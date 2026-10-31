(() => {
  "use strict";
  const page = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  const excluded = new Set(["index.html", "login.html", "register.html", "forgot-password.html"]);
  if (excluded.has(page)) return;

  const SUPABASE_URL = "https://hkfhehbhmucymusaytoe.supabase.co";
  const SUPABASE_KEY = "sb_publishable_O-aPnRtG3EZ6-Lwo8_sRuw_ZQqSQSF_";

  const style = document.createElement("style");
  style.textContent = `
    #dv-site-announcement{position:relative;z-index:1000;width:100%;overflow:hidden;background:linear-gradient(90deg,#171105,#2a2109,#171105);color:#f5d979;border-bottom:1px solid rgba(212,175,55,.55);box-shadow:0 3px 12px #0003;font:700 13px/1.45 Arial,Helvetica,sans-serif}
    #dv-site-announcement .dv-announcement-track{display:flex;width:max-content;min-width:100%;align-items:center;animation:dv-announcement-scroll var(--dv-announcement-duration,28s) linear infinite}
    #dv-site-announcement .dv-announcement-item{display:block;flex:0 0 auto;padding:9px 44px;white-space:pre;line-height:1.5}
    #dv-site-announcement a{color:#79baff;text-decoration:underline;text-underline-offset:2px}
    #dv-site-announcement:hover .dv-announcement-track{animation-play-state:paused}
    @keyframes dv-announcement-scroll{from{transform:translateX(100vw)}to{transform:translateX(-100%)}}
    @media(prefers-reduced-motion:reduce){#dv-site-announcement .dv-announcement-track{animation:none;transform:none;white-space:normal;width:100%}#dv-site-announcement .dv-announcement-item{white-space:pre-wrap}}
  `;
  document.head.appendChild(style);

  function linkedText(container, text) {
    const pattern = /https?:\/\/[^\s<>"']+/gi;
    let last = 0, match;
    while ((match = pattern.exec(text))) {
      container.append(document.createTextNode(text.slice(last, match.index)));
      let url = match[0], trailing = "";
      while (/[),.!?;:]+$/.test(url)) { trailing = url.slice(-1) + trailing; url = url.slice(0, -1); }
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          const a = document.createElement("a");
          a.href = parsed.href; a.textContent = "Click here"; a.target = "_blank"; a.rel = "noopener noreferrer";
          container.append(a);
        } else container.append(document.createTextNode(url));
      } catch (_) { container.append(document.createTextNode(url)); }
      if (trailing) container.append(document.createTextNode(trailing));
      last = match.index + match[0].length;
    }
    container.append(document.createTextNode(text.slice(last)));
  }

  async function load() {
    try {
      if (!window.supabase?.createClient) {
        await new Promise((resolve, reject) => {
          const loader = document.createElement("script");
          loader.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
          loader.onload = resolve;
          loader.onerror = () => reject(new Error("Could not load the announcement service"));
          document.head.appendChild(loader);
        });
      }
      if (!window.supabase?.createClient) throw new Error("Announcement service is unavailable");
      const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      const { data, error } = await db.from("site_announcement").select("message,enabled").eq("id", true).maybeSingle();
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.enabled || !String(row.message || "").trim()) return;
      const bar = document.createElement("div");
      bar.id = "dv-site-announcement";
      bar.setAttribute("role", "region");
      bar.setAttribute("aria-label", "Site announcement");
      const track = document.createElement("div");
      track.className = "dv-announcement-track";
      const item = document.createElement("div");
      item.className = "dv-announcement-item";
      linkedText(item, String(row.message));
      const duplicate = item.cloneNode(true);
      track.append(item, duplicate);
      track.style.setProperty("--dv-announcement-duration", Math.max(18, Math.min(65, String(row.message).length * 0.22)) + "s");
      bar.append(track);
      document.body.insertBefore(bar, document.body.firstChild);
    } catch (error) {
      console.warn("Site announcement could not be loaded:", error?.message || error);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load, { once: true });
  else load();
})();