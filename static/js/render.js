function renderMarkdown(node, text) {
  // Escape-first: every write is textContent, so model/tool output can never inject HTML.
  node.textContent = "";
  var parts = String(text == null ? "" : text).split(/```/);
  parts.forEach(function (chunk, i) {
    if (i % 2 === 1) {
      var pre = document.createElement("pre"), code = document.createElement("code");
      var nl = chunk.indexOf("\n");
      code.textContent = nl >= 0 ? chunk.slice(nl + 1) : chunk;
      pre.appendChild(code); node.appendChild(pre);
      return;
    }
    chunk.split("\n").forEach(function (line, li) {
      if (li) node.appendChild(document.createElement("br"));
      var h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        var el = document.createElement("strong");
        el.textContent = h[2]; node.appendChild(el); return;
      }
      var re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g, last = 0, m;
      while ((m = re.exec(line)) !== null) {
        if (m.index > last) node.appendChild(document.createTextNode(line.slice(last, m.index)));
        var tok = m[0];
        if (tok.slice(0, 2) === "**") { var b = document.createElement("strong"); b.textContent = tok.slice(2, -2); node.appendChild(b); }
        else if (tok.charAt(0) === "`") { var c = document.createElement("code"); c.textContent = tok.slice(1, -1); node.appendChild(c); }
        else { var em = document.createElement("em"); em.textContent = tok.slice(1, -1); node.appendChild(em); }
        last = m.index + tok.length;
      }
      if (last < line.length) node.appendChild(document.createTextNode(line.slice(last)));
    });
  });
}

function hideWelcome() { var w = $("welcome"); if (w && w.parentNode) w.parentNode.removeChild(w); }

function addMsg(role, text, meta) {
  hideWelcome();
  var wrap = document.createElement("div");
  wrap.className = "msg " + role;
  var m = document.createElement("div");
  m.className = "meta";
  if (role === "user") m.textContent = (meta && meta.steer) ? "You \u00b7 steer" : "You";
  else if (role === "error") m.textContent = "Error";
  else if (role === "system") m.textContent = "";
  else { var t = document.createElement("span"); t.textContent = "Hermes" + (meta && meta.ts ? " \u00b7 " + fmtTime(meta.ts) : ""); m.appendChild(t); }
  var bubble = document.createElement("div");
  bubble.className = "bubble";
  renderMarkdown(bubble, text || "");
  if (meta && meta.images && meta.images.length) {
    var row = document.createElement("div");
    row.className = "msg-img-row";
    meta.images.forEach(function (url) {
      var img = document.createElement("img");
      img.src = url; img.className = "msg-img"; img.alt = "Attached image";
      img.addEventListener("click", function () { openLightbox(url); });
      row.appendChild(img);
    });
    bubble.appendChild(row);
  }
  wrap.appendChild(m);
  wrap.appendChild(bubble);
  threadInner.appendChild(wrap);
  scrollDown();
  return { wrap: wrap, bubble: bubble, metaEl: m };
}

function _toolDur(ms) {
  if (ms == null || isNaN(ms)) return "";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
}

// One collapsible row per tool call, rendered IN the conversation under the call it
// belongs to -- CLI-style: the full arguments and the full output are inline and
// visible by default, and the header collapses them. Created on tool.started and
// updated IN PLACE on completion, so a call is a single row rather than a started
// line plus a separate done line. A completion matches the oldest still-running row
// with the same tool name, because the stream carries no call id.
function _toolDetail(rec) {
  if (rec.detail) return rec.detail;
  rec.detail = document.createElement("div");
  rec.detail.className = "tool-detail";
  rec.secs = {};
  rec.row.appendChild(rec.detail);
  if (rec.chev) rec.chev.textContent = "\u25BE";   // expanded
  return rec.detail;
}

function _toolSet(rec, key, label, text) {
  if (text == null || text === "") return;
  _toolDetail(rec);
  if (!rec.secs[key]) {
    var sec = document.createElement("div");
    sec.className = "tool-sec";
    var lbl = document.createElement("div");
    lbl.className = "tool-lbl";
    lbl.textContent = label;
    var pre = document.createElement("pre");
    sec.appendChild(lbl); sec.appendChild(pre);
    rec.detail.appendChild(sec);
    rec.secs[key] = pre;
  }
  rec.secs[key].textContent = String(text);
}

function _toolToggle(rec) {
  if (!rec.detail) return;
  var open = rec.detail.hidden;
  rec.detail.hidden = !open;
  rec.row.classList.toggle("collapsed", !open);
  if (rec.chev) rec.chev.textContent = open ? "\u25BE" : "\u25B8";
}

function addToolLine(turn, name, preview, args) {
  var lv = turn ? turn.live : live;
  if (!lv) return null;
  var row = document.createElement("div");
  row.className = "tool-line running";
  var head = document.createElement("div");
  head.className = "tool-head";
  var glyph = document.createElement("span");
  glyph.className = "tool-glyph"; glyph.textContent = "\u2699";
  var label = document.createElement("span");
  label.className = "tool-name"; label.textContent = name;
  var prev = document.createElement("span");
  prev.className = "tool-prev"; prev.textContent = preview ? String(preview) : "";
  var meta = document.createElement("span");
  meta.className = "tool-meta";
  var chev = document.createElement("span");
  chev.className = "tool-chev";
  head.appendChild(glyph); head.appendChild(label); head.appendChild(prev);
  head.appendChild(meta); head.appendChild(chev);
  row.appendChild(head);
  var rec = { row: row, name: name, glyph: glyph, prev: prev, meta: meta, chev: chev,
              detail: null, secs: null, t0: Date.now(), timer: null };
  if (args != null) _toolSet(rec, "args", "arguments", JSON.stringify(args, null, 2));
  head.addEventListener("click", function () { _toolToggle(rec); });
  rec.timer = setInterval(function () {
    meta.textContent = _toolDur(Date.now() - rec.t0);
  }, 500);
  if (!lv.pending) lv.pending = [];
  lv.pending.push(rec);
  lv.tools.appendChild(row);
  if (!turn || turn.sid === sessionId) scrollDown();
  return rec;
}

