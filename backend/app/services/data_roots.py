"""Data folders added by an administrator in Settings.

A data root is the only kind of folder BioCompute will browse, read or write. These checks keep an
admin from accidentally exposing system folders, a whole home directory, hidden configuration
(~/.ssh, ~/.aws ...) or BioCompute's own state directory (keys, secrets) through the file browser.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal
from ..models import DataRoot
from . import fs

NAME = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
SYSTEM = ("/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run", "/sbin", "/srv",
          "/sys", "/usr", "/var", "/opt", "/root", "/home", "/Users", "/System", "/Library", "/Applications", "/private",
          "/Volumes", "/mnt", "/media", "/tmp")
NEVER_INSIDE = ("/proc", "/sys", "/dev", "/etc", "/boot", "/run", "/bin", "/sbin", "/usr", "/lib", "/System", "/private/etc")


def reload() -> None:
    db = SessionLocal()
    try:
        fs.set_ui_roots([_root(r) for r in db.query(DataRoot).order_by(DataRoot.name).all()])
    finally:
        db.close()


def _root(r: DataRoot) -> fs.Root:
    return fs.Root(name=r.name, path=Path(r.path), restricted=r.restricted, writable=r.writable,
                   description=r.description or "", source="ui")


def check_path(raw: str) -> dict[str, Any]:
    """Validate a folder an admin wants to add. Returns facts plus problems (errors block saving)."""
    errors: list[str] = []
    warnings: list[str] = []
    text = (raw or "").strip()
    p = Path(os.path.expanduser(text))
    if not text or not p.is_absolute():
        return {"path": text, "ok": False, "errors": ["Give the full path of a folder on the controller, e.g. /data/chipseq or ~/projects/rnaseq"],
                "warnings": [], "exists": False}
    try:
        real = p.resolve(strict=True)
    except (OSError, RuntimeError):
        return {"path": text, "ok": False, "exists": False, "warnings": [],
                "errors": [f"{p} does not exist on the controller ({os.uname().nodename}). Data on another computer must be "
                           "mounted on the controller first (NFS/SMB share or external drive)."]}
    home = Path.home().resolve()
    state = Path(get_settings().state_dir).resolve()
    if not real.is_dir():
        errors.append("That is a file, not a folder")
    if str(real) in SYSTEM or real == home:
        errors.append(f"{real} is a system or top-level folder; choose the folder that holds your data, e.g. {real}/<project>")
    if any(str(real) == x or str(real).startswith(x + "/") for x in NEVER_INSIDE):
        errors.append(f"Folders under {real.parts[0]}{real.parts[1] if len(real.parts) > 1 else ''} hold system files and cannot be data folders")
    if any(part.startswith(".") for part in real.parts[1:]):
        errors.append("Hidden folders (names starting with a dot, e.g. ~/.ssh) cannot be data folders")
    if real == state or state.is_relative_to(real) or real.is_relative_to(state):
        errors.append(f"This would expose BioCompute's own state folder ({state}: keys and secrets)")
    readable = os.access(real, os.R_OK | os.X_OK)
    writable = os.access(real, os.W_OK)
    if real.is_dir() and not readable:
        errors.append("The account running BioCompute cannot read this folder (check permissions or group membership)")
    entries: list[str] = []
    count = 0
    if real.is_dir() and readable and not errors:
        try:
            with os.scandir(real) as it:
                for e in it:
                    if e.name.startswith("."):
                        continue
                    count += 1
                    if len(entries) < 8:
                        entries.append(e.name + ("/" if e.is_dir(follow_symlinks=False) else ""))
        except OSError as exc:
            errors.append(f"Cannot list the folder: {exc.strerror}")
    for r in fs.roots().values():
        if r.path == real:
            errors.append(f"Already available as data folder “{r.name}”")
        elif real.is_relative_to(r.path) or r.path.is_relative_to(real):
            warnings.append(f"Overlaps data folder “{r.name}” ({r.path}); its files will be reachable through both")
    if real != p.absolute():
        warnings.append(f"Resolves to {real}")
    return {"path": str(real), "ok": not errors, "errors": errors, "warnings": warnings, "exists": True,
            "readable": readable, "writable_possible": writable, "entries": entries, "entry_count": count,
            "suggested_name": re.sub(r"[^A-Za-z0-9_.-]+", "-", real.name).strip("-")[:64] or "data"}


def create(db: Session, name: str, path: str, restricted: bool, writable: bool, description: str, user: str) -> DataRoot:
    if not NAME.fullmatch(name or ""):
        raise HTTPException(400, "Name: letters, digits, '-', '_' or '.' (it becomes the prefix of paths, e.g. name:folder/file)")
    if name in fs.roots():
        raise HTTPException(409, f"A data folder called “{name}” already exists")
    c = check_path(path)
    if not c["ok"]:
        raise HTTPException(400, {"message": c["errors"][0], "errors": c["errors"]})
    if writable and not c["writable_possible"]:
        raise HTTPException(400, "The account running BioCompute cannot write to this folder; add it read-only or fix permissions")
    r = DataRoot(name=name, path=c["path"], restricted=restricted, writable=writable, description=description.strip(), created_by=user)
    db.add(r)
    db.commit()
    reload()
    return r


def update(db: Session, name: str, restricted: bool | None, writable: bool | None, description: str | None) -> DataRoot:
    r = db.get(DataRoot, name)
    if not r:
        raise HTTPException(404, "Only folders added in Settings can be changed here; the others come from BIOCOMPUTE_DATA_ROOTS")
    if writable and not os.access(r.path, os.W_OK):
        raise HTTPException(400, "The account running BioCompute cannot write to this folder")
    if restricted is not None:
        r.restricted = restricted
    if writable is not None:
        r.writable = writable
    if description is not None:
        r.description = description.strip()
    db.commit()
    reload()
    return r


def delete(db: Session, name: str) -> None:
    r = db.get(DataRoot, name)
    if not r:
        raise HTTPException(404, "Only folders added in Settings can be removed here; the others come from BIOCOMPUTE_DATA_ROOTS")
    db.delete(r)
    db.commit()
    reload()
