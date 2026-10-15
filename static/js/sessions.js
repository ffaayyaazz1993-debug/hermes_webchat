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
  if (busy) { toast("Wait for the current reply, or press Esc to stop it."); return; }
  finishLive();
  sessionId = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  threadInner.textContent = "";
  threadInner.appendChild(buildWelcome());
  convTitle.textContent = "New chat";
  lastTurn = null;
  renderStats(null);   // clear: the old chat's counters must not linger
  hideThinking();
  setStatus("ready", "ok");
  input.focus();
  newSession().then(refreshSidebar, function () {});
}

function loadSession(id) {
  if (busy) { toast("Wait for the current reply, or press Esc to stop it."); return; }
  // Show the stored name in the header immediately; refreshSidebar may not have run yet.
  var known = sessions.filter(function (x) { return x.id === id; })[0];
  if (known) setTitleBar(known.title);
  lastTurn = null;   // per-turn timings belong to the conversation being opened
  return apiJSON("/api/sessions/" + encodeURIComponent(id) + "/messages").then(function (d) {
    sessionId = id;
    try { sessionStorage.setItem(SESSION_KEY, id); } catch (e) {}
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
    if (!threadInner.querySelector(".msg")) threadInner.appendChild(buildWelcome());
    var s = sessions.filter(function (x) { return x.id === id; })[0];
    convTitle.textContent = (s && s.title) || "Chat";
    setStatus("ready", "ok");
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
  });
}

function markActive() {
  var items = sbList.querySelectorAll(".sb-item");
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle("active", items[i].dataset.id === sessionId);
  }
}

function refreshSidebar() {
  return apiJSON("/webchat/sidebar").then(function (d) {
    sessions = d.sessions || [];
    sbList.textContent = "";
    var mine = sessions.filter(function (s) { return s.message_count > 0 || s.id === sessionId; });
    if (!mine.length) {
      var e = document.createElement("div");
      e.className = "sb-empty"; e.textContent = "No conversations yet.";
      sbList.appendChild(e);
      return;
    }
    var group = null;
    mine.forEach(function (s) {
      var label = fmtDay(s.last_active);
      if (label !== group) {
        group = label;
        var h = document.createElement("div");
        h.className = "sb-group"; h.textContent = label;
        sbList.appendChild(h);
      }
      var item = document.createElement("button");
      item.className = "sb-item"; item.dataset.id = s.id;
      var t = document.createElement("span");
      t.className = "t"; t.textContent = s.title || "New chat";
      t.title = s.title || "New chat";
      var pen = document.createElement("span");
      pen.className = "x pen"; pen.textContent = "\u270E"; pen.title = "Rename chat";
      pen.addEventListener("click", function (ev) {
        ev.stopPropagation();
        startRename(item, s);
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
      item.appendChild(t); item.appendChild(pen); item.appendChild(x);
      item.addEventListener("click", function () { loadSession(s.id); });
      item.addEventListener("dblclick", function () { startRename(item, s); });
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
  }, function () { /* sidebar is non-critical */ });
}
