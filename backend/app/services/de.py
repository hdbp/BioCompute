"""Differential-expression tables (DESeq2, edgeR, limma and the like): column detection, cut-offs, export.

The table itself is read with explore._parse (cached), so this works on any TSV/CSV in a data folder.
Nothing is recomputed: the statistics are the ones in the file; we only classify rows with the cut-offs.
"""
from __future__ import annotations

import csv
import io
import json
import math
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from . import explore, fs

CANDIDATES = {
    "lfc": ["log2FoldChange", "logFC", "log2FC", "log2fc", "lfc", "avg_log2FC", "log2_fold_change", "Log2FC"],
    "padj": ["padj", "FDR", "adj.P.Val", "qvalue", "q_value", "p_adj", "p_val_adj", "PAdj", "fdr", "q.value"],
    "p": ["pvalue", "PValue", "P.Value", "p_value", "pval", "p_val", "Pvalue", "p.value"],
    "mean": ["baseMean", "AveExpr", "logCPM", "mean", "baseMeanA", "avg_expr", "mean_expression"],
    "id": ["gene", "gene_id", "Geneid", "GeneID", "ensembl_gene_id", "id", "ID", "feature", "V1", "Row.names"],
    "label": ["gene_name", "symbol", "Symbol", "SYMBOL", "external_gene_name", "gene_symbol", "name", "Name"],
}
# means already on a log scale are plotted as they are; counts-like means (baseMean) are plotted on log10
LOG_MEANS = {"AveExpr", "logCPM", "avg_log2", "mean_log"}


def detect(columns: list[dict[str, Any]]) -> dict[str, str | None]:
    names = [c["name"] for c in columns]
    numeric = {c["name"] for c in columns if c["type"] == "number"}
    text = [c["name"] for c in columns if c["type"] == "string"]
    lower = {n.lower(): n for n in names}

    def pick(role: str, pool: set[str] | list[str]) -> str | None:
        for cand in CANDIDATES[role]:
            hit = cand if cand in names else lower.get(cand.lower())
            if hit and hit in pool:
                return hit
        return None

    m = {"lfc": pick("lfc", numeric), "padj": pick("padj", numeric), "p": pick("p", numeric), "mean": pick("mean", numeric),
         "id": pick("id", names) or (text[0] if text else None), "label": pick("label", text)}
    if m["label"] == m["id"]:
        m["label"] = None
    return m


def is_de_table(columns: list[dict[str, Any]]) -> bool:
    m = detect(columns)
    return bool(m["lfc"] and (m["padj"] or m["p"]))


def _table(vpath: str) -> dict[str, Any]:
    _, p = fs.resolve(vpath)
    if not p.is_file():
        raise HTTPException(400, "Not a file")
    return explore._parse(p)


def _mapping(t: dict[str, Any], overrides: dict[str, str | None]) -> dict[str, str | None]:
    m = detect(t["columns"])
    names = {c["name"] for c in t["columns"]}
    for k, v in overrides.items():
        if v is not None and k in m:
            if v and v not in names:
                raise HTTPException(400, f"No column '{v}'")
            m[k] = v or None
    if not m["lfc"] or not (m["padj"] or m["p"]):
        raise HTTPException(400, "This does not look like a differential-expression table: it needs a log2 fold-change column "
                                 "and an adjusted p-value (or p-value) column. Choose them explicitly if they have other names.")
    return m


def _col(t: dict[str, Any], name: str | None) -> list[Any] | None:
    if not name:
        return None
    i = next(i for i, c in enumerate(t["columns"]) if c["name"] == name)
    c = t["columns"][i]
    if c["type"] == "number":
        return c["values"]
    return [r[i] if i < len(r) else "" for r in t["rows"]]


def data(vpath: str, overrides: dict[str, str | None]) -> dict[str, Any]:
    """Everything the interactive plots need, one entry per row (missing values as null)."""
    t = _table(vpath)
    m = _mapping(t, overrides)
    n = len(t["rows"])
    out = {k: _col(t, m[k]) for k in ("lfc", "padj", "p", "mean", "id", "label")}
    return {"mapping": m, "columns": [{"name": c["name"], "type": c["type"]} for c in t["columns"]], "n": n,
            "truncated": t["truncated"], "mean_is_log": (m["mean"] in LOG_MEANS) if m["mean"] else None,
            **{k: v for k, v in out.items()}}


def classify(lfc: float | None, pv: float | None, mean: float | None, *, p_cut: float, lfc_cut: float,
             mean_cut: float | None) -> str:
    if lfc is None or pv is None or (isinstance(lfc, float) and math.isnan(lfc)):
        return "na"
    if mean_cut is not None and (mean is None or mean < mean_cut):
        return "ns"
    if pv < p_cut and abs(lfc) >= lfc_cut:
        return "up" if lfc > 0 else "down"
    return "ns"


def filtered(vpath: str, overrides: dict[str, str | None], *, use: str, p_cut: float, lfc_cut: float,
             mean_cut: float | None, direction: str) -> tuple[list[str], list[list[str]], dict[str, int], dict[str, Any]]:
    """Rows passing the cut-offs (all original columns plus a 'regulation' column), sorted by p-value."""
    if direction not in ("up", "down", "both", "all"):
        raise HTTPException(400, "direction must be up, down, both or all")
    if use not in ("padj", "p"):
        raise HTTPException(400, "use must be padj or p")
    t = _table(vpath)
    m = _mapping(t, overrides)
    pcol = m["padj"] if use == "padj" and m["padj"] else m["p"]
    lfc, pv, mean = _col(t, m["lfc"]), _col(t, pcol), _col(t, m["mean"])
    counts = {"up": 0, "down": 0, "ns": 0, "na": 0}
    keep: list[tuple[float, int, str]] = []
    for i in range(len(t["rows"])):
        c = classify(lfc[i], pv[i], mean[i] if mean else None, p_cut=p_cut, lfc_cut=lfc_cut, mean_cut=mean_cut)
        counts[c] += 1
        if direction == "all" or c == direction or (direction == "both" and c in ("up", "down")):
            keep.append((pv[i] if pv[i] is not None else math.inf, i, c))
    keep.sort()
    header = [c["name"] for c in t["columns"]] + ["regulation"]
    rows = [t["rows"][i] + [""] * (len(t["columns"]) - len(t["rows"][i])) + [c] for _, i, c in keep]
    params = {"source": vpath, "lfc_column": m["lfc"], "p_column": pcol, "mean_column": m["mean"], "p_cutoff": p_cut,
              "abs_log2fc_cutoff": lfc_cut, "min_mean": mean_cut, "direction": direction, "counts": counts,
              "created": datetime.now(timezone.utc).isoformat()}
    return header, rows, counts, params


def to_text(header: list[str], rows: list[list[str]], fmt: str) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter="\t" if fmt == "tsv" else ",", lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def save(folder_vpath: str, base: str, text: str, fmt: str, params: dict[str, Any]) -> dict[str, str]:
    """Write the filtered table and its parameters (provenance) into a writable data folder."""
    _, folder = fs.resolve(folder_vpath, must_exist=False, for_write=True)
    folder.mkdir(parents=True, exist_ok=True)
    stem = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in base)[:80] or "de"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = folder / f"{stem}_{params['direction']}_{stamp}.{fmt}"
    out.write_text(text)
    meta = out.with_suffix(out.suffix + ".params.json")
    meta.write_text(json.dumps(params, indent=2))
    return {"path": fs.to_virtual(out) or str(out), "params": fs.to_virtual(meta) or str(meta)}
