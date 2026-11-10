"""One-click enrollment of tailnet machines over SSH.

This is the single place where BioCompute changes another computer, so it is narrow by design:

* only an administrator can start it, for one machine at a time, after confirming;
* only machines that are members of the tailnet, and only via one of *that machine's*
  Tailscale addresses or MagicDNS name (the target cannot be pointed elsewhere);
* a fixed sequence of quoted commands - no user-supplied shell text;
* the one-time enrollment token is bound to the node and passed on stdin, so it never
  appears on a command line, in a process list or in BioCompute's logs;
* the SSH session runs as the controller's service account using Tailscale SSH or that
  account's SSH key (BatchMode: no passwords, no prompts);
* participation stays OFF after enrollment; every attempt is audit-logged.
"""
from __future__ import annotations

import io
import re
import shlex
import shutil
import socket
import subprocess
import tarfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from ..config import get_settings
from ..db import SessionLocal
from ..models import Node
from ..security import audit
from . import cluster

AGENT_DIR = Path(__file__).resolve().parents[3] / "agent"
REMOTE_DIR = "$HOME/.local/share/biocompute-agent"
USER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9._-]{0,63}$")
URL_RE = re.compile(r"^https?://[A-Za-z0-9.\-\[\]:]+(/[\w./-]*)?$")
_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()

STEPS = [
    ("connect", "Connect over SSH and check Python"),
    ("reach", "Check that the machine can reach the controller"),
    ("copy", "Copy the BioCompute agent"),
    ("enroll", "Enroll with a one-time token"),
    ("service", "Install the background service"),
    ("verify", "Wait for the first heartbeat"),
]

HINTS = [
    (r"Permission denied \(publickey,password|Permission denied \(publickey,keyboard", "The machine's own SSH server "
     "answered, so the port is right, but it did not accept any key from the controller (password login cannot be "
     "used here). Authorize BioCompute's SSH key on that machine (see 'Controller SSH key' in this panel), then try again."),
    (r"Permission denied|publickey", "SSH refused the login. Allow SSH from the controller in your tailnet policy "
     "(Tailscale SSH: an 'accept' rule for this user) or authorize BioCompute's SSH key on the machine "
     "(see 'Controller SSH key' in this panel)."),
    (r"tailscale.*(check|re-?auth|authenticate)|visit.*login\.tailscale", "Tailscale SSH is in 'check' mode and wants a "
     "browser re-authentication; use an 'accept' rule for the controller, or connect once interactively."),
    (r"Connection timed out|No route to host|Could not resolve", "The machine did not answer over the tailnet. Is it online "
     "and logged in to Tailscale, with Tailscale SSH or sshd enabled on the chosen port (a firewall may also block that port)?"),
    (r"Connection refused", "Nothing listens for SSH on that port. Check the SSH port (Tailscale SSH always uses 22 on the "
     "tailnet address; your own sshd may use another), or enable Tailscale SSH (`tailscale set --ssh`) / Remote Login."),
    (r"Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED", "The machine's SSH host key changed. "
     "Remove its line from the controller's ssh_known_hosts in the state directory if this is expected."),
]


def key_path() -> Path:
    return Path(get_settings().state_dir).resolve() / "ssh" / "biocompute_ed25519"


def key_info() -> dict[str, Any]:
    """BioCompute's own SSH key (no passphrase, readable only by the service account)."""
    k = key_path()
    pub = k.with_suffix(".pub")
    if not (k.is_file() and pub.is_file()):
        return {"exists": False, "public_key": None, "path": str(k), "fingerprint": None}
    fp = None
    keygen = shutil.which("ssh-keygen")
    if keygen:
        r = subprocess.run([keygen, "-lf", str(pub)], capture_output=True, text=True)
        fp = r.stdout.split()[1] if r.returncode == 0 and len(r.stdout.split()) > 1 else None
    return {"exists": True, "public_key": pub.read_text().strip(), "path": str(k), "fingerprint": fp}


def create_key() -> dict[str, Any]:
    k = key_path()
    if k.is_file():
        return key_info()
    keygen = shutil.which("ssh-keygen")
    if not keygen:
        raise HTTPException(500, "ssh-keygen is not installed on the controller (package openssh-client)")
    k.parent.mkdir(parents=True, exist_ok=True)
    k.parent.chmod(0o700)
    comment = f"biocompute@{socket.gethostname().split('.')[0]}"
    r = subprocess.run([keygen, "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", str(k)], capture_output=True, text=True)
    if r.returncode != 0:
        raise HTTPException(500, f"ssh-keygen failed: {r.stderr.strip()[:300]}")
    k.chmod(0o600)
    return key_info()


