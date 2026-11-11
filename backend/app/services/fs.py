"""Permission-aware filesystem access.

Users may only browse within configured *data roots*. Every user-supplied path is
expressed as ``<root>:<relative/path>`` (a "virtual path") and resolved through
:func:`resolve`, which rejects absolute paths, ``..`` traversal and symlinks that
escape the root.
"""
from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from ..config import get_settings

FASTQ_RE = re.compile(r"\.(fastq|fq)(\.gz|\.bz2|\.zst)?$", re.I)
KIND_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("fastq", FASTQ_RE),
    ("bam", re.compile(r"\.(bam|cram|sam)$", re.I)),
    ("index", re.compile(r"\.(bai|crai|csi|tbi|fai)$", re.I)),
    ("vcf", re.compile(r"\.(vcf|bcf)(\.gz)?$", re.I)),
    ("bed", re.compile(r"\.(bed|narrowPeak|broadPeak|bedgraph|bdg|gtf|gff3?)(\.gz)?$", re.I)),
    ("bigwig", re.compile(r"\.(bw|bigwig)$", re.I)),
    ("fasta", re.compile(r"\.(fa|fasta|fna)(\.gz)?$", re.I)),
    ("ms-raw", re.compile(r"\.(raw|wiff|wiff2|d|mzml|mzxml|mgf)$", re.I)),
    ("table", re.compile(r"\.(csv|tsv|txt|xlsx)$", re.I)),
    ("report", re.compile(r"\.(html|pdf)$", re.I)),
    ("image", re.compile(r"\.(png|jpe?g|svg)$", re.I)),
    ("json", re.compile(r"\.(json|ya?ml)$", re.I)),
    ("r", re.compile(r"\.(rds|rdata|r)$", re.I)),
]


@dataclass(frozen=True)
class Root:
    name: str
    path: Path
    restricted: bool
    writable: bool
    description: str = ""
    source: str = "settings"  # "settings" (BIOCOMPUTE_DATA_ROOTS) or "ui" (added in Settings)

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "restricted": self.restricted,
            "writable": self.writable,
            "description": self.description,
            "exists": self.path.is_dir(),
            "source": self.source,
        }


_ui_roots: dict[str, Root] = {}


def set_ui_roots(items: list[Root]) -> None:
    """Folders added in Settings (stored in the database); BIOCOMPUTE_DATA_ROOTS wins on a name clash."""
    global _ui_roots
    _ui_roots = {r.name: r for r in items}


def roots() -> dict[str, Root]:
    out: dict[str, Root] = {}
    for r in get_settings().data_roots:
        name = str(r["name"])
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
            continue
        out[name] = Root(
            name=name,
            path=Path(os.path.expanduser(str(r["path"]))).resolve(),
            restricted=bool(r.get("restricted", False)),
            writable=bool(r.get("writable", False)),
            description=str(r.get("description", "")),
        )
    for name, r in _ui_roots.items():
        out.setdefault(name, r)
    return out


def split_virtual(vpath: str) -> tuple[str, str]:
    if ":" not in vpath:
        raise HTTPException(400, "Paths must be of the form '<root>:<relative path>'")
    root, rel = vpath.split(":", 1)
    return root, rel.lstrip("/")


def resolve(vpath: str, *, must_exist: bool = True, for_write: bool = False) -> tuple[Root, Path]:
    """Resolve a virtual path to an absolute path strictly inside its data root."""
    root_name, rel = split_virtual(vpath)
    rs = roots()
    if root_name not in rs:
        raise HTTPException(404, f"Unknown data root '{root_name}'")
    root = rs[root_name]
    if for_write and not root.writable:
        raise HTTPException(403, f"Data root '{root_name}' is read-only")
    if "\x00" in rel:
        raise HTTPException(400, "Invalid path")
    rel_parts = Path(rel).parts
    if any(p == ".." for p in rel_parts) or Path(rel).is_absolute():
        raise HTTPException(400, "Path traversal is not permitted")
    candidate = (root.path / rel).resolve() if must_exist else _resolve_parent(root.path / rel)
    try:
        candidate.relative_to(root.path)
    except ValueError:
        raise HTTPException(403, "Path escapes its data root") from None
    if must_exist and not candidate.exists():
        raise HTTPException(404, "Path not found")
    return root, candidate


