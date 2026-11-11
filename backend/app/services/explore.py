"""Data Explorer: decide how to show a file, read tables, and list public UCSC track hubs.

Everything goes through fs.resolve(), so only configured data roots are reachable and path
traversal / escaping symlinks are refused. Nothing here sends local data anywhere: the only
outbound request is the fixed UCSC public-hub listing, and it can be disabled.
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import math
import time
import urllib.request
from collections import OrderedDict
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from ..config import get_settings
from . import fs

# --------------------------------------------------------------------------- file kinds
# name suffix -> (igv type, igv format); index candidates are looked up next to the file
TRACKS: list[tuple[str, str, str, tuple[str, ...]]] = [
    (".bam", "alignment", "bam", (".bai", ".csi")),
    (".cram", "alignment", "cram", (".crai",)),
    (".bigwig", "wig", "bigwig", ()),
    (".bw", "wig", "bigwig", ()),
    (".bigbed", "annotation", "bigbed", ()),
    (".bb", "annotation", "bigbed", ()),
    (".bedgraph.gz", "wig", "bedgraph", (".tbi",)),
    (".bedgraph", "wig", "bedgraph", ()),
    (".bdg", "wig", "bedgraph", ()),
    (".narrowpeak.gz", "annotation", "narrowpeak", (".tbi",)),
    (".narrowpeak", "annotation", "narrowpeak", ()),
    (".broadpeak.gz", "annotation", "broadpeak", (".tbi",)),
    (".broadpeak", "annotation", "broadpeak", ()),
    (".bed.gz", "annotation", "bed", (".tbi", ".csi")),
    (".bed", "annotation", "bed", ()),
    (".vcf.gz", "variant", "vcf", (".tbi", ".csi")),
    (".vcf", "variant", "vcf", ()),
    (".gtf.gz", "annotation", "gtf", (".tbi",)),
    (".gtf", "annotation", "gtf", ()),
    (".gff3.gz", "annotation", "gff3", (".tbi",)),
    (".gff3", "annotation", "gff3", ()),
    (".gff", "annotation", "gff3", ()),
    (".seg", "seg", "seg", ()),
    (".bedpe", "interact", "bedpe", ()),
]
FASTA = (".fa", ".fasta", ".fna", ".fa.gz", ".fasta.gz", ".fna.gz")
TABLE_SUFFIXES = (".tsv", ".csv", ".txt", ".tab", ".xls", ".counts", ".tsv.gz", ".csv.gz", ".txt.gz", ".narrowpeak", ".broadpeak",
                  ".bed", ".bedgraph", ".bdg", ".gtf", ".gff", ".gff3", ".vcf", ".narrowpeak.gz", ".broadpeak.gz", ".bed.gz",
                  ".vcf.gz", ".gtf.gz", ".summary", ".mqc", ".stats")
IMAGES = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp")
MEDIA = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
         ".svg": "image/svg+xml", ".webp": "image/webp", ".html": "text/html", ".htm": "text/html"}

# column names for headerless genomic text formats
KNOWN_COLUMNS = {
    "bed": ["chrom", "start", "end", "name", "score", "strand", "thick_start", "thick_end", "item_rgb", "block_count",
            "block_sizes", "block_starts"],
    "narrowpeak": ["chrom", "start", "end", "name", "score", "strand", "signal_value", "p_value", "q_value", "peak"],
    "broadpeak": ["chrom", "start", "end", "name", "score", "strand", "signal_value", "p_value", "q_value"],
    "bedgraph": ["chrom", "start", "end", "value"],
    "gtf": ["seqname", "source", "feature", "start", "end", "score", "strand", "frame", "attributes"],
    "gff3": ["seqid", "source", "type", "start", "end", "score", "strand", "phase", "attributes"],
}


def _lname(p: Path) -> str:
    return p.name.lower()


def track_spec(p: Path) -> dict[str, Any] | None:
    name = _lname(p)
    for suffix, ttype, fmt, idx_exts in TRACKS:
        if name.endswith(suffix):
            index = None
            for ext in idx_exts:
                # sample.bam.bai, then sample.bai
                for cand in (p.with_name(p.name + ext), p.with_name(p.name[: -len(suffix)] + ext)):
                    if cand.is_file():
                        index = cand
                        break
                if index:
                    break
            needs_index = fmt in ("bam", "cram")
            return {"type": ttype, "format": fmt, "index": fs.to_virtual(index) if index else None,
                    "indexed": bool(index), "needs_index": needs_index,
                    "too_big_unindexed": not index and fmt not in ("bigwig", "bigbed") and p.stat().st_size > 200_000_000}
    if name.endswith(FASTA):
        fai = p.with_name(p.name + ".fai")
        gzi = p.with_name(p.name + ".gzi")
        return {"type": "reference", "format": "fasta", "index": fs.to_virtual(fai) if fai.is_file() else None,
                "indexed": fai.is_file(), "compressed_index": fs.to_virtual(gzi) if gzi.is_file() else None,
                "needs_index": True, "too_big_unindexed": False}
    return None


def table_format(p: Path) -> str | None:
    name = _lname(p).removesuffix(".gz")
    for fmt in ("narrowpeak", "broadpeak", "bedgraph", "gtf", "gff3", "vcf"):
        if name.endswith("." + fmt) or (fmt == "bedgraph" and name.endswith(".bdg")) or (fmt == "gff3" and name.endswith(".gff")):
            return fmt
    if name.endswith(".bed"):
        return "bed"
    if name.endswith(".csv"):
        return "csv"
    if _lname(p).endswith(TABLE_SUFFIXES):
        return "tsv"
    return None


def info(vpath: str) -> dict[str, Any]:
    root, p = fs.resolve(vpath)
    if not p.is_file():
        raise HTTPException(400, "Not a file")
    name = _lname(p)
    size = p.stat().st_size
    track = track_spec(p)
    tfmt = table_format(p)
    if name.endswith(".pdf"):
        viewer = "pdf"
    elif name.endswith(IMAGES):
        viewer = "image"
    elif name.endswith((".html", ".htm")):
        viewer = "html"
    elif tfmt:
        viewer = "table"
    elif track:
        viewer = "track"
    else:
        head = _open(p).read(4096) if not name.endswith((".bam", ".cram", ".bw", ".bigwig", ".bb")) else b"\x00"
        viewer = "binary" if b"\x00" in head else "text"
    return {"path": fs.to_virtual(p), "name": p.name, "size": size, "mtime": p.stat().st_mtime, "viewer": viewer,
            "table_format": tfmt, "track": track, "restricted": root.restricted}


# --------------------------------------------------------------------------- tables
def _open(p: Path):
    f = p.open("rb")
    if f.read(2) == b"\x1f\x8b":
        f.close()
        return gzip.open(p, "rb")
    f.seek(0)
    return f


MAX_ROWS = 500_000
MAX_CELLS = 30_000_000
_cache: "OrderedDict[tuple, dict[str, Any]]" = OrderedDict()


MISSING = frozenset(("", "NA", "NaN", "nan", ".", "-", "NULL", "null", "None", "N/A", "#N/A"))


def _num(v: str) -> float | None:
    if v in MISSING:
        return None
    try:
        x = float(v)
    except ValueError:
        return None
    return x if math.isfinite(x) else None


def _parse(p: Path) -> dict[str, Any]:
    key = (str(p), p.stat().st_mtime_ns, p.stat().st_size)
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    fmt = table_format(p) or "tsv"
    comments: list[str] = []
    header: list[str] | None = None
    rows: list[list[str]] = []
    truncated = False
    with io.TextIOWrapper(_open(p), encoding="utf-8", errors="replace", newline="") as fh:
        delim = "," if fmt == "csv" else "\t"
        if fmt == "tsv":  # sniff: some ".txt" tables are comma separated
            first = ""
            pos_lines = []
            for line in fh:
                pos_lines.append(line)
                if not line.startswith("#") and line.strip():
                    first = line
                    break
            if first.count(",") > first.count("\t"):
                delim = ","
            lines: Any = _chain(pos_lines, fh)
        else:
            lines = fh
        reader = csv.reader((ln for ln in lines if _keep(ln, comments, fmt)), delimiter=delim)
        cells = 0
        for r in reader:
            if not r:
                continue
            if header is None and fmt not in KNOWN_COLUMNS and fmt != "vcf":
                header = r
                continue
            rows.append(r)
            cells += len(r)
            if len(rows) >= MAX_ROWS or cells >= MAX_CELLS:
                truncated = True
                break
    if fmt == "vcf":
        hdr = next((c for c in reversed(comments) if c.startswith("#CHROM")), None)
        header = hdr.lstrip("#").rstrip("\n").split("\t") if hdr else None
    width = max([len(header or [])] + [len(r) for r in rows[:1000]] or [0])
    if header is None:
        known = KNOWN_COLUMNS.get(fmt, [])
        header = known[:width] + [f"V{i + 1}" for i in range(len(known), width)]
    elif _looks_like_data(header, rows):  # a headerless .tsv: the first line was data
        rows.insert(0, header)
        header = [f"V{i + 1}" for i in range(width)]
    header = _dedupe([h.strip() or f"V{i + 1}" for i, h in enumerate(header)] + [f"V{i + 1}" for i in range(len(header), width)])
    cols = []
    for i, name in enumerate(header):
        vals = [r[i] if i < len(r) else "" for r in rows]
        nums = [_num(v) for v in vals]
        present = [v for v in vals if v.strip() not in MISSING]
        numeric = bool(present) and sum(x is not None for x in nums) >= 0.98 * len(present)
        col: dict[str, Any] = {"name": name, "type": "number" if numeric else "string", "missing": len(vals) - len(present)}
        if numeric:
            fin = [x for x in nums if x is not None]
            if fin:
                col.update(min=min(fin), max=max(fin), mean=sum(fin) / len(fin))
            col["values"] = nums
        else:
            col["distinct"] = len(set(vals[:200_000]))
        cols.append(col)
    out = {"format": fmt, "columns": cols, "rows": rows, "truncated": truncated, "comments": comments[:50]}
    _cache[key] = out
    while len(_cache) > 4:
        _cache.popitem(last=False)
    return out


def _chain(first: list[str], rest):
    yield from first
    yield from rest


def _keep(line: str, comments: list[str], fmt: str) -> bool:
    if line.startswith("#") or (fmt in ("bed", "bedgraph", "narrowpeak", "broadpeak") and line.startswith(("track ", "browser "))):
        if len(comments) < 200:
            comments.append(line)
        return False
    return bool(line.strip())


def _looks_like_data(header: list[str], rows: list[list[str]]) -> bool:
    if not rows:
        return False
    numeric_hdr = sum(_num(h) is not None for h in header)
    return numeric_hdr >= max(1, len(header) // 2)


def _dedupe(names: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for n in names:
        if n in seen:
            seen[n] += 1
            out.append(f"{n}_{seen[n]}")
        else:
            seen[n] = 0
            out.append(n)
    return out


def table_page(vpath: str, offset: int = 0, limit: int = 100, sort: str | None = None, desc: bool = False,
               q: str | None = None) -> dict[str, Any]:
    _, p = fs.resolve(vpath)
    if not p.is_file():
        raise HTTPException(400, "Not a file")
    t = _parse(p)
    names = [c["name"] for c in t["columns"]]
    idx = list(range(len(t["rows"])))
    if q:
        ql = q.lower()
        idx = [i for i in idx if any(ql in cell.lower() for cell in t["rows"][i])]
    if sort and sort in names:
        ci = names.index(sort)
        col = t["columns"][ci]
        if col["type"] == "number":
            vals = col["values"]
            idx.sort(key=lambda i: (vals[i] is None, -(vals[i] or 0) if desc else (vals[i] or 0)))
        else:
            idx.sort(key=lambda i: (t["rows"][i][ci] if ci < len(t["rows"][i]) else ""), reverse=desc)
    page = [t["rows"][i] for i in idx[offset: offset + min(limit, 1000)]]
    return {"format": t["format"], "columns": [{k: v for k, v in c.items() if k != "values"} for c in t["columns"]],
            "total": len(idx), "rows_loaded": len(t["rows"]), "truncated": t["truncated"], "offset": offset, "rows": page,
            "comments": t["comments"][:20]}


def column_values(vpath: str, cols: list[str], max_points: int = 200_000) -> dict[str, Any]:
    """Numeric values of the chosen columns, rows with a missing value in any of them dropped, evenly thinned."""
    _, p = fs.resolve(vpath)
    t = _parse(p)
    by = {c["name"]: c for c in t["columns"]}
    for c in cols:
        if c not in by:
            raise HTTPException(400, f"No column '{c}'")
        if by[c]["type"] != "number":
            raise HTTPException(400, f"Column '{c}' is not numeric")
    series = [by[c]["values"] for c in cols]
    keep = [i for i in range(len(t["rows"])) if all(s[i] is not None for s in series)]
    n = len(keep)
    if n > max_points:
        step = n / max_points
        keep = [keep[int(k * step)] for k in range(max_points)]
    return {"n": n, "returned": len(keep), "sampled": n > max_points, "truncated": t["truncated"],
            "values": {c: [s[i] for i in keep] for c, s in zip(cols, series)}}


# --------------------------------------------------------------------------- public track hubs
UCSC_HUBS = "https://api.genome.ucsc.edu/list/publicHubs"


def public_hubs(refresh: bool = False) -> dict[str, Any]:
    s = get_settings()
    url = s.explorer_public_hubs_url
    if not url:
        return {"hubs": [], "source": None, "disabled": True}
    cache = Path(s.state_dir).resolve() / "cache" / "public_hubs.json"
    if cache.is_file() and not refresh and time.time() - cache.stat().st_mtime < 86_400:
        return {**json.loads(cache.read_text()), "cached": True}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "BioCompute"})
        with urllib.request.urlopen(req, timeout=20) as r:  # fixed, admin-configured URL only
            raw = json.loads(r.read(20_000_000))
    except Exception as exc:  # noqa: BLE001 - network/proxy/JSON errors all mean "list unavailable"
        if cache.is_file():
            return {**json.loads(cache.read_text()), "cached": True, "stale": True, "error": str(exc)[:200]}
        raise HTTPException(502, f"Could not load the public hub list from {url}: {exc}. "
                                 "You can still add a hub by its hub.txt URL.") from exc
    hubs = normalize_hubs(raw)
    out = {"hubs": hubs, "source": url, "fetched_at": time.time()}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out))
    return {**out, "cached": False}


def normalize_hubs(raw: Any) -> list[dict[str, Any]]:
    items = raw.get("publicHubs", raw.get("hubs", [])) if isinstance(raw, dict) else raw
    out = []
    for h in items or []:
        if not isinstance(h, dict):
            continue
        url = h.get("hubUrl") or h.get("url")
        if not isinstance(url, str) or not url.startswith(("https://", "http://")):
            continue
        dbs = h.get("dbList") or h.get("genomes") or ""
        if isinstance(dbs, str):
            dbs = [d for d in dbs.replace(" ", "").split(",") if d]
        out.append({"url": url, "short_label": str(h.get("shortLabel") or h.get("short_label") or url)[:200],
                    "long_label": str(h.get("longLabel") or h.get("long_label") or "")[:500],
                    "genomes": [str(d) for d in dbs][:500], "description_url": h.get("descriptionUrl") or None})
    return out
