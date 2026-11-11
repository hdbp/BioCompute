import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, FolderInput, ImageDown, SlidersHorizontal } from "lucide-react";
import { api, authed, errMsg, qs } from "@/lib/api";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/theme";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { PathInput } from "@/components/file-browser";
import { cssColor, drawAxes, extent, fmt, PAD, setupCanvas, useSize } from "./plots";

interface DEData {
  mapping: Record<"lfc" | "padj" | "p" | "mean" | "id" | "label", string | null>;
  columns: { name: string; type: string }[]; n: number; truncated: boolean; mean_is_log: boolean | null;
  lfc: (number | null)[]; padj: (number | null)[] | null; p: (number | null)[] | null; mean: (number | null)[] | null;
  id: string[] | null; label: string[] | null;
}
type Cls = "up" | "down" | "ns" | "na";
type Dir = "both" | "up" | "down" | "all";

/** Columns that make a table a differential-expression result (same names the server recognises). */
export function looksLikeDE(cols: { name: string; type: string }[]) {
  const num = new Set(cols.filter((c) => c.type === "number").map((c) => c.name.toLowerCase()));
  const has = (xs: string[]) => xs.some((x) => num.has(x.toLowerCase()));
  return has(["log2FoldChange", "logFC", "log2FC", "lfc", "avg_log2FC", "log2_fold_change"])
    && has(["padj", "FDR", "adj.P.Val", "qvalue", "q_value", "p_adj", "p_val_adj", "pvalue", "PValue", "P.Value", "p_value", "pval"]);
}

// one hue per group; lightness follows how many points overlap there (low -> high density)
const RAMPS: Record<"dark" | "light", Record<Exclude<Cls, "na">, [number[], number[]]>> = {
  dark: { ns: [[72, 72, 80], [178, 178, 188]], up: [[140, 58, 48], [255, 146, 112]], down: [[42, 86, 150], [128, 188, 255]] },
  light: { ns: [[188, 188, 196], [88, 88, 98]], up: [[226, 112, 88], [160, 28, 16]], down: [[96, 150, 222], [20, 66, 156]] },
};
const ramp = (a: number[], b: number[], t: number) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
const SWATCH: Record<Exclude<Cls, "na">, string> = { up: "rgb(220 90 70)", down: "rgb(70 130 220)", ns: "rgb(150 150 160)" };

