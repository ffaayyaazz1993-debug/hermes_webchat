// Live push channel (server -> browser).
//
// One fetch-stream subscriber per tab on GET /events, so the chat reports
// progress on its own: promoted background jobs, long turns, subagents, cron.
// You should never have to type "what's the status?".
//
// NOT EventSource: it cannot send the Authorization header, and putting the API
// key in a query string would leak it into history and logs. fetch() + a
// ReadableStream supports headers and gives explicit reconnect control -- the
// same pattern send.js already uses for chat/stream.
//
// Frames carry monotonic ids. A jump in ids means the server dropped frames for
// a slow tab (drop-oldest); that is surfaced instead of silently losing them.

var LIVE = {
  lastId: 0,
  backoff: 1000,
  controller: null,
  stopped: false,
  rows: {}          // key -> {row, meta, kids} for in-flight work
};

function liveStart() {
  if (LIVE.controller || LIVE.stopped) return;
  liveConnect();
}

function liveStop() {
  LIVE.stopped = true;
  if (LIVE.controller) LIVE.controller.abort();
  LIVE.controller = null;
}

function liveConnect() {
  var ctl = new AbortController();
  LIVE.controller = ctl;
  var hdrs = { "Accept": "text/event-stream" };
  if (KEY) hdrs["Authorization"] = "Bearer " + KEY;
  if (LIVE.lastId) hdrs["Last-Event-ID"] = String(LIVE.lastId);

  fetch("/events", { headers: hdrs, signal: ctl.signal }).then(function (res) {
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    LIVE.backoff = 1000;
    var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
    return (function pump() {
      return reader.read().then(function (r) {
        if (r.done) return null;
        buf += dec.decode(r.value, { stream: true });
        var parts = buf.split("\n\n");
        buf = parts.pop();
        for (var i = 0; i < parts.length; i++) liveFrame(parts[i]);
        return pump();
      });
    })();
  }).then(function () {
    liveRetry();
  }, function (err) {
    if (err && err.name === "AbortError") return;   // deliberate stop
    liveRetry();
  });
}

function liveRetry() {
  LIVE.controller = null;
  if (LIVE.stopped) return;
  var wait = LIVE.backoff;
  LIVE.backoff = Math.min(LIVE.backoff * 2, 30000);
  setTimeout(function () { if (!LIVE.stopped) liveConnect(); }, wait);
}

function liveFrame(raw) {
  if (!raw.trim()) return;
  var name = "message", data = "", id = null;
  raw.split("\n").forEach(function (line) {
    if (line.indexOf("id:") === 0) id = line.slice(3).trim();
    else if (line.indexOf("event:") === 0) name = line.slice(6).trim();
    else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
  });
  if (id && /^\d+$/.test(id)) {
    var n = parseInt(id, 10);
    if (LIVE.lastId && n > LIVE.lastId + 1) liveGap(n - LIVE.lastId - 1);
    LIVE.lastId = n;
  }
  var pl;
  try { pl = JSON.parse(data || "{}"); } catch (e) { return; }
  liveDispatch(name, pl);
}

// A gap means the server dropped frames for this tab (drop-oldest on a slow
// consumer). Say so rather than pretending the stream was continuous.
function liveGap(missed) {
  if (typeof toast === "function") {
    toast(missed + " progress update" + (missed === 1 ? "" : "s") + " missed while this tab was behind");
  }
}

function liveDispatch(name, pl) {
  if (name === "sessions.changed") {
    if (typeof refreshSidebar === "function") refreshSidebar();
    return;
  }
  if (name.indexOf("progress.") === 0) { liveProgress(name, pl); return; }
}

// ── rendering ───────────────────────────────────────────────────────────────
// Progress lands in the conversation as its own row. It is NOT a message: it is
// never POSTed, never starts a turn, and never enters the prompt.

function _liveLabel(pl) {
  var bits = [];
  if (pl.label) bits.push(String(pl.label));
  if (pl.detail) bits.push(String(pl.detail));
  return bits.join(" — ");
}

function _liveTime(secs) {
  if (secs == null || isNaN(secs)) return "";
  if (secs < 60) return Math.round(secs) + "s";
  var m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return m + "m " + s + "s";
}

function liveProgress(name, pl) {
  var sid = pl.session_id || "";
  var onScreen = (typeof sessionId !== "undefined") && sid && sid === sessionId;

  // Not the chat you're looking at: don't inject it here, just nudge the sidebar.
  if (!onScreen) {
    if (typeof refreshSidebar === "function") refreshSidebar();
    if (name === "progress.done" || name === "progress.failed") {
      if (typeof toast === "function") {
        toast((name === "progress.failed" ? "✗ " : "✓ ") + _liveLabel(pl) +
              (pl.elapsed ? " · " + _liveTime(pl.elapsed) : ""));
      }
    }
    return;
  }

  var key = pl.key || ("note-" + Date.now());
  var rec = LIVE.rows[key];

  if (!rec) {
    rec = _liveRow(key, pl);
    if (!rec) return;
  }

  if (name === "progress.running" || name === "progress.started") {
    rec.meta.textContent = "running · " + _liveTime(pl.elapsed);
    rec.glyph.textContent = "\u25CF";             // ●
  } else if (name === "progress.done") {
    rec.row.classList.remove("running");
    rec.row.classList.add("ok");
    rec.glyph.textContent = "\u2713";             // ✓
    rec.meta.textContent = "done" + (pl.elapsed ? " · " + _liveTime(pl.elapsed) : "");
    if (pl.detail) _liveChild(rec, pl.detail);
    delete LIVE.rows[key];
  } else if (name === "progress.failed") {
    rec.row.classList.remove("running");
    rec.row.classList.add("err");
    rec.glyph.textContent = "\u2717";             // ✗
    rec.meta.textContent = "failed" + (pl.elapsed ? " · " + _liveTime(pl.elapsed) : "");
    if (pl.detail) _liveChild(rec, pl.detail);
    delete LIVE.rows[key];
  } else if (name === "progress.note") {
    rec.meta.textContent = pl.elapsed ? _liveTime(pl.elapsed) : "";
  }
  if (typeof scrollDown === "function") scrollDown();
}

function _liveRow(key, pl) {
  if (typeof threadInner === "undefined" || !threadInner) return null;
  var row = document.createElement("div");
  row.className = "tool-line progress running";
  var head = document.createElement("div");
  head.className = "tool-head";
  var glyph = document.createElement("span");
  glyph.className = "tool-glyph"; glyph.textContent = "\u25CF";
  var label = document.createElement("span");
  label.className = "tool-name"; label.textContent = _liveLabel(pl) || "working";
  label.title = label.textContent;
  var meta = document.createElement("span");
  meta.className = "tool-meta";
  head.appendChild(glyph); head.appendChild(label); head.appendChild(meta);
  row.appendChild(head);
  var kids = document.createElement("div");
  kids.className = "sub-kids";
  row.appendChild(kids);
  threadInner.appendChild(row);
  var rec = { row: row, glyph: glyph, meta: meta, kids: kids };
  LIVE.rows[key] = rec;
  return rec;
}

function _liveChild(rec, text) {
  if (!rec || !rec.kids) return;
  var line = document.createElement("div");
  line.className = "sub-prog";
  line.textContent = String(text);
  rec.kids.appendChild(line);
}
