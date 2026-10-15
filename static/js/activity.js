// Activity panel — CLI-grade live turn structure.
// Built from SSE events the stream carries:
//   tool.started / tool.completed / tool.failed / tool.progress(_thinking) /
//   assistant.delta / assistant.commentary / assistant.completed / run.completed
//
// The API stream has no depth/parent/tool_call_id, so nested calls are not
// recoverable; parallel batches are inferred from consecutive starts with no
// completion between them (labelled as inferred in the UI).
var ACT = null;
var _actTimer = null;

function actNewTurn() {
  return { t0: Date.now(), nodes: [], apiCalls: 0, done: false, expanded: true, detail: null };
}
function act() {
  if (!ACT) ACT = actNewTurn();
  return ACT;
}
function actReset() { ACT = null; _renderAct(); _startActTimer(); }

function _fmtMs(ms) {
  if (ms == null) return "";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
}

// Match a completion to the oldest still-running call with the same tool name.
function actComplete(name, ok, duration, resultPreview) {
  var a = act();
  for (var i = a.nodes.length - 1; i >= 0; i--) {
    var n = a.nodes[i];
    if (n.kind === "tool" && n.name === name && n.status === "running") {
      n.ms = (duration != null && !isNaN(duration)) ? Math.round(duration * 1000) : (Date.now() - n.t0);
      n.status = ok ? "ok" : "err";
      if (resultPreview) {
        n.result = resultPreview;
        var base = n.detail ? String(n.detail) : "";
        n.detail = base + (base ? "\n\nOutput:\n" : "Output:\n") + resultPreview;
        n.preview = String(resultPreview).replace(/\s+/g, " ").slice(0, 160);
      }
      _renderAct();
      return;
    }
  }
}

function actAdd(node) {
  var a = act();
  node.t0 = Date.now();
  node.tokens = 0;
  node.status = node.status || "running";
  a.nodes.push(node);
  _renderAct();
  _scrollAct();
  return node;
}

// ── Timer: repaint running rows every 500ms so elapsed times stay live ──────
function _startActTimer() {
  if (_actTimer) clearInterval(_actTimer);
  _actTimer = setInterval(function () {
    if (!ACT || !ACT.nodes.length) { clearInterval(_actTimer); _actTimer = null; return; }
    var anyRunning = ACT.nodes.some(function (n) { return n.status === "running"; });
    if (!anyRunning) { clearInterval(_actTimer); _actTimer = null; return; }
    _renderAct();
  }, 500);
}

function _scrollAct() {
  var body = $("actBody");
  if (body) body.scrollTop = body.scrollHeight;
}

function _nodeGlyph(n) {
  if (n.kind === "tool") {
    if (n.status === "ok") return "\u2713";
    if (n.status === "err") return "\u2717";
    return "\u2699";
  }
  if (n.kind === "think") return "\U0001F4AD";
  if (n.kind === "output") return "\u25B2";
  if (n.kind === "note") return "\u25CE";
  return "\u25CB";
}

function _nodeColor(n) {
  if (n.kind === "tool") {
    if (n.status === "ok") return "var(--ok, #4ade80)";
    if (n.status === "err") return "var(--err, #f87171)";
    return "var(--run, var(--accent))";
  }
  if (n.kind === "think") return "var(--muted)";
  if (n.kind === "output") return "var(--accent)";
  return "var(--muted)";
}

function _actRow(n) {
  var row = document.createElement("div");
  row.className = "act-row-main";
  var glyph = _nodeGlyph(n);
  var color = _nodeColor(n);
  var label = esc(n.name || "?");
  var preview = esc(n.preview || "");

  var msDisplay = "";
  if (n.status === "running") {
    msDisplay = '<span class="act-live">\u25CF</span> ' + _fmtMs(Date.now() - n.t0);
  } else if (n.ms != null) {
    msDisplay = _fmtMs(n.ms);
  }

  var tokDisplay = "";
  if (n.tokens > 0) tokDisplay = " \u2191" + n.tokens + " tok";

  row.innerHTML =
    '<span class="act-glyph" style="color:' + color + '">' + glyph + '</span>' +
    '<span class="act-name">' + label + '</span>' +
    (preview ? '<span class="act-prev">' + preview + '</span>' : '') +
    '<span class="act-meta">' + msDisplay + tokDisplay + '</span>' +
    (n.status === "running" ? '<span class="act-spinner"></span>' : '');

  row.addEventListener("click", function () {
    if (!n.detail) return;
    n.expanded = !n.expanded;
    var ex = row.nextElementSibling;
    if (n.expanded && ex && ex.className === "act-detail") return;
    if (!n.expanded) { if (ex && ex.className === "act-detail") ex.remove(); return; }
    var d = document.createElement("div");
    d.className = "act-detail";
    var pre = document.createElement("pre");
    pre.textContent = n.detail;
    d.appendChild(pre);
    row.parentNode.insertBefore(d, row.nextElementSibling);
  });
  return row;
}

