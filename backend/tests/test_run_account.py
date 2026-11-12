"""Pipelines run under a separate unix account: they cannot read the database or the signing key, their files
remain readable and removable by the controller, cancelling goes through the helper, and a run whose inputs the
account cannot read stops at the preflight with the command that fixes it.

Needs root, setpriv, useradd and setfacl (the test container has them); skipped elsewhere."""
import importlib.util
import json
import os
import pwd
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from conftest import RAW, RESULTS, _TMP, wait_for_run
from test_studio import edge, node

from app.config import get_settings
from app.services import runner

ACCT = "bcrun-test"
REPO = Path(__file__).resolve().parents[2]
FAKE = Path(__file__).parent / "fixtures" / "fake_runas.py"

pytestmark = pytest.mark.skipif(
    os.geteuid() != 0 or not all(shutil.which(t) for t in ("setpriv", "useradd", "setfacl")),
    reason="needs root, setpriv, useradd and setfacl")


def _load_run_account():
    spec = importlib.util.spec_from_file_location("run_account", REPO / "scripts" / "run-account.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def account(monkeypatch, client):
    try:
        pwd.getpwnam(ACCT)
    except KeyError:
        subprocess.run(["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent",
                        "--shell", "/usr/sbin/nologin", ACCT], check=True)
    s = get_settings()
    db = Path(s.database_url[len("sqlite:///"):])
    secret = Path(s.state_dir) / "secret.key"
    deny = [str(db), str(secret)]
    cfg = _TMP / "runas.json"
    cfg.write_text(json.dumps({"account": ACCT, "owner_uid": 0, "deny": deny}))
    monkeypatch.setenv("BIOCOMPUTE_RUNAS_CONFIG", str(cfg))
    monkeypatch.setenv("FAKE_RUNAS_STATE", str(_TMP / "fake-units"))
    monkeypatch.setattr(s, "run_as", ACCT)
    monkeypatch.setattr(s, "runas_helper", f"{sys.executable} {FAKE}")
    runner.harden_state()
    ra = _load_run_account()
    monkeypatch.setattr(ra, "CONFIG", cfg)
    ra.grant(ACCT, RAW, "read", deny)
    ra.grant(ACCT, RESULTS, "write", deny)
    ra.grant(ACCT, s.pipelines_path, "read", deny)
    ra.grant(ACCT, s.runs_path, "traverse", deny)
    ra.grant(ACCT, Path(s.state_dir), "traverse", deny)
    with pytest.raises(SystemExit):  # the state folder holds the database: never granted as a whole
        ra.grant(ACCT, Path(s.state_dir), "read", deny)
    return {"uid": pwd.getpwnam(ACCT).pw_uid, "db": db, "secret": secret}


def _probe_pipeline(client, auth, name, acct, sleep="0"):
    probe = {
        "id": f"u_probe_{int(time.time() * 1000) % 10**8}", "name": "Probe", "category": "My modules",
        "description": "Who am I, what can I read", "scope": "per_sample", "language": "bash",
        "inputs": [{"name": "reads", "type": "fastq", "multiple": False}],
        "outputs": [{"name": "probe", "type": "table", "pattern": "{prefix}.probe.tsv"}],
        "params": [{"name": "sleep", "type": "string", "default": sleep, "description": "seconds"}],
        "tools": ["id"], "cpus": 1, "memory_gb": 1,
        "script": ("set -uo pipefail\n"
                   f'{{ echo "uid=$(id -u)"; if head -c1 "{acct["secret"]}" >/dev/null 2>&1; then echo secret=readable; else echo secret=denied; fi\n'
                   f'  if head -c1 "{acct["db"]}" >/dev/null 2>&1; then echo db=readable; else echo db=denied; fi; }} > "$BC_PREFIX.probe.tsv"\n'
                   'sleep "$BC_PARAM_SLEEP"\n'),
    }
    r = client.post("/api/studio/modules", headers=auth, json=probe)
    assert r.status_code == 200, r.text
    graph = {"nodes": [node("in", "input_samplesheet"), node("p", probe["id"]), node("out", "output_results")],
             "edges": [edge("in", "reads", "p", "reads"), edge("p", "probe", "out", "results")]}
    w = client.post("/api/studio/workflows", headers=auth, json={"name": name, "graph": graph}).json()
    pub = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth)
    assert pub.status_code == 200, pub.text
    return pub.json()["pipeline_id"]


