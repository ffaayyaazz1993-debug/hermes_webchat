function lastUserMsgEl() {
  var us = threadInner.querySelectorAll(".msg.user");
  return us.length ? us[us.length - 1] : null;
}
function removeAfter(el) {
  var n = el.nextElementSibling;
  while (n) { var nx = n.nextElementSibling; n.parentNode.removeChild(n); n = nx; }
}
// Rewind the persisted transcript to end at `keepId` so the agent resumes from exactly
// what is left. Uses the same SessionDB primitive as Hermes' own rewind.
function truncateTo(keepId) {
  if (!sessionId || !keepId) return Promise.resolve();
  return apiJSON("/webchat/sessions/" + encodeURIComponent(sessionId) + "/truncate", {
    method: "POST", body: JSON.stringify({ keep_through_message_id: Number(keepId) })
  });
}
function messageRows() {
  // The endpoint returns rows under "data" (with "pagination"); tolerate "messages" too.
  if (!sessionId) return Promise.resolve([]);
  return apiJSON("/api/sessions/" + encodeURIComponent(sessionId) + "/messages")
    .then(function (d) { return d.data || d.messages || []; }, function () { return []; });
}

function regenerate() {
  if (busy) { toast("Wait for the current reply, or press Esc to stop it."); return; }
  var u = lastUserMsgEl();
  if (!u) { toast("Nothing to regenerate."); return; }
  var text = bubbleText(u);
  var uid = Number(u.dataset.msgId || 0);   // read BEFORE detaching the node
  // The user bubble is REPLACED, not kept: the re-send below calls send(), which appends
  // a fresh user bubble. Leaving the old one in place is what showed two identical user
  // messages after a Retry (the server transcript stayed correct -- this was DOM-only).
  // Detach it now, before the async rewind, and re-add the re-sent one afterwards.
  var placeholder = document.createComment("retrying");
  if (u.parentNode) u.parentNode.replaceChild(placeholder, u);
  removeAfter(placeholder);
  // Rewind the transcript to just BEFORE the user turn, then ask again.
  //
  // The match must resolve to the FIRST occurrence of this user row, not the last.
  // A retry leaves the original user row in place and the re-send appends a second
  // one, so scanning backwards lands on the duplicate (observed: rows
  // 119657 user 'probe', 119658 user 'probe' -- keeping the last preserved the copy
  // and every retry grew the transcript). Truncating to match-1 then removes the
  // original, leaving exactly one user row.
  messageRows().then(function (rows) {
    var conversational = rows.filter(function (m) { return m.role === "user" || m.role === "assistant"; });
    var idx = -1;
    if (uid) {
      for (var k = 0; k < conversational.length; k++) {
        if (Number(conversational[k].id) === uid) { idx = k; break; }
      }
    }
    if (idx < 0) {
      for (var i = 0; i < conversational.length; i++) {   // FIRST match, not last
        if (conversational[i].role === "user"
            && String(conversational[i].content).trim() === text.trim()) { idx = i; break; }
      }
    }
    if (idx < 0) {
      for (var j = conversational.length - 1; j >= 0; j--) {
        if (conversational[j].role === "user") { idx = j; break; }
      }
    }
    if (idx < 0) return null;
    // Drop this user row and everything after it.
    return truncateTo(conversational[idx].id - 1);
  }).then(function () {
    lastSentUserEl = null;   // the rewind removed it; send() will re-create it
    send(text);
  }, function (e) {
    toast("Could not rewind: " + e.message);
    lastSentUserEl = null;
    send(text);
  });
}

function startEdit(wrap) {
  if (busy) { toast("Wait for the current reply, or press Esc to stop it."); return; }
  var bubble = wrap.querySelector(".bubble"), meta = wrap.querySelector(".meta"),
      controls = wrap.querySelector(".controls");
  var area = document.createElement("textarea");
  area.className = "edit-area";
  area.value = bubbleText(wrap);
  var actions = document.createElement("div");
  actions.className = "edit-actions";
  var cancel = document.createElement("button");
  cancel.className = "btn-sm"; cancel.textContent = "Cancel";
  var save = document.createElement("button");
  save.className = "btn-sm primary"; save.textContent = "Save & send";
  actions.appendChild(cancel); actions.appendChild(save);

  function restore() {
    if (area.parentNode) area.parentNode.removeChild(area);
    if (actions.parentNode) actions.parentNode.removeChild(actions);
    if (bubble) bubble.style.display = "";
    if (meta) meta.style.display = "";
    if (controls) controls.style.display = "";
  }
  cancel.addEventListener("click", restore);
  save.addEventListener("click", function () {
    var text = area.value.trim();
    if (!text) { toast("Message cannot be empty."); return; }
    var myId = Number(wrap.dataset.msgId || 0);
    var original = bubbleText(wrap);
    removeAfter(wrap);
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    // Rewind to the row BEFORE this user turn. Match the FIRST occurrence (a retry
    // can leave duplicates; a backward scan would land on the copy), by id when known,
    // else by the original content, else fall back to the first user row.
    messageRows().then(function (rows) {
      var conversational = rows.filter(function (m) { return m.role === "user" || m.role === "assistant"; });
      var idx = -1;
      if (myId) {
        for (var k = 0; k < conversational.length; k++) {
          if (Number(conversational[k].id) === myId) { idx = k; break; }
        }
      }
      if (idx < 0) {
        for (var i = 0; i < conversational.length; i++) {   // FIRST match, not last
          if (conversational[i].role === "user"
              && String(conversational[i].content).trim() === original.trim()) { idx = i; break; }
        }
      }
      if (idx < 0) {
        for (var j = 0; j < conversational.length; j++) {
          if (conversational[j].role === "user") { idx = j; break; }
        }
      }
      if (idx < 0) return null;
      return truncateTo(conversational[idx].id - 1);
    }).then(function () {
      lastSentUserEl = null;
      send(text);
    }, function (e) {
      toast("Could not rewind: " + e.message);
      lastSentUserEl = null;
      send(text);
    });
  });

  if (bubble) bubble.style.display = "none";
  if (meta) meta.style.display = "none";
  if (controls) controls.style.display = "none";
  wrap.appendChild(area); wrap.appendChild(actions);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  autosizeEl(area);
}
