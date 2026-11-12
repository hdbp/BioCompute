from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal, get_db
from ..models import Experiment, Node, Pipeline, PipelineVersion, Run, RunEvent, User
from ..schemas import RunCreate, RunDetail, RunOut
from ..security import audit, require_media_viewer, require_scientist, require_viewer
import shutil

from ..services import access, cluster, events, fs, runner
from ..services.pipelines import runnable_engines
from .pipelines import get_pipeline, get_version

router = APIRouter(prefix="/api/runs", tags=["runs"])
jobs_router = APIRouter(prefix="/api/jobs", tags=["runs"])
results_router = APIRouter(prefix="/api/results", tags=["results"])


def _out(db: Session, r: Run, cls=RunOut, user: User | None = None, **extra):
    o = cls.model_validate({**{c: getattr(r, c) for c in RunOut.model_fields if hasattr(r, c)}, **extra})
    o.can_edit = bool(user) and access.can_edit(user, r.created_by)
    p = db.get(Pipeline, r.pipeline_id)
    v = db.get(PipelineVersion, r.pipeline_version_id)
    o.pipeline_name = p.name if p else None
    o.pipeline_version = v.version if v else None
    if r.experiment_id:
        e = db.get(Experiment, r.experiment_id)
        o.experiment_name = e.name if e else None
    o.output_vpath = fs.to_virtual(Path(r.output_dir))
    return o


# What a client may ask for. Where a run executes (executor, nodes) and where it works (work_dir) are decided
# by the server from the placement rules, never taken from the request.
CLIENT_RESOURCES = {"max_cpus": (1, 4096), "max_memory_gb": (0.5, 65536), "min_memory_gb": (0, 65536), "min_disk_gb": (0, 10_000_000),
                    "max_time_h": (1, 24 * 365), "queue_size": (1, 10000), "controller_heap_gb": (1, 256)}


def clean_resources(raw: dict) -> dict:
    out: dict = {}
    for k, (lo, hi) in CLIENT_RESOURCES.items():
        if raw.get(k) in (None, ""):
            continue
        try:
            v = float(raw[k])
        except (TypeError, ValueError):
            raise HTTPException(422, f"{k} must be a number") from None
        if not lo <= v <= hi:
            raise HTTPException(422, f"{k} must be between {lo:g} and {hi:g}")
        out[k] = v
    if raw.get("requires_gpu"):
        out["requires_gpu"] = True
    if raw.get("keep_work"):
        out["keep_work"] = True  # keep intermediate files (debugging); they are deleted otherwise
    prof = raw.get("profile")
    if prof:
        if not isinstance(prof, str) or not re.fullmatch(r"[A-Za-z0-9_.,-]{1,200}", prof):
            raise HTTPException(422, "profile: letters, digits, _ . - and commas only")
        out["profile"] = prof
    return out


def scan_inputs(exp: Experiment | None, params: dict) -> tuple[bool, int, list[str]]:
    """Every file a run would read: (any in a restricted data folder, total bytes, existing paths outside all data folders).

    Looks at the experiment's sample files, at parameters holding paths (data-folder paths or absolute paths), and
    inside a samplesheet given as `input`. A FASTQ folder counts with the files in it.
    """
    restricted = False
    total = 0
    outside: list[str] = []
    seen: set[str] = set()

    def visit(value: object, deep: bool = False) -> None:
        nonlocal restricted, total
        if not isinstance(value, str) or not value or value in seen or len(value) > 4096 or "\n" in value:
            return
        seen.add(value)
        head = value.split("/", 1)[0]
        path: Path | None = None
        root = None
        if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", value):
            return  # a URL (or refgenie://, resolved later into its own data folder)
        if ":" in head and not value.startswith(("/", "~")):
            if head.split(":", 1)[0] not in fs.roots():
                return  # not a data-folder path (an ordinary value with a colon)
            try:
                root, path = fs.resolve(value, must_exist=False)
            except HTTPException:
                return
        elif value.startswith(("/", "~")):
            path = Path(value).expanduser()
            try:
                exists = path.exists()
            except OSError:
                exists = False
            if not exists:
                return
            root = fs.root_of(path)
            if root is None:
                outside.append(value)
                return
        else:
            return
        restricted |= root.restricted
        try:
            if path.is_file():
                total += path.stat().st_size
                if deep and path.suffix.lower() in (".csv", ".tsv", ".txt") and path.stat().st_size < 5_000_000:
                    for line in path.read_text(errors="replace").splitlines()[:20000]:
                        for cell in re.split(r"[,\t]", line):
                            visit(cell.strip().strip('"'))
            elif path.is_dir() and deep:
                n = 0
                for f in path.rglob("*"):
                    n += 1
                    if n > 20000:
                        break
                    try:
                        if f.is_file():
                            total += f.stat().st_size
                    except OSError:
                        continue
        except OSError:
            pass

    if exp:
        for s in exp.samples:
            for vp in (s.files or {}).values():
                for one in (vp if isinstance(vp, list) else [vp]):
                    visit(one)
    for key, val in (params or {}).items():
        for one in (val if isinstance(val, list) else [val]):
            visit(one, deep=key == "input")
    return restricted, total, outside


