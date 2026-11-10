"""Detection of execution software on the controller host (cached)."""
from __future__ import annotations

import re
import shutil
import subprocess
import time
from typing import Any

from ..config import get_settings

_CACHE: dict[str, tuple[float, Any]] = {}
TTL = 60.0


def _cached(key: str, fn):
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < TTL:
        return hit[1]
    val = fn()
    _CACHE[key] = (now, val)
    return val


def clear_cache() -> None:
    _CACHE.clear()


def _version(argv: list[str], pattern: str = r"(\d+\.\d+(?:\.\d+)?)", timeout: int = 20) -> str | None:
    exe = shutil.which(argv[0])
    if not exe:
        return None
    try:
        p = subprocess.run([exe, *argv[1:]], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    m = re.search(pattern, (p.stdout or "") + (p.stderr or ""))
    return m.group(1) if m else "unknown"


def nextflow_status() -> dict[str, Any]:
    def probe():
        s = get_settings()
        exe = shutil.which(s.nextflow_bin)
        if not exe:
            return {"available": False, "detail": f"'{s.nextflow_bin}' not found on PATH of the execution service"}
        ver = _version([exe, "-version"], r"version\s+(\d+\.\d+\.\d+)", timeout=60)
        return {"available": True, "path": exe, "version": ver, "detail": f"Nextflow {ver}"}

    return _cached("nextflow", probe)


def inventory() -> dict[str, Any]:
    def probe():
        s = get_settings()
        return {
            "nextflow": nextflow_status(),
            "java": _version([s.java_bin, "-version"], r'version "?(\d+[\.\d]*)'),
            "git": _version(["git", "--version"]),
            "docker": _version(["docker", "--version"]),
            "podman": _version(["podman", "--version"]),
            "apptainer": _version(["apptainer", "--version"]),
            "singularity": _version(["singularity", "--version"]),
            "conda": _version(["conda", "--version"]),
            "mamba": _version(["mamba", "--version"]),
            "R": _version(["R", "--version"], r"R version (\d+\.\d+\.\d+)"),
            "python3": _version(["python3", "--version"]),
            "htcondor": _version([s.condor_status_bin, "-version"], r"\$CondorVersion: (\d+\.\d+\.\d+)"),
            "tailscale": _version([s.tailscale_bin, "version"]),
            "snakemake": _version(["snakemake", "--version"]),
        }

    return _cached("inventory", probe)


def which_all(names: list[str]) -> dict[str, str | None]:
    return {n: shutil.which(n) for n in names}
