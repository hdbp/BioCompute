import * as React from "react";
import { Link } from "react-router-dom";
import { create } from "zustand";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { errMsg } from "@/lib/api";
import { ago, cn, when } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------- page title and breadcrumbs
export interface Crumb { label: string; to?: string }
export const usePageMeta = create<{ title: string; crumbs: Crumb[]; set: (title: string, crumbs: Crumb[]) => void }>((set) => ({
  title: "", crumbs: [], set: (title, crumbs) => set({ title, crumbs }),
}));

/** Sets the browser tab title and the breadcrumb in the top bar: usePageTitle("My run", [{ label: "Runs", to: "/jobs" }]). */
export function usePageTitle(title: string | null | undefined, crumbs: Crumb[] = []) {
  const key = JSON.stringify(crumbs);
  React.useEffect(() => {
    if (!title) return;
    usePageMeta.getState().set(title, crumbs);
    document.title = `${title} · BioCompute`;
    return () => { document.title = "BioCompute"; usePageMeta.getState().set("", []); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, key]);
}

export function Breadcrumbs() {
  const { title, crumbs } = usePageMeta();
  if (!title) return null;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px]">
      {crumbs.map((c) => (
        <React.Fragment key={c.label}>
          {c.to ? <Link to={c.to} className="shrink-0 text-muted hover:text-text">{c.label}</Link> : <span className="shrink-0 text-muted">{c.label}</span>}
          <span className="text-muted/60" aria-hidden>/</span>
        </React.Fragment>
      ))}
      <span className="truncate font-medium" aria-current="page">{title}</span>
    </nav>
  );
}

// ---------------------------------------------------------------------------- errors
/** A request failed: say what happened and offer to try again (instead of a blank page). */
export function QueryError({ error, onRetry, what = "this page", className }: { error: unknown; onRetry?: () => void; what?: string; className?: string }) {
  return (
    <div role="alert" className={cn("rounded-lg border border-bad/40 bg-bad/5 p-4 text-[13.5px]", className)}>
      <p className="flex items-center gap-2 font-medium text-bad"><AlertTriangle className="size-4" />Could not load {what}</p>
      <p className="mt-1 text-muted">{errMsg(error)}</p>
      {onRetry && <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}><RefreshCw />Try again</Button>}
    </div>
  );
}

/** Catches a crash while rendering a page, so the navigation stays usable. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey?: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-6">
        <div role="alert" className="mx-auto max-w-xl rounded-lg border border-bad/40 bg-bad/5 p-5 text-[13.5px]">
          <p className="flex items-center gap-2 font-medium text-bad"><AlertTriangle className="size-4" />This page stopped working</p>
          <p className="mt-1 text-muted">{this.state.error.message || "An unexpected error occurred."} Your data is not affected.</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => this.setState({ error: null })}><RefreshCw />Try again</Button>
            <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>Reload the app</Button>
          </div>
        </div>
      </div>
    );
  }
}

/** Relative time with the exact time on hover. */
export function Ago({ ts, className }: { ts?: string | null; className?: string }) {
  if (!ts) return <span className={className}>—</span>;
  return <time className={className} dateTime={ts} title={when(ts)}>{ago(ts)}</time>;
}

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
