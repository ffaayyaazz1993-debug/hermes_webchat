function setStatus(t, k) { statusText.textContent = t; dot.className = "dot" + (k ? " " + k : ""); }
function toast(m) {
  toastEl.textContent = m; toastEl.style.display = "block";
  clearTimeout(toastT); toastT = setTimeout(function () { toastEl.style.display = "none"; }, 4200);
}
function atBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140; }
function scrollDown(force) { if (force || atBottom()) thread.scrollTop = thread.scrollHeight; }
function fmtTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDay(ts) {
  if (!ts) return "Earlier";
  var d = new Date(ts * 1000), now = new Date();
  var days = Math.floor((now - d) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return d.toLocaleDateString([], { month: "long", year: "numeric" });
}
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(function () { toast("Copied"); }, fallbackCopy);
    return;
  }
  fallbackCopy();
  function fallbackCopy() {
    var ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast("Copy failed"); }
    ta.remove();
  }
}
