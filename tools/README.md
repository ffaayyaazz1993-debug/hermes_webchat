# Local Hermes-agent patches

Two changes live inside the Hermes install itself, so **`hermes update` reverts them**.
This directory holds the exact diff plus a one-command restore.

    bash C:/Users/ffaay/hermes_webchat/tools/reapply.sh          # apply if missing
    bash C:/Users/ffaay/hermes_webchat/tools/reapply.sh --check  # report only

## What is patched, and why

| File | Change | Breaks if reverted |
| --- | --- | --- |
| `tools/terminal_tool.py` | An explicit `timeout` above `LONG_COMMAND_THRESHOLD` (300s) runs as a tracked background job with a progress ping every `PROMOTED_HEARTBEAT_SECONDS` (120s), instead of blocking the turn blind. | Long commands block silently; no periodic check-in. |
| `gateway/platforms/api_server.py` | `tool.completed` frames carry `result`, `duration` and `is_error` (the executor already passed all three; the adapter dropped them). | The WebChat's inline tool rows render with an **empty OUTPUT section** — no tool output anywhere in the UI. |

## What is NOT patched

The whole WebChat UI (`static/`, `server.py`, `open_hermes_edge.sh`) lives in
`C:/Users/ffaay/hermes_webchat`, a separate repo outside the agent tree.
**`hermes update` does not touch it** — the inline collapsible tool rows, the
removal of the activity strip, the per-session turn handling: all safe.

## After re-applying

Both files are imported once per process, so:

- `api_server.py` -> **restart the WebChat server** (it subclasses `APIServerAdapter`
  in-process), or tool output stays empty.
- `terminal_tool.py` -> needs a fresh agent process; any new CLI session picks it up.

## If the patch stops applying

`git apply --3way` merges against the new upstream. If it fails, upstream changed the
lines the patch touches — read the failure, apply the same two edits by hand, then
regenerate this patch:

    AGENT=C:/Users/ffaay/AppData/Local/hermes/hermes-agent
    git -C "$AGENT" diff -- tools/terminal_tool.py gateway/platforms/api_server.py \
      > C:/Users/ffaay/hermes_webchat/tools/hermes_local_patches.patch
    git -C "$AGENT" rev-parse HEAD \
      > C:/Users/ffaay/hermes_webchat/tools/.patch_base_commit
