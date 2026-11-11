import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/hooks/theme";

// ---------------------------------------------------------------- colour + scales
const VIRIDIS = ["#440154", "#472c7a", "#3b518b", "#2c718e", "#21908d", "#27ad81", "#5cc863", "#aadc32", "#fde725"].map((h) => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);

/** Viridis at t in [0,1]. */
export function viridis(t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - i;
  const c = VIRIDIS[i].map((v, k) => Math.round(v + (VIRIDIS[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** The part of the ramp that stays visible on each surface: the darkest purple vanishes on a dark panel, the lightest yellow on white. */
const RAMP = { dark: [0.22, 1], light: [0, 0.86] } as const;

export type Transform = "none" | "log10" | "neglog10";
export const TRANSFORM_LABEL: Record<Transform, string> = { none: "linear", log10: "log10", neglog10: "−log10" };

export function applyTransform(v: number, t: Transform): number | null {
  if (t === "none") return v;
  if (v <= 0) return null;
  const l = Math.log10(v);
  return t === "log10" ? l : -l;
}

function niceTicks(min: number, max: number, count = 6): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
  return Number(v.toPrecision(4)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function cssColor(name: string, alpha = 1) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).join(",");
  return `rgba(${v},${alpha})`;
}

export function useSize(ref: React.RefObject<HTMLElement>) {
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export const PAD = { l: 64, r: 16, t: 12, b: 44 };

export function setupCanvas(c: HTMLCanvasElement, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  c.width = w * dpr;
  c.height = h * dpr;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}

export function drawAxes(g: CanvasRenderingContext2D, w: number, h: number, xd: [number, number], yd: [number, number], xl: string, yl: string) {
  const sx = (v: number) => PAD.l + ((v - xd[0]) / (xd[1] - xd[0])) * (w - PAD.l - PAD.r);
  const sy = (v: number) => h - PAD.b - ((v - yd[0]) / (yd[1] - yd[0])) * (h - PAD.t - PAD.b);
  g.font = "11px ui-sans-serif, system-ui, sans-serif";
  g.lineWidth = 1;
  g.strokeStyle = cssColor("--line", 0.7);
  g.fillStyle = cssColor("--muted");
  g.textAlign = "center";
  g.textBaseline = "top";
  for (const t of niceTicks(xd[0], xd[1])) {
    const x = Math.round(sx(t)) + 0.5;
    g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, h - PAD.b); g.stroke();
    g.fillText(fmt(t), x, h - PAD.b + 6);
  }
  g.textAlign = "right";
  g.textBaseline = "middle";
  for (const t of niceTicks(yd[0], yd[1], 5)) {
    const y = Math.round(sy(t)) + 0.5;
    g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(w - PAD.r, y); g.stroke();
    g.fillText(fmt(t), PAD.l - 6, y);
  }
  g.fillStyle = cssColor("--text");
  g.font = "12px ui-sans-serif, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillText(xl, PAD.l + (w - PAD.l - PAD.r) / 2, h - 8);
  g.save();
  g.translate(14, PAD.t + (h - PAD.t - PAD.b) / 2);
  g.rotate(-Math.PI / 2);
  g.fillText(yl, 0, 0);
  g.restore();
  return { sx, sy };
}

export function extent(a: Float64Array, pad = 0.03): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) return [0, 1];
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

// ---------------------------------------------------------------- density scatter
interface Tip { left: number; top: number; text: string[] }

/**
 * Scatter plot whose points are coloured by local density (2-D binning, 3×3 smoothing, log scale),
 * densest points drawn last, so overplotting stays readable.
 */
export function DensityScatter({ x, y, xLabel, yLabel, height = 380 }: { x: number[]; y: number[]; xLabel: string; yLabel: string; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const w = useSize(wrap);
  const { theme } = useTheme();
  const [tip, setTip] = useState<Tip | null>(null);

  const prep = useMemo(() => {
    const n = Math.min(x.length, y.length);
    const xs = Float64Array.from(x.slice(0, n));
    const ys = Float64Array.from(y.slice(0, n));
    const xd = extent(xs), yd = extent(ys);
    let r = NaN;
    if (n > 2) {
      let mx = 0, my = 0;
      for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
      mx /= n; my /= n;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
      r = sxy / Math.sqrt(sxx * syy);
    }
    return { n, xs, ys, xd, yd, r };
  }, [x, y]);

  const layout = useRef<{ bins: Map<number, number[]>; dens: Float32Array; px: Float32Array; py: Float32Array; cell: number; maxD: number } | null>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const g = setupCanvas(c, w, height);
    const { n, xs, ys, xd, yd } = prep;
    const { sx, sy } = drawAxes(g, w, height, xd, yd, xLabel, yLabel);
    // 2-D histogram in screen space
    const cell = 4;
    const gw = Math.ceil(w / cell), gh = Math.ceil(height / cell);
    const grid = new Uint32Array(gw * gh);
    const px = new Float32Array(n), py = new Float32Array(n);
    const bins = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      px[i] = sx(xs[i]); py[i] = sy(ys[i]);
      const k = Math.floor(py[i] / cell) * gw + Math.floor(px[i] / cell);
      grid[k]++;
      const b = bins.get(k); if (b) b.push(i); else bins.set(k, [i]);
    }
    const dens = new Float32Array(n);
    let maxD = 1;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(px[i] / cell), cy = Math.floor(py[i] / cell);
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) s += grid[yy * gw + xx] * (dx === 0 && dy === 0 ? 1 : 0.5);
      }
      dens[i] = s;
      if (s > maxD) maxD = s;
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => dens[a] - dens[b]);
    const [lo, hi] = RAMP[theme];
    const lmax = Math.log1p(maxD);
    const r = n > 50_000 ? 1.2 : n > 5000 ? 1.8 : 2.6;
    g.save();
    g.beginPath(); g.rect(PAD.l, PAD.t, w - PAD.l - PAD.r, height - PAD.t - PAD.b); g.clip();
    for (const i of order) {
      g.fillStyle = viridis(lo + (hi - lo) * (Math.log1p(dens[i]) / lmax));
      g.fillRect(px[i] - r, py[i] - r, r * 2, r * 2);
    }
    g.restore();
    layout.current = { bins, dens, px, py, cell, maxD };
  }, [prep, w, height, theme, xLabel, yLabel]);

  const onMove = (e: React.MouseEvent) => {
    const L = layout.current;
    if (!L) return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const gw = Math.ceil(w / L.cell);
    let best = -1, bd = 64; // 8 px radius
    const cx = Math.floor(mx / L.cell), cy = Math.floor(my / L.cell);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      for (const i of L.bins.get((cy + dy) * gw + cx + dx) ?? []) {
        const d = (L.px[i] - mx) ** 2 + (L.py[i] - my) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    if (best < 0) { setTip(null); return; }
    setTip({ left: L.px[best], top: L.py[best], text: [`${xLabel}: ${fmt(prep.xs[best])}`, `${yLabel}: ${fmt(prep.ys[best])}`, `${Math.round(L.dens[best])} points nearby`] });
  };

  const [lo, hi] = RAMP[theme];
  return (
    <figure className="space-y-2">
      <div ref={wrap} className="relative w-full">
        <canvas ref={canvas} onMouseMove={onMove} onMouseLeave={() => setTip(null)} role="img"
          aria-label={`Density-coloured scatter plot of ${yLabel} against ${xLabel}, ${prep.n.toLocaleString()} points`} />
        {tip && (
          <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] shadow-lg"
            style={{ left: tip.left, top: tip.top }}>
            {tip.text.map((t) => <div key={t} className="whitespace-nowrap tabular-nums">{t}</div>)}
          </div>
        )}
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-16 text-[11.5px] text-muted">
        <span className="tabular-nums">{prep.n.toLocaleString()} points</span>
        {Number.isFinite(prep.r) && <span className="tabular-nums">Pearson r = {prep.r.toFixed(3)}</span>}
        <span className="flex items-center gap-1.5">
          Density (log)
          <span className="inline-block h-2 w-24 rounded-sm" style={{ background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => viridis(lo + (hi - lo) * t)).join(",")})` }} />
          <span>low → high</span>
        </span>
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------- histogram
export function Histogram({ values, label, bins: nb = 40, height = 300 }: { values: number[]; label: string; bins?: number; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const w = useSize(wrap);
  const { theme } = useTheme();
  const [tip, setTip] = useState<Tip | null>(null);
  const h = useMemo(() => {
    const a = Float64Array.from(values);
    const [lo, hi] = extent(a, 0);
    const width = (hi - lo) / nb;
    const counts = new Array(nb).fill(0);
    for (const v of a) counts[Math.min(nb - 1, Math.floor((v - lo) / width))]++;
    let mean = 0;
    for (const v of a) mean += v;
    mean /= a.length || 1;
    const sorted = Array.from(a).sort((p, q) => p - q);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
    return { lo, hi, width, counts, max: Math.max(1, ...counts), n: a.length, mean, median };
  }, [values, nb]);

  const geo = useRef<{ x0: number; bw: number; sy: (v: number) => number } | null>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const g = setupCanvas(c, w, height);
    const { sx, sy } = drawAxes(g, w, height, [h.lo, h.hi], [0, h.max * 1.05], label, "count");
    const bw = sx(h.lo + h.width) - sx(h.lo);
    g.fillStyle = viridis(theme === "dark" ? 0.55 : 0.4); // one hue: a histogram is a single series
    h.counts.forEach((cnt, i) => {
      if (!cnt) return;
      const x = sx(h.lo + i * h.width) + 1, top = sy(cnt), base = sy(0);
      const ww = Math.max(1, bw - 2); // 2 px gap between bars
      g.beginPath();
      g.roundRect(x, top, ww, base - top, [Math.min(4, ww / 2), Math.min(4, ww / 2), 0, 0]);
      g.fill();
    });
    geo.current = { x0: sx(h.lo), bw, sy };
  }, [h, w, height, theme, label]);

  const onMove = (e: React.MouseEvent) => {
    const G = geo.current;
    if (!G) return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - G.x0) / G.bw);
    if (i < 0 || i >= h.counts.length) { setTip(null); return; }
    const a = h.lo + i * h.width;
    setTip({ left: G.x0 + (i + 0.5) * G.bw, top: G.sy(h.counts[i]), text: [`${fmt(a)} – ${fmt(a + h.width)}`, `${h.counts[i].toLocaleString()} values`] });
  };

  return (
    <figure className="space-y-2">
      <div ref={wrap} className="relative w-full">
        <canvas ref={canvas} onMouseMove={onMove} onMouseLeave={() => setTip(null)} role="img" aria-label={`Histogram of ${label}, ${h.n.toLocaleString()} values`} />
        {tip && (
          <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+8px)] rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] shadow-lg"
            style={{ left: tip.left, top: tip.top }}>
            {tip.text.map((t) => <div key={t} className="whitespace-nowrap tabular-nums">{t}</div>)}
          </div>
        )}
      </div>
      <figcaption className="flex gap-4 pl-16 text-[11.5px] text-muted tabular-nums">
        <span>{h.n.toLocaleString()} values</span><span>mean {fmt(h.mean)}</span><span>median {fmt(h.median)}</span>
      </figcaption>
    </figure>
  );
}
