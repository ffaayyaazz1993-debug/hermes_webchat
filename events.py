"""Live push channel for the WebChat.

A single server->browser SSE stream so the UI reports progress on its own:
promoted background jobs, long turns, subagents, cron runs. The browser never
has to ask "what's the status?".

Three pieces:

  EventBus        fan-out to every open tab. Producers may run on agent threads,
                  so publish() is thread-safe and hands work back to the loop.
  ProgressTracker coalescing + rate limiting. Raw event churn is NOT what a human
                  wants to read: one item is tracked per unit of work and only
                  heartbeat-ed when it outlives a turn, capped per session.
  sse_frame       wire encoding, with monotonic ids so a client can detect a
                  gap (dropped frame) instead of silently missing one.

Nothing here talks to a model and nothing here enters the prompt: progress rows
are display-only, persisted so they survive a reload, never replayed into context.
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import threading
import time
from typing import Any, Callable, Optional

LOG = logging.getLogger("hermes-webchat.events")

# Cadence / limits. The right numbers are a taste call, so they are all here.
HEARTBEAT_SECONDS = 90      # how often a still-running item reports in
FIRST_REPORT_SECONDS = 45   # silence before an item says anything at all
MIN_GAP_SECONDS = 30        # per-session floor between progress rows
RING_SIZE = 250             # replay buffer for reconnecting tabs
QUEUE_SIZE = 500            # per-tab buffer; drop-oldest, ids expose the gap


class EventBus:
    """Fan-out of events to every subscribed tab."""

    def __init__(self, ring_size: int = RING_SIZE) -> None:
        self._subs: set[asyncio.Queue] = set()
        self._ring: collections.deque = collections.deque(maxlen=ring_size)
        self._seq = 0
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._lock = threading.Lock()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        with self._lock:
            self._loop = loop

    # -- produce -----------------------------------------------------------
    def publish(self, event: str, payload: Optional[dict] = None) -> None:
        """Thread-safe. Safe to call from agent threads and tool callbacks."""
        with self._lock:
            self._seq += 1
            frame = {"id": self._seq, "event": event, "data": payload or {}}
            self._ring.append(frame)
            subs = list(self._subs)
            loop = self._loop
        for q in subs:
            if loop is not None:
                try:
                    loop.call_soon_threadsafe(self._offer, q, frame)
                except RuntimeError:
                    pass  # loop closed mid-shutdown
            else:
                self._offer(q, frame)

    @staticmethod
    def _offer(q: asyncio.Queue, frame: dict) -> None:
        try:
            q.put_nowait(frame)
        except asyncio.QueueFull:
            # A slow tab must never stall the server. Drop the OLDEST so the newest
            # still lands; ids are monotonic, so the client can see the gap.
            try:
                q.get_nowait()
                q.put_nowait(frame)
            except Exception:
                pass

    # -- consume -----------------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_SIZE)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subs.discard(q)

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subs)

    def replay_since(self, last_id: int) -> list[dict]:
        with self._lock:
            return [f for f in self._ring if f["id"] > last_id]


BUS = EventBus()


def sse_frame(frame: dict) -> bytes:
    """One SSE frame: id (for gap detection) + event name + JSON payload."""
    body = json.dumps(frame.get("data") or {}, ensure_ascii=False)
    return ("id: %s\nevent: %s\ndata: %s\n\n"
            % (frame["id"], frame["event"], body)).encode("utf-8")


class ProgressTracker:
    """Decides WHAT is worth interrupting a human for.

    Producers register a unit of work; the tracker decides when it speaks. The
    rules exist because the failure mode of a progress channel is noise:

      * nothing is reported until it has been quiet for FIRST_REPORT_SECONDS, so
        quick work stays silent (you already watched it finish);
      * a still-running item heartbeats every HEARTBEAT_SECONDS;
      * terminal states (done / failed / blocked) always get through, rate cap
        or not, because those are the ones that need a human;
      * everything else is floored at MIN_GAP_SECONDS per session.
    """

    def __init__(self, bus: EventBus = BUS) -> None:
        self._bus = bus
        self._items: dict[str, dict] = {}
        self._last_sent: dict[str, float] = {}
        self._lock = threading.Lock()
        self._task: Optional[asyncio.Task] = None

    # -- producer API ------------------------------------------------------
    def start(self, key: str, *, session_id: str, label: str, kind: str = "job",
              detail: str = "") -> None:
        with self._lock:
            self._items[key] = {
                "key": key, "session_id": session_id, "label": label, "kind": kind,
                "detail": detail, "t0": time.time(), "last_report": time.time(),
                "state": "running", "announced": False,
            }

    def update(self, key: str, *, detail: str = "") -> None:
        with self._lock:
            it = self._items.get(key)
            if it and detail:
                it["detail"] = detail

    def finish(self, key: str, *, ok: bool = True, detail: str = "") -> None:
        with self._lock:
            it = self._items.pop(key, None)
        if not it:
            return
        elapsed = time.time() - it["t0"]
        it["detail"] = detail or it["detail"]
        self._emit(it, "progress.done" if ok else "progress.failed",
                   elapsed=elapsed, force=True)

    def note(self, *, session_id: str, text: str, kind: str = "note",
             force: bool = False) -> None:
        """A one-off line (e.g. a subagent finishing). Rate-capped unless forced."""
        item = {"key": "", "session_id": session_id, "label": text, "kind": kind,
                "detail": "", "t0": time.time(), "state": "note"}
        self._emit(item, "progress.note", elapsed=0.0, force=force)

    # -- internals ---------------------------------------------------------
    def _emit(self, item: dict, event: str, *, elapsed: float, force: bool) -> None:
        session_id = item.get("session_id") or ""
        now = time.time()
        with self._lock:
            last = self._last_sent.get(session_id, 0.0)
            if not force and (now - last) < MIN_GAP_SECONDS:
                return
            self._last_sent[session_id] = now
        self._bus.publish(event, {
            "session_id": session_id,
            "key": item.get("key") or "",
            "kind": item.get("kind") or "",
            "label": item.get("label") or "",
            "detail": item.get("detail") or "",
            "state": item.get("state") or "",
            "elapsed": round(elapsed, 1),
            "at": now,
        })

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(5)
            now = time.time()
            due: list[tuple[dict, float]] = []
            with self._lock:
                for it in self._items.values():
                    if it["state"] != "running":
                        continue
                    age = now - it["t0"]
                    since = now - it["last_report"]
                    if not it["announced"]:
                        if age >= FIRST_REPORT_SECONDS:
                            it["announced"] = True
                            it["last_report"] = now
                            due.append((dict(it), age))
                    elif since >= HEARTBEAT_SECONDS:
                        it["last_report"] = now
                        due.append((dict(it), age))
            for it, age in due:
                self._emit(it, "progress.running", elapsed=age, force=False)

    def start_ticker(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._task is None or self._task.done():
            self._task = loop.create_task(self._tick())

    def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None


TRACKER = ProgressTracker()
