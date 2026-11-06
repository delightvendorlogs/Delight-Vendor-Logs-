import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const API_KEY = Deno.env.get("VIRTUALSMS_API_KEY") ?? "";
const API_BASE = "https://virtualsms.io/api/v1";

const AUTOMATIC_REFUND_MARKER = "virtualsms_insufficient_funds_refunded";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Content-Type": "application/json",
};

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders,
  });
}

function fail(
  message: string,
  status = 400,
  extra: Record<string, unknown> = {},
) {
  return response({ success: false, error: message, message, ...extra }, status);
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function getRows(data: any): any[] {
  if (Array.isArray(data)) return data;

  for (const key of ["data", "results", "countries", "services", "orders"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }

  return [];
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function isInsufficientProviderBalance(error: any): boolean {
  if (Number(error?.status ?? 0) === 402) return true;

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

  collect(error);
  const text = parts.join(" ").toLowerCase();

  return (
    /\binsufficient[_\s-]*(funds?|balance|credits?)\b/i.test(text) ||
    /\b(not enough|lack of|low|insufficient|exhausted)\b.{0,60}\b(balance|funds?|credits?)\b/i.test(text) ||
    /\b(balance|funds?|credits?)\b.{0,60}\b(too low|insufficient|exhausted|not enough|depleted)\b/i.test(text) ||
    /\b(insufficient_balance|insufficient_funds|low_balance|insufficient_credits|low_credits)\b/i.test(text) ||
    /\baccount balance\b.{0,60}\b(low|insufficient|exhausted|not enough)\b/i.test(text)
  );
}

async function providerRequest(path: string, options: RequestInit = {}) {
  if (!API_KEY) throw new Error("VirtualSMS API key is not configured.");

  const headers = new Headers(options.headers);
  headers.set("X-API-Key", API_KEY);
  headers.set("Accept", "application/json");

  if (options.body) headers.set("Content-Type", "application/json");

  const result = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const raw = await result.text();

  let data: any;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }

  const providerError = {
    status: result.status,
    data,
    message: str(data?.message, data?.error, data?.detail),
  };

  if (isInsufficientProviderBalance(providerError)) {
    const error = new Error(
      str(
        data?.message,
        data?.error,
        data?.detail,
        "VirtualSMS provider balance is insufficient.",
      ),
    );

    Object.assign(error, { status: result.status, data });
    throw error;
  }

  if (!result.ok || data?.success === false) {
    const error = new Error(
      str(
        data?.message,
        data?.error,
        data?.detail,
        `VirtualSMS request failed (${result.status}).`,
      ),
    );

    Object.assign(error, { status: result.status, data });
    throw error;
  }

  return data;
}

async function getUser(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization) throw new Error("Please log in to continue.");

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
  });

  const { data, error } = await client.auth.getUser();

  if (error || !data.user) {
    throw new Error("Your session has expired. Please log in again.");
  }

  return data.user;
}

async function walletBalance(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("wallet")
    .select("balance")
    .eq("user-id", userId)
    .maybeSingle();

  if (error) {
    console.error("Wallet balance lookup failed:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });

    throw new Error("Unable to retrieve your wallet balance.");
  }

  if (!data) {
    throw new Error(
      "Your wallet record could not be found. Please contact support.",
    );
  }

  return num(data.balance);
}

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
      // Try the fallback source.
    }
  }

  throw new Error("Unable to retrieve the current USD to NGN exchange rate.");
}

function getServiceCode(item: any): string {
  return str(
    item?.service_code,
    item?.serviceCode,
    item?.service_id,
    item?.service,
    item?.code,
    item?.id,
  );
}

function getCountryCode(item: any): string {
  return str(
    item?.country_id,
    item?.country_code,
    item?.countryCode,
    item?.iso,
    item?.iso2,
    item?.code,
  ).toUpperCase();
}

function getServiceName(item: any): string {
  return str(
    item?.service_name,
    item?.serviceName,
    item?.name,
    item?.title,
    item?.service,
    getServiceCode(item),
  );
}

function getCountryName(item: any): string {
  return str(
    item?.country_name,
    item?.countryName,
    item?.name,
    item?.title,
    getCountryCode(item),
  );
}

function numericCountryId(country: string): number | null {
  if (!/^\d+$/.test(country)) return null;

  const id = Number(country);
  return Number.isSafeInteger(id) ? id : null;
}

