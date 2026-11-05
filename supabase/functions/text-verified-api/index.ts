
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* =========================================================
   CONFIGURATION
========================================================= */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const TV_USERNAME = Deno.env.get("TEXTVERIFIED_API_USERNAME") ?? "";
const TV_API_KEY = Deno.env.get("TEXTVERIFIED_API_KEY") ?? "";
const TV_BASE = "https://www.textverified.com/api/pub/v2";

const AUTO_REFUNDED_PROVIDER_FAILURE =
  "provider_insufficient_funds_refunded";

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Content-Type": "application/json",
};

function sanitizeCustomerPayload(value: any, key = ""): any {
  if (/^(provider_key|provider_name|provider_order_id|provider_order|provider_state|provider_response|provider_data|provider|server|server_id|server_name|servername)$/i.test(key)) return undefined;
  if (typeof value === "string") return value.replace(/\b(?:varsha\s*sms|varsha|text\s*verified|textverified|text\s*provider|virtual\s*sms|virtualsms|bashua\s*sms|bashua|grizzly\s*sms|grizzlysms|grizzly|smsbower|5sim)\b/gi, "").replace(/\s{2,}/g, " ").trim();
  if (Array.isArray(value)) return value.map((v) => sanitizeCustomerPayload(v)).filter((v) => v !== undefined);
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) { const next = sanitizeCustomerPayload(v, k); if (next !== undefined) clean[k] = next; }
    return clean;
  }
  return value;
}
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(sanitizeCustomerPayload(data)), { status, headers: corsHeaders });
}

function fail(
  message: string,
  status = 400,
  extra: Record<string, unknown> = {},
) {
  return response(
    { success: false, error: message, message, ...extra },
    status,
  );
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function getRows(data: any): any[] {
  if (Array.isArray(data)) return data;

  for (const key of ["data", "results", "services", "verifications"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }

  return [];
}

/* =========================================================
   PROVIDER ERROR DETECTION
========================================================= */

function isInsufficientProviderBalance(error: any): boolean {
  const status = Number(error?.status ?? 0);
  if (status === 402) return true;

  const parts: string[] = [];
  const visited = new Set<object>();

  function collect(value: any, depth = 0): void {
    if (depth > 6 || value == null) return;

    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
      return;
    }

    if (typeof value !== "object" || visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }

    for (const [key, item] of Object.entries(value)) {
      parts.push(key);
      collect(item, depth + 1);
    }
  }

  collect(error?.message);
  collect(error?.code);
  collect(error?.data);
  collect(error?.error);
  collect(error?.detail);
  collect(error?.response);

  const text = parts.join(" ").toLowerCase();

  return (
    /\binsufficient[_\s-]*(funds?|balance|credits?)\b/i.test(text) ||
    /\b(not enough|lack of|low|insufficient|exhausted|depleted)\b.{0,80}\b(balance|funds?|credits?)\b/i.test(text) ||
    /\b(balance|funds?|credits?)\b.{0,80}\b(too low|insufficient|exhausted|not enough|depleted)\b/i.test(text) ||
    /\b(account balance|provider balance)\b.{0,80}\b(low|insufficient|exhausted|not enough|depleted)\b/i.test(text) ||
    /\b(insufficient_balance|insufficient_funds|low_balance|insufficient_credits|low_credits)\b/i.test(text)
  );
}

function sanitizeProviderErrorText(value: unknown): string {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(?:api[_ -]?key|token|password)\s*[:=]\s*\S+/gi, "[REDACTED]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[REDACTED NUMBER]")
    .replace(/\s{2,}/g, " ")
    .slice(0, 240);
}

function extractProviderErrorMessage(data: any): string {
  const found: string[] = [];
  const seen = new Set<object>();
  const preferred = /^(message|detail|error|title|description|reason|code)$/i;
  function walk(value: any, depth = 0, key = ""): void {
    if (depth > 5 || value == null) return;
    if (typeof value === "string" || typeof value === "number") {
      if (preferred.test(key) && String(value).trim()) found.push(sanitizeProviderErrorText(value));
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, key);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) walk(child, depth + 1, childKey);
  }
  walk(data);
  return [...new Set(found)].filter(Boolean).join("; ").slice(0, 300);
}

function logSafeError(stage: string, error: unknown) {
  const e = error as any;
  let message = str(e?.message, "Unknown error");

  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /(?:api[_ -]?key|token|password)\s*[:=]\s*\S+/gi,
      "[REDACTED]",
    )
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[REDACTED NUMBER]")
    .slice(0, 300);

  // Log only a small allowlist of provider error fields. Never log the
  // raw response body because it may contain phone numbers or account data.
  const providerErrorSummary = extractProviderErrorMessage(e?.data);

  console.error(`[${stage}]`, {
    status: Number(e?.status) || null,
    path: str(e?.path, e?.stage),
    message,
    providerErrorSummary,
    insufficientBalance: isInsufficientProviderBalance(e),
  });
}

/* =========================================================
   TEXTVERIFIED AUTHENTICATION
========================================================= */

let cachedToken = "";
let tokenExpiry = 0;

async function getToken(forceRefresh = false): Promise<string> {
  if (!TV_USERNAME || !TV_API_KEY) {
    throw new Error(
      "TextVerified credentials are missing. Check TEXTVERIFIED_API_USERNAME and TEXTVERIFIED_API_KEY in Supabase Secrets.",
    );
  }

  if (!forceRefresh && cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  let result: Response | null = null;
  let authFailure: unknown = null;
  // Auth was previously outside the retry path. A transient auth-gateway
  // failure therefore prevented the services request from ever being made.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      result = await fetch(`${TV_BASE}/auth`, {
        method: "POST",
        // Match TextVerified's documented SDK auth request exactly:
        // POST /auth with only the two credential headers and no body.
        headers: {
          "X-API-KEY": TV_API_KEY,
          "X-API-USERNAME": TV_USERNAME,
        },
      });
      if (![429, 500, 502, 503, 504].includes(result.status) || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    } catch (error) {
      authFailure = error;
      if (attempt === 3) throw Object.assign(new Error("TextVerified authentication request failed or timed out."), { path: "/auth", cause: error });
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  if (!result) throw Object.assign(new Error("TextVerified authentication returned no response."), { path: "/auth", cause: authFailure });

  const raw = await result.text();
  let data: any;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }

  if (!result.ok) {
    const error = new Error(
      str(
        data?.message,
        data?.error,
        data?.detail,
        `TextVerified authentication failed (${result.status}).`,
      ),
    );

    Object.assign(error, { status: result.status, data, path: "/auth" });
    throw error;
  }

  cachedToken = str(
    data?.token,
    data?.access_token,
    data?.data?.token,
  );

  if (!cachedToken) {
    throw new Error("TextVerified did not return an authentication token.");
  }

  tokenExpiry = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