def _launch(client, auth, pid, out, params=None):
    r = client.post("/api/runs", headers=auth, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": out,
                                                    "params": {"input": "raw:run1", **(params or {})}, "resources": {}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _poll_until(client, auth, rid, pred, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        runner._poll_once()
        d = client.get(f"/api/runs/{rid}", headers=auth).json()
        if pred(d):
            return d
        time.sleep(0.3)
    raise AssertionError(f"run {rid} did not reach the expected state: {d['status']}")


def test_pipeline_code_runs_as_the_run_account(client, auth, account):
    pid = _probe_pipeline(client, auth, "Run account probe", account)
    rid = _launch(client, auth, pid, "results:runas_probe")
    done = _poll_until(client, auth, rid, lambda d: d["status"] in runner.TERMINAL)
    log = client.get(f"/api/runs/{rid}/log", headers=auth).json()["content"]
    assert done["status"] == "completed", log[-3000:]
    prov = done["provenance"]
    assert prov["run_as"] == ACCT and prov["os_limits"]["memory_mb"] >= 512
    probes = list((RESULTS / "runas_probe").rglob("*.probe.tsv"))
    assert probes
    body = probes[0].read_text()
    assert f"uid={account['uid']}" in body and "secret=denied" in body and "db=denied" in body, body
    assert probes[0].stat().st_uid == account["uid"]
    # the systemd unit it would be: OS limits, the database made inaccessible, no controller identity in its environment
    cmd = json.loads((_TMP / "fake-units" / f"{prov['unit']}.service.cmd.json").read_text())
    assert any(c.startswith("--property=MemoryMax=") for c in cmd) and any(c.startswith("--property=CPUQuota=") for c in cmd)
    assert f"--property=InaccessiblePaths=-{account['db']}" in cmd and "--property=NoNewPrivileges=yes" in cmd
    assert not any(c.startswith(("--setenv=HOME=", "--setenv=BIOCOMPUTE_", "--setenv=USER=")) for c in cmd)
    # the controller still reads the results and removes what the account wrote
    assert not Path(done["work_dir"]).exists()
    r = client.delete(f"/api/runs/{rid}", headers=auth, params={"results": "true"}).json()
    assert r["results_deleted"] and not (RESULTS / "runas_probe").exists() and not Path(done["run_dir"]).exists()


def test_cancel_goes_through_the_helper(client, auth, account):
    pid = _probe_pipeline(client, auth, "Run account cancel", account, sleep="60")
    rid = _launch(client, auth, pid, "results:runas_cancel")
    _poll_until(client, auth, rid, lambda d: d["status"] == "running")
    time.sleep(1.5)
    assert client.post(f"/api/runs/{rid}/cancel", headers=auth).status_code == 200
    done = _poll_until(client, auth, rid, lambda d: d["status"] in runner.TERMINAL)
    assert done["status"] == "cancelled"
    assert "signal biocompute-run-" in (_TMP / "fake-units" / "calls.log").read_text()


def test_unreadable_inputs_stop_at_preflight(client, auth, account):
    private = RAW / "private_run"
    shutil.copytree(RAW / "run1", private)
    subprocess.run(["setfacl", "-R", "-b", str(private)], check=True)
    os.chmod(private, 0o700)
    pid = _probe_pipeline(client, auth, "Run account preflight", account)
    rid = _launch(client, auth, pid, "results:runas_private", {"input": "raw:private_run"})
    done = client.get(f"/api/runs/{rid}", headers=auth).json()
    assert done["status"] == "failed"
    assert "Run account can read" in done["error"] and "run-account.py grant" in done["error"]
