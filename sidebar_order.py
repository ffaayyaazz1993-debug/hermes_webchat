"""Sidebar order: manual drag ranks + pins, stored beside the WebChat.

Deliberately NOT in Hermes' sessions table. Two reasons: there is no order/rank
column there (only `pinned`), and writing to Hermes' schema would be undone or
broken by `hermes update`. This is a UI concern owned by the UI.

Shape of the file:

    {"rank": {"<session_id>": 12.5, ...}, "pinned": ["<session_id>", ...]}

`rank` is a float so a drop between two neighbours needs no renumbering of the
whole list. `pinned` is a list, so pin order is explicit and stable.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any, Iterable, Optional

LOG = logging.getLogger("hermes-webchat.sidebar_order")

HERE = Path(__file__).resolve().parent
STATE_DIR = HERE / "state"
STORE = STATE_DIR / "sidebar_order.json"

_lock = threading.RLock()


def _read() -> dict:
    try:
        with open(STORE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {"rank": {}, "pinned": []}
    except Exception as exc:  # corrupt file must not break the sidebar
        LOG.warning("sidebar_order: unreadable (%s); starting empty", exc)
        return {"rank": {}, "pinned": []}
    if not isinstance(data, dict):
        return {"rank": {}, "pinned": []}
    rank = data.get("rank") if isinstance(data.get("rank"), dict) else {}
    pinned = data.get("pinned") if isinstance(data.get("pinned"), list) else []
    return {"rank": rank, "pinned": [str(p) for p in pinned]}


def _write(data: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    tmp.replace(STORE)


def snapshot() -> dict:
    with _lock:
        return _read()


def has_manual_order() -> bool:
    with _lock:
        d = _read()
    return bool(d["rank"])


def decorate(sessions: Iterable[dict]) -> list[dict]:
    """Attach `rank` (or None) and `ui_pinned` to each session dict."""
    with _lock:
        d = _read()
    rank, pinned = d["rank"], set(d["pinned"])
    out = []
    for s in sessions:
        sid = str(s.get("id") or "")
        s = dict(s)
        r = rank.get(sid)
        s["rank"] = float(r) if isinstance(r, (int, float)) else None
        s["ui_pinned"] = sid in pinned
        out.append(s)
    return out


def set_order(order: list[str], pinned: Optional[list[str]] = None) -> dict:
    """Persist an explicit drag order.

    `order` is the full visible list, top to bottom, EXCLUDING pinned rows. Rank
    is assigned by position; dropping between two rows is then just the midpoint
    the client sends as a plain list.
    """
    order = [str(s) for s in (order or [])]
    with _lock:
        d = _read()
        rank: dict[str, float] = {}
        for i, sid in enumerate(order):
            rank[sid] = float((i + 1) * 10)
        if pinned is not None:
            d["pinned"] = [str(p) for p in pinned]
        d["rank"] = rank
        _write(d)
    return d


def set_pinned(session_id: str, pinned: bool) -> dict:
    sid = str(session_id or "")
    if not sid:
        return snapshot()
    with _lock:
        d = _read()
        cur = [p for p in d["pinned"] if p != sid]
        if pinned:
            cur.insert(0, sid)      # newest pin goes to the top of the block
        d["pinned"] = cur
        _write(d)
    return d


def clear() -> dict:
    """Back to automatic recency ordering."""
    with _lock:
        d = {"rank": {}, "pinned": []}
        _write(d)
    return d


def sort_key(s: dict) -> tuple:
    """Pinned first, then dragged rows by rank, then everything else by recency."""
    pinned = 1 if s.get("ui_pinned") else 0
    rank = s.get("rank")
    has_rank = 1 if isinstance(rank, (int, float)) else 0
    # Unranked sorts ABOVE the manual block so a brand-new chat is never buried.
    return (-pinned, 0 if not has_rank else 1, rank if has_rank else 0,
            -(float(s.get("last_active") or 0)))
