from __future__ import annotations

import json
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import ParameterPreset, Pipeline, PipelineVersion, Run, User
from ..schemas import (DuplicateIn, ImportGit, ImportLocal, ParamValidateIn, PipelineDetail, PipelineSummary,
                       PipelineUpdate, PipelineVersionOut, PresetIn, PresetOut, SchemaAuthorIn)
from ..security import audit, require_scientist, require_viewer
from ..services import fs, nfschema
from ..services import pipelines as svc

router = APIRouter(prefix="/api/pipelines", tags=["pipelines"])
versions_router = APIRouter(prefix="/api/pipeline-versions", tags=["pipelines"])
schemas_router = APIRouter(prefix="/api/pipeline-schemas", tags=["pipelines"])


def _latest(p: Pipeline) -> PipelineVersion | None:
    pinned = [v for v in p.versions if v.pinned]
    return pinned[-1] if pinned else (p.versions[-1] if p.versions else None)


def _summary(db: Session, p: Pipeline, cls=PipelineSummary, **extra):
    v = _latest(p)
    run_count = db.query(func.count(Run.id)).filter(Run.pipeline_id == p.id).scalar() or 0
    last = db.query(Run.status).filter(Run.pipeline_id == p.id).order_by(Run.created_at.desc()).first()
    data = {c: getattr(p, c) for c in PipelineSummary.model_fields if hasattr(p, c)}
    return cls(**data, latest_version=PipelineVersionOut.model_validate(v) if v else None,
               has_schema=bool(v and v.schema_json), run_count=run_count,
               last_run_status=last[0] if last else None, preset_count=len(p.presets), **extra)


def get_pipeline(db: Session, pid: str) -> Pipeline:
    p = db.get(Pipeline, pid) or db.query(Pipeline).filter(Pipeline.slug == pid).one_or_none()
    if not p:
        raise HTTPException(404, "Pipeline not found")
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
                   favorites: bool = False, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    query = db.query(Pipeline)
    if kind:
        query = query.filter(Pipeline.kind == kind)
    if category:
        query = query.filter(Pipeline.category == category)
    if favorites:
        query = query.filter(Pipeline.favorite.is_(True))
    items = query.order_by(Pipeline.kind, Pipeline.name).all()
    if q:
        ql = q.lower()
        items = [p for p in items if ql in p.name.lower() or ql in p.description.lower() or ql in p.category.lower()
                 or any(ql in t.lower() for t in p.tags or [])]
    return [_summary(db, p) for p in items]


@router.get("/{pid}", response_model=PipelineDetail)
def pipeline_detail(pid: str, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid)
    v = _latest(p)
    return _summary(db, p, PipelineDetail,
                    versions=[PipelineVersionOut.model_validate(x) for x in p.versions],
                    readme=(v.manifest or {}).get("readme") if v else None,
                    manifest={k: val for k, val in ((v.manifest or {}) if v else {}).items() if k != "readme"},
                    input_columns=nfschema.input_columns(v.input_schema_json) if v else [],
                    runnable=svc.runnable_engines(v) if v else [])


