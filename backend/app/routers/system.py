"""Dashboard aggregates, settings, health and the global event stream."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import AppSetting, Experiment, Node, NodeMetric, Pipeline, Run, RunEvent, User
from ..security import audit, get_current_user, require_admin, require_viewer
from ..services import cluster, events, fs, tools

router = APIRouter(prefix="/api", tags=["system"])

UI_SETTING_KEYS = {"cluster_preset", "default_output_dir", "default_profile", "onboarding_done"}


@router.get("/health")
def health(db: Session = Depends(get_db)):
    db.execute(__import__("sqlalchemy").text("SELECT 1"))
    return {"status": "ok", "service": "biocompute", "time": datetime.now(timezone.utc).isoformat()}


@router.get("/dashboard")
def dashboard(user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    cluster.refresh_states(db)
    db.commit()
    nodes = db.query(Node).all()
    enrolled = [n for n in nodes if n.state in ("enrolled", "active", "draining", "offline") or n.is_controller]
    online = [n for n in nodes if n.state in ("active", "draining") or n.is_controller]
    eligible = [n for n in online if cluster.eligibility(n)["eligible"]]
    cpu_total = sum(n.cpu_logical or 0 for n in online)
    cpu_alloc = sum(n.allocation.max_cpus for n in eligible if n.allocation)
    mem_total = sum(n.mem_total or 0 for n in online)
    mem_avail = sum(n.mem_available or 0 for n in online)
    mem_alloc = sum((n.allocation.max_memory_gb if n.allocation else 0) for n in eligible) * 2**30
    gpus = sum(len(n.gpus or []) for n in online)
    counts = dict(db.query(Run.status, func.count(Run.id)).group_by(Run.status).all())
    active_runs = db.query(Run).filter(Run.status.in_(("running", "cancelling", "queued", "preflight"))).order_by(Run.created_at.desc()).all()
    recent = db.query(Run).order_by(Run.created_at.desc()).limit(8).all()
    alerts = []
    if user.role == "admin":
        from ..services import accounts
        n = len(accounts.pending(db))
        if n:
            alerts.append({"level": "warning", "title": f"{n} account request{'s' if n > 1 else ''} waiting",
                           "message": "Approve or decline them in Settings, Users."})
    nf = tools.nextflow_status()
    if not nf["available"]:
        alerts.append({"level": "warning", "title": "Nextflow not available",
                       "message": f"{nf.get('detail')}. Nextflow pipelines cannot be launched; the BioCompute native engine is used for bcflow pipelines."})
    if not fs.roots():
        alerts.append({"level": "warning", "title": "No data roots configured",
                       "message": "Add the folders that hold your data in Settings, Controller, Data folders (or set BIOCOMPUTE_DATA_ROOTS)."})
    for r in db.query(Run).filter(Run.status.in_(("failed", "lost"))).order_by(Run.finished_at.desc()).limit(3).all():
        if r.finished_at and datetime.now(timezone.utc) - (r.finished_at if r.finished_at.tzinfo else r.finished_at.replace(tzinfo=timezone.utc)) < timedelta(days=2):
            alerts.append({"level": "error", "title": f"Run {r.name} {r.status}", "message": (r.error or "")[:300], "run_id": r.id})
    for n in nodes:
        if n.state == "offline":
            alerts.append({"level": "info", "title": f"{n.hostname} offline", "message": "No agent heartbeat in the last 3 minutes."})
        if n.state == "discovered" and len(alerts) < 12:
            pass
    pending = sum(1 for n in nodes if n.state == "discovered")
    if pending:
        alerts.append({"level": "info", "title": f"{pending} discovered device(s) awaiting review",
                       "message": "Discovered devices cannot run work until an administrator authorizes and enrolls them."})
    # utilization history (controller + workers), 5-minute buckets over 6 hours
    since = datetime.now(timezone.utc) - timedelta(hours=6)
    hist: dict[str, dict] = {}
    for m in db.query(NodeMetric).filter(NodeMetric.ts >= since).order_by(NodeMetric.ts).all():
        ts = m.ts if m.ts.tzinfo else m.ts.replace(tzinfo=timezone.utc)
        b = ts.replace(second=0, microsecond=0, minute=ts.minute - ts.minute % 5).isoformat()
        h = hist.setdefault(b, {"ts": b, "cpu": [], "mem": []})
        h["cpu"].append(m.cpu_percent)
        h["mem"].append(m.mem_percent)
    history = [{"ts": k, "cpu": round(sum(v["cpu"]) / len(v["cpu"]), 1), "mem": round(sum(v["mem"]) / len(v["mem"]), 1)}
               for k, v in sorted(hist.items())]
    return {
        "nodes": {"discovered": len(nodes), "eligible_candidates": sum(1 for n in nodes if n.state == "candidate"),
                  "enrolled": len(enrolled), "online": len(online), "eligible_now": len(eligible)},
        "resources": {"cpu_total": cpu_total, "cpu_allocatable": cpu_alloc, "mem_total": mem_total,
                      "mem_available": mem_avail, "mem_allocatable": mem_alloc, "gpus": gpus},
        "runs": {"active": sum(counts.get(s, 0) for s in ("running", "cancelling", "preflight")), "queued": counts.get("queued", 0),
                 "completed": counts.get("completed", 0), "failed": counts.get("failed", 0) + counts.get("lost", 0),
                 "cancelled": counts.get("cancelled", 0)},
        "active_runs": [{"id": r.id, "name": r.name, "status": r.status, "engine": r.engine, "progress": {k: (r.progress or {}).get(k) for k in ("total", "done", "failed")},
                         "processes": (r.progress or {}).get("processes", {}), "started_at": r.started_at} for r in active_runs],
        "recent_runs": [{"id": r.id, "name": r.name, "status": r.status, "created_at": r.created_at, "finished_at": r.finished_at} for r in recent],
        "topology": [{"id": n.id, "hostname": n.hostname, "state": n.state, "site": n.site, "is_controller": n.is_controller,
                      "os": n.os, "arch": n.arch, "cpus": n.cpu_logical, "utilization": n.utilization,
                      "eligible": cluster.eligibility(n)["eligible"], "sources": n.discovery_sources} for n in nodes],
        "history": history,
        "alerts": alerts,
        "counts": {"pipelines": db.query(Pipeline).filter(Pipeline.kind != "template").count(),
                   "templates": db.query(Pipeline).filter(Pipeline.kind == "template").count(),
                   "experiments": db.query(Experiment).count()},
        "engine": {"nextflow": nf, "bcflow": get_settings().enable_demo_engine},
    }


@router.get("/settings")
def get_app_settings(_: User = Depends(require_viewer), db: Session = Depends(get_db)):
    s = get_settings()
    stored = {r.key: r.value for r in db.query(AppSetting).all()}
    return {
        "site_name": s.site_name, "environment": s.environment,
        "data_roots": [r.public() | {"path": str(r.path)} for r in fs.roots().values()],
        "pipelines_dir": str(s.pipelines_path), "runs_dir": str(s.runs_path),
        "max_concurrent_runs": s.max_concurrent_runs, "allow_custom_code_modules": s.allow_custom_code_modules,
        "enable_demo_engine": s.enable_demo_engine,
        "database": s.database_url.split("://")[0],
        "software": tools.inventory(),
        "module_tools": tools.module_tools(),
        "discovery": {"authorized_cidrs": s.discovery_authorized_cidrs, "mdns": s.discovery_enable_mdns,
                      "tailscale": s.discovery_enable_tailscale, "htcondor": s.discovery_enable_htcondor,
                      "neighbors": s.discovery_enable_neighbors},
        "ui": {k: stored.get(k) for k in UI_SETTING_KEYS},
    }


@router.put("/settings/ui")
def put_ui_settings(body: dict, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    for k, v in body.items():
        if k not in UI_SETTING_KEYS:
            continue
        row = db.get(AppSetting, k) or AppSetting(key=k)
        row.value = v
        db.merge(row)
    audit(db, admin.username, "settings.update", None, keys=sorted(body))
    db.commit()
    return {"ok": True}


@router.post("/settings/refresh-tools")
def refresh_tools(_: User = Depends(require_admin)):
    tools.extend_tool_path()  # tools installed since the service started (scripts/tools.sh)
    tools.clear_cache()
    return tools.inventory()


@router.get("/events")
async def event_stream(request: Request, _: User = Depends(get_current_user)):
    sub = events.subscribe()

    async def gen():
        try:
            yield "retry: 5000\n\n"
            while not await request.is_disconnected():
                try:
                    msg = await asyncio.wait_for(sub[1].get(), timeout=15)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            events.unsubscribe(sub)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/activity")
def activity(limit: int = 50, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    rows = db.query(RunEvent).order_by(RunEvent.id.desc()).limit(min(limit, 500)).all()
    return [{"id": e.id, "run_id": e.run_id, "ts": e.ts, "kind": e.kind, "message": e.message} for e in rows]