// The terminal tool returns a JSON envelope ({"output": ..., "exit_code": ...,
// "error": ...}). The CLI prints the output itself, so mirror that rather than
// dumping escaped JSON. Only unwrap the exact envelope shape -- anything with extra
// keys is shown raw so nothing is silently dropped.
function _toolOutputText(raw) {
  if (typeof raw !== "string") return raw;
  var t = raw.trim();
  if (t.charAt(0) !== "{") return raw;
  var d;
  try { d = JSON.parse(t); } catch (e) { return raw; }
  if (!d || typeof d !== "object" || typeof d.output !== "string") return raw;
  var keys = Object.keys(d).sort().join(",");
  if (keys !== "error,exit_code,output") return raw;
  var extra = [];
  if (d.exit_code != null && d.exit_code !== 0) extra.push("exit code: " + d.exit_code);
  if (d.error) extra.push("error: " + d.error);
  return d.output + (extra.length ? "\n\n[" + extra.join(" \u00b7 ") + "]" : "");
}

function completeToolLine(turn, name, ok, duration, resultPreview, preview) {
  var lv = turn ? turn.live : live;
  if (!lv || !lv.pending) return null;
  for (var i = 0; i < lv.pending.length; i++) {
    var rec = lv.pending[i];
    if (rec.name !== name) continue;
    lv.pending.splice(i, 1);
    if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
    var ms = (duration != null && !isNaN(duration)) ? Math.round(duration * 1000)
                                                   : (Date.now() - rec.t0);
    rec.row.classList.remove("running");
    rec.row.classList.add(ok ? "ok" : "err");
    rec.glyph.textContent = ok ? "\u2713" : "\u2717";
    rec.meta.textContent = _toolDur(ms);
    if (preview) rec.prev.textContent = String(preview);
    _toolSet(rec, "output", ok ? "output" : "error",
             _toolOutputText((resultPreview != null && resultPreview !== "") ? resultPreview : preview));
    if (!turn || turn.sid === sessionId) scrollDown();
    return rec;
  }
  return null;
}

function startLive(turn) {
  var wrap = document.createElement("div");
  wrap.className = "msg assistant";
  var m = document.createElement("div"); m.className = "meta";
  var t = document.createElement("span"); t.textContent = "Hermes \u00b7 " + fmtTime(Date.now() / 1000);
  m.appendChild(t);
  var tools = document.createElement("div"); tools.className = "tools";
  var bubble = document.createElement("div");
  bubble.className = "bubble caret";
  wrap.appendChild(m); wrap.appendChild(tools); wrap.appendChild(bubble);
  var lv = { wrap: wrap, bubble: bubble, tools: tools, text: "" };
  if (turn) turn.live = lv;
  // Only the chat on screen paints. A turn whose chat the user has switched away
  // from keeps its node in memory (turn.live.wrap) with no parent; loadSession
  // re-attaches it if they come back before the reply lands.
  if (!turn || turn.sid === sessionId) {
    hideWelcome();
    threadInner.appendChild(wrap);
    live = lv;
    scrollDown(true);
  }
  return lv;
}
function updateLive(turn) {
  var lv = turn ? turn.live : live;
  if (!lv) return;
  renderMarkdown(lv.bubble, lv.text);
  if (!turn || turn.sid === sessionId) scrollDown();
}
function finishLive(turn) {
  var lv = turn ? turn.live : live;
  if (!lv) return;
  // A turn that ends without a completion event would otherwise leave a row's
  // elapsed-time interval running forever.
  if (lv.pending) {
    lv.pending.forEach(function (rec) { if (rec.timer) clearInterval(rec.timer); rec.timer = null; });
    lv.pending = [];
  }
  lv.bubble.classList.remove("caret");
  if (!lv.text) { if (lv.wrap.parentNode) lv.wrap.parentNode.removeChild(lv.wrap); }
  else { addControls(lv.wrap, "assistant"); }
  if (!turn || turn.sid === sessionId) live = null;
}

function bubbleText(wrap) { var b = wrap.querySelector(".bubble"); return b ? b.innerText : ""; }

function addControls(wrap, role) {
  if (wrap.querySelector(".controls")) return;
  var box = document.createElement("div");
  box.className = "controls";
  function btn(label, title, fn) {
    var b = document.createElement("button");
    b.className = "ctl"; b.title = title; b.textContent = label;
    b.addEventListener("click", fn);
    box.appendChild(b); return b;
  }
  if (role === "assistant") {
    btn("Copy", "Copy message", function () { copyText(bubbleText(wrap)); });
    btn("Retry", "Regenerate this response", regenerate);
  } else {
    btn("Copy", "Copy message", function () { copyText(bubbleText(wrap)); });
    btn("Edit", "Edit and resend", function () { startEdit(wrap); });
  }
  wrap.appendChild(box);
}
