/* ==========================================
DELIGHT VENDOR LOGS
Shared Website Branding Configuration
========================================== */

window.SITE_BRANDING = {
name: "Delight Vendor Logs",
logo: "./assets/dv-logo.png"
};

/* Apply shared logo and brand name */
document.addEventListener("DOMContentLoaded", function () {
const branding = window.SITE_BRANDING;

document.querySelectorAll("[data-brand-logo]").forEach(function (img) {
img.src = branding.logo;
img.alt = branding.name + " logo";
});

document.querySelectorAll("[data-brand-name]").forEach(function (element) {
element.textContent = branding.name;
});
});
