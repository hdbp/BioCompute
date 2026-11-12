from __future__ import annotations

import json
import shutil
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import ParameterPreset, Pipeline, PipelineVersion, Run, StudioWorkflow, User
from ..schemas import (DuplicateIn, ImportGit, ImportLocal, ParamValidateIn, PipelineDetail, PipelineSummary,
                       PipelineUpdate, PipelineVersionOut, PresetIn, PresetOut, SchemaAuthorIn)
from ..security import audit, require_scientist, require_viewer
from ..services import access, fs, nf_map, nfschema
from ..services import pipeline_edit as pedit
from ..services import step_settings
from ..services import custom_modules as cm
from ..services import nf_edit
from ..services import pipelines as svc

STUDIO_SNAPSHOT = "studio_graph.json"  # written next to each published Studio version

router = APIRouter(prefix="/api/pipelines", tags=["pipelines"])
versions_router = APIRouter(prefix="/api/pipeline-versions", tags=["pipelines"])
schemas_router = APIRouter(prefix="/api/pipeline-schemas", tags=["pipelines"])


def _latest(p: Pipeline) -> PipelineVersion | None:
    pinned = [v for v in p.versions if v.pinned]
    return pinned[-1] if pinned else (p.versions[-1] if p.versions else None)


def _summary(db: Session, p: Pipeline, user: User, cls=PipelineSummary, **extra):
    v = _latest(p)
    run_count = db.query(func.count(Run.id)).filter(Run.pipeline_id == p.id).scalar() or 0
    last = db.query(Run.status).filter(Run.pipeline_id == p.id).order_by(Run.created_at.desc()).first()
    data = {c: getattr(p, c) for c in PipelineSummary.model_fields if hasattr(p, c)}
    data["favorite"] = p.id in ((user.prefs or {}).get("favorite_pipelines") or [])  # favorites are per user
    data["can_edit"] = access.can_edit(user, p.owner)
    return cls(**data, latest_version=PipelineVersionOut.model_validate(v) if v else None,
               has_schema=bool(v and v.schema_json), run_count=run_count,
               last_run_status=last[0] if last else None, preset_count=len(p.presets), **extra)


def get_pipeline(db: Session, pid: str, user: User | None = None, edit: bool = False) -> Pipeline:
    """Look up a pipeline. With `user`, someone else's private pipeline is "not found"; `edit` needs owner or admin."""
    p = db.get(Pipeline, pid) or db.query(Pipeline).filter(Pipeline.slug == pid).one_or_none()
    if not p:
        raise HTTPException(404, "Pipeline not found")
    if user is not None:
        access.check_view(user, p.owner, p.visibility, "Pipeline")
        if edit:
            access.check_edit(user, p.owner, f"“{p.name}”")
    return p


def get_version(p: Pipeline, version_id: str | None) -> PipelineVersion:
    if version_id:
        v = next((x for x in p.versions if x.id == version_id), None)
        if not v:
            raise HTTPException(404, "Version not found")
        return v
    v = _latest(p)
    if not v:
        raise HTTPException(400, "Pipeline has no installed version (template?)")
    return v


