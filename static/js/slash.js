// Skills come from the server, which calls Hermes' own scan_skill_commands() -- the
// same source the CLI palette uses, so the names and descriptions match exactly.
var SKILLS = null, slashSel = 0, slashMatches = [];

function loadSkills() {
  if (SKILLS) return Promise.resolve(SKILLS);
  return apiJSON("/webchat/skills").then(function (d) {
    SKILLS = d.skills || [];
    return SKILLS;
  }, function () { SKILLS = []; return SKILLS; });
}

// Only offer the palette when the caret sits in the FIRST token: "/foo" at the start is
// a command, but "see /tmp" mid-sentence is not.
function slashQuery() {
  var v = input.value, pos = input.selectionStart;
  if (pos !== v.length) return null;              // caret not at the end -> ignore
  if (v.charAt(0) !== "/") return null;
  if (/\s/.test(v)) return null;                  // already moved past the command
  return v.slice(1).toLowerCase();
}

function closeSlash() {
  var el = $("slash-palette");
  if (el) { el.hidden = true; el.textContent = ""; }
  slashMatches = [];
}
function applySlash(cmd) {
  input.value = cmd + " ";
  closeSlash();
  autosize();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function renderSlash() {
  var q = slashQuery();
  if (q === null) { closeSlash(); return false; }
  // /capabilities is a WEBCHAT command, not a Hermes skill: the table is built from
  // this install's live config, so it is offered alongside the scanned skills.
  var LOCAL = [{ command: "/capabilities", name: "Capabilities",
                 description: "Table of what this Hermes install can do" },
               { command: "/model", name: "Model",
                 description: "Show or switch the model (/model <name> [--save])" }];
  var all = LOCAL.concat(SKILLS || []);
  var pool = q ? all.filter(function (s) {
    return s.command.slice(1).indexOf(q) === 0 || s.name.toLowerCase().indexOf(q) !== -1;
  }) : all;
  // Cap the list: 190 skills is unusable to scroll, and the useful ones sort first.
  slashMatches = pool.slice(0, 60);
  slashSel = 0;
  var el = $("slash-palette");
  if (!el) return false;
  el.textContent = "";
  var head = document.createElement("div");
  head.className = "slash-head";
  head.textContent = slashMatches.length
    ? (q ? slashMatches.length + " of " + all.length + " skills" : all.length + " skills \u00b7 type to filter")
    : "Skills";
  el.appendChild(head);
  if (!slashMatches.length) {
    var e = document.createElement("div");
    e.className = "slash-empty";
    e.textContent = "No skill matches \u201c/" + q + "\u201d.";
    el.appendChild(e);
  }
  slashMatches.forEach(function (s, i) {
    var row = document.createElement("div");
    row.className = "slash-row" + (i === 0 ? " sel" : "");
    row.setAttribute("role", "option");
    var c = document.createElement("span");
    c.className = "cmd"; c.textContent = s.command;
    var d = document.createElement("span");
    d.className = "desc"; d.textContent = s.description || s.name;
    row.appendChild(c); row.appendChild(d);
    row.addEventListener("mousedown", function (ev) { ev.preventDefault(); applySlash(s.command); });
    el.appendChild(row);
  });
  el.hidden = false;
  return true;
}
