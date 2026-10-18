function newSession() {
  // Create the session UNTILED on purpose. Hermes refuses to auto-name a row that
  // already has a title -- SessionDB._set_session_title skips any non-null title whose
  // provenance ranks at or above the incoming one -- so seeding "New chat <timestamp>"
  // here permanently blocked auto-naming (verified: auto returned changed=false against
  // a timestamped row). A null title also sidesteps the uniqueness check that made the
  // second New chat fail with "Title already in use by session <id>". The name is
  // filled in from the first user message, or by hand.
  return apiJSON("/api/sessions", {
    method: "POST", body: JSON.stringify({ source: "api_server" })
  }).then(function (d) {
    sessionId = (d.session && d.session.id) || d.id || null;
    try { sessionStorage.setItem(SESSION_KEY, sessionId); } catch (e) {}
    setTitleBar("New chat");
    return sessionId;
  });
}

function buildWelcome() {
  var w = document.createElement("div");
  w.id = "welcome";
  var h = document.createElement("h2"); h.textContent = "Hermes";
  var p = document.createElement("p");
  p.textContent = "Your agent \u2014 tools, memory, skills, sessions and Kanban, in the browser.";
  var chips = document.createElement("div");
  chips.className = "chips"; chips.id = "chips";
  ["What can you do?", "List my active Kanban tasks", "What do you remember about me?",
   "Run a shell command and explain the output"].forEach(function (label) {
    var b = document.createElement("button");
    b.className = "chip"; b.textContent = label;
    chips.appendChild(b);
  });
  chips.addEventListener("click", function (e) {
    var c = e.target.closest ? e.target.closest(".chip") : null;
    if (c) { input.value = c.textContent; autosize(); input.focus(); }
  });
  w.appendChild(h); w.appendChild(p); w.appendChild(chips);
  return w;
}

function newChat() {
  // Switching away mid-turn is allowed: a running turn keeps streaming on its own
  // session and lands there (see send.js). Nothing is aborted and nothing is lost.
  sessionId = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  try { history.replaceState(null, "", window.location.pathname + window.location.search); } catch (e) {}
  threadInner.textContent = "";
  threadInner.appendChild(buildWelcome());
  convTitle.textContent = "New chat";
  var saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.style.display = "none";
  lastTurn = null;
  renderStats(null);   // clear: the old chat's counters must not linger
  hideThinking();
  setStatus("ready", "ok");
  syncTurnAliases();   // no turn belongs to this fresh chat
  input.focus();
  newSession().then(function () { syncTurnAliases(); refreshSidebar(); }, function () {});
}

function loadSession(id) {
  // Switching away mid-turn is allowed: a running turn keeps streaming on its own
  // session and lands there (see send.js). Nothing is aborted.
  // Show the stored name in the header immediately; refreshSidebar may not have run yet.
  var known = sessions.filter(function (x) { return x.id === id; })[0];
  if (known) setTitleBar(known.title);
  lastTurn = null;   // per-turn timings belong to the conversation being opened
  return apiJSON("/api/sessions/" + encodeURIComponent(id) + "/messages").then(function (d) {
    sessionId = id;
    try { sessionStorage.setItem(SESSION_KEY, id); } catch (e) {}
    try { history.replaceState(null, "", window.location.pathname + window.location.search + "#session-" + encodeURIComponent(id)); } catch (e) {}
    var msgs = d.data || d.messages || [];
    userHistory = msgs.filter(function (m) { return m.role === "user" && m.content; })
      .map(function (m) { return m.content; }).slice(-200);
    threadInner.textContent = "";
    live = null;
    msgs.forEach(function (m) {
      if (m.role === "user") {
        var r = addMsg("user", m.content, { ts: m.timestamp });
        r.wrap.dataset.msgId = m.id;
        addControls(r.wrap, "user");
      } else if (m.role === "assistant" && m.content) {
        var r2 = addMsg("assistant", m.content, { ts: m.timestamp });
        r2.wrap.dataset.msgId = m.id;
        addControls(r2.wrap, "assistant");
      }
    });
    // A turn for this chat may still be streaming in the background. Its bubble was
    // kept in memory while the user was elsewhere -- put it back, along with any
    // notes it raised in the meantime.
    var t = turnFor(id);
    if (t) {
      (t.notes || []).forEach(function (n) { addMsg(n.role, n.text); });
      t.notes = [];
      if (t.busy && t.live && t.live.wrap) {
        threadInner.appendChild(t.live.wrap);
        updateLive(t);
      }
    }
    if (!threadInner.querySelector(".msg")) threadInner.appendChild(buildWelcome());
    var s = sessions.filter(function (x) { return x.id === id; })[0];
    convTitle.textContent = (s && s.title) || "Chat";
    // Show save button for non-api_server sessions (CLI, cron, etc.)
    // If session not in sidebar (s is undefined), it's an external session → show button.
    var saveBtn = document.getElementById("saveBtn");
    if (saveBtn) {
        var isExternal = !s || (s.source && s.source !== "api_server");
        saveBtn.style.display = isExternal ? "" : "none";
    }
    syncTurnAliases();   // busy / controller / live now describe THIS chat
    scrollDown(true);
    markActive();
    // Stats AFTER sessionId is assigned. Calling it earlier dropped the response on
    // every page load: refreshStats only renders when the id it fetched matches the
    // current sessionId, and at that point sessionId was still null -- so the strip
    // came back empty after a refresh (it only reappeared after the next turn).
    refreshStats(id);
  }, function (e) {
    toast("Could not open that chat: " + e.message);
    sessionId = null;
    syncTurnAliases();
  });
}

