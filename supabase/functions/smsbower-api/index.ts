import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SUPABASE_ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ||
  Deno.env.get("SB_PUBLISHABLE_KEY") ||
  "";

const SMSBOWER_API_KEY = Deno.env.get("SMSBOWER_API_KEY")!;

const SMSBOWER_URL =
  "https://smsbower.page/stubs/handler_api.php";

const FX_URL =
  "https://open.er-api.com/v6/latest/USD";

const FX_FALLBACK_URL =
  "https://api.frankfurter.app/latest?from=USD&to=NGN";

/*
 * ============================================================
 * MARKUP FALLBACKS
 * ============================================================
 */

const DEFAULT_MARKUP_PERCENT = 100;

const USA_MARKUP_PERCENT = 100;
const USA_WHATSAPP_MARKUP_PERCENT = 100;

const DEFAULT_MARKUP_MULTIPLIER =
  1 + DEFAULT_MARKUP_PERCENT / 100;

const USA_WHATSAPP_MARKUP_MULTIPLIER =
  1 + USA_WHATSAPP_MARKUP_PERCENT / 100;
const USA_MARKUP_MULTIPLIER = 1 + USA_MARKUP_PERCENT / 100;


/*
 * ============================================================
 * PREFERRED WHATSAPP PROVIDERS
 * ============================================================
 *
 * These are checked against LIVE SMSBower provider data.
 *
 * IMPORTANT:
 * We do NOT create a server if SMSBower does not return
 * the provider with a valid price and stock.
 *
 * country_id -> provider_id
 *
 * UK            16  -> 3368
 * USA Virtual   12  -> 3209
 * Canada        36  -> 2462
 * Colombia      33  -> 3253
 * Indonesia      6  -> 1329
 * Brazil        73  -> 2933
 * USA           187 -> 3170
 * ============================================================
 */

const PREFERRED_WHATSAPP_PROVIDERS: Record<
  number,
  string
> = {
  16: "3368",
  12: "3209",
  36: "2462",
  33: "3253",
  6: "1329",
  73: "2933",
  187: "3170",
};


const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":
    "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};


/* ============================================================
   RESPONSE
============================================================ */

function json(
  data: unknown,
  status = 200,
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: corsHeaders,
    },
  );
}


/* ============================================================
   HELPERS
============================================================ */

function cleanString(
  value: unknown,
): string {
  return String(value ?? "").trim();
}


function numberOrNull(
  value: unknown,
): number | null {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


function positiveNumber(
  value: unknown,
): number | null {
  const n = Number(value);

  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {
    return null;
  }

  return n;
}


function ceilNaira(
  value: number,
): number {
  return Math.ceil(value);
}


function normalizeKey(
  value: unknown,
): string {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}


/* ============================================================
   ADMIN AUTH
============================================================ */

async function requireAdmin(
  req: Request,
) {
  const user =
    await getUserFromRequest(
      req,
    );

  if (!user) {
    return {
      ok: false,
      user: null,
    };
  }

  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from("admin_users")
      .select("user_id")
      .eq(
        "user_id",
        user.id,
      )
      .maybeSingle();

  if (error || !data) {
    // Confirm through the same authenticated RPC the admin page uses.
    // This keeps the check secure while handling service-role/table lookup mismatches.
    try {
      const userClient = createUserClient(req);
      const { data: isAdmin, error: rpcError } = await userClient.rpc("is_admin");
      if (!rpcError && isAdmin === true) return { ok: true, user };
    } catch {
      // Deny access if the authenticated check cannot be verified.
    }
    return { ok: false, user };
  }

  return { ok: true, user };
}


/* ============================================================
   MARKUP
============================================================ */

async function getMarkupPercent(
  serviceCode: string,
  countryId: number,
  serverId: string | null = null,
): Promise<number> {
  const countryKey = String(Number(countryId));
  const { data, error } = await supabaseAdmin.rpc("get_smsbower_price_rule", {
    p_country_key: countryKey,
    p_service_code: cleanString(serviceCode) || null,
    p_server_id: cleanString(serverId) || null,
  });
  if (!error && data) {
    const rule = Array.isArray(data) ? data[0] : data;
    if (rule && rule.pricing_mode === "markup") {
      const n = numberOrNull(rule.markup_percent);
      if (n !== null && n >= 0) return n;
    }
  }
  return Number(countryId) === 187 ? USA_MARKUP_PERCENT : DEFAULT_MARKUP_PERCENT;
}

async function getPriceRule(
  countryId: number, serviceCode: string, serverId: string | null = null,
): Promise<any> {
  const { data, error } = await supabaseAdmin.rpc("get_smsbower_price_rule", {
    p_country_key: String(Number(countryId)),
    p_service_code: cleanString(serviceCode) || null,
    p_server_id: cleanString(serverId) || null,
  });
  if (error) throw new Error(`Could not load pricing rule: ${error.message}`);
  return Array.isArray(data) ? (data[0] || null) : data;
}


/* ============================================================
   CUSTOMER PRICE
============================================================ */

async function calculateCustomerPrice(
  providerUsd: number,
  fx: number,
  serviceCode: string,
  countryId: number,
  serverId: string | null = null,
): Promise<number | null> {

  if (
    !Number.isFinite(providerUsd) ||
    providerUsd <= 0 ||
    !Number.isFinite(fx) ||
    fx <= 0
  ) {
    return null;
  }

  const rule = await getPriceRule(countryId, serviceCode, serverId);
  if (rule?.pricing_mode === "fixed") {
    const fixed = positiveNumber(rule.fixed_price_ngn);
    if (fixed) return ceilNaira(fixed);
  }
  const markupPercent = rule?.pricing_mode === "markup" && numberOrNull(rule.markup_percent) !== null
    ? Number(rule.markup_percent)
    : await getMarkupPercent(serviceCode, countryId, serverId);
  return ceilNaira(providerUsd * fx * (1 + markupPercent / 100));
}


/* ============================================================
   MARKUP MANAGEMENT
============================================================ */

async function getMarkupRules(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return json({ error: "Admin access required." }, 403);
  const { data, error } = await supabaseAdmin.from("virtual_number_markup_rules")
    .select("id,server,country_key,service_code,server_id,pricing_mode,markup_percent,fixed_price_ngn,is_active,created_at,updated_at")
    .eq("server", "smsbower").order("updated_at", { ascending: false });
  if (error) return json({ error: error.message }, 500);
  return json({ success: true, rules: data || [] });
}

async function saveMarkupRule(req: Request, body: any) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return json({ error: "Admin access required." }, 403);
  const country = body.country_key == null || body.country_key === "" || body.country_key === "overall" ? null : cleanString(body.country_key);
  const service = body.service_code == null || body.service_code === "" || body.service_code === "overall" ? null : cleanString(body.service_code);
  const server = body.server_id == null || body.server_id === "" || body.server_id === "overall" ? null : cleanString(body.server_id);
  const mode = cleanString(body.pricing_mode || "markup").toLowerCase();
  const markup = numberOrNull(body.markup_percent);
  const fixed = numberOrNull(body.fixed_price_ngn);
  if (!["markup", "fixed"].includes(mode)) return json({ error: "Pricing mode must be markup or fixed." }, 400);
  if (server && (!country || !service)) return json({ error: "Server-specific rules require a country and service." }, 400);
  if (mode === "markup" && (markup === null || markup < 0)) return json({ error: "Markup percentage must be 0 or higher." }, 400);
  if (mode === "fixed" && (fixed === null || fixed <= 0)) return json({ error: "Fixed NGN price must be greater than zero." }, 400);
  // Admin identity was verified above. Do not call admin_set_smsbower_price_rule
  // with the service-role client: auth.uid() is NULL in that context and the RPC
  // incorrectly rejects the verified administrator.
  const match = async () => {
    let q = supabaseAdmin.from("virtual_number_markup_rules").select("id")
      .eq("server", "smsbower");
    q = country === null ? q.is("country_key", null) : q.eq("country_key", country);
    q = service === null ? q.is("service_code", null) : q.eq("service_code", service);
    q = server === null ? q.is("server_id", null) : q.eq("server_id", server);
    return await q.order("updated_at", { ascending: false }).limit(1).maybeSingle();
  };
  const requestedId = cleanString(body.id);
  const found = requestedId ? null : await match();
  if (found?.error) return json({ error: found.error.message }, 500);
  const values = {
    server: "smsbower", country_key: country, service_code: service, server_id: server,
    pricing_mode: mode, markup_percent: mode === "markup" ? markup : 100,
    fixed_price_ngn: mode === "fixed" ? fixed : null, is_active: true,
    updated_at: new Date().toISOString(),
  };
  const result = requestedId
    ? await supabaseAdmin.from("virtual_number_markup_rules").update(values).eq("id", requestedId).eq("server", "smsbower").select("id").single()
    : found?.data
      ? await supabaseAdmin.from("virtual_number_markup_rules").update(values).eq("id", found.data.id).select("id").single()
      : await supabaseAdmin.from("virtual_number_markup_rules").insert(values).select("id").single();
  if (result.error) return json({ error: result.error.message }, 500);
  return json({ success: true, id: result.data.id, message: "Price rule saved." });
}

async function deleteMarkupRule(req: Request, body: any) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return json({ error: "Admin access required." }, 403);
  const id = cleanString(body.id);
  if (!id) return json({ error: "Invalid pricing rule." }, 400);
  const { data, error } = await supabaseAdmin.from("virtual_number_markup_rules")
    .delete().eq("id", id).eq("server", "smsbower").select("id");
  if (error) return json({ error: error.message }, 500);
  if (!data?.length) return json({ error: "Pricing rule not found." }, 404);
  return json({ success: true, message: "Price rule deleted." });
}

async function deleteServiceSetting(req: Request, body: any) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return json({ error: "Admin access required." }, 403);
  const country = cleanString(body.country_id);
  const service = cleanString(body.service_code);
  if (!country || !service) return json({ error: "Country and service are required." }, 400);
  const { data, error } = await supabaseAdmin.from("smsbower_service_settings")
    .delete().eq("country_id", country).eq("service_code", service).select("id");
  if (error) return json({ error: error.message }, 500);
  return json({ success: true, removed: data?.length || 0, message: "Service override removed; default availability restored." });
}

