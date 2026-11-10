#!/usr/bin/env python3
"""Aggregate per-sample FASTQ statistics into qc_summary.tsv and a self-contained HTML report.

The read-level scatter (GC% vs mean quality) colours each point by local point density
(2-D binned counts) so that over-plotted regions are visible.
"""
import argparse
import csv
import html
import math
from collections import defaultdict

VIRIDIS = [(68, 1, 84), (59, 82, 139), (33, 145, 140), (94, 201, 98), (253, 231, 37)]


def viridis(t):
    t = min(max(t, 0.0), 1.0) * (len(VIRIDIS) - 1)
    i = min(int(t), len(VIRIDIS) - 2)
    f = t - i
    a, b = VIRIDIS[i], VIRIDIS[i + 1]
    return "#%02x%02x%02x" % tuple(round(a[k] + (b[k] - a[k]) * f) for k in range(3))


def read_tsv(paths):
    rows = []
    for p in paths:
        with open(p, newline="") as fh:
            rows.extend(csv.DictReader(fh, delimiter="\t"))
    return rows


def bar_chart(title, labels, values, unit="", color="#38bdf8", w=640):
    h = 28 * len(labels) + 40
    vmax = max(values) if values else 1
    vmax = vmax or 1
    bars = []
    for i, (lab, v) in enumerate(zip(labels, values)):
        bw = (w - 220) * v / vmax
        y = 30 + i * 28
        bars.append(f'<text x="150" y="{y + 14}" text-anchor="end" class="lab">{html.escape(lab)}</text>'
                    f'<rect x="160" y="{y}" width="{bw:.1f}" height="18" rx="3" fill="{color}"/>'
                    f'<text x="{165 + bw:.1f}" y="{y + 14}" class="val">{v:,.2f}{unit}</text>')
    return f'<figure><figcaption>{html.escape(title)}</figcaption><svg viewBox="0 0 {w} {h}" width="100%">{"".join(bars)}</svg></figure>'


