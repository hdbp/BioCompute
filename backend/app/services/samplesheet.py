"""Experimental-design helpers: read-pair detection, validation, samplesheet generation."""
from __future__ import annotations

import csv
import io
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import fs, nfschema

# ordered from most to least specific
PAIR_PATTERNS = [
    re.compile(r"^(?P<stem>.+?)(?P<lane>_L\d{3})?_R(?P<read>[12])(?P<suffix>_\d{3})?\.(?P<ext>f(ast)?q(\.gz|\.bz2|\.zst)?)$", re.I),
    re.compile(r"^(?P<stem>.+?)(?P<lane>_L\d{3})?[._-]read(?P<read>[12])\.(?P<ext>f(ast)?q(\.gz|\.bz2|\.zst)?)$", re.I),
    re.compile(r"^(?P<stem>.+?)(?P<lane>_L\d{3})?[._](?P<read>[12])\.(?P<ext>f(ast)?q(\.gz|\.bz2|\.zst)?)$", re.I),
]
SINGLE_RE = re.compile(r"^(?P<stem>.+?)(?P<lane>_L\d{3})?\.(?P<ext>f(ast)?q(\.gz|\.bz2|\.zst)?)$", re.I)
ILLUMINA_S_RE = re.compile(r"_S\d+$")


def suggest_sample_name(stem: str) -> str:
    name = ILLUMINA_S_RE.sub("", stem)
    name = re.sub(r"[^\w.-]+", "_", name).strip("_")
    return name or stem


def detect_pairs(paths: list[str]) -> dict[str, Any]:
    """Group FASTQ virtual paths into samples / lanes / read pairs.

    Returns ``{"samples": [...], "unmatched": [...], "warnings": [...]}``. A sample has
    ``runs`` (one per lane) each with ``fastq_1`` and optional ``fastq_2``.
    """
    groups: dict[tuple[str, str, str], dict[str, str]] = defaultdict(dict)  # (dir, stem, lane) -> {1: p, 2: p}
    singles: list[tuple[str, str, str, str]] = []
    unmatched: list[str] = []
    for vp in paths:
        name = vp.rsplit("/", 1)[-1].split(":", 1)[-1]
        directory = vp[: len(vp) - len(name)]
        if not fs.FASTQ_RE.search(name):
            unmatched.append(vp)
            continue
        for pat in PAIR_PATTERNS:
            m = pat.match(name)
            if m:
                key = (directory, m.group("stem"), m.group("lane") or "")
                groups[key][m.group("read")] = vp
                break
        else:
            m = SINGLE_RE.match(name)
            singles.append((directory, m.group("stem") if m else name, (m.group("lane") if m else "") or "", vp))

    samples: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    for (directory, stem, lane), reads in sorted(groups.items()):
        sname = suggest_sample_name(stem)
        s = samples.setdefault(sname, {"sample_id": sname, "runs": [], "paired": True})
        if "1" not in reads:
            warnings.append(f"{sname}{lane}: found R2 without matching R1 ({reads.get('2')})")
            continue
        run = {"lane": lane.lstrip("_") or None, "fastq_1": reads["1"], "fastq_2": reads.get("2")}
        if "2" not in reads:
            s["paired"] = False
            warnings.append(f"{sname}{lane}: R1 without matching R2 - treated as single-end")
        s["runs"].append(run)
    for directory, stem, lane, vp in singles:
        sname = suggest_sample_name(stem)
        s = samples.setdefault(sname, {"sample_id": sname, "runs": [], "paired": False})
        s["paired"] = False
        s["runs"].append({"lane": lane.lstrip("_") or None, "fastq_1": vp, "fastq_2": None})
    for s in samples.values():
        kinds = {r["fastq_2"] is not None for r in s["runs"]}
        if len(kinds) > 1:
            warnings.append(f"{s['sample_id']}: mixture of paired and single-end runs")
    return {"samples": list(samples.values()), "unmatched": unmatched, "warnings": warnings}


# --------------------------------------------------------------------------- model -> rows
def _sample_runs(sample) -> list[dict[str, Any]]:
    files = sample.files or {}
    if files.get("runs"):
        return [{k: v for k, v in r.items() if k != "lane"} for r in files["runs"]]
    return [{k: v for k, v in files.items() if k != "runs"}]


DEFAULT_COLUMN_MAP = {
    "sample": "field:sample_id", "sample_id": "field:sample_id", "id": "field:sample_id", "Sample": "field:sample_id",
    "replicate": "field:replicate", "condition": "field:condition", "group": "field:condition",
    "batch": "field:batch", "control": "field:control_id", "control_replicate": "attr:control_replicate",
}


def _abs(vpath: str | None) -> str:
    if not vpath:
        return ""
    if ":" not in vpath:
        return vpath
    _, p = fs.resolve(vpath, must_exist=False)
    return str(p)