async function deleteServerSetting(req: Request, body: any) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return json({ error: "Admin access required." }, 403);
  const country = cleanString(body.country_id), service = cleanString(body.service_code), server = cleanString(body.server_id);
  if (!country || !service || !server) return json({ error: "Country, service and server are required." }, 400);
  const { data, error } = await supabaseAdmin.from("smsbower_server_settings")
    .delete().eq("country_id", country).eq("service_code", service).eq("server_id", server).select("id");
  if (error) return json({ error: error.message }, 500);
  return json({ success: true, removed: data?.length || 0, message: "Server override removed." });
}
async function deleteDisplaySetting(req: Request, body: any) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return json({ error: "Admin access required." }, 403);
  const country = cleanString(body.country_id), service = cleanString(body.service_code);
  if (!country || !service) return json({ error: "Country and service are required." }, 400);
  const { data, error } = await supabaseAdmin.from("smsbower_server_display_settings")
    .delete().eq("country_id", country).eq("service_code", service).select("id");
  if (error) return json({ error: error.message }, 500);
  return json({ success: true, removed: data?.length || 0, message: "Display settings reset." });
}

async function adminCountries(req: Request) {
  const a = await requireAdmin(req); if (!a.ok) return json({error:"Admin access required."},403);
  try { const raw = await smsBowerRequest({action:"getCountries"}); return json({success:true,countries:parseCountries(raw)}); }
  catch(e) { return json({error:e instanceof Error?e.message:"Could not load countries."},502); }
}
async function adminServices(req: Request) {
  const a = await requireAdmin(req); if (!a.ok) return json({error:"Admin access required."},403);
  try { const raw = await smsBowerRequest({action:"getServicesList"}); return json({success:true,services:parseServiceList(raw)}); }
  catch(e) { return json({error:e instanceof Error?e.message:"Could not load services."},502); }
}
async function listAdminSettings(req: Request, table: string, key: string) {
  const a = await requireAdmin(req); if (!a.ok) return json({error:"Admin access required."},403);
  const {data,error}=await supabaseAdmin.from(table).select("*").order("updated_at",{ascending:false});
  if(error) return json({error:error.message},500); return json({success:true,[key]:data||[]});
}
async function saveAdminSetting(req: Request, body: any, kind: "service"|"server"|"display") {
  const a=await requireAdmin(req); if(!a.ok) return json({error:"Admin access required."},403);
  const country=cleanString(body.country_id ?? body.country_key); const service=cleanString(body.service_code);
  if(!country||!service) return json({error:"Country and service are required."},400);
  let table="", values:any={country_id:country,service_code:service,updated_at:new Date().toISOString()};
  if(kind==="service") { table="smsbower_service_settings"; values={...values,country_name:cleanString(body.country_name),service_name:cleanString(body.service_name)||service,is_active:body.is_active!==false}; }
  if(kind==="server") { const server=cleanString(body.server_id); if(!server) return json({error:"Server ID is required."},400); table="smsbower_server_settings"; values={...values,server_id:server,server_name:cleanString(body.server_name)||server,is_active:body.is_active!==false,admin_tier:body.admin_tier==null?null:cleanString(body.admin_tier)}; }
  if(kind==="display") { const n=Number(body.max_servers); if(!Number.isInteger(n)||n<1||n>100) return json({error:"Maximum servers must be 1–100."},400); table="smsbower_server_display_settings"; values={...values,max_servers:n,preferred_tier:body.preferred_tier==null?null:cleanString(body.preferred_tier)}; }
  const keys=kind==="service"?["country_id","service_code"]:kind==="server"?["country_id","service_code","server_id"]:["country_id","service_code"];
  let q=supabaseAdmin.from(table).select("id"); for(const k of keys) q=q.eq(k,values[k]); const {data:old,error:findError}=await q.limit(1).maybeSingle(); if(findError) return json({error:findError.message},500);
  const result=old ? await supabaseAdmin.from(table).update(values).eq("id",old.id).select("*").single() : await supabaseAdmin.from(table).insert(values).select("*").single();
  if(result.error) return json({error:result.error.message},500); return json({success:true,setting:result.data});
}
async function adminServers(req: Request, body: any) {
  const a = await requireAdmin(req);
  if (!a.ok) return json({ error: "Admin access required." }, 403);
  const countryId = Number(body.country_id);
  const service = cleanString(body.service_code);
  if (!Number.isFinite(countryId) || !service) return json({ error: "Country and service are required." }, 400);

  let country: any = { id: countryId, name: cleanString(body.country_name), eng: cleanString(body.country_name) };
  try {
    const parsed = parseCountries(await smsBowerRequest({ action: "getCountries" }));
    country = parsed.find((x: any) => Number(x.id) === countryId) || country;
  } catch {}

  // Admin view intentionally reads live SMSBower V3 prices directly, without customer display limits.
  let providerRows: ProviderPrice[] = [];
  let lastLookupError = "";
  for (const countryValue of countryCandidates(country)) {
    try {
      const raw = await smsBowerRequest({ action: "getPricesV3", country: countryValue, service });
      if (typeof raw === "string" && raw.startsWith("BAD_COUNTRY")) continue;
      if (typeof raw === "string" && raw.startsWith("BAD_SERVICE")) { lastLookupError = "SMSBower does not recognize this service for the selected country."; break; }
      if (typeof raw === "string" && raw.startsWith("BAD_KEY")) return json({ error: "SMSBower API key is invalid." }, 502);
      providerRows = extractProviderPrices(raw).filter((p: any) =>
        cleanString(p.providerId) !== "" && cleanString(p.providerId) !== "0" &&
        Number.isFinite(Number(p.costUsd)) && Number(p.costUsd) > 0 &&
        Number.isFinite(Number(p.stock)) && Number(p.stock) > 0
      );
      if (providerRows.length) break;
    } catch (e) { lastLookupError = e instanceof Error ? e.message : "Provider lookup failed."; }
  }

  const byId = new Map<string, ProviderPrice>();
  for (const p of providerRows) {
    const id = cleanString(p.providerId), old = byId.get(id);
    if (!old || Number(p.costUsd) < Number(old.costUsd)) byId.set(id, p);
  }
  providerRows = [...byId.values()].sort((a, b) => Number(a.costUsd) - Number(b.costUsd) || Number(b.stock) - Number(a.stock));

  const [{ data: settings, error: e1 }, { data: display, error: e2 }] = await Promise.all([
    supabaseAdmin.from("smsbower_server_settings").select("*").eq("country_id", String(countryId)).eq("service_code", service),
    supabaseAdmin.from("smsbower_server_display_settings").select("*").eq("country_id", String(countryId)).eq("service_code", service).limit(1),
  ]);
  if (e1 || e2) return json({ error: (e1 || e2)!.message }, 500);

  const settingMap = new Map((settings || []).map((x: any) => [String(x.server_id), x]));
  const servers: any[] = providerRows.map((p, i) => {
    const id = cleanString(p.providerId), saved: any = settingMap.get(id) || {};
    const providerTier = cleanString((p as any).tier);
    return {
      ...saved,
      server_id: id,
      server_name: cleanString(saved.server_name) || cleanString((p as any).name) || cleanString((p as any).label) || ("Server " + id),
      provider_cost_usd: Number(p.costUsd),
      stock: Math.floor(Number(p.stock)),
      live: true,
      available: true,
      is_active: settingMap.has(id) ? saved.is_active !== false : true,
      admin_tier: saved.admin_tier || providerTier || null,
      provider_rank: i + 1,
    };
  });

  for (const saved of settings || []) {
    if (!servers.some((v: any) => String(v.server_id) === String(saved.server_id))) {
      servers.push({ ...saved, server_id: String(saved.server_id), provider_cost_usd: null, stock: 0, live: false, available: false, is_active: saved.is_active !== false });
    }
  }
  const dSetting = (display || [])[0] || null;
  if (dSetting?.preferred_tier) servers.sort((a: any, b: any) => {
    const ap = String(a.admin_tier || "") === String(dSetting.preferred_tier) ? 0 : 1;
    const bp = String(b.admin_tier || "") === String(dSetting.preferred_tier) ? 0 : 1;
    return ap - bp || Number(a.provider_cost_usd ?? Infinity) - Number(b.provider_cost_usd ?? Infinity);
  });
  return json({
    success: true,
    servers,
    all_servers: servers,
    settings: settings || [],
    display_settings: dSetting,
    provider_count: providerRows.length,
    warning: providerRows.length ? null : (lastLookupError || "SMSBower returned no available providers with both price and stock for this country/service."),
  });
}


/* ============================================================
   SMSBOWER REQUEST
============================================================ */

async function smsBowerRequest(
  params: Record<
    string,
    string | number | undefined
  >,
) {

  if (!SMSBOWER_API_KEY) {
    throw new Error(
      "SMSBOWER_API_KEY is not configured.",
    );
  }


  const url =
    new URL(
      SMSBOWER_URL,
    );


  url.searchParams.set(
    "api_key",
    SMSBOWER_API_KEY,
  );


  for (
    const [
      key,
      value,
    ]
    of Object.entries(params)
  ) {

    if (
      value !== undefined &&
      value !== null &&
      String(value) !== ""
    ) {

      url.searchParams.set(
        key,
        String(value),
      );
    }
  }


  const response =
    await fetch(
      url.toString(),
      {
        method:
          "GET",

        headers: {
          Accept:
            "application/json,text/plain,*/*",

          "User-Agent":
            "DelightVendorLogs/1.0",
        },
      },
    );


  const text =
    await response.text();


  let parsed: any;


  try {

    parsed =
      JSON.parse(text);

  } catch {

    parsed =
      text;
  }


  if (
    !response.ok
  ) {
    throw new Error(
      `SMSBower HTTP ${response.status}`,
    );
  }


  return parsed;
}


/* ============================================================
   AUTH
============================================================ */

async function getUserFromRequest(
  req: Request,
) {

  let token = "";


  const authorization =
    req.headers.get(
      "Authorization",
    ) ||
    req.headers.get(
      "authorization",
    ) ||
    "";


  if (
    authorization.startsWith(
      "Bearer ",
    )
  ) {

    token =
      authorization
        .replace(
          "Bearer ",
          "",
        )
        .trim();

  } else if (
    authorization
  ) {

    token =
      authorization.trim();
  }


  if (!token) {

    token =
      (
        req.headers.get(
          "apikey",
        ) ||
        req.headers.get(
          "APIKEY",
        ) ||
        ""
      ).trim();
  }


  if (!token) {
    return null;
  }


  const {
    data,
    error,
  } =
    await supabaseAdmin.auth.getUser(
      token,
    );


  if (
    error ||
    !data.user
  ) {
    return null;
  }


  return data.user;
}


