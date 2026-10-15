#!/usr/bin/env bash
# Open Hermes Web, Bot Room and the Kanban board in ONE Edge window with CDP.
# Single command to run:  bash C:/Users/ffaay/hermes_webchat/open_hermes_edge.sh
set -uo pipefail

WEBCHAT_PORT=8790
BOTROOM_PORT=8800
KANBAN_PORT=9119
CDP_PORT=9222
HERMES_PY="C:/Users/ffaay/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe"
EDGE_PROFILE="C:/Users/ffaay/AppData/Local/hermes/edge-cdp"

say() { printf '%s\n' "$*"; }
http() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null; }

start_server() {
  local name="$1" dir="$2" port="$3"
  if [ "$(http "http://127.0.0.1:${port}/")" = "200" ]; then
    say "  ${name} already up on ${port}"
    return 0
  fi
  if netstat -ano 2>/dev/null | grep -q ":${port} .*LISTENING"; then
    say "  WARNING: something already listens on ${port} but returns non-200"
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

verify() {
  local port="$1" want="$2" got
  got=$(curl -s "http://127.0.0.1:${port}/" --max-time 6 | tr -d '\r\n')
  case "$got" in
    *"$want"*) say "  ${port}: ${want} OK" ;;
    *) say "  WARNING: ${port} is not serving ${want}" ;;
  esac
}
verify "$WEBCHAT_PORT" "composer"
verify "$BOTROOM_PORT" "Message the room"
verify "$KANBAN_PORT"  "Hermes Agent"

# --- Edge CDP ---
say ""
say "Launching Edge with remote debugging on ${CDP_PORT}..."
powershell.exe -Command "Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1
sleep 3
mkdir -p "$EDGE_PROFILE"
powershell.exe -Command "Start-Process 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' -ArgumentList '--remote-debugging-port=${CDP_PORT}','--remote-allow-origins=*','--user-data-dir=${EDGE_PROFILE}','--no-first-run','--no-default-browser-check','--new-window','http://127.0.0.1:${WEBCHAT_PORT}/','http://127.0.0.1:${BOTROOM_PORT}/','http://127.0.0.1:${KANBAN_PORT}/kanban'" >/dev/null 2>&1

for _ in $(seq 1 20); do
  [ "$(http "http://127.0.0.1:${CDP_PORT}/json/version")" = "200" ] && break
  sleep 1
done

if [ "$(http "http://127.0.0.1:${CDP_PORT}/json/version")" = "200" ]; then
  say ""
  say "CDP up: $(curl -s http://127.0.0.1:${CDP_PORT}/json/version | sed -n 's/.*\"Browser\": *\"\([^\"]*\)\".*/\1/p')"
  say ""
  say "Open tabs:"
  curl -s "http://127.0.0.1:${CDP_PORT}/json/list" \
    | grep -o '"url": *"[^"]*"' | sed 's/.*"url": *"\(.*\)"/  \1/' | sort -u
else
  say ""
  say "CDP did NOT come up on ${CDP_PORT}."
  exit 1
fi