from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Experiment, Sample, User
from ..schemas import (ExperimentDetail, ExperimentIn, ExperimentOut, ExperimentValidateIn, PairDetectIn, SampleIn,
                       SampleOut, SamplesheetImportIn, SamplesReplace)
from ..security import audit, require_scientist, require_viewer
from ..services import fs, samplesheet
from .pipelines import get_pipeline, get_version

router = APIRouter(prefix="/api/experiments", tags=["experiments"])
samples_router = APIRouter(prefix="/api/samples", tags=["experiments"])


def get_exp(db: Session, eid: str) -> Experiment:
    e = db.get(Experiment, eid)
    if not e:
        raise HTTPException(404, "Experiment not found")
    return e


def _out(e: Experiment) -> ExperimentOut:
    o = ExperimentOut.model_validate(e)
    o.sample_count = len(e.samples)
    return o


@router.get("", response_model=list[ExperimentOut])
def list_experiments(_: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return [_out(e) for e in db.query(Experiment).order_by(Experiment.updated_at.desc()).all()]


@router.post("", response_model=ExperimentDetail)
def create_experiment(body: ExperimentIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    e = Experiment(**body.model_dump(), created_by=user.username)
    db.add(e)
    audit(db, user.username, "experiment.create", body.name)
    db.commit()
    return e


@router.get("/{eid}", response_model=ExperimentDetail)
def experiment_detail(eid: str, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return get_exp(db, eid)


@router.put("/{eid}", response_model=ExperimentDetail)
def update_experiment(eid: str, body: ExperimentIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    e = get_exp(db, eid)
    for k, v in body.model_dump(exclude_unset=True).items():  # fields a client does not send stay as they are
        setattr(e, k, v)
    db.commit()
    return e


@router.delete("/{eid}")
def delete_experiment(eid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    e = get_exp(db, eid)
    from ..models import Run

    if db.query(Run).filter(Run.experiment_id == e.id).count():
        raise HTTPException(409, "Experiment is referenced by runs; it cannot be deleted (provenance)")
    audit(db, user.username, "experiment.delete", e.name)
    db.delete(e)
    db.commit()
    return {"ok": True}


@router.post("/{eid}/duplicate", response_model=ExperimentDetail)
def duplicate_experiment(eid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    e = get_exp(db, eid)
    n = Experiment(name=f"{e.name} (copy)", description=e.description, assay=e.assay, custom_columns=list(e.custom_columns),
                   conditions=list(e.conditions), contrasts=list(e.contrasts), created_by=user.username)
    db.add(n)
    db.flush()
    for s in e.samples:
        db.add(Sample(experiment_id=n.id, position=s.position, sample_id=s.sample_id, condition=s.condition,
                      replicate=s.replicate, technical_replicate=s.technical_replicate, batch=s.batch,
                      is_control=s.is_control, control_id=s.control_id, files=dict(s.files), attributes=dict(s.attributes)))
    db.commit()
    db.refresh(n)
    return n


@router.put("/{eid}/samples", response_model=ExperimentDetail)
def replace_samples(eid: str, body: SamplesReplace, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Bulk save from the spreadsheet editor (the table is the source of truth)."""
    e = get_exp(db, eid)
    existing = {s.id: s for s in e.samples}
    keep: set[str] = set()
    for i, s in enumerate(body.samples):
        data = s.model_dump(exclude={"id"})
        _check_files(data["files"])
        if s.id and s.id in existing:
            obj = existing[s.id]
            for k, v in data.items():
                setattr(obj, k, v)
            obj.position = i
            keep.add(obj.id)
        else:
            obj = Sample(experiment_id=e.id, position=i, **data)
            db.add(obj)
    for sid, obj in existing.items():
        if sid not in keep:
            db.delete(obj)
    db.commit()
    db.refresh(e)
    return e


def _check_files(files: dict) -> None:
    """Only virtual paths inside data roots may be assigned (no arbitrary host paths)."""
    def check(v, key=""):
        if key == "lane":
            return
        if isinstance(v, str) and v:
            fs.resolve(v, must_exist=False)
        elif isinstance(v, list):
            for x in v:
                check(x)
        elif isinstance(v, dict):
            for k, x in v.items():
                check(x, k)

    check(files)


@router.post("/{eid}/samples", response_model=SampleOut)
def add_sample(eid: str, body: SampleIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    e = get_exp(db, eid)
    _check_files(body.files)
    s = Sample(experiment_id=e.id, position=len(e.samples), **body.model_dump(exclude={"id"}))
    db.add(s)
    db.commit()
    return s


@samples_router.patch("/{sid}", response_model=SampleOut)
def patch_sample(sid: str, body: SampleIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    s = db.get(Sample, sid)
    if not s:
        raise HTTPException(404)
    _check_files(body.files)
    for k, v in body.model_dump(exclude={"id"}).items():
        setattr(s, k, v)
    db.commit()
    return s


@samples_router.delete("/{sid}")
def delete_sample(sid: str, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    s = db.get(Sample, sid)
    if not s:
        raise HTTPException(404)
    db.delete(s)
    db.commit()
    return {"ok": True}


@router.post("/detect-pairs")
def detect_pairs(body: PairDetectIn, _: User = Depends(require_viewer)):
    paths = list(body.paths)
    if body.directory:
        if body.recursive:
            paths += [f["path"] for f in fs.walk_files(body.directory, fs.FASTQ_RE)]
        else:
            paths += [e["path"] for e in fs.list_dir(body.directory)["entries"] if e["kind"] == "fastq"]
    for p in paths:
        fs.split_virtual(p)
    return samplesheet.detect_pairs(paths)


@router.post("/{eid}/import-samplesheet", response_model=ExperimentDetail)
def import_samplesheet(eid: str, body: SamplesheetImportIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    """Import a CSV/TSV samplesheet or metadata table. Known columns map to sample fields,
    file columns to files, everything else becomes custom metadata."""
    e = get_exp(db, eid)
    cols, rows = samplesheet.parse_table(body.content)
    if not rows:
        raise HTTPException(400, "No rows found")
    lower = {c.lower(): c for c in cols}
    id_col = next((lower[c] for c in ("sample", "sample_id", "sampleid", "id", "name", "sample name") if c in lower), None)
    if not id_col:
        raise HTTPException(400, f"No sample id column found (looked for sample/sample_id/id); columns: {cols}")
    field_cols = {"condition": ("condition", "group", "treatment"), "replicate": ("replicate", "rep", "biological_replicate"),
                  "batch": ("batch",), "control_id": ("control", "control_id", "input"),
                  "technical_replicate": ("technical_replicate", "tech_rep")}
    file_re = re.compile(r"^(fastq_?[12]|fq[12]|r[12]|read[12]|raw|spectra_filepath|bam|file)$", re.I)
    by_id = {s.sample_id: s for s in e.samples}
    if body.mode == "replace":
        for s in list(e.samples):
            db.delete(s)
        by_id = {}
        db.flush()
    new_custom = list(e.custom_columns)
    pos = len(e.samples)
    for row in rows:
        sid = row.get(id_col, "").strip()
        if not sid:
            continue
        s = by_id.get(sid) if body.mode == "merge" else None
        if s is None:
            s = Sample(experiment_id=e.id, position=pos, sample_id=sid, files={}, attributes={})
            pos += 1
            db.add(s)
            by_id[sid] = s
        files = dict(s.files or {})
        attrs = dict(s.attributes or {})
        for c, v in row.items():
            if c == id_col or v == "":
                continue
            lc = c.lower()
            field = next((f for f, names in field_cols.items() if lc in names), None)
            if field:
                if field in ("replicate", "technical_replicate"):
                    try:
                        setattr(s, field, int(v))
                    except ValueError:
                        attrs[c] = v
                else:
                    setattr(s, field, v)
            elif file_re.match(c):
                key = {"fq1": "fastq_1", "r1": "fastq_1", "read1": "fastq_1", "fq2": "fastq_2", "r2": "fastq_2",
                       "read2": "fastq_2", "spectra_filepath": "raw"}.get(lc, lc.replace("fastq1", "fastq_1").replace("fastq2", "fastq_2"))
                files[key] = samplesheet.guess_virtual(v)
            else:
                attrs[c] = v
                if c not in new_custom:
                    new_custom.append(c)
        if s.control_id is None and str(attrs.get("is_control", "")).lower() in ("1", "true", "yes"):
            s.is_control = True
        s.files, s.attributes = files, attrs
    e.custom_columns = new_custom
    audit(db, user.username, "experiment.import_samplesheet", e.name, rows=len(rows), mode=body.mode)
    db.commit()
    db.refresh(e)
    return e


def _pipeline_schema(db: Session, body: ExperimentValidateIn, user: User):
    if not body.pipeline_id:
        return None
    p = get_pipeline(db, body.pipeline_id, user)
    return get_version(p, body.version_id).input_schema_json


@router.post("/{eid}/validate")
def validate_experiment(eid: str, body: ExperimentValidateIn, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    e = get_exp(db, eid)
    return samplesheet.validate_experiment(e, _pipeline_schema(db, body, user), body.column_map)


@router.post("/{eid}/samplesheet")
def generate_samplesheet(eid: str, body: ExperimentValidateIn, user: User = Depends(require_viewer), db: Session = Depends(get_db)):
    e = get_exp(db, eid)
    if e.assay == "proteomics" and not body.pipeline_id:
        cols, rows = samplesheet.proteomics_design(e)
        return {"columns": cols, "rows": rows, "csv": samplesheet.to_csv(rows, cols, "\t"), "format": "openms-design-tsv"}
    schema = _pipeline_schema(db, body, user)
    cols = samplesheet.columns_for(schema, e)
    rows = samplesheet.build_rows(e, cols, body.column_map)
    return {"columns": cols, "rows": rows, "csv": samplesheet.to_csv(rows, cols), "format": "csv"}


@router.get("/{eid}/export", response_class=PlainTextResponse)
def export_metadata(eid: str, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    e = get_exp(db, eid)
    cols = ["sample_id", "condition", "replicate", "technical_replicate", "batch", "is_control", "control_id",
            "fastq_1", "fastq_2", "raw", *e.custom_columns]
    rows = []
    for s in e.samples:
        r = {"sample_id": s.sample_id, "condition": s.condition, "replicate": s.replicate,
             "technical_replicate": s.technical_replicate, "batch": s.batch, "is_control": s.is_control,
             "control_id": s.control_id, **{k: v for k, v in (s.files or {}).items() if isinstance(v, str)},
             **(s.attributes or {})}
        rows.append({k: ("" if v is None else v) for k, v in r.items()})
    return samplesheet.to_csv(rows, cols, "\t")
