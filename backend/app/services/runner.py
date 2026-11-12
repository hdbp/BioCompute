"""Run lifecycle: preparation, launch, monitoring, cancellation, resume, reconciliation.

Runs are executed by a detached supervisor (``engines/wrapper.py``) in its own
session, so they continue if the controller restarts. A single background monitor
thread polls active runs, parses progress and records state transitions. On start-up
:func:`reconcile` re-attaches to runs that were active before a restart.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psutil
from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal
from ..engines.adapters import ADAPTERS, parse_progress
from ..models import Experiment, Pipeline, PipelineVersion, Run, RunEvent
from . import events, fs, nfschema, samplesheet, tools

WRAPPER = Path(__file__).resolve().parent.parent / "engines" / "wrapper.py"
ACTIVE = ("preflight", "queued", "running", "cancelling")
TERMINAL = ("completed", "failed", "cancelled", "lost")
_monitor_started = threading.Event()
_launch_lock = threading.Lock()


def now() -> datetime:
    return datetime.now(timezone.utc)


def add_event(db: Session, run: Run, kind: str, message: str, **data: Any) -> None:
    db.add(RunEvent(run_id=run.id, kind=kind, message=message, data=data))
    events.publish("run", {"run_id": run.id, "kind": kind, "message": message, "status": run.status})


def set_status(db: Session, run: Run, status: str, message: str | None = None) -> None:
    if run.status == status:
        return
    run.status = status
    if status == "running" and not run.started_at:
        run.started_at = now()
    if status in TERMINAL:
        run.finished_at = now()
    add_event(db, run, "status", message or f"Run {status}", status=status)


# --------------------------------------------------------------------------- preparation
def prepare(db: Session, *, pipeline: Pipeline, version: PipelineVersion, engine: str, params: dict[str, Any],
            output_vpath: str, experiment: Experiment | None, resources: dict[str, Any], name: str | None,
            user: str, column_map: dict[str, str] | None = None, placement: dict[str, Any] | None = None) -> tuple[Run, list[dict]]:
    if pipeline.kind == "template":
        raise HTTPException(400, "This pipeline is a catalog template - import it before running")
    if engine not in (version.engines or []):
        raise HTTPException(400, f"Engine '{engine}' cannot run this pipeline version (supports {version.engines})")
    if engine == "bcflow" and not get_settings().enable_demo_engine:
        raise HTTPException(400, "The BioCompute native engine is disabled by configuration")
    root, out_abs = fs.resolve(output_vpath, must_exist=False, for_write=True)
    # whether BioCompute creates this output folder: only then may deleting the run also delete its results
    try:
        created_here = not out_abs.exists() or (out_abs.is_dir() and not any(out_abs.iterdir()))
    except OSError:
        created_here = False
    s = get_settings()
    run = Run(name=name or f"{pipeline.slug}-{now():%Y%m%d-%H%M%S}", pipeline_id=pipeline.id,
              pipeline_version_id=version.id, experiment_id=experiment.id if experiment else None,
              engine=engine, status="pending", params={}, resources=resources, placement=placement or {},
              output_dir=str(out_abs), run_dir="", created_by=user)
    run._output_dir_created = created_here
    db.add(run)
    db.flush()
    run_dir = s.runs_path / run.id
    run_dir.mkdir(parents=True)
    run.run_dir = str(run_dir)
    run.work_dir = str(Path(resources.get("work_dir") or (run_dir / "work")))
    run.nf_session_name = f"bc_{run.id}"

    issues: list[dict[str, Any]] = []
    # effective parameters = schema defaults overlaid with user values (recorded for provenance)
    eff = {**nfschema.defaults(version.schema_json), **{k: v for k, v in params.items() if v not in ("", None)}}
    # refgenie:// references -> paths; the digests go into provenance
    from . import refgenie
    eff, references, ref_issues = refgenie.resolve_params(eff)
    issues += ref_issues
    run._references = references  # read by provenance() in the same request
    if references:
        (run_dir / "references.json").write_text(json.dumps(references, indent=2))
    # resolve virtual paths in file/directory parameters to absolute paths
    for g in nfschema.normalize(version.schema_json)["groups"]:
        for f in g["fields"]:
            v = eff.get(f["name"])
            if f["widget"] in ("file", "directory") and isinstance(v, str) and v and ":" in v.split("/", 1)[0]:
                try:
                    _, p = fs.resolve(v)
                    eff[f["name"]] = str(p)
                except HTTPException as exc:
                    issues.append({"level": "error", "field": f["name"], "message": str(exc.detail)})
    # no experiment: the samplesheet comes from a file or a folder of FASTQ files chosen at launch (or the pipeline default)
    inp = eff.get("input")
    if experiment is None and isinstance(inp, str) and inp and Path(inp).exists():
        src = Path(inp).resolve()
        if fs.root_of(src) is None:
            issues.append({"level": "error", "field": "input", "message": "The samplesheet or FASTQ folder must be inside a data folder"})
        elif src.is_dir():
            try:
                cols, rows, notes = samplesheet.from_folder(src, samplesheet.columns_for(version.input_schema_json, None)
                                                            if version.input_schema_json else None)
            except HTTPException as exc:
                cols, rows, notes = [], [], [str(exc.detail)]
            if not rows:
                issues.append({"level": "error", "field": "input", "message": f"No FASTQ files found in {fs.to_virtual(src) or src}"})
            else:
                sheet = run_dir / "samplesheet.csv"
                sheet.write_text(samplesheet.to_csv(rows, cols))
                eff["input"] = str(sheet)
                (run_dir / "input_source.json").write_text(json.dumps({"folder": fs.to_virtual(src), "samples": len({r["sample"] for r in rows}),
                                                                       "rows": len(rows), "notes": notes[:50]}, indent=2))
        elif src.suffix.lower() in (".csv", ".tsv"):
            text, _ = samplesheet.resolve_sheet(src)
            sheet = run_dir / f"samplesheet{src.suffix.lower()}"
            sheet.write_text(text)
            eff["input"] = str(sheet)
    # experiment -> samplesheet
    if experiment is not None:
        if experiment.assay == "proteomics" and not version.input_schema_json:
            cols, rows = samplesheet.proteomics_design(experiment)
            sheet = run_dir / "experimental_design.tsv"
            sheet.write_text(samplesheet.to_csv(rows, cols, delimiter="\t"))
        else:
            cols = samplesheet.columns_for(version.input_schema_json, experiment)
            rows = samplesheet.build_rows(experiment, cols, column_map)
            sheet = run_dir / "samplesheet.csv"
            sheet.write_text(samplesheet.to_csv(rows, cols))
        eff["input"] = str(sheet)
        v = samplesheet.validate_experiment(experiment, version.input_schema_json, column_map)
        issues += [i for i in v["issues"] if i["level"] == "error"]
    eff["outdir"] = str(out_abs)
    issues += [i for i in nfschema.validate_params(version.schema_json, eff) if i["level"] == "error"]
    run.params = eff
    (run_dir / "params.json").write_text(json.dumps(eff, indent=2, default=str))
    return run, issues


def provenance(db: Session, run: Run, pipeline: Pipeline, version: PipelineVersion,
               experiment: Experiment | None) -> dict[str, Any]:
    inputs = []
    if experiment is not None:
        for smp in experiment.samples:
            pairs = [(r, v) for run_files in samplesheet._sample_runs(smp) for r, v in run_files.items()]
            if (smp.files or {}).get("raw"):
                pairs.append(("raw", smp.files["raw"]))
            for role, vp in pairs:
                if isinstance(vp, str) and vp:
                    try:
                        _, p = fs.resolve(vp)
                        st = p.stat()
                        inputs.append({"sample": smp.sample_id, "role": role, "path": str(p), "size": st.st_size,
                                       "mtime": st.st_mtime})
                    except Exception:
                        inputs.append({"sample": smp.sample_id, "role": role, "path": vp, "error": "unresolved"})
    inv = tools.inventory()
    return {
        "biocompute_run_id": run.id,
        "output_dir_created": bool(getattr(run, "_output_dir_created", False)),
        "created_by": run.created_by,
        "created_at": now().isoformat(),
        "pipeline": {"name": pipeline.name, "slug": pipeline.slug, "source": pipeline.source_url,
                     "version": version.version, "git_commit": version.git_commit, "path": version.path},
        "engine": {"name": run.engine,
                   "version": (inv.get("nextflow") or {}).get("version") if run.engine == "nextflow" else "bcflow-1"},
        "host": {"hostname": platform.node(), "os": platform.platform(), "python": sys.version.split()[0],
                 "cpus": os.cpu_count()},
        "software": {k: v for k, v in inv.items() if k != "nextflow" and v},
        "params_sha256": hashlib.sha256(json.dumps(run.params, sort_keys=True, default=str).encode()).hexdigest(),
        # reference genome assets by refgenie digest: the exact reference a result was made with
        "references": getattr(run, "_references", []),
        "resources": run.resources,
        "placement": run.placement,
        "experiment": {"id": experiment.id, "name": experiment.name, "samples": len(experiment.samples)} if experiment else None,
        "inputs": inputs,
    }


# --------------------------------------------------------------------------- launch / control
def _pid_start(pid: int) -> float | None:
    try:
        return psutil.Process(pid).create_time()
    except psutil.Error:
        return None


def _alive(run: Run) -> bool:
    if not run.pid:
        return False
    st = _pid_start(run.pid)
    return st is not None and (run.pid_start_time is None or abs(st - run.pid_start_time) < 2)


def active_count(db: Session) -> int:
    return db.query(Run).filter(Run.status.in_(("running", "cancelling"))).count()


# --------------------------------------------------------------------------- admission (CPU / memory accounting)
LOCAL_ACTIVE = ("running", "cancelling")


def controller_budget(db: Session) -> tuple[int, float]:
    """CPU cores and memory (GB) that runs on the controller may use together: the controller's allocation
    (Nodes, controller, Allocation), or the whole machine when it has none."""
    from ..models import Node
    cnode = db.query(Node).filter(Node.is_controller.is_(True)).first()
    if cnode is not None and cnode.allocation is not None and cnode.allocation.enabled:
        return max(1, int(cnode.allocation.max_cpus)), max(0.5, float(cnode.allocation.max_memory_gb))
    return os.cpu_count() or 1, round(psutil.virtual_memory().total / 1024 ** 3, 1)


def claim(run: Run) -> tuple[int, float]:
    """What a run reserves on the controller: its CPU and memory ceilings (the limits its engine is given).
    Runs sent to HTCondor run their tasks on other computers and reserve nothing here."""
    r = run.resources or {}
    if r.get("executor") == "condor":
        return 0, 0.0
    cpus = int(r.get("max_cpus") or (1 if run.engine == "bcflow" else os.cpu_count() or 1))
    mem = float(r.get("max_memory_gb") or (0 if run.engine == "bcflow" else 4))
    return cpus, mem


def local_load(db: Session, exclude: str | None = None) -> tuple[int, float, int]:
    """CPU cores and memory reserved by runs active on the controller, and how many such runs there are."""
    cpus, mem, n = 0, 0.0, 0
    for r in db.query(Run).filter(Run.status.in_(LOCAL_ACTIVE)).all():
        if r.id == exclude:
            continue
        c, m = claim(r)
        if c or m:
            cpus, mem, n = cpus + c, mem + m, n + 1
    return cpus, mem, n


def wait_reason(db: Session, run: Run) -> str | None:
    """Why the run cannot start now, or None. A run that alone needs more than the budget (the allocation was
    lowered after it was launched) starts when nothing else runs, so it cannot wait forever."""
    limit = get_settings().max_concurrent_runs
    if active_count(db) >= limit:
        return f"Waiting for a free execution slot: {limit} run{'s' if limit != 1 else ''} at a time (BIOCOMPUTE_MAX_CONCURRENT_RUNS)"
    c, m = claim(run)
    if not c and not m:
        return None
    used_c, used_m, n = local_load(db, exclude=run.id)
    if n == 0:
        return None
    cap_c, cap_m = controller_budget(db)
    if used_c + c > cap_c:
        return (f"Waiting for CPU cores: running analyses reserve {used_c} of the {cap_c} cores allowed on the controller "
                f"and this run needs {c}")
    if used_m + m > cap_m + 1e-6:
        return (f"Waiting for memory: running analyses reserve {used_m:g} of the {cap_m:g} GB allowed on the controller "
                f"and this run needs {m:g} GB")
    return None


def _note_wait(db: Session, run: Run, reason: str) -> None:
    if (run.provenance or {}).get("queue_reason") != reason:
        run.provenance = {**(run.provenance or {}), "queue_reason": reason}
        if run.status == "queued":
            add_event(db, run, "info", reason)


def start(db: Session, run: Run) -> None:
    """Preflight then spawn the wrapper (or queue if at capacity)."""
    version = db.get(PipelineVersion, run.pipeline_version_id)
    adapter = ADAPTERS[run.engine]
    set_status(db, run, "preflight")
    checks = adapter.preflight(Path(version.path), run.resources)
    failed = [c for c in checks if not c.ok and c.level == "error"]
    add_event(db, run, "preflight", f"{len(checks) - len(failed)}/{len(checks)} preflight checks passed",
              checks=[c.as_dict() for c in checks])
    if failed:
        run.error = "Preflight failed: " + "; ".join(f"{c.name}: {c.detail}" for c in failed)
        set_status(db, run, "failed", run.error)
        return
    with _launch_lock:
        reason = wait_reason(db, run)
        if reason:
            run.provenance = {**(run.provenance or {}), "queue_reason": reason}
            set_status(db, run, "queued", reason)
            return
        _spawn(db, run, version)


def engine_environ() -> dict[str, str]:
    """The environment pipeline code runs with: the service's, minus the controller's own configuration and
    keys (database URL and password, signing key, assistant API keys). Pipelines never need those."""
    return {k: v for k, v in os.environ.items() if not k.upper().startswith(("BIOCOMPUTE_", "ANTHROPIC_", "OPENAI_"))}


def _spawn(db: Session, run: Run, version: PipelineVersion) -> None:
    if "queue_reason" in (run.provenance or {}):
        run.provenance = {k: v for k, v in run.provenance.items() if k != "queue_reason"}
    run_dir = Path(run.run_dir)
    for f in ("exit_code", "cancelled", "wrapper.pid", "child.pid"):
        (run_dir / f).unlink(missing_ok=True)
    Path(run.output_dir).mkdir(parents=True, exist_ok=True)
    spec = ADAPTERS[run.engine].launch(
        pipeline_path=Path(version.path), run_dir=run_dir, work_dir=Path(run.work_dir),
        params_file=run_dir / "params.json", resources=run.resources,
        session_name=f"{run.nf_session_name}_{run.attempt}",
        resume_session=run.provenance.get("resume_session") if run.resumed_from or run.attempt > 1 else None,
    )
    (run_dir / "command.json").write_text(json.dumps({"argv": spec.argv, "cwd": spec.cwd, "env": spec.env}, indent=2))
    env = {**engine_environ(), **spec.env}
    with open(run_dir / "stdout.log", "ab") as fh:
        fh.write(f"[biocompute] attempt {run.attempt} - launching: {' '.join(spec.argv)}\n".encode())
    proc = subprocess.Popen(
        [sys.executable, str(WRAPPER), "--run-dir", str(run_dir), "--cwd", spec.cwd, "--", *spec.argv],
        cwd=spec.cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, close_fds=True,
    )
    run.pid = proc.pid
    run.pid_start_time = _pid_start(proc.pid)
    run.exit_code = None
    run.error = None
    run.finished_at = None
    set_status(db, run, "running", f"Started {run.engine} (pid {proc.pid}, attempt {run.attempt})")
    threading.Thread(target=proc.wait, daemon=True).start()  # reap zombie while controller lives


def cancel(db: Session, run: Run) -> None:
    if run.status == "queued" or run.status == "pending":
        set_status(db, run, "cancelled", "Cancelled before start")
        return
    if run.status not in ("running", "cancelling"):
        raise HTTPException(409, f"Run is {run.status}")
    ready = Path(run.run_dir) / "wrapper.pid"
    deadline = time.time() + 5
    while run.pid and not ready.exists() and time.time() < deadline and _alive(run):
        time.sleep(0.05)  # supervisor still starting; its signal handler is not installed yet
    if run.pid and _alive(run):
        try:  # the supervisor forwards SIGTERM to the engine, which shuts down its tasks gracefully
            os.kill(run.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    run.provenance = {**run.provenance, "cancel_requested_at": time.time()}
    set_status(db, run, "cancelling", "Cancellation requested (SIGTERM sent; engine shutting down gracefully)")


def resume(db: Session, run: Run, user: str) -> Run:
    if run.status in ACTIVE:
        raise HTTPException(409, "Run is still active")
    run.attempt += 1
    run.provenance = {**run.provenance, "resume_session": f"{run.nf_session_name}_{run.attempt - 1}"}
    run.progress = {}
    add_event(db, run, "info", f"Resume requested by {user} (attempt {run.attempt}); cached tasks will be reused")
    start(db, run)
    return run


# --------------------------------------------------------------------------- monitor
_poll_failures: dict[str, int] = {}
MAX_POLL_FAILURES = 5


def _poll_run(db: Session, run: Run) -> None:
    rd = Path(run.run_dir)
    try:
        prog = parse_progress(rd)
        if prog != run.progress:
            newly_failed = prog["failed"] - (run.progress or {}).get("failed", 0)
            run.progress = prog
            if newly_failed > 0:
                add_event(db, run, "task", f"{newly_failed} task(s) failed")
            events.publish("run", {"run_id": run.id, "kind": "progress", "status": run.status,
                                   "done": prog["done"], "total": prog["total"]})
    except Exception as exc:  # never let parsing kill the monitor
        run.progress = {**(run.progress or {}), "parse_error": str(exc)}
    ec_file = rd / "exit_code"
    if ec_file.exists():
        try:
            rc = int(ec_file.read_text().strip() or 1)
        except ValueError:
            rc = 1
        run.exit_code = rc
        if (rd / "cancelled").exists() or run.status == "cancelling":
            set_status(db, run, "cancelled", f"Run cancelled (engine exit code {rc})")
        elif rc == 0:
            set_status(db, run, "completed", "Pipeline completed successfully")
            if cleanup_after_success(run):
                freed = remove_work_dir(run)
                if freed:
                    add_event(db, run, "cleanup", f"Intermediate files removed: {freed / 2**20:.1f} MB freed")
        else:
            run.error = _error_excerpt(rd) or f"Engine exited with code {rc}"
            set_status(db, run, "failed", f"Pipeline failed (exit code {rc})")
        _write_provenance_final(run)
    elif not _alive(run):
        if run.status == "cancelling":
            set_status(db, run, "cancelled", "Run cancelled (supervisor terminated)")
        else:
            run.error = "Execution supervisor disappeared without recording an exit code (host reboot or kill -9?)"
            set_status(db, run, "lost", run.error)
    elif run.status == "cancelling":
        t0 = (run.provenance or {}).get("cancel_requested_at", time.time())
        if time.time() - t0 > 60:
            try:
                os.killpg(os.getpgid(run.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def _poll_once() -> None:
    """One monitor pass. Each run is handled and committed on its own: a problem with one run (an unreadable
    folder, a broken file) must not stop the others from being updated or queued runs from starting."""
    db = SessionLocal()
    try:
        ids = [r.id for r in db.query(Run.id).filter(Run.status.in_(("running", "cancelling"))).all()]
        for rid in ids:
            try:
                run = db.get(Run, rid)
                if run is None or run.status not in ("running", "cancelling"):
                    continue
                _poll_run(db, run)
                db.commit()
                _poll_failures.pop(rid, None)
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                n = _poll_failures[rid] = _poll_failures.get(rid, 0) + 1
                if n >= MAX_POLL_FAILURES:
                    try:
                        run = db.get(Run, rid)
                        if run is not None:
                            run.error = f"BioCompute could not read this run's state {n} times in a row: {exc}"
                            set_status(db, run, "lost", run.error)
                            db.commit()
                    except Exception:  # noqa: BLE001
                        db.rollback()
                    _poll_failures.pop(rid, None)
        # start queued runs when capacity frees up
        queued = [r.id for r in db.query(Run.id).filter(Run.status == "queued").order_by(Run.created_at).all()]
        for rid in queued:
            try:
                with _launch_lock:
                    run = db.get(Run, rid)
                    if run is None or run.status != "queued":
                        continue
                    reason = wait_reason(db, run)
                    if reason:
                        # first come, first served: a later, smaller run does not overtake one that waits for room
                        _note_wait(db, run, reason)
                        db.commit()
                        break
                    _spawn(db, run, db.get(PipelineVersion, run.pipeline_version_id))
                db.commit()
            except Exception as exc:  # noqa: BLE001 - a run that cannot start must not block the queue behind it
                db.rollback()
                try:
                    run = db.get(Run, rid)
                    if run is not None:
                        run.error = f"The run could not be started: {exc}"
                        set_status(db, run, "failed", run.error)
                        db.commit()
                except Exception:  # noqa: BLE001
                    db.rollback()
    finally:
        db.close()


# --------------------------------------------------------------------------- storage
def dir_size(p: Path, limit: int = 2_000_000) -> int:
    """Bytes of the files under p (stops counting after `limit` entries)."""
    total, n = 0, 0
    stack = [p]
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    n += 1
                    if n > limit:
                        return total
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(Path(e.path))
                        elif e.is_file(follow_symlinks=False):
                            total += e.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def _own_work_dir(run: Run) -> Path | None:
    """The run's work folder, only when it is inside BioCompute's own runs folder (never a user folder)."""
    if not run.work_dir:
        return None
    w = Path(run.work_dir).resolve()
    try:
        w.relative_to(get_settings().runs_path.resolve())
    except ValueError:
        return None
    return w


def cleanup_after_success(run: Run) -> bool:
    return get_settings().cleanup_intermediates and not (run.resources or {}).get("keep_work")


def remove_work_dir(run: Run) -> int:
    """Delete a run's intermediate files (its work folder). Results in the output folder are not touched.
    Afterwards Resume cannot reuse finished steps. Returns the bytes freed."""
    w = _own_work_dir(run)
    if w is None or not w.exists():
        return 0
    size = dir_size(w)
    shutil.rmtree(w, ignore_errors=True)
    return size


def _error_excerpt(rd: Path) -> str | None:
    log = rd / "stdout.log"
    if not log.exists():
        return None
    text = log.read_text(errors="replace")
    idx = text.rfind("ERROR ~")
    if idx >= 0:
        return text[idx: idx + 4000]
    return "\n".join(text.splitlines()[-30:])


def _write_provenance_final(run: Run) -> None:
    rd = Path(run.run_dir)
    prov = dict(run.provenance or {})
    prov.update({"status": run.status, "exit_code": run.exit_code,
                 "finished_at": now().isoformat(), "progress_summary": {k: run.progress.get(k) for k in ("total", "done", "failed")}})
    outputs = []
    out = Path(run.output_dir)
    try:
        if out.is_dir():
            for p in sorted(out.rglob("*")):
                if len(outputs) >= 5000:
                    break
                try:
                    if p.is_file():
                        outputs.append({"path": str(p.relative_to(out)), "size": p.stat().st_size})
                except OSError:
                    continue  # a file that vanished or cannot be read is simply not listed
    except OSError:
        pass
    prov["outputs"] = outputs
    run.provenance = prov
    try:
        (rd / "provenance.json").write_text(json.dumps(prov, indent=2, default=str))
        if out.is_dir():
            (out / "biocompute_provenance.json").write_text(json.dumps(prov, indent=2, default=str))
    except OSError:
        pass


def _loop(interval: float) -> None:
    while True:
        try:
            _poll_once()
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[biocompute] monitor error: {exc}", file=sys.stderr)
        time.sleep(interval)


def start_monitor(interval: float = 2.0) -> None:
    if _monitor_started.is_set():
        return
    _monitor_started.set()
    threading.Thread(target=_loop, args=(interval,), daemon=True, name="run-monitor").start()


def reconcile() -> dict[str, int]:
    """Called at start-up: re-attach to or close out runs that were active before a restart."""
    db = SessionLocal()
    stats = {"reattached": 0, "finished": 0, "lost": 0}
    try:
        for run in db.query(Run).filter(Run.status.in_(("running", "cancelling", "preflight", "pending"))).all():
            if run.status in ("preflight", "pending"):
                run.error = "Controller restarted before launch completed"
                set_status(db, run, "failed", run.error)
                continue
            if (Path(run.run_dir) / "exit_code").exists():
                stats["finished"] += 1  # monitor will finalize
            elif _alive(run):
                add_event(db, run, "info", "Controller restarted - re-attached to running pipeline")
                stats["reattached"] += 1
            else:
                stats["lost"] += 1
        db.commit()
    finally:
        db.close()
    return stats


def read_log(run: Run, which: str = "stdout", offset: int = 0, limit: int = 256_000) -> dict[str, Any]:
    names = {"stdout": "stdout.log", "nextflow": "nextflow.log"}
    p = Path(run.run_dir) / names.get(which, "stdout.log")
    if not p.exists():
        return {"content": "", "offset": 0, "size": 0}
    size = p.stat().st_size
    if offset > size:
        offset = 0
    with open(p, "rb") as fh:
        fh.seek(offset)
        data = fh.read(limit)
    return {"content": data.decode("utf-8", errors="replace"), "offset": offset + len(data), "size": size}
