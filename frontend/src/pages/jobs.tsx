import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ListChecks, Plus, Search } from "lucide-react";
import { api, qs } from "@/lib/api";
import type { Run, Task } from "@/lib/types";
import { ago, duration } from "@/lib/utils";
import { PageHeader } from "@/components/page";
import { Badge, Empty, Meter, Panel, PanelHeader, Skeleton, Tabs, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RunStatusBadge } from "@/components/status";

const FILTERS = [
  { id: "", label: "All" },
  { id: "running,cancelling,preflight", label: "Running" },
  { id: "queued", label: "Queued" },
  { id: "completed", label: "Completed" },
  { id: "failed,lost", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
];

export default function JobsPage() {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get("status") ?? "";
  const status = FILTERS.find((f) => f.id.split(",")[0] === raw.split(",")[0])?.id ?? "";
  const [q, setQ] = useState("");
  const runs = useQuery({ queryKey: ["runs", status], queryFn: () => api.get<Run[]>(`/api/runs${qs({ status })}`), refetchInterval: 5000 });
  const tasks = useQuery({ queryKey: ["runs", "jobs"], queryFn: () => api.get<(Task & { run_id: string; run_name: string })[]>("/api/jobs"), refetchInterval: 4000 });
  const items = useMemo(() => (runs.data ?? []).filter((r) => !q || [r.name, r.pipeline_name, r.experiment_name, r.created_by].some((s) => s?.toLowerCase().includes(q.toLowerCase()))), [runs.data, q]);
  const activeTasks = (tasks.data ?? []).filter((t) => !["COMPLETED", "CACHED"].includes((t.status ?? "").toUpperCase()));

  return (
    <>
      <PageHeader title="Jobs" description="Pipeline runs and the individual tasks they execute. Status comes from the engine's trace and log files."
        actions={<Button asChild variant="primary"><Link to="/jobs/new"><Plus />Launch analysis</Link></Button>} />
      {activeTasks.length > 0 && (
        <Panel className="mb-5">
          <PanelHeader title="Active tasks" description={`${activeTasks.length} task${activeTasks.length === 1 ? "" : "s"} submitted or running across active runs`} />
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
        <Tabs value={status} onValueChange={(v) => setSp(v ? { status: v } : {})}>
          <TabsList>{FILTERS.map((f) => <TabsTrigger key={f.id} value={f.id}>{f.label}</TabsTrigger>)}</TabsList>
        </Tabs>
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search runs" className="pl-8" aria-label="Search runs" />
        </div>
      </div>
      <Panel className="overflow-x-auto">
        {runs.isLoading && <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>}
        {runs.data && items.length === 0 && (
          <Empty icon={<ListChecks />} title={status ? "No runs with this status" : "No runs yet"}
            action={<Button asChild variant="primary"><Link to="/jobs/new">Launch your first analysis</Link></Button>}>
            Runs you launch appear here with live progress, logs and outputs.
          </Empty>
        )}
        {items.length > 0 && (
          <table className="w-full min-w-[900px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2.5 font-medium">Run</th><th className="font-medium">Pipeline</th><th className="font-medium">Experiment</th>
                <th className="font-medium w-48">Progress</th><th className="font-medium">Status</th><th className="font-medium">Duration</th><th className="px-4 font-medium text-right">Started</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const total = r.progress.total ?? 0;
                const done = r.progress.done ?? 0;
                return (
                  <tr key={r.id} className="border-b border-line/50 last:border-0 hover:bg-raised/40">
                    <td className="px-4 py-2.5"><Link to={`/runs/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                      <span className="block text-xs text-muted">{r.engine === "bcflow" ? "native engine" : r.engine}{r.attempt > 1 ? `, attempt ${r.attempt}` : ""}{r.created_by ? `, by ${r.created_by}` : ""}</span></td>
                    <td className="text-muted">{r.pipeline_name} <span className="font-mono text-[11px]">{r.pipeline_version}</span></td>
                    <td className="text-muted">{r.experiment_name ?? "—"}</td>
                    <td><div className="flex items-center gap-2 pr-4"><Meter value={done} max={total || 1} tone={r.status === "failed" ? "bad" : r.status === "completed" ? "ok" : "run"} /><span className="text-xs text-muted tabular-nums w-12">{done}/{total}</span></div></td>
                    <td><RunStatusBadge status={r.status} /></td>
                    <td className="text-muted tabular-nums">{r.started_at ? duration(r.started_at, r.finished_at) : "—"}</td>
                    <td className="px-4 text-right text-muted">{ago(r.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
