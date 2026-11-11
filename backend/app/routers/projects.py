"""Projects: keep the data of one study together (folders, files, runs) and give it a tidy folder on disk."""
from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Project, Run, User
from ..security import audit, require_scientist, require_viewer
from ..services import access, fs

router = APIRouter(prefix="/api/projects", tags=["projects"])
SUBFOLDERS = ("data", "results", "analyses")


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    visibility: str = "private"
    home_root: str | None = None  # create <root>:projects/<slug>/{data,results,analyses}
    home: str | None = None       # or use an existing folder


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    visibility: str | None = None


class ItemIn(BaseModel):
    ref: str  # data-root path, or a run id when kind == "run"
    kind: str | None = None
    label: str | None = None


def _get(db: Session, pid: str, user: User, edit: bool = False) -> Project:
    p = db.get(Project, pid)
    if not p:
        raise HTTPException(404, "Project not found")
    access.check_view(user, p.owner, p.visibility, "Project")
    if edit:
        access.check_edit(user, p.owner, f"The project “{p.name}”")
    return p


def _resolve_item(db: Session, it: dict[str, Any]) -> dict[str, Any]:
    out = dict(it)
    if it["kind"] == "run":
        r = db.get(Run, it["ref"])
        out["exists"] = r is not None
        if r:
            out.update(run_name=r.name, status=r.status, output=fs.to_virtual(Path(r.output_dir).resolve()) if r.output_dir else None)
        return out
    try:
        _, p = fs.resolve(it["ref"])
        out["exists"] = True
        out["kind"] = "folder" if p.is_dir() else "file"
    except HTTPException:
        out["exists"] = False
    return out


def _out(db: Session, p: Project, user: User, detail: bool = False) -> dict[str, Any]:
    d = {"id": p.id, "name": p.name, "description": p.description, "owner": p.owner, "visibility": p.visibility,
         "home": p.home, "item_count": len(p.items or []), "can_edit": access.can_edit(user, p.owner),
         "created_at": p.created_at, "updated_at": p.updated_at}
    if detail:
        d["items"] = [_resolve_item(db, it) for it in (p.items or [])]
        d["folders"] = {k: f"{p.home.rstrip('/')}/{k}" if p.home else None for k in SUBFOLDERS}
    return d


def add_item(db: Session, p: Project, user: User, ref: str, kind: str | None = None, label: str | None = None) -> dict[str, Any]:
    if kind == "run" or (kind is None and db.get(Run, ref)):
        r = db.get(Run, ref)
        if not r:
            raise HTTPException(404, "Run not found")
        kind, label = "run", label or r.name
    else:
        _, path = fs.resolve(ref)  # only data folders; traversal refused
        kind = "folder" if path.is_dir() else "file"
        ref = fs.to_virtual(path) or ref
        label = label or path.name or ref
    if any(it["ref"] == ref for it in (p.items or [])):
        raise HTTPException(409, "Already in this project")
    it = {"id": secrets.token_hex(4), "kind": kind, "ref": ref, "label": label[:200], "added_by": user.username,
          "added_at": datetime.now(timezone.utc).isoformat()}
    p.items = [*(p.items or []), it]
    return it


@router.get("")
def list_projects(user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    q = db.query(Project)
    f = access.visible_filter(user, Project.owner, Project.visibility)
    if f is not None:
        q = q.filter(f)
    return [_out(db, p, user) for p in q.order_by(Project.updated_at.desc()).all()]


@router.post("")
def create_project(body: ProjectIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = Project(name=body.name.strip(), description=body.description, owner=user.username,
                visibility=access.check_visibility_value(body.visibility), items=[])
    if body.home_root:
        slug = re.sub(r"[^a-z0-9]+", "-", body.name.lower()).strip("-")[:60] or "project"
        base, i = f"{body.home_root}:projects/{slug}", 2
        home = base
        while True:
            _, path = fs.resolve(home, must_exist=False, for_write=True)
            if not path.exists():
                break
            home, i = f"{base}-{i}", i + 1
        for sub in SUBFOLDERS:
            (path / sub).mkdir(parents=True, exist_ok=True)
        p.home = fs.to_virtual(path) or home
    elif body.home:
        _, path = fs.resolve(body.home)
        if not path.is_dir():
            raise HTTPException(400, "The project folder must be a folder")
        p.home = fs.to_virtual(path)
    db.add(p)
    db.flush()
    audit(db, user.username, "project.create", p.name, home=p.home, visibility=p.visibility)
    db.commit()
    return _out(db, p, user, detail=True)


@router.get("/{pid}")
def get_project(pid: str, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return _out(db, _get(db, pid, user), user, detail=True)


@router.patch("/{pid}")
def edit_project(pid: str, body: ProjectPatch, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = _get(db, pid, user, edit=True)
    if body.name is not None:
        p.name = body.name.strip()
    if body.description is not None:
        p.description = body.description
    if body.visibility is not None:
        p.visibility = access.check_visibility_value(body.visibility)
        audit(db, user.username, "project.visibility", p.name, visibility=p.visibility)
    db.commit()
    return _out(db, p, user, detail=True)


@router.delete("/{pid}")
def delete_project(pid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = _get(db, pid, user, edit=True)
    audit(db, user.username, "project.delete", p.name)
    db.delete(p)
    db.commit()
    return {"ok": True, "note": "The project's files and folders were not touched."}


@router.post("/{pid}/items")
def add(pid: str, body: ItemIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = _get(db, pid, user, edit=True)
    it = add_item(db, p, user, body.ref, body.kind, body.label)
    db.commit()
    return it


@router.delete("/{pid}/items/{item_id}")
def remove(pid: str, item_id: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = _get(db, pid, user, edit=True)
    items = [it for it in (p.items or []) if it["id"] != item_id]
    if len(items) == len(p.items or []):
        raise HTTPException(404, "Item not found")
    p.items = items
    db.commit()
    return {"ok": True}
