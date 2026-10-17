"use strict";
var BOOT = (function () {
  var el = document.getElementById("hermes-boot");
  try { return JSON.parse(el.textContent); } catch (e) { return {}; }
})();
var KEY = BOOT.apiKey || "";
var MODEL = "hermes-agent";
var SESSION_KEY = "hermes_webchat_session";

function $(id) { return document.getElementById(id); }
var thread = $("thread"), threadInner = $("thread-inner"), input = $("input"),
    sendBtn = $("send"), sendIcon = $("sendIcon"), sbList = $("sbList"),
    statusText = $("statusText"), dot = $("dot"), toastEl = $("toast"),
    convTitle = $("convTitle");

var sessionId = null, busy = false, controller = null, live = null,
    sessions = [], toastT = null, lastSentUserEl = null;
var turns = {};         // sessionId -> in-flight turn; see send.js
var userHistory = [];   // previous user messages, for ghost auto-guess
var ghostSuggest = null; // current suggestion string (null = none)
