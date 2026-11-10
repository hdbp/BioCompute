"""Pipeline import and inspection.

A pipeline is *installed* only if it exists as a local checkout with an entry point
(``main.nf`` for Nextflow, ``bcflow.json`` for the BioCompute native engine).
Catalog *templates* (e.g. nf-core pipelines not yet cloned) are recorded with
``kind='template'`` and are not executable until imported.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Pipeline, PipelineVersion
from . import tools

GIT_URL_RE = re.compile(r"^(https://|git@|ssh://)[\w.@:/~+-]+?(\.git)?/?$")
SLUG_RE = re.compile(r"[^a-z0-9]+")

# Curated catalog of nf-core pipelines relevant to the lab's workloads. These are
# *templates*: metadata only; nothing is claimed to be installed.
NFCORE_CATALOG: list[dict[str, Any]] = [
    {"slug": "nf-core-rnaseq", "name": "nf-core/rnaseq", "category": "Transcriptomics",
     "description": "RNA-seq analysis: QC, trimming, alignment (STAR/HISAT2) or pseudo-alignment (Salmon), quantification."},
    {"slug": "nf-core-chipseq", "name": "nf-core/chipseq", "category": "Epigenomics",
     "description": "ChIP-seq peak-calling, QC and differential analysis (Bowtie2/BWA, MACS2)."},
    {"slug": "nf-core-atacseq", "name": "nf-core/atacseq", "category": "Chromatin accessibility",
     "description": "ATAC-seq peak-calling and QC."},
    {"slug": "nf-core-cutandrun", "name": "nf-core/cutandrun", "category": "Chromatin",
     "description": "CUT&RUN / CUT&Tag analysis with SEACR and MACS2."},
    {"slug": "nf-core-methylseq", "name": "nf-core/methylseq", "category": "Epigenomics",
     "description": "Bisulfite-sequencing methylation analysis (Bismark / bwa-meth)."},
    {"slug": "nf-core-hic", "name": "nf-core/hic", "category": "Chromatin",
     "description": "Chromosome conformation capture (Hi-C) data processing."},
    {"slug": "nf-core-sarek", "name": "nf-core/sarek", "category": "Genomics",
     "description": "Germline and somatic variant calling from WGS/WES."},
    {"slug": "nf-core-scrnaseq", "name": "nf-core/scrnaseq", "category": "Single-cell",
     "description": "Single-cell RNA-seq processing (STARsolo, alevin-fry, kallisto|bustools, Cell Ranger)."},
    {"slug": "nf-core-differentialabundance", "name": "nf-core/differentialabundance", "category": "Statistics",
     "description": "Differential abundance analysis for feature/observation matrices (RNA-seq, proteomics)."},
    {"slug": "nf-core-quantms", "name": "nf-core/quantms", "category": "Proteomics",
     "description": "Quantitative mass-spectrometry proteomics (DDA-LFQ, DDA-ISO, DIA-LFQ)."},
    {"slug": "nf-core-mhcquant", "name": "nf-core/mhcquant", "category": "Proteomics",
     "description": "Identify and quantify MHC eluted peptides from mass-spectrometry raw data."},
    {"slug": "nf-core-fetchngs", "name": "nf-core/fetchngs", "category": "Data acquisition",
     "description": "Fetch metadata and raw FastQ files from public databases."},
]
for _c in NFCORE_CATALOG:
    _c["source_url"] = "https://github.com/" + _c["name"]


def slugify(s: str) -> str:
    return SLUG_RE.sub("-", s.lower()).strip("-")[:100] or "pipeline"


def _git(args: list[str], cwd: Path | None = None, timeout: int = 600) -> str:
    git = shutil.which("git")
    if not git:
        raise HTTPException(500, "git is not installed on the controller")
    proc = subprocess.run([git, *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise HTTPException(400, f"git {' '.join(args[:2])} failed: {proc.stderr.strip()[-500:]}")
    return proc.stdout.strip()


def parse_nextflow_config(text: str) -> dict[str, Any]:
    """Best-effort extraction of the ``manifest`` scope from nextflow.config.

    Nextflow config is Groovy; we deliberately do not evaluate it. Only simple
    ``key = 'value'`` assignments inside ``manifest { }`` are read.
    """
    out: dict[str, Any] = {}
    m = re.search(r"manifest\s*\{(.*?)\n\}", text, re.S)
    if m:
        for km in re.finditer(r"^\s*(\w+)\s*=\s*['\"](.*?)['\"]\s*$", m.group(1), re.M):
            out[km.group(1)] = km.group(2)
    profiles = re.findall(r"^\s{4}(\w+)\s*\{", text.split("profiles", 1)[1], re.M) if "profiles" in text else []
    out["profiles"] = sorted(set(profiles))
    return out


def inspect_dir(path: Path) -> dict[str, Any]:
    """Inspect a pipeline checkout and return metadata for a PipelineVersion."""
    if not path.is_dir():
        raise HTTPException(400, f"Not a directory: {path}")
    info: dict[str, Any] = {"engines": [], "manifest": {}, "schema": None, "input_schema": None,
                            "software": [], "outputs": [], "readme": None}
    if (path / "main.nf").is_file():
        info["engines"].append("nextflow")
    bc = path / "bcflow.json"
    if bc.is_file():
        info["engines"].append("bcflow")
        try:
            bcm = json.loads(bc.read_text())
            info["outputs"] = bcm.get("outputs", [])
        except json.JSONDecodeError as exc:
            raise HTTPException(400, f"Invalid bcflow.json: {exc}") from exc
    if not info["engines"]:
        raise HTTPException(400, "No main.nf or bcflow.json found - not a supported pipeline")
    cfg = path / "nextflow.config"
    if cfg.is_file():
        info["manifest"] = parse_nextflow_config(cfg.read_text(errors="replace"))
        txt = cfg.read_text(errors="replace")
        for kw in ("docker", "singularity", "apptainer", "conda", "podman", "wave"):
            if re.search(rf"\b{kw}\b", txt):
                info["software"].append(kw)
    sch = path / "nextflow_schema.json"
    if sch.is_file():
        try:
            info["schema"] = json.loads(sch.read_text())
        except json.JSONDecodeError as exc:
            raise HTTPException(400, f"Invalid nextflow_schema.json: {exc}") from exc
    # locate samplesheet schema: referenced from --input or the nf-core default
    input_ref = None
    if info["schema"]:
        from .nfschema import normalize

        for g in normalize(info["schema"])["groups"]:
            for f in g["fields"]:
                if f["name"] == "input" and f.get("schema"):
                    input_ref = f["schema"]
    for cand in [input_ref, "assets/schema_input.json"]:
        if cand and (path / cand).is_file():
            try:
                info["input_schema"] = json.loads((path / cand).read_text())
                break
            except json.JSONDecodeError:
                pass
    outdoc = path / "docs" / "output.md"
    if outdoc.is_file() and not info["outputs"]:
        heads = re.findall(r"^#{2,3}\s+(.+)$", outdoc.read_text(errors="replace"), re.M)
        info["outputs"] = [{"name": h.strip(), "description": ""} for h in heads[:30]]
    for rd in ("README.md", "readme.md"):
        if (path / rd).is_file():
            info["readme"] = (path / rd).read_text(errors="replace")[:20000]
            break
    return info


def git_info(path: Path) -> dict[str, str | None]:
    if not (path / ".git").exists() or not shutil.which("git"):
        return {"commit": None, "ref": None}
    try:
        commit = _git(["rev-parse", "HEAD"], cwd=path)
        ref = subprocess.run(["git", "describe", "--tags", "--always"], cwd=path, capture_output=True, text=True).stdout.strip()
        return {"commit": commit, "ref": ref or None}
    except HTTPException:
        return {"commit": None, "ref": None}


def register_from_dir(
    db: Session, path: Path, *, source_type: str, source_url: str | None = None,
    name: str | None = None, category: str | None = None, version: str | None = None,
    pipeline: Pipeline | None = None, studio_workflow_id: str | None = None,
) -> Pipeline:
    info = inspect_dir(path)
    gi = git_info(path)
    manifest = info["manifest"]
    disp_name = name or manifest.get("name") or path.name
    if pipeline is None:
        slug = slugify(disp_name)
        base, i = slug, 2
        while db.query(Pipeline).filter_by(slug=slug).first():
            slug = f"{base}-{i}"
            i += 1
        pipeline = Pipeline(
            slug=slug, name=disp_name,
            description=manifest.get("description") or (info["schema"] or {}).get("description") or "",
            category=category or "general", kind="studio" if source_type == "studio" else "installed",
            source_type=source_type, source_url=source_url,
            engine=info["engines"][0], studio_workflow_id=studio_workflow_id,
        )
        db.add(pipeline)
        db.flush()
    ver = PipelineVersion(
        pipeline_id=pipeline.id,
        version=version or manifest.get("version") or gi["ref"] or "local",
        git_commit=gi["commit"], git_ref=gi["ref"], path=str(path),
        schema_json=info["schema"], input_schema_json=info["input_schema"],
        manifest={**manifest, "readme": info["readme"]}, engines=info["engines"],
        outputs=info["outputs"], software=info["software"],
    )
    db.add(ver)
    pipeline.engine = info["engines"][0]
    db.flush()
    return pipeline


def import_git(db: Session, url: str, ref: str | None, name: str | None, category: str | None) -> Pipeline:
    if not GIT_URL_RE.match(url):
        raise HTTPException(400, "Unsupported git URL (use https:// or ssh)")
    if ref and not re.fullmatch(r"[\w./-]{1,120}", ref):
        raise HTTPException(400, "Invalid git ref")
    s = get_settings()
    slug = slugify(name or url.rstrip("/").removesuffix(".git").split("/", 3)[-1])
    dest = s.pipelines_path / slug
    i = 2
    while dest.exists():
        dest = s.pipelines_path / f"{slug}-{i}"
        i += 1
    # `--` prevents the URL being interpreted as an option (argument injection)
    _git(["clone", "--quiet", "--", url, str(dest)])
    if ref:
        _git(["-c", "advice.detachedHead=false", "checkout", "--quiet", ref], cwd=dest)
    try:
        return register_from_dir(db, dest, source_type="nf-core" if "nf-core/" in url else "git",
                                 source_url=url, name=name, category=category, version=ref)
    except HTTPException:
        shutil.rmtree(dest, ignore_errors=True)
        raise


def seed_catalog(db: Session) -> None:
    for c in NFCORE_CATALOG:
        if not db.query(Pipeline).filter_by(slug=c["slug"]).first():
            db.add(Pipeline(slug=c["slug"], name=c["name"], description=c["description"], category=c["category"],
                            kind="template", source_type="template", source_url=c["source_url"], engine="nextflow",
                            tags=["nf-core"]))


def runnable_engines(version: PipelineVersion) -> list[dict[str, Any]]:
    """Which engines can actually execute this version on the controller right now."""
    out = []
    for e in version.engines or []:
        if e == "nextflow":
            nf = tools.nextflow_status()
            out.append({"engine": e, "available": nf["available"], "detail": nf.get("detail")})
        elif e == "bcflow":
            out.append({"engine": e, "available": get_settings().enable_demo_engine,
                        "detail": "BioCompute native engine (local execution; development / fallback engine)"})
    return out
