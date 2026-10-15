(function init() {
  var missing = ["thread", "thread-inner", "input", "send", "compress-btn", "sidebar", "sbList",
                 "newChat", "menuBtn", "themeBtn", "convTitle"]
    .filter(function (id) { return !document.getElementById(id); });
  if (missing.length) {
    document.body.innerHTML = '<p style="padding:20px;font:14px sans-serif;color:#ef4444">'
      + "UI missing element(s): " + missing.join(", ") + "</p>";
    return;
  }
  var theme = "dark", sb = "0";
  try { theme = localStorage.getItem("hermes_theme") || "dark"; sb = localStorage.getItem("hermes_sb") || "0"; } catch (e) {}
  setTheme(theme);
  if (sb === "1") document.body.classList.add("sidebar-collapsed");
  // Panel open state: an explicit choice wins; otherwise default ON for wide screens so
// the structure view is discoverable without hunting for the header button. Narrow
// screens leave it off -- there is no room beside the chat.
  var actPref = null;
  try { actPref = localStorage.getItem("hermes_act"); } catch (e) {}
  if (actPref === "1") $("actpanel").hidden = false;
  else if (actPref === null && window.innerWidth >= 1100) $("actpanel").hidden = false;
  if (window.matchMedia && window.matchMedia("(max-width: 860px)").matches) {
    document.body.classList.add("sidebar-collapsed");
  }
  autosize();
  loadThinking();   // prefetch faces/verbs so the first turn paints without delay
  loadSkills();     // same for the "/" palette: warm it at boot, not on first keystroke

  if (!KEY) {
    setStatus("no key", "err");
    addMsg("error", "No API key was injected by the server. Restart hermes_webchat to mint one.");
    return;
  }
  apiJSON("/v1/models").then(function (m) {
    $("sbModel").textContent = (m.data && m.data[0] && m.data[0].id) || MODEL;
  }, function () {});

  var stored = null;
  try { stored = sessionStorage.getItem(SESSION_KEY); } catch (e) {}
  var chain = stored ? loadSession(stored) : Promise.resolve();
  chain.then(function () {
    if (!sessionId) return newSession();
    return null;
  }).then(function () {
    return refreshSidebar();
  }).then(function () {
    setStatus("ready", "ok");
    input.focus();
  }, function (e) {
    setStatus("offline", "err");
    addMsg("error", "Cannot reach the Hermes server: " + ((e && e.message) || e));
  });
})();