@router.patch("/{pid}", response_model=PipelineSummary)
def update_pipeline(pid: str, body: PipelineUpdate, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    db.commit()
    return _summary(db, p)


@router.delete("/{pid}")
def delete_pipeline(pid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid)
    if db.query(Run).filter(Run.pipeline_id == p.id).count():
        raise HTTPException(409, "Pipeline has execution history; it cannot be deleted (provenance)")
    managed = get_settings().pipelines_path
    for v in p.versions:
        if v.path and Path(v.path).resolve().is_relative_to(managed):
            shutil.rmtree(v.path, ignore_errors=True)
    audit(db, user.username, "pipeline.delete", p.slug)
    db.delete(p)
    db.commit()
    return {"ok": True}


@router.post("/import/local", response_model=PipelineSummary)
def import_local(body: ImportLocal, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    _, path = fs.resolve(body.path)
    if body.copy_files:
        dest = get_settings().pipelines_path / svc.slugify(body.name or path.name)
        if dest.exists():
            raise HTTPException(409, f"{dest.name} already exists in the pipeline store")
        shutil.copytree(path, dest, symlinks=True)
        path = dest
    p = svc.register_from_dir(db, path, source_type="local", source_url=body.path, name=body.name, category=body.category)
    audit(db, user.username, "pipeline.import_local", p.slug, path=str(path))
    db.commit()
    return _summary(db, p)


@router.post("/import/git", response_model=PipelineSummary)
def import_git(body: ImportGit, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = svc.import_git(db, body.url, body.ref, body.name, body.category)
    # if this matched a catalog template, mark the template as installed by linking
    tmpl = db.query(Pipeline).filter(Pipeline.kind == "template", Pipeline.source_url == body.url.removesuffix(".git")).first()
    if tmpl:
        p.category = body.category or tmpl.category
        p.description = p.description or tmpl.description
        p.tags = sorted(set((p.tags or []) + (tmpl.tags or [])))
    audit(db, user.username, "pipeline.import_git", p.slug, url=body.url, ref=body.ref)
    db.commit()
    return _summary(db, p)


@router.post("/{pid}/versions/update", response_model=PipelineSummary)
def fetch_new_version(pid: str, body: ImportGit, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Check out another ref of a git pipeline as a new version (version pinning)."""
    p = get_pipeline(db, pid)
    if p.source_type not in ("git", "nf-core"):
        raise HTTPException(400, "Only git-based pipelines can fetch versions")
    tmp = svc.import_git(db, p.source_url or body.url, body.ref, f"{p.slug}-{body.ref or 'latest'}", p.category)
    v = tmp.versions[-1]
    v.pipeline_id = p.id
    db.flush()
    db.delete(tmp)
    audit(db, user.username, "pipeline.version_add", p.slug, ref=body.ref)
    db.commit()
    db.refresh(p)
    return _summary(db, p)


@router.post("/{pid}/duplicate", response_model=PipelineSummary)
def duplicate(pid: str, body: DuplicateIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid)
    v = get_version(p, None)
    dest = get_settings().pipelines_path / svc.slugify(body.name)
    if dest.exists():
        raise HTTPException(409, "A pipeline with this name already exists in the store")
    shutil.copytree(v.path, dest, symlinks=True, ignore=shutil.ignore_patterns("work", ".nextflow*"))
    newp = svc.register_from_dir(db, dest, source_type="local", source_url=f"duplicate:{p.slug}", name=body.name,
                                 category=p.category)
    for pr in p.presets:
        db.add(ParameterPreset(pipeline_id=newp.id, name=pr.name, description=pr.description, params=pr.params,
                               created_by=user.username))
    audit(db, user.username, "pipeline.duplicate", p.slug, new=newp.slug)
    db.commit()
    return _summary(db, newp)


# --------------------------------------------------------------------------- versions
@versions_router.post("/{version_id}/pin")
def pin_version(version_id: str, pinned: bool = True, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    v = db.get(PipelineVersion, version_id)
    if not v:
        raise HTTPException(404)
    for other in v.pipeline.versions:
        other.pinned = False
    v.pinned = pinned
    audit(db, user.username, "pipeline.pin", v.pipeline.slug, version=v.version, pinned=pinned)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- schema / params
@schemas_router.get("/{pid}")
def form_schema(pid: str, version_id: str | None = None, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid)
    v = get_version(p, version_id)
    form = nfschema.normalize(v.schema_json)
    return {"pipeline_id": p.id, "version_id": v.id, "form": form, "defaults": nfschema.defaults(v.schema_json),
            "input_columns": nfschema.input_columns(v.input_schema_json), "raw": v.schema_json,
            "profiles": (v.manifest or {}).get("profiles", [])}


@schemas_router.post("/{pid}/validate")
def validate_params(pid: str, body: ParamValidateIn, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid)
    v = get_version(p, body.version_id)
    issues = nfschema.validate_params(v.schema_json, body.params)
    return {"valid": not any(i["level"] == "error" for i in issues), "issues": issues}


@schemas_router.post("/{pid}/author")
def author_schema(pid: str, body: SchemaAuthorIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Schema-authoring wizard for pipelines without nextflow_schema.json."""
    p = get_pipeline(db, pid)
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
        (Path(v.path) / "nextflow_schema.json").write_text(json.dumps(schema, indent=2))
    audit(db, user.username, "pipeline.schema_authored", p.slug)
    db.commit()
    return {"ok": True, "schema": schema}


@schemas_router.post("/{pid}/export", response_class=PlainTextResponse)
def export_params(pid: str, body: ParamValidateIn, fmt: str = "json", _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    get_pipeline(db, pid)
    clean = {k: v for k, v in body.params.items() if v not in ("", None)}
    if fmt == "yaml":
        lines = []
        for k, v in clean.items():
            lines.append(f"{k}: {json.dumps(v)}")
        return "\n".join(lines) + "\n"
    return json.dumps(clean, indent=2) + "\n"


# --------------------------------------------------------------------------- presets
@router.get("/{pid}/presets", response_model=list[PresetOut])
def list_presets(pid: str, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return get_pipeline(db, pid).presets


@router.post("/{pid}/presets", response_model=PresetOut)
def save_preset(pid: str, body: PresetIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid)
    pr = next((x for x in p.presets if x.name == body.name), None)
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
    if not pr or pr.pipeline_id != get_pipeline(db, pid).id:
        raise HTTPException(404)
    db.delete(pr)
    db.commit()
    return {"ok": True}


@router.get("/{pid}/history")
def pipeline_history(pid: str, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    p = get_pipeline(db, pid)
    runs = db.query(Run).filter(Run.pipeline_id == p.id).order_by(Run.created_at.desc()).limit(100).all()
    return [{"id": r.id, "name": r.name, "status": r.status, "created_at": r.created_at, "finished_at": r.finished_at,
             "engine": r.engine, "params": r.params, "version_id": r.pipeline_version_id} for r in runs]