def _hint(text: str) -> str | None:
    for pat, hint in HINTS:
        if re.search(pat, text, re.I):
            return hint
    return None


def default_controller_url(node_controller: Node | None) -> str | None:
    s = get_settings()
    if s.public_url:
        return s.public_url.rstrip("/")
    if node_controller is not None:
        t = cluster.tailnet_info(node_controller)
        if t["member"] and (t["dns_name"] or t["ips"]):
            return f"http://{t['dns_name'] or t['ips'][0]}:8080"
    return None


def targets(node: Node) -> list[str]:
    t = cluster.tailnet_info(node)
    return [x for x in [t["dns_name"], *t["ips"]] if x]


def _agent_tarball() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for rel in ("biocompute_agent.py", "hostinfo.py", "install.sh", "systemd/biocompute-agent.service",
                    "launchd/org.biocompute.agent.plist"):
            src = (AGENT_DIR / rel).resolve()  # hostinfo.py is a symlink into the backend
            info = tar.gettarinfo(str(src), arcname=rel)
            info.mode = 0o755 if rel.endswith((".py", ".sh")) else 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            with open(src, "rb") as fh:
                tar.addfile(info, fh)
    return buf.getvalue()


def _ssh(user: str, host: str, script: str, stdin: bytes | None = None, timeout: int = 120, port: int = 22) -> tuple[int, str]:
    s = get_settings()
    known = Path(s.state_dir).resolve() / "ssh_known_hosts"
    argv = [s.ssh_bin, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new",
            "-o", f"UserKnownHostsFile={known}", "-o", "LogLevel=ERROR", "-p", str(int(port)), "-l", user,
            *(["-i", str(key_path())] if key_path().is_file() else []),  # plus any agent/default keys
            "--", host,
            "sh -c " + shlex.quote(script)]  # remote login shell may be zsh/fish: always run POSIX sh
    try:
        p = subprocess.run(argv, input=stdin or b"", capture_output=True, timeout=timeout)
    except FileNotFoundError:
        return 127, f"'{s.ssh_bin}' not found on the controller"
    except subprocess.TimeoutExpired:
        return 124, "timed out"
    out = (p.stdout + p.stderr).decode(errors="replace")
    return p.returncode, out[-4000:]


def status(node_id: str) -> dict[str, Any] | None:
    with _lock:
        job = _jobs.get(node_id)
        if job:
            return {**job, "steps": [dict(s) for s in job["steps"]]}
    with SessionLocal() as db:
        n = db.get(Node, node_id)
        return (n.network or {}).get("ssh_enroll") if n else None


def start(db, node: Node, *, user: str, host: str, controller_url: str, site: str | None, port: int = 22,
          install_service: bool, allow_discovery_reports: bool, actor: str) -> dict[str, Any]:
    s = get_settings()
    if not s.allow_ssh_enrollment:
        raise HTTPException(403, "SSH enrollment is disabled (BIOCOMPUTE_ALLOW_SSH_ENROLLMENT=false)")
    if node.is_controller:
        raise HTTPException(400, "This is the controller")
    if node.state in ("disabled",) or (node.agent_installed and node.state in ("active", "enrolled", "draining")):
        raise HTTPException(409, f"Machine is {node.state}; nothing to enroll")
    if not cluster.tailnet_info(node)["member"]:
        raise HTTPException(400, "Automatic enrollment is only available for machines in your tailnet")
    if host not in targets(node):
        raise HTTPException(400, f"SSH target must be one of this machine's tailnet addresses: {', '.join(targets(node))}")
    if not 1 <= int(port) <= 65535:
        raise HTTPException(400, "SSH port must be between 1 and 65535")
    if not USER_RE.match(user):
        raise HTTPException(400, "Invalid SSH user name")
    if not URL_RE.match(controller_url):
        raise HTTPException(400, "Controller URL must look like http(s)://host[:port]")
    if site and not re.fullmatch(r"[\w.-]{1,80}", site):
        raise HTTPException(400, "Invalid site")
    with _lock:
        if _jobs.get(node.id, {}).get("state") == "running":
            raise HTTPException(409, "An enrollment for this machine is already running")
        job = {"node_id": node.id, "state": "running", "user": user, "host": host, "port": int(port), "controller_url": controller_url,
               "started_at": datetime.now(timezone.utc).isoformat(), "finished_at": None, "error": None, "hint": None,
               "steps": [{"id": i, "title": t, "state": "skipped" if (i == "service" and not install_service) else "pending",
                          "output": ""} for i, t in STEPS]}
        _jobs[node.id] = job
    if node.state == "discovered":  # the admin's click is the authorization
        node.state = "candidate"
    token = cluster.issue_token(db, f"ssh enrollment: {node.hostname}", site or node.site, 1, actor,
                                allow_discovery_reports, for_node=node.id)
    audit(db, actor, "node.ssh_enroll_started", node.hostname, ssh_user=user, host=host, port=int(port), controller=controller_url,
          install_service=install_service)
    db.commit()
    threading.Thread(target=_run, args=(node.id, token, install_service, allow_discovery_reports, actor),
                     daemon=True, name=f"ssh-enroll-{node.id}").start()
    return status(node.id)


