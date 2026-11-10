import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function bytes(n?: number | null, digits = 1): string {
  if (n == null || isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
}

export function gb(n?: number | null): string {
  return n == null ? "—" : `${(n / 2 ** 30).toFixed(n / 2 ** 30 >= 100 ? 0 : 1)} GB`;
}

export function ago(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z");
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 0) return "just now";
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function when(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts.endsWith("Z") || ts.includes("+") ? ts : ts + "Z");
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function duration(a?: string | null, b?: string | null): string {
  if (!a) return "—";
  const p = (t: string) => new Date(t.endsWith("Z") || t.includes("+") ? t : t + "Z").getTime();
  const s = ((b ? p(b) : Date.now()) - p(a)) / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

export function download(filename: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
