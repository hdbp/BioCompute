"""In-process pub/sub used for server-sent events (live run status, logs, node updates)."""
from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

_subscribers: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = set()
_lock = threading.Lock()


def subscribe() -> tuple[asyncio.AbstractEventLoop, asyncio.Queue]:
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=1000)
    with _lock:
        _subscribers.add((loop, q))
    return loop, q


def unsubscribe(sub) -> None:
    with _lock:
        _subscribers.discard(sub)


def publish(topic: str, data: dict[str, Any]) -> None:
    """Thread-safe: may be called from the monitor thread or request handlers."""
    msg = json.dumps({"topic": topic, **data}, default=str)
    with _lock:
        subs = list(_subscribers)
    for loop, q in subs:
        def put(q=q):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(msg)
        try:
            loop.call_soon_threadsafe(put)
        except RuntimeError:
            unsubscribe((loop, q))
