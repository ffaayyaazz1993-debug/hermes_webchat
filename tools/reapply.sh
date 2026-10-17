#!/usr/bin/env bash
# Re-apply the local Hermes-agent patches that `hermes update` overwrites.
#
# These two files live in the Hermes install itself, so an update reverts them:
#   tools/terminal_tool.py                 long-command promotion + progress ping
#   gateway/platforms/api_server.py        carry tool result/duration on tool.completed
#
# Everything in ../static (the WebChat UI) is in THIS repo, outside the agent tree,
# and is never touched by an update.
#
# Usage:  bash reapply.sh          # apply if missing
#         bash reapply.sh --check  # report state only, change nothing
set -u

AGENT="${HERMES_SRC:-C:/Users/ffaay/AppData/Local/hermes/hermes-agent}"
# git is a NATIVE Windows binary and MSYS does not translate /c/... paths for it, so
# build the patch path with pwd -W (the Windows form). Passing an MSYS path makes
# `git apply` fail with "can't open patch ... No such file or directory".
HERE="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"
PATCH="$HERE/hermes_local_patches.patch"
BASE="$(cat "$HERE/.patch_base_commit" 2>/dev/null || echo unknown)"
FILES=(tools/terminal_tool.py gateway/platforms/api_server.py)

if [ ! -f "$PATCH" ]; then
  echo "missing patch file: $PATCH" >&2
  exit 1
fi

echo "agent : $AGENT"
echo "base  : ${BASE:0:12}   (patched against this commit)"
echo "now   : $(git -C "$AGENT" rev-parse HEAD 2>/dev/null)"
echo

if git -C "$AGENT" diff --quiet -- "${FILES[@]}"; then
  state="UNPATCHED"
else
  state="PATCHED"
fi
echo "state : $state"
git -C "$AGENT" diff --stat -- "${FILES[@]}" 2>/dev/null

if [ "$state" = "PATCHED" ]; then
  echo
  echo "nothing to do."
  exit 0
fi

if [ "${1:-}" = "--check" ]; then
  echo
  echo "would apply: $PATCH"
  if git -C "$AGENT" apply --check "$PATCH"; then
    echo "check : applies cleanly"
  else
    echo "check : exact apply would fail (upstream moved) -- a 3-way merge may still work" >&2
    exit 1
  fi
  exit 0
fi

echo
# Exact apply first (the normal case right after an update); 3-way as a fallback when
# upstream shifted the surrounding lines.
if git -C "$AGENT" apply "$PATCH" 2>/dev/null; then
  echo "-> applied (exact)"
elif git -C "$AGENT" apply --3way "$PATCH"; then
  echo "-> applied (3-way merge)"
else
  echo "-> git apply FAILED (upstream changed under the patch). Apply by hand:" >&2
  echo "   $PATCH" >&2
  exit 1
fi
git -C "$AGENT" diff --stat -- "${FILES[@]}"

cat <<'EOF'

REMINDER -- the api_server change only takes effect in a NEW process, so restart
the WebChat server (it imports APIServerAdapter in-process):

  netstat -ano | grep ':8790' | grep LISTENING        # note the PID
  powershell.exe -Command "Stop-Process -Id <PID> -Force"
  cd /c/Users/ffaay/hermes_webchat && HERMES_DISABLE_LAZY_INSTALLS=1 NO_COLOR=1 \
    "C:/Users/ffaay/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe" \
    server.py --port 8790 > /tmp/webchat.log 2>&1 &

The terminal_tool change needs a new agent process too (any fresh CLI session).
EOF
