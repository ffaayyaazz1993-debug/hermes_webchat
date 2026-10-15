var micBtn = $("mic-btn");
var micRec = null;
var micOn = false;
if (micBtn) {
  micBtn.addEventListener("click", function () {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast("Speech recognition is not supported in this browser", "err"); return; }
    if (micOn) { if (micRec) try { micRec.stop(); } catch (e) {} return; }
    micRec = new SR();
    micRec.lang = navigator.language || "en-US";
    micRec.interimResults = false;
    micRec.continuous = true;
    var handled = 0;
    micRec.onstart = function () { micOn = true; micBtn.classList.add("listening"); micBtn.title = "Stop listening"; window.__mic = window.__mic || {}; window.__mic.started = true; window.__mic.lastError = null; toast("Listening… speak now", "ok"); };
    micRec.onresult = function (e) {
      var toAppend = "";
      for (var i = handled; i < e.results.length; i++) {
        if (e.results[i].isFinal) toAppend += " " + e.results[i][0].transcript;
      }
      handled = e.results.length;
      if (toAppend.trim()) {
        input.value = (input.value.trim() + toAppend).trim();
        if (typeof autosize === "function") autosize();
        window.__mic = window.__mic || {}; window.__mic.results = e.results.length; window.__mic.lastTranscript = toAppend.trim();
        toast("Heard: " + toAppend.trim().slice(0, 60), "ok");
      }
    };
    micRec.onerror = function (e) {
      var msg = e.error || "unknown";
      if (msg === "no-speech") msg = "No speech detected — try again";
      if (msg === "not-allowed" || msg === "service-not-allowed") msg = "Microphone permission or speech service blocked";
      if (msg === "audio-capture") msg = "No microphone detected";
      toast("Speech error: " + msg, "err");
      window.__mic = window.__mic || {}; window.__mic.lastError = e.error || "unknown";
    };
    micRec.onend = function () { micOn = false; micBtn.classList.remove("listening"); micBtn.title = "Speech to text"; window.__mic = window.__mic || {}; window.__mic.onend = true; handled = 0; };
    try { micRec.start(); }
    catch (err) { toast("Could not start microphone", "err"); }
  });
}
