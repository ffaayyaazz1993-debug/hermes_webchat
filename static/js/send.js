function setBusy(on) {
  busy = on;
  sendBtn.classList.toggle("stop", on);
  sendBtn.title = on ? "Stop generating (Esc)" : "Send (Enter)";
  sendBtn.setAttribute("aria-label", on ? "Stop generating" : "Send");
  sendIcon.innerHTML = on
    ? '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>'
    : '<path d="M12 19V5M5 12l7-7 7 7"/>';
  setStatus(on ? "generating…" : "ready", on ? "busy" : "ok");
  updateCompressBtn();
}

function send(text) {
  if (text && text.trim()) {
    var t = text.trim();
    if (userHistory[userHistory.length - 1] !== t) userHistory.push(t);
    if (userHistory.length > 200) userHistory.shift();
  }
  if (busy || !text || !text.trim()) return;
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
  runTurn(text, imgs, pdfs).then(function () {
    // Name the conversation from its first user message once the turn lands (the
    // backend reads the persisted transcript, so it must run after the turn).
    if (sessionId) maybeAutoName(sessionId, text);
    return refreshStats().then(refreshSidebar);
  }, refreshSidebar);
}

function runTurn(text, images, pdfs) {
  var p = sessionId ? Promise.resolve(sessionId) : newSession();
  return p.then(function () {
    controller = new AbortController();
    startLive();
    var terminal = false;
    // Measured, not invented: the CLI keeps latency/velocity in the live agent's
    // deques, which do not exist here (a fresh agent per turn). Wall-clock from
    // request to run.completed plus the provider's own output_tokens give the same
    // two numbers without another call.
    var t0 = performance.now(), outTok = null;
    activityReset();               // new turn: fresh structure tree
    loadThinking();                 // warm the face/verb lists for instant paint
    setThinking("thinking");        // shows while Hermes thinks, before any output
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
    return fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/chat/stream", {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json", "Accept": "text/event-stream" },
        KEY ? { "Authorization": "Bearer " + KEY } : {}),
      body: JSON.stringify({ message: msgBody }),
      signal: controller.signal
    }).then(function (res) {
      if (res.status === 401) throw new Error("Unauthorized - the API key was rejected.");
      if (!res.ok || !res.body) {
        return res.text().then(function (t) {
          var d = ""; try { var j = JSON.parse(t); d = (j.error && j.error.message) || ""; } catch (e) {}
          throw new Error("HTTP " + res.status + (d ? ": " + d : ""));
        });
      }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
      function handleFrame(frame) {
        if (!frame.trim() || frame.charAt(0) === ":") return;
        var name = "message", data = "";
        frame.split("\n").forEach(function (line) {
          if (line.indexOf("event:") === 0) name = line.slice(6).trim();
          else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
        });
        var pl; try { pl = JSON.parse(data || "{}"); } catch (e) { return; }
        if (name === "assistant.delta" && pl.delta) {
          if (live.text) hideThinking();          // real output started
          live.text += pl.delta; updateLive();
          activityOutputDelta(pl.delta);
        }
        else if (name === "reasoning" || name === "thinking.delta") { setThinking("thinking"); }
        else if (name === "tool.progress" && pl.tool_name === "_thinking" && pl.delta) {
          activityThinking(pl.delta);
          setThinking("thinking");
        }
        else if (name === "assistant.commentary" && pl.text) {
          activityCommentary(pl.text);
        }
        else if (name === "tool.started") {
          addToolLine(pl.tool_name || "tool", pl.preview, false);
          setThinking("tool", pl.tool_name || "tool");
          activityToolStarted(pl.tool_name || "tool", pl.preview, pl.args);
        }
        else if (name === "tool.completed") {
          addToolLine("\u2713 " + (pl.tool_name || "tool"), pl.preview, false);
          setThinking("thinking");
          activityToolCompleted(pl.tool_name || "tool", true, pl.duration, pl.result_preview);
        }
        else if (name === "tool.failed") {
          addToolLine("\u2717 " + (pl.tool_name || "tool"), pl.preview, true);
          setThinking("thinking");
          activityToolCompleted(pl.tool_name || "tool", false, pl.duration, pl.result_preview);
        }
        else if (name === "assistant.completed") {
          if (pl.content && !live.text) { live.text = pl.content; updateLive(); }
          act().apiCalls++;
          activityOutputDone();
          terminal = true;
        }
        else if (name === "error") { addMsg("error", pl.message || "The run failed."); activityTurnDone(); terminal = true; }
        else if (name === "run.completed" || name === "done") {
          if (pl && pl.usage && pl.usage.output_tokens != null) outTok = Number(pl.usage.output_tokens);
          if (name === "run.completed") {
            activityTurnDone();
            var secs = (performance.now() - t0) / 1000;
            lastTurn = { seconds: secs, outputTokens: outTok };
            if (outTok && secs > 0) lastTurn.tokPerSec = outTok / secs;
            refreshStats();          // durable counters are written by now
            renderStats(null, lastTurn);
          }
          terminal = true;
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
        hideThinking();
        finishLive();
        if (!terminal) addMsg("system", "The stream ended without a reply. Check the server log.");
        setStatus("ready", "ok");
      });
    });
  }).catch(function (err) {
    hideThinking();
    finishLive();
    if (err && err.name === "AbortError") addMsg("system", "Stopped.");
    else { addMsg("error", (err && err.message) || String(err)); setStatus("error", "err"); toast((err && err.message) || String(err)); }
  }).then(function () {
    busy = false; controller = null; setBusy(false);
  }, function (err) {
    hideThinking();
    finishLive();
    addMsg("error", (err && err.message) || String(err));
    busy = false; controller = null; setBusy(false);
  });
}
