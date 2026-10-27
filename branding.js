/* Shared Delight Vendor Logs branding — use the original DV asset. */
(function(){
  const logoPath = "assets/dv-logo.png";
  window.SITE_BRANDING = { name: "Delight Vendor Logs", logo: logoPath };
  function applyBranding(){
    document.querySelectorAll("link[rel~='icon'],link[rel='apple-touch-icon']").forEach(function(link){link.href=logoPath;});
    if(!document.querySelector("link[rel~='icon']")){
      const icon=document.createElement("link");icon.rel="icon";icon.type="image/png";icon.href=logoPath;document.head.appendChild(icon);
    }
    document.querySelectorAll("[data-brand-logo]").forEach(function(img){img.src=logoPath;img.alt="Delight Vendor Logs logo";});
    document.querySelectorAll("[data-brand-name]").forEach(function(el){el.textContent=window.SITE_BRANDING.name;});
    document.querySelectorAll("h1,h2,.brand-name").forEach(function(el){
      const label=(el.textContent||"").trim();
      if(!/^(Delight Vendor Logs|Delight Vendor Logs\s*[—-].*)$/i.test(label)) return;
      if(el.querySelector("img")) return;
      const img=document.createElement("img");img.src=logoPath;img.alt="";img.setAttribute("data-auto-brand-logo","true");
      img.style.cssText="width:1.45em;height:1.45em;object-fit:contain;vertical-align:middle;margin-right:.45em;display:inline-block";
      el.insertBefore(img,el.firstChild);
    });
  }

  function setupNotificationBadge(){
    const bell=document.querySelector(".notification-btn");
    if(!bell||!window.supabase||bell.querySelector(".notification-badge"))return;
    const badge=document.createElement("span");badge.className="notification-badge";badge.style.cssText="position:absolute;top:-7px;right:-7px;min-width:20px;height:20px;padding:0 5px;display:none;align-items:center;justify-content:center;border-radius:12px;background:#e53935;color:#fff;border:2px solid #080808;font:800 11px Arial";bell.style.position="relative";bell.appendChild(badge);
    const sb=window.supabase.createClient("https://hkfhehbhmucymusaytoe.supabase.co","sb_publishable_O-aPnRtG3EZ6-Lwo8_sRuw_ZQqSQSF_");
    async function refresh(){try{const s=await sb.auth.getSession();if(!s.data.session)return;const r=await sb.functions.invoke("delight-notifications",{body:{action:"list"}});if(r.error||!r.data||r.data.error)return;const count=(r.data.notifications||[]).filter(n=>!n.read_at).length;badge.textContent=count>99?"99+":String(count);badge.style.display=count?"flex":"none";bell.setAttribute("aria-label",count+" unread notifications");}catch(e){}}refresh();window.setInterval(refresh,30000);
  }
  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",applyBranding);document.addEventListener("DOMContentLoaded",setupNotificationBadge);}else{applyBranding();setupNotificationBadge();}
})();