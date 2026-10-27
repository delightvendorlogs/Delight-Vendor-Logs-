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
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",applyBranding);else applyBranding();
})();