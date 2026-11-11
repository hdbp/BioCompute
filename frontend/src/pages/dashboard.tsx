import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, Boxes, CircleAlert, Cpu, FlaskConical, Info, Laptop, MemoryStick, Plus, Server } from "lucide-react";
import { api } from "@/lib/api";
import { ago, bytes, cn } from "@/lib/utils";
import type { RunStatus } from "@/lib/types";
import { PageHeader, Stat } from "@/components/page";
import { Badge, Empty, Meter, Panel, PanelHeader, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { CoreLattice, LatticeLegend } from "@/components/lattice";
import { RunStatusBadge } from "@/components/status";
import { GettingStarted } from "@/components/getting-started";

interface TopoNode {
  id: string; hostname: string; state: string; site: string | null; is_controller: boolean; os: string | null; arch: string | null;
  cpus: number | null; utilization: { cpu_percent?: number; mem_percent?: number; power?: { has_battery?: boolean } }; eligible: boolean; sources: string[];
}
interface Dashboard {
  nodes: { discovered: number; eligible_candidates: number; enrolled: number; online: number; eligible_now: number };
  resources: { cpu_total: number; cpu_allocatable: number; mem_total: number; mem_available: number; mem_allocatable: number; gpus: number };
  runs: { active: number; queued: number; completed: number; failed: number; cancelled: number };
  active_runs: { id: string; name: string; status: RunStatus; engine: string; progress: { total?: number; done?: number; failed?: number }; processes: Record<string, { submitted: number; completed: number; cached: number; failed: number }>; started_at: string | null }[];
  recent_runs: { id: string; name: string; status: RunStatus; created_at: string; finished_at: string | null }[];
  topology: TopoNode[];
  history: { ts: string; cpu: number; mem: number }[];
  alerts: { level: "info" | "warning" | "error"; title: string; message: string; run_id?: string }[];
  counts: { pipelines: number; templates: number; experiments: number };
  engine: { nextflow: { available: boolean; version?: string; detail?: string }; bcflow: boolean };
}

interface NodeAlloc { id: string; allocation: { max_cpus: number; enabled: boolean } | null }

export default function DashboardPage() {
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Dashboard>("/api/dashboard"), refetchInterval: 10000 });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => api.get<NodeAlloc[]>("/api/nodes"), refetchInterval: 30000 });
  const d = q.data;
  const alloc = new Map((nodes.data ?? []).map((n) => [n.id, n.allocation]));

  return (
    <>
      <PageHeader title="Cluster overview"
        description="Live state of your computers, analyses and alerts. Every number here comes from the controller; nothing is simulated."
        actions={<>
          <Button asChild variant="secondary"><Link to="/experiments"><FlaskConical />New experiment</Link></Button>
          <Button asChild variant="primary"><Link to="/jobs/new"><Plus />Launch analysis</Link></Button>
        </>} />
      <GettingStarted />

      {q.isLoading && <Skeleton className="h-72" />}
      {d && (
        <div className="space-y-5">
          {/* Topology: the core lattice of every machine, grouped by site */}
          <Panel>
            <PanelHeader title="Computing nodes"
              description={`${d.nodes.online} online of ${d.nodes.enrolled} enrolled, ${d.nodes.discovered} known devices. Each well is one CPU core.`}
              actions={<Button asChild size="sm" variant="ghost"><Link to="/nodes">Manage nodes</Link></Button>} />
            <Topology nodes={d.topology} alloc={alloc} />
            <div className="border-t border-line px-4 py-2.5"><LatticeLegend /></div>
          </Panel>

          <div className="grid gap-5 lg:grid-cols-3">
            <Panel className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
              <Stat label="Allocatable CPU cores" value={d.resources.cpu_allocatable} sub={`of ${d.resources.cpu_total} on online nodes`} />
              <Stat label="Allocatable memory" value={bytes(d.resources.mem_allocatable, 0)} sub={`${bytes(d.resources.mem_available, 0)} free of ${bytes(d.resources.mem_total, 0)}`} />
              <Stat label="GPUs" value={d.resources.gpus} sub={d.resources.gpus ? "detected on online nodes" : "none detected"} />
              <Stat label="Eligible right now" value={`${d.nodes.eligible_now} node${d.nodes.eligible_now === 1 ? "" : "s"}`} sub="policy, hours and power permitting" />
              <div className="col-span-2 space-y-1.5">
                <div className="flex justify-between text-xs text-muted"><span>Cores allocated to BioCompute</span><span className="tabular-nums">{Math.round((d.resources.cpu_allocatable / (d.resources.cpu_total || 1)) * 100)}%</span></div>
                <Meter value={d.resources.cpu_allocatable} max={d.resources.cpu_total} />
              </div>
            </Panel>
            <Panel className="p-4">
              <div className="grid grid-cols-4 gap-3">
                <RunCount label="Running" n={d.runs.active} tone="text-run" to="/jobs?status=running" />
                <RunCount label="Queued" n={d.runs.queued} tone="text-wait" to="/jobs?status=queued" />
                <RunCount label="Completed" n={d.runs.completed} tone="text-ok" to="/jobs?status=completed" />
                <RunCount label="Failed" n={d.runs.failed} tone="text-bad" to="/jobs?status=failed" />
              </div>
              <div className="mt-4 border-t border-line pt-3 space-y-1.5 text-[13px]">
                <EngineLine ok={d.engine.nextflow.available} label="Nextflow" detail={d.engine.nextflow.available ? `version ${d.engine.nextflow.version}` : "not installed on the controller"} />
                <EngineLine ok={d.engine.bcflow} label="BioCompute native engine" detail={d.engine.bcflow ? "enabled (local execution)" : "disabled"} />
                <p className="pt-1 text-xs text-muted">
                  <Link className="hover:text-text" to="/pipelines">{d.counts.pipelines} installed pipelines</Link>, {d.counts.templates} catalog templates, <Link className="hover:text-text" to="/experiments">{d.counts.experiments} experiments</Link>
                </p>
              </div>
            </Panel>
            <Panel>
              <PanelHeader title="Alerts" />
              <div className="max-h-56 overflow-y-auto divide-y divide-line/60">
                {d.alerts.length === 0 && <p className="px-4 py-6 text-[13px] text-muted">No alerts. Everything is running normally.</p>}
                {d.alerts.map((a, i) => (
                  <div key={i} className="flex gap-2.5 px-4 py-2.5">
                    {a.level === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" /> : a.level === "warning" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-wait" /> : <Info className="mt-0.5 size-4 shrink-0 text-muted" />}
                    <div className="min-w-0 text-[13px]">
                      <p className="font-medium">{a.run_id ? <Link to={`/runs/${a.run_id}`} className="hover:underline">{a.title}</Link> : a.title}</p>
                      <p className="text-muted line-clamp-2 break-words">{a.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          <div className="grid gap-5 lg:grid-cols-5">
            <Panel className="lg:col-span-3">
              <PanelHeader title="Utilization" description="Average CPU and memory across reporting nodes, 5-minute buckets, last 6 hours" />
              <div className="h-56 px-2 py-3">
                {d.history.length < 2
                  ? <Empty title="Collecting samples" className="py-10">The controller records utilization every 30 seconds; the chart fills in after a few minutes.</Empty>
                  : (
                    <ResponsiveContainer>
                      <AreaChart data={d.history} margin={{ left: -18, right: 12, top: 6 }}>
                        <defs>
                          <linearGradient id="gcpu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgb(var(--accent))" stopOpacity={0.35} /><stop offset="1" stopColor="rgb(var(--accent))" stopOpacity={0} /></linearGradient>
                          <linearGradient id="gmem" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgb(var(--run))" stopOpacity={0.25} /><stop offset="1" stopColor="rgb(var(--run))" stopOpacity={0} /></linearGradient>
                        </defs>
                        <CartesianGrid stroke="rgb(var(--line))" strokeDasharray="2 4" vertical={false} />
                        <XAxis dataKey="ts" tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={40} />
                        <YAxis domain={[0, 100]} unit="%" tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} axisLine={false} tickLine={false} />
                        <Tooltip contentStyle={{ background: "rgb(var(--raised))", border: "1px solid rgb(var(--line))", borderRadius: 8, fontSize: 12 }}
                          labelFormatter={(t) => new Date(t).toLocaleString()} formatter={(v: number, n) => [`${v}%`, n === "cpu" ? "CPU" : "Memory"]} />
                        <Area type="monotone" dataKey="cpu" stroke="rgb(var(--accent))" strokeWidth={1.75} fill="url(#gcpu)" />
                        <Area type="monotone" dataKey="mem" stroke="rgb(var(--run))" strokeWidth={1.75} fill="url(#gmem)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
              </div>
            </Panel>
            <Panel className="lg:col-span-2">
              <PanelHeader title="Workflow progress" actions={<Button asChild size="sm" variant="ghost"><Link to="/jobs">All jobs</Link></Button>} />
              <div className="divide-y divide-line/60">
                {d.active_runs.length === 0 && (
                  <Empty icon={<Boxes />} title="No analyses running" className="py-8"
                    action={<Button asChild size="sm" variant="primary"><Link to="/jobs/new">Launch analysis</Link></Button>}>
                    Recently finished runs are listed below.
                  </Empty>
                )}
                {d.active_runs.map((r) => {
                  const pct = r.progress.total ? Math.round(((r.progress.done ?? 0) / r.progress.total) * 100) : 0;
                  return (
                    <Link key={r.id} to={`/runs/${r.id}`} className="block px-4 py-3 hover:bg-raised/50">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-[13.5px]">{r.name}</span>
                        <RunStatusBadge status={r.status} />
                      </div>
                      <div className="mt-2 flex items-center gap-3">
                        <Meter value={pct} tone="run" className="flex-1" />
                        <span className="text-xs text-muted tabular-nums w-24 text-right">{r.progress.done ?? 0}/{r.progress.total ?? 0} tasks</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {Object.entries(r.processes).slice(0, 6).map(([p, c]) => (
                          <span key={p} className={cn("rounded px-1.5 py-px text-[11px] border border-line", c.failed ? "text-bad" : c.completed + c.cached === c.submitted ? "text-ok" : "text-muted")}>{p} {c.completed + c.cached}/{c.submitted}</span>
                        ))}
                      </div>
                    </Link>
                  );
                })}
                {d.recent_runs.filter((r) => !d.active_runs.some((a) => a.id === r.id)).slice(0, 5).map((r) => (
                  <Link key={r.id} to={`/runs/${r.id}`} className="flex items-center justify-between gap-2 px-4 py-2 text-[13px] hover:bg-raised/50">
                    <span className="truncate">{r.name}</span>
                    <span className="flex items-center gap-2 shrink-0"><span className="text-xs text-muted">{ago(r.finished_at ?? r.created_at)}</span><RunStatusBadge status={r.status} /></span>
                  </Link>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}

function RunCount({ label, n, tone, to }: { label: string; n: number; tone: string; to: string }) {
  return (
    <Link to={to} className="rounded-md p-1.5 -m-1.5 hover:bg-raised/60">
      <p className={cn("text-2xl font-semibold tabular-nums", n ? tone : "text-muted")}>{n}</p>
      <p className="text-xs text-muted">{label}</p>
    </Link>
  );
}

function EngineLine({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("size-2 rounded-full", ok ? "bg-ok" : "bg-wait")} />
      <span className="font-medium">{label}</span>
      <span className="text-muted truncate">{detail}</span>
    </div>
  );
}

function Topology({ nodes, alloc }: { nodes: TopoNode[]; alloc: Map<string, { max_cpus: number; enabled: boolean } | null> }) {
  const participating = nodes.filter((n) => !["discovered", "candidate"].includes(n.state));
  const pending = nodes.length - participating.length;
  const sites = new Map<string, TopoNode[]>();
  for (const n of participating) {
    const s = n.site ?? "unassigned";
    sites.set(s, [...(sites.get(s) ?? []), n]);
  }
  const ordered = [...sites.entries()].sort(([, a], [, b]) => Number(b.some((n) => n.is_controller)) - Number(a.some((n) => n.is_controller)));
  if (!participating.length) {
    return <Empty icon={<Server />} title="No enrolled nodes yet" action={<Button asChild size="sm" variant="primary"><Link to="/nodes">Discover computers</Link></Button>}>Run discovery, then authorize and enroll machines.</Empty>;
  }
  return (
    <div className="flex flex-wrap gap-4 p-4">
      {ordered.map(([site, list]) => (
        <div key={site} className="min-w-0 flex-1 basis-80 rounded-lg border border-dashed border-line/80 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted">
            <span className="font-medium text-text text-[13px]">{site}</span>
            <span>{list.length} node{list.length === 1 ? "" : "s"}</span>
            {list.some((n) => n.is_controller) && <Badge tone="accent" className="ml-auto">Controller site, holds raw data</Badge>}
          </div>
          <div className="flex flex-wrap gap-3">
            {list.map((n) => {
              const a = alloc.get(n.id);
              const laptop = n.utilization?.power?.has_battery;
              return (
                <Link to="/nodes" key={n.id} className={cn("rounded-md border bg-ink/40 p-3 hover:border-muted/60 transition-colors", n.is_controller ? "border-accent/50" : "border-line")}>
                  <div className="mb-2 flex items-center gap-2">
                    {laptop ? <Laptop className="size-4 text-muted" /> : <Server className={cn("size-4", n.is_controller ? "text-accent" : "text-muted")} />}
                    <span className="font-medium text-[13px]">{n.hostname}</span>
                    <span className={cn("size-1.5 rounded-full", n.state === "active" || n.is_controller ? (n.eligible ? "bg-ok" : "bg-wait") : "bg-muted")} title={n.eligible ? "eligible for work" : "not eligible right now"} />
                  </div>
                  <CoreLattice total={n.cpus ?? 1} allocated={a?.enabled ? a.max_cpus : 0} busyPercent={n.utilization?.cpu_percent} size="sm" />
                  <div className="mt-2 flex gap-3 text-[11px] text-muted tabular-nums">
                    <span className="inline-flex items-center gap-1"><Cpu className="size-3" />{n.utilization?.cpu_percent?.toFixed(0) ?? "—"}%</span>
                    <span className="inline-flex items-center gap-1"><MemoryStick className="size-3" />{n.utilization?.mem_percent?.toFixed(0) ?? "—"}%</span>
                    <span>{n.os} {n.arch}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
      {pending > 0 && (
        <Link to="/nodes?filter=discovered" className="flex basis-48 flex-col justify-center rounded-lg border border-dashed border-line/80 p-3 text-[13px] text-muted hover:text-text">
          <span className="text-xl font-semibold text-text tabular-nums">{pending}</span>
          discovered device{pending === 1 ? "" : "s"} not authorized. Review on the Nodes page.
        </Link>
      )}
    </div>
  );
}
