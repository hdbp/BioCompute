"""Your own editable copies of pipelines. Originals are never changed.

- fork(): a Studio pipeline becomes a new Studio workflow of yours (publishing it creates a new pipeline);
  any other pipeline's files are copied into a new pipeline of yours.
- Code edits are only allowed on such copies, and each save is a new version in its own folder: no existing
  version folder is ever written to.
"""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import HTTPException

from ..config import get_settings
from ..models import Pipeline, PipelineVersion

COPY_PREFIX = "copy:"  # Pipeline.source_url of a copy made here ("copy:<original slug>@<version>")
SKIP_DIRS = {".git", "work", ".nextflow", "node_modules", "results", "__pycache__", ".nf-test"}
MAX_FILES = 5000
MAX_EDIT_BYTES = 1_000_000
IGNORE = shutil.ignore_patterns("work", ".nextflow*", "results", ".nf-test")


def is_copy(p: Pipeline) -> bool:
    return (p.source_url or "").startswith((COPY_PREFIX, "duplicate:"))


def copies_root() -> Path:
    d = get_settings().pipelines_path / "copies"
    d.mkdir(parents=True, exist_ok=True)
    return d


def new_copy_dir(slug: str) -> Path:
    return copies_root() / f"{slug}-{uuid.uuid4().hex[:8]}" / "v1"


def _text(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            head = fh.read(4096)
    except OSError:
        return False
    if b"\0" in head:
        return False
    try:
        head.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def list_files(v: PipelineVersion) -> list[dict]:
    root = Path(v.path)
    out: list[dict] = []
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if any(part in SKIP_DIRS for part in rel.parts) or not p.is_file():
            continue
        if p.is_symlink() and not _inside(p.resolve(), root):
            continue
        size = p.stat().st_size
        out.append({"path": str(rel), "size": size, "text": size <= MAX_EDIT_BYTES and _text(p)})
        if len(out) >= MAX_FILES:
            break
    return out


def _inside(p: Path, root: Path) -> bool:
    try:
        p.relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _safe_rel(rel: str) -> Path:
    r = Path(rel)
    if not rel or r.is_absolute() or ".." in r.parts or any(part in SKIP_DIRS for part in r.parts) or rel.startswith("~"):
        raise HTTPException(400, f"Not a file inside the pipeline: {rel}")
    return r


def read_file(v: PipelineVersion, rel: str) -> str:
    root = Path(v.path).resolve()
    p = (root / _safe_rel(rel)).resolve()
    if not _inside(p, root) or not p.is_file():
        raise HTTPException(404, f"No file {rel} in this version")
    if p.stat().st_size > MAX_EDIT_BYTES or not _text(p):
        raise HTTPException(415, f"{rel} is not a text file BioCompute can show")
    return p.read_text(encoding="utf-8")


def new_version_dir(p: Pipeline) -> tuple[Path, str]:
    nums = [int(x.version[1:]) for x in p.versions if x.version[:1] == "v" and x.version[1:].isdigit()]
    n = max(nums, default=len(p.versions)) + 1
    dest = copies_root() / f"{p.slug}-{p.id}" / f"v{n}"
    while dest.exists():
        n += 1
        dest = dest.parent / f"v{n}"
    return dest, f"v{n}"


def write_version(base: PipelineVersion, dest: Path, changes: dict[str, str | None]) -> list[str]:
    """Copy `base` to the new folder `dest` and apply the changes there (None deletes a file)."""
    if dest.exists():
        raise HTTPException(409, "That version folder already exists")
    shutil.copytree(base.path, dest, symlinks=True, ignore=IGNORE)
    root = dest.resolve()
    applied = []
    for rel, content in changes.items():
        target = root / _safe_rel(rel)
        # resolve() follows any existing links in the path: the file must stay inside this version's folder
        if not _inside(target.parent.resolve(), root):
            raise HTTPException(400, f"Not a file inside the pipeline: {rel}")
        if target.is_symlink():
            target.unlink()  # replace a link by a real file; never write through it
        if content is None:
            if target.is_file():
                target.unlink()
                applied.append(rel)
            continue
        if len(content.encode()) > MAX_EDIT_BYTES:
            raise HTTPException(413, f"{rel} is larger than 1 MB")
        target.parent.mkdir(parents=True, exist_ok=True)
        mode = target.stat().st_mode if target.exists() else None
        target.write_text(content, encoding="utf-8")
        if mode is not None:
            target.chmod(mode)
        elif rel.startswith("bin/"):
            target.chmod(0o755)
        applied.append(rel)
    return applied
