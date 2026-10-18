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
  // Compare calendar days, not elapsed 24h windows. The raw (now - d)/86400000
  // floor labelled a chat from 21:00 two nights ago as "Yesterday" (Oct 16 21:03
  // read as Yesterday on Oct 18), so the header did not match the real date.
  var midnight = function (x) {
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  };
  var days = Math.round((midnight(now) - midnight(d)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  // Older than yesterday: one header per real date, so the list reads
  // Today, Yesterday, then each previous date in turn (newest first).
  var opts = { weekday: "short", day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
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
