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
from ..models import CustomModule, Pipeline, StudioWorkflow, User
from ..schemas import StudioCompileIn, StudioIn, StudioOut
from ..security import audit, require_scientist, require_viewer
from ..services import pipelines as psvc
from ..services import custom_modules as cm
from ..services import studio
from ..services.studio_modules import MODULES, PORT_TYPES

router = APIRouter(prefix="/api/studio", tags=["studio"])


@router.get("/modules")
def modules(_: User = Depends(require_viewer), db: Session = Depends(get_db)):
    user = [v for v in cm.index(db).values() if v.get("user")]
    return {"modules": MODULES + sorted(user, key=lambda m: m["name"].lower()), "port_types": PORT_TYPES,
            "custom_code_allowed": get_settings().allow_custom_code_modules}


# --------------------------------------------------------------------------- user-defined modules
@router.get("/tools/scan")
def scan_tools(_: User = Depends(require_scientist)):
    """Known bioinformatics programs found on the controller's PATH."""
    return {"tools": cm.scan_tools(), "templates": sorted(cm.TEMPLATES)}


@router.get("/tools/check")
def check_tool(name: str, _: User = Depends(require_scientist)):
    return cm.check_tool(name)


@router.get("/module-templates/{key}")
def module_template(key: str, _: User = Depends(require_scientist)):
    return cm.template(key)


@router.get("/module-skeleton")
def module_skeleton(exe: str, _: User = Depends(require_scientist)):
    return cm.skeleton(exe)


@router.post("/modules/check")
def check_module(body: dict, existing_id: str | None = None, _: User = Depends(require_scientist), db: Session = Depends(get_db)):
    return cm.check_module(body, existing_id=existing_id, db=db)


def _require_code_allowed():
    if not get_settings().allow_custom_code_modules:
        raise HTTPException(403, "Custom modules are disabled by the administrator (BIOCOMPUTE_ALLOW_CUSTOM_CODE_MODULES=false)")


@router.post("/modules")
def create_module(body: dict, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    _require_code_allowed()
    res = cm.check_module(body, db=db)
    if not res["valid"]:
        raise HTTPException(422, {"message": "Module is invalid", "issues": res["issues"]})
    db.add(CustomModule(id=res["module"]["id"], definition=res["module"], created_by=user.username))
    audit(db, user.username, "studio.module_create", res["module"]["id"], tools=res["module"]["tools"])
    db.commit()
    return res


@router.put("/modules/{mid}")
def update_module(mid: str, body: dict, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    _require_code_allowed()
    m = db.get(CustomModule, mid)
    if not m:
        raise HTTPException(404, "Module not found")
    res = cm.check_module(body, existing_id=mid, db=db)
    if not res["valid"]:
        raise HTTPException(422, {"message": "Module is invalid", "issues": res["issues"]})
    if res["module"]["id"] != mid:
        raise HTTPException(400, "The module id cannot be changed (workflows refer to it); duplicate it instead")
    m.definition = res["module"]
    audit(db, user.username, "studio.module_update", mid)
    db.commit()
    return res


@router.delete("/modules/{mid}")
def delete_module(mid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    m = db.get(CustomModule, mid)
    if not m:
        raise HTTPException(404, "Module not found")
    used = [w.name for w in db.query(StudioWorkflow).all()
            if any(((n.get("data") or {}).get("module") == mid) for n in (w.graph or {}).get("nodes", []))]
    if used:
        raise HTTPException(409, f"Used by workflow(s): {', '.join(used[:5])}. Remove it from them first.")
    db.delete(m)
    audit(db, user.username, "studio.module_delete", mid)
    db.commit()
    return {"ok": True}


@router.get("/modules/{mid}/export")
def export_module(mid: str, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    m = db.get(CustomModule, mid)
    if not m:
        raise HTTPException(404, "Module not found")
    return {"biocompute_module": 1, **m.definition}


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
def validate(body: StudioCompileIn, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return studio.validate(body.graph, cm.index(db))


@router.post("/compile")
def compile_graph(body: StudioCompileIn, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return studio.compile_graph(body.graph, body.name, body.description, cm.index(db))


@router.post("/export")
def export_zip(body: StudioCompileIn, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    res = studio.compile_graph(body.graph, body.name, body.description, cm.index(db))
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
    res = studio.compile_graph(w.graph, w.name, w.description, cm.index(db))
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