/* ============================================================
   CUSTOMER SUPABASE CLIENT
============================================================ */

function createUserClient(
  req: Request,
) {

  const authorization =
    req.headers.get(
      "Authorization",
    ) || "";


  if (!SUPABASE_ANON_KEY) {
    throw new Error(
      "Wallet service is not configured.",
    );
  }


  return createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      global: {
        headers: {
          Authorization:
            authorization,
        },
      },

      auth: {
        autoRefreshToken:
          false,

        persistSession:
          false,
      },
    },
  );
}


/* ============================================================
   LIVE FX
============================================================ */

async function getLiveUsdNgn(): Promise<number> {

  try {

    const response =
      await fetch(
        FX_URL,
        {
          headers: {
            Accept:
              "application/json",
          },
        },
      );


    if (
      response.ok
    ) {

      const data =
        await response.json();


      const rate =
        Number(
          data?.rates?.NGN,
        );


      if (
        Number.isFinite(rate) &&
        rate > 0
      ) {
        return rate;
      }
    }

  } catch {
    // fallback
  }


  try {

    const response =
      await fetch(
        FX_FALLBACK_URL,
        {
          headers: {
            Accept:
              "application/json",
          },
        },
      );


    if (
      response.ok
    ) {

      const data =
        await response.json();


      const rate =
        Number(
          data?.rates?.NGN,
        );


      if (
        Number.isFinite(rate) &&
        rate > 0
      ) {
        return rate;
      }
    }

  } catch {
    // no hardcoded fallback
  }


  throw new Error(
    "Live USD/NGN exchange rate is currently unavailable.",
  );
}


/* ============================================================
   COUNTRIES
============================================================ */

function parseCountries(
  raw: any,
): any[] {

  if (!raw) {
    return [];
  }


  let source: any[] =
    [];


  if (
    Array.isArray(raw)
  ) {

    source =
      raw;

  } else if (
    Array.isArray(
      raw.countries,
    )
  ) {

    source =
      raw.countries;

  } else if (
    Array.isArray(
      raw.data,
    )
  ) {

    source =
      raw.data;

  } else if (
    typeof raw ===
    "object"
  ) {

    source =
      Object.values(raw);
  }


  const result: any[] =
    [];


  for (
    const item of source
  ) {

    if (
      !item ||
      typeof item !==
        "object"
    ) {
      continue;
    }


    const id =
      numberOrNull(
        item.id ??
        item.country_id ??
        item.countryId,
      );


    if (
      id === null ||
      id < 0
    ) {
      continue;
    }


    const eng =
      cleanString(
        item.eng ??
        item.name ??
        item.en ??
        item.country,
      );


    const rus =
      cleanString(
        item.rus,
      );


    const chn =
      cleanString(
        item.chn,
      );


    if (
      !eng &&
      !rus &&
      !chn
    ) {
      continue;
    }


    result.push({
      id,

      name:
        eng ||
        rus ||
        chn,

      eng,

      rus,

      chn,

      aliases:
        buildCountryAliases(
          id,
          eng ||
            rus ||
            chn,
        ),
    });
  }


  const seen =
    new Set();


  return result.filter(
    (
      country,
    ) => {

      const key =
        `${country.id}:${country.name}`;


      if (
        seen.has(key)
      ) {
        return false;
      }


      seen.add(key);


      return true;
    },
  );
}


function buildCountryAliases(
  id: number,
  name: string,
): string[] {

  const aliases = [
    String(id),
    name.toLowerCase(),
  ];


  const n =
    name.toLowerCase();


  if (
    id === 16 ||
    n.includes(
      "united kingdom",
    ) ||
    n === "england"
  ) {

    aliases.push(
      "uk",
      "gb",
      "england",
      "united kingdom",
    );
  }


  if (
    id === 187 ||
    n === "usa" ||
    n.includes(
      "united states",
    )
  ) {

    aliases.push(
      "us",
      "usa",
      "united states",
    );
  }


  if (
    id === 12 ||
    n.includes(
      "virt",
    )
  ) {

    aliases.push(
      "us",
      "usa",
      "united states",
      "united states virtual",
      "usa virtual",
    );
  }


  return [
    ...new Set(
      aliases,
    ),
  ];
}


function countryCandidates(
  country: any,
): string[] {

  const result: string[] =
    [];


  const add = (
    value: unknown,
  ) => {

    const s =
      cleanString(
        value,
      );


    if (
      s &&
      !result.includes(s)
    ) {
      result.push(s);
    }
  };


  add(
    country?.id,
  );


  const name =
    cleanString(
      country?.name,
    ).toLowerCase();


  const eng =
    cleanString(
      country?.eng,
    ).toLowerCase();


  const id =
    Number(
      country?.id,
    );


  if (
    id === 16 ||
    name.includes(
      "united kingdom",
    ) ||
    name === "england" ||
    eng.includes(
      "united kingdom",
    ) ||
    eng === "england"
  ) {

    add("16");
    add("united kingdom");
    add("england");
    add("uk");
    add("gb");
  }


  if (
    id === 187 ||
    name === "usa" ||
    name.includes(
      "united states",
    ) ||
    eng === "usa" ||
    eng.includes(
      "united states",
    )
  ) {

    add("187");
    add("usa");
    add("united states");
    add("us");
  }


  if (
    id === 12 ||
    name.includes(
      "virtual",
    ) ||
    eng.includes(
      "virtual",
    )
  ) {

    add("12");
    add("usa");
    add("united states");
    add("us");
  }


  add(
    country?.eng,
  );


  add(
    country?.name,
  );


  return result;
}


/* ============================================================
   SERVICES LIST
============================================================ */

function parseServiceList(
  raw: any,
): Array<{
  code: string;
  name: string;
}> {

  let services: any[] =
    [];


  if (
    Array.isArray(
      raw?.services,
    )
  ) {

    services =
      raw.services;

  } else if (
    Array.isArray(raw)
  ) {

    services =
      raw;
  }


  return services
    .map(
      (
        service,
      ) => ({
        code:
          cleanString(
            service?.code ??
            service?.service_code,
          ),

        name:
          cleanString(
            service?.name ??
            service?.service_name ??
            service?.title,
          ),
      }),
    )
    .filter(
      (
        service,
      ) =>
        service.code.length >
        0,
    );
}


/* ============================================================
   PROVIDER PRICE TYPES
============================================================ */

type ProviderPrice = {
  providerId: string;
  costUsd: number;
  stock: number;
};


/* ============================================================
   PREFERRED WHATSAPP PROVIDER LOOKUP
===============================================================
 *
 * Uses SMSBower's read-only:
 *
 *     getTopCountriesByService
 *
 * We ONLY accept the preferred provider when:
 *
 *     provider ID matches exactly
 *     price > 0
 *     count/stock > 0
 *
 * If SMSBower does not return it, we return null.
 *
 * We NEVER call getNumberV2 here.
 * ============================================================
 */

function isWhatsAppService(
  serviceCode: string,
): boolean {

  const normalized =
    normalizeKey(
      serviceCode,
    );

  return (
    normalized === "wa" ||
    normalized === "whatsapp"
  );
}


function preferredCountryKeys(
  country: any,
): string[] {

  const keys: string[] =
    [];


  const add = (
    value: unknown,
  ) => {

    const raw =
      cleanString(
        value,
      );


    if (!raw) {
      return;
    }


    const normalized =
      normalizeKey(
        raw,
      );


    if (
      normalized &&
      !keys.includes(
        normalized,
      )
    ) {

      keys.push(
        normalized,
      );
    }
  };


  const id =
    Number(
      country?.id,
    );


  add(id);

  add(
    country?.name,
  );

  add(
    country?.eng,
  );


  if (id === 16) {
    add("uk");
    add("gb");
    add("england");
    add("united kingdom");
  }


  if (id === 12) {
    add("usa");
    add("us");
    add("united states");
    add("usa virtual");
    add("united states virtual");
  }


  if (id === 187) {
    add("usa");
    add("us");
    add("united states");
  }


  if (id === 36) {
    add("canada");
  }


  if (id === 33) {
    add("colombia");
  }


  if (id === 6) {
    add("indonesia");
  }


  if (id === 73) {
    add("brazil");
  }


  return keys;
}


function extractPreferredProviderFromCountryData(
  countryData: any,
  preferredProviderId: string,
): ProviderPrice | null {

  if (
    !countryData ||
    typeof countryData !== "object"
  ) {
    return null;
  }


  /*
   * Most commonly SMSBower returns:
   *
   * {
   *   "3170": {
   *     "price": 0.12,
   *     "count": 542
   *   }
   * }
   *
   * But also tolerate an array/object representation
   * without inventing any values.
   */

  const direct =
    countryData[
      preferredProviderId
    ];


  if (
    direct &&
    typeof direct === "object"
  ) {

    const cost =
      positiveNumber(
        direct.price ??
        direct.cost ??
        direct.activationCost,
      );


    const stock =
      positiveNumber(
        direct.count ??
        direct.stock,
      );


    if (
      cost &&
      stock
    ) {

      return {
        providerId:
          preferredProviderId,

        costUsd:
          cost,

        stock:
          Math.floor(
            stock,
          ),
      };
    }
  }


  if (
    Array.isArray(
      countryData,
    )
  ) {

    for (
      const item
      of countryData
    ) {

      if (
        !item ||
        typeof item !== "object"
      ) {
        continue;
      }


      const providerId =
        cleanString(
          item.provider_id ??
          item.providerId ??
          item.provider ??
          item.id,
        );


      if (
        providerId !==
        preferredProviderId
      ) {
        continue;
      }


      const cost =
        positiveNumber(
          item.price ??
          item.cost ??
          item.activationCost,
        );


      const stock =
        positiveNumber(
          item.count ??
          item.stock,
        );


      if (
        cost &&
        stock
      ) {

        return {
          providerId:
            preferredProviderId,

          costUsd:
            cost,

          stock:
            Math.floor(
              stock,
            ),
        };
      }
    }
  }


  return null;
}


