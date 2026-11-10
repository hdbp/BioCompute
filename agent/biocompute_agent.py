#!/usr/bin/env python3
"""BioCompute worker agent (Python 3.9+, standard library only; psutil/zeroconf optional).

What it does:
  * enroll   - exchange a one-time enrollment token for an agent token (stored 0600)
  * run      - send an inventory + utilization heartbeat every 30 s; optionally advertise
               itself via mDNS and (if the token allows it) report devices seen in the
               local ARP/NDP cache, which lets one agent per network segment act as a
               discovery agent for a remote controller.
  * status   - print the stored configuration and the controller's view of this node.

What it deliberately does NOT do: accept commands, open a shell, install software or
execute jobs. Job execution on workers is performed by the scheduler you configure
(HTCondor), never by this agent.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hostinfo  # noqa: E402

VERSION = "0.1.0"
CONFIG = Path(os.environ.get("BIOCOMPUTE_AGENT_CONFIG", Path.home() / ".config" / "biocompute" / "agent.json"))


def load() -> dict:
    if not CONFIG.exists():
        sys.exit(f"Not enrolled: {CONFIG} missing. Run `{sys.argv[0]} enroll` first.")
    return json.loads(CONFIG.read_text())


def save(cfg: dict) -> None:
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(cfg, fh, indent=2)


def post(cfg: dict, path: str, body: dict, token: str | None = None) -> dict:
    url = cfg["controller"].rstrip("/") + path
    ctx = ssl.create_default_context(cafile=cfg.get("ca_file")) if url.startswith("https") else None
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{e.code} {e.read().decode(errors='replace')[:300]}") from None


def inventory(full: bool) -> dict:
    inv = hostinfo.collect(full=full)
    inv["agent_version"] = VERSION
    return inv


def neighbours() -> list[dict]:
    """Passive: parse the ARP/NDP cache. Sends no packets."""
    devs = []
    try:
        if platform.system() == "Linux":
            out = subprocess.run(["ip", "-j", "neigh"], capture_output=True, text=True, timeout=10).stdout
            for n in json.loads(out or "[]"):
                if n.get("dst") and "FAILED" not in (n.get("state") or []):
                    devs.append({"hostname": n["dst"], "addresses": [n["dst"]],
                                 "fingerprint": f"mac:{n['lladdr']}" if n.get("lladdr") else None})
        else:
            out = subprocess.run(["arp", "-an"], capture_output=True, text=True, timeout=10).stdout
            for m in re.finditer(r"\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+)", out):
                devs.append({"hostname": m.group(1), "addresses": [m.group(1)], "fingerprint": f"mac:{m.group(2)}"})
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        pass
    return [{k: v for k, v in d.items() if v} for d in devs]


def advertise(port: int):
    try:
        from zeroconf import ServiceInfo, Zeroconf  # type: ignore
    except ImportError:
        return None
    import socket

    host = socket.gethostname().split(".")[0]
    addrs = [socket.inet_aton(a) for a in hostinfo.addresses() if ":" not in a]
    info = ServiceInfo("_biocompute._tcp.local.", f"{host}._biocompute._tcp.local.", addresses=addrs, port=port,
                       properties={"machine_id": hostinfo.machine_id(), "agent": VERSION}, server=f"{host}.local.")
    zc = Zeroconf()
    zc.register_service(info)
    return zc


def cmd_enroll(a) -> None:
    cfg = {"controller": a.controller, "ca_file": a.ca_file}
    r = post(cfg, "/api/agent/enroll", {"token": a.token, "inventory": inventory(True)})
    cfg.update({"agent_token": r["agent_token"], "node_id": r["node_id"], "discovery": a.discovery,
                "heartbeat_seconds": r.get("heartbeat_seconds", 30)})
    save(cfg)
    print(f"Enrolled as node {r['node_id']}. {r.get('message', '')}\nConfiguration saved to {CONFIG}")


def cmd_run(a) -> None:
    cfg = load()
    zc = advertise(int(os.environ.get("BIOCOMPUTE_AGENT_PORT", "8765"))) if not a.no_mdns else None
    last_full, last_disc = 0.0, 0.0
    try:
        while True:
            now = time.time()
            try:
                full = now - last_full > 3600
                r = post(cfg, "/api/agent/heartbeat", {"inventory": inventory(full)}, cfg["agent_token"])
                if full:
                    last_full = now
                el = r.get("eligibility", {})
                print(f"[{time.strftime('%H:%M:%S')}] heartbeat ok: state={r.get('state')} eligible={el.get('eligible')} "
                      f"{'; '.join(el.get('reasons', []))}", flush=True)
                if cfg.get("discovery") and now - last_disc > 600:
                    devs = neighbours()
                    post(cfg, "/api/agent/discovery-report", {"devices": devs, "network": platform.node()}, cfg["agent_token"])
                    last_disc = now
            except (RuntimeError, OSError) as exc:
                print(f"[{time.strftime('%H:%M:%S')}] heartbeat failed: {exc}", file=sys.stderr, flush=True)
            if a.once:
                break
            time.sleep(cfg.get("heartbeat_seconds", 30))
    finally:
        if zc:
            zc.close()


def cmd_status(_a) -> None:
    cfg = load()
    print(json.dumps({k: v for k, v in cfg.items() if k != "agent_token"}, indent=2))
    print(json.dumps(post(cfg, "/api/agent/heartbeat", {"inventory": inventory(False)}, cfg["agent_token"]), indent=2))


def main() -> None:
    ap = argparse.ArgumentParser(description="BioCompute worker agent")
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("enroll", help="enroll this machine with a one-time token")
    e.add_argument("--controller", required=True, help="e.g. https://lab-ws.example.org")
    e.add_argument("--token", required=True)
    e.add_argument("--ca-file", help="CA bundle for a private TLS certificate")
    e.add_argument("--discovery", action="store_true", help="report neighbour devices (token must allow it)")
    r = sub.add_parser("run", help="send heartbeats (used by the systemd/launchd service)")
    r.add_argument("--once", action="store_true")
    r.add_argument("--no-mdns", action="store_true")
    sub.add_parser("status")
    a = ap.parse_args()
    {"enroll": cmd_enroll, "run": cmd_run, "status": cmd_status}[a.cmd](a)


if __name__ == "__main__":
    main()