def can_view_run(db: Session, user: User, r: Run) -> bool:
    """A run is visible to whoever may see its pipeline and its experiment (private ones stay private)."""
    if user.role == "admin" or r.created_by == user.username:
        return True
    p = db.get(Pipeline, r.pipeline_id)
    if p is not None and not access.can_view(user, p.owner, p.visibility):
        return False
    if r.experiment_id:
        e = db.get(Experiment, r.experiment_id)
        if e is not None and not access.can_view(user, e.created_by, e.visibility):
            return False
    return True


def get_run(db: Session, rid: str, user: User | None = None, edit: bool = False) -> Run:
    """A run the user may see; `edit` (cancel, resume, delete) needs who started it, or an administrator."""
    r = db.get(Run, rid)
    if not r or (user is not None and not can_view_run(db, user, r)):
        raise HTTPException(404, "Run not found")
    if user is not None and edit:
        access.check_edit(user, r.created_by, f"Run “{r.name}”")
    return r


@router.get("", response_model=list[RunOut])
def list_runs(status: str | None = None, pipeline_id: str | None = None, limit: int = 200, mine: bool = False,
              user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    q = db.query(Run)
    if status:
        q = q.filter(Run.status.in_(status.split(",")))
    if pipeline_id:
        q = q.filter(Run.pipeline_id == pipeline_id)
    if mine:
        q = q.filter(Run.created_by == user.username)
    out = []
    for r in q.order_by(Run.created_at.desc()).limit(min(limit, 1000) * 2).all():
        if can_view_run(db, user, r):
            out.append(_out(db, r, user=user))
        if len(out) >= min(limit, 1000):
            break
    return out


@router.post("", response_model=RunDetail)
def create_run(body: RunCreate, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = get_pipeline(db, body.pipeline_id, user)
    v = get_version(p, body.version_id)
    engine = body.engine
    if engine is None:
        avail = [e for e in runnable_engines(v) if e["available"]]
        if not avail:
            raise HTTPException(400, "No available engine can run this pipeline on the controller "
                                     f"(supports {v.engines}); see Settings → Execution environment")
        engine = avail[0]["engine"]
    exp = db.get(Experiment, body.experiment_id) if body.experiment_id else None
    if body.experiment_id and (not exp or not access.can_view(user, exp.created_by, exp.visibility)):
        raise HTTPException(404, "Experiment not found")
    res = clean_resources(body.resources)
    # data-locality-aware placement: every input counts, not only the experiment's files
    restricted, input_bytes, outside = scan_inputs(exp, body.params)
    if outside:
        raise HTTPException(422, {"message": "Some inputs are outside the data folders BioCompute may use",
                                  "issues": [{"level": "error", "message": f"{x} is not inside a data folder. An admin can add its folder in "
                                              "Settings, Controller, Data folders."} for x in outside[:20]]})
    # max_cpus / max_memory_gb are ceilings; min_memory_gb / min_disk_gb / requires_gpu are hard requirements
    plan = cluster.placement(db, input_bytes=input_bytes, restricted=restricted,
                             requested_cpus=int(res.get("max_cpus") or 0), requested_mem_gb=float(res.get("min_memory_gb") or 0),
                             requested_nodes=body.node_ids or None, requires_gpu=bool(res.get("requires_gpu")),
                             requested_disk_gb=float(res["min_disk_gb"]) if res.get("min_disk_gb") else None)
    eligible = [c for c in plan["candidates"] if c["eligible"]]
    if body.node_ids:
        selected = eligible
        if not selected:
            raise HTTPException(400, "None of the selected nodes may run this analysis: " +
                                "; ".join(f"{c['hostname']}: {', '.join(c['reasons'])}" for c in plan["candidates"] if c["node_id"] in body.node_ids))
    else:
        # default: data-local execution on the controller; other nodes only when the user selects them
        ctl = next((c for c in plan["candidates"] if c["is_controller"]), None)
        if ctl is None or not ctl["eligible"]:
            raise HTTPException(400, "The controller cannot run this analysis right now" +
                                (f" ({', '.join(ctl['reasons'])})" if ctl else "") + ". Select execution nodes explicitly.")
        selected = [ctl]
    controller = next((c for c in selected if c["is_controller"]), None)
    if len(selected) > 1 or (selected and not controller):
        if engine != "nextflow":
            raise HTTPException(400, "Multi-node or remote execution requires the Nextflow engine with HTCondor")
        res["executor"] = "condor"
        res["nodes"] = [c["hostname"] for c in selected]
    # never exceed the allocation of the controller for local runs (oversubscription guard)
    if res.get("executor") != "condor":
        cnode = db.query(Node).filter(Node.is_controller.is_(True)).first()
        if cnode and cnode.allocation:
            cap_c, cap_m = cnode.allocation.max_cpus, cnode.allocation.max_memory_gb
            res["max_cpus"] = min(int(res.get("max_cpus") or cap_c), cap_c)
            res["max_memory_gb"] = min(float(res.get("max_memory_gb") or cap_m), cap_m)
            res["limits_source"] = "controller allocation (scheduler-enforced by Nextflow executor limits, not OS-enforced)"
    placement = {"selected": [c["hostname"] for c in selected] or ["controller"], "restricted_inputs": restricted,
                 "input_bytes": input_bytes, "estimate": plan["estimate"], "executor": res.get("executor", "local"),
                 "nodes": [{k: c[k] for k in ("hostname", "facts", "warnings", "estimated_seconds")} for c in selected],
                 "fastest": plan["fastest"]["hostname"] if plan["fastest"] else None}
    run, issues = runner.prepare(db, pipeline=p, version=v, engine=engine, params=body.params, output_vpath=body.output_dir,
                                 experiment=exp, resources=res, name=body.name, user=user.username,
                                 column_map=body.column_map, placement=placement)
    if issues:
        db.rollback()
        shutil.rmtree(run.run_dir, ignore_errors=True)
        raise HTTPException(422, {"message": "Validation failed", "issues": issues})
    if body.dry_run:
        detail = _detail(db, run, user)
        db.rollback()
        shutil.rmtree(run.run_dir, ignore_errors=True)
        return detail
    run.provenance = runner.provenance(db, run, p, v, exp)
    Path(run.run_dir, "provenance.json").write_text(json.dumps(run.provenance, indent=2, default=str))
    audit(db, user.username, "run.launch", run.id, pipeline=p.slug, engine=engine, output=body.output_dir)
    if body.project_id:  # list the run in the project; a project the user cannot change is ignored, not an error
        from ..models import Project
        from .projects import add_item
        proj = db.get(Project, body.project_id)
        if proj and access.can_view(user, proj.owner, proj.visibility) and access.can_edit(user, proj.owner):
            add_item(db, proj, user, run.id, "run")
    db.commit()
    runner.start(db, run)
    db.commit()
    return _detail(db, run, user)


def _detail(db: Session, r: Run, user: User | None = None) -> RunDetail:
    evs = db.query(RunEvent).filter(RunEvent.run_id == r.id).order_by(RunEvent.id).all() if r.id else []
    w = runner._own_work_dir(r) if r.id else None
    extra = {"work_bytes": runner.dir_size(w, limit=200_000) if w is not None and w.exists() else 0,
             "results_deletable": bool(r.id) and _deletable_results(r) is not None}
    return _out(db, r, RunDetail, user=user, provenance=r.provenance or {}, **extra,
                events=[{"id": e.id, "ts": e.ts, "kind": e.kind, "message": e.message, "data": e.data} for e in evs])


@router.get("/capacity")
def capacity(_: User = Depends(require_viewer), db: Session = Depends(get_db)):
    """CPU cores and memory runs on the controller may use together, and how much running analyses reserve.
    A new run that does not fit waits in the queue until enough is free."""
    cap_c, cap_m = runner.controller_budget(db)
    used_c, used_m, n = runner.local_load(db)
    return {"cpus": cap_c, "memory_gb": cap_m, "used_cpus": used_c, "used_memory_gb": round(used_m, 2), "running": n,
            "queued": db.query(Run).filter(Run.status == "queued").count(),
            "max_concurrent_runs": get_settings().max_concurrent_runs}


@router.get("/{rid}", response_model=RunDetail)
def run_detail(rid: str, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return _detail(db, get_run(db, rid, user), user)


@router.post("/{rid}/cancel", response_model=RunOut)
def cancel_run(rid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    r = get_run(db, rid, user, edit=True)
    runner.cancel(db, r)
    audit(db, user.username, "run.cancel", r.id)
    db.commit()
    return _out(db, r, user=user)


@router.post("/{rid}/resume", response_model=RunOut)
def resume_run(rid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    r = get_run(db, rid, user, edit=True)
    runner.resume(db, r, user.username)
    audit(db, user.username, "run.resume", r.id, attempt=r.attempt)
    db.commit()
    return _out(db, r, user=user)


@router.post("/{rid}/clean-work")
def clean_work(rid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Delete a finished run's intermediate files. Its results are kept; Resume then repeats every step."""
    r = get_run(db, rid, user, edit=True)
    if r.status not in runner.TERMINAL:
        raise HTTPException(409, "The run is still active")
    freed = runner.remove_work_dir(r)
    runner.add_event(db, r, "cleanup", f"Intermediate files removed by {user.username}: {freed / 2**20:.1f} MB freed")
    audit(db, user.username, "run.clean_work", r.id, freed=freed)
    db.commit()
    return {"freed": freed}


def _deletable_results(r: Run) -> Path | None:
    """The run's output folder, when deleting the run may also delete it: BioCompute created it for this run, it is
    inside a writable data folder, and no other run writes there."""
    if not (r.provenance or {}).get("output_dir_created"):
        return None
    out = Path(r.output_dir).resolve()
    root = fs.root_of(out)
    if root is None or not root.writable or out == root.path.resolve():
        return None
    return out


@router.delete("/{rid}")
def delete_run(rid: str, results: bool = False, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Delete a finished run: its record, log and intermediate files; with results=true also the output folder it created."""
    r = get_run(db, rid, user, edit=True)
    if r.status not in runner.TERMINAL:
        raise HTTPException(409, "Cancel the run first")
    out = _deletable_results(r) if results else None
    if results and out is None:
        raise HTTPException(409, "The results folder was not created by this run (or is shared with others); it is kept. "
                                 "Delete the run without its results, or remove the folder in Data Explorer.")
    if out is not None and db.query(Run).filter(Run.output_dir == r.output_dir, Run.id != r.id).count():
        raise HTTPException(409, "Another run writes to the same results folder; it is kept")
    freed = runner.remove_work_dir(r)
    rd = Path(r.run_dir).resolve()
    if rd.is_relative_to(get_settings().runs_path.resolve()) and rd.exists():
        freed += runner.dir_size(rd)
        runner.remove_tree(rd)
    if out is not None and out.exists():
        freed += runner.dir_size(out)
        runner.remove_tree(out)
    from ..models import Project
    for proj in db.query(Project).all():  # the run disappears from projects that listed it
        items = [i for i in (proj.items or []) if not (i.get("kind") == "run" and i.get("ref") == r.id)]
        if len(items) != len(proj.items or []):
            proj.items = items
    db.query(RunEvent).filter(RunEvent.run_id == r.id).delete()
    audit(db, user.username, "run.delete", r.id, name=r.name, with_results=out is not None, freed=freed)
    db.delete(r)
    db.commit()
    return {"ok": True, "freed": freed, "results_deleted": out is not None}


@router.get("/{rid}/log")
def run_log(rid: str, which: str = "stdout", offset: int = 0, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return runner.read_log(get_run(db, rid, user), which, offset)


@router.get("/{rid}/files/{name}")
def run_file(rid: str, name: str, user: User = Depends(require_media_viewer), db: Session = Depends(get_db)):
    allowed = {"params.json", "samplesheet.csv", "experimental_design.tsv", "provenance.json", "trace.txt",
               "report.html", "timeline.html", "biocompute.config", "command.json", "nextflow.log", "stdout.log"}
    if name not in allowed:
        raise HTTPException(404)
    p = Path(get_run(db, rid, user).run_dir) / name
    if not p.exists():
        raise HTTPException(404, f"{name} not available for this run")
    return FileResponse(p, media_type="text/html" if name.endswith(".html") else "text/plain")


@router.get("/{rid}/stream")
async def stream_run(rid: str, request: Request, user: User = Depends(require_media_viewer)):
    """Server-sent events: incremental log lines and status/progress changes for one run."""
    with SessionLocal() as db:
        run = get_run(db, rid, user)
        offset = max(0, runner.read_log(run, "stdout", 0, 0)["size"] - 64_000)
    sub = events.subscribe()

    async def gen():
        nonlocal offset
        try:
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                with SessionLocal() as db:
                    run = db.get(Run, rid)
                    chunk = runner.read_log(run, "stdout", offset)
                    status = {"status": run.status, "progress": {k: run.progress.get(k) for k in ("total", "done", "failed")},
                              "processes": run.progress.get("processes", {}), "exit_code": run.exit_code}
                if chunk["content"]:
                    offset = chunk["offset"]
                    yield f"event: log\ndata: {json.dumps(chunk['content'])}\n\n"
                yield f"event: status\ndata: {json.dumps(status)}\n\n"
                if status["status"] in runner.TERMINAL:
                    yield "event: end\ndata: {}\n\n"
                    break
                try:
                    await asyncio.wait_for(sub[1].get(), timeout=2.0)
                except asyncio.TimeoutError:
                    pass
        finally:
            events.unsubscribe(sub)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------------------------- jobs (tasks)
@jobs_router.get("")
def list_jobs(user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    out = []
    for r in db.query(Run).filter(Run.status.in_(("running", "cancelling", "queued"))).all():
        if not can_view_run(db, user, r):
            continue
        for t in (r.progress or {}).get("tasks", []):
            out.append({**t, "run_id": r.id, "run_name": r.name})
    return out


# --------------------------------------------------------------------------- results
@results_router.get("")
def list_results(user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    runs = db.query(Run).filter(Run.status.in_(("completed", "failed", "cancelled"))).order_by(Run.finished_at.desc()).limit(400).all()
    out = []
    for r in runs:
        if not can_view_run(db, user, r) or len(out) >= 200:
            continue
        o = _out(db, r, user=user)
        outputs = (r.provenance or {}).get("outputs", [])
        out.append({**o.model_dump(), "output_count": len(outputs), "output_bytes": sum(x.get("size", 0) for x in outputs)})
    return out


@results_router.get("/{rid}")
def run_results(rid: str, path: str = "", user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    r = get_run(db, rid, user)
    base = Path(r.output_dir).resolve()
    target = (base / path).resolve()
    if not target.is_relative_to(base):
        raise HTTPException(403, "Path escapes the run's output directory")
    if not target.exists():
        return {"base": str(base), "path": path, "entries": [], "missing": True}
    if target.is_file():
        raise HTTPException(400, "Not a directory")
    entries = []
    for p in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        st = p.stat()
        entries.append({"name": p.name, "path": p.relative_to(base).as_posix(), "type": "dir" if p.is_dir() else "file",
                        "kind": "dir" if p.is_dir() else fs.classify(p.name), "size": None if p.is_dir() else st.st_size,
                        "mtime": st.st_mtime})
    return {"base": str(base), "path": path, "entries": entries, "missing": False, "vpath": fs.to_virtual(base)}


@results_router.get("/{rid}/file")
def result_file(rid: str, path: str, download: bool = False, user: User = Depends(require_media_viewer), db: Session = Depends(get_db)):
    r = get_run(db, rid, user)
    base = Path(r.output_dir).resolve()
    target = (base / path).resolve()
    if not target.is_relative_to(base) or not target.is_file():
        raise HTTPException(404)
    if download:
        return FileResponse(target, filename=target.name)
    if target.suffix in (".html", ".htm"):
        return FileResponse(target, media_type="text/html", headers={"Content-Security-Policy": "sandbox allow-scripts"})
    if target.suffix == ".svg":  # an SVG can carry scripts: opened directly it must not run them with the app's origin
        return FileResponse(target, headers={"Content-Security-Policy": "sandbox"})
    if target.suffix in (".png", ".jpg", ".jpeg", ".pdf"):
        return FileResponse(target)
    with target.open("rb") as fh:  # only the part that is shown (the file may be a multi-GB BAM)
        data = fh.read(200_000)
    if b"\x00" in data[:4096]:
        return {"binary": True, "size": target.stat().st_size}
    return {"binary": False, "size": target.stat().st_size, "content": data.decode("utf-8", errors="replace"),
            "truncated": target.stat().st_size > 200_000}