async function tvRequest(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<any> {
  const token = await getToken();
  const headers = new Headers(options.headers);

  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");

  if (options.body) {
    headers.set("Content-Type", "application/json");
  }

  let result: Response | null = null;
  // Retry transient provider gateway failures before returning an error.
  // This does not retry authentication, validation, or other client errors.
  let lastFetchError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      result = await fetch(`${TV_BASE}${path}`, {
        ...options,
        headers,
      });
      if (![429, 500, 502, 503, 504].includes(result.status) || attempt === 3) break;
    } catch (error) {
      lastFetchError = error;
      if (attempt === 3) {
        throw Object.assign(new Error("TextVerified request failed or timed out."), { path, cause: error });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  if (!result) throw Object.assign(new Error("TextVerified request did not return a response."), { path, cause: lastFetchError });

  const raw = await result.text();
  let data: any;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }

  if (result.status === 401 && retry) {
    await getToken(true);
    return await tvRequest(path, options, false);
  }

  const providerError = {
    status: result.status,
    data,
    message: extractProviderErrorMessage(data),
  };

  // Check provider account funding before treating any failed response as
  // a stock or generic request error. Some provider versions return HTTP 400.
  if (isInsufficientProviderBalance(providerError)) {
    const error = new Error("Insufficient funds. Please contact support.");
    Object.assign(error, {
      status: result.status,
      data,
      provider: "textverified",
      path,
      code: "PROVIDER_INSUFFICIENT_FUNDS",
      providerMessage: extractProviderErrorMessage(data),
    });
    throw error;
  }

  if (!result.ok) {
    const error = new Error(
      str(
        extractProviderErrorMessage(data),
        `Number request failed (${result.status}).`,
      ),
    );

    Object.assign(error, {
      status: result.status,
      data,
      provider: "textverified",
      path,
      providerMessage: extractProviderErrorMessage(data),
    });

    throw error;
  }

  return data;
}

/* =========================================================
   USER AUTHENTICATION
========================================================= */

async function getUser(req: Request) {
  const authorization = req.headers.get("Authorization");

  if (!authorization) {
    throw new Error("Please log in to continue.");
  }

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await client.auth.getUser();

  if (error || !data.user) {
    throw new Error("Your session has expired. Please log in again.");
  }

  return data.user;
}

/* =========================================================
   WALLET
========================================================= */

async function walletBalance(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("wallet")
    .select("balance")
    .eq("user-id", userId)
    .maybeSingle();

  if (error) {
    logSafeError("textverified-wallet-read", error);
    throw new Error("Unable to retrieve your wallet balance.");
  }

  return num(data?.balance);
}

/* =========================================================
   EXCHANGE RATE
========================================================= */

async function getFxRate(): Promise<number> {
  const urls = [
    "https://open.er-api.com/v6/latest/USD",
    "https://api.frankfurter.dev/v1/latest?base=USD&symbols=NGN",
  ];

  for (const url of urls) {
    try {
      const result = await fetch(url);
      if (!result.ok) continue;

      const data = await result.json();
      const rate = num(data?.rates?.NGN);

      if (rate > 0) return rate;
    } catch {
      // Try the fallback provider.
    }
  }

  throw new Error("Unable to retrieve the current USD to NGN exchange rate.");
}

/* =========================================================
   SERVICES
========================================================= */

function normalizeService(item: any) {
  const name = str(
    item?.serviceName,
    item?.name,
    item?.service,
    item?.id,
  );

  return {
    name,
    service_name: name,
    description: str(
      item?.description,
      item?.displayName,
      item?.display_name,
      name,
    ),
    capability: str(item?.capability, item?.defaultCapability, "sms"),
    provider_data: item,
  };
}

async function listServices() {
  const result = await tvRequest(
    "/services?numberType=mobile&reservationType=verification",
  );

  return getRows(result)
    .map(normalizeService)
    .filter((item) => item.name);
}

/* =========================================================
   MARKUP AND QUOTING
========================================================= */

async function getMarkup(serviceName: string): Promise<number> {
  const code = serviceName.toLowerCase();

  const { data: override, error: overrideError } = await supabase
    .from("virtual_number_price_overrides")
    .select("*")
    .eq("country_id", 187)
    .eq("service_code", code)
    .eq("is_active", true)
    .maybeSingle();

  if (!overrideError && override) {
    return num(override.markup_percent, 0);
  }

  const { data: rules, error: rulesError } = await supabase
    .from("virtual_number_markup_rules")
    .select("*")
    .eq("server", "textverified")
    .eq("is_active", true);

  if (rulesError) {
    logSafeError("textverified-markup-rules", rulesError);
  }

  const items = rules ?? [];

  const serviceRule = items.find((item: any) =>
    str(item.service_code).toLowerCase() === code &&
    (item.country_id === 187 || item.country_id == null)
  );

  const defaultRule = items.find((item: any) =>
    !item.service_code &&
    (item.country_id === 187 || item.country_id == null)
  );

  return num(
    serviceRule?.markup_percent ?? defaultRule?.markup_percent,
    100,
  );
}

async function getQuote(serviceName: string, capability = "sms") {
  if (!serviceName) {
    throw new Error("Choose a service first.");
  }

  const allowedCapabilities = ["sms", "voice", "smsAndVoiceCombo"];

  if (!allowedCapabilities.includes(capability)) {
    throw new Error("Unsupported verification capability.");
  }

  const result = await tvRequest("/pricing/verifications", {
    method: "POST",
    body: JSON.stringify({
      serviceName,
      areaCode: false,
      carrier: false,
      numberType: "mobile",
      capability,
    }),
  });

  const providerPrice = num(
    result?.price ??
      result?.cost ??
      result?.data?.price ??
      result?.data?.cost,
    -1,
  );

  if (providerPrice < 0) {
    throw new Error(
      "TextVerified did not return a valid price for this service.",
    );
  }

  const [fx, markup] = await Promise.all([
    getFxRate(),
    getMarkup(serviceName),
  ]);

  const costNaira = providerPrice * fx;

  return {
    success: true,
    service: serviceName,
    country: "United States",
    country_id: 187,
    provider_price: providerPrice,
    exchange_rate: fx,
    markup_percent: markup,
    cost_naira: Math.ceil(costNaira),
    price: Math.ceil(costNaira * (1 + markup / 100)),
    currency: "NGN",
    capability,
  };
}

/* =========================================================
   RESERVE CUSTOMER ORDER
========================================================= */

async function reserveOrder(args: {
  userId: string;
  service: string;
  price: number;
  providerPrice: number;
  exchangeRate: number;
  markup: number;
  idempotencyKey: string;
}) {
  const providerCostNgn = Math.ceil(
    args.providerPrice * args.exchangeRate,
  );

  const { data, error } = await supabase.rpc(
    "reserve_virtual_number_order",
    {
      p_user_id: args.userId,
      p_provider_key: "textverified",
      p_idempotency_key: args.idempotencyKey,
      p_service_code: args.service.toLowerCase(),
      p_service_name: args.service,
      p_country_id: 187,
      p_country_name: "United States",
      p_customer_price_ngn: args.price,
      p_exchange_rate: args.exchangeRate,
      p_provider_cost_usd: args.providerPrice,
      p_provider_cost_ngn: providerCostNgn,
    },
  );

  if (error) {
    logSafeError("textverified-reserve-order", error);
    throw new Error("Unable to reserve this order.");
  }

  const order = Array.isArray(data) ? data[0] : data;

  if (order?.success === false) {
    if (order?.error === "insufficient_wallet_balance") {
      throw new Error(
        "Insufficient wallet funds. Please add money to your wallet.",
      );
    }

    throw new Error(
      str(order?.message, order?.error, "Unable to reserve this order."),
    );
  }

  return order;
}

async function ownedOrder(orderId: string, userId: string) {
  if (!orderId) throw new Error("Order ID is required.");

  const { data, error } = await supabase
    .from("virtual_number_orders")
    .select("*")
    .eq("id", orderId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) throw new Error("Order not found.");
  return data;
}

/* =========================================================
   REFUND HELPER
========================================================= */

async function refundTextVerifiedOrder(
  orderId: string,
  reason: string,
) {
  const { data, error } = await supabase.rpc(
    "process_virtual_number_refund",
    {
      p_order_id: Number(orderId),
      p_provider_key: "textverified",
      p_reason: reason,
    },
  );

  if (error) {
    logSafeError("textverified-refund", error);

    return {
      confirmed: false,
      alreadyRefunded: false,
      data: null,
    };
  }

  const refund = Array.isArray(data) ? data[0] : data;
  const alreadyRefunded = refund?.already_refunded === true;
  const newlyRefunded = refund?.success === true;

  return {
    confirmed: newlyRefunded || alreadyRefunded,
    alreadyRefunded,
    data: refund,
  };
}

/* =========================================================
   MARK AUTOMATIC PROVIDER-FUNDS REFUND

   This marker is deliberately set ONLY for an automatically
   refunded failed purchase. Genuine customer cancellations
   do not receive this marker.
========================================================= */

async function markAutomaticProviderRefund(
  orderId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("virtual_number_orders")
    .update({
      provider_state: AUTO_REFUNDED_PROVIDER_FAILURE,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("user_id", userId)
    .eq("provider_key", "textverified")
    .select("id")
    .maybeSingle();

  if (error || !data) {
    logSafeError(
      "textverified-mark-automatic-provider-refund",
      error ?? new Error("Order marker update returned no row."),
    );
    return false;
  }

  return true;
}

/* =========================================================
   PROVIDER LINKS
========================================================= */

function safeProviderLink(link: unknown): string {
  const value = typeof link === "string" ? link : str((link as any)?.href, (link as any)?.url);
  if (!value) return "";
  try {
    const url = new URL(value, TV_BASE);
    const base = new URL(TV_BASE);
    if (url.protocol !== "https:" || url.hostname !== base.hostname) return "";
    if (!url.pathname.startsWith("/api/pub/v2/")) return "";
    return url.toString();
  } catch { return ""; }
}

async function fetchProviderLink(
  link: unknown,
  method = "GET",
) {
  const url = safeProviderLink(link);
  const linkMethod = str((link as any)?.method, method).toUpperCase();
  const requestMethod = linkMethod === "POST" ? "POST" : "GET";

  if (!url) {
    throw new Error("TextVerified returned an invalid provider link.");
  }

  const token = await getToken();

  const result = await fetch(url, {
    method: requestMethod,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const raw = await result.text();
  let data: any;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }

  if (!result.ok) {
    const error = new Error(
      str(
        data?.message,
        data?.error,
        data?.detail,
        `TextVerified request failed (${result.status}).`,
      ),
    );

    Object.assign(error, {
      status: result.status,
      data,
      provider: "textverified",
    });

    throw error;
  }

  return data;
}

function customerServiceLabel(serviceName: string): string {
  const raw = str(serviceName).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return "This service";
  const key = raw.toLowerCase();
  const known: Record<string, string> = {
    whatsapp: "WhatsApp",
    telegram: "Telegram",
    gmail: "Gmail",
    "google voice": "Google Voice",
    instagram: "Instagram",
    facebook: "Facebook",
    tiktok: "TikTok",
    snapchat: "Snapchat",
    discord: "Discord",
    amazon: "Amazon",
    microsoft: "Microsoft",
  };
  return known[key] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

function outOfStockMessage(serviceName: string): string {
  return `${customerServiceLabel(serviceName)} is out of stock. Please try again later.`;
}

function isExplicitOutOfStock(error: any): boolean {
  const extracted = extractProviderErrorMessage(error?.data).toLowerCase().trim();
  const text = [
    error?.message,
    error?.providerMessage,
    extracted,
    error?.data,
  ].map((v) => typeof v === "string" ? v : JSON.stringify(v ?? "")).join(" ").toLowerCase();
  const status = Number(error?.status ?? 0);
  // The provider uses an "Unavailable" error for an empty number pool.
  // Restrict this short generic code to client-error responses so a 503
  // gateway outage is never mislabeled as service stock.
  const unavailableCode = status >= 400 && status < 500 &&
    /^(unavailable|no[_\s-]*numbers?|out[_\s-]*of[_\s-]*stock|inventory[_\s-]*unavailable)$/.test(extracted.replace(/\s+/g, " "));
  return unavailableCode ||
    /out of stock|no available numbers?|no numbers? available|no phone numbers? available|inventory unavailable|no inventory|no number available|number availability exhausted|no stock available/.test(text);
}

/* =========================================================
   BUY NUMBER
========================================================= */


function extractProviderExpiry(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  const objects = [payload, payload.data, payload.order, payload.verification, payload.result]
    .filter((item: any) => item && typeof item === "object");
  const absoluteKeys = ["provider_expires_at","expires_at","expiresAt","expiration_time","expirationTime","expiry_at","expiryAt","expires_on","expiresOn","end_time","endTime","expiration"];
  for (const obj of objects) {
    for (const key of absoluteKeys) {
      const value = obj[key];
      if (value === undefined || value === null || value === "") continue;
      let date: Date | null = null;
      if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value))) {
        const n = Number(value);
        date = new Date(n > 1e12 ? n : n > 1e9 ? n * 1000 : NaN);
      } else {
        const parsed = Date.parse(String(value));
        if (Number.isFinite(parsed)) date = new Date(parsed);
      }
      if (date && Number.isFinite(date.getTime())) return date.toISOString();
    }
    for (const key of ["expires_in_seconds","expiresInSeconds","duration_seconds","durationSeconds","ttl_seconds","ttlSeconds"]) {
      const seconds = Number(obj[key]);
      if (Number.isFinite(seconds) && seconds > 0 && seconds < 86400 * 30) {
        return new Date(Date.now() + seconds * 1000).toISOString();
      }
    }
  }
  return null;
}

async function actionBuy(body: any, userId: string, req: Request) {
  const serviceName = str(body.service, body.service_name, body.serviceName);
  const capability = str(body.capability, "sms");

  // Check price and wallet first, but do not reserve/debit anything yet.
  const pricing = await getQuote(serviceName, capability);
  const balance = await walletBalance(userId);
  if (balance < pricing.price) {
    const shortfall = Math.ceil(pricing.price - balance);
    return fail(`Insufficient funds. Please add ₦${shortfall.toLocaleString("en-NG")}.`, 400, {
      error_code: "INSUFFICIENT_WALLET_FUNDS", balance, price: pricing.price, shortfall,
    });
  }

  const idempotencyKey = str(
    req.headers.get("idempotency-key"), body.idempotency_key, body.idempotencyKey,
  ) || crypto.randomUUID();

  // Availability lookup is not a purchase. Ask for the number first.
  // A customer order and wallet debit are created ONLY after a real number
  // and a retrievable verification ID are both returned.
  let provider: any;
  try {
    provider = await tvRequest("/verifications", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        serviceName, capability, numberType: "mobile",
        areaCodeSelectOption: [], carrierSelectOption: [],
      }),
    });
  } catch (error) {
    logSafeError("textverified-availability-request", error);
    const providerStatus = Number((error as any)?.status ?? 0);
    const providerMessage = str(
      (error as any)?.providerMessage,
      (error as any)?.message,
      extractProviderErrorMessage((error as any)?.data),
    ).toLowerCase();

    // A low provider credit balance is an account-funding issue, not stock.
    // Do not tell customers the service is out of stock in this case.
    if (isInsufficientProviderBalance(error)) {
      return fail("Insufficient funds. Please contact support.", 402, {
        error_code: "PROVIDER_INSUFFICIENT_FUNDS",
        no_customer_charge: true,
      });
    }

    // HTTP 404/409 alone is not proof of empty inventory. Only explicit
    // provider stock wording is shown to customers as an out-of-stock result.
    if (isExplicitOutOfStock(error)) {
      return fail(outOfStockMessage(serviceName), 409, {
        error_code: "NUMBER_OUT_OF_STOCK",
        no_customer_charge: true,
      });
    }

    return fail("The number request could not be completed. No money was deducted. Please try again later.", 503, {
      error_code: "NUMBER_REQUEST_FAILED",
    });
  }

  let details = provider;
  let providerOrderId = str(
    provider?.id, provider?.verificationId, provider?.verification_id,
    provider?.data?.id, provider?.data?.verificationId,
  );
  const selfLink = provider?.href ?? provider?.links?.self?.href;
  if (!providerOrderId && selfLink) {
    try {
      details = await fetchProviderLink(selfLink);
      providerOrderId = str(
        details?.id, details?.verificationId, details?.verification_id,
        details?.data?.id, details?.data?.verificationId,
      );
    } catch (error) {
      logSafeError("textverified-availability-details", error);
      if (isInsufficientProviderBalance(error)) {
        return fail("Insufficient funds. Please contact support.", 402, {
          error_code: "PROVIDER_INSUFFICIENT_FUNDS",
          no_customer_charge: true,
        });
      }
      if (isExplicitOutOfStock(error)) {
        return fail(outOfStockMessage(serviceName), 409, {
          error_code: "NUMBER_OUT_OF_STOCK",
          no_customer_charge: true,
        });
      }
      return fail("We could not confirm an available number. No money was deducted. Please try again later.", 503, {
        error_code: "NUMBER_AVAILABILITY_UNAVAILABLE",
        no_customer_charge: true,
      });
    }
  }

  const phone = str(
    details?.number, details?.phoneNumber, details?.phone_number,
    details?.data?.number, details?.data?.phoneNumber, details?.data?.phone_number,
    provider?.number, provider?.phoneNumber, provider?.phone_number,
  );

  // No usable allocation means out of stock. If a reservation ID exists,
  // best-effort cancel it before returning. The customer has not been charged.
  if (!providerOrderId || !phone) {
    if (providerOrderId) {
      try {
        await tvRequest("/verifications/" + encodeURIComponent(providerOrderId) + "/cancel", {
          method: "POST",
        });
      } catch (cancelError) {
        logSafeError("textverified-release-number-without-phone", cancelError);
      }
    }
    return fail(outOfStockMessage(serviceName), 409, {
      error_code: "NUMBER_OUT_OF_STOCK",
      no_customer_charge: true,
    });
  }

  const providerExpiresAt = extractProviderExpiry(details) ?? extractProviderExpiry(provider);

  // The provider has returned a real number. Only now create the customer
  // order and debit the wallet, using the same idempotency key.
  let orderId = "";
  try {
    const reserved = await reserveOrder({
      userId, service: serviceName, price: pricing.price,
      providerPrice: pricing.provider_price, exchangeRate: pricing.exchange_rate,
      markup: pricing.markup_percent, idempotencyKey,
    });
    orderId = str(reserved?.order_id, reserved?.id, reserved?.order?.id);
    if (!orderId) throw new Error("Order reservation did not return an order ID.");

    if (reserved?.existing === true) {
      return response({
        success: true, pending: true, order_id: orderId,
        message: "This number request already exists. Check your existing order.",
      }, 202);
    }

    const { data: attached, error: attachError } = await supabase.rpc(
      "attach_virtual_number_provider_order",
      {
        p_order_id: Number(orderId), p_user_id: userId,
        p_provider_key: "textverified", p_provider_order_id: providerOrderId,
        p_number: phone, p_provider_expires_at: providerExpiresAt,
        p_provider_state: "waiting",
      },
    );

    if (attachError || !attached) {
      logSafeError("textverified-attach-order", attachError ?? new Error("Number allocation could not be attached."));
      const refund = await refundTextVerifiedOrder(orderId, "Automatic refund: allocated number could not be attached to the customer order");
      if (refund.confirmed) {
        await markAutomaticProviderRefund(orderId, userId);
        await supabase.from("transactions").update({ status: "cancelled" })
          .eq("reference", "VNUM-" + orderId).eq("type", "virtual_number_purchase");
      }
      return response({
        success: false, refunded: refund.confirmed, refund_pending: !refund.confirmed,
        error_code: refund.confirmed ? "ORDER_ATTACH_FAILED_REFUNDED" : "ORDER_ATTACH_REFUND_REVIEW",
        message: refund.confirmed
          ? "The number could not be attached to your order. Your wallet has been refunded."
          : "The number was allocated, but the order needs support review. Please contact support before trying again.",
      }, refund.confirmed ? 502 : 202);
    }

    console.info("[textverified-buy] Number allocated and customer order attached.", {
      orderId, hasProviderOrderId: true, hasPhoneNumber: true,
    });
    return response({
      success: true, pending: true, order_id: orderId, order: attached,
      number: phone, message: "Your number is ready. Waiting for the verification code.",
    });
  } catch (error) {
    logSafeError("textverified-buy-after-allocation", error);
    if (orderId) {
      const refund = await refundTextVerifiedOrder(orderId, "Automatic refund: purchase could not be completed after number allocation");
      if (refund.confirmed) {
        await markAutomaticProviderRefund(orderId, userId);
        await supabase.from("transactions").update({ status: "cancelled" })
          .eq("reference", "VNUM-" + orderId).eq("type", "virtual_number_purchase");
      }
      return response({
        success: false, refunded: refund.confirmed, refund_pending: !refund.confirmed,
        error_code: refund.confirmed ? "PURCHASE_FAILED_REFUNDED" : "PURCHASE_REFUND_REVIEW",
        message: refund.confirmed
          ? "The purchase could not be completed. Your wallet has been refunded."
          : "The purchase needs support review. Please contact support before trying again.",
      }, refund.confirmed ? 502 : 202);
    }
    if (isInsufficientProviderBalance(error)) {
      return fail("Insufficient funds. Please contact support.", 402, {
        error_code: "PROVIDER_INSUFFICIENT_FUNDS",
        no_customer_charge: true,
      });
    }
    return fail("The number could not be secured. No money was deducted. Please try again later.", 503, {
      error_code: "NUMBER_ALLOCATION_FAILED",
      no_customer_charge: true,
    });
  }
}
/* =========================================================
   TEXTVERIFIED SMS / OTP EXTRACTION
========================================================= */

