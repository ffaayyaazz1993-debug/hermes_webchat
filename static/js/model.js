// Model switcher — dropdown in the topbar.
// Fetches /webchat/models, shows current + available, POSTs /webchat/model on pick.
var _modelList = null;

function modelCurrent() {
  if (!_modelList) return null;
  return _modelList.current || "unknown";
}

function modelLabel() {
  if (!_modelList) return "model";
  var c = _modelList.current || "unknown";
  var p = _modelList.provider ? " · " + _modelList.provider : "";
  return c + p;
}

function modelOpen() {
  var btn = $("modelBtn");
  if (!btn) return;
  if (!_modelList) {
    // Show loading immediately, then render when fetch completes
    var menu = $("modelMenu");
    if (menu) {
      menu.innerHTML = '<div class="mm-head">model</div><div class="mm-item" style="color:var(--muted)">Loading…</div>';
      menu.classList.add("open");
    }
    modelFetch().then(function () {
      modelRenderMenu();
    }, function () {
      modelRenderMenu();
    });
    return;
  }
  modelRenderMenu();
}

function modelFetch() {
  return apiJSON("/webchat/models").then(function (d) {
    _modelList = d;
    var lbl = $("modelLabel");
    if (lbl) lbl.textContent = modelLabel();
    return d;
  }).catch(function (e) {
    _modelList = { error: e.message || "fetch failed" };
    var lbl = $("modelLabel");
    if (lbl) lbl.textContent = "model";
    return _modelList;
  });
}

function modelRenderMenu() {
  var menu = $("modelMenu");
  if (!menu) return;
  var d = _modelList;

  if (d && d.error) {
    menu.innerHTML = '<div class="mm-head">model</div><div class="mm-item" style="color:var(--err,#f87171)">Could not load models: ' + esc(d.error) + '</div>';
    menu.classList.add("open");
    return;
  }

  var ids = (d && d.model_ids) || [];
  var provs = (d && d.providers) || [];
  var cur = (d && d.current) || "";

  var html = "";
  html += '<div class="mm-head">model <span class="mm-cur">' + esc(cur) + '</span></div>';
  if (provs.length) {
    html += '<div class="mm-sec">providers</div>';
    provs.forEach(function (p) {
      html += '<div class="mm-item" data-provider="' + esc(p.provider) + '">'
        + '<span class="mm-dot' + (p.provider === d.provider ? " on" : "") + '"></span>'
        + esc(p.provider) + ' <span class="mm-n">' + p.count + '</span></div>';
    });
  }
  if (ids.length) {
    html += '<div class="mm-sec">models</div>';
    ids.forEach(function (m) {
      html += '<div class="mm-item' + (m === cur ? " cur" : "") + '" data-model="' + esc(m) + '">'
        + '<span class="mm-dot' + (m === cur ? " on" : "") + '"></span>'
        + esc(m) + '</div>';
    });
  }
  html += '<div class="mm-sec">usage</div>';
  html += '<div class="mm-help">/model &lt;name&gt; · /model &lt;name&gt; --save</div>';
  html += '<div class="mm-help">/model &lt;name&gt; --provider &lt;slug&gt;</div>';

  menu.innerHTML = html;
  menu.classList.add("open");

  // Click handlers
  menu.querySelectorAll(".mm-item").forEach(function (el) {
    el.addEventListener("click", function () {
      var m = el.getAttribute("data-model");
      var p = el.getAttribute("data-provider");
      modelSwitch(m, p);
    });
  });
}

function modelSwitch(name, provider) {
  if (!name && !provider) return;
  var body = { model: name || "", provider: provider || "", persist: false };
  // Use fetch with timeout — the /webchat/model endpoint can hang on provider catalog probes
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 10000);
  fetch("/webchat/model", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + KEY },
    body: JSON.stringify(body),
    signal: ctrl.signal
  }).then(function (r) { return r.json(); }).then(function (d) {
    clearTimeout(timer);
    if (!d.ok) { toast("model switch failed: " + (d.error || "unknown")); return; }
    _modelList = null;
    modelFetch();
    var line = "model: " + d.model + (d.provider ? " (" + (d.provider_label || d.provider) + ")" : "");
    if (d.context_length) line += "  ctx " + Number(d.context_length).toLocaleString();
    line += d.persisted ? "  [saved]" : "  [session]";
    toast(line);
    refreshStats();
  }).catch(function (e) {
    toast("model switch failed: " + e.message);
  });
}

function modelClose() {
  var menu = $("modelMenu");
  if (menu) menu.classList.remove("open");
}

function modelToggle() {
  var menu = $("modelMenu");
  if (menu && menu.classList.contains("open")) modelClose();
  else modelOpen();
}

// Close on outside click
document.addEventListener("click", function (e) {
  var menu = $("modelMenu");
  var btn = $("modelBtn");
  if (!menu || !btn) return;
  if (!menu.contains(e.target) && !btn.contains(e.target)) modelClose();
});

function modelInit() {
  var btn = $("modelBtn");
  if (btn) btn.addEventListener("click", function (e) { e.stopPropagation(); modelToggle(); });
  modelFetch();
}