function markActive() {
  var items = sbList.querySelectorAll(".sb-item");
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle("active", items[i].dataset.id === sessionId);
  }
}

// Manual order + pins. Mirrors sidebar_order.sort_key on the server: pinned
// block first, then unranked rows by recency, then dragged rows by rank. Ranks
// and pins persist in the WebChat's own sidecar, so `hermes update` cannot undo
// them, and the list falls back to pure recency when nothing has been dragged.
var manualOrder = false, dragId = null;

function _sbSortKey(a, b) {
  var pa = a.ui_pinned ? 1 : 0, pb = b.ui_pinned ? 1 : 0;
  if (pa !== pb) return pb - pa;                       // pinned block on top
  var ra = (typeof a.rank === "number") ? a.rank : null;
  var rb = (typeof b.rank === "number") ? b.rank : null;
  if ((ra === null) !== (rb === null)) return (ra === null) ? -1 : 1;  // new chats above the manual block
  if (ra !== null && rb !== null && ra !== rb) return ra - rb;
  return (Number(b.last_active) || 0) - (Number(a.last_active) || 0);
}

function _sbItems() { return Array.from(sbList.querySelectorAll(".sb-item")); }

function _sbById(id) {
  return sessions.filter(function (x) { return x.id === id; })[0];
}

function _sbPersistOrder() {
  var order = [], pinned = [];
  _sbItems().forEach(function (el) {
    var s = _sbById(el.dataset.id);
    if (!s) return;
    (s.ui_pinned ? pinned : order).push(s.id);
  });
  return apiJSON("/webchat/sidebar/order", {
    method: "POST", body: JSON.stringify({ order: order, pinned: pinned })
  });
}

function togglePin(sid, on) {
  apiJSON("/webchat/sidebar/order", {
    method: "POST", body: JSON.stringify({ pin: { id: sid, value: !!on } })
  }).then(function () { refreshSidebar(); },
          function (e) { toast("Pin failed: " + e.message); });
}

// Drop: rebuild the visible order with the dragged row moved, repaint instantly,
// then persist. Ranks are reassigned by position, so no midpoints are needed.
function _sbDrop(srcId, targetId, below) {
  var ids = _sbItems().map(function (el) { return el.dataset.id; });
  var from = ids.indexOf(srcId), to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return;
  ids.splice(from, 1);
  to = ids.indexOf(targetId);
  ids.splice(below ? to + 1 : to, 0, srcId);
  var rank = 10;
  // Rank EVERY session, not just the rows on screen. A session left unranked
  // sorts above the manual block on the next load (by design, so new chats are
  // never buried) -- which made unrendered sessions appear to jump the queue.
  // Visible rows keep their dropped order; the rest follow by recency.
  var rest = sessions
    .filter(function (s) { return !s.ui_pinned && ids.indexOf(s.id) < 0; })
    .sort(function (a, b) { return (Number(b.last_active) || 0) - (Number(a.last_active) || 0); })
    .map(function (s) { return s.id; });
  ids.concat(rest).forEach(function (id) {
    var s = _sbById(id);
    if (!s || s.ui_pinned) return;   // pins keep their own block
    s.rank = rank; rank += 10;
  });
  manualOrder = true;                // a manual order exists now: headers come down
  _sbRender();
  _sbPersistOrder().then(null, function (e) {
    toast("Order not saved: " + e.message);
    refreshSidebar();
  });
}

function _sbDragOver(item, ev) {
  var r = item.getBoundingClientRect();
  var below = (ev.clientY - r.top) > r.height / 2;
  item.classList.toggle("drop-above", !below);
  item.classList.toggle("drop-below", below);
  return below;
}