function decodeSmsEntities(value: string): string {
  return value.replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}
function normalizeOtp(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const digits = String(value).trim().replace(/[^0-9]/g, "");
  return /^\d{4,8}$/.test(digits) ? digits : "";
}
function extractTextVerifiedOtp(result: any, sms: any): string {
  const seen = new Set<any>(), candidates: any[] = [];
  const walk = (v: any, d = 0): void => {
    if (v == null || d > 8 || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
    candidates.push(v);
    for (const [k, x] of Object.entries(v)) {
      if (/^(href|url|link|links|id|verificationid|verification_id|reservationid|reservation_id|number|phone|phonenumber|phone_number|created_at|received_at)$/i.test(k)) continue;
      if (x && typeof x === "object") walk(x, d + 1);
    }
  };
  walk(result); walk(sms);
  for (const item of candidates) for (const key of ["code","otp","sms_code","verificationCode","verification_code","pin"]) { const code = normalizeOtp(item?.[key]); if (code) return code; }
  const texts: string[] = [], textKeys = new Set(["content","text","body","message","smscontent","sms_content","messagebody","message_body","sms","messages","data","results","items"]);
  const collect = (v: any, d = 0): void => {
    if (v == null || d > 8) return;
    if (typeof v === "string") { if (!/^https?:\/\//i.test(v)) texts.push(decodeSmsEntities(v)); return; }
    if (typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) collect(x, d + 1); return; }
    for (const [k, x] of Object.entries(v)) {
      if (/^(href|url|link|links|id|verificationid|verification_id|reservationid|reservation_id|number|phone|phonenumber|phone_number)$/i.test(k)) continue;
      if (textKeys.has(k.toLowerCase()) || (x && typeof x === "object")) collect(x, d + 1);
    }
  };
  collect(result); collect(sms);
  const patterns = [
    /(?:verification|security|sms|login|one[- ]time|confirmation|whatsapp)?\s*(?:code|otp|pin)\s*(?:is|:|=|-)?\s*["']?(\d{3,4}(?:[\s-]\d{3,4})?)/i,
    /(?:code|otp|pin)[^\d]{0,28}(\d{3,4}(?:[\s-]\d{3,4})?)/i,
    /(\d{3,4}(?:[\s-]\d{3,4})?)\s*(?:is your|is the|for your)?\s*(?:verification|security|sms|login)?\s*(?:code|otp|pin)\b/i
  ];
  for (const text of texts) for (const pattern of patterns) { const code = normalizeOtp(text.match(pattern)?.[1]); if (code) return code; }
  return "";
}
function extractTextVerifiedSmsText(value: any): string {
  const seen = new Set<any>(), messages: string[] = [];
  const visit = (v: any, d = 0): void => {
    if (v == null || d > 8) return;
    if (typeof v === "string") { const t = decodeSmsEntities(v).trim(); if (t && !/^https?:\/\//i.test(t) && !/^[{[]/.test(t)) messages.push(t); return; }
    if (typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) visit(x, d + 1); return; }
    for (const [k, x] of Object.entries(v)) {
      if (/^(href|url|link|links|id|verificationid|verification_id|reservationid|reservation_id|number|phone|phonenumber|phone_number)$/i.test(k)) continue;
      if (/^(content|text|body|message|smscontent|sms_content|messagebody|message_body|sms|messages|data|results|items)$/i.test(k) || (x && typeof x === "object")) visit(x, d + 1);
    }
  };
  visit(value); return [...new Set(messages)].join("\n").slice(0, 4000);
}
function parseSavedSmsLink(value: unknown): any {
  if (typeof value !== "string" || !value.trim()) return null;
  try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed.find((x) => x && (x.href || x.url)) ?? null; return parsed && typeof parsed === "object" && (parsed.href || parsed.url) ? parsed : null; }
  catch { return null; }
}
async function getTextVerifiedSms(verification: any, phone: string, providerOrderId = "", savedSms = ""): Promise<any> {
  const embedded = verification?.sms ?? verification?.messages ?? verification?.data?.sms ?? verification?.data?.messages ?? verification?.verification?.sms;
  const links = [verification?.links?.sms, verification?.links?.messages, verification?._links?.sms, verification?.data?.links?.sms, verification?.smsHref, verification?.sms_href, embedded && typeof embedded === "object" ? embedded : null, parseSavedSmsLink(savedSms)].filter(Boolean);
  for (const link of links) {
    try {
      let data = await fetchProviderLink(link);
      for (let depth = 0; depth < 2; depth++) {
        const nested = data?.links?.sms ?? data?.links?.messages ?? data?._links?.sms ?? data?.data?.links?.sms ?? (data?.sms && typeof data.sms === "object" && (data.sms.href || data.sms.url) ? data.sms : null);
        if (!nested) break; data = await fetchProviderLink(nested);
      }
      if (extractTextVerifiedSmsText(data) || Array.isArray(data) || data?.results || data?.data) return data;
    } catch (e) { logSafeError("textverified-sms-link-fetch", e); }
  }
  const reservationId = str(providerOrderId, verification?.id, verification?.reservationId, verification?.reservation_id, verification?.data?.id);
  if (reservationId) { try { return await tvRequest("/sms?reservationId=" + encodeURIComponent(reservationId)); } catch (e) { logSafeError("textverified-sms-reservation-fetch", e); } }
  if (phone) { try { return await tvRequest("/sms?to=" + encodeURIComponent(phone) + "&reservationType=verification"); } catch (e) { logSafeError("textverified-sms-list-fetch", e); } }
  return embedded ?? null;
}
function isVerificationComplete(value: unknown): boolean {
  const state = String(value ?? "").toLowerCase().replace(/[\s_-]/g, "");
  return ["verificationcompleted","completed","complete","success","successful","received","finished","verified","smsreceived"].includes(state);
}
async function actionStatus(orderId:string,userId:string){
 const order=await ownedOrder(orderId,userId);
 if(str(order.provider_state).toLowerCase()===AUTO_REFUNDED_PROVIDER_FAILURE)return response({success:true,order,refunded:true,hidden_failed_purchase:true});
 const current=str(order.status).toLowerCase();
 if(["cancelled","canceled","refunded","expired","failed"].includes(current))return response({success:true,order});
 const received=Boolean(str(order.otp_code)||order.code_received_at||["received","completed","finished","success","successful"].includes(current)||isVerificationComplete(order.provider_state));
 if(received&&str(order.otp_code))return response({success:true,order:{...order,status:"received"},code_received:true});
 const providerId=str(order.provider_order_id,order.provider_order);
 if(!providerId)return response({success:true,pending:true,order});
 const result=await tvRequest("/verifications/"+encodeURIComponent(providerId));
 const phone=str(order.phone_number,order.number,result?.number,result?.phoneNumber,result?.phone_number,result?.data?.number);
 const sms=await getTextVerifiedSms(result,phone,providerId,order.full_sms), otp=extractTextVerifiedOtp(result,sms)||str(order.otp_code);
 const smsText=extractTextVerifiedSmsText(sms)||str(result?.sms_text,result?.message_body);
 const state=str(result?.status,result?.state,result?.data?.status,result?.verification?.status).toLowerCase();
 const expiry=extractProviderExpiry(result)??order.provider_expires_at??null, expired=Boolean(expiry&&Date.parse(String(expiry))<=Date.now());
 const updates:Record<string,unknown>={updated_at:new Date().toISOString()};
 if(expiry)updates.provider_expires_at=expiry;
 if(otp){updates.otp_code=otp;updates.code_received_at=order.code_received_at||new Date().toISOString();updates.status="received";}
 else if(isVerificationComplete(state)){updates.status="received";}
 else if(!received&&/cancel/.test(state))updates.status="cancelled";
 else if(!received&&(/expire|timeout|timed.?out/.test(state)||expired)){updates.status="failed";updates.provider_state="expired";}
 if(state)updates.provider_state=/expire|timeout|timed.?out/.test(state)?"expired":state;
 if(smsText)updates.full_sms=smsText;
 let q=supabase.from("virtual_number_orders").update(updates).eq("id",orderId).eq("user_id",userId).eq("provider_key","textverified");
 if(received)q=q.eq("status",current);
 const {data,error}=await q.select().maybeSingle();
 if(error){logSafeError("textverified-status-update",error);throw new Error("Unable to update order status.");}
 const saved=data??await ownedOrder(orderId,userId);
 if(otp)return response({success:true,order:saved,code_received:true});
 if(!received&&/cancel/.test(state)){
  const refund=await refundTextVerifiedOrder(orderId,"TextVerified verification cancelled - wallet refund");
  if(!refund.confirmed)return response({success:true,order:saved,cancelled:true,refund_pending:true},202);
  const {data:co,error:ce}=await supabase.from("virtual_number_orders").update({status:"cancelled",provider_state:state,cancelled_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",orderId).eq("user_id",userId).eq("provider_key","textverified").select().single();
  if(ce)throw new Error("Cancellation and refund succeeded, but order status could not be saved.");
  return response({success:true,order:co,refunded:true,cancelled:true});
 }
 if(!received&&(/expire|timeout|timed.?out/.test(state)||expired)){
  const refund=await refundTextVerifiedOrder(orderId,"TextVerified number timed out - automatic refund");
  if(!refund.confirmed)return response({success:true,order:saved,expired:true,refund_pending:true},202);
  const {data:eo,error:ee}=await supabase.from("virtual_number_orders").update({status:"expired",provider_state:"expired",updated_at:new Date().toISOString()}).eq("id",orderId).eq("user_id",userId).eq("provider_key","textverified").select().single();
  if(ee)throw new Error("Refund succeeded, but timeout status could not be saved.");
  return response({success:true,order:eo,expired:true,refunded:true});
 }
 return response({success:true,order:saved,code_received:false});
}

async function actionCancel(orderId:string,userId:string){
 const order=await ownedOrder(orderId,userId);
 if(str(order.provider_state).toLowerCase()===AUTO_REFUNDED_PROVIDER_FAILURE)return response({success:true,refunded:true,order,message:"This failed purchase was already refunded."});
 const current=str(order.status).toLowerCase();
 if(["cancelled","canceled","refunded"].includes(current)){
  const refund=await refundTextVerifiedOrder(orderId,"TextVerified verification cancelled and refunded");
  if(!refund.confirmed)return response({success:false,refund_pending:true,error_code:"CANCEL_REFUND_REVIEW",order_id:orderId,message:"The number is already cancelled, but the wallet refund could not be confirmed. Please contact support."},502);
  return response({success:true,refunded:true,order,order_id:orderId,message:"Cancellation refund confirmed."});
 }
 if(str(order.otp_code)||order.code_received_at||["received","completed","finished","success","successful"].includes(current)||isVerificationComplete(order.provider_state))return response({success:false,code_received:true,order,error_code:"CODE_ALREADY_RECEIVED",message:"Verification successful. This number can no longer be cancelled."},409);
 const providerId=str(order.provider_order_id,order.provider_order);
 if(!providerId){
  const createdAt=Date.parse(str(order.created_at,order.purchased_at));
  const ageMs=Number.isFinite(createdAt)?Date.now()-createdAt:0;
  const state=str(order.provider_state).toLowerCase();
  if(!["reserved",""].includes(state)){
   return fail("This request cannot be cancelled automatically yet. Please contact support.",409,{error_code:"UNCONFIRMED_ORDER_REVIEW",order_id:orderId});
  }
  if(ageMs<20000){
   return response({success:false,pending:true,error_code:"NUMBER_SEARCH_STILL_RUNNING",order_id:orderId,message:"We are still checking number availability. Please wait a few seconds and try cancelling again."},409);
  }
  const refund=await refundTextVerifiedOrder(orderId,"Customer cancelled while no number or retrievable reservation had been issued");
  if(!refund.confirmed){
   return response({success:false,refund_pending:true,error_code:"CANCEL_REFUND_REVIEW",order_id:orderId,message:"The number has not been assigned. Your refund needs a quick review; please contact support."},502);
  }
  const now=new Date().toISOString();
  const {data:co,error:ce}=await supabase.from("virtual_number_orders").update({
   status:"cancelled",
   provider_state:"cancelled_no_number_refunded",
   cancelled_at:now,
   updated_at:now
  }).eq("id",orderId).eq("user_id",userId).eq("provider_key","textverified").is("provider_order_id",null).is("number",null).is("otp_code",null).select().maybeSingle();
  if(ce||!co){
   logSafeError("textverified-unconfirmed-cancel-save",ce??new Error("Order changed while cancellation was processing."));
   return response({success:true,refunded:true,order_id:orderId,message:"Your wallet refund was confirmed. The order status is being synchronized."});
  }
  const {error:transactionError}=await supabase.from("transactions").update({status:"cancelled"}).eq("reference","VNUM-"+orderId).eq("type","virtual_number_purchase");
  if(transactionError)logSafeError("textverified-unconfirmed-cancel-transaction",transactionError);
  return response({success:true,refunded:true,cancelled:true,order:co,order_id:orderId,message:"No number had been assigned. Your cancellation and wallet refund are confirmed."});
 }
 let details:any=null;
 let detailsLookup404=false;
 try{
  details=await tvRequest("/verifications/"+encodeURIComponent(providerId));
 }catch(error){
  if(Number((error as any)?.status)!==404)throw error;
  // Some provider records can be unavailable to the detail lookup while the
  // cancellation action is still accepted. Try the cancel action directly;
  // never refund unless that action confirms success.
  detailsLookup404=true;
  logSafeError("textverified-cancel-details-lookup-404",error);
 }
 const phone=details?str(order.phone_number,order.number,details?.number,details?.phoneNumber,details?.phone_number,details?.data?.number):str(order.phone_number,order.number);
 const sms=details?await getTextVerifiedSms(details,phone,providerId,order.full_sms):null;
 const otp=details?extractTextVerifiedOtp(details,sms):"";
 if(otp){
  const {data:done,error:se}=await supabase.from("virtual_number_orders").update({otp_code:otp,code_received_at:order.code_received_at||new Date().toISOString(),status:"received",full_sms:typeof sms==="string"?sms:str(sms?.content,sms?.text,sms?.body,sms?.message),updated_at:new Date().toISOString()}).eq("id",orderId).eq("user_id",userId).eq("provider_key","textverified").select().single();
  if(se)throw new Error("A code was received, but the successful verification could not be saved. Please retry status check.");
  return response({success:false,code_received:true,order:done,error_code:"CODE_ALREADY_RECEIVED",message:"Verification successful. This number can no longer be cancelled."},409);
 }
 const providerStatus=details?str(details?.status,details?.state,details?.data?.status,details?.verification?.status).toLowerCase():"";
 if(isVerificationComplete(providerStatus)){
  const smsText=extractTextVerifiedSmsText(sms);
  const {data:done,error:de}=await supabase.from("virtual_number_orders").update({
   ...(otp?{otp_code:otp,code_received_at:order.code_received_at||new Date().toISOString()}:{}),
   status:"received", ...(smsText?{full_sms:smsText}:{}), updated_at:new Date().toISOString()
  }).eq("id",orderId).eq("user_id",userId).eq("provider_key","textverified").select().single();
  if(de)throw new Error("Verification completed, but the order status could not be saved.");
  return response({success:false,code_received:true,order:done,error_code:"CODE_ALREADY_RECEIVED",message:"Verification successful. This number can no longer be cancelled."},409);
 }
 if(!/cancel/.test(providerStatus)){
  try{
   await tvRequest("/verifications/"+encodeURIComponent(providerId)+"/cancel",{method:"POST"});
  }catch(error){
   if(detailsLookup404&&Number((error as any)?.status)===404){
    logSafeError("textverified-cancel-action-404",error);
    return response({success:false,error_code:"PROVIDER_VERIFICATION_NOT_FOUND",order_id:orderId,message:"TextVerified could not find this active verification. No wallet refund has been processed. Please contact support so we can review this order."},409);
   }
   throw error;
  }
 }
 const refund=await refundTextVerifiedOrder(orderId,"TextVerified verification cancelled and refunded");
 if(!refund.confirmed)return response({success:false,refund_pending:true,error_code:"CANCEL_REFUND_REVIEW",order_id:orderId,message:"Cancellation was sent, but the wallet refund could not be confirmed. Please contact support."},502);
 const {data:co,error:ce}=await supabase.from("virtual_number_orders").update({status:"cancelled",provider_state:providerStatus||"cancelled",cancelled_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",orderId).eq("user_id",userId).eq("provider_key","textverified").select().single();
 if(ce){logSafeError("textverified-cancel-refund-update",ce);return response({success:true,refunded:true,order_id:orderId,message:"Cancellation and wallet refund were confirmed, but the order display needs a support review."});}
 return response({success:true,refunded:true,order:co,order_id:orderId,message:"Cancellation and refund confirmed."});
}

/* =========================================================
   CUSTOMER ORDERS
========================================================= */

async function refreshWaitingTextVerifiedOrder(order:any,userId:string){
 if(!order||String(order.user_id)!==userId||String(order.provider_key).toLowerCase()!=="textverified"||str(order.provider_state).toLowerCase()===AUTO_REFUNDED_PROVIDER_FAILURE||!["waiting","pending","received","completed","success","successful"].includes(str(order.status).toLowerCase()))return;
 const providerId=str(order.provider_order_id,order.provider_order);if(!providerId||!TV_USERNAME||!TV_API_KEY)return;
 try{
  const result=await tvRequest("/verifications/"+encodeURIComponent(providerId));
  const phone=str(order.phone_number,order.number,result?.number,result?.phoneNumber,result?.phone_number,result?.data?.number);
  const sms=await getTextVerifiedSms(result,phone,providerId,order.full_sms),otp=extractTextVerifiedOtp(result,sms);
  const state=str(result?.status,result?.state,result?.data?.status,result?.verification?.status).toLowerCase();
  const received=Boolean(str(order.otp_code)||order.code_received_at||["received","completed","finished","success","successful"].includes(str(order.status).toLowerCase())||isVerificationComplete(order.provider_state));
  const updates:Record<string,unknown>={updated_at:new Date().toISOString()};
  if(otp){updates.otp_code=str(order.otp_code)||otp;updates.code_received_at=order.code_received_at||new Date().toISOString();updates.status="received";}
  else if(isVerificationComplete(state)){updates.status="received";}
  else if(!received&&/cancel/.test(state))updates.status="cancelled";
  else if(!received&&/expire|timeout|timed.?out/.test(state))updates.status="failed";
  if(state)updates.provider_state=state;
  if(smsText)updates.full_sms=smsText;
  let q=supabase.from("virtual_number_orders").update(updates).eq("id",order.id).eq("user_id",userId).eq("provider_key","textverified");
  if(received)q=q.eq("status",str(order.status));
  const {error}=await q;if(error)logSafeError("textverified-orders-refresh-update",error);
 }catch(e){logSafeError("textverified-orders-refresh",e);}
}

async function actionOrders(userId: string) {
  const { data: initialOrders, error: initialError } = await supabase
    .from("virtual_number_orders")
    .select("*")
    .eq("user_id", userId)
    .eq("provider_key", "textverified")
    .order("created_at", { ascending: false });

  if (initialError) {
    logSafeError("textverified-orders", initialError);
    throw new Error("Unable to load your number orders.");
  }

  // Refresh up to ten active verifications so newly received SMS codes
  // are saved in our database and returned to this site, not only the provider.
  const waitingOrders = (initialOrders ?? [])
    .filter((order: any) =>
      ["waiting", "pending", "received", "completed", "success", "successful"].includes(str(order.status).toLowerCase()) &&
      !str(order.otp_code) &&
      str(order.provider_state).toLowerCase() !== AUTO_REFUNDED_PROVIDER_FAILURE &&
      str(order.provider_order_id, order.provider_order)
    )
    .slice(0, 10);

  for (const order of waitingOrders) {
    await refreshWaitingTextVerifiedOrder(order, userId);
  }

  const { data, error } = await supabase
    .from("virtual_number_orders")
    .select("*")
    .eq("user_id", userId)
    .eq("provider_key", "textverified")
    .order("created_at", { ascending: false });

  if (error) {
    logSafeError("textverified-orders-reload", error);
    throw new Error("Unable to reload your TextVerified orders.");
  }

  // Keep audit records in the database, but exclude these automatic
  // provider-funds failures from this API's customer-facing order list.
  const orders = (data ?? []).filter(
    (order: any) =>
      str(order.provider_state).toLowerCase() !==
      AUTO_REFUNDED_PROVIDER_FAILURE,
  );

  return response({ success: true, orders });
}

/* =========================================================
   EDGE FUNCTION HANDLER
========================================================= */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return fail("Method not allowed.", 405);
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return fail("Supabase environment is not configured.", 503);
  }

  let action = "unknown";

  try {
    const user = await getUser(req);

    const body = req.method === "POST"
      ? await req.json().catch(() => ({}))
      : {};

    action = str(
      body.action,
      body.type,
      new URL(req.url).searchParams.get("action"),
    ).toLowerCase();

    console.info("[textverified-request] Received request.", {
      action,
      method: req.method,
    });

    if (!TV_USERNAME || !TV_API_KEY) {
      return fail(
        "TextVerified credentials are not configured. Check TEXTVERIFIED_API_USERNAME and TEXTVERIFIED_API_KEY in Supabase Secrets.",
        503,
      );
    }

    switch (action) {
      case "services":
      case "listservices":
        return response({
          success: true,
          services: await listServices(),
        });

      case "quote":
      case "price":
        return response(
          await getQuote(
            str(body.service, body.service_name, body.serviceName),
            str(body.capability, "sms"),
          ),
        );

      case "buy":
      case "purchase":
        return await actionBuy(body, user.id, req);

      case "status":
      case "check":
        return await actionStatus(
          str(body.order_id, body.orderId, body.id),
          user.id,
        );

      case "cancel":
        return await actionCancel(
          str(body.order_id, body.orderId, body.id),
          user.id,
        );

      case "orders":
        return await actionOrders(user.id);

      case "wallet":
      case "balance":
        return response({
          success: true,
          balance: await walletBalance(user.id),
        });

      default:
        return fail(
          "Unknown action. Use services, quote, buy, status, cancel, orders, or wallet.",
        );
    }
  } catch (error) {
    logSafeError(`textverified-request-${action}`, error);

    const message = error instanceof Error
      ? error.message
      : "Unexpected server error.";

    if (isInsufficientProviderBalance(error)) {
      return fail(
        "Insufficient funds. Please contact support.",
        402,
        {
          error_code: "PROVIDER_INSUFFICIENT_FUNDS",
          order_id: null,
          refunded: false,
        },
      );
    }

    return fail(message, num((error as any)?.status, 500));
  }
});