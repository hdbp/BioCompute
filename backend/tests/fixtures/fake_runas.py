#!/usr/bin/env python3
"""Stand-in for /usr/local/libexec/biocompute-runas in tests (no systemd in the test container).

`start` asks the REAL helper (dry run) for the systemd-run command it would use, so its validation and environment
filtering are exercised, then starts that command as the run account with setpriv (umask 0007, own session) instead
of a systemd unit. `remove` and `check` run the real helper (they use setpriv, not systemd). signal/stop/status act
on the recorded process.
"""
import json
import os
import pwd
import signal
import subprocess
import sys
from pathlib import Path

REAL = Path(__file__).resolve().parents[3] / "deploy" / "biocompute-runas"
STATE = Path(os.environ["FAKE_RUNAS_STATE"])
STATE.mkdir(parents=True, exist_ok=True)


def real(args, stdin=None):
    return subprocess.run(["/usr/bin/python3", "-I", str(REAL), *args], input=stdin, text=True, capture_output=True)


def main(argv):
    verb = argv[0]
    if verb in ("remove", "check"):
        p = real(argv, sys.stdin.read() if verb == "check" else None)
        sys.stdout.write(p.stdout)
        sys.stderr.write(p.stderr)
        return p.returncode
    if verb == "start":
        p = real(["--dry-run", *argv], sys.stdin.read())
        if p.returncode != 0:
            sys.stderr.write(p.stderr)
            return p.returncode
        cmd = json.loads(p.stdout)
        sep = cmd.index("--")
        opts, command = cmd[:sep], cmd[sep + 1:]
        get = lambda k: next(o.split("=", 1)[1] for o in opts if o.startswith(k + "="))
        uid, gid, unit, cwd = int(get("--uid")), int(get("--gid")), get("--unit"), get("--working-directory")
        env = {"HOME": pwd.getpwuid(uid).pw_dir}
        for o in opts:
            if o.startswith("--setenv="):
                k, _, v = o[len("--setenv="):].partition("=")
                env[k] = v
        (STATE / f"{unit}.cmd.json").write_text(json.dumps(cmd))
        proc = subprocess.Popen(["/usr/bin/setpriv", f"--reuid={uid}", f"--regid={gid}", "--init-groups", "--", *command],
                                cwd=cwd, env=env, preexec_fn=lambda: os.umask(0o007), start_new_session=True,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (STATE / unit).write_text(str(proc.pid))
        return 0
    unit = argv[2] + ".service"
    pid = int((STATE / unit).read_text())
    with open(STATE / "calls.log", "a") as fh:
        fh.write(f"{verb} {unit}\n")
    try:
        if verb == "signal":
            os.kill(pid, signal.SIGTERM)
        elif verb == "stop":
            os.killpg(pid, signal.SIGKILL)
        elif verb == "status":
            os.kill(pid, 0)
            print("ActiveState=active")
    except ProcessLookupError:
        print("ActiveState=inactive")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