@router.get("", response_model=list[PipelineSummary])
def list_pipelines(q: str | None = None, kind: str | None = None, category: str | None = None,
                   favorites: bool = False, owner: str | None = None, archived: bool = False,
                   user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    """Installed pipelines and catalog entries; with archived=true only the uninstalled ones that runs still refer to."""
    query = db.query(Pipeline).filter(Pipeline.archived.is_(archived))
    f = access.visible_filter(user, Pipeline.owner, Pipeline.visibility)
    if f is not None:
        query = query.filter(f)
    if owner == "me":
        query = query.filter(Pipeline.owner == user.username)
    elif owner:
        query = query.filter(Pipeline.owner == owner)
    if kind:
        query = query.filter(Pipeline.kind == kind)
    if category:
        query = query.filter(Pipeline.category == category)
    if favorites:
        query = query.filter(Pipeline.id.in_((user.prefs or {}).get("favorite_pipelines") or []))
    items = query.order_by(Pipeline.kind, Pipeline.name).all()
    if q:
        ql = q.lower()
        items = [p for p in items if ql in p.name.lower() or ql in p.description.lower() or ql in p.category.lower()
                 or any(ql in t.lower() for t in p.tags or [])]
    return [_summary(db, p, user) for p in items]


@router.get("/{pid}", response_model=PipelineDetail)
def pipeline_detail(pid: str, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid, user)
    v = _latest(p)
    return _summary(db, p, user, PipelineDetail,
                    versions=[PipelineVersionOut.model_validate(x) for x in p.versions],
                    readme=(v.manifest or {}).get("readme") if v else None,
                    manifest={k: val for k, val in ((v.manifest or {}) if v else {}).items() if k != "readme"},
                    input_columns=nfschema.input_columns(v.input_schema_json) if v else [],
                    runnable=svc.runnable_engines(v) if v else [])


@router.patch("/{pid}", response_model=PipelineSummary)
def update_pipeline(pid: str, body: PipelineUpdate, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    changes = body.model_dump(exclude_unset=True)
    fav = changes.pop("favorite", None)
    p = get_pipeline(db, pid, user, edit=bool(changes))
    if fav is not None:  # anyone who can see a pipeline can star it for themselves
        prefs = dict(user.prefs or {})
        favs = [x for x in prefs.get("favorite_pipelines", []) if x != p.id]
        prefs["favorite_pipelines"] = favs + ([p.id] if fav else [])
        user.prefs = prefs
    for k in ("name", "category"):
        if k in changes:
            changes[k] = (changes[k] or "").strip()
            if not changes[k]:
                raise HTTPException(422, f"The {k} cannot be empty")
    if "visibility" in changes:
        access.check_visibility_value(changes["visibility"])
        if p.owner is None:
            raise HTTPException(400, "Catalog and bundled pipelines are always shared with the lab")
        audit(db, user.username, "pipeline.visibility", p.slug, visibility=changes["visibility"])
    for k, v in changes.items():
        setattr(p, k, v)
    db.commit()
    return _summary(db, p, user)


@router.delete("/{pid}")
def delete_pipeline(pid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Uninstall a pipeline. Without runs it is deleted with its files. With runs it is archived: hidden from the
    lists and from launching, while the versions those runs used stay (their records, Resume and provenance need
    them); the other versions and their files are deleted. Files outside BioCompute's pipeline store (a folder you
    imported from) are never touched. A catalog entry cannot be uninstalled (it is not installed)."""
    p = get_pipeline(db, pid, user, edit=True)
    if p.kind == "template":
        raise HTTPException(409, "This is a catalog entry, not an installed pipeline")
    managed = get_settings().pipelines_path
    used = {vid for (vid,) in db.query(Run.pipeline_version_id).filter(Run.pipeline_id == p.id).distinct()}
    freed = 0
    removed = 0
    for v in list(p.versions):
        if v.id in used:
            continue
        if v.path and Path(v.path).resolve().is_relative_to(managed) and Path(v.path).resolve() != managed:
            freed += _tree_size(Path(v.path))
            shutil.rmtree(v.path, ignore_errors=True)
        removed += 1
        if used:
            db.delete(v)
    favs = [f for f in ((user.prefs or {}).get("favorite_pipelines") or []) if f != p.id]
    user.prefs = {**(user.prefs or {}), "favorite_pipelines": favs}
    if not used:
        audit(db, user.username, "pipeline.delete", p.slug, freed=freed)
        db.delete(p)
        db.commit()
        return {"ok": True, "result": "deleted", "freed": freed, "kept_versions": 0, "removed_versions": removed}
    p.archived = True
    audit(db, user.username, "pipeline.uninstall", p.slug, kept_versions=len(used), removed_versions=removed, freed=freed)
    db.commit()
    return {"ok": True, "result": "archived", "freed": freed, "kept_versions": len(used), "removed_versions": removed}


@router.post("/{pid}/restore", response_model=PipelineSummary)
def restore_pipeline(pid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Install an uninstalled pipeline again (with the versions that were kept for its runs)."""
    p = get_pipeline(db, pid, user, edit=True)
    p.archived = False
    audit(db, user.username, "pipeline.restore", p.slug)
    db.commit()
    return _summary(db, p, user)


def _tree_size(p: Path) -> int:
    total = 0
    for f in p.rglob("*"):
        try:
            if f.is_file() and not f.is_symlink():
                total += f.stat().st_size
        except OSError:
            continue
    return total


@router.post("/import/local", response_model=PipelineSummary)
def import_local(body: ImportLocal, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    _, path = fs.resolve(body.path)
    if body.copy_files:
        dest = get_settings().pipelines_path / svc.slugify(body.name or path.name)
        if dest.exists():
            raise HTTPException(409, f"{dest.name} already exists in the pipeline store")
        shutil.copytree(path, dest, symlinks=True)
        path = dest
    access.check_visibility_value(body.visibility)
    p = svc.register_from_dir(db, path, source_type="local", source_url=body.path, name=body.name, category=body.category)
    p.owner, p.visibility = user.username, body.visibility
    audit(db, user.username, "pipeline.import_local", p.slug, path=str(path), visibility=body.visibility)
    db.commit()
    return _summary(db, p, user)


@router.post("/import/git", response_model=PipelineSummary)
def import_git(body: ImportGit, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    access.check_visibility_value(body.visibility)
    p = svc.import_git(db, body.url, body.ref, body.name, body.category)
    p.owner, p.visibility = user.username, body.visibility
    # if this matched a catalog template, mark the template as installed by linking
    tmpl = db.query(Pipeline).filter(Pipeline.kind == "template", Pipeline.source_url == body.url.removesuffix(".git")).first()
    if tmpl and body.visibility == "private":  # a private install must not take the catalog entry away from others
        p.category = body.category or tmpl.category
        p.description = p.description or tmpl.description
        tmpl = None
    if tmpl:  # the catalog entry is now genuinely installed for the lab: replace the template
        p.category = body.category or tmpl.category
        p.description = p.description or tmpl.description
        p.tags = sorted(set((p.tags or []) + (tmpl.tags or [])))
        slug = tmpl.slug
        db.delete(tmpl)
        db.flush()
        p.slug = slug
    audit(db, user.username, "pipeline.import_git", p.slug, url=body.url, ref=body.ref, visibility=body.visibility)
    db.commit()
    return _summary(db, p, user)


@router.post("/{pid}/versions/update", response_model=PipelineSummary)
def fetch_new_version(pid: str, body: ImportGit, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Check out another ref of a git pipeline as a new version (version pinning)."""
    p = get_pipeline(db, pid, user, edit=True)
    if p.source_type not in ("git", "nf-core"):
        raise HTTPException(400, "Only git-based pipelines can fetch versions")
    tmp = svc.import_git(db, p.source_url or body.url, body.ref, f"{p.slug}-{body.ref or 'latest'}", p.category)
    svc.adopt_version(db, tmp, p)
    audit(db, user.username, "pipeline.version_add", p.slug, ref=body.ref)
    db.commit()
    db.refresh(p)
    return _summary(db, p, user)


@router.post("/{pid}/duplicate", response_model=PipelineSummary)
def duplicate(pid: str, body: DuplicateIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Your own copy of a pipeline you can see (files copied into the pipeline store)."""
    access.check_visibility_value(body.visibility)
    p = get_pipeline(db, pid, user)
    v = get_version(p, None)
    dest = get_settings().pipelines_path / svc.slugify(body.name)
    if dest.exists():
        raise HTTPException(409, "A pipeline with this name already exists in the store")
    shutil.copytree(v.path, dest, symlinks=True, ignore=shutil.ignore_patterns("work", ".nextflow*"))
    graph = _studio_graph(db, p, v)
    if graph is not None:
        # a Studio pipeline: copy its workflow too, so the copy can be changed in Studio and published as new versions
        w = StudioWorkflow(name=body.name, description=p.description, graph=graph, created_by=user.username,
                           visibility=body.visibility)
        db.add(w)
        db.flush()
        (dest / STUDIO_SNAPSHOT).write_text(json.dumps({"workflow_id": w.id, "graph": graph}))
        newp = svc.register_from_dir(db, dest, source_type="studio", source_url=f"duplicate:{p.slug}", name=body.name,
                                     category=p.category, version="v1", studio_workflow_id=w.id)
    else:
        newp = svc.register_from_dir(db, dest, source_type="local", source_url=f"duplicate:{p.slug}", name=body.name,
                                     category=p.category)
    newp.owner, newp.visibility = user.username, body.visibility
    newp.description = p.description
    for pr in p.presets:
        db.add(ParameterPreset(pipeline_id=newp.id, name=pr.name, description=pr.description, params=pr.params,
                               created_by=user.username))
    audit(db, user.username, "pipeline.duplicate", p.slug, new=newp.slug)
    db.commit()
    return _summary(db, newp, user)


# --------------------------------------------------------------------------- your own editable copy
class ForkIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    version_id: str | None = None
    visibility: str = "private"


@router.post("/{pid}/fork")
def fork(pid: str, body: ForkIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Start a new pipeline of your own from one version of this one. The original is not changed.

    Studio pipelines: a new Studio workflow with that version's graph (publish it to create the new pipeline).
    Other pipelines: that version's files copied into a new pipeline whose code you can edit.
    """
    access.check_visibility_value(body.visibility)
    p = get_pipeline(db, pid, user)
    if p.kind == "template":
        raise HTTPException(400, "Install the pipeline before copying it")
    v = get_version(p, body.version_id)
    if p.source_type == "studio":
        graph = _studio_graph(db, p, v)
        if graph is None:
            raise HTTPException(409, f"{v.version} has no Studio graph to start from")
        w = StudioWorkflow(name=body.name.strip(), description=p.description, graph=graph, created_by=user.username,
                           visibility=body.visibility)
        db.add(w)
        audit(db, user.username, "pipeline.fork", p.slug, version=v.version, workflow=body.name)
        db.commit()
        return {"kind": "studio", "workflow_id": w.id, "from": f"{p.name} {v.version}"}
    dest = pedit.new_copy_dir(svc.slugify(body.name))
    dest.parent.mkdir(parents=True, exist_ok=True)
    pedit.copy_version(v.path, dest)  # unchanged files are shared with the original (hard links), not duplicated
    newp = svc.register_from_dir(db, dest, source_type="local", source_url=f"{pedit.COPY_PREFIX}{p.slug}@{v.version}",
                                 name=body.name.strip(), category=p.category, version="v1")
    newp.owner, newp.visibility, newp.description = user.username, body.visibility, p.description
    for pr in p.presets:
        db.add(ParameterPreset(pipeline_id=newp.id, name=pr.name, description=pr.description, params=pr.params,
                               created_by=user.username))
    audit(db, user.username, "pipeline.fork", p.slug, version=v.version, new=newp.slug)
    db.commit()
    return {"kind": "nextflow", "pipeline_id": newp.id, "from": f"{p.name} {v.version}"}


@router.get("/{pid}/files")
def pipeline_files(pid: str, version_id: str | None = None, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid, user)
    v = get_version(p, version_id)
    editable = access.can_edit(user, p.owner) and pedit.is_copy(p) and p.source_type != "studio"
    return {"version_id": v.id, "version": v.version, "editable": editable, "files": pedit.list_files(v)}


@router.get("/{pid}/files/content", response_class=PlainTextResponse)
def pipeline_file(pid: str, path: str, version_id: str | None = None, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid, user)
    return pedit.read_file(get_version(p, version_id), path)


class SaveFilesIn(BaseModel):
    base_version_id: str
    changes: dict[str, str | None]  # path -> new content; None deletes the file
    note: str = Field(default="", max_length=500)


@router.post("/{pid}/files")
def save_files(pid: str, body: SaveFilesIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Save code changes as a NEW version of your own copy. Existing versions are never written to."""
    p = get_pipeline(db, pid, user, edit=True)
    if not pedit.is_copy(p) or p.source_type == "studio":
        raise HTTPException(403, "Originals are never changed: use “Edit as new pipeline” to make your own copy first")
    if not body.changes:
        raise HTTPException(400, "No changes to save")
    base = get_version(p, body.base_version_id)
    dest, label = pedit.new_version_dir(p)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        applied = pedit.write_version(base, dest, body.changes)
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    svc.register_from_dir(db, dest, source_type=p.source_type, name=p.name, version=label, pipeline=p)
    audit(db, user.username, "pipeline.edit", p.slug, version=label, base=base.version, files=applied, note=body.note)
    db.commit()
    db.refresh(p)
    newv = next(x for x in p.versions if x.version == label)
    return {"version_id": newv.id, "version": label, "files": applied}


# --------------------------------------------------------------------------- step settings (interactive edits)
def _step_info(v: PipelineVersion) -> dict[str, dict]:
    """Processes of the shown workflow (also inside its subworkflows) with what each supports."""
    m = nf_map.build_map(v.path)
    info: dict[str, dict] = {}
    for n in m.get("nodes", []) if m.get("ok") else []:
        if n["kind"] == "process":
            info.setdefault(n["id"], {"supports_when": n.get("supports_when"), "supports_args": n.get("supports_args")})
        for st in n.get("step_info") or []:
            if st["kind"] == "process":
                info.setdefault(st["id"], {"supports_when": st.get("supports_when"), "supports_args": st.get("supports_args")})
    return info


def _step_names(v: PipelineVersion) -> list[str]:
    return list(_step_info(v))


@router.get("/{pid}/steps")
def step_settings_get(pid: str, version_id: str | None = None, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    """Step settings changed on the map for this version, and what the pipeline itself sets for each step."""
    p = get_pipeline(db, pid, user)
    v = get_version(p, version_id)
    root = Path(v.path)
    return {"version_id": v.id, "version": v.version,
            "editable": access.can_edit(user, p.owner) and pedit.is_copy(p) and p.source_type != "studio",
            "overrides": step_settings.load(root), "current": step_settings.current(root, _step_names(v))}


class StepSettingsIn(BaseModel):
    base_version_id: str
    overrides: dict[str, dict]


@router.post("/{pid}/steps")
def step_settings_save(pid: str, body: StepSettingsIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Save step settings as a NEW version of your own copy (a config file; the code is not modified)."""
    p = get_pipeline(db, pid, user, edit=True)
    if not pedit.is_copy(p) or p.source_type == "studio":
        raise HTTPException(403, "Originals are never changed: use “Edit as new pipeline” to make your own copy first")
    base = get_version(p, body.base_version_id)
    steps = step_settings.validate(body.overrides)
    known = _step_info(base)
    unknown = sorted(set(steps) - set(known))
    if unknown:
        raise HTTPException(400, f"Not a step of this pipeline: {', '.join(unknown)}")
    for name, o in steps.items():
        if o.get("enabled") is False and not known[name].get("supports_when"):
            raise HTTPException(400, f"{name} has no on/off switch (no `when:` using task.ext.when); turn it off in the code")
        if "args" in o and not known[name].get("supports_args"):
            raise HTTPException(400, f"{name} does not read task.ext.args; change its command in the code")
    dest, label = pedit.new_version_dir(p)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        pedit.write_version(base, dest, step_settings.changes_for(Path(base.path), steps))
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    svc.register_from_dir(db, dest, source_type=p.source_type, name=p.name, version=label, pipeline=p)
    audit(db, user.username, "pipeline.steps", p.slug, version=label, base=base.version, steps=steps)
    db.commit()
    db.refresh(p)
    newv = next(x for x in p.versions if x.version == label)
    return {"version_id": newv.id, "version": label, "steps": steps}


# --------------------------------------------------------------------------- add / remove steps (code edits)
class StructureIn(BaseModel):
    base_version_id: str
    op: str = Field(pattern="^(add|remove)$")
    step: str | None = None            # remove: the step; add: the new step's name (optional)
    connect: bool = False              # remove: steps reading its output read its input instead
    module_id: str | None = None       # add: library module
    after: str | None = None           # add: the step it follows
    output: str | None = None          # add: which output of `after` it reads
    extra_params: dict[str, str] = {}  # add: other file inputs -> new pipeline parameter names
    dry_run: bool = True


@router.post("/{pid}/structure")
def change_structure(pid: str, body: StructureIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Add or remove a step of your own Nextflow copy. dry_run returns the code change; otherwise a new version."""
    p = get_pipeline(db, pid, user, edit=True)
    if not pedit.is_copy(p) or p.source_type == "studio":
        raise HTTPException(403, "Originals are never changed: use “Edit as new pipeline” to make your own copy first")
    base = get_version(p, body.base_version_id)
    root = Path(base.path)
    if body.op == "remove":
        if not body.step:
            raise HTTPException(400, "Which step?")
        plan = nf_edit.plan_remove(root, body.step, connect=body.connect)
    else:
        if not (body.module_id and body.after and body.output):
            raise HTTPException(400, "Choose a module, the step it follows and that step's output")
        mod = cm.index(db, user).get(body.module_id)
        if not mod:
            raise HTTPException(404, f"No module {body.module_id}")
        plan = nf_edit.plan_add(root, mod, body.after, body.output, body.step, body.extra_params)
    if body.dry_run or not plan.get("ok"):
        return nf_edit.preview(plan)
    files = dict(plan["files"])
    if body.op == "remove":
        # step settings of the removed step (and of steps inside it) go too
        steps = step_settings.load(root)
        node = next((n for n in nf_map.build_map(root).get("nodes", []) if n["id"] == body.step), {})
        gone = {body.step, *[s["id"] for s in node.get("step_info") or []]}
        if any(k in steps for k in gone):
            for k, v in step_settings.changes_for(root, {k: v for k, v in steps.items() if k not in gone}).items():
                if k != "nextflow.config":
                    files[k] = v
    dest, label = pedit.new_version_dir(p)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        pedit.write_version(base, dest, files)
        after_map = nf_map.build_map(dest)
        ids = {n["id"] for n in after_map.get("nodes", [])}
        if not after_map.get("ok") or (body.op == "remove" and plan["step"] in ids) or (body.op == "add" and plan["step"] not in ids):
            raise HTTPException(409, "BioCompute could not confirm the change in the new code; nothing was saved. Use Edit code instead.")
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    svc.register_from_dir(db, dest, source_type=p.source_type, name=p.name, version=label, pipeline=p)
    audit(db, user.username, f"pipeline.step_{body.op}", p.slug, version=label, base=base.version, step=plan["step"],
          module=body.module_id, after=body.after, connect=body.connect)
    db.commit()
    db.refresh(p)
    newv = next(x for x in p.versions if x.version == label)
    return {**nf_edit.preview(plan), "version_id": newv.id, "version": label}


# --------------------------------------------------------------------------- map
def _naive(t):
    return t.replace(tzinfo=None) if t is not None and t.tzinfo else t


def _studio_graph(db: Session, p: Pipeline, v: PipelineVersion) -> dict | None:
    if p.source_type != "studio":
        return None
    snap = Path(v.path) / STUDIO_SNAPSHOT
    if snap.is_file():
        try:
            return json.loads(snap.read_text()).get("graph")
        except (OSError, ValueError):
            return None
    w = db.get(StudioWorkflow, p.studio_workflow_id) if p.studio_workflow_id else None
    return w.graph if w else None


@router.get("/{pid}/map")
def pipeline_map(pid: str, version_id: str | None = None, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    """The pipeline's structure for one version: its Pipeline Studio graph, or a map read from its Nextflow code."""
    p = get_pipeline(db, pid, user)
    if p.kind == "template" or not p.versions:
        return {"kind": "none", "reason": "Not installed on this controller"}
    v = get_version(p, version_id)
    base = {"version_id": v.id, "version": v.version,
            "copy_of": (p.source_url or "").split(":", 1)[1] if pedit.is_copy(p) else None,
            "can_edit_code": access.can_edit(user, p.owner) and pedit.is_copy(p) and p.source_type != "studio"}
    if p.source_type == "studio" and p.studio_workflow_id:
        w = db.get(StudioWorkflow, p.studio_workflow_id)
        nums = [int(x.version[1:]) for x in p.versions if x.version[:1] == "v" and x.version[1:].isdigit()]
        studio = {"workflow_id": p.studio_workflow_id, "workflow_exists": w is not None, "graph": None, "exact": False,
                  "can_view_workflow": bool(w) and access.can_view(user, w.created_by, w.visibility),
                  "can_edit": bool(w) and access.can_edit(user, w.created_by),
                  "next_version": f"v{max(nums, default=len(p.versions)) + 1}", "latest": v.id == p.versions[-1].id}
        snap = Path(v.path) / STUDIO_SNAPSHOT
        if snap.is_file():
            try:
                studio.update(graph=json.loads(snap.read_text()).get("graph"), exact=True)
            except (OSError, ValueError):
                pass
        elif w is not None and studio["latest"] and _naive(w.updated_at) <= _naive(v.created_at) + timedelta(seconds=5):
            studio.update(graph=w.graph, exact=True)  # published before snapshots were kept, workflow unchanged since
        out = {**base, "kind": "studio", "studio": studio}
        if studio["graph"] is None:
            out["nextflow"] = nf_map.build_map(v.path)  # older version: read it from its generated code
        return out
    m = nf_map.build_map(v.path)
    if not m.get("ok"):
        return {**base, "kind": "none", "reason": m.get("reason")}
    return {**base, "kind": "nextflow", "nextflow": m}


# --------------------------------------------------------------------------- versions
@router.delete("/{pid}/versions/{version_id}")
def delete_version(pid: str, version_id: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Delete a version that no run used. Its files are removed only when they are in BioCompute's pipeline store
    (an imported folder of yours is never deleted)."""
    p = get_pipeline(db, pid, user, edit=True)
    v = get_version(p, version_id)
    if len(p.versions) <= 1:
        raise HTTPException(409, "This is the only version: delete the pipeline instead")
    if v.pinned:
        raise HTTPException(409, "This is the default version: choose another default first")
    used = db.query(Run).filter(Run.pipeline_version_id == v.id).count()
    if used:
        raise HTTPException(409, f"{used} run{'s' if used != 1 else ''} used this version; it is kept so they stay reproducible")
    path = Path(v.path).resolve()
    removed = False
    if path.is_relative_to(get_settings().pipelines_path.resolve()) and path.exists():
        shutil.rmtree(path, ignore_errors=True)
        removed = True
    audit(db, user.username, "pipeline.version_delete", p.slug, version=v.version, files_removed=removed)
    p.versions.remove(v)
    db.commit()
    return {"ok": True, "files_removed": removed}



@versions_router.post("/{version_id}/pin")
def pin_version(version_id: str, pinned: bool = True, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    v = db.get(PipelineVersion, version_id)
    if not v:
        raise HTTPException(404)
    get_pipeline(db, v.pipeline_id, user, edit=True)
    for other in v.pipeline.versions:
        other.pinned = False
    v.pinned = pinned
    audit(db, user.username, "pipeline.pin", v.pipeline.slug, version=v.version, pinned=pinned)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- schema / params
@schemas_router.get("/{pid}")
def form_schema(pid: str, version_id: str | None = None, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid, user)
    v = get_version(p, version_id)
    form = nfschema.normalize(v.schema_json)
    return {"pipeline_id": p.id, "version_id": v.id, "form": form, "defaults": nfschema.defaults(v.schema_json),
            "input_columns": nfschema.input_columns(v.input_schema_json), "raw": v.schema_json,
            "profiles": (v.manifest or {}).get("profiles", [])}


@schemas_router.post("/{pid}/validate")
def validate_params(pid: str, body: ParamValidateIn, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid, user)
    v = get_version(p, body.version_id)
    issues = nfschema.validate_params(v.schema_json, body.params)
    return {"valid": not any(i["level"] == "error" for i in issues), "issues": issues}


@schemas_router.post("/{pid}/author")
def author_schema(pid: str, body: SchemaAuthorIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Schema-authoring wizard for pipelines without nextflow_schema.json."""
    p = get_pipeline(db, pid, user, edit=True)
    v = get_version(p, body.version_id)
    groups: dict[str, dict] = {}
    for f in body.fields:
        name = str(f.get("name", ""))
        if not name.replace("_", "").isalnum():
            raise HTTPException(400, f"Invalid parameter name '{name}'")
        g = groups.setdefault(f.get("group") or "parameters", {"title": (f.get("group") or "Parameters").replace("_", " ").title(),
                                                               "type": "object", "properties": {}, "required": []})
        prop = {"type": f.get("type", "string")}
        for k in ("description", "default", "enum", "minimum", "maximum", "format", "help_text"):
            if f.get(k) not in (None, ""):
                prop[k] = f[k]
        g["properties"][name] = prop
        if f.get("required"):
            g["required"].append(name)
    schema = {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": f"{p.name} parameters",
              "type": "object", "$defs": groups, "allOf": [{"$ref": f"#/$defs/{k}"} for k in groups]}
    v.schema_json = schema
    if body.write_to_pipeline and v.path:
        managed = get_settings().pipelines_path
        if not Path(v.path).resolve().is_relative_to(managed):
            raise HTTPException(403, "Only pipelines in the managed pipeline store can be written to")
        pedit.safe_write(Path(v.path) / "nextflow_schema.json", json.dumps(schema, indent=2))  # never into a linked file
    audit(db, user.username, "pipeline.schema_authored", p.slug)
    db.commit()
    return {"ok": True, "schema": schema}


@schemas_router.post("/{pid}/export", response_class=PlainTextResponse)
def export_params(pid: str, body: ParamValidateIn, fmt: str = "json", user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    get_pipeline(db, pid, user)
    clean = {k: v for k, v in body.params.items() if v not in ("", None)}
    if fmt == "yaml":
        lines = []
        for k, v in clean.items():
            lines.append(f"{k}: {json.dumps(v)}")
        return "\n".join(lines) + "\n"
    return json.dumps(clean, indent=2) + "\n"


# --------------------------------------------------------------------------- presets
@router.get("/{pid}/presets", response_model=list[PresetOut])
def list_presets(pid: str, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return get_pipeline(db, pid, user).presets


@router.post("/{pid}/presets", response_model=PresetOut)
def save_preset(pid: str, body: PresetIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid, user)  # anyone who can use a pipeline can save presets for it
    pr = next((x for x in p.presets if x.name == body.name), None)
    if pr and pr.created_by not in (None, user.username) and not access.can_edit(user, p.owner):
        raise HTTPException(403, f"The preset “{body.name}” belongs to {pr.created_by}; save yours under another name")
    if pr:
        pr.params, pr.description = body.params, body.description
    else:
        pr = ParameterPreset(pipeline_id=p.id, name=body.name, description=body.description, params=body.params,
                             created_by=user.username)
        db.add(pr)
    audit(db, user.username, "preset.save", p.slug, preset=body.name)
    db.commit()
    return pr


@router.delete("/{pid}/presets/{preset_id}")
def delete_preset(pid: str, preset_id: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    pr = db.get(ParameterPreset, preset_id)
    p = get_pipeline(db, pid, user)
    if not pr or pr.pipeline_id != p.id:
        raise HTTPException(404)
    if pr.created_by not in (None, user.username) and not access.can_edit(user, p.owner):
        raise HTTPException(403, f"This preset belongs to {pr.created_by}")
    db.delete(pr)
    db.commit()
    return {"ok": True}


@router.get("/{pid}/history")
def pipeline_history(pid: str, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid, user)
    runs = db.query(Run).filter(Run.pipeline_id == p.id).order_by(Run.created_at.desc()).limit(100).all()
    return [{"id": r.id, "name": r.name, "status": r.status, "created_at": r.created_at, "finished_at": r.finished_at,
             "engine": r.engine, "params": r.params, "version_id": r.pipeline_version_id} for r in runs]
