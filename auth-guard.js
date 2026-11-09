(function () {
  "use strict";

  var root = document.documentElement;
  var loaderStyle = document.createElement("style");
  loaderStyle.id = "dv-auth-loader-style";
  loaderStyle.textContent = "body{visibility:hidden!important}#dvAuthLoader{position:fixed;inset:0;z-index:2147483646;display:grid;place-content:center;gap:18px;padding:24px;background:linear-gradient(145deg,rgba(5,5,5,.97),rgba(19,17,12,.96));color:#f6f0df;text-align:center;font:13px/1.5 system-ui,sans-serif}#dvAuthLoader .dv-auth-brand{display:flex;align-items:center;justify-content:center;gap:10px;font-weight:700;letter-spacing:.2px}#dvAuthLoader img{width:34px;height:34px;object-fit:contain;animation:dvAuthPulse 1.1s ease-in-out infinite}#dvAuthLoader .dv-auth-copy{color:#cfc4a6;font-size:12px}#dvAuthLoader .dv-auth-track{width:min(220px,62vw);height:3px;margin:0 auto;overflow:hidden;border-radius:99px;background:#ffffff20}#dvAuthLoader .dv-auth-track:after{content:'';display:block;width:38%;height:100%;border-radius:99px;background:linear-gradient(90deg,#8f6b25,#f0d48b,#8f6b25);animation:dvAuthProgress 1.25s ease-in-out infinite}#dvAuthLoader .dv-auth-skeletons{display:grid;gap:7px;width:min(250px,70vw);margin:0 auto}#dvAuthLoader .dv-auth-skeletons i{display:block;height:7px;border-radius:9px;background:linear-gradient(90deg,#ffffff0b 20%,#ffffff20 48%,#ffffff0b 76%);background-size:220% 100%;animation:dvAuthShimmer 1.35s linear infinite}#dvAuthLoader .dv-auth-skeletons i:nth-child(2){width:78%;margin:auto}#dvAuthLoader .dv-auth-skeletons i:nth-child(3){width:55%;margin:auto}@keyframes dvAuthPulse{0%,100%{transform:scale(.88);opacity:.78}50%{transform:scale(1.08);opacity:1}}@keyframes dvAuthProgress{0%{transform:translateX(-120%)}100%{transform:translateX(360%)}}@keyframes dvAuthShimmer{to{background-position:-220% 0}}@media(prefers-reduced-motion:reduce){#dvAuthLoader *{animation:none!important}}#dvNavProgress{position:fixed;top:0;left:0;z-index:2147483647;height:3px;width:100%;pointer-events:none;opacity:0;transition:opacity .15s}#dvNavProgress:after{content:'';display:block;width:34%;height:100%;background:linear-gradient(90deg,transparent,#e3bd64,#fff0b8);box-shadow:0 0 9px #d8ad4d;transform:translateX(-120%)}#dvNavProgress.active{opacity:1}#dvNavProgress.active:after{animation:dvNavSweep .9s ease-in-out infinite}@keyframes dvNavSweep{to{transform:translateX(360%)}}";
  document.head.appendChild(loaderStyle);
  var authLoader = document.createElement("div");
  authLoader.id = "dvAuthLoader";
  authLoader.setAttribute("role","status");
  authLoader.setAttribute("aria-live","polite");
  authLoader.innerHTML = '<div class="dv-auth-brand"><img src="assets/dv-logo.png" alt=""><span>Delight Vendor Logs</span></div><div class="dv-auth-copy">Preparing your account…</div><div class="dv-auth-track"></div><div class="dv-auth-skeletons" aria-hidden="true"><i></i><i></i><i></i></div>';
  root.appendChild(authLoader);
  var navProgress = document.createElement("div");
  navProgress.id = "dvNavProgress";
  root.appendChild(navProgress);
  function finishAuthLoading(){
    if(authLoader.parentNode) authLoader.parentNode.removeChild(authLoader);
    if(loaderStyle.parentNode) loaderStyle.parentNode.removeChild(loaderStyle);
  }
  function startNavigationProgress(){
    navProgress.classList.add("active");
  }
  document.addEventListener("click",function(event){
    var link=event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if(!link || event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target==="_blank" || link.hasAttribute("download")) return;
    try{
      var destination=new URL(link.href,location.href);
      if(destination.origin!==location.origin) return;
      if(destination.pathname===location.pathname && destination.search===location.search && destination.hash) return;
      startNavigationProgress();
    }catch(_){}
  },true);
  window.addEventListener("beforeunload",startNavigationProgress);

  var base = new URL("./", location.href);
  var SUPABASE_URL = "https://hkfhehbhmucymusaytoe.supabase.co";
  var SUPABASE_KEY = "sb_publishable_O-aPnRtG3EZ6-Lwo8_sRuw_ZQqSQSF_";

  function goToLogin() {
    var target = location.pathname + location.search + location.hash;
    location.replace(new URL("login.html?redirect=" + encodeURIComponent(target), base).href);
  }

  function networkError(error) {
    var message = String(error && (error.message || error) || "").toLowerCase();
    return error instanceof TypeError ||
      message.includes("failed to fetch") ||
      message.includes("load failed") ||
      message.includes("networkerror") ||
      message.includes("network request failed") ||
      message.includes("fetch failed") ||
      message.includes("timeout");
  }

  async function loadSdk() {
    if (window.supabase && window.supabase.createClient) return;
    var urls = [
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
      "https://unpkg.com/@supabase/supabase-js@2"
    ];
    var lastError;
    for (var i = 0; i < urls.length; i++) {
      try {
        await new Promise(function (resolve, reject) {
          var script = document.createElement("script");
          script.src = urls[i];
          script.onload = resolve;
          script.onerror = function () { reject(new Error("Supabase SDK could not be loaded")); };
          document.head.appendChild(script);
        });
        if (window.supabase && window.supabase.createClient) return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Sign-in service unavailable");
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error("Authentication request timed out")); }, ms);
      })
    ]);
  }

  async function boot() {
    try {
      try {
        var legacy = localStorage.getItem("dv-auth");
        var key = "sb-hkfhehbhmucymusaytoe-auth-token";
        if (!localStorage.getItem(key) && legacy) localStorage.setItem(key, legacy);
      } catch (_) {}

      await loadSdk();
      var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });

      var sessionResult = await withTimeout(client.auth.getSession(), 12000);
      var session = sessionResult && sessionResult.data && sessionResult.data.session;
      if (!session) {
        goToLogin();
        return;
      }

      try {
        var userResult = await withTimeout(client.auth.getUser(), 12000);
        if (userResult.error || !userResult.data || !userResult.data.user) {
          if (userResult.error && (userResult.error.status === 401 || userResult.error.status === 403)) {
            await client.auth.signOut({ scope: "local" });
            goToLogin();
            return;
          }
          if (!networkError(userResult.error)) {
            goToLogin();
            return;
          }
        }
      } catch (error) {
        if (!networkError(error)) {
          goToLogin();
          return;
        }
        // A valid, unexpired locally stored session is retained during a temporary network outage.
        if (session.expires_at && session.expires_at * 1000 <= Date.now()) {
          goToLogin();
          return;
        }
      }

      finishAuthLoading();
      client.auth.onAuthStateChange(function (event, nextSession) {
        if (event === "SIGNED_OUT" || (event === "INITIAL_SESSION" && !nextSession)) {
          goToLogin();
        }
      });
    } catch (error) {
      console.error("Authentication guard error:", error);
      goToLogin();
    }
  }

  boot();
})();