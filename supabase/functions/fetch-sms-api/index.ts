import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FETCHSMS_API_KEY = Deno.env.get("FETCHSMS_API_KEY") ?? "";
const API_BASE = "https://api.fetchsms.com/v1";
const PROVIDER_KEY = "fetchsms";
const COUNTRY_ID = 187;
const AUTO_REFUND_MARKER = "fetchsms_purchase_failed_refunded";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Content-Type": "application/json",
};

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function fail(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return response({ success: false, error: message, message, ...extra }, status);
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function toUtcIso(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : raw + "Z";
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function getUser(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization) throw new Error("Please log in to continue.");

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await client.auth.getUser();

  if (error || !data.user) throw new Error("Your session has expired. Please log in again.");
  return data.user;
}

class ProviderError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data: any = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.data = data;
  }
}

async function providerRequest(path: string, options: RequestInit = {}, authenticated = true) {
  if (authenticated && !FETCHSMS_API_KEY) {
    throw new ProviderError("Fetch SMS API key is not configured. Add FETCHSMS_API_KEY to Supabase Edge Function secrets.", 503);
  }

  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (authenticated) headers.set("Authorization", "Bearer " + FETCHSMS_API_KEY);

  let result: Response;
  try {
    result = await fetch(API_BASE + path, { ...options, headers });
  } catch (error) {
    throw new ProviderError("Fetch SMS could not be reached. The purchase result may need confirmation.", 503, { cause: String(error) });
  }

  const raw = await result.text();
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { detail: raw };
  }

  if (!result.ok) {
    throw new ProviderError(
      str(data?.detail, data?.message, data?.error, "Fetch SMS request failed (" + result.status + ")."),
      result.status,
      data,
    );
  }
  return data;
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
      // Try the next FX source.
    }
  }
  throw new Error("Unable to retrieve the current USD to NGN exchange rate.");
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

async function listServicesRaw(): Promise<any[]> {
  const result = await providerRequest("/services", {}, false);
  return Array.isArray(result) ? result : Array.isArray(result?.services) ? result.services : [];
}

async function listServices() {
  const rows = await listServicesRaw();
  const services = rows.filter((item: any) => Number(item?.id) !== 1).map((item: any) => ({
    id: num(item?.id), code: String(item?.id ?? ""), service_code: String(item?.id ?? ""),
    slug: str(item?.slug), name: str(item?.name, item?.slug, item?.id),
    service_name: str(item?.name, item?.slug, item?.id), price_cents: num(item?.price_cents),
    short_available: num(item?.short_available), available: num(item?.short_available) > 0,
    long_available: num(item?.long_available),
  }));
  return await mapWithConcurrency(services, 3, async (item) => {
    if (!item.available) return { ...item, price: null, price_ngn: null };
    try {
      const quote = await getQuote(String(item.service_code), item);
      return { ...item, price: quote.price, price_ngn: quote.price, currency: "NGN" };
    } catch {
      console.warn("[fetchsms-service-price] Quote unavailable for service.");
      return { ...item, price: null, price_ngn: null };
    }
  });
}

async function getMarkup(service: string): Promise<number> {
  const { data, error } = await supabase
    .from("virtual_number_markup_rules")
    .select("country_id,country_key,service_code,markup_percent,is_active")
    .eq("server", PROVIDER_KEY)
    .eq("is_active", true);

  if (error) throw new Error("Unable to retrieve Fetch SMS markup settings.");

  const rules = data ?? [];
  const serviceKey = service.toLowerCase();
  const match = (countryId: number | null, serviceCode: string | null) =>
    rules.find((r: any) =>
      (r.country_id == null ? countryId === null : Number(r.country_id) === countryId) &&
      (str(r.service_code).toLowerCase() || null) === serviceCode
    );

  const specific = match(COUNTRY_ID, serviceKey);
  const countryDefault = match(COUNTRY_ID, null);
  const globalService = match(null, serviceKey);
  const globalDefault = match(null, null);
  return num(
    specific?.markup_percent ??
    countryDefault?.markup_percent ??
    globalService?.markup_percent ??
    globalDefault?.markup_percent,
    100,
  );
}

async function getFixedPriceOverride(service: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("virtual_number_price_overrides")
    .select("custom_price_ngn")
    .eq("provider", PROVIDER_KEY)
    .eq("country_id", COUNTRY_ID)
    .eq("service_code", service)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw new Error("Unable to retrieve the Fetch SMS fixed-price override.");
  if (!data) return null;
  const price = num(data.custom_price_ngn, -1);
  return price > 0 ? price : null;
}

