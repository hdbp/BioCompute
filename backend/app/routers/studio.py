from __future__ import annotations

import io
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Pipeline, StudioWorkflow, User
from ..schemas import StudioCompileIn, StudioIn, StudioOut
from ..security import audit, require_scientist, require_viewer
from ..services import pipelines as psvc
from ..services import studio
from ..services.studio_modules import MODULES, PORT_TYPES

router = APIRouter(prefix="/api/studio", tags=["studio"])


@router.get("/modules")
def modules(_: User = Depends(require_viewer)):
    return {"modules": MODULES, "port_types": PORT_TYPES, "custom_code_allowed": get_settings().allow_custom_code_modules}


@router.get("/workflows", response_model=list[StudioOut])
def list_workflows(_: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return db.query(StudioWorkflow).order_by(StudioWorkflow.updated_at.desc()).all()


@router.post("/workflows", response_model=StudioOut)
def create_workflow(body: StudioIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    w = StudioWorkflow(**body.model_dump(), created_by=user.username)
    db.add(w)
    db.commit()
    return w


@router.get("/workflows/{wid}", response_model=StudioOut)
def get_workflow(wid: str, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    w = db.get(StudioWorkflow, wid)
    if not w:
        raise HTTPException(404)
    return w


@router.put("/workflows/{wid}", response_model=StudioOut)
def save_workflow(wid: str, body: StudioIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    w = db.get(StudioWorkflow, wid)
    if not w:
        raise HTTPException(404)
    w.name, w.description, w.graph = body.name, body.description, body.graph
    db.commit()
    return w


@router.delete("/workflows/{wid}")
def delete_workflow(wid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    w = db.get(StudioWorkflow, wid)
    if not w:
        raise HTTPException(404)
    db.delete(w)
    db.commit()
    return {"ok": True}


@router.post("/validate")
def validate(body: StudioCompileIn, _: User = Depends(require_viewer)):
    return studio.validate(body.graph)


@router.post("/compile")
def compile_graph(body: StudioCompileIn, _: User = Depends(require_viewer)):
    return studio.compile_graph(body.graph, body.name, body.description)


@router.post("/export")
def export_zip(body: StudioCompileIn, _: User = Depends(require_viewer)):
    res = studio.compile_graph(body.graph, body.name, body.description)
    if not res["valid"]:
        raise HTTPException(422, {"message": "Graph is invalid", "issues": res["issues"]})
    buf = io.BytesIO()
    slug = psvc.slugify(body.name)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in res["files"].items():
            info = zipfile.ZipInfo(f"{slug}/{name}")
            info.external_attr = (0o755 if name.startswith("bin/") else 0o644) << 16
            z.writestr(info, content)
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{slug}.zip"'})


@router.post("/workflows/{wid}/publish")
def publish(wid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Generate the pipeline into the managed store and register it (new version on re-publish)."""
    w = db.get(StudioWorkflow, wid)
    if not w:
        raise HTTPException(404)
    res = studio.compile_graph(w.graph, w.name, w.description)
    if not res["valid"]:
        raise HTTPException(422, {"message": "Graph is invalid", "issues": res["issues"]})
    existing = db.query(Pipeline).filter(Pipeline.studio_workflow_id == w.id).first()
    n = len(existing.versions) + 1 if existing else 1
    dest = get_settings().pipelines_path / f"studio-{psvc.slugify(w.name)}-{w.id}" / f"v{n}"
    if dest.exists():
        shutil.rmtree(dest)
    for name, content in res["files"].items():
        p = dest / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        if name.startswith("bin/"):
            p.chmod(0o755)
    p = psvc.register_from_dir(db, dest, source_type="studio", name=w.name, category="Studio", version=f"v{n}",
                               pipeline=existing, studio_workflow_id=w.id)
    p.description = w.description or p.description
    audit(db, user.username, "studio.publish", w.name, version=n)
    db.commit()
    return {"pipeline_id": p.id, "version": f"v{n}", "path": str(dest)}