export function DEView({ path, projects, defaultProject }: { path: string; projects: Project[]; defaultProject?: string | null }) {
  const qc = useQueryClient();
  const [mapping, setMapping] = useState<Partial<DEData["mapping"]>>({});
  const q = useQuery({
    queryKey: ["de", path, mapping],
    queryFn: () => api.get<DEData>(`/api/explore/de${qs({ path, ...mapping })}`),
  });
  const [plot, setPlot] = useState<"volcano" | "ma">("volcano");
  const [use, setUse] = useState<"padj" | "p">("padj");
  const [pCut, setPCut] = useState(0.05);
  const [lfcCut, setLfcCut] = useState(1);
  const [meanCut, setMeanCut] = useState<number | null>(null);
  const [topN, setTopN] = useState(10);
  const [find, setFind] = useState("");
  const [dir, setDir] = useState<Dir>("both");
  const [page, setPage] = useState(0);
  const [showCols, setShowCols] = useState(false);
  const [saveTo, setSaveTo] = useState<string>(defaultProject ?? "");
  const [folder, setFolder] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setMapping({}); setPage(0); }, [path]);
  useEffect(() => { if (q.data && !q.data.padj) setUse("p"); }, [q.data]);

  const d = q.data;
  const cls = useMemo<Cls[]>(() => {
    if (!d) return [];
    const pv = (use === "padj" ? d.padj : d.p) ?? d.p ?? d.padj ?? [];
    return d.lfc.map((l, i) => {
      const p = pv[i];
      if (l == null || p == null) return "na";
      if (meanCut != null && (d.mean?.[i] == null || d.mean[i]! < meanCut)) return "ns";
      return p < pCut && Math.abs(l) >= lfcCut ? (l > 0 ? "up" : "down") : "ns";
    });
  }, [d, use, pCut, lfcCut, meanCut]);
  const counts = useMemo(() => cls.reduce((a, c) => ({ ...a, [c]: a[c] + 1 }), { up: 0, down: 0, ns: 0, na: 0 } as Record<Cls, number>), [cls]);
  const pvals = d ? ((use === "padj" ? d.padj : d.p) ?? d.p ?? d.padj ?? []) : [];
  const name = (i: number) => d?.label?.[i] || d?.id?.[i] || `row ${i + 1}`;

  const rows = useMemo(() => {
    if (!d) return [];
    const f = find.trim().toLowerCase();
    // a gene search looks at every gene, whatever its category
    const idx = cls.map((c, i) => [c, i] as const).filter(([c]) => f || dir === "all" || c === dir || (dir === "both" && (c === "up" || c === "down"))).map(([, i]) => i);
    const out = f ? idx.filter((i) => name(i).toLowerCase().includes(f) || (d.id?.[i] ?? "").toLowerCase().includes(f)) : idx;
    return out.sort((a, b) => (pvals[a] ?? Infinity) - (pvals[b] ?? Infinity));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, cls, dir, find, use]);
  useEffect(() => setPage(0), [dir, find, pCut, lfcCut, meanCut]);

  if (q.isError) return <p className="text-[13px] text-bad">{errMsg(q.error)}</p>;
  if (!d) return <p className="py-10 text-center text-[13px] text-muted">Reading results…</p>;

  const exportParams = { path, use, p_cut: pCut, lfc_cut: lfcCut, mean_cut: meanCut ?? undefined, direction: dir, ...mapping };
  const exportUrl = (fmt: "csv" | "tsv") => authed(`/api/explore/de/export${qs({ ...exportParams, fmt })}`);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post<{ path: string; rows: number }>("/api/explore/de/save", {
        path, use, p_cut: pCut, lfc_cut: lfcCut, mean_cut: meanCut, direction: dir, fmt: "tsv", mapping,
        project_id: saveTo && saveTo !== "folder" ? saveTo : null, folder: saveTo === "folder" ? folder : null,
      });
      toast.success(`Saved ${r.rows} genes to ${r.path} (with the cut-offs in a .params.json next to it)`);
      qc.invalidateQueries({ queryKey: ["project"] });
      qc.invalidateQueries({ queryKey: ["browse"] });
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  const pLabel = use === "padj" ? d.mapping.padj ?? "padj" : d.mapping.p ?? "p";
  const editable = projects.filter((p) => p.can_edit && p.home);

  return (
    <div className="space-y-4">
      {/* controls */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-3 text-[13px]">
        <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="Plot">
          {([["volcano", "Volcano"], ["ma", "MA plot"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setPlot(k)} aria-pressed={plot === k} disabled={k === "ma" && !d.mean}
              className={cn("rounded px-3 py-1 disabled:opacity-40", plot === k ? "bg-raised text-text" : "text-muted hover:text-text")}>{l}</button>
          ))}
        </div>
        {d.padj && d.p && (
          <Field label="Significance" className="w-36"><Select className="h-8" value={use} onChange={(e) => setUse(e.target.value as "padj" | "p")}>
            <option value="padj">adjusted p ({d.mapping.padj})</option><option value="p">raw p ({d.mapping.p})</option></Select></Field>
        )}
        <Field label={`${use === "padj" ? "Adj. p" : "p"} below`} className="w-28">
          <Input className="h-8" type="number" min={0} max={1} step="any" value={pCut} onChange={(e) => setPCut(Math.min(1, Math.max(0, Number(e.target.value) || 0)))} />
        </Field>
        <Field label="|log2 FC| at least" className="w-32">
          <Input className="h-8" type="number" min={0} step={0.1} value={lfcCut} onChange={(e) => setLfcCut(Math.max(0, Number(e.target.value) || 0))} />
        </Field>
        {d.mean && (
          <Field label={`Min ${d.mapping.mean}`} className="w-32">
            <Input className="h-8" type="number" step="any" placeholder="none" value={meanCut ?? ""} onChange={(e) => setMeanCut(e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
        )}
        <Field label="Label top" className="w-24">
          <Select className="h-8" value={topN} onChange={(e) => setTopN(Number(e.target.value))}>{[0, 5, 10, 20, 40].map((n) => <option key={n} value={n}>{n ? `${n} genes` : "none"}</option>)}</Select>
        </Field>
        <Field label="Find a gene" className="w-44">
          <Input type="search" className="h-8" value={find} onChange={(e) => setFind(e.target.value)} placeholder="e.g. MYC" />
        </Field>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShowCols((s) => !s)} aria-expanded={showCols}><SlidersHorizontal />Columns</Button>
        {showCols && (
          <div className="grid w-full gap-3 border-t border-line pt-3 sm:grid-cols-3 lg:grid-cols-6">
            {(["lfc", "padj", "p", "mean", "id", "label"] as const).map((k) => (
              <Field key={k} label={{ lfc: "log2 fold change", padj: "Adjusted p", p: "p-value", mean: "Mean expression", id: "Gene id", label: "Gene name" }[k]}>
                <Select className="h-8" value={mapping[k] ?? d.mapping[k] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [k]: e.target.value }))}>
                  <option value="">(none)</option>
                  {d.columns.filter((c) => (k === "id" || k === "label") ? true : c.type === "number").map((c) => <option key={c.name}>{c.name}</option>)}
                </Select>
              </Field>
            ))}
          </div>
        )}
      </div>

      {/* counts */}
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {(["up", "down", "ns"] as const).map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1">
            <span className="size-2.5 rounded-full" style={{ background: SWATCH[c] }} />
            {c === "up" ? "Up" : c === "down" ? "Down" : "Not significant"} <b className="tabular-nums">{counts[c].toLocaleString()}</b>
          </span>
        ))}
        {counts.na > 0 && <span className="text-xs text-muted">{counts.na.toLocaleString()} without a test result (NA)</span>}
        <span className="text-xs text-muted">Shade shows how many genes overlap (light = few, strong = many).</span>
        {d.truncated && <Badge tone="wait">first {d.n.toLocaleString()} rows</Badge>}
      </div>

      <DEPlot d={d} cls={cls} pvals={pvals} plot={plot} pCut={pCut} lfcCut={lfcCut} topN={topN} find={find} pLabel={pLabel} name={name} />

      {/* results table + export */}
      <div className="rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[13px]">
          <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="Which genes">
            {([["both", "Significant"], ["up", "Up"], ["down", "Down"], ["all", "All"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setDir(k)} aria-pressed={dir === k} className={cn("rounded px-2.5 py-1", dir === k ? "bg-raised text-text" : "text-muted hover:text-text")}>{l}</button>
            ))}
          </div>
          <span className="tabular-nums text-muted">{`${rows.length.toLocaleString()} gene${rows.length === 1 ? "" : "s"}`}{find.trim() ? ` matching “${find.trim()}” (any category)` : `, sorted by ${pLabel}`}</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <a href={exportUrl("csv")}><Button size="sm" variant="secondary" tabIndex={-1}><Download />CSV</Button></a>
            <a href={exportUrl("tsv")}><Button size="sm" variant="secondary" tabIndex={-1}><Download />TSV</Button></a>
            <Select aria-label="Save into" className="h-8 w-52" value={saveTo} onChange={(e) => setSaveTo(e.target.value)}>
              <option value="">Save into…</option>
              {editable.map((p) => <option key={p.id} value={p.id}>Project: {p.name}</option>)}
              <option value="folder">A data folder…</option>
            </Select>
            {saveTo === "folder" && <div className="w-64"><PathInput mode="dir" value={folder} onChange={setFolder} writableOnly /></div>}
            <Button size="sm" variant="primary" loading={saving} disabled={!saveTo || (saveTo === "folder" && !folder)} onClick={save}><FolderInput />Save</Button>
          </div>
        </div>
        <div className="max-h-[50vh] overflow-auto">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-raised"><tr className="text-left">
              <th className="px-2.5 py-1.5 font-medium">Gene</th>
              {d.mean && <th className="px-2.5 py-1.5 text-right font-medium">{d.mapping.mean}</th>}
              <th className="px-2.5 py-1.5 text-right font-medium">{d.mapping.lfc}</th>
              {d.p && <th className="px-2.5 py-1.5 text-right font-medium">{d.mapping.p}</th>}
              {d.padj && <th className="px-2.5 py-1.5 text-right font-medium">{d.mapping.padj}</th>}
              <th className="px-2.5 py-1.5 font-medium">Regulation</th>
            </tr></thead>
            <tbody>
              {rows.slice(page * 100, page * 100 + 100).map((i) => (
                <tr key={i} className="border-b border-line/50 hover:bg-raised/50">
                  <td className="px-2.5 py-1">{name(i)}{d.label?.[i] && d.id?.[i] && d.label[i] !== d.id[i] && <span className="ml-1.5 text-[11px] text-muted">{d.id[i]}</span>}</td>
                  {d.mean && <td className="px-2.5 py-1 text-right font-mono tabular-nums">{d.mean[i] == null ? "NA" : fmt(d.mean[i]!)}</td>}
                  <td className="px-2.5 py-1 text-right font-mono tabular-nums">{d.lfc[i] == null ? "NA" : fmt(d.lfc[i]!)}</td>
                  {d.p && <td className="px-2.5 py-1 text-right font-mono tabular-nums">{d.p[i] == null ? "NA" : fmt(d.p[i]!)}</td>}
                  {d.padj && <td className="px-2.5 py-1 text-right font-mono tabular-nums">{d.padj[i] == null ? "NA" : fmt(d.padj[i]!)}</td>}
                  <td className="px-2.5 py-1"><span className="inline-flex items-center gap-1.5">{cls[i] !== "na" && <span className="size-2 rounded-full" style={{ background: SWATCH[cls[i] as Exclude<Cls, "na">] }} />}{{ up: "up", down: "down", ns: "not significant", na: "NA" }[cls[i]]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="p-6 text-center text-[13px] text-muted">{find.trim() ? `No gene matches “${find.trim()}”.` : "No genes pass these cut-offs."}</p>}
        </div>
        {rows.length > 100 && (
          <div className="flex items-center justify-end gap-2 px-3 py-2 text-xs text-muted">
            <span className="tabular-nums">{page * 100 + 1}–{Math.min(rows.length, page * 100 + 100)} of {rows.length.toLocaleString()}</span>
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button size="sm" variant="ghost" disabled={(page + 1) * 100 >= rows.length} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        )}
        <p className="border-t border-line px-3 py-2 text-[11.5px] text-muted">
          Exports contain every column of the original table plus a <code>regulation</code> column, for the genes selected above.
          Saved files get a <code>.params.json</code> next to them recording the cut-offs.
        </p>
      </div>
    </div>
  );
}

function DEPlot({ d, cls, pvals, plot, pCut, lfcCut, topN, find, pLabel, name }: {
  d: DEData; cls: Cls[]; pvals: (number | null)[]; plot: "volcano" | "ma"; pCut: number; lfcCut: number; topN: number; find: string;
  pLabel: string; name: (i: number) => string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const w = useSize(wrap);
  const { theme } = useTheme();
  const h = 440;
  const [tip, setTip] = useState<{ left: number; top: number; i: number } | null>(null);
  const geo = useRef<{ px: Float32Array; py: Float32Array; idx: Int32Array; bins: Map<number, number[]> } | null>(null);

  // x/y per gene for the chosen plot
  const pts = useMemo(() => {
    const idx: number[] = [], xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < d.lfc.length; i++) {
      const l = d.lfc[i];
      if (l == null || cls[i] === "na") continue;
      if (plot === "volcano") {
        const p = pvals[i];
        if (p == null) continue;
        idx.push(i); xs.push(l); ys.push(-Math.log10(Math.max(p, 1e-300)));
      } else {
        const m = d.mean?.[i];
        if (m == null) continue;
        const x = d.mean_is_log ? m : m > 0 ? Math.log10(m) : null;
        if (x == null) continue;
        idx.push(i); xs.push(x); ys.push(l);
      }
    }
    return { idx: Int32Array.from(idx), xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
  }, [d, cls, pvals, plot]);

  const xLabel = plot === "volcano" ? d.mapping.lfc ?? "log2 FC" : d.mean_is_log ? d.mapping.mean ?? "mean" : `log10(${d.mapping.mean})`;
  const yLabel = plot === "volcano" ? `−log10(${pLabel})` : d.mapping.lfc ?? "log2 FC";

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const g = setupCanvas(c, w, h);
    let xd = extent(pts.xs), yd = extent(pts.ys);
    if (plot === "volcano") { const m = Math.max(Math.abs(xd[0]), Math.abs(xd[1]), lfcCut * 1.2); xd = [-m, m]; yd = [0, Math.max(yd[1], -Math.log10(pCut) * 1.1) * 1.08]; }
    else { const m = Math.max(Math.abs(yd[0]), Math.abs(yd[1]), lfcCut * 1.2); yd = [-m, m]; }
    const { sx, sy } = drawAxes(g, w, h, xd, yd, xLabel, yLabel);
    const n = pts.idx.length;
    const px = new Float32Array(n), py = new Float32Array(n);
    const cell = 4, gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
    const grid = new Uint32Array(gw * gh);
    const bins = new Map<number, number[]>();
    for (let k = 0; k < n; k++) {
      px[k] = sx(pts.xs[k]); py[k] = sy(pts.ys[k]);
      const key = Math.floor(py[k] / cell) * gw + Math.floor(px[k] / cell);
      grid[key]++;
      const b = bins.get(key); if (b) b.push(k); else bins.set(key, [k]);
    }
    const dens = new Float32Array(n);
    let maxD = 1;
    for (let k = 0; k < n; k++) {
      const cx = Math.floor(px[k] / cell), cy = Math.floor(py[k] / cell);
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) s += grid[yy * gw + xx] * (dx || dy ? 0.5 : 1);
      }
      dens[k] = s; if (s > maxD) maxD = s;
    }
    const rank: Record<Cls, number> = { ns: 0, na: 0, down: 1, up: 1 };
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => rank[cls[pts.idx[a]]] - rank[cls[pts.idx[b]]] || dens[a] - dens[b]);
    const lmax = Math.log1p(maxD);
    const r = n > 40_000 ? 1.3 : n > 8000 ? 1.8 : 2.5;
    g.save();
    g.beginPath(); g.rect(PAD.l, PAD.t, w - PAD.l - PAD.r, h - PAD.t - PAD.b); g.clip();
    for (const k of order) {
      const c = cls[pts.idx[k]] as Exclude<Cls, "na">;
      const [a, b] = RAMPS[theme][c];
      g.fillStyle = ramp(a, b, Math.log1p(dens[k]) / lmax);
      g.fillRect(px[k] - r, py[k] - r, r * 2, r * 2);
    }
    // cut-off lines
    g.setLineDash([5, 4]);
    g.strokeStyle = cssColor("--muted", 0.9);
    g.lineWidth = 1;
    const line = (x0: number, y0: number, x1: number, y1: number) => { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
    if (plot === "volcano") {
      const y = sy(-Math.log10(pCut)); line(PAD.l, y, w - PAD.r, y);
      if (lfcCut > 0) { line(sx(lfcCut), PAD.t, sx(lfcCut), h - PAD.b); line(sx(-lfcCut), PAD.t, sx(-lfcCut), h - PAD.b); }
    } else {
      line(PAD.l, sy(0), w - PAD.r, sy(0));
      if (lfcCut > 0) { line(PAD.l, sy(lfcCut), w - PAD.r, sy(lfcCut)); line(PAD.l, sy(-lfcCut), w - PAD.r, sy(-lfcCut)); }
    }
    g.setLineDash([]);
    // labels: top N significant by p, plus genes matching the search
    const sig = Array.from({ length: n }, (_, k) => k).filter((k) => cls[pts.idx[k]] === "up" || cls[pts.idx[k]] === "down")
      .sort((a, b) => (pvals[pts.idx[a]] ?? 1) - (pvals[pts.idx[b]] ?? 1)).slice(0, topN);
    const f = find.trim().toLowerCase();
    const hits = f ? Array.from({ length: n }, (_, k) => k).filter((k) => name(pts.idx[k]).toLowerCase() === f || (d.id?.[pts.idx[k]] ?? "").toLowerCase() === f).slice(0, 20) : [];
    g.font = "11px ui-sans-serif, system-ui, sans-serif";
    g.textBaseline = "bottom";
    const placed: { x: number; y: number; w: number }[] = [];
    for (const k of [...hits, ...sig]) {
      const label = name(pts.idx[k]);
      const tw = g.measureText(label).width;
      let x = px[k] + 5, y = py[k] - 3;
      if (x + tw > w - PAD.r) x = px[k] - 5 - tw;
      if (y - 12 < PAD.t) y = py[k] + 15; // keep labels of the most extreme genes inside the plot
      if (placed.some((p) => Math.abs(p.y - y) < 12 && x < p.x + p.w && x + tw > p.x)) continue; // skip colliding labels
      placed.push({ x, y, w: tw });
      g.fillStyle = cssColor("--surface", 0.85);
      g.fillRect(x - 2, y - 12, tw + 4, 13);
      g.fillStyle = cssColor("--text");
      g.fillText(label, x, y);
    }
    for (const k of hits) {
      g.strokeStyle = cssColor("--accent"); g.lineWidth = 2;
      g.beginPath(); g.arc(px[k], py[k], 6, 0, Math.PI * 2); g.stroke();
    }
    g.restore();
    geo.current = { px, py, idx: pts.idx, bins };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, w, theme, plot, pCut, lfcCut, topN, find, cls, xLabel, yLabel]);

  const onMove = (e: React.MouseEvent) => {
    const G = geo.current;
    if (!G) return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const gw = Math.ceil(w / 4), cx = Math.floor(mx / 4), cy = Math.floor(my / 4);
    let best = -1, bd = 64;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (const k of G.bins.get((cy + dy) * gw + cx + dx) ?? []) {
      const dd = (G.px[k] - mx) ** 2 + (G.py[k] - my) ** 2;
      if (dd < bd) { bd = dd; best = k; }
    }
    setTip(best < 0 ? null : { left: G.px[best], top: G.py[best], i: G.idx[best] });
  };

  const download = () => {
    const url = canvas.current?.toDataURL("image/png");
    if (url) Object.assign(document.createElement("a"), { href: url, download: `${plot === "volcano" ? "volcano" : "ma"}_plot.png` }).click();
  };

  return (
    <figure className="rounded-lg border border-line bg-surface p-3">
      <div ref={wrap} className="relative w-full">
        <canvas ref={canvas} onMouseMove={onMove} onMouseLeave={() => setTip(null)} role="img"
          aria-label={`${plot === "volcano" ? "Volcano" : "MA"} plot of ${pts.idx.length.toLocaleString()} genes`} />
        {tip && (
          <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] shadow-lg"
            style={{ left: tip.left, top: tip.top }}>
            <div className="font-medium">{name(tip.i)}</div>
            <div className="tabular-nums">{d.mapping.lfc}: {fmt(d.lfc[tip.i] ?? NaN)}</div>
            {d.mean && <div className="tabular-nums">{d.mapping.mean}: {d.mean[tip.i] == null ? "NA" : fmt(d.mean[tip.i]!)}</div>}
            <div className="tabular-nums">{pLabel}: {pvals[tip.i] == null ? "NA" : fmt(pvals[tip.i]!)}</div>
            <div>{{ up: "up", down: "down", ns: "not significant", na: "NA" }[cls[tip.i]]}</div>
          </div>
        )}
      </div>
      <figcaption className="mt-1 flex items-center gap-3 pl-16 text-[11.5px] text-muted">
        <span className="tabular-nums">{pts.idx.length.toLocaleString()} genes</span>
        <span>Dashed lines: the cut-offs</span>
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={download}><ImageDown />PNG</Button>
      </figcaption>
    </figure>
  );
}