def density_scatter(points, w=640, h=380, bins=40):
    if not points:
        return "<p>No read-level data.</p>"
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    x0, x1 = 0.0, 100.0
    y0, y1 = 0.0, max(42.0, max(ys))
    grid = defaultdict(int)
    cell = lambda x, y: (min(int((x - x0) / (x1 - x0) * bins), bins - 1), min(int((y - y0) / (y1 - y0) * bins), bins - 1))
    for x, y in points:
        grid[cell(x, y)] += 1
    dmax = max(grid.values())
    pl, pr, pt, pb = 50, 20, 20, 40
    sx = lambda x: pl + (x - x0) / (x1 - x0) * (w - pl - pr)
    sy = lambda y: h - pb - (y - y0) / (y1 - y0) * (h - pt - pb)
    dots = sorted(((grid[cell(x, y)], x, y) for x, y in points))  # dense points drawn last
    circles = "".join(f'<circle cx="{sx(x):.1f}" cy="{sy(y):.1f}" r="2" fill="{viridis(math.log1p(d) / math.log1p(dmax))}" fill-opacity="0.8"/>' for d, x, y in dots)
    axes = (f'<line x1="{pl}" y1="{h - pb}" x2="{w - pr}" y2="{h - pb}" stroke="#888"/><line x1="{pl}" y1="{pt}" x2="{pl}" y2="{h - pb}" stroke="#888"/>'
            + "".join(f'<text x="{sx(v)}" y="{h - pb + 16}" text-anchor="middle" class="val">{v}</text>' for v in range(0, 101, 20))
            + "".join(f'<text x="{pl - 6}" y="{sy(v) + 4}" text-anchor="end" class="val">{v}</text>' for v in range(0, int(y1) + 1, 10))
            + f'<text x="{(w + pl) / 2}" y="{h - 6}" text-anchor="middle" class="lab">Read GC content (%)</text>'
            + f'<text x="14" y="{h / 2}" transform="rotate(-90 14 {h / 2})" text-anchor="middle" class="lab">Mean base quality (Phred)</text>')
    legend = "".join(f'<rect x="{w - 150 + i * 6}" y="{pt}" width="6" height="10" fill="{viridis(i / 19)}"/>' for i in range(20))
    legend += f'<text x="{w - 150}" y="{pt + 24}" class="val">low</text><text x="{w - 30}" y="{pt + 24}" class="val" text-anchor="end">high density</text>'
    return f'<figure><figcaption>Per-read GC vs quality ({len(points):,} reads, coloured by point density)</figcaption><svg viewBox="0 0 {w} {h}" width="100%">{axes}{circles}{legend}</svg></figure>'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", default="FASTQ QC report")
    ap.add_argument("--samplesheet")
    ap.add_argument("--stats", nargs="+", required=True)
    ap.add_argument("--reads", nargs="*", default=[])
    a = ap.parse_args()
    meta = {}
    if a.samplesheet:
        with open(a.samplesheet, newline="") as fh:
            for r in csv.DictReader(fh):
                meta[r.get("sample")] = r
    stats = read_tsv(a.stats)
    per_sample = defaultdict(lambda: {"reads": 0, "bases": 0, "gc_w": 0.0, "q_w": 0.0, "q30_w": 0.0, "pass": 0, "files": 0})
    for r in stats:
        s = per_sample[r["sample"]]
        n, b = int(r["reads"]), int(r["bases"])
        s["reads"] += n
        s["bases"] += b
        s["gc_w"] += float(r["gc_percent"]) * b
        s["q_w"] += float(r["mean_quality"]) * b
        s["q30_w"] += float(r["pct_q30_bases"]) * b
        s["pass"] += int(r["reads_pass"])
        s["files"] += 1
    cols = ["sample", "condition", "replicate", "files", "reads", "bases", "mean_length", "gc_percent", "mean_quality", "pct_q30_bases", "pct_pass"]
    summary = []
    for name in sorted(per_sample):
        s = per_sample[name]
        b = s["bases"] or 1
        m = meta.get(name, {})
        summary.append({"sample": name, "condition": m.get("condition", ""), "replicate": m.get("replicate", ""), "files": s["files"],
                        "reads": s["reads"], "bases": s["bases"], "mean_length": round(s["bases"] / max(s["reads"], 1), 2),
                        "gc_percent": round(s["gc_w"] / b, 2), "mean_quality": round(s["q_w"] / b, 2),
                        "pct_q30_bases": round(s["q30_w"] / b, 2), "pct_pass": round(100 * s["pass"] / max(s["reads"], 1), 2)})
    with open("qc_summary.tsv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, delimiter="\t")
        w.writeheader()
        w.writerows(summary)
    pts = [(float(r["gc_percent"]), float(r["mean_quality"])) for r in read_tsv(a.reads)]
    labels = [r["sample"] for r in summary]
    table = "".join("<tr>" + "".join(f"<td>{html.escape(str(r[c]))}</td>" for c in cols) + "</tr>" for r in summary)
    flags = [r["sample"] for r in summary if r["pct_pass"] < 80 or r["mean_quality"] < 25]
    body = f"""<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(a.title)}</title>
<style>body{{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:980px;color:#1e293b}}h1{{font-weight:600}}
table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{border-bottom:1px solid #e2e8f0;padding:6px 8px;text-align:left}}
th{{background:#f1f5f9}}figure{{margin:1.5rem 0}}figcaption{{font-weight:600;margin-bottom:.5rem}}.lab{{font-size:12px;fill:#334155}}
.val{{font-size:11px;fill:#64748b}}.warn{{background:#fef3c7;padding:.75rem 1rem;border-radius:8px}}</style></head><body>
<h1>{html.escape(a.title)}</h1><p>{len(summary)} samples · {sum(r['reads'] for r in summary):,} reads · generated by the BioCompute FASTQ QC pipeline</p>
{f'<p class="warn">Samples below thresholds (pass &lt; 80% or mean Q &lt; 25): {html.escape(", ".join(flags))}</p>' if flags else ''}
<table><tr>{''.join(f'<th>{c}</th>' for c in cols)}</tr>{table}</table>
{bar_chart('Reads per sample', labels, [r['reads'] for r in summary], '', '#38bdf8')}
{bar_chart('Reads passing filters (%)', labels, [r['pct_pass'] for r in summary], '%', '#34d399')}
{bar_chart('GC content (%)', labels, [r['gc_percent'] for r in summary], '%', '#a78bfa')}
{density_scatter(pts)}
</body></html>"""
    with open("qc_report.html", "w") as fh:
        fh.write(body)


if __name__ == "__main__":
    main()
