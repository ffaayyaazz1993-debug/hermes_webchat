// 116.4K -> "116.4K"; 1000000 -> "1.0M". Same compact style as the CLI bar.
function compactTok(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "K";
  return String(n);
}
// 10-cell block bar, the CLI's own glyph pair.
function blockBar(pct, width) {
  width = width || 10;
  var filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return new Array(filled + 1).join("\u2588") + new Array(Math.max(0, width - filled) + 1).join("\u2591");
}
function gradeCtx(pct) { return pct >= 95 ? "bad" : pct > 80 ? "warn" : ""; }
function gradeHit(pct) { return pct >= 70 ? "good" : pct >= 40 ? "warn" : "bad"; }

var lastTurn = null;   // {seconds, outputTokens, tokPerSec} measured from the stream

function renderStats(s, turn) {
  var el = $("stats");
  if (!el) return;
  if (!s || (!s.model_short && !s.context_tokens)) { el.hidden = true; el.textContent = ""; return; }
  var segs = [];
  function seg(cls, txt, title) {
    segs.push('<span class="seg ' + (cls || "") + '"' + (title ? ' title="' + title + '"' : "") + ">" + txt + "</span>");
  }
  function sep() { segs.push('<span class="sep">│</span>'); }

  if (s.model_short) seg("model", "☤ " + esc(s.model_short), s.model || "");
  sep();

  if (s.context_length) {
    var ctxTxt = "~" + compactTok(s.context_tokens) + "/" + compactTok(s.context_length)
      + (s.context_pinned ? " pinned" : "");
    seg("bar", ctxTxt, "prompt tokens in context window (input + cache read + cache write)");
    sep();
    if (s.context_percent != null) {
      seg("bar " + gradeCtx(s.context_percent), "[" + blockBar(s.context_percent) + "] ~" + s.context_percent + "%",
          "context window used");
      sep();
    }
  }
  if (s.cache_hit_pct != null) {
    seg(gradeHit(s.cache_hit_pct), "◎ " + s.cache_hit_pct + "%", "prompt cache hit rate this session");
    sep();
  }
  var t = turn || lastTurn;
  if (t && t.seconds) {
    // These two are NOT the same as the CLI bar's, and the tooltips say so: the CLI
    // reads per-call API latency from the live agent's deques, which do not exist
    // here (a fresh agent per turn, no persisted latency -- only session timestamps).
    // So this is end-to-end wall-clock for the turn, which also covers tool calls and
    // Hermes' auxiliary title pass, and end-to-end effective throughput.
    seg("", "◷ " + t.seconds.toFixed(1) + "s", "total wall-clock for the last turn "
        + "(includes tool calls; the CLI's \u25f7 is per-call API latency)");
    sep();
    if (t.tokPerSec) {
      seg("", "↑ " + t.tokPerSec.toFixed(1) + " tok/s",
          "output tokens per second, end-to-end");
    }
  }
  // Drop a trailing separator.
  while (segs.length && segs[segs.length - 1].indexOf("sep") !== -1) segs.pop();
  el.innerHTML = segs.join(" ");
  el.hidden = false;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function refreshStats(sid) {
  // Default to the open session, but allow an explicit id: loadSession calls this
  // before it reassigns sessionId, which would otherwise read the PREVIOUS chat.
  var id = sid || sessionId;
  if (!id) { renderStats(null); return Promise.resolve(); }
  return apiJSON("/webchat/sessions/" + encodeURIComponent(id) + "/stats")
    .then(function (s) {
      // Ignore a response for a chat the user has since navigated away from.
      if (id === sessionId) renderStats(s);
    }, function () { /* cosmetic */ });
}
