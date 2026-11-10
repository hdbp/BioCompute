import * as React from "react";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, actions, children, className }: {
  title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode; className?: string;
}) {
  return (
    <header className={cn("mb-6", className)}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-tight">{title}</h1>
          {description && <p className="mt-1 text-[13.5px] text-muted max-w-3xl">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function Stat({ label, value, sub, className }: { label: string; value: React.ReactNode; sub?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-xs text-muted">{label}</p>
      <p className="text-xl font-semibold tabular-nums mt-0.5">{value}</p>
      {sub && <p className="text-xs text-muted mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

export function KV({ k, v, mono }: { k: React.ReactNode; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-3 py-1.5 text-[13px] border-b border-line/60 last:border-0">
      <dt className="w-36 shrink-0 text-muted">{k}</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono text-[12px]")}>{v ?? "—"}</dd>
    </div>
  );
}

export function IssueList({ issues, className }: { issues: { level: string; message: string; sample?: string | null }[]; className?: string }) {
  if (!issues.length) return null;
  const tone = (l: string) => (l === "error" ? "text-bad" : l === "warning" ? "text-wait" : "text-muted");
  return (
    <ul className={cn("space-y-1 text-[13px]", className)}>
      {issues.map((i, k) => (
        <li key={k} className="flex gap-2">
          <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full bg-current", tone(i.level))} />
          <span><span className={cn("font-medium", tone(i.level))}>{i.sample ? `${i.sample}: ` : ""}</span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}
