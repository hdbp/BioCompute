"""Disk use of BioCompute's own folders, and cleaning them up (administrators)."""
from __future__ import annotations

import shutil
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Pipeline, PipelineVersion, Run, User
from ..security import audit, require_admin
from ..services import fs, runner

router = APIRouter(prefix="/api/storage", tags=["system"])


def _free(p: Path) -> dict | None:
    try:
        u = shutil.disk_usage(p)
        return {"total": u.total, "free": u.free}
    except OSError:
        return None


@router.get("")
def storage(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    """What uses disk: run work folders (intermediate files), run logs, pipeline versions; free space per folder."""
    s = get_settings()
    runs = []
    work_total = logs_total = 0
    for r in db.query(Run).order_by(Run.created_at.desc()).all():
        w = runner._own_work_dir(r)
        wb = runner.dir_size(w) if w is not None and w.exists() else 0
        rd = Path(r.run_dir)
        lb = runner.dir_size(rd) - wb if rd.exists() else 0
        work_total += wb
        logs_total += max(lb, 0)
        runs.append({"id": r.id, "name": r.name, "status": r.status, "created_by": r.created_by, "finished_at": r.finished_at,
                     "work_bytes": wb, "log_bytes": max(lb, 0), "keep_work": bool((r.resources or {}).get("keep_work"))})
    store = s.pipelines_path.resolve()
    pipes = []
    store_total = 0
    for p in db.query(Pipeline).all():
        vs = []
        for v in p.versions:
            path = Path(v.path)
            inside = path.resolve().is_relative_to(store)
            size = runner.dir_size(path) if inside and path.exists() else 0
            store_total += size
            vs.append({"id": v.id, "version": v.version, "bytes": size, "in_store": inside, "pinned": v.pinned,
                       "runs": db.query(Run).filter(Run.pipeline_version_id == v.id).count()})
        if any(x["bytes"] for x in vs):
            pipes.append({"id": p.id, "name": p.name, "owner": p.owner, "versions": vs})
    pipes.sort(key=lambda x: -sum(v["bytes"] for v in x["versions"]))
    runs.sort(key=lambda x: -(x["work_bytes"] + x["log_bytes"]))
    folders = [{"name": "BioCompute state", "path": str(s.state_dir), "disk": _free(Path(s.state_dir))}]
    for r in fs.roots().values():
        folders.append({"name": r.name, "path": str(r.path), "disk": _free(r.path)})
    return {"work_bytes": work_total, "log_bytes": logs_total, "pipeline_bytes": store_total,
            "cleanup_intermediates": s.cleanup_intermediates, "runs": runs[:200], "pipelines": pipes[:100], "folders": folders}


class CleanIn(BaseModel):
    older_than_days: int = Field(default=14, ge=0, le=3650)
    statuses: list[str] = ["completed", "failed", "cancelled", "lost"]


@router.post("/clean-work")
def clean_work(body: CleanIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Delete the intermediate files of finished runs older than N days (their results and logs stay)."""
    cutoff = runner.now() - timedelta(days=body.older_than_days)
    freed, n = 0, 0
    for r in db.query(Run).filter(Run.status.in_([x for x in body.statuses if x in runner.TERMINAL])).all():
        fin = r.finished_at or r.created_at
        if fin is not None and fin.tzinfo is None:
            fin = fin.replace(tzinfo=cutoff.tzinfo)
        if fin is None or fin > cutoff:
            continue
        f = runner.remove_work_dir(r)
        if f:
            freed += f
            n += 1
            runner.add_event(db, r, "cleanup", f"Intermediate files removed by {admin.username} (storage clean-up): {f / 2**20:.1f} MB")
    audit(db, admin.username, "storage.clean_work", None, runs=n, freed=freed, older_than_days=body.older_than_days)
    db.commit()
    return {"runs": n, "freed": freed}
