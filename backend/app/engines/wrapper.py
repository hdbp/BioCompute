#!/usr/bin/env python3
"""Detached run supervisor (stdlib only, no app imports).

Started by the controller with ``start_new_session=True`` so that a pipeline keeps
running if the web application restarts. Responsibilities:

* start the engine command (argv list, never a shell) in its own process group;
* record ``wrapper.pid`` / ``child.pid`` and, when finished, ``exit_code``
  (written atomically) so the controller can reconcile state after a restart;
* forward SIGTERM/SIGINT to the engine for graceful cancellation.

Usage: wrapper.py --run-dir DIR --cwd DIR -- argv...
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time


def atomic_write(path: str, text: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--cwd", required=True)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    if not cmd:
        print("wrapper: no command", file=sys.stderr)
        return 2
    state = {"child": None, "cancelled": False}

    def forward(signum, _frame):
        state["cancelled"] = True
        if state["child"] is not None:
            try:
                state["child"].send_signal(signum)
            except ProcessLookupError:
                pass

    # install before anything else so an early cancellation is never lost
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    atomic_write(os.path.join(a.run_dir, "wrapper.pid"), str(os.getpid()))
    log = open(os.path.join(a.run_dir, "stdout.log"), "ab", buffering=0)
    started = time.time()
    try:
        child = subprocess.Popen(cmd, cwd=a.cwd, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    except OSError as exc:
        log.write(f"[biocompute] failed to start engine: {exc}\n".encode())
        atomic_write(os.path.join(a.run_dir, "exit_code"), "127")
        return 127
    state["child"] = child
    atomic_write(os.path.join(a.run_dir, "child.pid"), str(child.pid))
    if state["cancelled"]:
        child.terminate()
    rc = child.wait()
    if state["cancelled"]:
        atomic_write(os.path.join(a.run_dir, "cancelled"), "1")
    log.write(f"\n[biocompute] engine exited with code {rc} after {time.time() - started:.1f}s\n".encode())
    log.close()
    atomic_write(os.path.join(a.run_dir, "exit_code"), str(rc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
