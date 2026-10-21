/* ==========================================
DELIGHT VENDOR LOGS
Shared Website Branding Configuration
========================================== */

window.SITE_BRANDING = {
name: "Delight Vendor Logs",
logo: "https://raw.githubusercontent.com/delightvendorlogs/Delight-Vendor-Logs-/main/assets/dv-logo.png"
};

document.addEventListener("DOMContentLoaded", function () {
const branding = window.SITE_BRANDING;

document.querySelectorAll("[data-brand-logo]").forEach(function (img) {
img.src = branding.logo;
img.alt = "";
});

document.querySelectorAll("[data-brand-name]").forEach(function (element) {
element.textContent = branding.name;
});
});
