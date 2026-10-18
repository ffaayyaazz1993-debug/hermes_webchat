// ---------------------------------------------------------------------------
// In-flight turns, keyed by session id (the `turns` global lives in core.js).
//
// A turn keeps streaming when the user opens another chat: its SSE reader stays
// bound to its own session, deltas accumulate on the turn's own DOM node, and
// that node is re-attached by loadSession if the user comes back before the
// reply lands. Only the chat on screen paints -- a background turn's events
// never touch the visible transcript (its notes queue on the turn instead).
//
// `busy`, `controller` and `live` remain module-level aliases for whichever turn
// the OPEN chat owns, so the rest of the UI (composer, Esc-to-stop, Retry/Edit,
// the compress button) keeps working without knowing about the map.
// ---------------------------------------------------------------------------

function turnFor(sid) { return sid ? turns[sid] : null; }

// Re-point the aliases at the chat on screen. Called on every switch, and when a
// turn starts or ends.
function syncTurnAliases() {
  var t = turnFor(sessionId);
  busy = !!(t && t.busy);
  controller = (t && t.busy) ? t.controller : null;
  live = (t && t.busy && t.live) ? t.live : null;
  setBusyUI(busy);
}

function setBusyUI(on) {
  setStatus(on ? "generating…" : "ready", on ? "busy" : "ok");
  updateCompressBtn();
  updateSendBtn();
}

// The composer stays live while a turn streams: with text in it the button STEERS the
// running reply, empty it STOPS it. Esc always stops.
function updateSendBtn() {
  var steer = busy && input.value.trim().length > 0;
  sendBtn.classList.toggle("stop", busy && !steer);
  var title = !busy ? "Send (Enter)"
            : steer ? "Send into the running reply (steer)"
            : "Stop generating (Esc)";
  sendBtn.title = title;
  sendBtn.setAttribute("aria-label", title);
  sendIcon.innerHTML = (busy && !steer)
    ? '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>'
    : '<path d="M12 19V5M5 12l7-7 7 7"/>';
}

// Kept for callers that only ever act on the chat on screen.
function setBusy(on) { busy = on; setBusyUI(on); }

// A note raised by a turn that is NOT the one on screen must not land in the
// visible transcript -- it queues on the turn and is painted on return.
function turnMsg(turn, role, text) {
  if (!turn || turn.sid === sessionId) { addMsg(role, text); return; }
  turn.notes.push({ role: role, text: text });
}

// ── Mid-turn steering ──────────────────────────────────────────────────────────────
// POST /v1/runs/{run_id}/steer -> agent.steer() -> the text is queued and delivered as
// its own user row once the current tool batch finishes. The turn is NOT interrupted and
// no new turn starts. run_id comes from the run.started frame, which is the first one.
function _waitRunId(turn, tries) {
  if (turn.runId) return Promise.resolve(turn.runId);
  if (!turn.busy || tries <= 0) return Promise.resolve(null);
  return new Promise(function (r) { setTimeout(r, 150); })
    .then(function () { return _waitRunId(turn, tries - 1); });
}

function steerTurn(text) {
  var t = (text || "").trim();
  var turn = turnFor(sessionId);
  if (!t || !turn || !turn.busy) return false;
  input.value = ""; autosize(); updateSendBtn();
  var node = addMsg("user", t, { steer: true });   // optimistic, like a normal send
  scrollDown();
  _waitRunId(turn, 40).then(function (rid) {
    if (!rid) throw new Error("the reply is not accepting steer input");
    return _steerPost(rid, t, 60, turn);
  }).catch(function (e) {
    if (node && node.wrap && node.wrap.parentNode) node.wrap.parentNode.removeChild(node.wrap);
    toast("Steer failed: " + ((e && e.message) || e));
    input.value = t; autosize(); updateSendBtn();   // hand the text back
  });
  return true;
}

// A run only accepts steer input once its agent is registered, which is a few seconds
// into a turn -- before that the endpoint answers 409 run_not_accepting_steer (measured:
// 409 at +0.1s, accepted at +8.8s). The user typed it, so retry until it lands or the
// turn ends rather than silently dropping it.
function _steerPost(rid, text, tries, turn) {
  return fetch("/v1/runs/" + encodeURIComponent(rid) + "/steer", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" },
                           KEY ? { "Authorization": "Bearer " + KEY } : {}),
    body: JSON.stringify({ input: text })
  }).then(function (res) {
    if (res.ok) return true;
    if (res.status === 409 && tries > 0 && turn.busy) {
      return new Promise(function (r) { setTimeout(r, 700); })
        .then(function () { return _steerPost(rid, text, tries - 1, turn); });
    }
    return res.text().then(function (body) {
      var d = "";
      try { var j = JSON.parse(body); d = (j.error && j.error.message) || ""; } catch (e) {}
      throw new Error(d || ("HTTP " + res.status));
    });
  });
}

