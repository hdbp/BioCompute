"""Step settings changed on the pipeline map, written as a Nextflow config (the pipeline's code is not modified).

Each changed step gets a `withName` block in conf/biocompute_steps.config, included last from nextflow.config so
it wins over the pipeline's own settings. To override the right thing it reuses the selector the pipeline already
uses for that step (nf-core's conf/modules.config often has fully qualified names), else `(.*:)?NAME`.

What a step can take:
  enabled=False -> ext.when = false   (nf-core modules skip themselves; others need a code change)
  args          -> ext.args = '...'   (extra command-line arguments; nf-core modules pass them to the tool)
  cpus, memory, time, container       -> the usual process directives
The settings are also kept as JSON (conf/biocompute_steps.json) so the map can show and edit them.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .nf_map import _blank, _block

JSON_FILE = "conf/biocompute_steps.json"
CONFIG_FILE = "conf/biocompute_steps.config"
INCLUDE = "includeConfig 'conf/biocompute_steps.config'"
NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MEMORY = re.compile(r"^\d+(\.\d+)?\s*(KB|MB|GB|TB)$", re.I)
TIME = re.compile(r"^\d+(\.\d+)?\s*(ms|s|m|min|h|d)(\s+\d+(\.\d+)?\s*(ms|s|m|min|h|d))*$", re.I)
CONTAINER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-/:@+]*$")
SHOWN = ("ext.when", "ext.args", "cpus", "memory", "time", "container")


def load(root: Path) -> dict[str, dict[str, Any]]:
    p = root / JSON_FILE
    try:
        data = json.loads(p.read_text()) if p.is_file() else {}
    except (OSError, ValueError):
        return {}
    return data.get("steps", {}) if isinstance(data, dict) else {}


def validate(overrides: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for name, o in overrides.items():
        if not NAME.match(name):
            raise HTTPException(400, f"Not a step name: {name}")
        if not isinstance(o, dict):
            raise HTTPException(400, f"{name}: settings must be an object")
        clean: dict[str, Any] = {}
        if o.get("enabled") is False:
            clean["enabled"] = False
        if o.get("args") not in (None, ""):
            a = str(o["args"])
            if "\n" in a or len(a) > 2000:
                raise HTTPException(400, f"{name}: arguments must be one line (at most 2000 characters)")
            clean["args"] = a
        if o.get("cpus") not in (None, ""):
            try:
                c = int(o["cpus"])
            except (TypeError, ValueError):
                raise HTTPException(400, f"{name}: CPUs must be a whole number") from None
            if not 1 <= c <= 1024:
                raise HTTPException(400, f"{name}: CPUs must be between 1 and 1024")
            clean["cpus"] = c
        for key, rx, example in (("memory", MEMORY, "8 GB"), ("time", TIME, "4h")):
            v = o.get(key)
            if v not in (None, ""):
                v = str(v).strip()
                if not rx.match(v):
                    raise HTTPException(400, f"{name}: {key} must look like {example}")
                clean[key] = v
        if o.get("container") not in (None, ""):
            v = str(o["container"]).strip()
            if not CONTAINER.match(v):
                raise HTTPException(400, f"{name}: not a container image name")
            clean["container"] = v
        if clean:
            out[name] = clean
    return out


def _configs(root: Path) -> list[tuple[str, str]]:
    out = []
    for p in sorted(root.rglob("*.config")):
        rel = str(p.relative_to(root))
        if rel == CONFIG_FILE or any(part in ("work", ".nextflow", "tests") for part in p.relative_to(root).parts):
            continue
        try:
            out.append((rel, p.read_text(errors="replace")))
        except OSError:
            continue
    return out


def _alt_matches(alt: str, name: str) -> bool:
    for pat in (alt, alt.split(":")[-1]):
        try:
            if re.fullmatch(pat, name):
                return True
        except re.error:
            return False
    return False


def current(root: Path, names: list[str]) -> dict[str, list[dict[str, Any]]]:
    """For each step: the pipeline's own withName settings that apply to it (selector, file, shown settings)."""
    found: dict[str, list[dict[str, Any]]] = {n: [] for n in names}
    for rel, raw in _configs(root):
        clean = _blank(raw)
        for m in re.finditer(r"withName\s*:\s*(['\"])(.*?)\1\s*\{", raw):
            if clean[m.start():m.start() + 8] != "withName":
                continue
            a, b = _block(clean, m.end() - 1)
            body = raw[a:b]
            settings = {k: v.strip() for k, v in re.findall(r"(?m)^\s*(ext\.when|ext\.args|cpus|memory|time|container)\s*=\s*(.+)$", body)}
            for alt in m.group(2).split("|"):
                for n in names:
                    if _alt_matches(alt.strip(), n):
                        found[n].append({"selector": alt.strip(), "file": rel, "settings": settings})
    return found


def _q(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def render(root: Path, steps: dict[str, dict[str, Any]]) -> str:
    cur = current(root, list(steps))
    lines = ["// Written by BioCompute from the pipeline map (step settings). Change them there, or here.",
             "// Included last from nextflow.config, so these settings win over the pipeline's own.", "process {"]
    for name in sorted(steps):
        o = steps[name]
        selectors = list(dict.fromkeys(c["selector"] for c in cur.get(name, []))) or [f"(.*:)?{name}"]
        body = []
        if o.get("enabled") is False:
            body.append("ext.when = false")
        if "args" in o:
            body.append(f"ext.args = {_q(o['args'])}")
        if "cpus" in o:
            body.append(f"cpus = {o['cpus']}")
        if "memory" in o:
            body.append(f"memory = {_q(o['memory'])}")
        if "time" in o:
            body.append(f"time = {_q(o['time'])}")
        if "container" in o:
            body.append(f"container = {_q(o['container'])}")
        for sel in selectors:
            lines.append(f"    withName: {_q(sel)} {{  // {name}")
            lines += [f"        {x}" for x in body]
            lines.append("    }")
    lines.append("}")
    return "\n".join(lines) + "\n"


def changes_for(root: Path, steps: dict[str, dict[str, Any]]) -> dict[str, str]:
    """The files to write in the new version: settings JSON, the config, and nextflow.config including it."""
    nf = root / "nextflow.config"
    base = nf.read_text() if nf.is_file() else ""
    if INCLUDE not in base:
        base = base.rstrip("\n") + ("\n\n" if base.strip() else "") + "// step settings changed on the BioCompute pipeline map\n" + INCLUDE + "\n"
    return {
        JSON_FILE: json.dumps({"steps": steps}, indent=2) + "\n",
        CONFIG_FILE: render(root, steps),
        "nextflow.config": base,
    }
