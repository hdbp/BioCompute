"""Optional second listener for worker agents only.

The main API (UI, pipelines, runs...) listens on 127.0.0.1. Workers on other machines need just
three endpoints: enroll, heartbeat and discovery reports (all authenticated with their own
tokens) plus /api/health. This listener serves exactly those, on an address such as the
controller's tailnet IP, so the rest of the API never becomes reachable from the network.

BIOCOMPUTE_AGENT_LISTEN:
  "tailscale"         - bind to this machine's Tailscale IPv4 (from `tailscale ip -4`), port BIOCOMPUTE_AGENT_PORT
  "100.64.1.2:8765"   - explicit address and port ("[fd7a::1]:8765" for IPv6)
  unset / "off"       - disabled
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
import threading
from datetime import datetime, timezone

from fastapi import FastAPI

from .config import get_settings
from .routers import cluster

agent_app = FastAPI(title="BioCompute agent endpoint", docs_url=None, redoc_url=None, openapi_url=None)
agent_app.include_router(cluster.agent_router)


@agent_app.get("/api/health")
def health():
    return {"status": "ok", "listener": "agent", "time": datetime.now(timezone.utc).isoformat()}


_state: dict = {"url": None, "server": None, "error": None}


def resolve(spec: str | None) -> tuple[str, int] | None:
    s = get_settings()
    if not spec or spec.strip().lower() in ("off", "false", "0", "no"):
        return None
    spec = spec.strip()
    if spec.lower() == "tailscale":
        exe = shutil.which(s.tailscale_bin)
        if not exe:
            raise RuntimeError("BIOCOMPUTE_AGENT_LISTEN=tailscale but the tailscale CLI is not installed")
        r = subprocess.run([exe, "ip", "-4"], capture_output=True, text=True, timeout=10)
        ip = (r.stdout or "").split()
        if r.returncode != 0 or not ip:
            raise RuntimeError(f"could not get this machine's Tailscale IP: {(r.stderr or r.stdout).strip()[:200]}")
        return ip[0], s.agent_port
    m = re.fullmatch(r"\[([0-9a-fA-F:]+)\](?::(\d+))?|([^:\[\]]+)(?::(\d+))?", spec)
    if not m:
        raise RuntimeError(f"invalid BIOCOMPUTE_AGENT_LISTEN value: {spec!r}")
    host = m.group(1) or m.group(3)
    port = int(m.group(2) or m.group(4) or s.agent_port)
    return host, port


def start() -> str | None:
    """Start the agent listener in a background thread; returns its URL (or None)."""
    import uvicorn

    try:
        addr = resolve(get_settings().agent_listen)
    except RuntimeError as exc:
        _state["error"] = str(exc)
        print(f"[biocompute] agent listener not started: {exc}", file=sys.stderr)
        return None
    if addr is None:
        return None
    host, port = addr
    server = uvicorn.Server(uvicorn.Config(agent_app, host=host, port=port, lifespan="off", log_level="warning",
                                           proxy_headers=False))
    threading.Thread(target=server.run, daemon=True, name="agent-listener").start()  # own loop; no signal capture
    _state.update(server=server, url=f"http://{'[' + host + ']' if ':' in host else host}:{port}", error=None)
    print(f"[biocompute] agent listener on {_state['url']} (enroll/heartbeat/health only)", file=sys.stderr)
    return _state["url"]


def ensure() -> str | None:
    """Start the listener on the tailnet address if it isn't running (used when an admin enrolls a machine)."""
    if _state["url"]:
        return _state["url"]
    s = get_settings()
    if s.agent_listen and s.agent_listen.strip().lower() in ("off", "false", "0", "no"):
        return None  # explicitly disabled
    original = s.agent_listen
    try:
        s.agent_listen = original or "tailscale"
        return start()
    finally:
        s.agent_listen = original


def stop() -> None:
    if _state["server"] is not None:
        _state["server"].should_exit = True


def url() -> str | None:
    return _state["url"]


def error() -> str | None:
    return _state["error"]