function send(text) {
  if (text && text.trim()) {
    var t = text.trim();
    if (userHistory[userHistory.length - 1] !== t) userHistory.push(t);
    if (userHistory.length > 200) userHistory.shift();
  }
  if (!text || !text.trim()) return;
  // /capabilities is handled entirely in the browser -- it renders a table from
  // GET /webchat/capabilities and never spends a model turn.
  var cmd = text.trim().toLowerCase();
  if (cmd === "/capabilities" || cmd === "/caps") {
    input.value = ""; autosize(); hideWelcome();
    showCapabilities();
    return;
  }
  // /model is also browser-side: it reads GET /webchat/models and POSTs to
  // /webchat/model, so picking a model never spends a model turn.
  if (cmd === "/model" || cmd.indexOf("/model ") === 0) {
    input.value = ""; autosize(); hideWelcome();
    showModel(text.trim().slice(6).trim());
    return;
  }
  // A turn is already streaming: STEER it rather than refusing. Slash commands are left
  // alone -- they are not conversation, and steering "/compress" would be nonsense.
  if (busy) {
    if (cmd.charAt(0) !== "/") steerTurn(text);
    return;
  }
  setBusy(true);
  hideWelcome();
  var imgs = pendingImages.slice(); pendingImages = [];
  var pdfs = pendingPdfs.slice(); pendingPdfs = [];
  renderAttachments();
  var u = addMsg("user", text, { ts: Date.now() / 1000, images: imgs });
  addControls(u.wrap, "user");
  // Track the DOM node of the user turn we are about to create, so Retry/Edit can
  // rewind the transcript to exactly this point. Without it a Retry on a just-sent
  // message has no server id to truncate at and would re-append the user turn
  // (observed: two identical user bubbles after one Retry).
  lastSentUserEl = u.wrap;
  input.value = ""; autosize();
  runTurn(text, imgs, pdfs).then(function (sid) {
    // Name the conversation from its first user message once the turn lands (the
    // backend reads the persisted transcript, so it must run after the turn).
    if (sid) maybeAutoName(sid, text);
    return refreshStats().then(refreshSidebar);
  }, refreshSidebar);
}