def _set(job, step_id, state, output=""):
    with _lock:
        for st in job["steps"]:
            if st["id"] == step_id:
                st["state"] = state
                if output:
                    st["output"] = output.strip()[-2000:]


def _run(node_id: str, token: str, install_service: bool, discovery: bool, actor: str) -> None:
    job = _jobs[node_id]
    user, host, url, port = job["user"], job["host"], job["controller_url"], job["port"]

    def ssh(script: str, **kw):
        return _ssh(user, host, script, port=port, **kw)

    def fail(step_id, msg, out=""):
        _set(job, step_id, "failed", out or msg)
        with _lock:
            job.update(state="failed", error=msg, hint=_hint(out or msg), finished_at=datetime.now(timezone.utc).isoformat())

    try:
        _set(job, "connect", "running")
        rc, out = ssh('uname -s; command -v python3 >/dev/null 2>&1 || { echo "python3 not found"; exit 3; }; '
                                   'python3 -c "import sys; print(\'python %d.%d\' % sys.version_info[:2]); sys.exit(0 if sys.version_info >= (3, 9) else 4)"')
        if rc != 0:
            return fail("connect", "Python 3.9+ is required on the machine" if rc in (3, 4) else "SSH connection failed", out)
        _set(job, "connect", "done", out)

        _set(job, "reach", "running")
        rc, out = ssh("python3 -c " + shlex.quote(
            "import sys, urllib.request; urllib.request.urlopen(sys.argv[1] + '/api/health', timeout=10).read(); print('controller reachable')")
            + " " + shlex.quote(url))
        if rc != 0:
            return fail("reach", f"The machine cannot reach the controller at {url}. Use an address it can reach "
                                 "(tailnet name of the controller and the nginx/TLS port), not 127.0.0.1.", out)
        _set(job, "reach", "done", out)

        _set(job, "copy", "running")
        rc, out = ssh(f'mkdir -p "{REMOTE_DIR}" && tar -xf - -C "{REMOTE_DIR}" && echo copied to "{REMOTE_DIR}"',
                       stdin=_agent_tarball())
        if rc != 0:
            return fail("copy", "Copying the agent failed", out)
        _set(job, "copy", "done", out)

        _set(job, "enroll", "running")
        cmd = f'python3 "{REMOTE_DIR}/biocompute_agent.py" enroll --controller {shlex.quote(url)} --token -'
        if discovery:
            cmd += " --discovery"
        rc, out = ssh(cmd, stdin=(token + "\n").encode())
        if rc != 0:
            return fail("enroll", "Enrollment was rejected", out)
        _set(job, "enroll", "done", out)

        if install_service:
            _set(job, "service", "running")
            rc, out = ssh(f'sh "{REMOTE_DIR}/install.sh"', timeout=180)
            if rc != 0:
                return fail("service", "The agent is enrolled, but installing the background service failed. "
                                       "Run install.sh on the machine, or retry.", out)
            _set(job, "service", "done", out)

        _set(job, "verify", "running")
        since = time.time() - 2  # a heartbeat from the newly installed service, not the enrollment itself
        while True:
            with SessionLocal() as db:
                n = db.get(Node, node_id)
                ls = n.last_seen if n else None
                if ls is not None and ls.tzinfo is None:
                    ls = ls.replace(tzinfo=timezone.utc)
                ok = n is not None and n.agent_installed and (not install_service or (ls is not None and ls.timestamp() >= since))
            if ok or time.time() - since > 60:
                break
            time.sleep(3)
        _set(job, "verify", "done" if ok else "failed",
             "Agent is reporting." if ok else "Enrolled, but no heartbeat from the background service yet.")
        with _lock:
            job.update(state="done" if ok else "warning", finished_at=datetime.now(timezone.utc).isoformat())
    except Exception as exc:  # never leave a job stuck in "running"
        fail(next((s["id"] for s in job["steps"] if s["state"] == "running"), "connect"), f"{type(exc).__name__}: {exc}")
    finally:
        with SessionLocal() as db:
            n = db.get(Node, node_id)
            if n is not None:
                n.network = {**(n.network or {}), "ssh_enroll": status(node_id)}
                audit(db, actor, "node.ssh_enroll_" + job["state"], n.hostname, error=job["error"])
                db.commit()
