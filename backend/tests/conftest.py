import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_TMP = Path(tempfile.mkdtemp(prefix="biocompute-test-"))
RAW = _TMP / "raw"
RESULTS = _TMP / "results"
RESULTS.mkdir(parents=True)
(_TMP / "outside").mkdir()
(_TMP / "outside" / "secret.txt").write_text("secret")

os.environ.update({
    "BIOCOMPUTE_ENVIRONMENT": "test",
    "BIOCOMPUTE_DATABASE_URL": f"sqlite:///{_TMP / 'test.db'}",
    "BIOCOMPUTE_STATE_DIR": str(_TMP / "state"),
    "BIOCOMPUTE_ADMIN_PASSWORD": "admin-password-123",
    "BIOCOMPUTE_DATA_ROOTS": json.dumps([
        {"name": "raw", "path": str(RAW), "restricted": True, "writable": False, "description": "test raw data"},
        {"name": "results", "path": str(RESULTS), "restricted": False, "writable": True},
    ]),
    "BIOCOMPUTE_DISCOVERY_AUTHORIZED_CIDRS": "10.99.0.0/16",
    "BIOCOMPUTE_DISCOVERY_ENABLE_MDNS": "false",
    "BIOCOMPUTE_SITE_NAME": "lab",
})
subprocess.run([sys.executable, str(ROOT / "examples/data/generate_test_data.py"), str(RAW / "run1"), "--reads", "200"],
               check=True, capture_output=True)
# a symlink that escapes the data root - must never be followed
(RAW / "escape").symlink_to(_TMP / "outside")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def token(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": "admin-password-123"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def tmp_root():
    return _TMP


def wait_for_run(client, auth, run_id, timeout=60, terminal=("completed", "failed", "cancelled", "lost")):
    """The background monitor is disabled in tests; drive it explicitly."""
    from app.services import runner

    deadline = time.time() + timeout
    while time.time() < deadline:
        runner._poll_once()
        r = client.get(f"/api/runs/{run_id}", headers=auth).json()
        if r["status"] in terminal:
            return r
        time.sleep(0.3)
    raise AssertionError(f"run {run_id} did not finish: {r['status']}")