async function getPreferredWhatsappProvider(
  country: any,
  serviceCode: string,
): Promise<ProviderPrice | null> {

  if (
    !isWhatsAppService(
      serviceCode,
    )
  ) {
    return null;
  }


  const countryId =
    Number(
      country?.id,
    );


  if (
    !Number.isFinite(
      countryId,
    )
  ) {
    return null;
  }


  const preferredProviderId =
    PREFERRED_WHATSAPP_PROVIDERS[
      countryId
    ];


  if (
    !preferredProviderId
  ) {
    return null;
  }


  try {

    const raw =
      await smsBowerRequest({
        action:
          "getTopCountriesByService",

        service:
          serviceCode,
      });


    if (
      typeof raw ===
      "string"
    ) {

      if (
        raw.startsWith(
          "BAD_KEY",
        )
      ) {

        throw new Error(
          "SMSBower API key is invalid.",
        );
      }


      return null;
    }


    if (
      !raw ||
      typeof raw !==
        "object"
    ) {
      return null;
    }


    const wantedKeys =
      preferredCountryKeys(
        country,
      );


    /*
     * First try the exact country keys.
     */

    for (
      const wantedKey
      of wantedKeys
    ) {

      const matchingKey =
        Object.keys(
          raw,
        ).find(
          (
            key,
          ) =>
            normalizeKey(
              key,
            ) === wantedKey,
        );


      if (
        !matchingKey
      ) {
        continue;
      }


      const found =
        extractPreferredProviderFromCountryData(
          raw[
            matchingKey
          ],
          preferredProviderId,
        );


      if (found) {
        return found;
      }
    }


    /*
     * Some API responses can wrap the country
     * information inside data/countries.
     *
     * Check those containers without guessing
     * provider data.
     */

    const containers = [
      raw?.data,
      raw?.countries,
      raw?.results,
    ];


    for (
      const container
      of containers
    ) {

      if (
        !container ||
        typeof container !==
          "object"
      ) {
        continue;
      }


      for (
        const wantedKey
        of wantedKeys
      ) {

        const matchingKey =
          Object.keys(
            container,
          ).find(
            (
              key,
            ) =>
              normalizeKey(
                key,
              ) === wantedKey,
          );


        if (
          !matchingKey
        ) {
          continue;
        }


        const found =
          extractPreferredProviderFromCountryData(
            container[
              matchingKey
            ],
            preferredProviderId,
          );


        if (found) {
          return found;
        }
      }
    }

  } catch (
    error
  ) {

    console.error(
      "Preferred WhatsApp provider lookup error:",
      error,
    );
  }


  /*
   * IMPORTANT:
   *
   * No valid provider data means no preferred
   * server is created.
   */

  return null;
}


/* ============================================================
   V3 PROVIDER PRICE PARSER
============================================================ */

function extractProviderPrices(
  raw: any,
): ProviderPrice[] {

  const result: ProviderPrice[] =
    [];


  const visit = (
    node: any,
    possibleProviderId?: string,
  ) => {

    if (
      node === null ||
      node === undefined
    ) {
      return;
    }


    if (
      Array.isArray(node)
    ) {

      for (
        const item of node
      ) {

        visit(
          item,
          possibleProviderId,
        );
      }

      return;
    }


    if (
      typeof node !==
      "object"
    ) {
      return;
    }


    const cost =
      numberOrNull(
        node.price ??
        node.cost ??
        node.activationCost,
      );


    const stock =
      numberOrNull(
        node.count ??
        node.stock,
      );


    const providerId =
      cleanString(
        node.provider_id ??
        node.providerId ??
        node.provider ??
        node.id ??
        possibleProviderId,
      );


    if (
      cost !== null &&
      cost > 0 &&
      stock !== null &&
      stock > 0
    ) {

      result.push({
        providerId:
          providerId ||
          "0",

        costUsd:
          cost,

        stock:
          Math.floor(stock),
      });
    }


    for (
      const [
        key,
        value,
      ] of Object.entries(node)
    ) {

      if (
        [
          "price",
          "cost",
          "count",
          "stock",
          "provider_id",
          "providerId",
          "provider",
          "id",
          "activationCost",
        ].includes(key)
      ) {
        continue;
      }


      visit(
        value,
        key,
      );
    }
  };


  visit(raw);


  const map =
    new Map<
      string,
      ProviderPrice
    >();


  for (
    const item of result
  ) {

    if (
      item.stock <= 0 ||
      item.costUsd <= 0
    ) {
      continue;
    }


    const existing =
      map.get(
        item.providerId,
      );


    if (
      !existing ||
      item.costUsd <
        existing.costUsd ||
      (
        item.costUsd ===
          existing.costUsd &&
        item.stock >
          existing.stock
      )
    ) {

      map.set(
        item.providerId,
        item,
      );
    }
  }


  return Array.from(
    map.values(),
  );
}


/* ============================================================
   STANDARD getPrices PARSER
============================================================ */

type SimpleServicePrice = {
  key: string;
  costUsd: number;
  stock: number;
};


function extractSimpleServicePrices(
  raw: any,
): SimpleServicePrice[] {

  const result:
    SimpleServicePrice[] =
    [];


  const walk = (
    node: any,
    path: string[],
  ) => {

    if (
      node === null ||
      node === undefined
    ) {
      return;
    }


    if (
      Array.isArray(node)
    ) {

      for (
        const child of node
      ) {

        walk(
          child,
          path,
        );
      }

      return;
    }


    if (
      typeof node !==
      "object"
    ) {
      return;
    }


    const cost =
      numberOrNull(
        node.cost ??
        node.price ??
        node.activationCost,
      );


    const stock =
      numberOrNull(
        node.count ??
        node.stock,
      );


    if (
      cost !== null &&
      cost > 0 &&
      stock !== null &&
      stock > 0
    ) {

      const serviceKey =
        path.length
          ? path[
              path.length - 1
            ]
          : "";


      if (
        serviceKey
      ) {

        result.push({
          key:
            serviceKey,

          costUsd:
            cost,

          stock:
            Math.floor(
              stock,
            ),
        });
      }


      return;
    }


    for (
      const [
        key,
        value,
      ] of Object.entries(node)
    ) {

      if (
        [
          "cost",
          "price",
          "count",
          "stock",
          "activationCost",
        ].includes(key)
      ) {
        continue;
      }


      walk(
        value,
        [
          ...path,
          key,
        ],
      );
    }
  };


  walk(
    raw,
    [],
  );


  const map =
    new Map<
      string,
      SimpleServicePrice
    >();


  for (
    const item of result
  ) {

    const key =
      normalizeKey(
        item.key,
      );


    const existing =
      map.get(key);


    if (
      !existing ||
      item.stock >
        existing.stock
    ) {

      map.set(
        key,
        item,
      );
    }
  }


  return Array.from(
    map.values(),
  );
}


/* ============================================================
   FIND SERVICE PRICE
============================================================ */

function findServicePrice(
  raw: any,
  serviceCode: string,
  serviceName?: string,
): ProviderPrice | null {

  const prices =
    extractSimpleServicePrices(
      raw,
    );


  if (
    !prices.length
  ) {
    return null;
  }


  const code =
    normalizeKey(
      serviceCode,
    );


  const name =
    normalizeKey(
      serviceName,
    );


  let found =
    prices.find(
      (
        item,
      ) =>
        normalizeKey(
          item.key,
        ) === code,
    );


  if (found) {

    return {
      providerId:
        "0",

      costUsd:
        found.costUsd,

      stock:
        found.stock,
    };
  }


  if (name) {

    found =
      prices.find(
        (
          item,
        ) =>
          normalizeKey(
            item.key,
          ) === name,
      );


    if (found) {

      return {
        providerId:
          "0",

        costUsd:
          found.costUsd,

        stock:
          found.stock,
      };
    }
  }


  if (
    code.length >= 3
  ) {

    found =
      prices.find(
        (
          item,
        ) => {

          const key =
            normalizeKey(
              item.key,
            );


          return (
            key.includes(code) ||
            code.includes(key)
          );
        },
      );


    if (found) {

      return {
        providerId:
          "0",

        costUsd:
          found.costUsd,

        stock:
          found.stock,
      };
    }
  }


  if (
    name.length >= 4
  ) {

    found =
      prices.find(
        (
          item,
        ) => {

          const key =
            normalizeKey(
              item.key,
            );


          return (
            key.includes(name) ||
            name.includes(key)
          );
        },
      );


    if (found) {

      return {
        providerId:
          "0",

        costUsd:
          found.costUsd,

        stock:
          found.stock,
      };
    }
  }


  return null;
}


/* ============================================================
   COUNTRY PRICE REQUEST
============================================================ */

async function getCountryPrices(
  country: any,
) {

  const candidates =
    countryCandidates(
      country,
    );


  let lastError:
    unknown = null;


  for (
    const countryValue
    of candidates
  ) {

    try {

      const raw =
        await smsBowerRequest({
          action:
            "getPrices",

          country:
            countryValue,
        });


      if (
        typeof raw ===
        "string"
      ) {

        if (
          raw.startsWith(
            "BAD_COUNTRY",
          )
        ) {
          continue;
        }


        if (
          raw.startsWith(
            "BAD_KEY",
          )
        ) {

          throw new Error(
            "SMSBower API key is invalid.",
          );
        }
      }


      return {
        raw,
        countryValue,
      };

    } catch (
      error
    ) {

      lastError =
        error;
    }
  }


  throw (
    lastError ||
    new Error(
      "Unable to load live country prices.",
    )
  );
}


/* ============================================================
   VERSION CONFIG
============================================================ */

async function getVersionConfig(
  version: string,
) {

  const normalized =
    [
      "V1",
      "V2",
      "V3",
    ].includes(version)
      ? version
      : "V1";


  try {

    const {
      data,
      error,
    } =
      await supabaseAdmin
        .from(
          "virtual_number_version_config",
        )
        .select(
          "version_code,country_ids,service_codes,provider_ids,is_active",
        )
        .eq(
          "version_code",
          normalized,
        )
        .maybeSingle();


    if (
      error ||
      !data
    ) {

      return {
        version:
          normalized,

        country_ids:
          [],

        service_codes:
          [],

        provider_ids:
          [],

        is_active:
          true,
      };
    }


    return {
      version:
        normalized,

      country_ids:
        Array.isArray(
          data.country_ids,
        )
          ? data.country_ids
          : [],

      service_codes:
        Array.isArray(
          data.service_codes,
        )
          ? data.service_codes
          : [],

      provider_ids:
        Array.isArray(
          data.provider_ids,
        )
          ? data.provider_ids
          : [],

      is_active:
        data.is_active !== false,
    };

  } catch {

    return {
      version:
        normalized,

      country_ids:
        [],

      service_codes:
        [],

      provider_ids:
        [],

      is_active:
        true,
    };
  }
}