def _resolve_parent(p: Path) -> Path:
    """Resolve symlinks of the deepest existing ancestor (target may not exist yet)."""
    existing = p
    tail: list[str] = []
    while not existing.exists() and existing != existing.parent:
        tail.insert(0, existing.name)
        existing = existing.parent
    return existing.resolve().joinpath(*tail)


def to_virtual(abs_path: Path) -> str | None:
    abs_path = abs_path.resolve()
    for r in roots().values():
        try:
            rel = abs_path.relative_to(r.path)
            return f"{r.name}:{rel.as_posix() if str(rel) != '.' else ''}"
        except ValueError:
            continue
    return None


def root_of(abs_path: Path) -> Root | None:
    abs_path = abs_path.resolve()
    for r in roots().values():
        try:
            abs_path.relative_to(r.path)
            return r
        except ValueError:
            continue
    return None


def classify(name: str) -> str:
    for kind, pat in KIND_PATTERNS:
        if pat.search(name):
            return kind
    return "file"


def list_dir(vpath: str, *, show_hidden: bool = False, limit: int = 5000) -> dict[str, Any]:
    root, p = resolve(vpath)
    if not p.is_dir():
        raise HTTPException(400, "Not a directory")
    entries: list[dict[str, Any]] = []
    with os.scandir(p) as it:
        for e in it:
            if not show_hidden and e.name.startswith("."):
                continue
            try:
                st = e.stat(follow_symlinks=True)
            except OSError:
                continue
            is_dir = stat.S_ISDIR(st.st_mode)
            # never follow symlinks out of the root
            try:
                Path(e.path).resolve().relative_to(root.path)
            except ValueError:
                continue
            rel = Path(e.path).resolve().relative_to(root.path).as_posix()
            entries.append(
                {
                    "name": e.name,
                    "path": f"{root.name}:{rel}",
                    "type": "dir" if is_dir else "file",
                    "kind": "dir" if is_dir else classify(e.name),
                    "size": None if is_dir else st.st_size,
                    "mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
                }
            )
            if len(entries) >= limit:
                break
    entries.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))
    rel = p.relative_to(root.path).as_posix()
    return {
        "root": root.public(),
        "path": f"{root.name}:{'' if rel == '.' else rel}",
        "parent": None if p == root.path else f"{root.name}:{'' if p.parent == root.path else p.parent.relative_to(root.path).as_posix()}",
        "entries": entries,
        "truncated": len(entries) >= limit,
    }


def walk_files(vpath: str, pattern: re.Pattern[str] | None = None, max_files: int = 20000) -> list[dict[str, Any]]:
    root, p = resolve(vpath)
    out: list[dict[str, Any]] = []
    for dirpath, dirnames, filenames in os.walk(p, followlinks=False):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if fn.startswith("."):
                continue
            if pattern and not pattern.search(fn):
                continue
            full = Path(dirpath) / fn
            try:
                st = full.stat()
                rel = full.resolve().relative_to(root.path).as_posix()
            except (OSError, ValueError):
                continue
            out.append({"name": fn, "path": f"{root.name}:{rel}", "size": st.st_size, "kind": classify(fn)})
            if len(out) >= max_files:
                return out
    return out


def read_text_preview(vpath: str, max_bytes: int = 64_000) -> dict[str, Any]:
    _, p = resolve(vpath)
    if not p.is_file():
        raise HTTPException(400, "Not a file")
    size = p.stat().st_size
    if p.suffix == ".gz":
        import gzip

        with gzip.open(p, "rb") as fh:
            data = fh.read(max_bytes)
    else:
        with open(p, "rb") as fh:
            data = fh.read(max_bytes)
    binary = b"\x00" in data[:4096]
    return {
        "path": vpath,
        "size": size,
        "truncated": size > max_bytes,
        "binary": binary,
        "content": None if binary else data.decode("utf-8", errors="replace"),
    }
