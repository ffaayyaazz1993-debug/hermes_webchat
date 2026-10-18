"""Hermes Web Chat — a lightweight local web server for the existing Hermes agent.

This does NOT reimplement any backend logic. It subclasses Hermes' own
``APIServerAdapter`` (gateway/platforms/api_server.py) and appends a single
static-UI route to the same aiohttp application. Every capability the UI uses
-- agent turns, tools, session persistence, history, streaming -- is the
upstream code path:

    POST /api/sessions                     -> self._handle_create_session
    GET  /api/sessions                     -> self._handle_list_sessions
    GET  /api/sessions/{id}/messages       -> self._handle_session_messages
    POST /api/sessions/{id}/chat/stream    -> self._handle_session_chat_stream  (SSE)
    POST /api/sessions/{id}/chat           -> self._handle_session_chat         (fallback)
    GET  /v1/models                        -> self._handle_models

The only new code is: the embedded HTML/CSS/JS front end, a config loader, and
a launcher. Auth is inherited from the adapter (bearer API_SERVER_KEY).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import secrets
import sys
from pathlib import Path
from typing import Any, Dict, Optional

LOG = logging.getLogger("hermes-webchat")

# --------------------------------------------------------------------------
# Locate + import the Hermes installation (git install under the hermes home).
# --------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent


def _hermes_src_candidates() -> list[Path]:
    home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    cands = [
        home / "hermes-agent",
        Path.home() / "AppData" / "Local" / "hermes" / "hermes-agent",
        home / "hermes-agent" / "src",
    ]
    extra = os.environ.get("HERMES_SRC")
    if extra:
        cands.insert(0, Path(extra))
    return cands


def _find_hermes_src() -> Path:
    """Locate the Hermes source tree (the directory holding gateway/platforms/api_server.py)."""
    for cand in _hermes_src_candidates():
        if (cand / "gateway" / "platforms" / "api_server.py").is_file():
            return cand
    raise SystemExit(
        "Could not locate the Hermes source tree (gateway/platforms/api_server.py).\n"
        "Set HERMES_SRC=C:/path/to/hermes-agent and retry."
    )


def _compiled_modules_this_venv() -> list[str]:
    """Top-level importable modules with a compiled extension in THIS interpreter's venv.

    Hermes imports several of these lazily (long after boot): ``pydantic_core`` when the
    OpenAI-compatible client class is first resolved, ``jiter`` on the first streamed
    response. If PM's committed environment -- built for a different CPython -- has
    already claimed ``sys.path``, those lazy imports land there and fail on the ABI.
    Importing them here, from this interpreter's own site-packages, pins them for good.
    """
    names: set[str] = set()
    try:
        import site

        for sp in site.getsitepackages():
            sp_dir = Path(sp)
            if not sp_dir.is_dir():
                continue
            for entry in sp_dir.iterdir():
                # Top-level compiled module: foo.cp311-win_amd64.pyd -> "foo"
                if entry.is_file() and entry.name.endswith((".pyd", ".so")):
                    names.add(entry.name.split(".")[0])
                    continue
                # Compiled module nested in a package: jiter/jiter.cp311-....pyd
                # -> "jiter" (pydantic_core, jiter, tiktoken extensions all look
                # like this, and each is imported lazily at request time).
                if entry.is_dir() and (entry / "__init__.py").is_file():
                    try:
                        if any(c.suffix in (".pyd", ".so") for c in entry.iterdir()):
                            names.add(entry.name)
                    except OSError:
                        continue
    except Exception as exc:  # noqa: BLE001
        LOG.debug("could not enumerate compiled modules: %s", exc)
    # Always include the pure-Python packages that only the committed env carries.
    names.update({"openai", "ruamel.yaml"})
    return sorted(names)


def _bootstrap_import_path() -> None:
    """Boot this process the way the `hermes` CLI does, without the two traps below.

    ``hermes_bootstrap`` is REQUIRED: its ``activate_dependencies()`` selects the
    committed PM environment onto ``sys.path``, and Hermes resolves openai/pydantic/
    ruamel through that selection.

    Two verified hazards on this host (see the notes inline for the repro):

    1. ``prepare_launch()`` may RELAUNCH this process via ``venv_sync.relaunch_command``,
       re-entering ``sys.argv[0]`` (our server.py) under the store interpreter, which
       has none of Hermes' deps -- the relaunch dies on ``import ruamel.yaml`` and takes
       the live server down. ``HERMES_DISABLE_LAZY_INSTALLS`` is the documented opt-out;
       it disables the relaunch and leaves ``activate_dependencies`` intact. It must be
       set BEFORE the import.

    2. That selection also puts a foreign-ABI environment on ``sys.path``. On this host
       the committed env is CPython 3.14 while this interpreter is 3.11, so any import of
       a C-extension package AFTER the bootstrap resolves into that env and dies with
       ``No module named 'pydantic_core._pydantic_core'`` on every agent turn.

       ``agent.lazy_forward`` makes this unavoidable by design: it defers
       ``from openai import OpenAI`` until the first client is built
       (``agent/process_bootstrap.py::_load_openai_cls``), i.e. long after boot. So
       pre-importing is not enough on its own -- we import the C-extension deps BEFORE
       the bootstrap (pinning them to this interpreter's venv, which is the one the CLI
       uses) and then prime the lazy proxy's cache so the deferred import is a no-op.
    """
    os.environ.setdefault("HERMES_DISABLE_LAZY_INSTALLS", "1")

    root = _find_hermes_src()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    # (2a) Pin this interpreter's C-extension packages BEFORE the bootstrap reshuffles
    # sys.path. The committed env is a different CPython on this host, so any lazily
    # imported binary module resolves into it and fails (observed in turn order:
    # pydantic_core at client construction, then jiter at the first streamed request).
    # Rather than chase them one at a time, pin every compiled module this venv owns:
    # an already-imported module cannot be displaced by a later sys.path reorder.
    for _mod in _compiled_modules_this_venv():
        try:
            __import__(_mod)
        except Exception as exc:  # noqa: BLE001 - diagnostics only, never fatal
            LOG.debug("pre-bootstrap import of %s unavailable: %s", _mod, exc)

    import hermes_bootstrap  # noqa: F401  (import side effects are the point)

    # hermes_bootstrap hardens sys.path against cwd shadowing; re-assert our root.
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    # (2b) Defeat the lazy openai.OpenAI proxy with the class we just pinned, so the
    # deferred client build cannot re-resolve openai into the foreign environment.
    try:
        import openai as _openai

        import agent.process_bootstrap as _pb

        _pb._OPENAI_CLS_CACHE = _openai.OpenAI
    except Exception as exc:  # noqa: BLE001
        LOG.debug("could not prime the lazy openai proxy: %s", exc)


_bootstrap_import_path()

# Pin PyMuPDF in this interpreter so PDF upload extraction resolves to THIS
# venv (its C extension is absent from the committed foreign-ABI env).
try:
    import fitz as _fitz  # noqa: F401
except Exception as exc:  # noqa: BLE001
    LOG.debug("PyMuPDF unavailable in this interpreter: %s", exc)


from gateway.config import PlatformConfig  # noqa: E402
from gateway.platforms.api_server import APIServerAdapter  # noqa: E402

UI_PATH = HERE / "static" / "index.html"


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
def load_config(path: Optional[Path]) -> Dict[str, Any]:
    """Load webchat config. Precedence: defaults < file < env < CLI args."""
    cfg: Dict[str, Any] = {
        "host": "127.0.0.1",   # localhost only by default -- never public without opting in
        "port": 8787,
        "api_key": "",         # auto-generated + persisted if empty
        "open_browser": False,
    }
    if path and path.is_file():
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            cfg.update({k: v for k, v in loaded.items() if v is not None})

    if os.environ.get("HERMES_WEBCHAT_PORT"):
        cfg["port"] = int(os.environ["HERMES_WEBCHAT_PORT"])
    if os.environ.get("HERMES_WEBCHAT_HOST"):
        cfg["host"] = os.environ["HERMES_WEBCHAT_HOST"]
    if os.environ.get("API_SERVER_KEY"):
        cfg["api_key"] = os.environ["API_SERVER_KEY"]
    if os.environ.get("HERMES_WEBCHAT_OPEN"):
        cfg["open_browser"] = os.environ["HERMES_WEBCHAT_OPEN"] == "1"
    return cfg


def resolve_api_key(cfg: Dict[str, Any], cfg_path: Optional[Path]) -> str:
    """Return a strong API key, generating and persisting one on first run.

    APIServerAdapter refuses to start without a >=16 char key (it dispatches
    terminal-capable work). We mint a strong one so the web UI works out of the
    box, and hand it to the browser once at page load rather than making the
    user find it.
    """
    key = (cfg.get("api_key") or "").strip()
    if len(key) >= 16:
        return key
    key = secrets.token_hex(32)
    cfg["api_key"] = key
    if cfg_path is not None:
        try:
            cfg_path.parent.mkdir(parents=True, exist_ok=True)
            cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
            try:
                os.chmod(cfg_path, 0o600)
            except OSError:
                pass
            LOG.info("Generated a new API key and saved it to %s", cfg_path)
        except OSError as exc:
            LOG.warning("Could not persist generated key (%s); using it for this run only", exc)
    return key


def assert_bind_is_safe(host: str) -> None:
    """Refuse a non-loopback bind unless the operator explicitly opted in."""
    local = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}  # 0.0.0.0 handled below
    if host in {"127.0.0.1", "localhost", "::1"}:
        return
    if host == "0.0.0.0":
        raise SystemExit(
            "Refusing to bind 0.0.0.0: the Hermes agent can run shell commands as your user.\n"
            "Use --host 127.0.0.1 (default). To expose it deliberately, run a strong\n"
            "API_SERVER_KEY, put it behind a firewall/reverse-proxy with TLS, and set\n"
            "--host <lan-ip> yourself."
        )
    if host not in local:
        raise SystemExit(
            f"Refusing to bind non-loopback host {host!r}. Pass --allow-remote to override "
            "(only do this behind a firewall with a strong API_SERVER_KEY)."
        )


# --------------------------------------------------------------------------
# The adapter subclass: upstream API + our UI. No backend logic duplicated.
# --------------------------------------------------------------------------
class WebChatAdapter(APIServerAdapter):
    """APIServerAdapter with an embedded chat UI mounted at /.

    Every /v1 and /api route is the upstream implementation, untouched.
    """

    def _http_route_table(self) -> list[tuple]:
        routes = super()._http_route_table()
        # The UI is served unauthenticated HTML (it contains no secrets); the
        # API key is injected client-side and stored in sessionStorage.
        routes.append(("GET", "/", self._handle_webchat_ui))
        routes.append(("GET", "/index.html", self._handle_webchat_ui))
        routes.append(("GET", "/favicon.ico", self._handle_favicon))
        routes.append(("GET", "/js/{filename}", self._handle_webchat_js))
        # Sidebar history + the message-truncation the edit/regenerate controls need.
        # Both delegate to the SAME SessionDB the agent turn writes to, so the UI can
        # never drift from what Hermes actually persisted.
        #
        # Auth matters here: these read AND rewrite the transcript, so they must be gated
        # exactly like the chat routes. Note aiohttp validates the handler SIGNATURE at
        # add_route time, so a route must be plain handler(request) -- it cannot be the
        # (self, request) shape _admit_api_agent_request produces (that decorator is for
        # method decoration upstream, not standalone route registration). Each handler
        # below therefore performs the inherited auth check itself, first thing.
        routes.append(("GET", "/webchat/sidebar", self._handle_webchat_sidebar))
        routes.append((
            "POST", "/webchat/sessions/{session_id}/truncate",
            self._handle_webchat_truncate))
        routes.append((
            "POST", "/webchat/sessions/{session_id}/compress",
            self._handle_webchat_compress))
        routes.append((
            "PATCH", "/webchat/sessions/{session_id}/title",
            self._handle_webchat_title))
        routes.append((
            "POST", "/webchat/sessions/{session_id}/save",
            self._handle_webchat_save))
        routes.append((
            "GET", "/webchat/sessions/{session_id}/stats",
            self._handle_webchat_stats))
        routes.append((
            "GET", "/webchat/skills",
            self._handle_webchat_skills))
        routes.append((
            "GET", "/webchat/thinking",
            self._handle_webchat_thinking))
        routes.append((
            "GET", "/webchat/capabilities",
            self._handle_webchat_capabilities))
        routes.append((
            "GET", "/webchat/models",
            self._handle_webchat_models))
        routes.append((
            "POST", "/webchat/model",
            self._handle_webchat_model_switch))
        routes.append((
            "POST", "/webchat/upload_pdf",
            self._handle_webchat_upload_pdf))
        # Server->browser push channel. One long-lived SSE stream per tab, so the
        # UI can report progress on its own instead of being asked for a status.
        routes.append(("GET", "/events", self._handle_webchat_events))
        # Dev-only probe for the push channel, gated by env so it cannot fire in
        # normal use: POST /events/test {"event": "...", "data": {...}}.
        routes.append(("POST", "/events/test", self._handle_webchat_events_test))
        # Manual sidebar order + pins (WebChat-owned sidecar, see sidebar_order.py).
        routes.append(("POST", "/webchat/sidebar/order", self._handle_webchat_sidebar_order))
        return routes

    async def _handle_webchat_events_test(self, request: "web.Request") -> "web.Response":
        """POST /events/test — dev probe for the push channel (env-gated).

        Exists so the channel can be verified deterministically without waiting on
        a real long job. Refuses unless WEBCHAT_DEBUG_EVENTS=1.
        """
        from aiohttp import web as aio_web

        from events import BUS, TRACKER

        auth_err = self._check_auth(request)
        if auth_err:
            return auth_err
        if os.environ.get("WEBCHAT_DEBUG_EVENTS") != "1":
            return aio_web.json_response(
                {"error": {"message": "disabled; set WEBCHAT_DEBUG_EVENTS=1"}}, status=403)
        try:
            body = await request.json()
        except Exception:
            body = {}
        event = str(body.get("event") or "progress.note")
        data = body.get("data") if isinstance(body.get("data"), dict) else {}
        if body.get("track"):   # also exercise the tracker + its heartbeat ticker
            TRACKER.start(str(body["track"]), session_id=str(body.get("session_id") or ""),
                          label=str(data.get("label") or "tracked work"),
                          kind=str(data.get("kind") or "job"))
        BUS.publish(event, data)
        return aio_web.json_response({"published": event, "subscribers": BUS.subscriber_count()})

    async def _handle_webchat_events(self, request: "web.Request") -> "web.Response":
        """GET /events — the live push channel (server-sent events).

        One stream per tab. Frames carry monotonic ids, so a tab that reconnects
        with Last-Event-ID gets the frames it missed replayed from the ring
        buffer; a dropped frame shows up as a gap in the ids rather than as
        silence. Producers publish from agent threads via events.BUS.publish().
        """
        from aiohttp import web as aio_web

        from events import BUS, TRACKER, sse_frame

        auth_err = self._check_auth(request)  # inherited gate: bearer API_SERVER_KEY
        if auth_err:
            return auth_err

        loop = asyncio.get_running_loop()
        BUS.bind_loop(loop)
        TRACKER.start_ticker(loop)   # idempotent; heartbeats running work

        resp = aio_web.StreamResponse(headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        })
        await resp.prepare(request)
        q = BUS.subscribe()
        LOG.info("events: tab subscribed (%d open)", BUS.subscriber_count())
        try:
            last = request.headers.get("Last-Event-ID") or ""
            if last.isdigit():
                for frame in BUS.replay_since(int(last)):
                    await resp.write(sse_frame(frame))
            await resp.write(b": connected\n\n")
            while True:
                try:
                    frame = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    # Comment heartbeat: keeps proxies and idle timers from closing
                    # an otherwise silent stream.
                    await resp.write(b": ping\n\n")
                    continue
                await resp.write(sse_frame(frame))
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        finally:
            BUS.unsubscribe(q)
            LOG.info("events: tab unsubscribed (%d open)", BUS.subscriber_count())
        return resp

    async def _handle_webchat_models(self, request: "web.Request") -> "web.Response":
        """GET /webchat/models -- the model list plus the current selection.

        Read-only. The provider catalog is probed live by the CLI's own resolver, so this
        can be slow on a cold cache; the frontend treats a failure as "no catalog" and
        still lets you type a model name, because typing a name must never depend on a
        catalog probe succeeding.
        """
        from aiohttp import web as aio_web

        err = self._check_auth(request)
        if err:
            return err

        def build() -> Dict[str, Any]:
            # hermes_constants.get_hermes_home + yaml is the same read the capabilities
            # route uses. The module-level load_config() is the WEBCHAT JSON config and
            # parsing config.yaml with it raised JSONDecodeError.
            from hermes_constants import get_hermes_home
            import yaml
            cfg = yaml.safe_load(
                (get_hermes_home() / "config.yaml").read_text(encoding="utf-8")) or {}
            model_cfg = cfg.get("model") or {}
            current = str(model_cfg.get("default") or model_cfg.get("model") or "")
            provider = str(model_cfg.get("provider") or "")
            out: Dict[str, Any] = {
                "current": current, "provider": provider,
                "context_length": int(model_cfg.get("context_length") or 0) or None,
                "models": [], "providers": [], "note": "",
            }
            try:
                from hermes_cli.model_switch import list_provider_models  # type: ignore
            except Exception:
                list_provider_models = None  # type: ignore
            # Every provider that has credentials, so the picker can show them grouped.
            try:
                from hermes_cli.model_switch import get_authenticated_provider_slugs  # type: ignore
                slugs = get_authenticated_provider_slugs(
                    current_provider=provider,
                    user_providers=cfg.get("providers") or {},
                    custom_providers=cfg.get("custom_providers") or [])
            except Exception as exc:
                slugs = []
                out["note"] = f"provider list unavailable: {type(exc).__name__}"
            for slug in slugs:
                try:
                    names = list(list_provider_models(slug)) if list_provider_models else []
                except Exception:
                    names = []
                if not names:
                    # Provider not in models.dev (e.g. nous) — fall back to config.yaml default
                    prov_cfg = (cfg.get("providers") or {}).get(slug) or {}
                    def_model = prov_cfg.get("default") or ""
                    if not def_model:
                        # Also check top-level model config
                        if (cfg.get("model") or {}).get("provider") == slug:
                            def_model = (cfg.get("model") or {}).get("default") or ""
                    if def_model:
                        names = [def_model]
                out["providers"].append({"provider": slug, "count": len(names)})
                for n in names:
                    out["models"].append({"id": str(n), "provider": slug})
            # A flat unique list keeps the datalist simple while the grouped list stays
            # available for anything that wants provider context.
            seen, flat = set(), []
            for m in out["models"]:
                if m["id"].lower() not in seen:
                    seen.add(m["id"].lower())
                    flat.append(m["id"])
            out["model_ids"] = flat
            return out

        try:
            data = await asyncio.to_thread(build)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("model list failed: %s", exc)
            return aio_web.json_response({"error": f"{type(exc).__name__}: {exc}"}, status=500)
        return aio_web.json_response(data)

    async def _handle_webchat_model_switch(self, request: "web.Request") -> "web.Response":
        """POST /webchat/model -- switch the model for THIS install.

        Body: ``{"model": "<name>", "provider": "<slug|>", "persist": false}``.

        Persisting rewrites ``model.default``/``model.provider`` in config.yaml, which
        changes the model for every future session -- so it is opt-in and defaults to off.
        Without ``persist`` the change applies to the running WebChat only.
        """
        from aiohttp import web as aio_web

        err = self._check_auth(request)
        if err:
            return err
        try:
            payload = await request.json()
        except Exception:
            return aio_web.json_response({"error": "bad json"}, status=400)
        wanted = str(payload.get("model") or "").strip()
        explicit_provider = str(payload.get("provider") or "").strip()
        persist = bool(payload.get("persist"))
        if not wanted and not explicit_provider:
            return aio_web.json_response({"error": "model required"}, status=400)

        def apply() -> Dict[str, Any]:
            from hermes_constants import get_hermes_home
            from hermes_cli.model_switch import switch_model
            import yaml
            cfg_path = get_hermes_home() / "config.yaml"
            cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
            model_cfg = cfg.get("model") or {}
            result = switch_model(
                wanted,
                current_provider=str(model_cfg.get("provider") or ""),
                current_model=str(model_cfg.get("default") or model_cfg.get("model") or ""),
                current_base_url=str(model_cfg.get("base_url") or ""),
                explicit_provider=explicit_provider,
                user_providers=cfg.get("providers") or {},
                custom_providers=cfg.get("custom_providers") or [])
            if not getattr(result, "success", False):
                return {"ok": False, "error": str(
                    getattr(result, "message", "") or "switch failed")}
            if persist:
                from hermes_cli.model_switch import persist_model_selection
                persist_model_selection(result, cfg_path)
            return {
                "ok": True, "model": result.new_model,
                "provider": result.target_provider,
                "provider_label": getattr(result, "provider_label", "") or "",
                "context_length": getattr(result, "context_length", None),
                "persisted": persist,
                "warning": getattr(result, "message", "") or "",
            }

        try:
            out = await asyncio.wait_for(asyncio.to_thread(apply), timeout=15.0)
        except asyncio.TimeoutError:
            return aio_web.json_response({"ok": False, "error": "model switch timed out (provider catalog probe hung)"}, status=504)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("model switch failed: %s", exc)
            return aio_web.json_response(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status=500)
        return aio_web.json_response(out, status=200 if out.get("ok") else 400)

    async def _handle_webchat_compress(self, request: "web.Request") -> "web.Response":
        """POST /webchat/sessions/{id}/compress — force context compression.

        Uses the same ``compress_now`` + ``_compress_context(force=True)`` path
        the CLI's ``/compress`` uses. The compressed history is persisted back
        to the session via ``SessionDB.replace_messages``.
        """
        from aiohttp import web as aio_web

        auth_err = self._check_auth(request)
        if auth_err:
            return auth_err

        session_id = request.match_info["session_id"]

        # Parse compress args from request body
        try:
            body = await request.json()
            args_str = body.get("args", "") if isinstance(body, dict) else ""
        except Exception:
            args_str = ""

        def _compress(args_str: str) -> dict:
            db = self._ensure_session_db()
            if db is None:
                return {"ok": False, "error": "session DB unavailable"}

            # Build a temporary agent for this session first (needed for token estimates).
            agent = self._create_agent(session_id=session_id)
            try:
                # Initialize context compressor with session state (match CLI behavior)
                if hasattr(agent, 'context_compressor') and agent.context_compressor:
                    try:
                        from hermes_constants import get_hermes_home
                        agent.context_compressor.bind_session_state(db, session_id)
                        agent.context_compressor.on_session_start(
                            session_id,
                            hermes_home=str(get_hermes_home()),
                            platform='api_server',
                            model=getattr(agent, 'model', ''),
                            context_length=getattr(agent.context_compressor, 'context_length', 0),
                        )
                    except Exception as ce_err:
                        LOG.debug("Compressor init for %s: %s", session_id, ce_err)
                rows = db.get_messages(session_id)
                history = [m for m in (rows or []) if m.get("role") in ("user", "assistant")]
                if len(history) < 4:
                    return {"ok": False, "error": "nothing to compress (need at least 4 messages)"}

                from agent.conversation_compression_manual import (
                    compress_now, parse_compress_args, estimate_request_tokens,
                )

                req = parse_compress_args(args_str)
                result = compress_now(agent, history, req,
                                      system_message=getattr(agent, "_cached_system_prompt", "") or "",
                                      task_id=session_id)

                if result.status == "lock_skipped":
                    return {"ok": False, "error": "compression already in progress (lock held)"}

                if result.status == "nothing_to_do":
                    return {"ok": False, "error": "nothing to compress"}

                if result.status == "preview":
                    return {"ok": False, "error": "\n".join(result.lines)}

                # Persist compressed history
                after = result.after_messages
                db.replace_messages(session_id, after, archive_dropped=True)

                before_active = len(rows or [])
                before_active_tokens = estimate_request_tokens(agent, list(rows or []))
                after_tokens = estimate_request_tokens(agent, list(after or []))

                return {
                    "ok": True,
                    "before_messages": before_active,
                    "after_messages": len(after or []),
                    "before_tokens": before_active_tokens,
                    "after_tokens": after_tokens,
                    "removed": before_active - len(after or []),
                }
            finally:
                # Clean up temp agent
                if hasattr(agent, 'disconnect'):
                    try:
                        agent.disconnect()
                    except Exception:
                        pass

        try:
            out = await asyncio.to_thread(_compress, args_str)
        except Exception as exc:
            LOG.warning("compress failed for %s: %s", session_id, exc)
            return aio_web.json_response(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status=500)
        return aio_web.json_response(out, status=200 if out.get("ok") else 400)

    async def _handle_webchat_capabilities(self, request: "web.Request") -> "web.Response":
        """GET /webchat/capabilities — what this Hermes install can actually do.

        A capability table, not a marketing panel: every row is read from a live
        source and failures degrade to a per-section ``error`` string instead of a
        silently blank section. Sources, in order:

          * config.yaml via ``get_hermes_home()`` — the same loader the stats route
            uses, so precedence matches the CLI (model, context pin, compression,
            auxiliary compression route, toolsets, MCP servers, A2A agents,
            custom providers)
          * ``agent.skill_commands.scan_skill_commands`` — the real slash-command
            inventory, counted not sampled
          * ``/v1/models`` style provider reachability is NOT probed here: a live
            provider call on a page view would cost tokens. Reachability is shown as
            "configured", never as "working".

        Secrets are never included: custom-provider entries are reduced to name,
        base_url host and model count, and api_key values are dropped entirely.
        """
        from aiohttp import web as aio_web

        auth_err = self._check_auth(request)
        if auth_err:
            return auth_err

        def _cfg() -> dict:
            from hermes_constants import get_hermes_home

            import yaml

            path = get_hermes_home() / "config.yaml"
            return yaml.safe_load(path.read_text(encoding="utf-8")) or {}

        cfg: Dict[str, Any] = {}
        cfg_error = None
        try:
            cfg = await asyncio.to_thread(_cfg)
        except Exception as exc:  # noqa: BLE001
            cfg_error = str(exc)

        groups: List[Dict[str, Any]] = []

        model_cfg = cfg.get("model") or {}
        comp = cfg.get("compression") or {}
        aux_comp = ((cfg.get("auxiliary") or {}).get("compression") or {})
        pinned = False
        try:
            from agent.context_pin import is_context_pinned

            ctx_len = int(model_cfg.get("context_length") or 0)
            pinned = bool(is_context_pinned(ctx_len, ctx_len or None))
        except Exception:
            ctx_len = int(model_cfg.get("context_length") or 0)

        groups.append({
            "id": "model", "title": "Model & context",
            "rows": [
                {"field": "model", "value": str(model_cfg.get("default") or "\u2014")},
                {"field": "provider", "value": str(model_cfg.get("provider") or "\u2014")},
                {"field": "endpoint", "value": str(model_cfg.get("base_url") or "\u2014")},
                {"field": "context_length",
                 "value": f"{ctx_len:,}" if ctx_len else "\u2014",
                 "note": "pinned" if pinned else ""},
                {"field": "compression",
                 "value": ("on" if comp.get("enabled") else "off"),
                 "note": f"threshold {comp.get('threshold')}" if comp.get("enabled") else ""},
                {"field": "compression helper",
                 "value": str(aux_comp.get("provider") or "auto"),
                 "note": str(aux_comp.get("model") or "inherits main route")},
            ],
        })

        toolsets = cfg.get("toolsets") or []
        groups.append({
            "id": "toolsets", "title": "Toolsets",
            "rows": [{"field": str(t), "value": "enabled"} for t in toolsets],
            "empty": "no toolsets configured",
        })

        mcp = cfg.get("mcp_servers") or {}
        mcp_rows = []
        for name, spec in (mcp.items() if isinstance(mcp, dict) else []):
            spec = spec if isinstance(spec, dict) else {}
            mcp_rows.append({
                "field": str(name),
                "value": "enabled" if spec.get("enabled", True) else "disabled",
                "note": str(spec.get("command") or "")[:60],
            })
        groups.append({"id": "mcp", "title": "MCP servers", "rows": mcp_rows,
                       "empty": "none configured"})

        a2a = cfg.get("a2a_served_agents") or {}
        groups.append({
            "id": "a2a", "title": "A2A agents",
            "rows": [
                {"field": str(name),
                 "value": str((spec or {}).get("label") or "agent"),
                 "note": str((spec or {}).get("endpoint") or "")}
                for name, spec in (a2a.items() if isinstance(a2a, dict) else [])
            ],
            "empty": "none served",
        })

        prov_rows = []
        for entry in (cfg.get("custom_providers") or []):
            if not isinstance(entry, dict):
                continue
            prov_rows.append({
                "field": str(entry.get("name") or "\u2014"),
                "value": f"{len(entry.get('models') or {})} models",
                "note": str(entry.get("base_url") or ""),
            })
        for name, spec in (cfg.get("providers") or {}).items():
            spec = spec if isinstance(spec, dict) else {}
            if not spec.get("api") and not spec.get("base_url"):
                continue
            prov_rows.append({
                "field": str(name),
                "value": f"{len(spec.get('models') or [])} models",
                "note": str(spec.get("api") or spec.get("base_url") or ""),
            })
        groups.append({"id": "providers", "title": "Other providers",
                       "rows": prov_rows, "empty": "none configured"})

        def _skills() -> dict:
            from agent.skill_commands import scan_skill_commands

            return scan_skill_commands() or {}

        skills_error = None
        try:
            scanned = await asyncio.to_thread(_skills)
        except Exception as exc:  # noqa: BLE001
            scanned, skills_error = {}, str(exc)
        groups.append({
            "id": "skills", "title": "Skills (slash commands)",
            "rows": [{"field": "available", "value": str(len(scanned)),
                      "note": skills_error or ""}],
        })

        return aio_web.json_response({
            "groups": groups,
            "config_error": cfg_error,
            "generated_at": int(asyncio.get_event_loop().time() * 1000),
        })

    async def _handle_webchat_thinking(self, request: "web.Request") -> "web.Response":
        """GET /webchat/thinking — the CLI's "thinking" faces and verbs.

        Read from ``agent.display.KawaiiSpinner`` (the same class the CLI spinner
        uses) so the web UI says exactly what the terminal says, including any active
        skin's override: the accessors prefer ``spinner.thinking_faces`` /
        ``thinking_verbs`` from the skin and fall back to the built-in kawaii faces
        and the THINKING_VERBS catalog ("pondering, contemplating, musing,
        cogitating, ruminating, deliberating, mulling, reflecting, ... synthesizing").

        Nothing is hard-coded here on purpose — a copy of the verb list in the UI
        would silently drift from the CLI the moment a skin or locale changes it.
        """
        from aiohttp import web as aio_web

        auth_err = self._check_auth(request)
        if auth_err:
            return auth_err

        def _read() -> dict:
            from agent.display import KawaiiSpinner

            return {
                "faces": list(KawaiiSpinner.get_thinking_faces()),
                "verbs": list(KawaiiSpinner.get_thinking_verbs()),
                "waiting_faces": list(KawaiiSpinner.get_waiting_faces()),
            }

        try:
            data = await asyncio.to_thread(_read)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("thinking-phrase lookup failed: %s", exc)
            return aio_web.json_response({"faces": [], "verbs": [], "error": str(exc)})
        return aio_web.json_response(data)

    async def _handle_webchat_skills(self, request: "web.Request") -> "web.Response":
        """GET /webchat/skills — the ``/slash`` commands, for composer autocomplete.

        Delegates to ``agent.skill_commands.scan_skill_commands``, the exact call the
        CLI palette uses, so the web UI offers the same set, the same ``/slug`` names
        (already collision-checked against core commands) and the same descriptions.
        Nothing is re-implemented and nothing is discovered separately.

        ``scan_skill_commands`` swallows import errors and returns ``{}``, which is
        exactly what a bare interpreter produces (hermes_yaml is missing there). This
        runs inside the booted server, where those imports resolve -- but if the scan
        ever comes back empty we say so instead of rendering an empty palette.
        """
        from aiohttp import web as aio_web

        auth_err = self._check_auth(request)
        if auth_err:
            return auth_err

        def _scan() -> dict:
            from agent.skill_commands import scan_skill_commands

            return scan_skill_commands() or {}

        try:
            raw = await asyncio.to_thread(_scan)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("skill scan failed: %s", exc)
            return aio_web.json_response({"skills": [], "error": str(exc)})

        skills = [
            {"command": key, "name": v.get("name") or key.lstrip("/"),
             "description": v.get("description") or ""}
            for key, v in sorted(raw.items())
        ]
        if not skills:
            LOG.warning("skill scan returned 0 commands (imports may have failed silently)")
        return aio_web.json_response({"skills": skills})

    async def _handle_webchat_stats(self, request: "web.Request") -> "web.Response":
        """GET /webchat/sessions/{id}/stats — the numbers behind the CLI status bar.

        The API server builds a fresh agent per turn (``_run_agent``), so there is no
        long-lived agent object to poll the way ``cli_status_bar_mixin`` does. These
        figures are therefore read from the session row Hermes already persists on
        every turn -- the same durable counters, not a re-derived guess:

          * model           sessions.model
          * prompt/context = input + cache_read + cache_write, which is exactly the
                             ``prompt`` definition the CLI uses for its cache ratio
                             (verified: 18192 + 1238 + 0 == the 19430 prompt_tokens the
                             provider reported for the same turn)
          * cache hit       cache_read / prompt, the CLI's formula
          * context length  the configured ``context_length`` (1M here)

        Latency and tokens/sec are deliberately NOT here: they live only in the live
        agent's latency/output deques. The UI measures those from the stream it is
        already consuming, which is real data and costs no extra call.
        """
        from aiohttp import web as aio_web

        auth_err = self._check_auth(request)
        if auth_err:
            return auth_err
        db = await self._ensure_session_db_async()
        if db is None:
            return self._session_db_unavailable()
        session_id = request.match_info["session_id"]

        def _read() -> dict:
            row = db.get_session(session_id) or {}
            inp = int(row.get("input_tokens") or 0)
            out = int(row.get("output_tokens") or 0)
            cread = int(row.get("cache_read_tokens") or 0)
            cwrite = int(row.get("cache_write_tokens") or 0)
            prompt_sum = inp + cread + cwrite

            # Context-window occupancy is the CURRENT prompt size, NOT the sum above.
            # The sessions columns are cumulative over every API call in the session:
            # a 28-call turn re-sends the whole conversation each time, so cache_read
            # reached 1,001,810 while the real prompt was 50,785 -- reporting the sum
            # showed a bogus 854K/85.4% for a 5.1% context. The usage anchor is the
            # same durable per-turn figure the CLI anchors its bar on
            # (agent.usage_anchor.anchored_context_tokens), and it is correct for a
            # single-call session too (19,311 both ways).
            # When the anchor is absent, do NOT fall back to prompt_sum -- that is the
            # cumulative total across all turns and will always show an impossible
            # number (observed: 344M/1.0M). Set 0 so the UI hides the bar.
            ctx_tokens = 0
            try:
                import json as _json

                mc = _json.loads(row.get("model_config") or "{}")
                anchored = int(((mc.get("_usage_anchor") or {}).get("prompt_tokens")) or 0)
                if anchored > 0:
                    ctx_tokens = anchored
            except Exception:
                pass

            model = str(row.get("model") or "")
            short = model
            try:  # same display helper the CLI status bar uses, so names match
                from hermes_cli.model_switch import format_model_for_display

                short = format_model_for_display(model.split("/")[-1]) or model
            except Exception:
                short = model.split("/")[-1] if "/" in model else model
            if short.endswith(".gguf"):
                short = short[:-5]

            ctx_len = 0
            try:
                from hermes_constants import get_hermes_home

                # Same loader Hermes uses, so precedence matches the CLI. The key is
                # nested: model.context_length (a top-level read returns None and the
                # context segments silently disappear).
                import yaml  # noqa: F401  (import kept local; Hermes ships ruamel/yaml)

                cfg = yaml.safe_load(
                    (get_hermes_home() / "config.yaml").read_text(encoding="utf-8")) or {}
                ctx_len = int(((cfg.get("model") or {}).get("context_length") or 0))
            except Exception:
                ctx_len = 0

            # "pinned" means the shown context_length IS the model.context_length pin
            # (agent.context_pin.is_context_pinned) -- not "the prompt happens to fit".
            try:
                from agent.context_pin import is_context_pinned

                pinned = bool(is_context_pinned(ctx_len, ctx_len or None))
            except Exception:
                pinned = False
            pct = round(min(100.0, (ctx_tokens / ctx_len) * 100), 1) if ctx_len else None
            # Cache hit is a RATIO, so the cumulative totals are the right basis here:
            # summing re-reads across calls still yields cread/prompt for the session.
            hit = round((cread / prompt_sum) * 100, 1) if prompt_sum > 0 and cread > 0 else None
            return {
                "session_id": session_id,
                "model": model, "model_short": short,
                "context_tokens": ctx_tokens, "context_length": ctx_len or None,
                "context_percent": pct, "context_pinned": pinned,
                "cache_hit_pct": hit,
                "context_tokens_source": "usage_anchor" if ctx_tokens != prompt_sum else "session_sum",
                "session_input_tokens": inp, "session_output_tokens": out,
                "session_cache_read_tokens": cread, "session_cache_write_tokens": cwrite,
                "session_total_tokens": prompt_sum + out,
                "session_api_calls_equivalent_prompt": prompt_sum,
            }

        try:
            data = await asyncio.to_thread(_read)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("stats failed for %s: %s", session_id, exc)
            return aio_web.json_response(
                {"error": {"message": str(exc), "code": "stats_failed"}}, status=500)
        return aio_web.json_response(data)

    # -- sidebar ------------------------------------------------------------
    async def _handle_webchat_sidebar_order(self, request: "web.Request") -> "web.Response":
        """POST /webchat/sidebar/order — persist a drag order and/or pin state.

        Body (all optional):
          {"order": [sid, ...],          # full visible list top-to-bottom, pinned excluded
           "pinned": [sid, ...],         # explicit pin block, top first
           "pin": {"id": sid, "value": true},   # toggle one row
           "reset": true}                # back to automatic recency ordering

        Writes only the WebChat's own sidecar file, never Hermes' sessions table.
        """
        from aiohttp import web as aio_web

        import sidebar_order

        auth_err = self._check_auth(request)  # this route mutates UI state
        if auth_err:
            return auth_err
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}

        def _apply() -> dict:
            if body.get("reset"):
                return sidebar_order.clear()
            if isinstance(body.get("pin"), dict):
                pin = body["pin"]
                return sidebar_order.set_pinned(str(pin.get("id") or ""), bool(pin.get("value")))
            order = body.get("order") if isinstance(body.get("order"), list) else None
            pinned = body.get("pinned") if isinstance(body.get("pinned"), list) else None
            if order is None and pinned is None:
                return sidebar_order.snapshot()
            return sidebar_order.set_order(order or [], pinned)

        try:
            data = await asyncio.to_thread(_apply)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("sidebar order write failed: %s", exc)
            return aio_web.json_response(
                {"error": {"message": str(exc), "code": "order_write_failed"}}, status=500)
        return aio_web.json_response({"ok": True, "rank": len(data.get("rank") or {}),
                                      "pinned": len(data.get("pinned") or [])})

    async def _handle_webchat_sidebar(self, request: "web.Request") -> "web.Response":
        """GET /webchat/sidebar — this web UI's conversations, newest first.

        Thin composition over the inherited list handler: same auth, same DB, same
        ordering. Grouped by recency the way a chat sidebar reads best.
        """
        from aiohttp import web as aio_web

        auth_err = self._check_auth(request)  # inherited gate: bearer API_SERVER_KEY
        if auth_err:
            return auth_err
        db = await self._ensure_session_db_async()
        if db is None:
            return self._session_db_unavailable()

        def _load() -> list:
            return db.list_sessions_rich(
                source="api_server", limit=200, offset=0, include_children=True,
                order_by_last_active=True, include_pinned=True,
            )

        try:
            rows = await asyncio.to_thread(_load)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("sidebar listing failed: %s", exc)
            return aio_web.json_response({"sessions": []})

        sessions = []
        for row in rows or []:
            sessions.append({
                "id": row.get("id"),
                "title": row.get("title") or "New chat",
                # Provenance lets the UI keep a user-chosen name and only auto-name
                # untitled chats. Hermes ranks user > llm > derived and refuses to
                # overwrite a user title, so this is the source of truth, not a guess.
                "title_source": row.get("title_source") or "",
                "preview": (row.get("preview") or "")[:160],
                "message_count": row.get("message_count") or 0,
                "pinned": bool(row.get("pinned")),
                "last_active": row.get("last_active") or row.get("started_at") or 0,
                "ended_at": row.get("ended_at"),
            })
        # Manual drag order + pins live in the WebChat's own sidecar (no Hermes
        # schema change, so `hermes update` cannot undo them). Decorate rather
        # than re-sort here: the client owns presentation order, and it needs the
        # raw fields to do the drag maths.
        from sidebar_order import decorate, has_manual_order

        sessions = decorate(sessions)
        return aio_web.json_response({
            "sessions": sessions,
            "manual_order": has_manual_order(),
        })

    async def _handle_webchat_title(self, request: "web.Request") -> "web.Response":
        """PATCH /webchat/sessions/{id}/title — name a conversation.

        Delegates to ``SessionDB.set_session_title``, which writes with ``user``
        provenance: the highest rank, so a later automatic titler can never clobber
        a name the user typed. Reusing it (rather than writing the ``sessions`` table
        directly) is what keeps the web UI's naming consistent with the CLI's.

        ``auto`` instead derives a title from the first user message at ``derived``
        provenance -- free, no extra model call, and still loses to a manual rename.
        """
        from aiohttp import web as aio_web

        auth_err = self._check_auth(request)  # this route mutates a session
        if auth_err:
            return auth_err
        db = await self._ensure_session_db_async()
        if db is None:
            return self._session_db_unavailable()
        session_id = request.match_info["session_id"]
        body, err = await self._read_json_body(request)
        if err:
            return err

        auto = bool(body.get("auto"))
        title = str(body.get("title") or "").strip()
        # Collapse whitespace: a title is a single display line.
        title = " ".join(title.split())

        if not auto:
            if not title:
                return aio_web.json_response(
                    {"error": {"message": "title is required (or pass auto=true)",
                               "code": "bad_request"}}, status=400)
            max_len = getattr(db, "MAX_TITLE_LENGTH", 100)
            if len(title) > max_len:
                title = title[:max_len].rstrip()

        def _write() -> dict:
            if auto:
                # Derived from the first user turn: the most honest zero-cost name.
                rows = db.get_messages(session_id)
                first = ""
                for m in rows or []:
                    if m.get("role") == "user":
                        c = str(m.get("content") or "").strip()
                        if c:
                            first = c
                            break
                if not first:
                    return {"changed": False, "title": db.get_session_title(session_id)}
                if len(first) > 60:
                    first = first[:60].rsplit(" ", 1)[0] + "\u2026"
                changed = db.set_auto_title(session_id, first, source=db.TITLE_SOURCE_DERIVED)
                return {"changed": bool(changed), "title": db.get_session_title(session_id)}
            changed = db.set_session_title(session_id, title)
            return {"changed": bool(changed), "title": db.get_session_title(session_id)}

        try:
            result = await asyncio.to_thread(_write)
        except ValueError as exc:  # upstream raises on title validation/conflict
            return aio_web.json_response(
                {"error": {"message": str(exc), "code": "invalid_title"}}, status=400)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("title update failed for %s: %s", session_id, exc)
            return aio_web.json_response(
                {"error": {"message": str(exc), "code": "title_failed"}}, status=500)
        return aio_web.json_response({"session_id": session_id, **result})

    async def _handle_webchat_save(self, request: "web.Request") -> "web.Response":
        """POST /webchat/sessions/{id}/save — register a CLI/external session into web history.

        Changes the session's source to 'api_server' so it appears in the sidebar
        alongside native web chats. Idempotent: re-saving an already-api_server
        session is a no-op.
        """
        from aiohttp import web as aio_web

        auth_err = self._check_auth(request)
        if auth_err:
            return auth_err
        session_id = request.match_info["session_id"]
        db = await self._ensure_session_db_async()
        if db is None:
            return self._session_db_unavailable()

        def _save() -> dict:
            row = db.get_session(session_id)
            if row is None:
                return {"error": "not_found"}
            if row.get("source") == "api_server":
                return {"saved": False, "already": True, "source": "api_server"}
            db._write_sql(
                "UPDATE sessions SET source = 'api_server' WHERE id = ?",
                (session_id,),
            )
            return {"saved": True, "source": "api_server"}

        try:
            result = await asyncio.to_thread(_save)
        except Exception as exc:
            LOG.warning("save failed for %s: %s", session_id, exc)
            return aio_web.json_response(
                {"error": {"message": str(exc), "code": "save_failed"}}, status=500)
        if "error" in result:
            return aio_web.json_response(
                {"error": {"message": "session not found", "code": "not_found"}}, status=404)
        return aio_web.json_response(result)

    async def _handle_webchat_truncate(self, request: "web.Request") -> "web.Response":
        """POST /webchat/sessions/{id}/truncate — drop every message after an id.

        Backs "edit & resend" and "regenerate": the client asks for the transcript to
        end at message N, then posts the (possibly edited) user turn again. This is the
        same ``SessionDB.replace_messages`` primitive the agent's own rewind uses, so the
        agent resumes from exactly what is left -- no second backend, no divergence.
        """
        from aiohttp import web as aio_web

        auth_err = self._check_auth(request)  # this route REWRITES the transcript
        if auth_err:
            return auth_err
        session_id = request.match_info["session_id"]
        body, err = await self._read_json_body(request)
        if err:
            return err
        keep_through = body.get("keep_through_message_id")
        if keep_through is None:
            return aio_web.json_response(
                {"error": {"message": "keep_through_message_id is required", "code": "bad_request"}},
                status=400)
        try:
            keep_through = int(keep_through)
        except (TypeError, ValueError):
            return aio_web.json_response(
                {"error": {"message": "keep_through_message_id must be an integer",
                           "code": "bad_request"}}, status=400)

        db = await self._ensure_session_db_async()
        if db is None:
            return self._session_db_unavailable()

        def _truncate() -> int:
            rows = db.get_messages(session_id)
            kept = [m for m in (rows or []) if int(m.get("id") or 0) <= keep_through]
            # archive_dropped=True SOFT-archives the dropped tail instead of DELETEing it.
            # replace_messages is destructive by default (rows are deleted AND evicted from
            # FTS, leaving nothing to recover), and its own docstring names this exact case:
            # "This is the mode a rewind/edit/regenerate must use" -- those flows overwrite a
            # transcript the user may not have meant to drop. It also keeps the ids of the
            # kept prefix, so a later regenerate resolves ids consistently.
            db.replace_messages(session_id, kept, archive_dropped=True)
            return len(kept)

        try:
            kept_count = await asyncio.to_thread(_truncate)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("truncate failed for %s: %s", session_id, exc)
            return aio_web.json_response(
                {"error": {"message": str(exc), "code": "truncate_failed"}}, status=500)
        return aio_web.json_response(
            {"session_id": session_id, "kept": kept_count, "truncated_after": keep_through})

    def _allow_webchat_same_origin(self) -> None:
        """Let the browser talk to this origin without CORS configuration.

        The inherited ``cors_middleware`` answers 403 for ANY request carrying an
        ``Origin`` header that is not in ``cors_origins`` -- correct for a headless API
        used by third-party clients, but it also rejects the UI's own same-origin
        ``fetch`` calls, so the page loads and then fails with "Failed to fetch" and
        sits at "connecting..." forever (verified in Chrome).

        A browser sends ``Origin`` on POST even same-origin, so the UI cannot avoid it.
        Same-origin requests need no CORS grant at all: the browser already treats them
        as first-party. So this adds exactly the origins this server itself is reachable
        at (its configured bind host/port, plus loopback spellings of it) and nothing
        else. An explicit ``cors_origins`` list from the operator is still honored and
        still takes precedence for genuinely cross-origin clients.
        """
        host, port = self._host, self._port
        hosts = {str(host), "127.0.0.1", "localhost", "[::1]", "::1"}
        origins = {f"http://{h}:{port}" for h in hosts}
        existing = tuple(self._cors_origins or ())
        merged = existing + tuple(o for o in origins if o not in existing)
        if merged != existing:
            LOG.debug("allowing same-origin webchat requests: %s", ", ".join(origins))
            self._cors_origins = merged

    async def _handle_webchat_upload_pdf(self, request: "web.Request") -> "web.Response":
        """POST /webchat/upload_pdf -- extract text from a PDF for chat attachment."""
        from aiohttp import web as aio_web
        import base64

        auth_err = self._check_auth(request)
        if auth_err:
            return auth_err

        try:
            body = await request.json()
        except Exception:
            return aio_web.json_response({"error": "bad json"}, status=400)

        name = str(body.get("filename") or "attachment.pdf")
        data_b64 = body.get("data")
        if not data_b64:
            return aio_web.json_response({"error": "data required"}, status=400)
        # strip any data: prefix
        if "," in str(data_b64):
            data_b64 = str(data_b64).split(",", 1)[1]
        try:
            raw = base64.b64decode(data_b64, validate=True)
        except Exception:
            return aio_web.json_response({"error": "invalid base64"}, status=400)

        if len(raw) > 10 * 1024 * 1024:
            return aio_web.json_response({"error": "file too large (max 10MB)"}, status=413)

        def _extract():
            import pymupdf as fitz  # PyMuPDF (compiled, pre-pinned in this venv)
            doc = fitz.open(stream=raw, filetype="pdf")
            if doc.needs_pass:
                return None, "password-protected PDF not supported"
            parts = []
            for page in doc:
                t = page.get_text()
                if t.strip():
                    parts.append(t)
            text = "\n\n".join(parts)
            pages = doc.page_count
            doc.close()
            limit = 100000
            if len(text) > limit:
                text = text[:limit] + "\n\n[... truncated at 100k chars ...]"
            return text, pages

        try:
            text, info = await asyncio.to_thread(_extract)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("pdf extract failed: %s", exc)
            return aio_web.json_response({"error": f"{type(exc).__name__}: {exc}"}, status=500)

        if text is None:
            return aio_web.json_response({"error": str(info)}, status=400)
        return aio_web.json_response({
            "ok": True, "name": name, "text": text,
            "pages": info, "chars": len(text),
        })

    async def _handle_webchat_ui(self, request: "web.Request") -> "web.Response":
        from aiohttp import web as aio_web

        if not UI_PATH.is_file():
            return aio_web.Response(
                text="UI bundle missing: %s" % UI_PATH, status=500, content_type="text/plain"
            )
        html = UI_PATH.read_text(encoding="utf-8")
        # Inject the API key + bind address as a JSON <script> block the page
        # parses at boot. Served no-store so the key is never cached.
        boot = json.dumps({"apiKey": self._api_key, "host": self._host, "port": self._port})
        tag = '<script id="hermes-boot" type="application/json">%s</script>' % boot.replace("<", "\\u003c")
        html = html.replace(
            '<script id="hermes-boot" type="application/json">{}</script>', tag
        ).replace(
            '<script id="hermes-boot" type="application/json">/*__HERMES_BOOT__*/null</script>', tag
        ).replace(
            '<script id="hermes-boot" type="application/json">null</script>', tag
        )
        if 'id="hermes-boot"' not in html:  # template drifted — inject before </head>
            html = html.replace("</head>", tag + "\n</head>")
        return aio_web.Response(
            text=html,
            content_type="text/html",
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                # The inherited security_headers_middleware stamps
                #   Content-Security-Policy: default-src 'none'
                # which is correct for a JSON API but forbids this page's own inline
                # <script> and every fetch() -- Chrome rejects them in ~0.4ms with
                # "TypeError: Failed to fetch" and never sends a request, so the UI
                # loads and then sits at "connecting..." forever. Scoped to this one
                # document only; the JSON API routes keep the strict header.
                #
                # 'unsafe-inline' is required for the boot <script> and the app script.
                # It is safe here because the page is same-origin only, loads no remote
                # code, and renders all model/tool text via textContent (never innerHTML).
                "Content-Security-Policy": (
                    "default-src 'none'; "
                    "script-src 'unsafe-inline' 'self'; "
                    "connect-src 'self' https: wss:; "
                    "style-src 'unsafe-inline'; "
                    "img-src 'self' data:; "
                    "media-src 'self' blob:; "
                    "form-action 'none'; "
                    "base-uri 'none'; "
                    "frame-ancestors 'none'"
                ),
                                "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
            },
        )

    async def _handle_favicon(self, request: "web.Request") -> "web.Response":
        from aiohttp import web as aio_web

        return aio_web.Response(status=204)

    async def _handle_webchat_js(self, request: "web.Request") -> "web.Response":
        from aiohttp import web as aio_web
        from pathlib import Path

        filename = request.match_info["filename"]
        # Prevent path traversal
        if ".." in filename or "/" in filename or "\\" in filename:
            return aio_web.Response(status=403)
        fpath = HERE / "static" / "js" / filename
        if not fpath.exists() or not fpath.is_file():
            return aio_web.Response(status=404)
        return aio_web.FileResponse(fpath)


# --------------------------------------------------------------------------
# Entrypoint
# --------------------------------------------------------------------------
def build_adapter(cfg: Dict[str, Any]) -> WebChatAdapter:
    extra = {
        "host": cfg["host"],
        "port": int(cfg["port"]),
        "key": cfg["api_key"],
    }
    platform_config = PlatformConfig(
        enabled=True,
        api_key=cfg["api_key"],
        extra=extra,
    )
    adapter = WebChatAdapter(platform_config)
    # Must run before connect(): cors_middleware reads _cors_origins per request.
    adapter._allow_webchat_same_origin()
    return adapter


async def _run(cfg: Dict[str, Any]) -> int:
    adapter = build_adapter(cfg)
    ok = await adapter.connect()
    if not ok or not adapter.is_connected:
        LOG.error(
            "Failed to start. Check that aiohttp is installed and port %s is free.", cfg["port"]
        )
        return 1

    url = f"http://{'127.0.0.1' if cfg['host'] in ('0.0.0.0',) else cfg['host']}:{cfg['port']}/"
    print("=" * 64)
    print("  Hermes Web Chat is running")
    print("=" * 64)
    print(f"  URL:  {url}")
    print(f"  Bind: {cfg['host']}:{cfg['port']}  (API key required)")
    print("  Stop: Ctrl+C")
    print("=" * 64)

    if cfg.get("open_browser"):
        try:
            os.startfile(url)  # type: ignore[attr-defined]
        except Exception:
            pass

    try:
        while adapter.is_connected:
            await asyncio.sleep(1)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        try:
            await adapter.disconnect()
        except Exception:
            pass
    print("\nHermes Web Chat stopped.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="hermes-webchat",
        description="Lightweight local web chat UI for the existing Hermes agent.",
    )
    ap.add_argument("--host", default=None, help="Bind host (default 127.0.0.1, localhost only)")
    ap.add_argument("--port", type=int, default=None, help="Port (default 8787)")
    ap.add_argument("--api-key", default=None, help="API key (else API_SERVER_KEY or auto-generated)")
    ap.add_argument("--config", default=str(HERE / "config.json"), help="Config file path")
    ap.add_argument("--open", action="store_true", help="Open the browser on start")
    ap.add_argument(
        "--allow-remote", action="store_true", help="Permit a non-loopback bind (use with a firewall)"
    )
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    cfg_path = Path(args.config).expanduser()
    cfg = load_config(cfg_path)
    if args.host:
        cfg["host"] = args.host
    if args.port:
        cfg["port"] = args.port
    if args.api_key:
        cfg["api_key"] = args.api_key
    if args.open:
        cfg["open_browser"] = True

    if not args.allow_remote:
        assert_bind_is_safe(cfg["host"])
    elif cfg["host"] not in {"127.0.0.1", "localhost", "::1"}:
        LOG.warning(
            "Binding %s (non-loopback) with --allow-remote. Anyone who can reach this port can "
            "run shell commands as your user. Ensure a firewall and a strong API_SERVER_KEY.",
            cfg["host"],
        )

    cfg["api_key"] = resolve_api_key(cfg, cfg_path)

    try:
        return asyncio.run(_run(cfg))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
