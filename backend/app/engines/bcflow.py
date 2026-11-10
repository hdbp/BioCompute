#!/usr/bin/env python3
"""bcflow - the BioCompute native workflow engine (stdlib only).

A small, deliberately limited engine that executes ``bcflow.json`` manifests: a DAG
of steps that are either *per_sample* (one task per samplesheet row) or *aggregate*
(one task consuming the outputs of all samples). Commands are argv lists with
template substitution - never passed through a shell.

It exists so that BioCompute can run genuine local analyses where Nextflow is not
installed, and to execute Pipeline Studio graphs. It is NOT a replacement for
Nextflow: no containers, no remote executors, no retries beyond ``--resume``.

Output: writes a Nextflow-compatible ``trace.txt`` and prints Nextflow-like
``Submitted process > NAME (tag)`` lines so the controller can track progress with
the same parser for both engines.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

TOKEN = re.compile(r"\{(\??)(each:)?([\w.]+)\}")
TRACE_FIELDS = ["task_id", "hash", "native_id", "process", "tag", "name", "status", "exit", "submit",
                "start", "complete", "duration", "realtime", "%cpu", "peak_rss", "workdir"]
STOP = threading.Event()


def log(msg: str) -> None:
    print(msg, flush=True)


class Task:
    def __init__(self, step: dict, sample: dict | None, tid: int):
        self.step = step
        self.sample = sample
        self.id = tid
        self.name = step["id"] + (f" ({sample['id']})" if sample else "")
        self.deps: list[Task] = []
        self.outputs: dict[str, Path] = {}
        self.workdir: Path | None = None
        self.status = "PENDING"


def load_samples(path: str | None) -> list[dict]:
    """Read the samplesheet; rows sharing a sample id (lanes / technical runs) are grouped."""
    if not path:
        return []
    with open(path, newline="") as fh:
        text = fh.read()
    delim = "\t" if text.count("\t") > text.count(",") else ","
    rows = list(csv.DictReader(text.splitlines(), delimiter=delim))
    grouped: dict[str, dict] = {}
    for r in rows:
        sid = r.get("sample") or r.get("sample_id") or r.get("id")
        if not sid:
            raise SystemExit("samplesheet row without 'sample' column")
        g = grouped.setdefault(sid, {"id": sid, **r, "_rows": []})
        g["_rows"].append(r)
    return list(grouped.values())


def lookup(ctx: dict, key: str):
    cur = ctx
    for part in key.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def _fmt(v) -> str:
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, (list, tuple)):
        return " ".join(_fmt(x) for x in v)
    return str(v)


def render_str(s: str, ctx: dict) -> str:
    """Substitute {x}, {?x} (optional) and {each:x} (space-joined) tokens inside a string."""

    def sub(mm):
        v = lookup(ctx, ("each." if mm.group(2) else "") + mm.group(3))
        if v in (None, "") or v == []:
            if mm.group(1) or mm.group(2):
                return ""
            raise KeyError(f"unresolved template '{{{mm.group(3)}}}' in {s!r}")
        return _fmt(v)

    return TOKEN.sub(sub, s).strip()


def render(argv: list[str], ctx: dict) -> list[str]:
    out: list[str] = []
    for arg in argv:
        m = TOKEN.fullmatch(arg)
        if m and m.group(2):  # {each:STEP.out} -> expands to many args
            vals = lookup(ctx, "each." + m.group(3)) or []
            out.extend(_fmt(v) for v in vals)
        elif m and m.group(1):  # {?x} optional -> dropped if empty
            v = lookup(ctx, m.group(3))
            if v not in (None, "", False):
                out.append(_fmt(v))
        elif m and isinstance(lookup(ctx, m.group(3)), list):
            out.extend(_fmt(v) for v in lookup(ctx, m.group(3)))
        else:
            out.append(render_str(arg, ctx))
    return out


def fmt_ms(sec: float) -> str:
    return f"{sec * 1000:.0f}ms" if sec < 1 else f"{sec:.1f}s"


class Engine:
    def __init__(self, a):
        self.a = a
        self.manifest = json.loads(Path(a.manifest).read_text())
        self.pipeline_dir = Path(a.manifest).resolve().parent
        self.params = json.loads(Path(a.params).read_text()) if a.params else {}
        self.outdir = Path(a.outdir).resolve()
        self.workdir = Path(a.workdir).resolve()
        self.samples = load_samples(a.samplesheet or self.params.get("input"))
        self.trace_path = Path(a.trace)
        self.lock = threading.Lock()
        self.procs: dict[int, subprocess.Popen] = {}
        self.max_cpus = max(1, a.max_cpus)
        self.manifest_digest = hashlib.sha1(Path(a.manifest).read_bytes()).hexdigest()

    # ------------------------------------------------------------------ graph
    def build(self) -> list[Task]:
        tasks: list[Task] = []
        by_step: dict[str, list[Task]] = {}
        tid = 1
        steps = self.manifest["steps"]
        ids = [s["id"] for s in steps]
        for s in steps:
            for dep in s.get("after", []):
                if dep not in ids or ids.index(dep) >= ids.index(s["id"]):
                    raise SystemExit(f"step {s['id']}: dependency {dep} must be declared earlier")
            if s.get("scope", "per_sample") == "per_sample":
                if not self.samples:
                    raise SystemExit(f"step {s['id']} is per_sample but no samplesheet was given")
                lst = []
                for smp in self.samples:
                    t = Task(s, smp, tid)
                    tid += 1
                    for dep in s.get("after", []):
                        d = by_step[dep]
                        t.deps.extend([x for x in d if x.sample is None or x.sample["id"] == smp["id"]])
                    lst.append(t)
            else:
                t = Task(s, None, tid)
                tid += 1
                for dep in s.get("after", []):
                    t.deps.extend(by_step[dep])
                lst = [t]
            by_step[s["id"]] = lst
            tasks.extend(lst)
        return tasks

    def context(self, t: Task) -> dict:
        ctx = {
            "params": self.params, "outdir": str(self.outdir), "bin": str(self.pipeline_dir / "bin"),
            "projectDir": str(self.pipeline_dir), "task": {"cpus": t.step.get("cpus", 1)},
            "steps": {}, "each": {"samples": {}},
        }
        for smp in self.samples:
            for k, v in smp.items():
                if isinstance(v, list):
                    ctx["each"]["samples"].setdefault(k, []).extend(v)
                elif v:
                    ctx["each"]["samples"].setdefault(k, []).append(v)
        if t.sample:
            ctx["sample"] = t.sample
        for d in t.deps:
            sid = d.step["id"]
            if d.sample is None or (t.sample is not None and d.sample["id"] == t.sample["id"]):
                ctx["steps"].setdefault(sid, {}).update({k: " ".join(map(str, v)) for k, v in d.outputs.items()})
            for k, v in d.outputs.items():
                ctx["each"].setdefault(sid, {}).setdefault(k, []).extend(str(x) for x in v)
        return ctx

    # ------------------------------------------------------------------ execution
    def trace(self, row: dict) -> None:
        with self.lock:
            new = not self.trace_path.exists()
            with open(self.trace_path, "a", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=TRACE_FIELDS, delimiter="\t", extrasaction="ignore")
                if new:
                    w.writeheader()
                w.writerow(row)

    def run_task(self, t: Task) -> int:
        ctx = self.context(t)
        argv = render(t.step["command"], ctx)
        task_env = {k: render_str(str(v), ctx) for k, v in t.step.get("env", {}).items()}
        h = hashlib.sha1(json.dumps([t.step["id"], argv, task_env, self.manifest_digest]).encode()).hexdigest()
        t.workdir = self.workdir / h[:2] / h[2:16]
        out_patterns = {k: render_str(v, ctx) for k, v in t.step.get("outputs", {}).items()}
        tag = t.sample["id"] if t.sample else ""
        done_marker = t.workdir / ".bcflow.done"
        if self.a.resume and done_marker.exists():
            t.outputs = {k: [Path(p) for p in v] for k, v in json.loads(done_marker.read_text()).items()}
        if self.a.resume and done_marker.exists() and all(p.exists() for v in t.outputs.values() for p in v):
            log(f"[{h[:2]}/{h[2:8]}] Cached process > {t.name}")
            self.trace({"task_id": t.id, "hash": f"{h[:2]}/{h[2:8]}", "process": t.step["id"], "tag": tag,
                        "name": t.name, "status": "CACHED", "exit": 0, "workdir": str(t.workdir)})
            self.publish(t)
            return 0
        if t.workdir.exists():
            shutil.rmtree(t.workdir)
        t.workdir.mkdir(parents=True)
        (t.workdir / ".command.json").write_text(json.dumps(argv, indent=1))
        log(f"[{h[:2]}/{h[2:8]}] Submitted process > {t.name}")
        submit = time.time()
        env = {**os.environ, **task_env, "BCFLOW_TASK_CPUS": str(t.step.get("cpus", 1))}
        env["PATH"] = str(self.pipeline_dir / "bin") + os.pathsep + env.get("PATH", "")
        with open(t.workdir / ".command.log", "wb") as out:
            try:
                p = subprocess.Popen(argv, cwd=t.workdir, stdout=out, stderr=subprocess.STDOUT, env=env,
                                     stdin=subprocess.DEVNULL, start_new_session=True)
            except OSError as exc:
                out.write(f"failed to start: {exc}\n".encode())
                rc = 127
                p = None
            if p is not None:
                with self.lock:
                    self.procs[t.id] = p
                rc = p.wait()
                with self.lock:
                    self.procs.pop(t.id, None)
        end = time.time()
        t.outputs, missing = {}, []
        for k, pat in out_patterns.items():
            found = sorted(t.workdir.glob(pat)) if any(c in pat for c in "*?[") else [t.workdir / pat]
            found = [p for p in found if p.exists()]
            if not found:
                missing.append(pat)
            t.outputs[k] = found
        if rc == 0 and missing:
            with open(t.workdir / ".command.log", "a") as out:
                out.write(f"\nMissing declared outputs: {missing}\n")
            rc = 1
        status = "COMPLETED" if rc == 0 else ("ABORTED" if STOP.is_set() else "FAILED")
        self.trace({"task_id": t.id, "hash": f"{h[:2]}/{h[2:8]}", "native_id": p.pid if p else "",
                    "process": t.step["id"], "tag": tag, "name": t.name, "status": status, "exit": rc,
                    "submit": int(submit * 1000), "start": int(submit * 1000), "complete": int(end * 1000),
                    "duration": fmt_ms(end - submit), "realtime": fmt_ms(end - submit), "workdir": str(t.workdir)})
        if rc == 0:
            done_marker.write_text(json.dumps({k: [str(p) for p in v] for k, v in t.outputs.items()}))
            self.publish(t)
        else:
            tail = (t.workdir / ".command.log").read_text(errors="replace")[-3000:]
            log(f"ERROR ~ Error executing process > '{t.name}'\n\nCommand executed:\n  {' '.join(argv)}\n\n"
                f"Command exit status:\n  {rc}\n\nCommand output:\n{tail}\nWork dir:\n  {t.workdir}")
        return rc

    def publish(self, t: Task) -> None:
        pub = t.step.get("publish")
        if not pub:
            return
        dest = self.outdir / pub
        dest.mkdir(parents=True, exist_ok=True)
        for src in (p for v in t.outputs.values() for p in v):
            if src.is_dir():
                shutil.copytree(src, dest / src.name, dirs_exist_ok=True)
            elif src.exists():
                shutil.copy2(src, dest / src.name)

    def merge_lanes(self) -> None:
        """nf-core CAT_FASTQ semantics: concatenate per-read files of multi-row samples."""
        for smp in self.samples:
            rows = smp.pop("_rows")
            if len(rows) > 1:
                dest = self.workdir / "merged_lanes"
                dest.mkdir(parents=True, exist_ok=True)
                for col in ("fastq_1", "fastq_2"):
                    parts = [r.get(col) for r in rows]
                    if not any(parts):
                        continue
                    if not all(parts):
                        raise SystemExit(f"sample {smp['id']}: mixture of single- and paired-end rows")
                    gz = {p.endswith(".gz") for p in parts}
                    if len(gz) > 1:
                        raise SystemExit(f"sample {smp['id']}: cannot merge gzipped and plain FASTQ files")
                    out = dest / f"{smp['id']}_R{col[-1]}.merged.fastq{'.gz' if gz.pop() else ''}"
                    if not (self.a.resume and out.exists()):
                        with open(out, "wb") as fh:
                            for p in parts:
                                with open(p, "rb") as src:
                                    shutil.copyfileobj(src, fh, 1 << 20)
                    smp[col] = str(out)
                log(f"bcflow ~ merged {len(rows)} lanes/runs of sample {smp['id']}")
            smp["reads"] = [x for x in (smp.get("fastq_1"), smp.get("fastq_2")) if x]

    def run(self) -> int:
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.merge_lanes()
        tasks = self.build()
        self.outdir.mkdir(parents=True, exist_ok=True)
        self.workdir.mkdir(parents=True, exist_ok=True)
        if self.trace_path.exists() and not self.a.resume:
            self.trace_path.unlink()
        log(f"bcflow ~ BioCompute native engine | pipeline: {self.manifest.get('name')} {self.manifest.get('version', '')}")
        log(f"bcflow ~ samples: {len(self.samples)} | tasks: {len(tasks)} | max cpus: {self.max_cpus}")
        for req in self.manifest.get("requires", []):
            if not shutil.which(req):
                log(f"ERROR ~ required tool not found on PATH: {req}")
                return 1
        pending = list(tasks)
        running: dict = {}
        failed = False
        used = 0
        with ThreadPoolExecutor(max_workers=max(1, self.max_cpus)) as pool:
            while (pending or running) and not STOP.is_set():
                ready = [t for t in pending if all(d.status == "COMPLETED" for d in t.deps)]
                if not failed:
                    for t in ready:
                        c = min(t.step.get("cpus", 1), self.max_cpus)
                        if used + c > self.max_cpus:
                            continue
                        used += c
                        pending.remove(t)
                        t.status = "RUNNING"
                        running[pool.submit(self.run_task, t)] = (t, c)
                if not running:
                    break
                done, _ = wait(list(running), timeout=0.5, return_when=FIRST_COMPLETED)
                for f in done:
                    t, c = running.pop(f)
                    used -= c
                    try:
                        rc = f.result()
                    except Exception as exc:  # template errors etc.
                        log(f"ERROR ~ {t.name}: {exc}")
                        rc = 1
                    t.status = "COMPLETED" if rc == 0 else "FAILED"
                    if rc != 0:
                        failed = True  # stop scheduling new tasks; let running ones finish
        if STOP.is_set():
            log("bcflow ~ execution aborted by signal")
            return 143
        if failed or pending:
            log(f"bcflow ~ workflow failed ({sum(t.status == 'FAILED' for t in tasks)} failed task(s))")
            return 1
        log(f"bcflow ~ workflow completed successfully: {len(tasks)} task(s); results in {self.outdir}")
        return 0

    def terminate(self, *_):
        STOP.set()
        with self.lock:
            for p in self.procs.values():
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass


def main() -> int:
    ap = argparse.ArgumentParser(prog="bcflow")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--params")
    ap.add_argument("--samplesheet")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--trace", required=True)
    ap.add_argument("--max-cpus", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--resume", action="store_true")
    a = ap.parse_args()
    eng = Engine(a)
    signal.signal(signal.SIGTERM, eng.terminate)
    signal.signal(signal.SIGINT, eng.terminate)
    return eng.run()


if __name__ == "__main__":
    sys.exit(main())
