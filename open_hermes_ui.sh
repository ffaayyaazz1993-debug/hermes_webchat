#!/usr/bin/env bash
# Open Hermes Web, Bot Room and the Kanban board in one CDP-enabled Chrome window.
#
#   ./open_hermes_ui.sh
#
# Three tabs, one window. Starts the three servers if they are not already up,
# launches Chrome DETACHED with --remote-debugging-port=9222, then waits for the
# CDP endpoint to answer instead of assuming the port opened.
#
# Detached on purpose: a Chrome owned by a tracked background job makes the Hermes
# gateway report "still waiting for the other Hermes process" on every message.
set -uo pipefail

WEBCHAT_PORT=8790
BOTROOM_PORT=8800
KANBAN_PORT=9119
CDP_PORT=9222
HERMES_PY="C:/Users/ffaay/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe"

say() { printf '%s\n' "$*"; }
http() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null; }

# ---------------------------------------------------------------- servers ----
start_server() {
  local name="$1" dir="$2" port="$3"
  if [ "$(http "http://127.0.0.1:${port}/")" = "200" ]; then
    say "  ${name} already up on ${port}"
    return 0
  fi
  if netstat -ano | grep -q ":${port} .*LISTENING"; then
    say "  WARNING: something already listens on ${port} but returns non-200 --"
    say "           leaving it alone rather than starting a second copy."
    return 0
  fi
  say "  starting ${name} on ${port}"
  ( cd "$dir" && HERMES_DISABLE_LAZY_INSTALLS=1 NO_COLOR=1 \
      "$HERMES_PY" server.py --port "$port" >"/tmp/${name}.log" 2>&1 & )
  for _ in $(seq 1 25); do
    [ "$(http "http://127.0.0.1:${port}/")" = "200" ] && { say "  ${name} ready"; return 0; }
    sleep 1
  done
  say "  WARNING: ${name} did not come up -- see /tmp/${name}.log"
}

say "Hermes services:"
start_server webchat  C:/Users/ffaay/hermes_webchat "$WEBCHAT_PORT"
start_server botroom  C:/Users/ffaay/hermes_botroom "$BOTROOM_PORT"
# Kanban (9119) is the Hermes CLI dashboard, NOT hermes_webchat/server.py. Pointing
# the launcher at webchat's server bound a SECOND copy of the chat app to 9119, so
# the "kanban" tab silently rendered the webchat instead of the board.
if [ "$(http "http://127.0.0.1:${KANBAN_PORT}/")" = "200" ]; then
  say "  kanban already up on ${KANBAN_PORT}"
else
  say "  starting hermes dashboard (kanban) on ${KANBAN_PORT}"
  ( hermes dashboard --port "$KANBAN_PORT" --no-open >"/tmp/kanban.log" 2>&1 & )
  for _ in $(seq 1 30); do
    [ "$(http "http://127.0.0.1:${KANBAN_PORT}/")" = "200" ] && { say "  kanban ready"; break; }
    sleep 1
  done
fi

# Verify each service is actually the app it claims to be. The wrong app on a port
# returns 200 and hides the mistake.
verify() {
  local port="$1" want="$2" got
  # No head/head -c: these markers sit well past 4KB, so truncating reported a false
  # "wrong app" for two services that were serving correctly.
  got=$(curl -s "http://127.0.0.1:${port}/" --max-time 6 | tr -d '\r\n')
  case "$got" in
    *"$want"*) say "  ${port}: ${want} OK" ;;
    *) say "  WARNING: ${port} is not serving ${want} -- wrong app bound to that port" ;;
  esac
}
verify "$WEBCHAT_PORT" "composer"
verify "$BOTROOM_PORT" "Message the room"
verify "$KANBAN_PORT"  "Hermes Agent"

# ----------------------------------------------------------------- chrome ----
CDP_JSON="http://127.0.0.1:${CDP_PORT}/json/version"
if [ "$(http "$CDP_JSON")" = "200" ]; then
  say ""
  say "CDP already listening on ${CDP_PORT} -- opening tabs in the existing window."
  URLS=()
  for u in "http://127.0.0.1:${WEBCHAT_PORT}/" \
           "http://127.0.0.1:${BOTROOM_PORT}/" \
           "http://127.0.0.1:${KANBAN_PORT}/"; do
    # PUT, not GET: /json/new rejects GET with 405.
    curl -s -X PUT "http://127.0.0.1:${CDP_PORT}/json/new?$u" >/dev/null 2>&1
  done
  say "  3 tabs requested"
else
  say ""
  say "Launching Chrome with remote debugging on ${CDP_PORT}..."
  SCRIPT="C:/Users/ffaay/AppData/Local/hermes/skills/software-development/windows-hermes-browser/scripts/launch_chrome_cdp.ps1"
  for u in "http://127.0.0.1:${WEBCHAT_PORT}/" \
           "http://127.0.0.1:${BOTROOM_PORT}/" \
           "http://127.0.0.1:${KANBAN_PORT}/"; do
    # Bounded: the PowerShell launcher can block on a Chrome that is already running,
    # and this script must return rather than hang the terminal.
    timeout 40 powershell -ExecutionPolicy Bypass -File "$SCRIPT" -StartUrl "$u" \
      >/dev/null 2>&1 || true
  done
fi

# The launcher returns before the socket is listening; poll instead of trusting it.
for _ in $(seq 1 20); do
  [ "$(http "$CDP_JSON")" = "200" ] && break
  sleep 1
done

if [ "$(http "$CDP_JSON")" = "200" ]; then
  say ""
  say "CDP up: $(curl -s "$CDP_JSON" | sed -n 's/.*"Browser": *"\([^"]*\)".*/\1/p')"
  say ""
  missing=0
  for p in "$WEBCHAT_PORT" "$BOTROOM_PORT" "$KANBAN_PORT"; do
    curl -s "http://127.0.0.1:${CDP_PORT}/json/list" \
      | grep -q "127.0.0.1:${p}/" || { say "  MISSING tab for port ${p}"; missing=1; }
  done
  say ""
  say "Open tabs:"
  curl -s "http://127.0.0.1:${CDP_PORT}/json/list" \
    | grep -o '"url": *"http://127.0.0.1:[0-9]*[^"]*"' \
    | sed 's/.*"url": *"\(.*\)"/  \1/' | sort -u
else
  say ""
  say "CDP did NOT come up on ${CDP_PORT}. Close every Chrome window fully and re-run."
  exit 1
fi