async function getMarkup(
  service: string,
  countryId: number | null,
): Promise<number> {
  if (countryId !== null) {
    const { data, error } = await supabase
      .from("virtual_number_price_overrides")
      .select("*")
      .eq("provider", "virtualsms")
      .eq("country_id", countryId)
      .eq("service_code", service)
      .eq("is_active", true)
      .maybeSingle();

    if (error) {
      throw new Error("Unable to retrieve the service price override.");
    }

    if (data) return num(data.markup_percent, 0);
  }

  const { data, error } = await supabase
    .from("virtual_number_markup_rules")
    .select("*")
    .eq("server", "virtualsms")
    .eq("is_active", true);

  if (error) {
    throw new Error("Unable to retrieve VirtualSMS markup settings.");
  }

  const rules = data ?? [];

  const serviceRule = rules.find(
    (rule: any) =>
      str(rule.service_code).toLowerCase() === service.toLowerCase() &&
      rule.country_id == null,
  );

  const defaultRule = rules.find(
    (rule: any) => !rule.service_code && rule.country_id == null,
  );

  return num(serviceRule?.markup_percent ?? defaultRule?.markup_percent, 100);
}

async function calculatePrice(
  providerPrice: number,
  service: string,
  country: string,
) {
  const countryId = numericCountryId(country);

  const [fx, markup] = await Promise.all([
    getFxRate(),
    getMarkup(service, countryId),
  ]);

  const costNaira = providerPrice * fx;

  return {
    provider_price: providerPrice,
    exchange_rate: fx,
    markup_percent: markup,
    cost_naira: Math.ceil(costNaira),
    price: Math.ceil(costNaira * (1 + markup / 100)),
    currency: "NGN",
  };
}

async function listCountries(service?: string) {
  const path = service
    ? `/customer/countries?service=${encodeURIComponent(service)}`
    : "/customer/countries";

  const result = await providerRequest(path);

  return getRows(result).map((item: any) => ({
    code: getCountryCode(item),
    country_code: getCountryCode(item),
    name: getCountryName(item),
    country_name: getCountryName(item),
    flag: str(item?.flag, item?.emoji),
    available: item?.available !== false,
    provider_data: item,
  }));
}

async function listServices(country?: string) {
  const path = country
    ? `/customer/services?country=${encodeURIComponent(country)}`
    : "/customer/services";
  const result = await providerRequest(path);
  const services = getRows(result).map((item: any) => ({
    code: getServiceCode(item), service_code: getServiceCode(item),
    name: getServiceName(item), service_name: getServiceName(item),
    description: str(item?.description), available: item?.available !== false,
    provider_data: item,
  }));
  return await mapWithConcurrency(services, 3, async (item) => {
    if (!country || item.available === false) return { ...item, price: null, price_ngn: null };
    try {
      const quote = await getQuote(item.code, country);
      return { ...item, price: quote.price, price_ngn: quote.price, currency: "NGN" };
    } catch {
      console.warn("[virtualsms-service-price] Quote unavailable for service.");
      return { ...item, price: null, price_ngn: null };
    }
  });
}

async function getQuote(service: string, country: string) {
  if (!service || !country) {
    throw new Error("Select a country and service first.");
  }

  const result = await providerRequest(
    `/price?service=${encodeURIComponent(service)}&country=${encodeURIComponent(country)}`,
  );

  const providerPrice = num(result?.price ?? result?.data?.price, -1);

  if (providerPrice < 0) {
    throw new Error("The provider did not return a valid price.");
  }

  if (result?.available === false || result?.data?.available === false) {
    throw new Error(
      "This service is currently unavailable in the selected country.",
    );
  }

  return {
    success: true,
    service,
    country,
    ...(await calculatePrice(providerPrice, service, country)),
    available: true,
  };
}

