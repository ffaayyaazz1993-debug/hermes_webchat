// Faces and verbs come from the server, which reads agent.display.KawaiiSpinner --
// the CLI's own lists, honouring the active skin. A local copy would drift.
var THINK = null, thinkTimer = null, thinkI = 0, thinkMode = null, thinkTool = "";

function loadThinking() {
  if (THINK) return Promise.resolve(THINK);
  return apiJSON("/webchat/thinking").then(function (d) {
    THINK = { faces: d.faces || [], verbs: d.verbs || [] };
    return THINK;
  }, function () { THINK = { faces: [], verbs: [] }; return THINK; });
}

function hideThinking() {
  var el = $("thinking");
  if (el) { el.hidden = true; el.textContent = ""; }
  if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
  thinkMode = null; thinkTool = "";
}

function drawThinking() {
  var el = $("thinking");
  if (!el || !thinkMode) return;
  var faces = (THINK && THINK.faces) || [];
  var verbs = (THINK && THINK.verbs) || [];
  var face = faces.length ? faces[thinkI % faces.length] : "";
  var verb = verbs.length ? verbs[thinkI % verbs.length] : "thinking";
  thinkI++;   // advance AFTER reading both, so face and verb stay paired
  el.textContent = "";
  if (face) { var f = document.createElement("span"); f.className = "face"; f.textContent = face; el.appendChild(f); }
  var v = document.createElement("span");
  v.className = "verb"; v.textContent = verb;
  el.appendChild(v);
  // Once a tool starts, the verb is noise -- say what is actually running.
  if (thinkMode === "tool" && thinkTool) {
    v.className = "tool";
    v.textContent = thinkTool;
  }
  var d = document.createElement("span");
  d.className = "dots";
  el.appendChild(d);
}

// mode: "thinking" before any output, "tool" once a tool runs, null to hide.
function setThinking(mode, toolName) {
  var el = $("thinking");
  if (!el) return;
  if (!mode) { hideThinking(); return; }
  var changed = mode !== thinkMode;
  thinkMode = mode;
  if (toolName) thinkTool = toolName;
  el.hidden = false;
  if (changed) thinkI = Math.floor(Math.random() * 1000);   // desync between turns
  drawThinking();
  if (!thinkTimer) thinkTimer = setInterval(drawThinking, 1900);
}