async function getQuote(service: string, serviceRowOverride?: any) {
  if (!/^\d+$/.test(service) || Number(service) === 1) {
    throw new Error("Select a valid short-term Fetch SMS service. Long-term rentals are not part of this USA verification flow.");
  }

  const [quote, catalog, fx, markup, fixedPrice] = await Promise.all([
    providerRequest(
      "/services/quote?service=" + encodeURIComponent(service) + "&mode=short",
      {},
      false,
    ),
    serviceRowOverride ? Promise.resolve([]) : listServicesRaw(),
    getFxRate(),
    getMarkup(service),
    getFixedPriceOverride(service),
  ]);

  const cents = num(quote?.total_cents, -1);
  if (cents < 0) throw new Error("Fetch SMS did not return a valid service price.");

  const serviceRow = serviceRowOverride ?? catalog.find((item: any) => String(item?.id) === service);
  const stock = num(serviceRow?.short_available);
  const providerPrice = cents / 100;
  const costNaira = Math.ceil(providerPrice * fx);
  const price = fixedPrice ?? Math.ceil(costNaira * (1 + markup / 100));

  return {
    success: true,
    service,
    service_name: str(serviceRow?.name, serviceRow?.slug, service),
    label: "USA number",
    country: "United States",
    country_id: COUNTRY_ID,
    provider_price: providerPrice,
    provider_price_cents: cents,
    exchange_rate: fx,
    markup_percent: markup,
    cost_naira: costNaira,
    price,
    fixed_price_override: fixedPrice !== null,
    currency: "NGN",
    available: stock > 0,
    short_available: stock,
    status: stock > 0 ? "available" : "out_of_stock",
  };
}

async function walletBalance(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("wallet")
    .select("balance")
    .eq("user-id", userId)
    .maybeSingle();

  if (error || !data) throw new Error("Unable to retrieve your wallet balance.");
  return num(data.balance);
}

async function providerBalanceCents(): Promise<number> {
  const data = await providerRequest("/wallet/balance");
  return num(data?.balance_cents, -1);
}