def build_rows(experiment, columns: list[str], mapping: dict[str, str] | None = None) -> list[dict[str, Any]]:
    mapping = {**DEFAULT_COLUMN_MAP, **(mapping or {})}
    rows: list[dict[str, Any]] = []
    for s in experiment.samples:
        for run in _sample_runs(s):
            row: dict[str, Any] = {}
            for col in columns:
                src = mapping.get(col)
                val: Any = None
                if src is None:
                    if col in run:
                        src = f"file:{col}"
                    elif col in (s.attributes or {}):
                        src = f"attr:{col}"
                if src:
                    kind, _, key = src.partition(":")
                    if kind == "field":
                        val = getattr(s, key, None)
                    elif kind == "attr":
                        val = (s.attributes or {}).get(key)
                    elif kind == "file":
                        val = _abs(run.get(key))
                    elif kind == "const":
                        val = key
                if col == "control" and s.is_control:
                    val = ""
                row[col] = "" if val is None else val
            rows.append(row)
    return rows


def to_csv(rows: list[dict[str, Any]], columns: list[str], delimiter: str = ",") -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=columns, delimiter=delimiter, lineterminator="\n", extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


def proteomics_design(experiment) -> tuple[list[str], list[dict[str, Any]]]:
    """OpenMS/quantms experimental design (two-table format flattened to the file table)."""
    cols = ["Fraction_Group", "Fraction", "Spectra_Filepath", "Label", "Sample",
            "MSstats_Condition", "MSstats_BioReplicate"]
    rows = []
    for i, s in enumerate(experiment.samples, start=1):
        a = s.attributes or {}
        rows.append({
            "Fraction_Group": a.get("fraction_group", i),
            "Fraction": a.get("fraction", 1),
            "Spectra_Filepath": _abs((s.files or {}).get("raw")),
            "Label": a.get("label", 1),
            "Sample": i,
            "MSstats_Condition": s.condition or "",
            "MSstats_BioReplicate": s.replicate or 1,
        })
    return cols, rows


def columns_for(input_schema: dict[str, Any] | None, experiment) -> list[str]:
    if input_schema:
        return [c["name"] for c in nfschema.input_columns(input_schema)]
    base = ["sample", "fastq_1", "fastq_2", "condition", "replicate"]
    return base + [c for c in (experiment.custom_columns or []) if c not in base]


# --------------------------------------------------------------------------- validation
def validate_experiment(experiment, input_schema: dict[str, Any] | None = None,
                        mapping: dict[str, str] | None = None, check_files: bool = True) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []

    def add(level: str, message: str, sample: str | None = None, field: str | None = None):
        issues.append({"level": level, "message": message, "sample": sample, "field": field})

    samples = experiment.samples
    if not samples:
        add("error", "Experiment has no samples")
    ids = Counter(s.sample_id for s in samples)
    run_keys: Counter = Counter()
    for s in samples:
        if not s.sample_id or not re.fullmatch(r"[\w.-]+", s.sample_id):
            add("error", "Sample ID must be non-empty and contain only letters, digits, '_', '.', '-'", s.sample_id, "sample_id")
        # identical IDs are allowed only as technical replicates / multiple runs of one sample
        if ids[s.sample_id] > 1 and not s.technical_replicate:
            add("error", f"Duplicate sample ID '{s.sample_id}'", s.sample_id, "sample_id")
        run_keys[(s.sample_id, s.replicate, s.technical_replicate)] += 1
        used_files: list[str] = []
        for run in _sample_runs(s):
            for role, vp in run.items():
                if role == "lane" or not vp or not isinstance(vp, str):
                    continue
                used_files.append(vp)
                if check_files:
                    try:
                        _, p = fs.resolve(vp)
                        if p.is_file() and p.stat().st_size == 0:
                            add("warning", f"{role} is an empty file", s.sample_id, role)
                    except HTTPException as exc:
                        add("error", f"{role}: {exc.detail} ({vp})", s.sample_id, role)
            f1, f2 = run.get("fastq_1"), run.get("fastq_2")
            if f1 and f2:
                n1, n2 = f1.rsplit("/", 1)[-1], f2.rsplit("/", 1)[-1]
                d = [i for i, (a, b) in enumerate(zip(n1, n2)) if a != b]
                if len(n1) != len(n2) or len(d) != 1:
                    add("warning", f"Read files look mismatched: {n1} / {n2}", s.sample_id, "fastq_2")
                elif f1 == f2:
                    add("error", "fastq_1 and fastq_2 are the same file", s.sample_id, "fastq_2")
        if experiment.assay != "proteomics" and not any(r.get("fastq_1") for r in _sample_runs(s)) and not (s.files or {}).get("raw"):
            add("warning", "No input files assigned", s.sample_id, "files")
        if experiment.assay == "proteomics" and not (s.files or {}).get("raw"):
            add("error", "Proteomics samples require a raw instrument file", s.sample_id, "raw")
        if s.control_id:
            if s.control_id not in ids:
                add("error", f"Control '{s.control_id}' is not a sample in this experiment", s.sample_id, "control_id")
            elif s.control_id == s.sample_id:
                add("error", "A sample cannot be its own control", s.sample_id, "control_id")
        s._used = used_files  # type: ignore[attr-defined]
    all_files = Counter(f for s in samples for f in getattr(s, "_used", []))
    for f, n in all_files.items():
        if n > 1:
            add("error", f"File assigned more than once: {f}")
    conds = Counter(s.condition for s in samples if s.condition and not s.is_control)
    defined = {c["name"] for c in (experiment.conditions or [])} | set(conds)
    for c, n in conds.items():
        if n < 2:
            add("warning", f"Condition '{c}' has only {n} sample - no biological replication")
    for ct in experiment.contrasts or []:
        for side in ("treatment", "reference"):
            if ct.get(side) not in defined:
                add("error", f"Contrast '{ct.get('name')}' references unknown condition '{ct.get(side)}'")
        if ct.get("treatment") == ct.get("reference"):
            add("error", f"Contrast '{ct.get('name')}' compares a condition with itself")
    rows: list[dict[str, Any]] = []
    if input_schema is not None and samples:
        cols = columns_for(input_schema, experiment)
        rows = build_rows(experiment, cols, mapping)
        for iss in nfschema.validate_rows(input_schema, rows):
            sid = rows[iss["row"]].get("sample") or rows[iss["row"]].get("sample_id")
            add("error", f"Samplesheet row {iss['row'] + 1}, column '{iss['field']}': {iss['message']}", sid, iss["field"])
    errors = sum(1 for i in issues if i["level"] == "error")
    return {"valid": errors == 0, "errors": errors, "warnings": len(issues) - errors, "issues": issues}