function versionAllowsService(
  config: any,
  serviceCode: string,
) {

  if (
    !config?.service_codes?.length
  ) {
    return true;
  }


  return config.service_codes
    .map(
      (x: any) =>
        String(
          x,
        ).toLowerCase(),
    )
    .includes(
      serviceCode.toLowerCase(),
    );
}


function versionAllowsCountry(
  config: any,
  countryId: number,
) {

  if (
    !config?.country_ids?.length
  ) {
    return true;
  }


  return config.country_ids
    .map(
      (x: any) =>
        Number(x),
    )
    .includes(
      Number(
        countryId,
      ),
    );
}


/* ============================================================
   LIVE PROVIDERS
============================================================ */

async function getLiveProviders(
  country: any,
  serviceCode: string,
  version = "V1",
) {

  const config =
    await getVersionConfig(
      version,
    );


  let providers:
    ProviderPrice[] =
    [];


  const candidates =
    countryCandidates(
      country,
    );


  for (
    const countryValue
    of candidates
  ) {

    try {

      const raw =
        await smsBowerRequest({
          action:
            "getPricesV3",

          country:
            countryValue,

          service:
            serviceCode,
        });


      if (
        typeof raw ===
        "string"
      ) {

        if (
          raw.startsWith(
            "BAD_COUNTRY",
          )
        ) {
          continue;
        }


        if (
          raw.startsWith(
            "BAD_SERVICE",
          )
        ) {
          break;
        }


        if (
          raw.startsWith(
            "BAD_KEY",
          )
        ) {

          throw new Error(
            "SMSBower API key is invalid.",
          );
        }
      }


      providers =
        extractProviderPrices(
          raw,
        );


      if (
        providers.length
      ) {
        break;
      }

    } catch {
      // try next country alias
    }
  }


  if (
    !providers.length
  ) {

    try {

      const countryPrices =
        await getCountryPrices(
          country,
        );


      const simple =
        findServicePrice(
          countryPrices.raw,
          serviceCode,
        );


      if (simple) {

        providers = [
          simple,
        ];
      }

    } catch {
      // handled below
    }
  }


  /*
   * ==========================================================
   * PREFERRED PROVIDER LOOKUP
   * ==========================================================
   *
   * This is done separately because the preferred provider
   * may not be present in the normal getPricesV3 response.
   *
   * It is ONLY used for WhatsApp.
   */

  const preferredProvider =
    await getPreferredWhatsappProvider(
      country,
      serviceCode,
    );


  if (
    !providers.length &&
    !preferredProvider
  ) {

    return {
      providers:
        [],
    };
  }


  /*
   * ==========================================================
   * ONLY LIVE / AVAILABLE PROVIDERS
   * ==========================================================
   */

  let filtered =
    providers.filter(
      (
        provider,
      ) =>
        Number.isFinite(
          provider.stock,
        ) &&
        provider.stock > 0 &&
        Number.isFinite(
          provider.costUsd,
        ) &&
        provider.costUsd > 0,
    );


  if (
    config.provider_ids?.length
  ) {

    const allowed =
      config.provider_ids.map(
        (x: any) =>
          String(x),
      );


    const onlyAllowed =
      filtered.filter(
        (
          provider,
        ) =>
          allowed.includes(
            String(
              provider.providerId,
            ),
          ),
      );


    if (
      onlyAllowed.length
    ) {

      filtered =
        onlyAllowed;
    }
  }


  /*
   * Cheapest available servers first.
   * If prices are equal, server with more stock first.
   */

  filtered.sort(
    (
      a,
      b,
    ) => {

      if (
        a.costUsd !==
        b.costUsd
      ) {

        return (
          a.costUsd -
          b.costUsd
        );
      }


      return (
        b.stock -
        a.stock
      );
    },
  );


  /*
   * ==========================================================
   * ADD PREFERRED PROVIDER
   * ==========================================================
   *
   * IMPORTANT:
   *
   * - Only add it if SMSBower actually returned it live.
   * - Never fabricate stock or price.
   * - Remove duplicate if the normal provider list already
   *   contains the same provider ID.
   * - Preferred provider goes FIRST.
   * - Existing normal live providers remain underneath.
   *
   * The normal five-server limit remains five NORMAL servers.
   * Therefore a live preferred provider can appear in addition
   * to those five.
   */

  if (
    preferredProvider &&
    preferredProvider.stock > 0 &&
    preferredProvider.costUsd > 0
  ) {

    filtered =
      filtered.filter(
        (
          provider,
        ) =>
          String(
            provider.providerId,
          ) !==
          String(
            preferredProvider.providerId,
          ),
      );


    filtered = [
      preferredProvider,
      ...filtered,
    ];
  }


  /*
   * ==========================================================
   * MAXIMUM SERVERS
   * ==========================================================
   *
   * Keep the preferred provider PLUS the existing five
   * normal live providers.
   */

  const hasPreferred =
    Boolean(
      preferredProvider &&
      preferredProvider.stock > 0 &&
      preferredProvider.costUsd > 0,
    );


  const normalProviders =
    filtered.filter(
      (
        provider,
      ) =>
        !(
          hasPreferred &&
          String(
            provider.providerId,
          ) ===
          String(
            preferredProvider!.providerId,
          )
        ),
    );


  const finalProviders =
    hasPreferred
      ? [
          preferredProvider!,
          ...normalProviders.slice(
            0,
            5,
          ),
        ]
      : filtered.slice(
          0,
          5,
        );


  return {
    providers:
      finalProviders,
  };
}


/* ============================================================
   LIVE SERVERS
============================================================ */

async function isServiceEnabled(countryId:number, serviceCode:string):Promise<boolean> {
 const {data,error}=await supabaseAdmin.from("smsbower_service_settings").select("is_active").eq("country_id",String(countryId)).eq("service_code",serviceCode).limit(1).maybeSingle();
 if(error) throw new Error(`Could not verify service settings: ${error.message}`); return !data || data.is_active!==false;
}
async function isServerEnabled(countryId:number,serviceCode:string,serverId:string):Promise<boolean> {
 const {data,error}=await supabaseAdmin.from("smsbower_server_settings").select("is_active").eq("country_id",String(countryId)).eq("service_code",serviceCode).eq("server_id",serverId).limit(1).maybeSingle();
 if(error) throw new Error(`Could not verify server settings: ${error.message}`); return !data || data.is_active!==false;
}

async function getLiveServers(
  country: any,
  serviceCode: string,
  version = "V1",
) {

  const fx =
    await getLiveUsdNgn();


  const providerResult =
    await getLiveProviders(
      country,
      serviceCode,
      version,
    );


  const servers: any[] =
    [];
  if (!(await isServiceEnabled(Number(country.id), serviceCode))) return {fx,servers,providers:[]};


  const preferredProviderId =
    isWhatsAppService(
      serviceCode,
    )
      ? PREFERRED_WHATSAPP_PROVIDERS[
          Number(
            country.id,
          )
        ] || ""
      : "";


  for (
    let i = 0;
    i <
    providerResult.providers.length;
    i++
  ) {

    const provider =
      providerResult.providers[i];

    // Only publish providers with a real ID, positive live stock and price.
    // SMSBower inventory can change between requests, so never invent availability.
    const providerId = cleanString(provider.providerId);
    const stock = Number(provider.stock);
    const providerCost = Number(provider.costUsd);

    if (
      !providerId ||
      providerId === "0" ||
      !Number.isFinite(stock) ||
      stock <= 0 ||
      !Number.isFinite(providerCost) ||
      providerCost <= 0
    ) {
      continue;
    }

    if (!(await isServerEnabled(Number(country.id), serviceCode, providerId))) continue;

    // Pass the actual server ID so server-specific pricing rules are respected.
    const price =
      await calculateCustomerPrice(
        providerCost,
        fx,
        serviceCode,
        Number(country.id),
        providerId,
      );

    if (
      !price ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      continue;
    }

    /*
     * Use the REAL SMSBower provider ID as server_id.
     */
    const serverId = providerId;


    const isRecommended =
      Boolean(
        preferredProviderId &&
        providerId &&
        providerId ===
          preferredProviderId,
      );


    servers.push({
      server_id:
        serverId,

      label:
        `Server ${i + 1}`,

      stock:
        Math.floor(
          provider.stock,
        ),

      provider_cost_usd:
        provider.costUsd,

      customer_price_ngn:
        price,

      /*
       * Frontend can use this to display the
       * small Recommended badge.
       */

      recommended:
        isRecommended,
      available: true,
    });
  }


  return {
    fx,

    servers,

    providers:
      providerResult.providers,
  };
}


/* ============================================================
   SERVICES FOR COUNTRY
============================================================ */

async function getServicesForCountry(
  country: any,
  version: string,
) {

  const config =
    await getVersionConfig(
      version,
    );


  const rawServices =
    await smsBowerRequest({
      action:
        "getServicesList",
    });


  const serviceList =
    parseServiceList(
      rawServices,
    );

  const { data: savedServiceSettings, error: savedSettingsError } = await supabaseAdmin
    .from("smsbower_service_settings").select("service_code,is_active")
    .eq("country_id", String(Number(country.id)));
  if (savedSettingsError) throw new Error(`Could not verify service settings: ${savedSettingsError.message}`);
  const disabledServices = new Set((savedServiceSettings || []).filter((x:any)=>x.is_active===false).map((x:any)=>String(x.service_code)));


  if (
    !serviceList.length
  ) {

    throw new Error(
      "SMSBower returned no services.",
    );
  }


  let livePrices: any =
    null;


  try {

    const result =
      await getCountryPrices(
        country,
      );


    livePrices =
      result.raw;

  } catch {

    livePrices =
      null;
  }


  const result: any[] =
    [];


  for (
    const service
    of serviceList
  ) {
    if (disabledServices.has(String(service.code))) continue;

    if (
      !versionAllowsService(
        config,
        service.code,
      )
    ) {
      continue;
    }


    let stock = 0;

    let providerCostUsd:
      number | null = null;


    if (
      livePrices
    ) {

      const price =
        findServicePrice(
          livePrices,
          service.code,
          service.name,
        );


      if (price) {

        stock =
          Math.floor(
            price.stock,
          );

        providerCostUsd =
          price.costUsd;
      }
    }


    result.push({
      service_code:
        service.code,

      service_name:
        service.name ||
        service.code,

      stock,

      provider_cost_usd:
        providerCostUsd,

      live:
        Boolean(
          providerCostUsd &&
          stock > 0,
        ),
    });
  }


  result.sort(
    (
      a,
      b,
    ) => {

      if (
        a.live &&
        !b.live
      ) {
        return -1;
      }


      if (
        !a.live &&
        b.live
      ) {
        return 1;
      }


      if (
        Number(a.stock) !==
        Number(b.stock)
      ) {

        return (
          Number(b.stock) -
          Number(a.stock)
        );
      }


      return String(
        a.service_name,
      ).localeCompare(
        String(
          b.service_name,
        ),
      );
    },
  );


  return result;
}


