function autosize() { autosizeEl(input); }
function autosizeEl(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, Math.floor(window.innerHeight * 0.42)) + "px";
}
input.addEventListener("input", function () {
  autosize();
  updateGhost();
  if (SKILLS === null) { loadSkills().then(renderSlash); return; }
  renderSlash();
});
input.addEventListener("scroll", function () {
  var ghost = $("ghost");
  if (ghost) ghost.scrollTop = input.scrollTop;
});
// Ghost auto-suggest from history (like CLI inline guess).
function updateGhost() {
  var ghost = $("ghost");
  if (!ghost) return;
  var val = input.value;
  if (!val || val.length < 2 || val.startsWith("/")) {
    ghostSuggest = null;
    ghost.innerHTML = "";
    return;
  }
  var lower = val.toLowerCase();
  var best = null;
  for (var i = userHistory.length - 1; i >= 0; i--) {
    var h = userHistory[i];
    if (h && h.length > val.length && h.toLowerCase().indexOf(lower) === 0) {
      best = h;
      break;
    }
  }
  if (!best) { ghostSuggest = null; ghost.innerHTML = ""; return; }
  var rest = best.slice(val.length);
  ghostSuggest = rest;
  ghost.innerHTML = '<span class="typed"></span><span class="suggest"></span>';
  ghost.firstChild.textContent = val;
  ghost.lastChild.textContent = rest;
}
function acceptGhost() {
  if (!ghostSuggest) return false;
  input.value += ghostSuggest;
  input.selectionStart = input.selectionEnd = input.value.length;
  ghostSuggest = null;
  $("ghost").innerHTML = "";
  autosize();
  return true;
}
// Paste: insert clipboard text verbatim (never interpreted as HTML) and grow to fit.
input.addEventListener("paste", function (e) {
  var text = (e.clipboardData || window.clipboardData).getData("text");
  if (!text) return;
  e.preventDefault();
  var start = input.selectionStart, end = input.selectionEnd;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + text.length;
  autosize();
});
input.addEventListener("keydown", function (e) {
  // The palette owns the keyboard while it is open: Tab completes, arrows move,
  // Enter accepts, Escape dismisses -- and plain Enter must NOT send a bare "/".
  var pal = $("slash-palette");
  var palOpen = pal && !pal.hidden && slashMatches.length;
  if (palOpen) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      var rows = pal.querySelectorAll(".slash-row");
      if (!rows.length) return;
      slashSel = (slashSel + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      for (var i = 0; i < rows.length; i++) rows[i].classList.toggle("sel", i === slashSel);
      rows[slashSel].scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      applySlash(slashMatches[slashSel].command);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (slashMatches.length) { applySlash(slashMatches[slashSel].command); return; }
      closeSlash();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSlash();
      return;
    }
  }
  if ((e.key === "Tab" || e.key === "End") && ghostSuggest) {
    e.preventDefault();
    acceptGhost();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (!busy) send(input.value);
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (!busy) send(input.value);
  } else if (e.key === "Escape" && busy && controller) {
    e.preventDefault();
    controller.abort();
  }
  // Shift+Enter is deliberately NOT handled: the browser inserts the newline.
});
// Clicking away dismisses the palette.
input.addEventListener("blur", function () { setTimeout(closeSlash, 120); });
sendBtn.addEventListener("click", function () {
  closeSlash();
  if (busy && controller) controller.abort(); else send(input.value);
});
