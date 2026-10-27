import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const EMAIL = Deno.env.get("THEGIFTUNC_EMAIL") ?? "";
const PASSWORD = Deno.env.get("THEGIFTUNC_PASSWORD") ?? "";
const BASE = "https://thegiftunc.com/api";
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
const failure = (message: string, status = 400, extra: Record<string, unknown> = {}) => reply({ error: message, ...extra }, status);
const db = createClient(URL, SERVICE, { auth: { persistSession: false } });

function arr(x: any): any[] {
  if (Array.isArray(x)) return x;
  for (const k of ["data", "categories", "services", "result"]) if (Array.isArray(x?.[k])) return x[k];
  return [];
}
function idOf(x: any) { return String(x?.id ?? x?.serviceId ?? x?.service_id ?? ""); }
function categoryOf(x: any) {
  const c = x?.category ?? x?.serviceCategory ?? x?.service_category ?? {};
  return { id: String(c?.id ?? x?.categoryId ?? x?.category_id ?? "other"), name: String(c?.name ?? x?.categoryName ?? x?.category_name ?? "Other") };
}
function costOf(x: any) {
  const n = Number(x?.price ?? x?.amount ?? x?.cost ?? x?.rate ?? x?.selling_price ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
async function supplier(path: string, method = "GET", payload?: unknown) {
  if (!EMAIL || !PASSWORD) throw new Error("TheGiftUnc login secrets are missing in Supabase.");
  const login = await fetch(BASE + "/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const auth = await login.json().catch(() => ({}));
  const token = auth?.access_token ?? auth?.data?.access_token ?? auth?.token;
  if (!login.ok || !token) throw new Error("TheGiftUnc login failed. Check the saved supplier credentials.");
  const response = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data?.message ?? data?.error ?? data?.detail ?? "The provider rejected the request."));
  return data;
}
async function getCatalog() {
  const [categoryResult, serviceResult, savedCats, savedServices] = await Promise.all([
    supplier("/service/categories"), supplier("/service/list"),
    db.from("social_log_category_pricing").select("*"),
    db.from("social_log_service_pricing").select("*"),
  ]);
  if (savedCats.error || savedServices.error) throw new Error("Could not load the saved service pricing settings.");
  const catCfg = new Map<string, any>((savedCats.data ?? []).map((x: any) => [String(x.category_id), x]));
  const serviceCfg = new Map<string, any>((savedServices.data ?? []).map((x: any) => [String(x.service_id), x]));
  const categories = arr(categoryResult).map((x: any) => {
    const id = idOf(x);
    return { id, name: String(x?.name ?? x?.category_name ?? x?.title ?? "Category"), markup_percent: Number(catCfg.get(id)?.markup_percent ?? 50) };
  });
  const services = arr(serviceResult).map((x: any) => {
    const id = idOf(x), cat = categoryOf(x), provider_price = costOf(x), cfg = serviceCfg.get(id);
    if (!categories.some((c: any) => c.id === cat.id)) categories.push({ id: cat.id, name: cat.name, markup_percent: Number(catCfg.get(cat.id)?.markup_percent ?? 50) });
    const calculated = Math.round(provider_price * (1 + Number(catCfg.get(cat.id)?.markup_percent ?? 50) / 100) * 100) / 100;
    return {
      id, name: String(x?.name ?? x?.service_name ?? x?.title ?? ("Service " + id)),
      description: String(x?.description ?? x?.details ?? ""), category_id: cat.id, category_name: cat.name,
      provider_price, calculated_price: calculated,
      customer_price: cfg?.custom_price != null ? Number(cfg.custom_price) : calculated,
      is_active: cfg?.is_active !== false,
    };
  }).filter((x: any) => x.id && x.is_active);
  return { categories, services, catCfg, serviceCfg };
}
async function authUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Please log in to continue.");
  const userClient = createClient(URL, ANON, { global: { headers: { Authorization: "Bearer " + token } }, auth: { persistSession: false } });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) throw new Error("Your session expired. Please log in again.");
  return { user: data.user, userClient };
}
async function requireAdmin(userId: string) {
  const { data, error } = await db.from("admin_users").select("user_id").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Admin access required.");
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return failure("Method not allowed.", 405);
  try {
    if (!URL || !ANON || !SERVICE) return failure("Supabase Edge Function secrets are incomplete.", 500);
    const { user, userClient } = await authUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    if (action === "catalog") {
      const c = await getCatalog();
      return reply({ categories: c.categories, services: c.services });
    }
    if (["admin_catalog", "save_category_markups", "save_service_prices"].includes(action)) {
      await requireAdmin(user.id);
      if (action === "admin_catalog") {
        const c = await getCatalog();
        return reply({
          categories: c.categories, services: c.services,
          category_markups: Object.fromEntries([...c.catCfg.entries()].map(([k, v]) => [k, Number(v.markup_percent)])),
          service_overrides: Object.fromEntries([...c.serviceCfg.entries()].map(([k, v]) => [k, v.custom_price == null ? null : Number(v.custom_price)])),
        });
      }
      if (action === "save_category_markups") {
        if (!body.markups || typeof body.markups !== "object") return failure("Category markups are required.");
        for (const [id, raw] of Object.entries(body.markups)) {
          const markup = Number(raw);
          if (!Number.isFinite(markup) || markup < 0 || markup > 10000) return failure("Markup must be between 0% and 10,000%.");
          const { error } = await db.from("social_log_category_pricing").upsert({
            category_id: String(id), category_name: String(body.category_names?.[id] ?? id),
            markup_percent: markup, updated_at: new Date().toISOString(),
          });
          if (error) throw error;
        }
        return reply({ ok: true });
      }
      const { overrides = {}, active = {}, service_names = {}, category_ids = {} } = body;
      for (const id of new Set([...Object.keys(overrides), ...Object.keys(active)])) {
        const custom = overrides[id] == null || overrides[id] === "" ? null : Number(overrides[id]);
        if (custom !== null && (!Number.isFinite(custom) || custom < 0)) return failure("Custom prices must be zero or higher.");
        const { error } = await db.from("social_log_service_pricing").upsert({
          service_id: String(id), service_name: String(service_names[id] ?? id),
          category_id: String(category_ids[id] ?? ""), custom_price: custom,
          is_active: active[id] !== false, updated_at: new Date().toISOString(),
        });
        if (error) throw error;
      }
      return reply({ ok: true });
    }
    if (action === "purchase") {
      const serviceId = String(body.service_id ?? "");
      const quantity = Number(body.quantity ?? 1);
      if (!serviceId || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return failure("Choose a service and quantity from 1 to 100.");
      const catalog = await getCatalog();
      const service = catalog.services.find((x: any) => x.id === serviceId);
      if (!service) return failure("This service is unavailable. Refresh the page and try again.");
      const charge = Math.round(Number(service.customer_price) * quantity * 100) / 100;
      if (!Number.isFinite(charge) || charge <= 0) return failure("This service has an invalid selling price. Contact support.");
      const reference = "social-log-" + crypto.randomUUID();
      const { data: debit, error: debitError } = await userClient.rpc("social_log_debit", {
        p_user_id: user.id, p_amount: charge, p_reference: reference, p_description: "TheGiftUnc service: " + service.name,
      });
      if (debitError) throw debitError;
      if (!debit?.ok) return failure("Insufficient funds. Shortfall: " + Number(debit?.shortfall ?? charge), 402, { shortfall: Number(debit?.shortfall ?? charge), balance: Number(debit?.balance ?? 0) });
      let result: any;
      try {
        const payload: Record<string, unknown> = { serviceId, quantity };
        if (body.order_data && typeof body.order_data === "object") payload.orderData = body.order_data;
        result = await supplier("/service/purchase", "POST", payload);
      } catch (e) {
        await db.rpc("social_log_refund", { p_user_id: user.id, p_amount: charge, p_reference: reference + "-refund", p_description: "TheGiftUnc order failed; wallet refund for " + service.name });
        return failure("The provider could not accept the order. Your wallet has been refunded. " + (e instanceof Error ? e.message : ""), 502);
      }
      const providerOrderId = String(result?.order?.id ?? result?.data?.order?.id ?? result?.orderId ?? result?.id ?? "");
      const state = String(result?.status ?? result?.data?.status ?? result?.order?.status ?? "pending").toLowerCase();
      const status = ["completed", "success", "successful", "done"].includes(state) ? "completed" : "pending";
      const { error: saveError } = await db.from("social_log_orders").insert({
        user_id: user.id, provider_order_id: providerOrderId || null, service_id: serviceId,
        service_name: service.name, category_id: service.category_id, customer_price: charge,
        provider_price: Number(service.provider_price) * quantity, quantity, status,
        order_data: body.order_data ?? null, provider_response: result, updated_at: new Date().toISOString(),
      });
      if (saveError) {
        await db.rpc("social_log_refund", { p_user_id: user.id, p_amount: charge, p_reference: reference + "-refund", p_description: "Refund because order record failed: " + service.name });
        return failure("We could not save your order record. Your wallet has been refunded; contact support if needed.", 500);
      }
      return reply({ ok: true, balance: Number(debit.balance), message: status === "completed" ? "Order completed successfully." : "Order submitted and is pending provider processing.", order: { provider_order_id: providerOrderId, service_name: service.name, status } });
    }
    return failure("Unknown action.");
  } catch (e) {
    return failure(e instanceof Error ? e.message : "Unexpected service error.", 500);
  }
});