async function reserveOrder(args: {
  userId: string;
  service: string;
  country: string;
  countryName: string;
  price: number;
  providerPrice: number;
  providerCostNaira: number;
  exchangeRate: number;
  idempotencyKey: string;
}) {
  const { data, error } = await supabase.rpc(
    "reserve_virtual_number_order",
    {
      p_user_id: args.userId,
      p_provider_key: "virtualsms",
      p_idempotency_key: args.idempotencyKey,
      p_service_code: args.service,
      p_service_name: args.service,
      p_country_id: numericCountryId(args.country),
      p_country_name: args.countryName,
      p_customer_price_ngn: args.price,
      p_exchange_rate: args.exchangeRate,
      p_provider_cost_usd: args.providerPrice,
      p_provider_cost_ngn: args.providerCostNaira,
    },
  );

  if (error) {
    throw new Error(error.message || "Unable to reserve this order.");
  }

  const order = Array.isArray(data) ? data[0] : data;

  if (order?.success === false) {
    throw new Error(str(order?.message, "Unable to reserve this order."));
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

function extractOtp(data: any): string {
  const direct = str(
    data?.otp,
    data?.code,
    data?.sms_code,
    data?.verification_code,
    data?.data?.otp,
    data?.data?.code,
    data?.sms?.code,
  );

  if (direct) return direct;

  const messages = [
    ...(Array.isArray(data?.messages) ? data.messages : []),
    ...(Array.isArray(data?.data?.messages) ? data.data.messages : []),
  ];

  for (const message of messages) {
    const explicit = str(message?.otp, message?.code, message?.sms_code);
    if (explicit) return explicit;

    const content = str(message?.content, message?.text, message?.body);
    const match = content.match(/\b(\d{4,8})\b/);

    if (match) return match[1];
  }

  return "";
}

async function markAutomaticProviderRefund(orderId: string) {
  const { error } = await supabase
    .from("virtual_number_orders")
    .update({
      provider_state: AUTOMATIC_REFUND_MARKER,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("provider_key", "virtualsms");

  if (error) {
    console.error("Could not save automatic-refund marker:", error.message);
    return false;
  }

  return true;
}

async function refundFailedProviderPurchase(orderId: string) {
  // Failed upstream purchase: restore the wallet and erase the temporary
  // order plus its pending debit/refund ledger entries.
  const { data, error } = await supabase.rpc(
    "cleanup_virtual_number_provider_failure",
    { p_order_id: Number(orderId), p_provider_key: "virtualsms" },
  );
  if (error) {
    console.error("Failed-purchase cleanup failed:", error.message);
    return { success: false, markerSaved: false };
  }
  const result = Array.isArray(data) ? data[0] : data;
  return { success: result?.success === true, markerSaved: result?.success === true };
}


function extractProviderExpiry(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  const objects = [payload, payload.data, payload.order, payload.result]
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
  const service = str(body.service, body.service_code, body.serviceCode);
  const country = str(
    body.country,
    body.country_code,
    body.countryCode,
  ).toUpperCase();

  if (!service || !country) {
    return fail("Select a country and service first.");
  }

  const quote = await getQuote(service, country);
  const balance = await walletBalance(userId);

  if (balance < quote.price) {
    const shortfall = Math.ceil(quote.price - balance);

    return fail(
      `Insufficient funds. Please add ₦${shortfall.toLocaleString("en-NG")}.`,
      400,
      { balance, price: quote.price, shortfall },
    );
  }

  const idempotencyKey =
    str(
      req.headers.get("idempotency-key"),
      body.idempotency_key,
      body.idempotencyKey,
    ) || crypto.randomUUID();

  const countries = await listCountries(service);
  const selectedCountry = countries.find(
    (item: any) => item.code === country,
  );

  const reserved = await reserveOrder({
    userId,
    service,
    country,
    countryName: selectedCountry?.name ?? country,
    price: quote.price,
    providerPrice: quote.provider_price,
    providerCostNaira: quote.cost_naira,
    exchangeRate: quote.exchange_rate,
    idempotencyKey,
  });

  const orderId = str(
    reserved?.order_id,
    reserved?.id,
    reserved?.order?.id,
  );

  if (!orderId) {
    throw new Error("Order reservation did not return an order ID.");
  }

  try {
    // CORRECTED: the documented purchase endpoint is /customer/purchase.
    const provider = await providerRequest("/customer/purchase", {
      method: "POST",
      body: JSON.stringify({ service, country }),
    });

    const providerOrderId = str(
      provider?.order_id,
      provider?.id,
      provider?.data?.order_id,
      provider?.data?.id,
    );

    const phone = str(
      provider?.phone_number,
      provider?.number,
      provider?.phone,
      provider?.data?.phone_number,
      provider?.data?.number,
      provider?.data?.phone,
    );
    const providerExpiresAt = extractProviderExpiry(provider);

    if (!providerOrderId || !phone) {
      console.error(
        "Incomplete VirtualSMS purchase response:",
        JSON.stringify(provider),
      );

      return response(
        {
          success: true,
          pending: true,
          order_id: orderId,
          message:
            "The provider response is incomplete. Your order needs confirmation. Please do not submit another purchase.",
        },
        202,
      );
    }

    const { data: attached, error: attachError } = await supabase.rpc(
      "attach_virtual_number_provider_order",
      {
        p_order_id: orderId,
        p_user_id: userId,
        p_provider_key: "virtualsms",
        p_provider_order_id: providerOrderId,
        p_number: phone,
        p_provider_expires_at: providerExpiresAt,
        p_provider_state: "waiting",
      },
    );

    if (attachError) {
      console.error(
        "Could not attach VirtualSMS order:",
        attachError.message,
      );

      return response(
        {
          success: true,
          pending: true,
          order_id: orderId,
          provider_order_id: providerOrderId,
          number: phone,
          message:
            "The provider returned a number, but saving it failed. Please contact support before retrying.",
        },
        202,
      );
    }

    const attachedOrder = Array.isArray(attached) ? attached[0] : attached;

    if (attachedOrder?.success === false) {
      return response(
        {
          success: true,
          pending: true,
          order_id: orderId,
          provider_order_id: providerOrderId,
          number: phone,
          message:
            "The provider returned a number, but order confirmation is pending. Please contact support before retrying.",
        },
        202,
      );
    }

    return response({
      success: true,
      order_id: orderId,
      order: attachedOrder ?? provider,
      provider_order_id: providerOrderId,
      number: phone,
      message: "Number purchased successfully.",
    });
  } catch (error) {
    if (isInsufficientProviderBalance(error)) {
      const refund = await refundFailedProviderPurchase(orderId);

      if (!refund.success) {
        return fail("Insufficient funds. Please contact support.", 502);
      }

      if (!refund.markerSaved) {
        return fail("Insufficient funds. Please contact support.", 502);
      }

      return fail("Insufficient funds. Please contact support.", 402);
    }

    const errorStatus = num((error as any)?.status, 0);
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    console.error("VirtualSMS purchase request failed:", {
      status: errorStatus,
      message: errorMessage,
    });

    // A 404 is a definite API/resource error, not proof of low provider balance.
    // Do not falsely mark it as a successful purchase or as a confirmed refund.
    if (errorStatus === 404) {
      return fail(
        "Unable to complete this purchase. Please contact support before retrying.",
        502,
        {
          order_id: orderId,
          provider_error: "404",
          refund_pending: true,
        },
      );
    }

    // A timeout or server error can be ambiguous: the provider may have
    // created the order before the connection failed. Do not auto-refund
    // or claim success without confirmation.
    return response(
      {
        success: true,
        pending: true,
        order_id: orderId,
        message:
          "The provider has not confirmed this purchase yet. Please check your order status and do not submit another purchase.",
      },
      202,
    );
  }
}

async function actionStatus(orderId:string,userId:string){
 const order=await ownedOrder(orderId,userId);
 if(order.provider_state===AUTOMATIC_REFUND_MARKER)return response({success:true,order,automatic_provider_refund:true});
 const current=str(order.status).toLowerCase();
 if(["cancelled","canceled","refunded","expired"].includes(current))return response({success:true,order});
 const providerId=str(order.provider_order_id,order.provider_order);
 if(!providerId)return response({success:true,order});
 const result=await providerRequest("/customer/order/"+encodeURIComponent(providerId));
 const otp=extractOtp(result)||str(order.otp_code);
 const smsText=typeof result?.sms==="string"?result.sms:str(result?.sms?.content,result?.sms?.text,result?.sms?.body,result?.message_body,result?.sms_text);
 const state=str(result?.status,result?.state,result?.data?.status,result?.order?.status,result?.data?.order?.status).toLowerCase();
 const expiry=extractProviderExpiry(result)??order.provider_expires_at??null;
 const expired=Boolean(expiry&&Date.parse(String(expiry))<=Date.now());
 const already=Boolean(order.otp_code)||["received","completed","finished","success","successful"].includes(current);
 const updates:Record<string,unknown>={updated_at:new Date().toISOString()};
 if(expiry)updates.provider_expires_at=expiry;
 if(otp){if(!order.otp_code){updates.otp_code=otp;updates.code_received_at=new Date().toISOString();}updates.status="received";}
 else if(already&&!order.otp_code)updates.status="waiting";
 else if(!already&&/cancel/.test(state))updates.status="cancelled";
 else if(!already&&(/expired|timeout|timed.?out/.test(state)||expired)){updates.status="failed";updates.provider_state="expired";}
 if(smsText)updates.full_sms=smsText;
 if(state)updates.provider_state=/expired|timeout|timed.?out/.test(state)?"expired":state;
 const {data,error}=await supabase.from("virtual_number_orders").update(updates).eq("id",orderId).eq("user_id",userId).select().single();
 if(error){console.error("VirtualSMS status update failed:",error.message);throw new Error("Unable to update order status.");}
 if(!otp&&!already&&(/expired|timeout|timed.?out/.test(state)||expired)){
  const {data:rd,error:re}=await supabase.rpc("process_virtual_number_refund",{p_order_id:Number(orderId),p_provider_key:"virtualsms",p_reason:"Virtual number timed out - automatic refund"});
  const refund=Array.isArray(rd)?rd[0]:rd;
  if(re||!(refund?.success===true||refund?.already_refunded===true))return response({success:true,order:data,expired:true,refund_pending:true},202);
  const {data:eo,error:ee}=await supabase.from("virtual_number_orders").update({status:"expired",provider_state:"expired",updated_at:new Date().toISOString()}).eq("id",orderId).eq("user_id",userId).select().single();
  if(ee)throw new Error("Refund succeeded, but timeout status could not be saved.");
  return response({success:true,order:eo,expired:true,refunded:true});
 }
 return response({success:true,order:data,code_received:Boolean(otp)});
}
async function actionCancel(orderId: string, userId: string) {
  const order = await ownedOrder(orderId, userId);

  if (order.provider_state === AUTOMATIC_REFUND_MARKER) {
    return response({
      success: true,
      order,
      message: "This failed purchase has already been refunded.",
    });
  }

  const providerId = str(order.provider_order_id, order.provider_order);

  if (!providerId) {
    throw new Error("This order does not have a provider order ID.");
  }

  if (
    ["cancelled", "canceled", "completed", "refunded"].includes(
      String(order.status ?? "").toLowerCase(),
    )
  ) {
    return response({
      success: true,
      order,
      message: "This order is already finalized.",
    });
  }

  // CORRECTED: cancellation takes the provider order ID in the URL.
  const result = await providerRequest(
    `/customer/cancel/${encodeURIComponent(providerId)}`,
    { method: "POST" },
  );

  const status = str(
    result?.status,
    result?.data?.status,
    result?.message,
  ).toLowerCase();

  if (/cannot|failed|error|already.*complete/.test(status)) {
    return fail(
      str(result?.message, "The provider did not confirm cancellation."),
      409,
    );
  }

  const { data, error } = await supabase
    .from("virtual_number_orders")
    .update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    throw new Error(
      "Cancellation was received but the order could not be updated.",
    );
  }

  const { data: refundData, error: refundError } = await supabase.rpc(
    "process_virtual_number_refund",
    {
      p_order_id: orderId,
      p_provider_key: "virtualsms",
      p_reason: "VirtualSMS order cancelled",
    },
  );

  if (refundError) {
    console.error("Cancellation refund needs review:", refundError.message);

    return response(
      {
        success: true,
        order: data,
        refund_pending: true,
        message:
          "Order cancelled. The refund could not be confirmed and needs support review.",
      },
      202,
    );
  }

  const refundResult = Array.isArray(refundData)
    ? refundData[0]
    : refundData;

  if (
    refundResult?.success !== true &&
    refundResult?.already_refunded !== true
  ) {
    return response(
      {
        success: true,
        order: data,
        refund_pending: true,
        message:
          "Order cancelled. The refund could not be confirmed and needs support review.",
      },
      202,
    );
  }

  return response({
    success: true,
    order: data,
    refunded: true,
    message: "Order cancelled and refund confirmed.",
  });
}

async function refreshWaitingProviderOrder(order: any, userId: string) {
  if (
    !order ||
    String(order.user_id) !== userId ||
    String(order.provider_key).toLowerCase() !== "virtualsms" ||
    order.provider_state === AUTOMATIC_REFUND_MARKER ||
    !["waiting", "pending", "received", "completed", "success", "successful"].includes(String(order.status ?? "").toLowerCase()) ||
    str(order.otp_code)
  ) return;

  const providerId = str(order.provider_order_id, order.provider_order);
  if (!providerId || !API_KEY) return;

  try {
    const result = await providerRequest(
      `/customer/order/${encodeURIComponent(providerId)}`,
    );
    const otp = extractOtp(result);
    const providerStatus = str(
      result?.status,
      result?.state,
      result?.data?.status,
      result?.order?.status,
      result?.data?.order?.status,
    ).toLowerCase();

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (otp) {
      updates.otp_code = otp;
      updates.code_received_at = new Date().toISOString();
      if (!/cancel|expire/.test(providerStatus)) updates.status = "received";
    }

    if (/cancel/.test(providerStatus)) updates.status = "cancelled";
    else if (/expired|timeout/.test(providerStatus)) updates.status = "failed";
    else if (/complete|received|success/.test(providerStatus) && otp) {
      updates.status = "received";
    }

    const messages = [
      ...(Array.isArray(result?.messages) ? result.messages : []),
      ...(Array.isArray(result?.data?.messages) ? result.data.messages : []),
      ...(Array.isArray(result?.order?.messages) ? result.order.messages : []),
      ...(Array.isArray(result?.data?.order?.messages) ? result.data.order.messages : []),
    ];

    if (messages.length) {
      updates.full_sms = JSON.stringify(messages);
    } else if (result?.sms !== undefined) {
      updates.full_sms = typeof result.sms === "string"
        ? result.sms
        : JSON.stringify(result.sms);
    } else if (result?.data?.sms !== undefined) {
      updates.full_sms = typeof result.data.sms === "string"
        ? result.data.sms
        : JSON.stringify(result.data.sms);
    } else if (result?.order?.sms !== undefined) {
      updates.full_sms = typeof result.order.sms === "string"
        ? result.order.sms
        : JSON.stringify(result.order.sms);
    }

    const { error } = await supabase
      .from("virtual_number_orders")
      .update(updates)
      .eq("id", order.id)
      .eq("user_id", userId)
      .eq("provider_key", "virtualsms");

    if (error) {
      console.error("VirtualSMS waiting-order refresh DB update failed:", {
        order_id: order.id,
        message: error.message,
        code: error.code,
      });
    }
  } catch (error) {
    console.error("VirtualSMS waiting-order refresh failed:", {
      order_id: order.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function actionOrders(userId: string) {
  const { data: initialOrders, error: initialError } = await supabase
    .from("virtual_number_orders")
    .select("*")
    .eq("user_id", userId)
    .eq("provider_key", "virtualsms")
    .order("created_at", { ascending: false });

  if (initialError) throw new Error("Unable to load your orders.");

  // Refresh a small batch of active orders so new SMS codes appear when
  // the dashboard requests the order list. This does not create purchases.
  const waitingOrders = (initialOrders ?? [])
    .filter((order: any) =>
      ["waiting", "pending", "received", "completed", "success", "successful"].includes(String(order.status ?? "").toLowerCase()) &&
      !str(order.otp_code) &&
      order.provider_state !== AUTOMATIC_REFUND_MARKER &&
      str(order.provider_order_id, order.provider_order)
    )
    .slice(0, 10);

  for (const order of waitingOrders) {
    await refreshWaitingProviderOrder(order, userId);
  }

  const { data, error } = await supabase
    .from("virtual_number_orders")
    .select("*")
    .eq("user_id", userId)
    .eq("provider_key", "virtualsms")
    .order("created_at", { ascending: false });

  if (error) throw new Error("Unable to reload your orders after refresh.");

  return response({ success: true, orders: data ?? [] });
}

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

  try {
    const user = await getUser(req);

    const body =
      req.method === "POST" ? await req.json().catch(() => ({})) : {};

    const action = str(
      body.action,
      body.type,
      new URL(req.url).searchParams.get("action"),
    ).toLowerCase();

    if (!API_KEY && !["wallet", "balance", "orders"].includes(action)) {
      return fail("VirtualSMS API key is not configured.", 503);
    }

    switch (action) {
      case "countries":
      case "listcountries":
        return response({
          success: true,
          countries: await listCountries(str(body.service) || undefined),
        });

      case "services":
      case "listservices":
        return response({
          success: true,
          services: await listServices(
            str(body.country, body.country_code) || undefined,
          ),
        });

      case "quote":
      case "price":
        return response(
          await getQuote(
            str(body.service, body.service_code),
            str(body.country, body.country_code).toUpperCase(),
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
          "Unknown action. Use countries, services, quote, buy, status, cancel, orders, or wallet.",
        );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";

    console.error("VirtualSMS function error:", message);

    return fail(message, num((error as any)?.status, 500));
  }
});