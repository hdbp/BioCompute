from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from ..db import SessionLocal, get_db
from ..models import Experiment, Node, Pipeline, PipelineVersion, Run, RunEvent, User
from ..schemas import RunCreate, RunDetail, RunOut
from ..security import audit, get_current_user, require_scientist, require_viewer
import shutil

from ..services import cluster, events, fs, runner
from ..services.pipelines import runnable_engines
from .pipelines import get_pipeline, get_version

router = APIRouter(prefix="/api/runs", tags=["runs"])
jobs_router = APIRouter(prefix="/api/jobs", tags=["runs"])
results_router = APIRouter(prefix="/api/results", tags=["results"])


def _out(db: Session, r: Run, cls=RunOut, **extra):
    o = cls.model_validate({**{c: getattr(r, c) for c in RunOut.model_fields if hasattr(r, c)}, **extra})
    p = db.get(Pipeline, r.pipeline_id)
    v = db.get(PipelineVersion, r.pipeline_version_id)
    o.pipeline_name = p.name if p else None
    o.pipeline_version = v.version if v else None
    if r.experiment_id:
        e = db.get(Experiment, r.experiment_id)
        o.experiment_name = e.name if e else None
    o.output_vpath = fs.to_virtual(Path(r.output_dir))
    return o


def get_run(db: Session, rid: str) -> Run:
    r = db.get(Run, rid)
    if not r:
        raise HTTPException(404, "Run not found")
    return r


@router.get("", response_model=list[RunOut])
def list_runs(status: str | None = None, pipeline_id: str | None = None, limit: int = 200,
              _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    q = db.query(Run)
    if status:
        q = q.filter(Run.status.in_(status.split(",")))
    if pipeline_id:
        q = q.filter(Run.pipeline_id == pipeline_id)
    return [_out(db, r) for r in q.order_by(Run.created_at.desc()).limit(min(limit, 1000)).all()]


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
    if body.experiment_id and not exp:
        raise HTTPException(404, "Experiment not found")
    res = dict(body.resources)
    # data-locality-aware placement
    restricted = False
    input_bytes = 0
    if exp:
        for s in exp.samples:
            for vp in (s.files or {}).values():
                if isinstance(vp, str) and vp:
                    try:
                        root, path = fs.resolve(vp)
                        restricted |= root.restricted
                        input_bytes += path.stat().st_size if path.is_file() else 0
                    except HTTPException:
                        pass
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
        detail = _detail(db, run)
        db.rollback()
        shutil.rmtree(run.run_dir, ignore_errors=True)
        return detail
    run.provenance = runner.provenance(db, run, p, v, exp)
    Path(run.run_dir, "provenance.json").write_text(json.dumps(run.provenance, indent=2, default=str))
    audit(db, user.username, "run.launch", run.id, pipeline=p.slug, engine=engine, output=body.output_dir)
    if body.project_id:  # list the run in the project; a project the user cannot change is ignored, not an error
        from ..models import Project
        from ..services import access
        from .projects import add_item
        proj = db.get(Project, body.project_id)
        if proj and access.can_view(user, proj.owner, proj.visibility) and access.can_edit(user, proj.owner):
            add_item(db, proj, user, run.id, "run")
    db.commit()
    runner.start(db, run)
    db.commit()
    return _detail(db, run)


def _detail(db: Session, r: Run) -> RunDetail:
    evs = db.query(RunEvent).filter(RunEvent.run_id == r.id).order_by(RunEvent.id).all() if r.id else []
    return _out(db, r, RunDetail, provenance=r.provenance or {},
                events=[{"id": e.id, "ts": e.ts, "kind": e.kind, "message": e.message, "data": e.data} for e in evs])


@router.get("/{rid}", response_model=RunDetail)
def run_detail(rid: str, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return _detail(db, get_run(db, rid))


@router.post("/{rid}/cancel", response_model=RunOut)
def cancel_run(rid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    r = get_run(db, rid)
    runner.cancel(db, r)
    audit(db, user.username, "run.cancel", r.id)
    db.commit()
    return _out(db, r)


@router.post("/{rid}/resume", response_model=RunOut)
def resume_run(rid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    r = get_run(db, rid)
    runner.resume(db, r, user.username)
    audit(db, user.username, "run.resume", r.id, attempt=r.attempt)
    db.commit()
    return _out(db, r)


@router.get("/{rid}/log")
def run_log(rid: str, which: str = "stdout", offset: int = 0, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return runner.read_log(get_run(db, rid), which, offset)


@router.get("/{rid}/files/{name}")
def run_file(rid: str, name: str, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    allowed = {"params.json", "samplesheet.csv", "experimental_design.tsv", "provenance.json", "trace.txt",
               "report.html", "timeline.html", "biocompute.config", "command.json", "nextflow.log", "stdout.log"}
    if name not in allowed:
        raise HTTPException(404)
    p = Path(get_run(db, rid).run_dir) / name
    if not p.exists():
        raise HTTPException(404, f"{name} not available for this run")
    return FileResponse(p, media_type="text/html" if name.endswith(".html") else "text/plain")


@router.get("/{rid}/stream")
async def stream_run(rid: str, request: Request, user: User = Depends(get_current_user)):
    """Server-sent events: incremental log lines and status/progress changes for one run."""
    with SessionLocal() as db:
        run = get_run(db, rid)
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
def list_jobs(_: User = Depends(require_viewer), db: Session = Depends(get_db)):
    out = []
    for r in db.query(Run).filter(Run.status.in_(("running", "cancelling", "queued"))).all():
        for t in (r.progress or {}).get("tasks", []):
            out.append({**t, "run_id": r.id, "run_name": r.name})
    return out


# --------------------------------------------------------------------------- results
@results_router.get("")
def list_results(_: User = Depends(require_viewer), db: Session = Depends(get_db)):
    runs = db.query(Run).filter(Run.status.in_(("completed", "failed", "cancelled"))).order_by(Run.finished_at.desc()).limit(200).all()
    out = []
    for r in runs:
        o = _out(db, r)
        outputs = (r.provenance or {}).get("outputs", [])
        out.append({**o.model_dump(), "output_count": len(outputs), "output_bytes": sum(x.get("size", 0) for x in outputs)})
    return out


@results_router.get("/{rid}")
def run_results(rid: str, path: str = "", _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    r = get_run(db, rid)
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
def result_file(rid: str, path: str, download: bool = False, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    r = get_run(db, rid)
    base = Path(r.output_dir).resolve()
    target = (base / path).resolve()
    if not target.is_relative_to(base) or not target.is_file():
        raise HTTPException(404)
    if download:
        return FileResponse(target, filename=target.name)
    if target.suffix in (".html", ".htm"):
        return FileResponse(target, media_type="text/html", headers={"Content-Security-Policy": "sandbox allow-scripts"})
    if target.suffix in (".png", ".jpg", ".jpeg", ".svg", ".pdf"):
        return FileResponse(target)
    data = target.read_bytes()[:200_000]
    if b"\x00" in data[:4096]:
        return {"binary": True, "size": target.stat().st_size}
    return {"binary": False, "size": target.stat().st_size, "content": data.decode("utf-8", errors="replace"),
            "truncated": target.stat().st_size > 200_000}
