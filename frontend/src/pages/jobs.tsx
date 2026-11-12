import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Ban, ChevronsUpDown, ListChecks, Plus, Search, X } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { Run, Task } from "@/lib/types";
import { cn, duration } from "@/lib/utils";
import { Ago, PageHeader, QueryError, usePageTitle } from "@/components/page";
import { Badge, Checkbox, Empty, Meter, Panel, PanelHeader, Skeleton, Tabs, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { RunStatusBadge, runStatusLabel } from "@/components/status";

const FILTERS = [
  { id: "", label: "All" },
  { id: "running,cancelling,preflight", label: "Running" },
  { id: "queued", label: "Queued" },
  { id: "completed", label: "Completed" },
  { id: "failed,lost", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
];
const TERMINAL = ["completed", "failed", "cancelled", "lost"];
const PAGE = 50;
const MAX = 1000;   // the most the server returns

type SortKey = "name" | "pipeline" | "status" | "started" | "duration";
const SORTS: SortKey[] = ["name", "pipeline", "status", "started", "duration"];
const ms = (t?: string | null) => (t ? new Date(t.endsWith("Z") || t.includes("+") ? t : t + "Z").getTime() : null);
const elapsed = (r: Run) => { const a = ms(r.started_at); return a == null ? null : (ms(r.finished_at) ?? Date.now()) - a; };
const sortValue = (r: Run, k: SortKey): string | number | null =>
  k === "name" ? r.name.toLowerCase() : k === "pipeline" ? (r.pipeline_name ?? "").toLowerCase() : k === "status" ? runStatusLabel(r.status)
    : k === "started" ? ms(r.created_at) : elapsed(r);

export default function JobsPage() {
  usePageTitle("Runs");
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const mayRun = can(user, "scientist");
  // every filter lives in the address, so Back from a run returns to the same list
  const [sp, setSp] = useSearchParams();
  const raw = sp.get("status") ?? "";
  const status = FILTERS.find((f) => f.id.split(",")[0] === raw.split(",")[0])?.id ?? "";
  const q = sp.get("q") ?? "";
  const mine = sp.get("mine") === "1";
  const sort: SortKey = SORTS.includes(sp.get("sort") as SortKey) ? (sp.get("sort") as SortKey) : "started";
  const dir: "asc" | "desc" = sp.get("dir") === "asc" || sp.get("dir") === "desc" ? (sp.get("dir") as "asc" | "desc") : sort === "started" ? "desc" : "asc";
  const show = Math.max(PAGE, Number(sp.get("show")) || PAGE);
  const patch = (o: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    Object.entries(o).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setSp(next, { replace: true });
  };
  const filter = (o: Record<string, string | null>) => patch({ ...o, show: null });   // a new filter starts at the top again
  const [picked, setPicked] = useState<string[]>([]);

  // live updates arrive over the app's event stream (it invalidates ["runs"]); polling is only a fallback
  const runs = useQuery({ queryKey: ["runs", status], queryFn: () => api.get<Run[]>(`/api/runs${qs({ status, limit: MAX })}`), refetchInterval: 30_000, placeholderData: keepPreviousData });
  const tasks = useQuery({ queryKey: ["runs", "jobs"], queryFn: () => api.get<(Task & { run_id: string; run_name: string })[]>("/api/jobs"), refetchInterval: 30_000 });
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (runs.data ?? []).filter((r) => (!mine || r.created_by === user?.username)
      && (!needle || [r.name, r.pipeline_name, r.experiment_name, r.created_by].some((s) => s?.toLowerCase().includes(needle))));
    const sign = dir === "asc" ? 1 : -1;
    return list.slice().sort((a, b) => {
      const x = sortValue(a, sort), y = sortValue(b, sort);
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;   // runs without a value go last
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sign;
    });
  }, [runs.data, q, mine, user?.username, sort, dir]);
  const page = items.slice(0, show);
  const activeTasks = (tasks.data ?? []).filter((t) => !["COMPLETED", "CACHED"].includes((t.status ?? "").toUpperCase()));
  const filtered = !!q.trim() || mine || !!status;

  const cancellable = page.filter((r) => !TERMINAL.includes(r.status) && r.status !== "cancelling");
  const selected = cancellable.filter((r) => picked.includes(r.id));
  const allPicked = cancellable.length > 0 && selected.length === cancellable.length;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const cancel = useMutation({
    mutationFn: async (list: Run[]) => {
      const res = await Promise.allSettled(list.map((r) => api.post(`/api/runs/${r.id}/cancel`)));
      return { ok: res.filter((x) => x.status === "fulfilled").length, failed: res.flatMap((x, i) => (x.status === "rejected" ? [`${list[i].name}: ${errMsg(x.reason)}`] : [])) };
    },
    onSuccess: ({ ok, failed }) => {
      if (ok) toast.success(`Cancellation requested for ${ok} run${ok === 1 ? "" : "s"}`);
      if (failed.length) toast.error(`${failed.length} run${failed.length === 1 ? "" : "s"} could not be cancelled`, { description: failed.slice(0, 3).join("; "), duration: 15000 });
      setPicked([]);
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const cancelSelected = async () => {
    const others = selected.filter((r) => r.created_by && r.created_by !== user?.username).length;
    const ok = await confirmDialog({
      title: `Cancel ${selected.length} run${selected.length === 1 ? "" : "s"}?`,
      body: <>
        <p>The steps that are still running are stopped. Results written so far stay in the output folder, and a cancelled run can be resumed later.</p>
        <p className="mt-2 text-muted">{selected.slice(0, 6).map((r) => r.name).join(", ")}{selected.length > 6 ? ` and ${selected.length - 6} more` : ""}</p>
        {others > 0 && <p className="mt-2 text-wait">{others} of them {others === 1 ? "was" : "were"} started by someone else.</p>}
      </>,
      confirmLabel: selected.length === 1 ? "Cancel run" : `Cancel ${selected.length} runs`, cancelLabel: "Keep running", danger: true,
    });
    if (ok) cancel.mutate(selected);
  };

  const th = (k: SortKey, label: string, className?: string) => (
    <th key={k} className={cn("font-medium", className)} aria-sort={sort === k ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={cn("inline-flex items-center gap-1 hover:text-text", sort === k && "text-text")} title="Sort by this column"
        onClick={() => patch({ sort: k, dir: sort === k ? (dir === "asc" ? "desc" : "asc") : k === "started" || k === "duration" ? "desc" : "asc" })}>
        {label}{sort === k ? (dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ChevronsUpDown className="size-3 opacity-50" />}
      </button>
    </th>
  );

  return (
    <>
      <PageHeader title="Runs" description="Every run of a pipeline, with its progress and status. Open a run for its log, steps and results."
        actions={mayRun && <Button asChild variant="primary"><Link to="/jobs/new"><Plus />New run</Link></Button>} />
      {activeTasks.length > 0 && (
        <Panel className="mb-5">
          <PanelHeader title="Steps running now" description={`${activeTasks.length} step${activeTasks.length === 1 ? "" : "s"} submitted or running in the active runs`} />
          <div className="max-h-56 overflow-y-auto">
            <table className="w-full text-[13px]">
              <tbody>
                {activeTasks.slice(0, 50).map((t) => (
                  <tr key={t.run_id + t.hash} className="border-b border-line/50 last:border-0">
                    <td className="px-4 py-1.5 font-mono text-[11.5px] text-muted w-24">{t.hash}</td>
                    <td className="py-1.5 font-medium">{t.process}{t.tag ? <span className="text-muted font-normal"> ({t.tag})</span> : ""}</td>
                    <td className="py-1.5"><Link to={`/runs/${t.run_id}`} className="text-muted hover:text-text">{t.run_name}</Link></td>
                    <td className="py-1.5 pr-4 text-right"><Badge tone={t.status === "FAILED" ? "bad" : "run"}>{t.status === "SUBMITTED" ? "running" : t.status.toLowerCase()}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Tabs value={status} onValueChange={(v) => filter({ status: v.split(",")[0] || null })}>
          <TabsList>{FILTERS.map((f) => <TabsTrigger key={f.id} value={f.id}>{f.label}</TabsTrigger>)}</TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted">
            <Checkbox checked={mine} onCheckedChange={(v) => filter({ mine: v ? "1" : null })} />Mine only
          </label>
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
            <Input value={q} onChange={(e) => filter({ q: e.target.value || null })} placeholder="Search by run, pipeline, experiment or person" className="pl-8 pr-7" aria-label="Search runs" />
            {q && <button type="button" onClick={() => filter({ q: null })} aria-label="Clear search" className="absolute right-2 top-2.5 text-muted hover:text-text"><X className="size-4" /></button>}
          </div>
        </div>
      </div>
      {selected.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2 text-[13px]" role="status">
          <span className="font-medium">{selected.length} run{selected.length === 1 ? "" : "s"} selected</span>
          <Button size="sm" variant="danger" loading={cancel.isPending} onClick={cancelSelected}><Ban />Cancel selected</Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked([])}>Clear selection</Button>
        </div>
      )}
      {runs.isError && !runs.data && <QueryError error={runs.error} what="the runs" onRetry={() => runs.refetch()} />}
      {runs.isError && runs.data && <p className="mb-3 text-[13px] text-wait" role="status">The list could not be refreshed ({errMsg(runs.error)}). It shows the last known state. <button type="button" className="text-accent hover:underline" onClick={() => runs.refetch()}>Try again</button></p>}
      {!(runs.isError && !runs.data) && (
        <Panel className="overflow-x-auto">
          {runs.isLoading && <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>}
          {runs.data && items.length === 0 && (
            filtered && (runs.data.length > 0 || !!status)
              ? (
                <Empty icon={<ListChecks />} title="No runs match these filters" action={<Button variant="secondary" onClick={() => setSp({}, { replace: true })}>Show all runs</Button>}>
                  {[status && `status "${FILTERS.find((f) => f.id === status)?.label}"`, mine && "started by you", q.trim() && `containing "${q.trim()}"`].filter(Boolean).join(", ")}
                </Empty>
              ) : (
                <Empty icon={<ListChecks />} title="No runs yet"
                  action={mayRun && <Button asChild variant="primary"><Link to="/jobs/new">Start your first run</Link></Button>}>
                  Runs you start appear here with live progress, logs and results.
                </Empty>
              )
          )}
          {items.length > 0 && (
            <table className={cn("w-full min-w-[900px] text-[13px] transition-opacity", runs.isPlaceholderData && "opacity-60")}>
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  {mayRun && (
                    <th className="w-10 pl-4">
                      {cancellable.length > 0 && <Checkbox checked={allPicked} aria-label="Select all runs that can be cancelled"
                        onCheckedChange={() => setPicked(allPicked ? [] : cancellable.map((r) => r.id))} />}
                    </th>
                  )}
                  {th("name", "Run", cn("py-2.5", mayRun ? "pl-1 pr-4" : "px-4"))}{th("pipeline", "Pipeline")}<th className="font-medium">Experiment</th>
                  <th className="font-medium w-48">Progress</th>{th("status", "Status")}{th("duration", "Duration")}{th("started", "Started", "px-4 text-right")}
                </tr>
              </thead>
              <tbody>
                {page.map((r) => {
                  const total = r.progress.total ?? 0;
                  const done = r.progress.done ?? 0;
                  const canPick = cancellable.some((c) => c.id === r.id);
                  return (
                    <tr key={r.id} className={cn("border-b border-line/50 last:border-0 hover:bg-raised/40", picked.includes(r.id) && canPick && "bg-accent/5")}>
                      {mayRun && <td className="pl-4">{canPick && <Checkbox checked={picked.includes(r.id)} onCheckedChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} />}</td>}
                      <td className={cn("py-2.5", mayRun ? "pl-1 pr-4" : "px-4")}><Link to={`/runs/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                        <span className="block text-xs text-muted">{r.engine === "bcflow" ? "native engine" : r.engine === "nextflow" ? "Nextflow" : r.engine}{r.attempt > 1 ? `, attempt ${r.attempt}` : ""}{r.created_by ? `, by ${r.created_by === user?.username ? "you" : r.created_by}` : ""}</span></td>
                      <td className="text-muted">{r.pipeline_name} <span className="font-mono text-[11px]">{r.pipeline_version}</span></td>
                      <td className="text-muted">{r.experiment_name ?? "—"}</td>
                      <td><div className="flex items-center gap-2 pr-4" title={`${done} of ${total} steps finished`}><Meter value={done} max={total || 1} tone={r.status === "failed" || r.status === "lost" ? "bad" : r.status === "completed" ? "ok" : "run"} /><span className="text-xs text-muted tabular-nums w-12">{done}/{total}</span></div></td>
                      <td><RunStatusBadge status={r.status} /></td>
                      <td className="text-muted tabular-nums">{r.started_at ? duration(r.started_at, r.finished_at) : "—"}</td>
                      <td className="px-4 text-right text-muted"><Ago ts={r.created_at} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {items.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-muted">
              <span>
                Showing {page.length} of {items.length} run{items.length === 1 ? "" : "s"}
                {runs.data && items.length < runs.data.length ? ` (${runs.data.length} before search)` : ""}
                {runs.data && runs.data.length >= MAX ? `. Only the ${MAX} most recent runs are listed.` : ""}
              </span>
              {items.length > page.length && (
                <span className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => patch({ show: String(show + PAGE) })}>Show {Math.min(PAGE, items.length - page.length)} more</Button>
                  {items.length - page.length > PAGE && <Button size="sm" variant="ghost" onClick={() => patch({ show: String(items.length) })}>Show all</Button>}
                </span>
              )}
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