function runTurn(text, images, pdfs) {
  var p = sessionId ? Promise.resolve(sessionId) : newSession();
  var turn = null;
  return p.then(function () {
    var sid = sessionId;
    turn = {
      sid: sid, controller: new AbortController(), live: null,
      busy: true, notes: [], terminal: false, outTok: null, runId: null
    };
    turns[sid] = turn;
    if (sid === sessionId) { busy = true; controller = turn.controller; setBusyUI(true); }
    refreshSidebar();          // the row for this chat now carries a "generating" dot
    var t0 = performance.now();
    if (sid === sessionId) {
      setThinking("thinking");       // shows while Hermes thinks, before any output
    }
    loadThinking();                  // warm the face/verb lists for instant paint
    startLive(turn);
    var msgBody = text || "";
    if ((images && images.length) || (pdfs && pdfs.length)) {
      var parts = [];
      if (text && text.trim()) parts.push({ type: "text", text: text });
      (pdfs || []).forEach(function (p) {
        parts.push({ type: "text", text: 'Attached PDF "' + (p.name || "attachment.pdf") + '" (extracted text):\n\n' + (p.text || "") });
      });
      (images || []).forEach(function (url) {
        parts.push({ type: "image_url", image_url: { url: url } });
      });
      msgBody = parts;
    }
    return fetch("/api/sessions/" + encodeURIComponent(sid) + "/chat/stream", {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json", "Accept": "text/event-stream" },
        KEY ? { "Authorization": "Bearer " + KEY } : {}),
      body: JSON.stringify({ message: msgBody }),
      signal: turn.controller.signal
    }).then(function (res) {
      if (res.status === 401) throw new Error("Unauthorized - the API key was rejected.");
      if (!res.ok || !res.body) {
        return res.text().then(function (t) {
          var d = ""; try { var j = JSON.parse(t); d = (j.error && j.error.message) || ""; } catch (e) {}
          throw new Error("HTTP " + res.status + (d ? ": " + d : ""));
        });
      }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
      // Everything below writes to the TURN, never to the visible transcript,
      // unless this turn's chat is the one on screen.
      function seen() { return turn.sid === sessionId; }
      function handleFrame(frame) {
        if (!frame.trim() || frame.charAt(0) === ":") return;
        var name = "message", data = "";
        frame.split("\n").forEach(function (line) {
          if (line.indexOf("event:") === 0) name = line.slice(6).trim();
          else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
        });
        var pl; try { pl = JSON.parse(data || "{}"); } catch (e) { return; }
        var on = seen();
        // A steer is addressed to the run, so capture its id for every turn -- including
        // one whose chat is not on screen. run.started is the first frame of the stream.
        if (name === "run.started" && pl.run_id) turn.runId = pl.run_id;
        if (name === "assistant.delta" && pl.delta) {
          if (turn.live) {
            if (on && turn.live.text) hideThinking();     // real output started
            turn.live.text += pl.delta;
          }
          if (on) updateLive(turn);
        }
        else if (name === "reasoning" || name === "thinking.delta") { if (on) setThinking("thinking"); }
        else if (name === "tool.progress" && pl.tool_name === "_thinking" && pl.delta) {
          if (on) setThinking("thinking");
        }
        else if (name === "tool.started") {
          addToolLine(turn, pl.tool_name || "tool", pl.preview, pl.args);
          if (on) setThinking("tool", pl.tool_name || "tool");
        }
        else if (name === "tool.completed") {
          // pl.result / pl.duration come from the api_server patch; result_preview is the
          // older, often-empty field, kept as a fallback so this still works unpatched.
          completeToolLine(turn, pl.tool_name || "tool", !pl.is_error,
                           pl.duration, pl.result || pl.result_preview, pl.preview);
          if (on) setThinking("thinking");
        }
        else if (name === "tool.failed") {
          completeToolLine(turn, pl.tool_name || "tool", false,
                           pl.duration, pl.result || pl.result_preview, pl.preview);
          if (on) setThinking("thinking");
        }
        else if (name === "subagent.start") {
          addSubagentLine(turn, pl);
          if (on) setThinking("tool", "subagent");
        }
        else if (name === "subagent.tool") {
          addSubagentTool(turn, pl);
          if (on) setThinking("tool", pl.tool || "subagent");
        }
        else if (name === "subagent.progress") {
          subagentProgress(turn, pl);
          if (on) setThinking("tool", "subagent");
        }
        else if (name === "subagent.complete") {
          completeSubagentLine(turn, pl);
          if (on) setThinking("thinking");
        }
        else if (name === "assistant.completed") {
          if (pl.content && turn.live && !turn.live.text) {
            turn.live.text = pl.content;
            if (on) updateLive(turn);
          }
          turn.terminal = true;
        }
        else if (name === "error") {
          turnMsg(turn, "error", pl.message || "The run failed.");
          turn.terminal = true;
        }
        else if (name === "run.completed" || name === "done") {
          if (pl && pl.usage && pl.usage.output_tokens != null) turn.outTok = Number(pl.usage.output_tokens);
          if (name === "run.completed") {
            if (on) {
              // Measured, not invented: the CLI keeps latency/velocity in the live
              // agent's deques, which do not exist here (a fresh agent per turn).
              // Wall-clock from request to run.completed plus the provider's own
              // output_tokens give the same two numbers without another call.
              var secs = (performance.now() - t0) / 1000;
              lastTurn = { seconds: secs, outputTokens: turn.outTok };
              if (turn.outTok && secs > 0) lastTurn.tokPerSec = turn.outTok / secs;
              refreshStats();          // durable counters are written by now
              renderStats(null, lastTurn);
            }
          }
          turn.terminal = true;
        }
      }
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var frames = buf.split("\n\n"); buf = frames.pop() || "";
          frames.forEach(handleFrame);
          return pump();
        });
      }
      return pump().then(function () {
        if (seen()) hideThinking();
        finishLive(turn);
        if (!turn.terminal) turnMsg(turn, "system", "The stream ended without a reply. Check the server log.");
      });
    });
  }).catch(function (err) {
    if (turn) finishLive(turn);
    if (!turn || turn.sid === sessionId) hideThinking();
    if (err && err.name === "AbortError") turnMsg(turn, "system", "Stopped.");
    else {
      turnMsg(turn, "error", (err && err.message) || String(err));
      if (!turn || turn.sid === sessionId) { setStatus("error", "err"); toast((err && err.message) || String(err)); }
    }
  }).then(function () {
    if (turn) {
      turn.busy = false;
      delete turns[turn.sid];
      // The reply landed while the user was in another chat: if they are looking
      // at this chat now and its live bubble never reached the transcript, pull
      // the persisted rows so the answer shows up.
      if (turn.sid === sessionId && turn.live && turn.live.text && !turn.live.wrap.isConnected) {
        loadSession(turn.sid);
      }
      refreshSidebar();
    }
    syncTurnAliases();
    return turn ? turn.sid : null;
  }, function (err) {
    if (turn) {
      finishLive(turn);
      turnMsg(turn, "error", (err && err.message) || String(err));
      turn.busy = false;
      delete turns[turn.sid];
      refreshSidebar();
    }
    syncTurnAliases();
    return turn ? turn.sid : null;
  });
}