/* ============================================================
   PROVIDER BALANCE INTERNAL ONLY
============================================================ */

async function getProviderBalance() {

  const raw =
    await smsBowerRequest({
      action:
        "getBalance",
    });


  if (
    typeof raw ===
    "string"
  ) {

    if (
      raw.startsWith(
        "BAD_KEY",
      )
    ) {

      throw new Error(
        "SMSBower API key is invalid.",
      );
    }


    const match =
      raw.match(
        /^ACCESS_BALANCE:(.+)$/i,
      );


    if (match) {

      const balance =
        Number(
          match[1],
        );


      if (
        Number.isFinite(
          balance,
        )
      ) {

        return balance;
      }
    }
  }


  const balance =
    Number(
      raw?.balance ??
      raw?.data?.balance,
    );


  if (
    Number.isFinite(
      balance,
    )
  ) {

    return balance;
  }


  throw new Error(
    "Unable to read SMSBower balance.",
  );
}


/* ============================================================
   GET NUMBER FROM SMSBOWER
============================================================ */

async function getNumberFromProvider(
  country: any,
  serviceCode: string,
  providerId: string,
  maxPriceUsd: number,
) {

  const candidates =
    countryCandidates(
      country,
    );


  for (
    const countryValue
    of candidates
  ) {

    const params: Record<
      string,
      string | number
    > = {

      action:
        "getNumberV2",

      service:
        serviceCode,

      country:
        countryValue,

      maxPrice:
        maxPriceUsd,
    };


    if (
      providerId &&
      providerId !== "0"
    ) {

      params.providerIds =
        providerId;
    }


    try {

      const raw =
        await smsBowerRequest(
          params,
        );


      if (
        typeof raw ===
        "string"
      ) {

        if (
          raw.startsWith(
            "BAD_COUNTRY",
          )
        ) {
          continue;
        }


        if (
          raw.startsWith(
            "NO_NUMBERS",
          ) ||
          raw.startsWith(
            "NO_NUMBER",
          )
        ) {
          continue;
        }


        if (
          raw.startsWith(
            "BAD_KEY",
          )
        ) {

          throw new Error(
            "SMSBower API key is invalid.",
          );
        }


        if (
          raw.startsWith(
            "BAD_SERVICE",
          )
        ) {

          throw new Error(
            "SMSBower service is invalid.",
          );
        }


        const parts =
          raw.split(":");


        if (
          parts[0] ===
            "ACCESS_NUMBER" &&
          parts.length >= 3
        ) {

          return {

            activationId:
              parts[1],

            phoneNumber:
              parts
                .slice(2)
                .join(":"),

            activationCost:
              maxPriceUsd,
          };
        }


        continue;
      }


      if (
        raw?.activationId &&
        raw?.phoneNumber
      ) {

        return {

          activationId:
            String(
              raw.activationId,
            ),

          phoneNumber:
            String(
              raw.phoneNumber,
            ),

          activationCost:
            Number(
              raw.activationCost,
            ),
        };
      }

    } catch (
      error
    ) {

      const message =
        error instanceof Error
          ? error.message
          : "";


      if (
        message
          .toLowerCase()
          .includes(
            "invalid",
          )
      ) {

        throw error;
      }
    }
  }


  return null;
}


/* ============================================================
   UPDATE ORDER
============================================================ */

async function updateOrder(
  orderId: string,
  values: Record<
    string,
    unknown
  >,
) {

  return await supabaseAdmin
    .from(
      "virtual_number_orders",
    )
    .update({
      ...values,

      updated_at:
        new Date().toISOString(),
    })
    .eq(
      "id",
      orderId,
    );
}


/* ============================================================
   BUY
============================================================ */

async function buyNumber(
  req: Request,
  body: any,
) {

  const user =
    await getUserFromRequest(
      req,
    );


  if (!user) {

    return json(
      {
        error:
          "Authentication required.",
      },
      401,
    );
  }


  const countryId =
    Number(
      body.country_id,
    );


  const serviceCode =
    cleanString(
      body.service_code,
    );


  const serverId =
    cleanString(
      body.server_id,
    );


  const version =
    [
      "V1",
      "V2",
      "V3",
    ].includes(
      body.version,
    )
      ? body.version
      : "V1";


  if (
    !Number.isFinite(
      countryId,
    ) ||
    !serviceCode ||
    !serverId
  ) {

    return json(
      {
        error:
          "Country, service and server are required.",
      },
      400,
    );
  }


  let countryObject: any =
    {

      id:
        countryId,

      name:
        cleanString(
          body.country_name,
        ),

      eng:
        cleanString(
          body.country_name,
        ),
    };


  try {

    const rawCountries =
      await smsBowerRequest({
        action:
          "getCountries",
      });


    const parsedCountries =
      parseCountries(
        rawCountries,
      );


    const found =
      parsedCountries.find(
        (x) =>
          Number(x.id) ===
          countryId,
      );


    if (found) {
      countryObject =
        found;
    }

  } catch {
    // Numeric ID remains usable.
  }


  const config =
    await getVersionConfig(
      version,
    );


  if (
    !versionAllowsCountry(
      config,
      countryId,
    )
  ) {

    return json(
      {
        error:
          "This country is not available in this version.",
      },
      400,
    );
  }


  if (
    !versionAllowsService(
      config,
      serviceCode,
    )
  ) {

    return json(
      {
        error:
          "This service is not available in this version.",
      },
      400,
    );
  }


  /*
   * Get the CURRENT live server list again immediately
   * before purchase.
   */

  const live =
    await getLiveServers(
      countryObject,
      serviceCode,
      version,
    );


  /*
   * ==========================================================
   * FIND THE SELECTED PROVIDER BY REAL PROVIDER ID
   * ==========================================================
   */

  let providerIndex =
    live.providers.findIndex(
      (
        provider,
      ) =>
        cleanString(
          provider.providerId,
        ) === serverId,
    );


  // SMSBower server selection must always use an actual provider ID.



  const provider =
    providerIndex >= 0
      ? live.providers[
          providerIndex
        ]
      : null;


  const selectedServer =
    live.servers.find(
      (
        server,
      ) =>
        String(
          server.server_id,
        ) === serverId,
    );


  if (
    !provider ||
    !selectedServer ||
    provider.stock <= 0
  ) {

    return json(
      {
        error:
          "Number not available. Please try another option.",
      },
      409,
    );
  }


  const providerCost =
    positiveNumber(
      provider.costUsd,
    );


  const displayedCustomerPrice =
    positiveNumber(
      selectedServer
        .customer_price_ngn,
    );


  if (
    !providerCost ||
    !displayedCustomerPrice
  ) {

    return json(
      {
        error:
          "Number not available. Please try another option.",
      },
      409,
    );
  }


  try {

    const providerBalance =
      await getProviderBalance();


    if (
      providerBalance <
      providerCost
    ) {

      return json(
        {
          ok: false,
          error: "PROVIDER_INSUFFICIENT_FUNDS",
          message: "Insufficient funds. Please contact support.",
        },
        503,
      );
    }

  } catch {

    return json(
      {
        ok: false,
        error: "PROVIDER_INSUFFICIENT_FUNDS",
        message: "Insufficient funds. Please contact support.",
      },
      503,
    );
  }


  const actualProviderId =
    cleanString(
      provider.providerId,
    ) || "0";


  const actualNumber =
    await getNumberFromProvider(
      countryObject,
      serviceCode,
      actualProviderId,
      providerCost,
    );


  if (!actualNumber) {

    return json(
      {
        error:
          "Number not available. Please try another option.",
      },
      409,
    );
  }


  const activationId =
    cleanString(
      actualNumber.activationId,
    );


  const phoneNumber =
    cleanString(
      actualNumber.phoneNumber,
    );


  const actualProviderCost =
    positiveNumber(
      actualNumber.activationCost,
    ) || providerCost;


  if (
    !activationId ||
    !phoneNumber ||
    !actualProviderCost
  ) {

    return json(
      {
        error:
          "Number not available. Please try another option.",
      },
      409,
    );
  }


  const fx =
    await getLiveUsdNgn();


  const actualCustomerPrice = await calculateCustomerPrice(actualProviderCost, fx, serviceCode, countryId, actualProviderId);


  if (
    !actualCustomerPrice ||
    actualCustomerPrice <= 0
  ) {

    try {

      await smsBowerRequest({
        action:
          "setStatus",

        status:
          8,

        id:
          activationId,
      });

    } catch {
      // best effort
    }


    return json(
      {
        error:
          "Number not available. Please try another option.",
      },
      409,
    );
  }


  const userClient = supabaseAdmin;


  const { data: reserveData, error: reserveError } = await userClient.rpc(
    "reserve_smsbower_virtual_number_purchase",
    {
      p_user_id: user.id,
      p_country_id: countryId,
      p_country_name: cleanString(countryObject.name || body.country_name || ""),
      p_service_code: serviceCode,
      p_service_name: cleanString(body.service_name) || serviceCode,
      p_server_id: actualProviderId,
      p_server_name: cleanString(selectedServer.label) || `Server ${actualProviderId}`,
      p_phone_number: phoneNumber,
      p_activation_id: activationId,
      p_provider_usd: actualProviderCost,
      p_exchange_rate: fx,
      p_customer_price_ngn: actualCustomerPrice,
      p_markup_percent: await getMarkupPercent(serviceCode, countryId, actualProviderId),
    },
  );


  if (reserveError) {

    try {

      await smsBowerRequest({
        action:
          "setStatus",

        status:
          8,

        id:
          activationId,
      });

    } catch {
      // best effort
    }


    const message =
      reserveError.message ||
      "";


    if (message.toLowerCase().includes("insufficient")) {
      const { data: walletRow } = await supabaseAdmin.from("wallet").select("balance").eq("user-id", user.id).maybeSingle();
      const balance = Number(walletRow?.balance || 0);
      const shortfall = Math.max(0, actualCustomerPrice - balance);
      const amount = shortfall.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return json({
        ok: false,
        error: "INSUFFICIENT_FUNDS",
        message: `Insufficient funds. Please add ₦${amount} to your wallet.`,
        requiredAmount: actualCustomerPrice,
        currentBalance: balance,
        shortfall,
      }, 402);
    }


    return json(
      {
        error:
          `Purchase reservation failed: ${message}. If the number was cancelled but your wallet changed, contact support with activation ID ${activationId}.`,
      },
      500,
    );
  }


  try {

    await smsBowerRequest({
      action:
        "setStatus",

      status:
        1,

      id:
        activationId,
    });

  } catch {
    // Order remains waiting.
  }


  return json({
    ok: true,
    success: true,
    message: "Number successfully purchased.",
    order: reserveData,
    activation_id: activationId,
    activationId,
    phone_number: phoneNumber,
    phoneNumber,
    number: phoneNumber,
    price_ngn: actualCustomerPrice,
  });
}


