"""One-click enrollment over (Tailscale) SSH.

A fake `ssh` executes the remote script locally with its own HOME and machine id, i.e. it
behaves like a separate machine. The agent enrolls against a real HTTP server running the app.
"""
import json
import os
import socket
import stat
import subprocess
import threading
import time
from pathlib import Path

import pytest
import uvicorn

from app.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.services import cluster

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def live_url():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, lifespan="off", log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True


def fake_ssh(tmp_path: Path, behaviour: str = "ok") -> Path:
    home = tmp_path / "remote-home"
    home.mkdir(exist_ok=True)
    log = tmp_path / "ssh.log"
    script = tmp_path / "ssh"
    if behaviour == "denied":
        body = 'echo "user@host: Permission denied (publickey)." >&2; exit 255'
    else:
        body = (f'cmd="${{@: -1}}"\n'
                f'HOME="{home}" BIOCOMPUTE_MACHINE_ID=remote-imac-1234 sh -c "$cmd"')
    script.write_text(f'#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "{log}"\n{body}\n')
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


def _tailnet_node(hostname: str, ip: str = "100.101.0.9") -> str:
    with SessionLocal() as db:
        n = cluster.upsert_node(db, {"hostname": hostname, "os": "macOS", "addresses": [ip],
                                     "fingerprint": f"host:{hostname}",
                                     "tailscale": {"online": True, "dns_name": f"{hostname}.tail1234.ts.net",
                                                   "ips": [ip], "os": "macOS"}}, "tailscale")
        db.commit()
        return n.id


def _wait(client, auth, nid, timeout=60):
    for _ in range(int(timeout / 0.3)):
        st = client.get(f"/api/nodes/{nid}/ssh-enroll", headers=auth).json()["status"]
        if st and st["state"] != "running":
            return st
        time.sleep(0.3)
    raise AssertionError("enrollment did not finish")


def test_ssh_enrollment_end_to_end(client, auth, live_url, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "ssh_bin", str(fake_ssh(tmp_path)))
    nid = _tailnet_node("imac-ssh")
    info = client.get(f"/api/nodes/{nid}/ssh-enroll", headers=auth).json()
    assert info["available"] and info["targets"][0] == "imac-ssh.tail1234.ts.net"
    # target must be one of this node's tailnet addresses
    bad = client.post(f"/api/nodes/{nid}/ssh-enroll", headers=auth, json={"ssh_user": "hugo", "host": "evil.example.org", "controller_url": live_url})
    assert bad.status_code == 400
    r = client.post(f"/api/nodes/{nid}/ssh-enroll", headers=auth, json={
        "ssh_user": "hugo", "host": "100.101.0.9", "controller_url": live_url, "site": "home", "install_service": False})
    assert r.status_code == 200, r.text
    st = _wait(client, auth, nid)
    assert st["state"] == "done", json.dumps(st, indent=1)
    assert [s["state"] for s in st["steps"]] == ["done", "done", "done", "done", "skipped", "done"]
    node = client.get(f"/api/nodes/{nid}", headers=auth).json()
    assert node["agent_installed"] and node["state"] == "active" and node["site"] == "home"
    assert node["allocation"]["enabled"] is False  # participation stays off
    assert sum(n["hostname"] == "imac-ssh" for n in client.get("/api/nodes", headers=auth).json()) == 1
    # the token never appears on an ssh command line; options are non-interactive
    log = (tmp_path / "ssh.log").read_text()
    assert "bce_" not in log and "BatchMode=yes" in log and "-l hugo" in log
    assert (tmp_path / "remote-home/.config/biocompute/agent.json").exists()
    assert (tmp_path / "remote-home/.local/share/biocompute-agent/hostinfo.py").is_file()
    audit = client.get("/api/auth/audit", headers=auth).json()
    assert any(a["action"] == "node.ssh_enroll_done" for a in audit)
    # already enrolled -> not offered again
    assert client.get(f"/api/nodes/{nid}/ssh-enroll", headers=auth).json()["available"] is False


def test_ssh_enrollment_failures(client, auth, live_url, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "ssh_bin", str(fake_ssh(tmp_path, "denied")))
    nid = _tailnet_node("mbp-denied", "100.101.0.10")
    r = client.post(f"/api/nodes/{nid}/ssh-enroll", headers=auth, json={"ssh_user": "hugo", "host": "100.101.0.10", "controller_url": live_url})
    assert r.status_code == 200
    st = _wait(client, auth, nid)
    assert st["state"] == "failed" and "Tailscale SSH" in st["hint"] and st["steps"][0]["state"] == "failed"
    # unreachable controller URL is caught before the token is used
    monkeypatch.setattr(get_settings(), "ssh_bin", str(fake_ssh(tmp_path)))
    r = client.post(f"/api/nodes/{nid}/ssh-enroll", headers=auth, json={"ssh_user": "hugo", "host": "100.101.0.10", "controller_url": "http://127.0.0.1:9"})
    st = _wait(client, auth, nid)
    assert st["state"] == "failed" and st["steps"][1]["id"] == "reach" and st["steps"][1]["state"] == "failed"
    # machines outside the tailnet are refused
    with SessionLocal() as db:
        lan = cluster.upsert_node(db, {"hostname": "lan-only", "addresses": ["192.168.5.5"], "fingerprint": "host:lan-only"}, "neighbors")
        db.commit()
        lid = lan.id
    assert client.get(f"/api/nodes/{lid}/ssh-enroll", headers=auth).json()["available"] is False
    r = client.post(f"/api/nodes/{lid}/ssh-enroll", headers=auth, json={"ssh_user": "hugo", "host": "192.168.5.5", "controller_url": live_url})
    assert r.status_code == 400


def test_install_sh_from_its_own_folder(tmp_path):
    """install.sh must work when run from the install folder itself (as SSH enrollment does)."""
    home = tmp_path / "home"
    dest = home / ".local/share/biocompute-agent"
    dest.mkdir(parents=True)
    for rel in ("biocompute_agent.py", "hostinfo.py", "install.sh", "systemd/biocompute-agent.service", "launchd/org.biocompute.agent.plist"):
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        (dest / rel).write_bytes((ROOT / "agent" / rel).resolve().read_bytes())
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    calls = tmp_path / "calls"
    for tool in ("systemctl", "loginctl"):
        (bin_ / tool).write_text(f'#!/bin/sh\necho "{tool} $*" >> "{calls}"\n')
        (bin_ / tool).chmod(0o755)
    env = {**os.environ, "HOME": str(home), "USER": "tester", "PATH": f"{bin_}:{os.environ['PATH']}"}
    p = subprocess.run(["sh", str(dest / "install.sh")], env=env, capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    unit = (home / ".config/systemd/user/biocompute-agent.service").read_text()
    assert f"{dest}/biocompute_agent.py run" in unit and "@PYTHON@" not in unit
    log = calls.read_text()
    assert "systemctl --user enable biocompute-agent.service" in log and "loginctl enable-linger tester" in log