function _renderAct() {
  var body = $("actBody"), cnt = $("actCount");
  var panel = $("actpanel");
  if (!body) return;

  if (!ACT || !ACT.nodes.length) {
    body.innerHTML = '<div class="act-empty">Send a message to watch Hermes work.</div>';
    if (cnt) cnt.textContent = "";
    return;
  }

  body.innerHTML = "";
  var a = ACT;
  var done = a.nodes.filter(function (n) { return n.kind === "tool"; }).length;
  if (cnt) cnt.textContent = done ? done + " steps" : "";

  var wrap = document.createElement("div");
  wrap.className = "act-turn";

  var hdr = document.createElement("div");
  hdr.className = "act-hdr";
  var totalMs = a.done ? (Date.now() - a.t0) : null;
  hdr.innerHTML =
    '<span class="act-hdr-toggle">' + (a.expanded ? "\u25BE" : "\u25B8") + '</span>' +
    '<span class="act-hdr-label">turn</span>' +
    '<span class="act-hdr-steps">' + a.nodes.length + ' steps' +
      (a.apiCalls ? ' \u00B7 ' + a.apiCalls + ' api' : '') +
    '</span>' +
    (totalMs != null
      ? '<span class="act-hdr-time">' + _fmtMs(totalMs) + '</span>'
      : '<span class="act-hdr-live">\u25CF live</span>');
  hdr.addEventListener("click", function () { a.expanded = !a.expanded; _renderAct(); });
  wrap.appendChild(hdr);

  if (a.expanded) {
    var i = 0;
    while (i < a.nodes.length) {
      var n = a.nodes[i];
      if (n.kind === "tool" && _isBatch(a, i)) {
        var batch = [], j = i;
        while (j < a.nodes.length && a.nodes[j].kind === "tool" && a.nodes[j].groupId === n.groupId) {
          batch.push(a.nodes[j]); j++;
        }
        var btag = document.createElement("div");
        btag.className = "act-batch";
        btag.textContent = "\u2295 " + batch.length + " parallel";
        wrap.appendChild(btag);
        var kids = document.createElement("div");
        kids.className = "act-kids";
        batch.forEach(function (b) { kids.appendChild(_actRow(b)); });
        wrap.appendChild(kids);
        i = j;
      } else {
        wrap.appendChild(_actRow(n));
        i++;
      }
    }
  }

  var foot = document.createElement("div");
  foot.className = "act-foot";
  var turnDur = a.done ? _fmtMs(Date.now() - a.t0) : _fmtMs(Date.now() - a.t0) + " so far";
  foot.innerHTML = '<span class="act-foot-time">\u23F1 ' + turnDur + '</span>' +
    (a.apiCalls ? '<span class="act-foot-api">\u25CC ' + a.apiCalls + ' api calls</span>' : '');
  wrap.appendChild(foot);

  body.appendChild(wrap);
}

function _isBatch(a, i) {
  var n = a.nodes[i], m = a.nodes[i + 1];
  if (!m || m.kind !== "tool") return false;
  if (n.status !== "running") return false;
  if (!n.groupId) {
    var g = 0;
    for (var k = 0; k < a.nodes.length; k++) if (a.nodes[k].groupId) g = Math.max(g, a.nodes[k].groupId);
    n.groupId = ++g;
    for (var j = i + 1; j < a.nodes.length && a.nodes[j].kind === "tool" && a.nodes[j].status === "running"; j++) {
      a.nodes[j].groupId = n.groupId;
    }
  }
  return true;
}

// ── Public API called from send.js ──────────────────────────────────────────

function activityReset() { actReset(); }

function activityToolStarted(name, preview, args) {
  actAdd({ kind: "tool", name: name, preview: preview, detail: args ? JSON.stringify(args, null, 1) : null, status: "running" });
}

function activityToolCompleted(name, ok, duration, resultPreview) {
  actComplete(name, ok, duration, resultPreview);
}

function activityThinking(delta) {
  var a = act();
  for (var i = a.nodes.length - 1; i >= 0; i--) {
    if (a.nodes[i].kind === "think" && a.nodes[i].status !== "ok") {
      a.nodes[i].text = (a.nodes[i].text || "") + delta;
      a.nodes[i].preview = a.nodes[i].text;
      a.nodes[i].detail = a.nodes[i].text;
      return;
    }
  }
  actAdd({ kind: "think", name: "thinking", text: delta, preview: delta, detail: delta, status: "running" });
}

function activityCommentary(text) {
  var a = act();
  for (var i = a.nodes.length - 1; i >= 0; i--) {
    if (a.nodes[i].kind === "note" && a.nodes[i].status !== "ok") {
      a.nodes[i].preview = text;
      a.nodes[i].detail = text;
      return;
    }
  }
  actAdd({ kind: "note", name: "commentary", preview: text, detail: text, status: "ok" });
}

function activityOutputStart() {
  actAdd({ kind: "output", name: "output", preview: "", detail: null, status: "running" });
}

function activityOutputDelta(delta) {
  var a = act();
  for (var i = a.nodes.length - 1; i >= 0; i--) {
    if (a.nodes[i].kind === "output" && a.nodes[i].status === "running") {
      a.nodes[i].text = (a.nodes[i].text || "") + delta;
      a.nodes[i].preview = a.nodes[i].text.slice(0, 160);
      a.nodes[i].tokens = (a.nodes[i].tokens || 0) + delta.split(/\s+/).filter(Boolean).length;
      return;
    }
  }
}

function activityOutputDone() {
  var a = act();
  for (var i = a.nodes.length - 1; i >= 0; i--) {
    if (a.nodes[i].kind === "output" && a.nodes[i].status === "running") {
      a.nodes[i].status = "ok";
      return;
    }
  }
  _renderAct();
}

function activityTurnDone() {
  if (ACT) ACT.done = true;
  _renderAct();
  _startActTimer();
}

function activityRender() { _renderAct(); }