/* ============================================================
   WALLET
============================================================ */

async function getWallet(
  req: Request,
) {

  const user =
    await getUserFromRequest(
      req,
    );


  if (!user) {

    return json(
      {
        error:
          "Authentication required.",
      },
      401,
    );
  }


  try {

    const userClient =
      createUserClient(
        req,
      );


    const {
      data,
      error,
    } =
      await userClient.rpc(
        "ensure_my_wallet",
      );


    if (error) {

      console.error(
        "ensure_my_wallet error:",
        error,
      );


      return json(
        {
          error:
            "Unable to load wallet balance.",
        },
        500,
      );
    }


    let wallet =
      data;


    if (
      Array.isArray(data)
    ) {

      wallet =
        data[0] || {
          balance:
            0,
        };
    }


    const balance =
      Number(
        wallet?.balance ??
        0,
      );


    return json({
      success:
        true,

      wallet: {
        balance:
          Number.isFinite(
            balance,
          )
            ? balance
            : 0,
      },
    });

  } catch (
    error
  ) {

    console.error(
      "wallet error:",
      error,
    );


    return json(
      {
        error:
          "Unable to load wallet balance.",
      },
      500,
    );
  }
}


/* ============================================================
   CHECK ORDER
============================================================ */

async function checkOrder(req: Request, body: any) {
  const user = await getUserFromRequest(req);
  if (!user) return json({ error: "Authentication required." }, 401);

  const orderId = cleanString(body.order_id || body.orderId);
  if (!/^\d+$/.test(orderId)) {
    return json({ error: "Invalid order." }, 400);
  }

  const { data: order, error } = await supabaseAdmin
    .from("virtual_number_orders").select("*")
    .eq("id", Number(orderId)).eq("user_id", user.id).eq("provider_key", "smsbower").maybeSingle();
  if (error || !order) return json({ error: "Order not found." }, 404);

  const currentStatus = cleanString(order.status).toLowerCase();
  if (["cancelled", "canceled", "failed", "refunded"].includes(currentStatus)) {
    return json({ order, status: currentStatus, otp_code: order.otp_code || order.sms_code || order.code || null, code: order.otp_code || order.sms_code || order.code || null });
  }

  const providerActivationId = cleanString(order.activation_id || order.provider_activation_id || order.numpool_order_id).replace(/^smsbower:/i, "");
  if (!providerActivationId || providerActivationId.startsWith("pending:")) {
    return json({ order, status: currentStatus || "waiting", otp_code: order.otp_code || order.sms_code || order.code || null, code: order.otp_code || order.sms_code || order.code || null });
  }

  const raw = await smsBowerRequest({ action: "getStatus", id: providerActivationId });
  const rawText = typeof raw === "string" ? raw.trim() : "";
  const object = raw && typeof raw === "object" ? (raw.data && typeof raw.data === "object" ? raw.data : raw) : {};
  let code = "";
  let smsText = "";
  let status = "waiting";

  if (rawText.startsWith("STATUS_OK:")) {
    code = rawText.slice("STATUS_OK:".length).trim();
  } else if (rawText.startsWith("STATUS_WAIT_RETRY:")) {
    code = rawText.slice("STATUS_WAIT_RETRY:".length).trim();
  } else if (rawText === "STATUS_CANCEL" || rawText === "ACCESS_CANCEL") {
    status = "cancelled";
  } else if (rawText === "STATUS_FINISH" || rawText === "STATUS_OK" || rawText === "FINISH") {
    status = "completed";
  } else if (rawText.startsWith("STATUS_WAIT")) {
    status = "waiting";
  } else if (object && typeof object === "object") {
    code = cleanString(object.otp_code || object.sms_code || object.smsCode || object.code || object.pin || object.verification_code);
    smsText = cleanString(object.sms_text || object.smsText || object.text || object.message || object.sms);
    const providerStatus = cleanString(object.status || object.state || object.result).toLowerCase();
    if (code) status = "completed";
    else if (/cancel/.test(providerStatus)) status = "cancelled";
    else if (/finish|complete|success|received|verified/.test(providerStatus)) status = "completed";
  }

  if (code) {
    // Once the provider has supplied an OTP, close the activation best-effort and
    // persist every common code field so both the dashboard and order history see it.
    try { await smsBowerRequest({ action: "setStatus", status: 6, id: providerActivationId }); } catch (e) {
      console.warn("SMSBower code received; completion request failed:", e instanceof Error ? e.message : e);
    }
    status = "completed";
  }

  if (status === "cancelled") {
    try {
      await cancelAndRefundOrder(order, true);
    } catch (e) {
      console.error("Provider reports cancellation but refund sync failed:", e instanceof Error ? e.message : e);
    }
  }

  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (code) {
    patch.otp_code = code;
    patch.sms_code = code;
    patch.code = code;
  }
  if (smsText) {
    patch.sms_text = smsText;
    patch.text = smsText;
  }

  const savedResult = await supabaseAdmin.from("virtual_number_orders").update(patch)
    .eq("id", order.id).eq("user_id", user.id).select("*").maybeSingle();
  if (savedResult.error) {
    console.error("Could not persist SMSBower status:", savedResult.error.message);
    return json({ error: "The provider status was checked, but saving the order failed. Please retry.", status, otp_code: code || null, sms_code: code || null, code: code || null }, 500);
  }
  const saved = savedResult.data || { ...order, ...patch };
  return json({
    success: true,
    status,
    otp_code: code || saved.otp_code || saved.sms_code || saved.code || null,
    sms_code: code || saved.sms_code || saved.otp_code || saved.code || null,
    code: code || saved.code || saved.otp_code || saved.sms_code || null,
    sms_text: smsText || saved.sms_text || saved.text || null,
    order: saved,
  });
}

/* ============================================================
   CANCEL + REFUND
============================================================ */

async function cancelAndRefundOrder(order: any, providerAlreadyConfirmed = false) {
  if (["cancelled","canceled","refunded"].includes(String(order.status||"").toLowerCase())) return {alreadyDone:true};
  if (["received","completed","success","successful"].includes(String(order.status||"").toLowerCase()) || order.otp_code || order.sms_code || order.code) throw new Error("This number has already received a code and cannot be refunded.");
  const activationId=cleanString(order.activation_id || order.provider_activation_id || order.numpool_order_id).replace(/^smsbower:/i, "");
  if(!activationId || activationId.startsWith("pending:")) throw new Error("SMSBower activation ID is missing; no refund was issued. Contact support.");

  // Before cancellation, check the provider directly. A code may have arrived
  // even while the local database still says waiting/pending.
  if (!providerAlreadyConfirmed) {
    let current:any;
    try { current=await smsBowerRequest({action:"getStatus",id:activationId}); }
    catch(e) { throw new Error(`Could not verify SMSBower status; no cancellation or refund was attempted. ${e instanceof Error?e.message:"Provider error"}`); }
    const text=typeof current==="string"?current.trim():"";
    const object=current && typeof current==="object" ? (current.data && typeof current.data==="object"?current.data:current) : {};
    const code=text.startsWith("STATUS_OK:")?text.slice("STATUS_OK:".length).trim():text.startsWith("STATUS_WAIT_RETRY:")?text.slice("STATUS_WAIT_RETRY:".length).trim():cleanString(object.otp_code||object.sms_code||object.smsCode||object.code||object.pin);
    if(code) {
      await supabaseAdmin.from("virtual_number_orders").update({status:"completed",otp_code:code,sms_code:code,code,updated_at:new Date().toISOString()}).eq("id",order.id).eq("user_id",order.user_id);
      throw new Error("The SMS code has already arrived. The order was updated with the code and cannot be cancelled or refunded.");
    }
    if(text==="STATUS_CANCEL" || text==="ACCESS_CANCEL") providerAlreadyConfirmed=true;
    else if(text==="STATUS_FINISH" || text==="STATUS_OK" || text==="FINISH") throw new Error("SMSBower reports this activation is already finished. No refund was issued.");
  }

  let providerResult:any = "STATUS_CANCEL";
  if (!providerAlreadyConfirmed) {
    try { providerResult=await smsBowerRequest({action:"setStatus",status:8,id:activationId}); }
    catch(e) { throw new Error(`SMSBower cancellation request failed; no refund was issued. ${e instanceof Error?e.message:"Provider error"}`); }
    const resultText=typeof providerResult==="string"?providerResult:JSON.stringify(providerResult);
    if(!/ACCESS_CANCEL|STATUS_CANCEL|CANCELLED|CANCELED/i.test(resultText)) {
      throw new Error(`SMSBower has not confirmed cancellation (${resultText.slice(0,180)}). No refund was issued.`);
    }
  }
  const {data,error}=await supabaseAdmin.rpc("cancel_virtual_number_and_refund",{p_user_id:order.user_id,p_activation_id:activationId});
  if(error) throw new Error(`Provider cancellation confirmed, but refund processing failed. Contact support with activation ID ${activationId}. ${error.message}`);
  if(data && data.success===false) throw new Error(data.message||"Refund was not completed; contact support.");
  return {refund:data,provider_cancel_result:providerResult};
}


