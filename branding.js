
/* ==========================================
   DELIGHT VENDOR LOGS
   Shared Website Branding Configuration
   ========================================== */

window.SITE_BRANDING = {
  name: "Delight Vendor Logs",

  // Main logo used in your website HTML
  logo: "/assets/dv-logo.png",

  // Browser tab icon
  favicon: "/assets/favicon.png",

  // Image shown when your website link is shared
  socialImage: "/assets/social-share.png",

  // Social-sharing image dimensions
  socialImageWidth: 1200,
  socialImageHeight: 630
};

/* Apply shared logo and brand name */
document.addEventListener("DOMContentLoaded", function () {
  const branding = window.SITE_BRANDING;

  // Display the logo wherever data-brand-logo is used
  document.querySelectorAll("[data-brand-logo]").forEach(function (img) {
    img.src = branding.logo;
    img.alt = branding.name + " logo";
  });

  // Display the brand name wherever data-brand-name is used
  document.querySelectorAll("[data-brand-name]").forEach(function (element) {
    element.textContent = branding.name;
  });
});

