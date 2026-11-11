"""First-run setup, against real server processes with fresh databases (no admin password in the environment)."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, tmp: Path, prepare=None):
        self.tmp = tmp
        self.port = _free_port()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("BIOCOMPUTE_")}
        (tmp / "data").mkdir(exist_ok=True)
        self.env.update({
            "BIOCOMPUTE_ENVIRONMENT": "test", "BIOCOMPUTE_DATABASE_URL": f"sqlite:///{tmp / 'db.sqlite'}",
            "BIOCOMPUTE_STATE_DIR": str(tmp / "state"), "BIOCOMPUTE_REGISTER_EXAMPLES": "false",
            "BIOCOMPUTE_DATA_ROOTS": json.dumps([{"name": "data", "path": str(tmp / "data"), "writable": True}]),
            "BIOCOMPUTE_DISCOVERY_ENABLE_MDNS": "false",
        })
        if prepare:
            subprocess.run([sys.executable, "-c", prepare], cwd=BACKEND, env=self.env, check=True)
        self.log = open(tmp / "server.log", "w")
        self.proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(self.port)],
                                     cwd=BACKEND, env=self.env, stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/health", timeout=1)
                return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError((tmp / "server.log").read_text())

    def call(self, method, path, body=None, headers=None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def stop(self):
        self.proc.terminate()
        self.proc.wait(10)
        self.log.close()


@pytest.fixture
def fresh():
    servers = []

    def start(prepare=None):
        s = Server(Path(tempfile.mkdtemp(prefix="bc-setup-")), prepare)
        servers.append(s)
        return s

    yield start
    for s in servers:
        s.stop()


REMOTE = {"X-Forwarded-For": "192.168.1.50"}  # what a request through a reverse proxy looks like


def test_first_run_creates_the_admin_in_the_browser(fresh):
    s = fresh()
    code_file = s.tmp / "state" / "setup_code.txt"
    code = code_file.read_text().strip()
    assert code in (s.tmp / "server.log").read_text()  # printed in the terminal
    assert oct(code_file.stat().st_mode & 0o777) == "0o600"

    st, d = s.call("GET", "/api/auth/setup")
    assert st == 200 and d["needed"] and d["local"] and not d["code_required"]
    assert s.call("GET", "/api/auth/setup", headers=REMOTE)[1]["code_required"]
    assert s.call("POST", "/api/auth/login", {"username": "admin", "password": "whatever-123"})[0] == 409

    # another computer needs the code
    assert s.call("POST", "/api/auth/setup", {"username": "hugo", "password": "long-enough-pw"}, REMOTE)[0] == 403
    assert s.call("POST", "/api/auth/setup", {"username": "hugo", "password": "long-enough-pw", "code": "AAAA-BBBB"}, REMOTE)[0] == 403
    assert s.call("POST", "/api/auth/setup", {"username": "hugo", "password": "short", "code": code}, REMOTE)[0] == 400
    st, d = s.call("POST", "/api/auth/setup", {"username": "hugo", "password": "long-enough-pw", "code": code.lower()}, REMOTE)
    assert st == 200 and d["user"]["role"] == "admin" and d["access_token"]

    # done: no second administrator can be created this way, the code is gone, and normal login works
    assert s.call("GET", "/api/auth/setup")[1] == {"needed": False}
    assert s.call("POST", "/api/auth/setup", {"username": "eve", "password": "long-enough-pw"})[0] == 409
    assert not code_file.exists()
    assert s.call("POST", "/api/auth/login", {"username": "hugo", "password": "long-enough-pw"})[0] == 200


def test_setup_from_this_computer_needs_no_code(fresh):
    s = fresh()
    st, d = s.call("POST", "/api/auth/setup", {"username": "lab-admin", "password": "long-enough-pw"})
    assert st == 200 and d["user"]["username"] == "lab-admin"


def test_older_install_with_generated_password_is_offered_setup(fresh):
    prepare = (
        "from app.main import migrate\nfrom app.db import SessionLocal\nfrom app.models import User\n"
        "from app.security import hash_secret\nfrom app.config import get_settings\n"
        "migrate(); db = SessionLocal(); db.add(User(username='admin', password_hash=hash_secret('generated-xyz-1'), role='admin'))\n"
        "db.commit()\nst = get_settings().state_dir; st.mkdir(parents=True, exist_ok=True)\n"
        "(st / 'initial_admin_password.txt').write_text('username: admin\\npassword: generated-xyz-1\\n')\n")
    s = fresh(prepare)
    st, d = s.call("GET", "/api/auth/setup")
    assert d["needed"] and d["existing_admin"] == "admin"
    st, d = s.call("POST", "/api/auth/setup", {"username": "hugo", "password": "long-enough-pw"})
    assert st == 200 and d["user"]["username"] == "hugo"
    assert s.call("POST", "/api/auth/login", {"username": "admin", "password": "generated-xyz-1"})[0] == 401
    assert not (s.tmp / "state" / "initial_admin_password.txt").exists()


def test_demo_database_with_the_well_known_password_is_offered_setup(fresh):
    prepare = (
        "from app.main import migrate\nfrom app.db import SessionLocal\nfrom app.models import User\n"
        "from app.security import hash_secret\n"
        "migrate(); db = SessionLocal(); db.add(User(username='admin', password_hash=hash_secret('biocompute-dev'), role='admin'))\n"
        "db.commit()\n")
    s = fresh(prepare)
    d = s.call("GET", "/api/auth/setup")[1]
    assert d["needed"] and d["existing_admin"] == "admin"
    assert s.call("POST", "/api/auth/setup", {"username": "hugo", "password": "long-enough-pw"})[0] == 200
    assert s.call("POST", "/api/auth/login", {"username": "admin", "password": "biocompute-dev"})[0] == 401


def test_admin_with_own_password_is_not_offered_setup(fresh):
    prepare = (
        "from app.main import migrate\nfrom app.db import SessionLocal\nfrom app.models import User\n"
        "from app.security import hash_secret\n"
        "migrate(); db = SessionLocal(); db.add(User(username='admin', password_hash=hash_secret('my-own-secret-9'), role='admin'))\n"
        "db.commit()\n")
    s = fresh(prepare)
    assert s.call("GET", "/api/auth/setup")[1] == {"needed": False}


# --------------------------------------------------------------------------- new accounts after the first one
def test_account_requests_and_invites(client, auth):
    # someone asks for an account from the sign-in page
    assert client.get("/api/auth/signup").json() == {"requests": True}
    r = client.post("/api/auth/request-account", json={"username": "newbie", "password": "newbie-password-1", "note": "Postdoc, ChIP-seq"})
    assert r.status_code == 200
    assert client.post("/api/auth/request-account", json={"username": "newbie", "password": "another-password-1"}).status_code == 409
    # cannot sign in yet, and says why only to whoever knows the password
    assert client.post("/api/auth/login", json={"username": "newbie", "password": "newbie-password-1"}).status_code == 403
    assert client.post("/api/auth/login", json={"username": "newbie", "password": "wrong-password-1"}).status_code == 401
    assert not any(u["username"] == "newbie" for u in client.get("/api/auth/users", headers=auth).json())
    reqs = client.get("/api/auth/requests", headers=auth).json()
    req = next(x for x in reqs if x["username"] == "newbie")
    assert req["note"] == "Postdoc, ChIP-seq"
    assert any("account request" in a["title"] for a in client.get("/api/dashboard", headers=auth).json()["alerts"])
    approved = client.post(f"/api/auth/requests/{req['id']}/approve", headers=auth, json={"role": "scientist"}).json()
    assert approved["role"] == "scientist" and approved["is_active"]
    assert client.post("/api/auth/login", json={"username": "newbie", "password": "newbie-password-1"}).status_code == 200
    # declined requests disappear; turned-off requests are refused
    client.post("/api/auth/request-account", json={"username": "spammer", "password": "spammer-password"})
    sp = next(x for x in client.get("/api/auth/requests", headers=auth).json() if x["username"] == "spammer")
    client.delete(f"/api/auth/requests/{sp['id']}", headers=auth)
    assert client.post("/api/auth/login", json={"username": "spammer", "password": "spammer-password"}).status_code == 401
    client.put("/api/auth/account-settings", headers=auth, json={"requests": False})
    assert client.post("/api/auth/request-account", json={"username": "late", "password": "late-password-1"}).status_code == 403
    client.put("/api/auth/account-settings", headers=auth, json={"requests": True})

    # invite link: single use, role chosen by the admin
    inv = client.post("/api/auth/invites", headers=auth, json={"role": "viewer", "days": 3}).json()
    token = inv["token"]
    assert client.get("/api/auth/invites/check", params={"token": token}).json()["role"] == "viewer"
    assert "token" not in client.get("/api/auth/invites", headers=auth).json()[0]
    t = client.post("/api/auth/invites/accept", json={"token": token, "username": "guest", "password": "guest-password-1"}).json()
    assert t["user"]["role"] == "viewer" and t["access_token"]
    assert client.post("/api/auth/invites/accept", json={"token": token, "username": "guest2", "password": "guest-password-1"}).status_code == 410
    assert client.get("/api/auth/invites/check", params={"token": "made-up"}).status_code == 404
    assert next(i for i in client.get("/api/auth/invites", headers=auth).json() if i["id"] == inv["id"])["status"] == "used"
    # a revoked invite stops working
    inv2 = client.post("/api/auth/invites", headers=auth, json={"role": "scientist"}).json()
    client.delete(f"/api/auth/invites/{inv2['id']}", headers=auth)
    assert client.get("/api/auth/invites/check", params={"token": inv2["token"]}).status_code == 404
    # only admins manage invites and requests
    viewer = {"Authorization": f"Bearer {t['access_token']}"}
    assert client.post("/api/auth/invites", headers=viewer, json={"role": "admin"}).status_code == 403
    assert client.get("/api/auth/requests", headers=viewer).status_code == 403