async function cancelOrder(
  req: Request,
  body: any,
) {

  const user =
    await getUserFromRequest(
      req,
    );


  if (!user) {

    return json(
      {
        error:
          "Authentication required.",
      },
      401,
    );
  }


  const orderId = cleanString(body.order_id);
  if (!/^\d+$/.test(orderId)) {

    return json(
      {
        error:
          "Invalid order.",
      },
      400,
    );
  }


  const {
    data: order,
    error,
  } =
    await supabaseAdmin
      .from(
        "virtual_number_orders",
      )
      .select("*")
      .eq(
        "id",
        Number(orderId),
      )
      .eq(
        "user_id",
        user.id,
      )
      .eq("provider_key", "smsbower")
      .maybeSingle();


  if (
    error ||
    !order
  ) {

    return json(
      {
        error:
          "Order not found.",
      },
      404,
    );
  }


  try {

    const result =
      await cancelAndRefundOrder(
        order,
      );


    return json({

      success:
        true,

      message:
        `Number cancelled. ₦${Math.ceil(
          Number(
            order.customer_price_ngn,
          ),
        ).toLocaleString()} refunded to your wallet.`,

      result,
    });

  } catch (
    error
  ) {

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to cancel number right now.",
      },
      409,
    );
  }
}


/* ============================================================
   ORDERS
============================================================ */

async function getOrders(
  req: Request,
) {

  const user =
    await getUserFromRequest(
      req,
    );


  if (!user) {

    return json(
      {
        error:
          "Authentication required.",
      },
      401,
    );
  }


  const {
    data,
    error,
  } =
    await supabaseAdmin
      .from(
        "virtual_number_orders",
      )
      .select(
        "id,activation_id,provider_activation_id,numpool_order_id,phone_number,service_code,service_name,country_id,country_name,customer_price_ngn,status,otp_code,sms_code,sms_text,created_at,updated_at,purchased_at",
      )
      .eq(
        "user_id",
        user.id,
      )
      .eq("provider_key", "smsbower")
      .order(
        "created_at",
        {
          ascending:
            false,
        },
      );


  if (error) {

    return json(
      {
        error:
          error.message,
      },
      500,
    );
  }


  return json({

    success:
      true,

    orders:
      data || [],
  });
}


/* ============================================================
   COUNTRIES
============================================================ */

async function getCountries(
  version: string,
) {

  const raw =
    await smsBowerRequest({
      action:
        "getCountries",
    });


  const countries =
    parseCountries(
      raw,
    );


  const config =
    await getVersionConfig(
      version,
    );


  return countries.filter(
    (
      country,
    ) =>
      versionAllowsCountry(
        config,
        Number(
          country.id,
        ),
      ),
  );
}


/* ============================================================
   MAIN
============================================================ */

Deno.serve(
  async (
    req: Request,
  ) => {

    if (
      req.method ===
      "OPTIONS"
    ) {

      return new Response(
        "ok",
        {
          headers:
            corsHeaders,
        },
      );
    }


    try {

      if (
        !SMSBOWER_API_KEY
      ) {

        return json(
          {
            error:
              "SMSBOWER_API_KEY is missing from Edge Function secrets.",
          },
          500,
        );
      }


      let body: any =
        {};


      if (
        req.method !==
        "GET"
      ) {

        try {

          body =
            await req.json();

        } catch {

          body =
            {};
        }
      }


      const action =
        cleanString(
          body.action ||
            new URL(
              req.url,
            ).searchParams.get(
              "action",
            ),
        );


      const version =
        [
          "V1",
          "V2",
          "V3",
        ].includes(
          body.version,
        )
          ? body.version
          : "V1";


      /* ======================================================
         COUNTRIES
      ====================================================== */

      if (
        action ===
        "countries"
      ) {

        const countries =
          await getCountries(
            version,
          );


        return json({

          success:
            true,

          version,

          countries,
        });
      }


      /* ======================================================
         SERVICES
      ====================================================== */

      if (
        action ===
        "services"
      ) {

        const countryId =
          Number(
            body.country_id,
          );


        if (
          !Number.isFinite(
            countryId,
          )
        ) {

          return json(
            {
              error:
                "Please select a country first.",
            },
            400,
          );
        }


        let country: any =
          {

            id:
              countryId,

            name:
              cleanString(
                body.country_name,
              ),

            eng:
              cleanString(
                body.country_name,
              ),
          };


        try {

          const raw =
            await smsBowerRequest({
              action:
                "getCountries",
            });


          const parsed =
            parseCountries(
              raw,
            );


          const found =
            parsed.find(
              (x) =>
                Number(
                  x.id,
                ) ===
                countryId,
            );


          if (found) {
            country =
              found;
          }

        } catch {
          // numeric ID remains
        }


        const services =
          await getServicesForCountry(
            country,
            version,
          );


        return json({

          success:
            true,

          version,

          country_id:
            countryId,

          services,
        });
      }


      /* ======================================================
         PRICES / SERVERS
      ====================================================== */

      if (
        action ===
        "prices"
      ) {

        const countryId =
          Number(
            body.country_id,
          );


        const serviceCode =
          cleanString(
            body.service_code,
          );


        if (
          !Number.isFinite(
            countryId,
          ) ||
          !serviceCode
        ) {

          return json(
            {
              error:
                "Country and service are required.",
            },
            400,
          );
        }


        let country: any =
          {

            id:
              countryId,

            name:
              cleanString(
                body.country_name,
              ),

            eng:
              cleanString(
                body.country_name,
              ),
          };


        try {

          const raw =
            await smsBowerRequest({
              action:
                "getCountries",
            });


          const parsed =
            parseCountries(
              raw,
            );


          const found =
            parsed.find(
              (x) =>
                Number(
                  x.id,
                ) ===
                countryId,
            );


          if (found) {
            country =
              found;
          }

        } catch {
          // continue
        }


        const result =
          await getLiveServers(
            country,
            serviceCode,
            version,
          );


        return json({

          success:
            true,

          version,

          country_id:
            countryId,

          service_code:
            serviceCode,

          exchange_rate:
            result.fx,

          servers:
            result.servers,
        });
      }


      if (action === "admin_countries") return await adminCountries(req);
      if (action === "admin_services") return await adminServices(req);
      if (action === "list_service_settings") return await listAdminSettings(req,"smsbower_service_settings","settings");
      if (action === "list_server_settings") return await listAdminSettings(req,"smsbower_server_settings","settings");
      if (action === "list_display_settings") return await listAdminSettings(req,"smsbower_server_display_settings","settings");
      if (action === "admin_servers") return await adminServers(req,body);
      if (action === "save_service_setting") return await saveAdminSetting(req,body,"service");
      if (action === "delete_service_setting") return await deleteServiceSetting(req,body);
      if (action === "delete_server_setting") return await deleteServerSetting(req,body);
      if (action === "delete_display_setting") return await deleteDisplaySetting(req,body);
      if (action === "save_server_setting") return await saveAdminSetting(req,body,"server");
      if (action === "save_display_setting") return await saveAdminSetting(req,body,"display");
      if (action === "save_price_rule") return await saveMarkupRule(req,body);
      if (action === "list_price_rules") return await getMarkupRules(req);
      if (action === "delete_price_rule") return await deleteMarkupRule(req,body);

      /* ======================================================
         MARKUP RULES
      ====================================================== */

      if (
        action ===
        "markup_rules"
      ) {

        return await getMarkupRules(
          req,
        );
      }


      /* ======================================================
         SAVE MARKUP RULE
      ====================================================== */

      if (
        action ===
        "save_markup_rule"
      ) {

        return await saveMarkupRule(
          req,
          body,
        );
      }


      /* ======================================================
         DELETE MARKUP RULE
      ====================================================== */

      if (
        action ===
        "delete_markup_rule"
      ) {

        return await deleteMarkupRule(
          req,
          body,
        );
      }


      /* ======================================================
         WALLET
      ====================================================== */

      if (
        action ===
        "wallet"
      ) {

        return await getWallet(
          req,
        );
      }


      /* ======================================================
         BUY
      ====================================================== */

      if (
        action ===
        "buy"
      ) {

        return await buyNumber(
          req,
          body,
        );
      }


      /* ======================================================
         CHECK
      ====================================================== */

      if (
        action ===
        "check"
      ) {

        return await checkOrder(
          req,
          body,
        );
      }


      /* ======================================================
         CANCEL
      ====================================================== */

      if (
        action ===
        "cancel"
      ) {

        return await cancelOrder(
          req,
          body,
        );
      }


      /* ======================================================
         ORDERS
      ====================================================== */

      if (
        action ===
        "orders"
      ) {

        return await getOrders(
          req,
        );
      }


      /* ======================================================
         EXCHANGE RATE
      ====================================================== */

      if (
        action ===
        "exchange_rate"
      ) {

        const rate =
          await getLiveUsdNgn();


        return json({

          success:
            true,

          usd_ngn:
            rate,

          markup:
            "Database pricing rules; USA default 100% markup; other countries default 200% markup",

          default_markup_percent:
            DEFAULT_MARKUP_PERCENT,
          usa_markup_percent: USA_MARKUP_PERCENT,

          usa_markup_percent: USA_MARKUP_PERCENT,
          usa_whatsapp_markup_percent:
            USA_WHATSAPP_MARKUP_PERCENT,

          default_multiplier:
            DEFAULT_MARKUP_MULTIPLIER,

          usa_multiplier: USA_MARKUP_MULTIPLIER,
          usa_whatsapp_multiplier:
            USA_WHATSAPP_MARKUP_MULTIPLIER,
        });
      }


      /* ======================================================
         UNKNOWN
      ====================================================== */

      return json(
        {
          error:
            "Unknown action.",
        },
        400,
      );

    } catch (
      error
    ) {

      console.error(
        "numpool-api error:",
        error,
      );


      const message =
        error instanceof Error
          ? error.message
          : "Unexpected server error.";


      return json(
        {
          error:
            message,
        },
        500,
      );
    }
  },
);
