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
  if (role === "user") m.textContent = "You";
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

function addToolLine(name, preview, failed) {
  if (!live) return;
  var row = document.createElement("div");
  row.className = "tool-line" + (failed ? " err" : "");
  row.textContent = (failed ? "\u2717 " : "\u2699 ") + name + (preview ? " \u2014 " + String(preview).slice(0, 140) : "");
  live.tools.appendChild(row);
  scrollDown();
}

function startLive() {
  hideWelcome();
  var wrap = document.createElement("div");
  wrap.className = "msg assistant";
  var m = document.createElement("div"); m.className = "meta";
  var t = document.createElement("span"); t.textContent = "Hermes \u00b7 " + fmtTime(Date.now() / 1000);
  m.appendChild(t);
  var tools = document.createElement("div"); tools.className = "tools";
  var bubble = document.createElement("div");
  bubble.className = "bubble caret";
  wrap.appendChild(m); wrap.appendChild(tools); wrap.appendChild(bubble);
  threadInner.appendChild(wrap);
  live = { wrap: wrap, bubble: bubble, tools: tools, text: "" };
  scrollDown(true);
}
function updateLive() { if (live) { renderMarkdown(live.bubble, live.text); scrollDown(); } }
function finishLive() {
  if (!live) return;
  live.bubble.classList.remove("caret");
  if (!live.text) { live.wrap.parentNode.removeChild(live.wrap); }
  else { addControls(live.wrap, "assistant"); }
  live = null;
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