def parse_table(text: str) -> tuple[list[str], list[dict[str, str]]]:
    sample = text[:4096]
    delim = "\t" if sample.count("\t") > sample.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    rows = [{(k or "").strip(): (v or "").strip() for k, v in r.items()} for r in reader]
    return [c.strip() for c in (reader.fieldnames or [])], rows


def guess_virtual(value: str) -> str:
    """Map an absolute path from an imported samplesheet back to a virtual path if possible."""
    if not value or ":" in value.split("/", 1)[0]:
        return value
    v = fs.to_virtual(Path(value))
    return v or value


# --------------------------------------------------------------------------- launch from a folder or a samplesheet file
CELL_VPATH = re.compile(r"^[A-Za-z0-9_.-]+:")


def from_folder(folder: Path, columns: list[str] | None = None, max_files: int = 20_000) -> tuple[list[str], list[dict[str, Any]], list[str]]:
    """Samplesheet rows for every FASTQ under `folder` (recursively, hidden folders skipped), paired by file name.

    `folder` must lie inside a data root; files reached through symlinks that leave the root are ignored.
    """
    root = fs.root_of(folder)
    if root is None:
        raise HTTPException(403, "The folder is not inside a data folder")
    files: list[str] = []
    for p in sorted(folder.rglob("*")):
        rel = p.relative_to(folder)
        if any(part.startswith(".") for part in rel.parts) or not p.is_file() or not fs.FASTQ_RE.search(p.name):
            continue
        real = p.resolve()
        if not real.is_relative_to(root.path):
            continue
        files.append(str(real))
        if len(files) >= max_files:
            break
    det = detect_pairs(files)
    cols = list(columns or [])
    for c in ("sample", "fastq_1", "fastq_2"):
        if c not in cols:
            cols.insert(["sample", "fastq_1", "fastq_2"].index(c), c)
    rows = [{"sample": s["sample_id"], "fastq_1": r["fastq_1"], "fastq_2": r["fastq_2"] or ""}
            for s in det["samples"] for r in s["runs"]]
    notes = det["warnings"] + ([f"{len(det['unmatched'])} file(s) ignored"] if det["unmatched"] else [])
    return cols, rows, notes


def resolve_sheet(src: Path) -> tuple[str, int]:
    """Copy of a user samplesheet with data-folder paths (root:rel/file) turned into absolute paths."""
    text = src.read_text(errors="replace")
    delim = "\t" if src.suffix.lower() == ".tsv" or text.split("\n", 1)[0].count("\t") > text.split("\n", 1)[0].count(",") else ","
    rows = list(csv.reader(io.StringIO(text), delimiter=delim))
    changed = 0
    for r in rows[1:]:
        for i, cell in enumerate(r):
            if CELL_VPATH.match(cell) and cell.split(":", 1)[0] in fs.roots():
                _, p = fs.resolve(cell, must_exist=False)
                r[i] = str(p)
                changed += 1
    buf = io.StringIO()
    csv.writer(buf, delimiter=delim, lineterminator="\n").writerows(rows)
    return buf.getvalue(), changed
