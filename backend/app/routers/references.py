"""Reference genomes (refgenie), read-only: what exists, refgenie:// references, suggestions for pipeline inputs."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..security import audit, require_admin, require_viewer
from ..services import fs, refgenie

router = APIRouter(prefix="/api/references", tags=["references"])


class ConfigIn(BaseModel):
    config: str | None = None  # path to genome_config.yaml (or its folder); empty = find it automatically


class SuggestIn(BaseModel):
    genome: str
    fields: list[dict[str, Any]]  # [{name, widget}] from the pipeline's parameter form


@router.get("/status")
def status(_: User = Depends(require_viewer)):
    return refgenie.status()


@router.put("/config")
def set_config(body: ConfigIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    refgenie.set_config(db, body.config)
    audit(db, admin.username, "references.config", None, config=body.config)
    db.commit()
    refgenie.reload()
    return refgenie.status()


@router.get("/genomes")
def genomes(_: User = Depends(require_viewer)):
    return refgenie.catalog()


@router.get("/resolve")
def resolve(uri: str, _: User = Depends(require_viewer)):
    return refgenie.resolve(uri)


@router.post("/suggest")
def suggest(body: SuggestIn, _: User = Depends(require_viewer)):
    """refgenie:// values for the reference parameters of a pipeline, for one genome."""
    return refgenie.suggestions(body.fields, body.genome)


@router.get("/browser-genome")
def browser_genome(genome: str, _: User = Depends(require_viewer)):
    """Data-folder paths of a genome's FASTA (+ .fai) and annotation, for the Data Explorer's genome browser."""
    def vpath(uri: str) -> str | None:
        try:
            p = refgenie.resolve(uri)["path"]
        except HTTPException:
            return None
        return fs.to_virtual(fs.Path(p).resolve())

    fasta, fai = vpath(f"refgenie://{genome}/fasta"), vpath(f"refgenie://{genome}/fasta.fai")
    if not fasta or not fai:
        raise HTTPException(404, f"{genome} has no fasta asset (with .fai) inside a data folder")
    gtf = next((v for v in (vpath(f"refgenie://{genome}/gencode_gtf"), vpath(f"refgenie://{genome}/ensembl_gtf")) if v), None)
    return {"name": genome, "fasta": fasta, "fai": fai, "annotation": gtf}
