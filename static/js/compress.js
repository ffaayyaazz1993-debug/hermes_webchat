var compressBtn = $("compress-btn");
function updateCompressBtn() {
  if (!compressBtn) return;
  compressBtn.disabled = !(sessionId && !busy);
}
compressBtn.addEventListener("click", function () {
  if (!sessionId || busy) return;
  send("/compress");
});
imgFileInput.addEventListener("change", function () {
  var files = Array.prototype.slice.call(imgFileInput.files || []);
  files.forEach(function (f) {
    if (f.type && f.type.indexOf("image/") === 0) {
      var r = new FileReader();
      r.onload = function () { pendingImages.push(r.result); renderAttachments(); };
      r.readAsDataURL(f);
    } else if (f.type === "application/pdf" || /\.pdf$/i.test(f.name || "")) {
      var r = new FileReader();
      r.onload = function () {
        toast("Extracting text from " + f.name + "…", "ok");
        fetch("/webchat/upload_pdf", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, KEY ? { "Authorization": "Bearer " + KEY } : {}),
          body: JSON.stringify({ filename: f.name, data: r.result })
        }).then(function (res) { return res.json(); }).then(function (d) {
          if (!d || !d.ok) { toast("PDF upload failed: " + ((d && d.error) || "unknown"), "err"); return; }
          pendingPdfs.push({ name: d.name || f.name, text: d.text || "" });
          renderAttachments();
          toast("Attached PDF: " + (d.name || f.name) + " (" + (d.pages || 0) + " pages)", "ok");
        }).catch(function (e) { toast("PDF upload failed: " + e.message, "err"); });
      };
      r.readAsDataURL(f);
    }
  });
  imgFileInput.value = "";
});

// Paste images from clipboard
input.addEventListener("paste", function (e) {
  var items = (e.clipboardData || {}).items;
  if (!items) return;
  Array.prototype.forEach.call(items, function (item) {
    if (item.type && item.type.indexOf("image/") === 0) {
      e.preventDefault();
      var f = item.getAsFile(); if (!f) return;
      var r = new FileReader();
      r.onload = function () { pendingImages.push(r.result); renderAttachments(); };
      r.readAsDataURL(f);
    }
  });
});

// Drop images onto composer
var composer = $("composer");
composer.addEventListener("dragover", function (e) { e.preventDefault(); });
composer.addEventListener("drop", function (e) {
  e.preventDefault();
  var files = Array.prototype.slice.call((e.dataTransfer || {}).files || []);
  files.forEach(function (f) {
    if (f.type && f.type.indexOf("image/") === 0) {
      var r = new FileReader();
      r.onload = function () { pendingImages.push(r.result); renderAttachments(); };
      r.readAsDataURL(f);
    } else if (f.type === "application/pdf" || /\.pdf$/i.test(f.name || "")) {
      var r = new FileReader();
      r.onload = function () {
        toast("Extracting text from " + f.name + "…", "ok");
        fetch("/webchat/upload_pdf", {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, KEY ? { "Authorization": "Bearer " + KEY } : {}),
          body: JSON.stringify({ filename: f.name, data: r.result })
        }).then(function (res) { return res.json(); }).then(function (d) {
          if (!d || !d.ok) { toast("PDF upload failed: " + ((d && d.error) || "unknown"), "err"); return; }
          pendingPdfs.push({ name: d.name || f.name, text: d.text || "" });
          renderAttachments();
          toast("Attached PDF: " + (d.name || f.name) + " (" + (d.pages || 0) + " pages)", "ok");
        }).catch(function (e) { toast("PDF upload failed: " + e.message, "err"); });
      };
      r.readAsDataURL(f);
    }
  });
});

// Lightbox for viewing images in messages
var lightbox = null;
function openLightbox(src) {
  if (lightbox) closeLightbox();
  lightbox = document.createElement("div");
  lightbox.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;";
  var img = document.createElement("img");
  img.src = src; img.style.cssText = "max-width:92vw;max-height:92vh;border-radius:8px;";
  lightbox.appendChild(img);
  lightbox.addEventListener("click", closeLightbox);
  document.body.appendChild(lightbox);
}
function closeLightbox() { if (lightbox) { lightbox.parentNode.removeChild(lightbox); lightbox = null; } }
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeLightbox(); });
// A cached tab kept showing stale strip numbers (observed: ~329K/~33% for a session
// whose real context was 32.9K/3.3%, because the page had been loaded before the
// usage-anchor fix). Refetch whenever the tab becomes visible again.
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && sessionId) refreshStats();
});
window.addEventListener("focus", function () {
  if (sessionId) refreshStats();
});

$("saveBtn").addEventListener("click", function () {
  if (!sessionId) { toast("No session to save"); return; }
  apiJSON("/webchat/sessions/" + encodeURIComponent(sessionId) + "/save", { method: "POST" })
    .then(function (d) {
      if (d.already) { toast("Already in web history"); }
      else if (d.saved) { toast("Saved to web history"); }
      refreshSidebar();
    })
    .catch(function (e) { toast("Save failed: " + e.message); });
});

$("newChat").addEventListener("click", newChat);
$("menuBtn").addEventListener("click", function () {
  document.body.classList.toggle("sidebar-collapsed");
  try { localStorage.setItem("hermes_sb", document.body.classList.contains("sidebar-collapsed") ? "1" : "0"); } catch (e) {}
});
// Tap-outside closes the mobile drawer. The scrim is only ever visible on mobile while
// the drawer is OPEN, so this must ADD the collapsed class; removing it was a no-op and
// left the drawer stuck open.
$("scrim").addEventListener("click", function () {
  document.body.classList.add("sidebar-collapsed");
});

// Below the mobile breakpoint the sidebar is an overlay, so it must start (and return)
// hidden. init() only applies this at load time; a resize into a narrow window would
// otherwise leave a 268px drawer covering the conversation.
var MOBILE_BP = 860;
function applyResponsiveSidebar() {
  var narrow = window.matchMedia && window.matchMedia("(max-width: " + MOBILE_BP + "px)").matches;
  if (narrow) document.body.classList.add("sidebar-collapsed");
}
if (window.matchMedia) {
  var mq = window.matchMedia("(max-width: " + MOBILE_BP + "px)");
  if (mq.addEventListener) mq.addEventListener("change", applyResponsiveSidebar);
  else if (mq.addListener) mq.addListener(applyResponsiveSidebar);
}
document.addEventListener("keydown", function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") { e.preventDefault(); newChat(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("menuBtn").click(); }
});
$("chips").addEventListener("click", function (e) {
  var c = e.target.closest ? e.target.closest(".chip") : null;
  if (c) { input.value = c.textContent; autosize(); input.focus(); }
});

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $("themeBtn").innerHTML = t === "dark"
    ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
}
$("themeBtn").addEventListener("click", function () {
  var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(next);
  try { localStorage.setItem("hermes_theme", next); } catch (e) {}
});
