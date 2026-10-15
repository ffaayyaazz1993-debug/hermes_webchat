function capTable(data) {
  var w = document.createElement("div");
  w.className = "capwrap";
  var groups = (data && data.groups) || [];
  var nrows = groups.reduce(function (a, g) { return a + (g.rows || []).length; }, 0);
  var hd = document.createElement("div");
  hd.className = "hd";
  hd.innerHTML = '<span>Hermes capabilities</span>'
    + '<span class="n">' + nrows + " rows \u00b7 " + groups.length + " groups</span>";
  w.appendChild(hd);
  if (data && data.config_error) {
    var ce = document.createElement("div");
    ce.className = "caperr";
    ce.textContent = "config.yaml unreadable: " + data.config_error;
    w.appendChild(ce);
  }
  groups.forEach(function (g) {
    var grp = document.createElement("div");
    grp.className = "capgrp";
    var gh = document.createElement("div");
    gh.className = "gh";
    gh.textContent = g.title;
    grp.appendChild(gh);
    var rows = g.rows || [];
    if (!rows.length) {
      var em = document.createElement("div");
      em.className = "capempty";
      em.textContent = g.empty || "nothing configured";
      grp.appendChild(em);
    } else {
      var t = document.createElement("table");
      t.className = "cap";
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        var td1 = document.createElement("td"); td1.className = "f"; td1.textContent = r.field;
        var td2 = document.createElement("td"); td2.className = "v"; td2.textContent = r.value;
        tr.appendChild(td1); tr.appendChild(td2);
        if (r.note) {
          var td3 = document.createElement("td"); td3.className = "n"; td3.textContent = r.note;
          tr.appendChild(td3);
        } else if (rows.some(function (x) { return x.note; })) {
          var td4 = document.createElement("td"); td4.className = "n"; td4.textContent = "";
          tr.appendChild(td4);
        }
        t.appendChild(tr);
      });
      grp.appendChild(t);
    }
    w.appendChild(grp);
  });
  return w;
}

/* ---- /model ----------------------------------------------------------------
   `/model`            -> list the current model and every available one
   `/model <name>`     -> switch for this session
   `/model <name> --save` -> switch and persist to config.yaml (all sessions)
   `/model <name> --provider <slug>` -> switch provider too
   Nothing here spends a model turn. */
var MODELS = null;

function showModel(arg) {
  var persist = /(^|\s)--save(\s|$)/.test(arg);
  var provMatch = arg.match(/--provider\s+(\S+)/);
  var provider = provMatch ? provMatch[1] : "";
  var name = arg.replace(/--save/g, "").replace(/--provider\s+\S+/g, "").trim();

  if (!name && !provider) {
    showModelList(MODELS && MODELS.current ? MODELS : null);
    return;
  }
  apiJSON("/webchat/model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, provider: provider, persist: persist })
  }).then(function (d) {
    if (!d.ok) { addMsg("assistant", "model switch failed: " + (d.error || "unknown")); return; }
    MODELS = null;
    var line = "model: " + d.model + (d.provider ? "  (" + (d.provider_label || d.provider) + ")" : "");
    if (d.context_length) line += "  ctx " + Number(d.context_length).toLocaleString();
    line += d.persisted ? "  [saved to config.yaml]" : "  [this session only]";
    addMsg("assistant", line + (d.warning ? "\n\n" + d.warning : ""));
    refreshStats();
  }).catch(function (e) {
    addMsg("assistant", "model switch failed: " + e.message);
  });
}

async function showModelList(d) {
  var thread = $("thread");
  var wrap = document.createElement("div");
  wrap.className = "msg assistant";
  var bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.style.padding = "0";
  bubble.textContent = "Reading models\u2026";
  wrap.appendChild(bubble);
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  try {
    if (!d) {
      var r = await fetch("/webchat/models", {
        headers: { "Authorization": "Bearer " + KEY }, cache: "no-store"
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      d = await r.json();
      MODELS = d;
    }
    var box = document.createElement("div");
    box.className = "caps";
    box.innerHTML = modelTable(d);
    bubble.textContent = "";
    bubble.style.padding = "";
    bubble.appendChild(box);
  } catch (err) {
    // A failed catalog probe must not block a switch: the name can still be typed.
    bubble.textContent = "Could not load models: " + (err && err.message ? err.message : err) +
      " \u2014 type /model <name> to switch anyway";
  }
  thread.scrollTop = thread.scrollHeight;
}

function modelTable(d) {
  function row(k, v) {
    return '<div class="caprow"><span class="capk">' + k + '</span><span class="capv">' + v + "</span></div>";
  }
  var rows = [];
  rows.push(row("current", esc(d.current || "\u2014") +
    (d.provider ? "  \u00b7  " + esc(d.provider) : "") +
    (d.context_length ? "  \u00b7  ctx " + Number(d.context_length).toLocaleString() : "")));
  if (d.note) rows.push(row("note", esc(d.note)));
  var ids = d.model_ids || [];
  var provs = (d.providers || []).filter(function (p) { return p.count; });
  rows.push(row("available", ids.length + " model" + (ids.length === 1 ? "" : "s") +
    (provs.length ? "  \u00b7  " + provs.map(function (p) {
      return esc(p.provider) + " (" + p.count + ")"; }).join(", ") : "")));
  if (ids.length) {
    rows.push(row("pick", ids.slice(0, 80).map(function (m) { return esc(m); }).join("\u00b7")));
  }
  rows.push(row("usage", esc("/model <name>") + "  \u00b7  " + esc("/model <name> --save") +
    "  \u00b7  " + esc("/model <name> --provider <slug>")));
  return rows.join("");
}

async function showCapabilities() {
  var thread = $("thread");
  var wrap = document.createElement("div");
  wrap.className = "msg assistant";
  var bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.style.padding = "0";
  bubble.textContent = "Reading capabilities\u2026";
  wrap.appendChild(bubble);
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  try {
    var r = await fetch("/webchat/capabilities", {
      headers: { "Authorization": "Bearer " + KEY }, cache: "no-store"
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    var data = await r.json();
    bubble.textContent = "";
    bubble.style.padding = "";
    bubble.appendChild(capTable(data));
  } catch (err) {
    bubble.textContent = "Could not load capabilities: " + (err && err.message ? err.message : err);
  }
  thread.scrollTop = thread.scrollHeight;
}
