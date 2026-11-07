(function () {
  "use strict";

  var root = document.documentElement;
  root.style.visibility = "hidden";
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

      root.style.visibility = "";
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