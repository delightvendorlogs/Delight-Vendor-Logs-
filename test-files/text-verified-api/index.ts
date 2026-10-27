
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

  console.error(`[${stage}]`, {
    status: Number(e?.status) || null,
    message,
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

  const result = await fetch(`${TV_BASE}/auth`, {
    method: "POST",
    headers: {
      "X-API-KEY": TV_API_KEY,
      "X-API-USERNAME": TV_USERNAME,
      Accept: "application/json",
      "Content-Type": "application/json",
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
        `TextVerified authentication failed (${result.status}).`,
      ),
    );

    Object.assign(error, { status: result.status, data });
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

  const result = await fetch(`${TV_BASE}${path}`, {
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

  if (result.status === 401 && retry) {
    await getToken(true);
    return await tvRequest(path, options, false);
  }

  const providerError = {
    status: result.status,
    data,
    message: str(data?.message, data?.error, data?.detail),
  };

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

  if (isInsufficientProviderBalance(providerError)) {
    const error = new Error(
      str(
        data?.message,
        data?.error,
        data?.detail,
        "TextVerified provider balance is insufficient.",
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
  const value = str(link);
  if (!value) return "";

  try {
    const url = new URL(value, TV_BASE);
    const base = new URL(TV_BASE);

    if (url.protocol !== "https:") return "";
    if (url.hostname !== base.hostname) return "";
    if (!url.pathname.startsWith("/api/pub/v2/")) return "";

    return url.toString();
  } catch {
    return "";
  }
}

async function fetchProviderLink(
  link: unknown,
  method = "GET",
) {
  const url = safeProviderLink(link);

  if (!url) {
    throw new Error("TextVerified returned an invalid provider link.");
  }

  const token = await getToken();

  const result = await fetch(url, {
    method,
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

/* =========================================================
   BUY NUMBER
========================================================= */

async function actionBuy(body: any, userId: string, req: Request) {
  const serviceName = str(
    body.service,
    body.service_name,
    body.serviceName,
  );

  const capability = str(body.capability, "sms");

  // Pricing errors happen before any wallet deduction.
  const pricing = await getQuote(serviceName, capability);
  const balance = await walletBalance(userId);

  if (balance < pricing.price) {
    const shortfall = Math.ceil(pricing.price - balance);

    return fail(
      `Insufficient funds. Please add ₦${shortfall.toLocaleString("en-NG")}.`,
      400,
      {
        error_code: "INSUFFICIENT_WALLET_FUNDS",
        balance,
        price: pricing.price,
        shortfall,
      },
    );
  }

  const idempotencyKey =
    str(
      req.headers.get("idempotency-key"),
      body.idempotency_key,
      body.idempotencyKey,
    ) || crypto.randomUUID();

  const reserved = await reserveOrder({
    userId,
    service: serviceName,
    price: pricing.price,
    providerPrice: pricing.provider_price,
    exchangeRate: pricing.exchange_rate,
    markup: pricing.markup_percent,
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

  if (reserved?.existing === true) {
    return response(
      {
        success: true,
        pending: true,
        order_id: orderId,
        message:
          "This purchase request already exists. Check the existing order before trying again.",
      },
      202,
    );
  }

  try {
    const provider = await tvRequest("/verifications", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        serviceName,
        capability,
        numberType: "mobile",
        areaCodeSelectOption: [],
        carrierSelectOption: [],
      }),
    });

    let details = provider;

    let providerOrderId = str(
      provider?.id,
      provider?.verificationId,
      provider?.verification_id,
      provider?.data?.id,
      provider?.data?.verificationId,
    );

    const selfLink = provider?.href ?? provider?.links?.self?.href;

    if (!providerOrderId && selfLink) {
      details = await fetchProviderLink(selfLink);

      providerOrderId = str(
        details?.id,
        details?.verificationId,
        details?.verification_id,
        details?.data?.id,
      );
    }

    const phone = str(
      details?.number,
      details?.phoneNumber,
      details?.phone_number,
      details?.data?.number,
      details?.data?.phoneNumber,
    );

    if (providerOrderId && !phone) {
      const { error: pendingUpdateError } = await supabase
        .from("virtual_number_orders")
        .update({
          provider_order_id: providerOrderId,
          provider_state: "waiting",
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId)
        .eq("user_id", userId)
        .eq("provider_key", "textverified");

      if (pendingUpdateError) {
        logSafeError(
          "textverified-save-pending-provider-id",
          pendingUpdateError,
        );
      }

      return response(
        {
          success: true,
          pending: true,
          order_id: orderId,
          message:
            "The provider accepted the request, but the number is not confirmed yet. Check the order status shortly.",
        },
        202,
      );
    }

    if (!providerOrderId || !phone) {
      console.error("[textverified-buy] Incomplete provider response.", {
        orderId,
        hasProviderOrderId: Boolean(providerOrderId),
        hasPhoneNumber: Boolean(phone),
      });

      return response(
        {
          success: true,
          pending: true,
          order_id: orderId,
          message:
            "The provider response is incomplete. Your order needs status verification before it can be confirmed.",
        },
        202,
      );
    }

    const { data: attached, error: attachError } = await supabase.rpc(
      "attach_virtual_number_provider_order",
      {
        p_order_id: Number(orderId),
        p_user_id: userId,
        p_provider_key: "textverified",
        p_provider_order_id: providerOrderId,
        p_number: phone,
        p_provider_expires_at: null,
        p_provider_state: "waiting",
      },
    );

    if (attachError) {
      logSafeError("textverified-attach-order", attachError);

      return response(
        {
          success: true,
          pending: true,
          order_id: orderId,
          message:
            "The provider returned a number, but your order could not be confirmed in our system. Please check your order status before retrying.",
        },
        202,
      );
    }

    console.info("[textverified-buy] Provider order attached.", {
      orderId,
      hasProviderOrderId: true,
      hasPhoneNumber: true,
    });

    return response({
      success: true,
      pending: false,
      order_id: orderId,
      order: attached,
      provider_order_id: providerOrderId,
      number: phone,
      message: "TextVerified number received successfully.",
    });
  } catch (error) {
    logSafeError("textverified-buy", error);

    if (isInsufficientProviderBalance(error)) {
      const refund = await refundTextVerifiedOrder(
        orderId,
        "TextVerified provider balance insufficient",
      );

      if (!refund.confirmed) {
        return fail(
          "Insufficient provider funds. Your refund could not be confirmed automatically. Please contact support before trying again.",
          502,
          {
            error_code: "PROVIDER_INSUFFICIENT_FUNDS_REFUND_REVIEW",
            order_id: orderId,
            refunded: false,
          },
        );
      }

      // Mark only this automatically refunded failed purchase.
      // Never apply this marker to a genuine customer cancellation.
      const marked = await markAutomaticProviderRefund(orderId, userId);

      if (!marked) {
        // The wallet refund is confirmed, but the marker failed.
        // Report this for support rather than claiming the order
        // was fully classified for hiding.
        return fail(
          "Insufficient provider funds. Your wallet refund was confirmed, but the order needs a support review.",
          502,
          {
            error_code: "PROVIDER_REFUNDED_ORDER_MARKER_FAILED",
            order_id: orderId,
            refunded: true,
            already_refunded: refund.alreadyRefunded,
          },
        );
      }

      return fail(
        "Insufficient provider funds. Please contact support.",
        402,
        {
          error_code: "PROVIDER_INSUFFICIENT_FUNDS",
          order_id: orderId,
          refunded: true,
          already_refunded: refund.alreadyRefunded,
          order_hidden_from_customer_list: true,
        },
      );
    }

    // Other provider failures may be ambiguous. Do not automatically
    // refund or claim a definite failure without confirmation.
    return response(
      {
        success: true,
        pending: true,
        order_id: orderId,
        error_code: "PROVIDER_RESULT_UNCONFIRMED",
        message:
          "Your order is awaiting provider confirmation. Please check its status before trying again.",
      },
      202,
    );
  }
}

/* =========================================================
   TEXTVERIFIED SMS / OTP EXTRACTION
========================================================= */

function extractTextVerifiedOtp(result: any, sms: any): string {
  const direct = str(
    result?.code,
    result?.otp,
    result?.verificationCode,
    result?.verification_code,
    result?.data?.code,
    result?.data?.otp,
    result?.verification?.code,
    result?.verification?.otp,
    sms?.code,
    sms?.otp,
    sms?.verificationCode,
    sms?.verification_code,
    sms?.data?.code,
    sms?.data?.otp,
  );

  if (direct) return direct;

  const candidates: any[] = [
    ...(Array.isArray(sms) ? sms : []),
    ...(Array.isArray(result?.messages) ? result.messages : []),
    ...(Array.isArray(result?.data?.messages) ? result.data.messages : []),
    ...(Array.isArray(result?.sms) ? result.sms : []),
    ...(Array.isArray(result?.data?.sms) ? result.data.sms : []),
  ];

  for (const item of candidates) {
    const explicit = str(
      item?.code,
      item?.otp,
      item?.sms_code,
      item?.verificationCode,
      item?.verification_code,
    );
    if (explicit) return explicit;

    const content = str(
      item?.content,
      item?.text,
      item?.body,
      item?.message,
    );
    const match = content.match(/\\b(\\d{4,8})\\b/);
    if (match) return match[1];
  }

  if (typeof sms === "string") {
    const match = sms.match(/\\b(\\d{4,8})\\b/);
    if (match) return match[1];
  }

  return "";
}

/* =========================================================
   CHECK ORDER STATUS
========================================================= */

async function actionStatus(orderId: string, userId: string) {
  const order = await ownedOrder(orderId, userId);

  // An automatically refunded failed purchase is already finalized.
  if (
    str(order.provider_state).toLowerCase() ===
    AUTO_REFUNDED_PROVIDER_FAILURE
  ) {
    return response({
      success: true,
      order,
      refunded: true,
      hidden_failed_purchase: true,
      message: "This failed purchase was refunded.",
    });
  }

  const currentStatus = str(order.status).toLowerCase();

  if (
    ["cancelled", "canceled", "refunded", "expired"].includes(currentStatus)
  ) {
    return response({ success: true, order });
  }

  const providerId = str(order.provider_order_id, order.provider_order);

  if (!providerId) {
    return response({
      success: true,
      pending: true,
      order,
      message:
        "The provider order ID is not available yet. This order has not been confirmed.",
    });
  }

  const result = await tvRequest(
    `/verifications/${encodeURIComponent(providerId)}`,
  );

  let sms: any = result?.sms ?? result?.messages ?? result?.data?.sms;

  const smsLink =
    result?.links?.sms?.href ??
    result?.smsHref ??
    result?.sms_href;

  if (!sms && smsLink) {
    try {
      sms = await fetchProviderLink(smsLink);
    } catch (error) {
      logSafeError("textverified-sms-fetch", error);
    }
  }

  const otp = extractTextVerifiedOtp(result, sms);

  const providerStatus = str(
    result?.status,
    result?.state,
    result?.data?.status,
  ).toLowerCase();

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (otp) {
    updates.otp_code = otp;
    updates.code_received_at = new Date().toISOString();
    if (!/cancel|expire/.test(providerStatus)) updates.status = "received";
  }

  if (sms !== undefined) {
    updates.full_sms = typeof sms === "string" ? sms : JSON.stringify(sms);
  }

  if (/complete|success|received/.test(providerStatus)) {
    updates.status = "received";
  } else if (/cancel/.test(providerStatus)) {
    updates.status = "cancelled";
  } else if (/expire/.test(providerStatus)) {
    updates.status = "failed";
  }

  if (providerStatus) updates.provider_state = providerStatus;

  const { data, error } = await supabase
    .from("virtual_number_orders")
    .update(updates)
    .eq("id", orderId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    logSafeError("textverified-status-update", error);
    throw new Error("Unable to update order status.");
  }

  return response({
    success: true,
    order: data,
    provider_response: result,
  });
}

/* =========================================================
   CANCEL ORDER
========================================================= */

async function actionCancel(orderId: string, userId: string) {
  const order = await ownedOrder(orderId, userId);

  if (
    str(order.provider_state).toLowerCase() ===
    AUTO_REFUNDED_PROVIDER_FAILURE
  ) {
    return response({
      success: true,
      refunded: true,
      order,
      message: "This failed purchase was already refunded.",
    });
  }

  const currentStatus = str(order.status).toLowerCase();

  if (
    [
      "cancelled",
      "canceled",
      "completed",
      "finished",
      "received",
      "refunded",
    ].includes(currentStatus)
  ) {
    return response({
      success: true,
      order,
      message: "This order is already finalized.",
    });
  }

  const providerId = str(order.provider_order_id, order.provider_order);

  if (!providerId) {
    return fail(
      "This order has no confirmed provider order ID. It needs status verification before cancellation.",
      409,
      {
        error_code: "PROVIDER_ORDER_ID_MISSING",
        order_id: orderId,
      },
    );
  }

  const details = await tvRequest(
    `/verifications/${encodeURIComponent(providerId)}`,
  );

  const canCancel =
    details?.canCancel ??
    details?.can_cancel ??
    details?.data?.canCancel;

  if (canCancel === false) {
    return fail(
      "TextVerified does not allow this verification to be cancelled now.",
      409,
    );
  }

  const cancelLink =
    details?.links?.cancel?.href ??
    details?.cancelHref ??
    details?.cancel_href;

  let result: any;

  if (cancelLink) {
    result = await fetchProviderLink(cancelLink, "POST");
  } else {
    result = await tvRequest(
      `/verifications/${encodeURIComponent(providerId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
  }

  const providerStatus = str(
    result?.status,
    result?.state,
    result?.data?.status,
  ).toLowerCase();

  if (/failed|cannot|not.?allowed|error/.test(providerStatus)) {
    return fail(
      str(result?.message, "TextVerified did not confirm cancellation."),
      409,
    );
  }

  const wasRefunded =
    result?.refunded === true ||
    result?.refund?.success === true ||
    /\brefund(ed)?\b/.test(providerStatus);

  if (wasRefunded) {
    const refund = await refundTextVerifiedOrder(
      orderId,
      "TextVerified verification cancelled and refunded",
    );

    if (!refund.confirmed) {
      return response(
        {
          success: false,
          refund_pending: true,
          error_code: "CANCEL_REFUND_REVIEW",
          order_id: orderId,
          message:
            "Cancellation was received, but the wallet refund could not be confirmed. Please contact support.",
        },
        502,
      );
    }

    // Deliberately do NOT set the automatic provider-failure marker here.
    // This was a real customer cancellation, so its card remains visible.
    const { data: cancelledOrder, error: updateError } = await supabase
      .from("virtual_number_orders")
      .update({
        provider_state: providerStatus || "cancelled",
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)
      .eq("user_id", userId)
      .select()
      .single();

    if (updateError) {
      logSafeError("textverified-cancel-refund-update", updateError);

      return response(
        {
          success: true,
          refunded: true,
          order_id: orderId,
          message:
            "Cancellation and refund were confirmed, but the order display needs a support review.",
        },
      );
    }

    return response({
      success: true,
      refunded: true,
      order: cancelledOrder,
      order_id: orderId,
      message: "Cancellation and refund confirmed.",
    });
  }

  const { data, error } = await supabase
    .from("virtual_number_orders")
    .update({
      status: "cancelled",
      provider_state: providerStatus || "cancelled",
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    logSafeError("textverified-cancel-update", error);
    throw new Error(
      "Cancellation was received but the order could not be updated.",
    );
  }

  return response({
    success: true,
    order: data,
    provider_response: result,
    message: "Cancellation request processed.",
  });
}

/* =========================================================
   CUSTOMER ORDERS
========================================================= */

async function refreshWaitingTextVerifiedOrder(order: any, userId: string) {
  if (
    !order ||
    String(order.user_id) !== userId ||
    String(order.provider_key).toLowerCase() !== "textverified" ||
    str(order.provider_state).toLowerCase() === AUTO_REFUNDED_PROVIDER_FAILURE ||
    !["waiting", "pending"].includes(str(order.status).toLowerCase()) ||
    str(order.otp_code)
  ) {
    return;
  }

  const providerId = str(order.provider_order_id, order.provider_order);
  if (!providerId || !TV_USERNAME || !TV_API_KEY) return;

  try {
    const result = await tvRequest(
      `/verifications/${encodeURIComponent(providerId)}`,
    );

    let sms: any = result?.sms ?? result?.messages ?? result?.data?.sms ??
      result?.data?.messages ?? result?.verification?.sms;

    const smsLink =
      result?.links?.sms?.href ??
      result?.smsHref ??
      result?.sms_href ??
      result?.data?.links?.sms?.href;

    if (!sms && smsLink) {
      try {
        sms = await fetchProviderLink(smsLink);
      } catch (error) {
        logSafeError("textverified-orders-sms-fetch", error);
      }
    }

    const otp = extractTextVerifiedOtp(result, sms);
    const providerStatus = str(
      result?.status,
      result?.state,
      result?.data?.status,
      result?.verification?.status,
    ).toLowerCase();

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (otp) {
      updates.otp_code = otp;
      updates.code_received_at = new Date().toISOString();
      if (!/cancel|expire/.test(providerStatus)) updates.status = "received";
    }

    if (/complete|success|received/.test(providerStatus) && otp) {
      updates.status = "received";
    } else if (/cancel/.test(providerStatus)) {
      updates.status = "cancelled";
    } else if (/expire/.test(providerStatus)) {
      updates.status = "failed";
    }

    if (providerStatus) updates.provider_state = providerStatus;

    if (sms !== undefined) {
      updates.full_sms = typeof sms === "string" ? sms : JSON.stringify(sms);
    } else if (result?.messages !== undefined) {
      updates.full_sms = JSON.stringify(result.messages);
    } else if (result?.data?.messages !== undefined) {
      updates.full_sms = JSON.stringify(result.data.messages);
    }

    const { error } = await supabase
      .from("virtual_number_orders")
      .update(updates)
      .eq("id", order.id)
      .eq("user_id", userId)
      .eq("provider_key", "textverified");

    if (error) {
      logSafeError("textverified-orders-refresh-update", error);
    }
  } catch (error) {
    // Keep the order list usable if one provider lookup fails.
    logSafeError("textverified-orders-refresh", error);
  }
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
    throw new Error("Unable to load your TextVerified orders.");
  }

  // Refresh up to ten active verifications so newly received SMS codes
  // are saved in our database and returned to this site, not only the provider.
  const waitingOrders = (initialOrders ?? [])
    .filter((order: any) =>
      ["waiting", "pending"].includes(str(order.status).toLowerCase()) &&
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
        "Insufficient provider funds. Please contact support.",
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