function refreshSidebar() {
  return apiJSON("/webchat/sidebar").then(function (d) {
    sessions = d.sessions || [];
    manualOrder = !!d.manual_order;
    _sbRender();
  }, function () { /* sidebar is non-critical */ });
}

// Pure render -- no fetch, so a drop repaints before the write lands.
function _sbRender() {
  sbList.textContent = "";
  // Order is explicit (see _sbSortKey). The endpoint does not guarantee order,
  // and the header loop only emits on a label CHANGE, so this sort is also what
  // keeps each date header appearing exactly once, in order.
  var mine = sessions.filter(function (s) {
    return s.message_count > 0 || s.id === sessionId;
  }).sort(_sbSortKey);
  if (!mine.length) {
    var e = document.createElement("div");
    e.className = "sb-empty"; e.textContent = "No conversations yet.";
    sbList.appendChild(e);
    return;
  }
  var group = null;
  mine.forEach(function (s) {
    // Date headers only while the list is automatic. Once a row has been dragged
    // a header would lie -- a chat dropped into "Today" is not from today.
    if (!manualOrder) {
      var label = fmtDay(s.last_active);
      if (label !== group) {
        group = label;
        var h = document.createElement("div");
        h.className = "sb-group"; h.textContent = label;
        sbList.appendChild(h);
      }
    }
    var item = document.createElement("button");
    item.className = "sb-item"; item.dataset.id = s.id;
    if (s.ui_pinned) item.classList.add("pinned");
    var t = document.createElement("span");
    t.className = "t"; t.textContent = s.title || "New chat";
    t.title = s.title || "New chat";
    var pen = document.createElement("span");
    pen.className = "x pen"; pen.textContent = "\u270E"; pen.title = "Rename chat";
    pen.addEventListener("click", function (ev) {
      ev.stopPropagation();
      startRename(item, s);
    });
    var pin = document.createElement("span");
    pin.className = "x pin" + (s.ui_pinned ? " on" : "");
    pin.textContent = "\u2691";                 // ⚑
    pin.title = s.ui_pinned ? "Unpin chat" : "Pin chat";
    pin.addEventListener("click", function (ev) {
      ev.stopPropagation();
      togglePin(s.id, !s.ui_pinned);
    });
    var x = document.createElement("span");
    x.className = "x"; x.textContent = "\u2715"; x.title = "Delete chat";
    x.addEventListener("click", function (ev) {
      ev.stopPropagation();
      apiJSON("/api/sessions/" + encodeURIComponent(s.id), { method: "DELETE" }).then(function () {
        if (s.id === sessionId) newChat();
        toast("Deleted");
        refreshSidebar();
      }, function (err) { toast("Delete failed: " + err.message); });
    });
    item.appendChild(t);
    // A chat with a turn still running gets a dot, so it is obvious which one is
    // working while the user reads another.
    if (turnFor(s.id)) {
      var sp = document.createElement("span");
      sp.className = "sb-spin";
      sp.title = "Still generating\u2026";
      item.appendChild(sp);
    }
    item.appendChild(pin); item.appendChild(pen); item.appendChild(x);
    item.addEventListener("click", function () { loadSession(s.id); });
    item.addEventListener("dblclick", function () { startRename(item, s); });

    // Drag to reorder, anywhere in the list.
    item.draggable = true;
    item.addEventListener("dragstart", function (ev) {
      dragId = s.id;
      item.classList.add("dragging");
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = "move";
        try { ev.dataTransfer.setData("text/plain", s.id); } catch (err) {}
      }
    });
    item.addEventListener("dragend", function () {
      dragId = null;
      _sbItems().forEach(function (el) {
        el.classList.remove("dragging", "drop-above", "drop-below");
      });
    });
    item.addEventListener("dragover", function (ev) {
      if (!dragId || dragId === s.id) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      _sbDragOver(item, ev);
    });
    item.addEventListener("dragleave", function () {
      item.classList.remove("drop-above", "drop-below");
    });
    item.addEventListener("drop", function (ev) {
      ev.preventDefault();
      if (!dragId || dragId === s.id) return;
      var below = _sbDragOver(item, ev);
      var src = dragId;
      item.classList.remove("drop-above", "drop-below");
      _sbDrop(src, s.id, below);
    });

    sbList.appendChild(item);
  });
  markActive();
  // Keep the header in step with the stored name. Whoever set it (Hermes' own titler,
  // auto-name here, or a manual rename), the sidebar is the source of truth -- without
  // this the header stayed on "New chat" while the sidebar showed the real name.
  if (sessionId) {
    var active = sessions.filter(function (x) { return x.id === sessionId; })[0];
    if (active && active.title) setTitleBar(active.title);
  }
}
