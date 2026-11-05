import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
const escapeHtml = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return reply({ error: "Please sign in." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceKey) return reply({ error: "Support is temporarily unavailable." }, 503);

  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authError } = await caller.auth.getUser();
  if (authError || !user) return reply({ error: "Please sign in again." }, 401);

  let payload: any;
  try { payload = await req.json(); } catch { return reply({ error: "Invalid request." }, 400); }
  const conversationId = String(payload.conversationId || "");
  const messageId = String(payload.messageId || "");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(conversationId) || !uuid.test(messageId)) return reply({ error: "Invalid chat message." }, 400);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const [conversationResult, messageResult, settingsResult] = await Promise.all([
    db.from("support_chat_conversations").select("id,customer_user_id,last_alert_at,bot_replied_at").eq("id", conversationId).maybeSingle(),
    db.from("support_chat_messages").select("id,conversation_id,sender_user_id,sender_role,message_text,image_path,created_at").eq("id", messageId).maybeSingle(),
    db.from("support_chat_settings").select("admin_last_seen_at,away_after_minutes,away_message").eq("id", true).maybeSingle(),
  ]);
  const conversation = conversationResult.data;
  const message = messageResult.data;
  if (conversationResult.error || !conversation || conversation.customer_user_id !== user.id) {
    return reply({ error: "Conversation not found." }, 404);
  }
  if (messageResult.error || !message || message.conversation_id !== conversationId ||
      message.sender_role !== "customer" || message.sender_user_id !== user.id) {
    return reply({ error: "Customer message not found." }, 404);
  }
  if (settingsResult.error) return reply({ error: "Support settings could not be loaded." }, 500);

  const settings = settingsResult.data || {};
  const awayMinutes = Math.max(1, Math.min(60, Number(settings.away_after_minutes) || 2));
  const lastSeen = settings.admin_last_seen_at ? new Date(settings.admin_last_seen_at).getTime() : 0;
  const adminOnline = Number.isFinite(lastSeen) && lastSeen > Date.now() - awayMinutes * 60 * 1000;
  if (adminOnline) return reply({ ok: true, adminOnline: true, botReplied: false, alertSent: false });

  let botReplied = false;
  const lastBotReply = conversation.bot_replied_at ? new Date(conversation.bot_replied_at).getTime() : 0;
  if (!lastBotReply || lastBotReply < Date.now() - 30 * 60 * 1000) {
    const awayMessage = String(settings.away_message ||
      "Thanks for your message. Our support team is away right now, but you can leave the details here. We will reply in this conversation as soon as possible.").slice(0, 1000);
    const inserted = await db.from("support_chat_messages").insert({
      conversation_id: conversationId,
      sender_user_id: null,
      sender_role: "bot",
      message_text: awayMessage,
    });
    botReplied = !inserted.error;
    if (inserted.error) console.error("Away reply could not be saved:", inserted.error.message);
  }

  const cooldown = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const claim = await db.from("support_chat_conversations")
    .update({ last_alert_at: new Date().toISOString() })
    .eq("id", conversationId)
    .or("last_alert_at.is.null,last_alert_at.lt." + cooldown)
    .select("id")
    .maybeSingle();
  if (claim.error) {
    console.error("Could not claim chat alert:", claim.error.message);
    return reply({ ok: true, adminOnline: false, botReplied, alertSent: false });
  }
  if (!claim.data) return reply({ ok: true, adminOnline: false, botReplied, alertSent: false });

  const profileResult = await db.from("profiles").select("full_name,email").eq("id", user.id).maybeSingle();
  const customerName = profileResult.data?.full_name || user.email || "A customer";
  const customerEmail = profileResult.data?.email || user.email || "Not available";
  const preview = String(message.message_text || (message.image_path ? "Sent an image attachment." : "Sent a message.")).slice(0, 700);
  const adminUrl = "https://delightvendorlog.com/admin-live-chat.html";
  const emailKey = Deno.env.get("RESEND_API_KEY") || "";
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "";
  const adminEmail = Deno.env.get("ADMIN_NOTIFICATION_EMAIL") || "delightvendorlogs@gmail.com";
  let emailSent = false;
  let emailError = "";
  if (emailKey && fromEmail) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + emailKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromEmail,
          to: [adminEmail],
          subject: "New customer message — Delight Vendor Logs",
          html: "<div style='font-family:Arial,sans-serif;background:#101010;color:#f5f0df;padding:24px;border-radius:12px'>" +
            "<h2 style='color:#d4af37'>New message in Live Chat</h2>" +
            "<p><b>Customer:</b> " + escapeHtml(customerName) + "</p>" +
            "<p><b>Email:</b> " + escapeHtml(customerEmail) + "</p>" +
            "<p><b>Message:</b><br>" + escapeHtml(preview).replace(/\n/g, "<br>") + "</p>" +
            "<p><a style='display:inline-block;background:#d4af37;color:#111;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold' href='" + adminUrl + "'>Open Live Chat</a></p></div>",
        }),
      });
      emailSent = response.ok;
      if (!response.ok) emailError = (await response.text()).slice(0, 400);
    } catch (error) { emailError = String(error); }
  } else {
    emailError = !emailKey ? "RESEND_API_KEY is not configured." : "RESEND_FROM_EMAIL is not configured.";
  }

  const telegramToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const telegramChat = Deno.env.get("TELEGRAM_CHAT_ID") || "";
  let telegramSent = false;
  let telegramError = "";
  if (telegramToken && telegramChat) {
    try {
      const response = await fetch("https://api.telegram.org/bot" + telegramToken + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramChat,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          text: "<b>🔔 New Delight Vendor Logs chat message</b>\n\n<b>Customer:</b> " + escapeHtml(customerName) +
            "\n<b>Email:</b> " + escapeHtml(customerEmail) + "\n<b>Message:</b> " + escapeHtml(preview) +
            "\n\n<a href='" + adminUrl + "'>Open Live Chat</a>",
        }),
      });
      const result = await response.json().catch(() => ({}));
      telegramSent = response.ok && result.ok === true;
      if (!telegramSent) telegramError = String(result.description || "Telegram delivery failed.");
    } catch (error) { telegramError = String(error); }
  } else {
    telegramError = "Telegram bot token or admin chat ID is missing.";
  }


  // Browser alerts are restricted to registered administrator accounts only.
  let pushSent = 0;
  let pushFailed = 0;
  let pushError = "";
  const adminRows = await db.from("admin_users").select("user_id");
  if (adminRows.error) {
    pushError = "Could not load administrator recipients.";
    console.error("Admin recipient lookup failed:", adminRows.error.message);
  } else {
    const adminIds = [...new Set((adminRows.data || []).map((row: any) => row.user_id).filter(Boolean))];
    if (adminIds.length) {
      const vapidResult = await db.rpc("get_dv_vapid_credentials");
      const publicKey = Deno.env.get("VAPID_PUBLIC_KEY") || vapidResult.data?.publicKey || "";
      const privateKey = Deno.env.get("VAPID_PRIVATE_KEY") || vapidResult.data?.privateKey || "";
      if (vapidResult.error) console.error("VAPID credentials unavailable:", vapidResult.error.message);
      if (publicKey && privateKey) {
        try {
          webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:delightvendorlogs@gmail.com", publicKey, privateKey);
          const subscriptions = await db.from("notification_push_subscriptions")
            .select("id,user_id,subscription")
            .in("user_id", adminIds);
          if (subscriptions.error) throw subscriptions.error;
          for (const sub of (subscriptions.data || []) as any[]) {
            try {
              await webpush.sendNotification(sub.subscription, JSON.stringify({
                title: "New customer message — Delight Vendor Logs",
                body: preview.slice(0, 180),
                icon: "/assets/dv-logo.png",
                badge: "/assets/dv-logo.png",
                data: { url: adminUrl },
              }));
              pushSent++;
            } catch (error: any) {
              pushFailed++;
              if (error?.statusCode === 404 || error?.statusCode === 410) {
                await db.from("notification_push_subscriptions").delete().eq("id", sub.id);
              } else {
                console.error("Admin chat push failed:", error?.statusCode || error?.message || error);
              }
            }
          }
        } catch (error) {
          pushError = "Browser push could not be sent.";
          console.error("Admin chat push setup failed:", error);
        }
      } else {
        pushError = "VAPID credentials are not configured.";
      }
    }
  }

  return reply({ ok: true, adminOnline: false, botReplied, alertSent: emailSent || telegramSent || pushSent > 0, emailSent, telegramSent, pushSent, pushFailed, emailError, telegramError, pushError });
});
