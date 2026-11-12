import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, BarChart3, ChevronLeft, ChevronRight, ScatterChart, Search } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { applyTransform, DensityScatter, fmt, Histogram, TRANSFORM_LABEL, type Transform } from "./plots";
import { DEView, looksLikeDE } from "./de-view";
import type { Project } from "@/lib/types";
import { QueryError } from "@/components/page";

interface Column { name: string; type: "number" | "string"; missing: number; min?: number; max?: number; mean?: number; distinct?: number }
interface TablePage {
  format: string; columns: Column[]; total: number; rows_loaded: number; truncated: boolean; offset: number; rows: string[][]; comments: string[];
}

const PAGE = 100;

export function TableView({ path, projects = [], project }: { path: string; projects?: Project[]; project?: string | null }) {
  const [mode, setMode] = useState<"de" | "table" | null>(null);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null);
  const [q, setQ] = useState("");
  const [qDebounced, setQd] = useState("");
  useEffect(() => { const t = setTimeout(() => { setQd(q); setOffset(0); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setOffset(0); setSort(null); setQ(""); setMode(null); }, [path]);

  const t = useQuery({
    queryKey: ["explore-table", path, offset, sort, qDebounced],
    queryFn: () => api.get<TablePage>(`/api/explore/table${qs({ path, offset, limit: PAGE, sort: sort?.col, desc: sort?.desc, q: qDebounced })}`),
    placeholderData: keepPreviousData,
  });
  const d = t.data;
  if (t.isError) return <QueryError error={t.error} onRetry={() => t.refetch()} what="this table" />;
  if (!d) return <p className="p-4 text-[13px] text-muted">Reading table…</p>;

  const isDE = looksLikeDE(d.columns);
  const view = mode ?? (isDE ? "de" : "table");
  const switcher = isDE && (
    <div className="flex w-fit rounded-md border border-line p-0.5 text-[13px]" role="group" aria-label="View">
      {([["de", "Differential expression"], ["table", "Table & plots"]] as const).map(([k, l]) => (
        <button key={k} onClick={() => setMode(k)} aria-pressed={view === k}
          className={cn("rounded px-3 py-1", view === k ? "bg-raised text-text" : "text-muted hover:text-text")}>{l}</button>
      ))}
    </div>
  );
  if (view === "de") return <div className="space-y-4">{switcher}<DEView path={path} projects={projects} defaultProject={project} /></div>;
  const toggleSort = (col: string) => setSort((s) => (s?.col === col ? (s.desc ? null : { col, desc: true }) : { col, desc: false }));
  return (
    <div className="space-y-4">
      {switcher}
      <PlotPanel path={path} columns={d.columns} />
      <div className="rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <span className="text-[13px] font-medium tabular-nums">{d.total.toLocaleString()} rows</span>
          <Badge>{d.format}</Badge>
          <span className="text-xs text-muted">{d.columns.length} columns</span>
          {d.truncated && <Badge tone="wait">first {d.rows_loaded.toLocaleString()} rows loaded</Badge>}
          <div className="relative ml-auto w-56">
            <Search className="absolute left-2 top-2.5 size-3.5 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter rows" className="h-8 pl-7" aria-label="Filter rows" />
          </div>
        </div>
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 z-[1] bg-raised">
              <tr>
                {d.columns.map((c) => (
                  <th key={c.name} className={cn("whitespace-nowrap border-b border-line px-2.5 py-1.5 font-medium", c.type === "number" ? "text-right" : "text-left")}>
                    <button onClick={() => toggleSort(c.name)} className="inline-flex items-center gap-1 hover:text-accent" title={colTitle(c)}>
                      {c.name}
                      {sort?.col === c.name && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={cn(t.isFetching && "opacity-60")}>
              {d.rows.map((r, i) => (
                <tr key={d.offset + i} className="border-b border-line/50 hover:bg-raised/50">
                  {d.columns.map((c, k) => (
                    <td key={k} className={cn("max-w-[28rem] truncate px-2.5 py-1", c.type === "number" && "text-right font-mono tabular-nums")} title={r[k]}>{r[k] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {d.rows.length === 0 && <p className="p-6 text-center text-[13px] text-muted">No rows match.</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-3 py-2 text-xs text-muted">
          <span className="tabular-nums">{d.total ? `${(offset + 1).toLocaleString()}–${Math.min(offset + PAGE, d.total).toLocaleString()} of ${d.total.toLocaleString()}` : "0"}</span>
          <Button size="icon" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} aria-label="Previous page"><ChevronLeft /></Button>
          <Button size="icon" variant="ghost" disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)} aria-label="Next page"><ChevronRight /></Button>
        </div>
      </div>
      {d.comments.length > 0 && (
        <details className="text-xs text-muted"><summary className="cursor-pointer">{d.comments.length} header/comment lines</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-raised p-2 font-mono">{d.comments.join("")}</pre></details>
      )}
    </div>
  );
}

function colTitle(c: Column) {
  if (c.type === "number") return `number · min ${fmt(c.min ?? NaN)} · max ${fmt(c.max ?? NaN)} · mean ${fmt(c.mean ?? NaN)}${c.missing ? ` · ${c.missing} missing` : ""}`;
  return `text · ${c.distinct} distinct${c.missing ? ` · ${c.missing} empty` : ""}`;
}

/** Sensible first plot for common genomics tables. */
function suggest(cols: Column[]): { mode: "scatter" | "hist"; x: string; y: string; tx: Transform; ty: Transform } | null {
  const num = cols.filter((c) => c.type === "number").map((c) => c.name);
  if (!num.length) return null;
  const has = (n: string) => num.find((c) => c.toLowerCase() === n.toLowerCase());
  const fc = has("log2FoldChange") ?? has("logFC");
  const p = has("padj") ?? has("FDR") ?? has("adj.P.Val") ?? has("pvalue") ?? has("P.Value");
  if (fc && p) return { mode: "scatter", x: fc, y: p, tx: "none", ty: "neglog10" }; // volcano
  const mean = has("baseMean") ?? has("AveExpr") ?? has("logCPM");
  if (fc && mean) return { mode: "scatter", x: mean, y: fc, tx: has("baseMean") ? "log10" : "none", ty: "none" }; // MA
  if (has("signal_value") && has("q_value")) return { mode: "scatter", x: "signal_value", y: "q_value", tx: "log10", ty: "none" }; // peaks
  if (num.length >= 2) return { mode: "scatter", x: num[0], y: num[1], tx: "none", ty: "none" };
  return { mode: "hist", x: num[0], y: num[0], tx: "none", ty: "none" };
}

function PlotPanel({ path, columns }: { path: string; columns: Column[] }) {
  const numeric = columns.filter((c) => c.type === "number");
  const init = useMemo(() => suggest(columns), [columns]);
  const [s, setS] = useState(init);
  useEffect(() => setS(init), [init, path]);
  const [open, setOpen] = useState(true);
  const [trim, setTrim] = useState(false);
  const [bins, setBins] = useState(40);
  const cols = s ? (s.mode === "scatter" ? [s.x, s.y] : [s.x]) : [];
  const v = useQuery({
    queryKey: ["explore-cols", path, cols.join(",")],
    queryFn: () => api.get<{ n: number; returned: number; sampled: boolean; values: Record<string, number[]> }>(`/api/explore/columns${qs({ path, cols: cols.join(",") })}`),
    enabled: open && !!s && cols.every((c) => numeric.some((n) => n.name === c)),
  });
  const data = useMemo(() => {
    if (!v.data || !s) return null;
    const xs: number[] = [], ys: number[] = [];
    let dropped = 0;
    const X = v.data.values[s.x], Y = v.data.values[s.mode === "scatter" ? s.y : s.x];
    for (let i = 0; i < X.length; i++) {
      const a = applyTransform(X[i], s.tx), b = s.mode === "scatter" ? applyTransform(Y[i], s.ty) : 0;
      if (a === null || b === null) { dropped++; continue; }
      xs.push(a); ys.push(b);
    }
    let trimmed = 0;
    if (trim && xs.length > 20) { // keep the central 99% on each axis so a few extreme values do not flatten the plot
      const bounds = (a: number[]) => { const o = [...a].sort((p, q) => p - q); return [o[Math.floor(o.length * 0.005)], o[Math.ceil(o.length * 0.995) - 1]]; };
      const [x0, x1] = bounds(xs);
      const [y0, y1] = s.mode === "scatter" ? bounds(ys) : [-Infinity, Infinity];
      const kx: number[] = [], ky: number[] = [];
      xs.forEach((x, i) => { if (x >= x0 && x <= x1 && ys[i] >= y0 && ys[i] <= y1) { kx.push(x); ky.push(ys[i]); } else trimmed++; });
      return { xs: kx, ys: ky, dropped, trimmed };
    }
    return { xs, ys, dropped, trimmed };
  }, [v.data, s, trim]);
  if (!s || !numeric.length) return null;
  const lab = (c: string, t: Transform) => (t === "none" ? c : t === "log10" ? `log10(${c})` : `−log10(${c})`);

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[12.5px]">
        <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="Plot type">
          <button onClick={() => { setS({ ...s, mode: "scatter" }); setOpen(true); }} className={cn("flex items-center gap-1 rounded px-2 py-1", s.mode === "scatter" && open ? "bg-raised text-text" : "text-muted")} aria-pressed={s.mode === "scatter"}><ScatterChart className="size-3.5" />Scatter</button>
          <button onClick={() => { setS({ ...s, mode: "hist" }); setOpen(true); }} className={cn("flex items-center gap-1 rounded px-2 py-1", s.mode === "hist" && open ? "bg-raised text-text" : "text-muted")} aria-pressed={s.mode === "hist"}><BarChart3 className="size-3.5" />Histogram</button>
        </div>
        <AxisPick label={s.mode === "scatter" ? "X" : "Column"} cols={numeric} value={s.x} t={s.tx} onChange={(x, tx) => setS({ ...s, x, tx })} />
        {s.mode === "scatter" && <AxisPick label="Y" cols={numeric} value={s.y} t={s.ty} onChange={(y, ty) => setS({ ...s, y, ty })} />}
        {s.mode === "hist" && (
          <Select aria-label="Number of bins" className="h-8 w-28" value={bins} onChange={(e) => setBins(Number(e.target.value))}>
            {[20, 40, 80, 160].map((b) => <option key={b} value={b}>{b} bins</option>)}
          </Select>
        )}
        <label className="flex items-center gap-1.5 text-muted"><input type="checkbox" className="accent-[rgb(var(--accent))]" checked={trim} onChange={(e) => setTrim(e.target.checked)} />Trim outliers</label>
        <button onClick={() => setOpen((o) => !o)} className="ml-auto text-xs text-muted hover:text-text">{open ? "Hide plot" : "Show plot"}</button>
      </div>
      {open && (
        <div className="p-3">
          {v.isError ? <p className="text-[13px] text-bad">{errMsg(v.error)}</p>
            : !data ? <p className="py-16 text-center text-[13px] text-muted">Loading values…</p>
            : data.xs.length === 0 ? <p className="py-16 text-center text-[13px] text-muted">No plottable values{data.dropped ? ` (${data.dropped} values ≤ 0 cannot be log-transformed)` : ""}.</p>
            : s.mode === "scatter" ? <DensityScatter x={data.xs} y={data.ys} xLabel={lab(s.x, s.tx)} yLabel={lab(s.y, s.ty)} />
            : <Histogram values={data.xs} label={lab(s.x, s.tx)} bins={bins} />}
          {v.data && (v.data.sampled || data?.dropped || data?.trimmed) ? (
            <p className="mt-1 pl-16 text-[11.5px] text-muted">
              {v.data.sampled && `Showing ${v.data.returned.toLocaleString()} of ${v.data.n.toLocaleString()} rows, evenly thinned. `}
              {data?.dropped ? `${data.dropped.toLocaleString()} values ≤ 0 left out of the log scale. ` : ""}
              {data?.trimmed ? `${data.trimmed.toLocaleString()} outliers outside the central 99% hidden.` : ""}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function AxisPick({ label, cols, value, t, onChange }: { label: string; cols: Column[]; value: string; t: Transform; onChange: (c: string, t: Transform) => void }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted">{label}</span>
      <Select aria-label={`${label} column`} className="h-8 w-44" value={value} onChange={(e) => onChange(e.target.value, t)}>
        {cols.map((c) => <option key={c.name}>{c.name}</option>)}
      </Select>
      <Select aria-label={`${label} scale`} className="h-8 w-24" value={t} onChange={(e) => onChange(value, e.target.value as Transform)}>
        {(Object.keys(TRANSFORM_LABEL) as Transform[]).map((k) => <option key={k} value={k}>{TRANSFORM_LABEL[k]}</option>)}
      </Select>
    </span>
  );
}