async function reserveOrder(args: {
  userId: string;
  service: string;
  serviceName: string;
  price: number;
  providerPrice: number;
  exchangeRate: number;
  idempotencyKey: string;
}) {
  const providerCostNgn = Math.ceil(args.providerPrice * args.exchangeRate);
  const { data, error } = await supabase.rpc("reserve_virtual_number_order", {
    p_user_id: args.userId,
    p_provider_key: PROVIDER_KEY,
    p_idempotency_key: args.idempotencyKey,
    p_service_code: args.service,
    p_service_name: args.serviceName,
    p_country_id: COUNTRY_ID,
    p_country_name: "United States",
    p_customer_price_ngn: args.price,
    p_exchange_rate: args.exchangeRate,
    p_provider_cost_usd: args.providerPrice,
    p_provider_cost_ngn: providerCostNgn,
  });

  if (error) throw new Error("Unable to reserve this order.");
  const order = Array.isArray(data) ? data[0] : data;
  if (order?.success === false) {
    if (order?.error === "insufficient_wallet_balance") {
      throw new Error("Insufficient wallet funds. Please add money to your wallet.");
    }
    throw new Error(str(order?.message, order?.error, "Unable to reserve this order."));
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
    .eq("provider_key", PROVIDER_KEY)
    .maybeSingle();

  if (error || !data) throw new Error("Order not found.");
  return data;
}

async function refundLocalOrder(orderId: number, reason: string) {
  const { data, error } = await supabase.rpc("process_virtual_number_refund", {
    p_order_id: orderId,
    p_provider_key: PROVIDER_KEY,
    p_reason: reason,
  });

  if (error) {
    console.error("Fetch SMS customer refund failed:", error.message);
    return false;
  }

  const refund = Array.isArray(data) ? data[0] : data;
  return refund?.success === true || refund?.already_refunded === true;
}

async function hideFailedPurchase(orderId: number, userId: string, reason: string) {
  const refunded = await refundLocalOrder(orderId, reason);
  if (!refunded) return false;

  const { error } = await supabase
    .from("virtual_number_orders")
    .update({
      status: "refunded",
      provider_state: AUTO_REFUND_MARKER,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("user_id", userId)
    .eq("provider_key", PROVIDER_KEY);

  if (error) {
    console.error("Fetch SMS refund marker failed:", error.message);
    return false;
  }

  const { error: txError } = await supabase
    .from("transactions")
    .update({ status: "failed" })
    .eq("reference", "VNUM-" + orderId)
    .eq("type", "virtual_number_purchase");

  if (txError) console.error("Fetch SMS purchase transaction update failed:", txError.message);
  return true;
}

async function actionBuy(body: any, userId: string, req: Request) {
  const service = str(body.service, body.service_code, body.serviceCode);
  const quote = await getQuote(service);

  if (!quote.available) {
    return fail("USA numbers for this service are currently out of stock. Please try again later.", 409, {
      error_code: "NUMBER_OUT_OF_STOCK",
      available: 0,
    });
  }

  const providerBalance = await providerBalanceCents();
  if (providerBalance < 0) throw new Error("Unable to check Fetch SMS provider balance.");
  if (providerBalance < quote.provider_price_cents) {
    return fail("Insufficient funds. Please contact support.", 402, {
      error_code: "PROVIDER_INSUFFICIENT_FUNDS",
    });
  }

  const customerBalance = await walletBalance(userId);
  if (customerBalance < quote.price) {
    const shortfall = Math.ceil(quote.price - customerBalance);
    return fail(
      "Insufficient funds. Please add ₦" + shortfall.toLocaleString("en-NG") + ".",
      400,
      { error_code: "INSUFFICIENT_WALLET_FUNDS", balance: customerBalance, price: quote.price, shortfall },
    );
  }

  const idempotencyKey =
    str(req.headers.get("idempotency-key"), body.idempotency_key, body.idempotencyKey) ||
    crypto.randomUUID();

  const reserved = await reserveOrder({
    userId,
    service,
    serviceName: quote.service_name,
    price: quote.price,
    providerPrice: quote.provider_price,
    exchangeRate: quote.exchange_rate,
    idempotencyKey,
  });

  const orderId = num(reserved?.order_id ?? reserved?.id);
  if (!orderId) throw new Error("Order reservation did not return an order ID.");

  if (reserved?.existing === true) {
    return response({
      success: true,
      pending: true,
      order_id: orderId,
      message: "This number request already exists. Check your existing order.",
    }, 202);
  }

  let providerOrder: any;
  try {
    providerOrder = await providerRequest("/verifications", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ service: Number(service) }),
    });
  } catch (error) {
    const status = num((error as any)?.status);
    if (status >= 400 && status < 500) {
      const refunded = await hideFailedPurchase(
        orderId,
        userId,
        status === 409
          ? "Fetch SMS out of stock - customer wallet refund"
          : "Fetch SMS purchase rejected - customer wallet refund",
      );
      if (!refunded) {
        return fail("The provider rejected this request, but the wallet refund needs support review. Please contact support.", 502, {
          error_code: "REFUND_REVIEW_REQUIRED",
          order_id: orderId,
        });
      }
      if (status === 402) {
        return fail("Insufficient funds. Please contact support.", 402, {
          error_code: "PROVIDER_INSUFFICIENT_FUNDS",
        });
      }
      if (status === 409) {
        return fail("USA numbers for this service are currently out of stock. Please try again later.", 409, {
          error_code: "NUMBER_OUT_OF_STOCK",
        });
      }
      return fail("This USA number could not be purchased. Your wallet refund is confirmed.", status);
    }

    await supabase
      .from("virtual_number_orders")
      .update({
        provider_state: "purchase_confirmation_pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)
      .eq("user_id", userId)
      .eq("provider_key", PROVIDER_KEY);

    return response({
      success: true,
      pending: true,
      order_id: orderId,
      message: "Fetch SMS did not confirm the purchase response. Your request is being held for confirmation; please do not purchase again.",
    }, 202);
  }

  const providerOrderId = str(providerOrder?.id, providerOrder?.verification_id);
  const phone = str(providerOrder?.number, providerOrder?.phone_number);
  const expiresAt = toUtcIso(providerOrder?.expires_at);

  if (!providerOrderId || !phone) {
    if (providerOrderId) {
      try {
        await providerRequest("/verifications/" + encodeURIComponent(providerOrderId) + "/cancel", {
          method: "POST",
        });
        await hideFailedPurchase(orderId, userId, "Fetch SMS returned an incomplete allocation - customer wallet refund");
        return fail("Fetch SMS did not return a usable phone number. Your wallet refund is confirmed.", 502);
      } catch (cancelError) {
        console.error("Fetch SMS incomplete allocation cancellation failed:", String(cancelError));
      }
    }

    await supabase
      .from("virtual_number_orders")
      .update({
        provider_order_id: providerOrderId || null,
        number: phone || null,
        provider_expires_at: expiresAt,
        provider_state: "allocation_confirmation_pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)
      .eq("user_id", userId)
      .eq("provider_key", PROVIDER_KEY);

    return response({
      success: true,
      pending: true,
      order_id: orderId,
      message: "Fetch SMS returned an incomplete allocation. The order is held for confirmation; please contact support before retrying.",
    }, 202);
  }

  const { data: attached, error: attachError } = await supabase.rpc("attach_virtual_number_provider_order", {
    p_order_id: orderId,
    p_user_id: userId,
    p_provider_key: PROVIDER_KEY,
    p_provider_order_id: providerOrderId,
    p_number: phone,
    p_provider_expires_at: expiresAt,
    p_provider_state: str(providerOrder?.status, "waiting"),
  });

  if (attachError || !attached) {
    console.error("Fetch SMS attach RPC failed:", attachError?.message ?? "No result");
    const { error: directError } = await supabase
      .from("virtual_number_orders")
      .update({
        provider_order_id: providerOrderId,
        number: phone,
        provider_expires_at: expiresAt,
        provider_state: str(providerOrder?.status, "waiting"),
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)
      .eq("user_id", userId)
      .eq("provider_key", PROVIDER_KEY);

    if (directError) {
      try {
        await providerRequest("/verifications/" + encodeURIComponent(providerOrderId) + "/cancel", {
          method: "POST",
        });
        await hideFailedPurchase(orderId, userId, "Fetch SMS allocation could not be saved - customer wallet refund");
        return fail("The number could not be saved. The provider cancellation and wallet refund were confirmed.", 502);
      } catch (cancelError) {
        console.error("Fetch SMS recovery cancellation failed:", String(cancelError));
      }
      return response({
        success: true,
        pending: true,
        order_id: orderId,
        provider_order_id: providerOrderId,
        number: phone,
        message: "The provider issued a number, but saving it needs support review. Do not purchase another number.",
      }, 202);
    }
  }

  return response({
    success: true,
    order_id: orderId,
    provider_order_id: providerOrderId,
    number: phone,
    expires_at: expiresAt,
    order: attached ?? providerOrder,
    message: "USA number purchased successfully.",
  });
}

async function actionStatus(orderId: string, userId: string) {
  const order = await ownedOrder(orderId, userId);
  if (str(order.provider_state).toLowerCase() === AUTO_REFUND_MARKER) {
    return response({ success: true, order, refunded: true, hidden_failed_purchase: true });
  }
  if (str(order.otp_code)) {
    return response({ success: true, order: { ...order, status: "received" }, code_received: true });
  }

  const current = str(order.status).toLowerCase();
  if (["refunded", "failed", "expired"].includes(current)) return response({ success: true, order });

  const providerId = str(order.provider_order_id);
  if (!providerId) return response({ success: true, pending: true, order });

  const result = await providerRequest("/verifications/" + encodeURIComponent(providerId));
  const code = str(result?.code);
  const state = str(result?.status).toLowerCase();
  const expiresAt = toUtcIso(result?.expires_at) ?? order.provider_expires_at ?? null;
  const now = new Date().toISOString();

  if (code && state === "received") {
    const { data, error } = await supabase
      .from("virtual_number_orders")
      .update({
        otp_code: code,
        code_received_at: order.code_received_at || now,
        status: "received",
        provider_state: "received",
        provider_expires_at: expiresAt,
        updated_at: now,
      })
      .eq("id", order.id)
      .eq("user_id", userId)
      .eq("provider_key", PROVIDER_KEY)
      .select()
      .single();

    if (error) throw new Error("A code arrived, but the successful verification could not be saved. Please refresh.");
    return response({ success: true, order: data, code_received: true });
  }

  if (state === "expired" || state === "cancelled") {
    const refunded = await refundLocalOrder(Number(order.id), "Fetch SMS " + state + " - customer wallet refund");
    if (!refunded) {
      return response({ success: true, order, expired: state === "expired", cancelled: state === "cancelled", refund_pending: true }, 202);
    }

    const nextStatus = state === "expired" ? "failed" : "cancelled";
    const { data, error } = await supabase
      .from("virtual_number_orders")
      .update({
        status: nextStatus,
        provider_state: state,
        provider_expires_at: expiresAt,
        updated_at: now,
      })
      .eq("id", order.id)
      .eq("user_id", userId)
      .eq("provider_key", PROVIDER_KEY)
      .select()
      .single();

    if (error) throw new Error("The refund was confirmed, but the order status could not be saved.");
    return response({ success: true, order: data, expired: state === "expired", cancelled: state === "cancelled", refunded: true });
  }

  const safeProviderState = state === "received" && !code ? "waiting" : (state || "waiting");
  const { data, error } = await supabase
    .from("virtual_number_orders")
    .update({
      provider_state: safeProviderState,
      provider_expires_at: expiresAt,
      updated_at: now,
    })
    .eq("id", order.id)
    .eq("user_id", userId)
    .eq("provider_key", PROVIDER_KEY)
    .select()
    .single();

  if (error) throw new Error("Unable to update the Fetch SMS order status.");
  return response({ success: true, order: data, code_received: false });
}

async function actionCancel(orderId: string, userId: string) {
  const order = await ownedOrder(orderId, userId);
  if (str(order.otp_code) || str(order.status).toLowerCase() === "received" || order.code_received_at) {
    return fail("Verification successful. This number can no longer be cancelled.", 409, {
      error_code: "CODE_ALREADY_RECEIVED",
    });
  }

  if (order.refunded_at || order.refund_processed_at || str(order.status).toLowerCase() === "refunded") {
    return response({ success: true, order, refunded: true, message: "This order has already been refunded." });
  }

  const providerId = str(order.provider_order_id);
  if (!providerId) {
    return fail("The provider has not confirmed a number for this request yet. Please refresh the order or contact support.", 409, {
      error_code: "PROVIDER_ORDER_NOT_CONFIRMED",
    });
  }

  try {
    await providerRequest("/verifications/" + encodeURIComponent(providerId) + "/cancel", {
      method: "POST",
    });
  } catch (error) {
    if (num((error as any)?.status) === 409) {
      try {
        const latest = await providerRequest("/verifications/" + encodeURIComponent(providerId));
        const code = str(latest?.code);
        if (code) {
          const { error: saveError } = await supabase
            .from("virtual_number_orders")
            .update({
              otp_code: code,
              code_received_at: order.code_received_at || new Date().toISOString(),
              status: "received",
              provider_state: "received",
              updated_at: new Date().toISOString(),
            })
            .eq("id", order.id)
            .eq("user_id", userId)
            .eq("provider_key", PROVIDER_KEY);
          if (saveError) throw new Error("A code arrived but could not be saved. Please refresh.");
          return fail("A verification code has already arrived. This number cannot be cancelled.", 409, {
            error_code: "CODE_ALREADY_RECEIVED",
          });
        }
      } catch (statusError) {
        console.error("Fetch SMS cancellation conflict status check failed:", String(statusError));
      }
    }
    throw error;
  }

  const refunded = await refundLocalOrder(Number(order.id), "Fetch SMS verification cancelled - wallet refund");
  if (!refunded) {
    return response({
      success: true,
      cancelled: true,
      refund_pending: true,
      message: "Fetch SMS confirmed cancellation, but the customer wallet refund needs support review.",
    }, 202);
  }

  const { data, error } = await supabase
    .from("virtual_number_orders")
    .select("*")
    .eq("id", order.id)
    .eq("user_id", userId)
    .eq("provider_key", PROVIDER_KEY)
    .single();

  if (error) throw new Error("Cancellation and refund were confirmed, but the order could not be reloaded.");
  return response({ success: true, order: data, cancelled: true, refunded: true });
}

async function actionOrders(userId: string) {
  const { data, error } = await supabase
    .from("virtual_number_orders")
    .select("*")
    .eq("user_id", userId)
    .eq("provider_key", PROVIDER_KEY)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new Error("Unable to load your Fetch SMS orders.");
  return response({
    success: true,
    orders: (data ?? []).filter((item: any) => str(item.provider_state).toLowerCase() !== AUTO_REFUND_MARKER),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") return fail("Method not allowed.", 405);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return fail("Supabase environment is not configured.", 503);
  }

  let action = "unknown";
  try {
    const user = await getUser(req);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    action = str(body.action, body.type, new URL(req.url).searchParams.get("action")).toLowerCase();

    switch (action) {
      case "services":
      case "listservices":
        return response({ success: true, services: await listServices() });

      case "quote":
      case "price":
        return response(await getQuote(str(body.service, body.service_code, body.serviceCode)));

      case "buy":
      case "purchase":
        return await actionBuy(body, user.id, req);

      case "status":
      case "check":
        return await actionStatus(str(body.id, body.order_id), user.id);

      case "cancel":
        return await actionCancel(str(body.id, body.order_id), user.id);

      case "orders":
        return await actionOrders(user.id);

      case "wallet":
      case "balance":
        return response({ success: true, balance_cents: await providerBalanceCents() });

      default:
        return fail("Unknown action. Use services, quote, buy, status, cancel, orders, or wallet.");
    }
  } catch (error) {
    const status = num((error as any)?.status, 500);
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    console.error("Fetch SMS request failed:", { action, status, message });
    return fail(message, status);
  }
});
