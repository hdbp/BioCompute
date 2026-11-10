"""Filesystem browsing (restricted to configured data roots) and dataset registry."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Dataset, User
from ..security import audit, require_scientist, require_viewer
from ..services import fs

router = APIRouter(prefix="/api/datasets", tags=["data"])


@router.get("/roots")
def list_roots(_: User = Depends(require_viewer)):
    return [r.public() for r in fs.roots().values()]


@router.get("/browse")
def browse(path: str, show_hidden: bool = False, _: User = Depends(require_viewer)):
    return fs.list_dir(path, show_hidden=show_hidden)


@router.get("/search")
def search(path: str, kind: str | None = None, pattern: str | None = None, _: User = Depends(require_viewer)):
    import re

    rx = None
    if pattern:
        try:
            rx = re.compile(pattern, re.I)
        except re.error as exc:
            raise HTTPException(400, f"Invalid pattern: {exc}") from exc
    files = fs.walk_files(path, rx, max_files=5000)
    if kind:
        files = [f for f in files if f["kind"] == kind]
    return {"files": files, "truncated": len(files) >= 5000}


@router.get("/preview")
def preview(path: str, _: User = Depends(require_viewer)):
    return fs.read_text_preview(path)


@router.get("/download")
def download(path: str, user: User = Depends(require_viewer)):
    root, p = fs.resolve(path)
    if not p.is_file():
        raise HTTPException(400, "Not a file")
    return FileResponse(p, filename=p.name)


class MkdirIn(BaseModel):
    path: str


@router.post("/mkdir")
def mkdir(body: MkdirIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    root, p = fs.resolve(body.path, must_exist=False, for_write=True)
    p.mkdir(parents=True, exist_ok=True)
    audit(db, user.username, "fs.mkdir", body.path)
    db.commit()
    return {"path": body.path}


class DatasetIn(BaseModel):
    name: str
    path: str
    description: str = ""
    restricted: bool | None = None


@router.get("")
def list_datasets(_: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return [{"id": d.id, "name": d.name, "path": f"{d.root}:{d.rel_path}", "restricted": d.restricted,
             "description": d.description, "size_bytes": d.size_bytes, "created_at": d.created_at}
            for d in db.query(Dataset).order_by(Dataset.name).all()]


@router.post("")
def register_dataset(body: DatasetIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    root, p = fs.resolve(body.path)
    size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() else p.stat().st_size
    rel = p.relative_to(root.path).as_posix()
    # datasets inside a restricted root are always restricted
    d = Dataset(name=body.name, root=root.name, rel_path="" if rel == "." else rel, description=body.description,
                restricted=root.restricted or bool(body.restricted), size_bytes=size)
    db.add(d)
    audit(db, user.username, "dataset.register", body.path, restricted=d.restricted)
    db.commit()
    return {"id": d.id}
