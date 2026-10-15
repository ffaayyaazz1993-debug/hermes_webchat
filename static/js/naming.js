function setTitleBar(text) {
  convTitle.textContent = text || "New chat";
}

// Rename inline in the sidebar. Enter saves, Escape cancels, blur saves.
function startRename(item, s) {
  if (!item || item.querySelector(".sb-rename")) return;
  var label = item.querySelector(".t");
  if (!label) return;
  var input = document.createElement("input");
  input.className = "sb-rename";
  input.value = s.title || "";
  input.maxLength = 100;
  item.replaceChild(input, label);
  input.focus();
  input.select();

  var done = false;
  function finish(save) {
    if (done) return;
    done = true;
    var val = input.value.trim();
    if (!save || !val) { refreshSidebar(); return; }
    setTitle(sessionIdOf(item), val, function () {
      if (item.dataset.id === sessionId) setTitleBar(val);
      refreshSidebar();
    });
  }
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    e.stopPropagation();   // do not let the composer shortcuts fire
  });
  input.addEventListener("blur", function () { finish(true); });
}

function sessionIdOf(item) { return item ? item.dataset.id : ""; }

convTitle.title = "Click to rename this conversation";
convTitle.addEventListener("click", startHeaderRename);

// Click the header title to rename the open conversation in place.
function startHeaderRename() {
  if (!sessionId) { toast("Start a conversation first"); return; }
  var cur = sessions.filter(function (x) { return x.id === sessionId; })[0];
  var box = document.createElement("input");
  box.className = "sb-rename";
  box.style.cssText = "font-size:15px;font-weight:600;min-width:180px";
  box.value = (cur && cur.title) || "New chat";
  box.maxLength = 100;
  var old = convTitle;
  old.parentNode.replaceChild(box, old);
  box.focus(); box.select();
  var done = false;
  function finish(save) {
    if (done) return;
    done = true;
    var val = box.value.trim();
    box.parentNode.replaceChild(old, box);
    setTitleBar(old.textContent);
    if (!save || !val) return;
    setTitle(sessionId, val, function () { refreshSidebar(); });
  }
  box.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  box.addEventListener("blur", function () { finish(true); });
}

// PATCH the title through the backend so Hermes records `user` provenance and its
// auto-titler can never overwrite it. Optimistic: the label updates immediately and
// is rolled back by refreshSidebar() if the write fails.
function setTitle(sid, title, done) {
  if (!sid) { if (done) done(); return; }
  var t = document.createElement("span");
  t.className = "t"; t.textContent = title; t.title = title;
  var item = sbList.querySelector('.sb-item[data-id="' + sid + '"]');
  if (item && !item.querySelector(".sb-rename")) item.replaceChild(t, item.querySelector(".t"));
  if (sid === sessionId) setTitleBar(title);
  apiJSON("/webchat/sessions/" + encodeURIComponent(sid) + "/title", {
    method: "PATCH",
    // apiJSON forwards `body` straight to fetch, so it must be a JSON *string*;
    // passing the object sent "[object Object]" and the backend answered
    // "Invalid JSON in request body" (verified -- every rename silently failed).
    body: JSON.stringify({ title: title })
  }).then(function (d) {
    if (done) done(d);
  }, function (err) {
    toast("Rename failed: " + err.message);
    refreshSidebar();
    if (done) done(null);
  });
}

// Give a fresh conversation a real name from its first user message. Free (no model
// call) and writes at `derived` provenance, so any manual rename still wins. Only fires
// once per session and only while the title is still the "New chat ..." placeholder.
var autoNamed = {};
function maybeAutoName(sid, firstUserText) {
  if (!sid || autoNamed[sid] || !firstUserText) return;
  var s = sessions.filter(function (x) { return x.id === sid; })[0];
  if (s && s.title_source === "user") return;         // user named it; leave it alone
  if (s && s.title && !/^New chat/.test(s.title)) return;  // already has a real name
  autoNamed[sid] = true;
  apiJSON("/webchat/sessions/" + encodeURIComponent(sid) + "/title", {
    method: "PATCH", body: JSON.stringify({ auto: true })
  }).then(function (d) {
    if (d && d.changed && d.title) {
      if (sid === sessionId) setTitleBar(d.title);
      refreshSidebar();
    }
  }, function () { /* silent: a missing name is cosmetic */ });
}
