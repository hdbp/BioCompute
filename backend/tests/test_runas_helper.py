"""The root helper refuses anything outside its narrow job (run as root with a test configuration; dry runs only)."""
import json
import os
import subprocess
from pathlib import Path

import pytest

from conftest import _TMP

HELPER = Path(__file__).resolve().parents[2] / "deploy" / "biocompute-runas"
pytestmark = pytest.mark.skipif(os.geteuid() != 0, reason="the helper's test configuration is only honoured for root")


def helper(*args, cfg, stdin="{}", env=None):
    path = _TMP / "helper-test.json"
    path.write_text(json.dumps(cfg))
    e = {"PATH": "/usr/bin:/bin", "BIOCOMPUTE_RUNAS_CONFIG": str(path), **(env or {})}
    return subprocess.run(["/usr/bin/python3", "-I", str(HELPER), *args], input=stdin, text=True, capture_output=True, env=e)


OK = {"account": "nobody", "owner_uid": 4242, "deny": ["/srv/bc/db.sqlite", "/srv/bc/secret.key", "/with space/x"]}
START = ["--dry-run", "start", "--unit", "biocompute-run-abc123-1", "--cpus", "4", "--memory-mb", "8192", "--cwd", "/tmp", "--",
         "/usr/bin/python3", "/opt/wrapper.py", "--run-dir", "/tmp/x"]


def test_start_builds_a_limited_unit_as_the_run_account():
    env = {"PATH": "/usr/bin", "HOME": "/home/me", "NXF_OPTS": "-Xms1g", "SSH_AUTH_SOCK": "/tmp/s", "LD_PRELOAD": "/x.so"}
    p = helper(*START, cfg=OK, stdin=json.dumps(env))
    assert p.returncode == 0, p.stderr
    cmd = json.loads(p.stdout)
    assert cmd[0] == "/usr/bin/systemd-run" and "--uid=65534" in cmd and "--expand-environment=no" in cmd  # systemd 255 here and "--unit=biocompute-run-abc123-1.service" in cmd
    assert "--property=CPUQuota=400%" in cmd and "--property=MemoryMax=8192M" in cmd and "--property=UMask=0007" in cmd
    assert "--property=InaccessiblePaths=-/srv/bc/db.sqlite" in cmd and not any("with space" in c for c in cmd)
    assert "--setenv=NXF_OPTS=-Xms1g" in cmd and "--setenv=PATH=/usr/bin" in cmd
    assert not any(c.startswith(("--setenv=HOME", "--setenv=SSH_", "--setenv=LD_PRELOAD")) for c in cmd)
    assert cmd[cmd.index("--") + 1:] == START[START.index("--") + 1:]


@pytest.mark.parametrize("change", [
    {"unit": "sshd"}, {"unit": "biocompute-run-ABC-1"}, {"cpus": "0"}, {"memory-mb": "1"}, {"cwd": "relative"},
    {"command": "python3"}, {"cwd": "/tmp\nExecStart=/bin/sh"},
])
def test_start_refuses_bad_arguments(change):
    args = list(START)
    for k, v in change.items():
        if k == "command":
            args[args.index("--") + 1] = v
        else:
            args[args.index(f"--{k}") + 1] = v
    p = helper(*args, cfg=OK)
    assert p.returncode != 0 and "biocompute-runas:" in p.stderr


def test_bad_environment_and_unknown_actions_are_refused():
    assert helper(*START, cfg=OK, stdin=json.dumps({"BAD KEY": "x"})).returncode != 0
    assert helper(*START, cfg=OK, stdin=json.dumps({"A": "line\nbreak"})).returncode != 0
    assert helper("--dry-run", "shell", cfg=OK).returncode != 0
    assert helper("--dry-run", "signal", "--unit", "ssh", cfg=OK).returncode != 0
    assert helper("--dry-run", "remove", "/", cfg=OK).returncode != 0
    p = helper("--dry-run", "stop", "--unit", "biocompute-run-abc-2", cfg=OK)
    assert json.loads(p.stdout) == ["/usr/bin/systemctl", "stop", "--no-block", "biocompute-run-abc-2.service"]
    p = helper("--dry-run", "remove", "/srv/runs/abc/work", cfg=OK)
    cmd = json.loads(p.stdout)
    assert cmd[0] == "/usr/bin/setpriv" and "--reuid=65534" in cmd and cmd[-1] == "/srv/runs/abc/work"


def test_the_run_account_must_be_unprivileged_and_only_the_owner_may_call():
    assert "separate, unprivileged" in helper(*START, cfg={**OK, "account": "root"}).stderr
    assert "separate, unprivileged" in helper(*START, cfg={**OK, "owner_uid": 65534}).stderr
    assert "does not exist" in helper(*START, cfg={**OK, "account": "no-such-account-xyz"}).stderr
    # through sudo the test configuration is ignored: the real one is required (and absent here)
    p = helper(*START, cfg=OK, env={"SUDO_UID": "4242"})
    assert p.returncode != 0 and "/etc/biocompute/runas.json" in p.stderr
