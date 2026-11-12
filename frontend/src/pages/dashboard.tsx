import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, ArrowRight, Boxes, CircleAlert, Cpu, FlaskConical, Info, Laptop, ListChecks, MemoryStick, Play, Plus, Server } from "lucide-react";
import { api } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import { bytes, cn } from "@/lib/utils";
import type { Experiment, Run, RunStatus } from "@/lib/types";
import { Ago, PageHeader, QueryError, Stat, usePageTitle } from "@/components/page";
import { Badge, Empty, Meter, Panel, PanelHeader, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { CoreLattice, LatticeLegend } from "@/components/lattice";
import { RunStatusBadge } from "@/components/status";
import { GettingStarted, useScientistChecklist } from "@/components/getting-started";

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
const ACTIVE = ["running", "cancelling", "queued", "preflight", "pending"];

/** Home: the signed-in person's own runs and experiments first, then the state of the computers (short for scientists, full for administrators). */
export default function DashboardPage() {
  usePageTitle("Home");
  const user = useAuth((s) => s.user);
  const admin = can(user, "admin");
  const mayRun = can(user, "scientist");
  // live events invalidate these queries (see the layout); the intervals are only a fallback
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Dashboard>("/api/dashboard"), refetchInterval: 60_000 });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => api.get<NodeAlloc[]>("/api/nodes"), refetchInterval: 60_000, enabled: admin });
  const runs = useQuery({ queryKey: ["runs", "home"], queryFn: () => api.get<Run[]>("/api/runs?limit=100"), refetchInterval: 60_000 });
  const experiments = useQuery({ queryKey: ["experiments"], queryFn: () => api.get<Experiment[]>("/api/experiments") });
  const d = q.data;
  const alloc = new Map((nodes.data ?? []).map((n) => [n.id, n.allocation]));
  const myRuns = (runs.data ?? []).filter((r) => r.created_by === user?.username);
  const myExperiments = (experiments.data ?? []).filter((e) => e.created_by === user?.username);
  const shownExperiments = (myExperiments.length ? myExperiments : experiments.data ?? []).slice(0, 6);
  const newcomer = !!runs.data && !!experiments.data && myRuns.length === 0;
  // a scientist who is new here already sees these three steps as the "Getting started" checklist
  const checklist = useScientistChecklist();
  const quickStart = mayRun && !checklist.visible && <QuickStart haveSamples={(experiments.data?.length ?? 0) > 0} haveRun={myRuns.length > 0} />;

  return (
    <>
      <PageHeader title="Home"
        description="Your runs and experiments first, then what the lab's computers are doing. Everything here is read live from the controller."
        actions={mayRun && <>
          <Button asChild variant="secondary"><Link to="/experiments"><FlaskConical />New experiment</Link></Button>
          <Button asChild variant="primary"><Link to="/jobs/new"><Plus />New run</Link></Button>
        </>} />
      <GettingStarted />
      {newcomer && quickStart}

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Your runs" description={myRuns.length ? "The most recent runs you started" : undefined}
            actions={<Button asChild size="sm" variant="ghost"><Link to={myRuns.length ? "/jobs?mine=1" : "/jobs"}>{myRuns.length ? "All your runs" : "All runs"}</Link></Button>} />
          {runs.isLoading && <div className="space-y-2 p-4">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>}
          {runs.isError && !runs.data && <div className="p-4"><QueryError error={runs.error} what="your runs" onRetry={() => runs.refetch()} /></div>}
          {runs.data && myRuns.length === 0 && (
            <Empty icon={<ListChecks />} title="You have not started a run yet" className="py-8"
              action={mayRun && <Button asChild size="sm" variant="primary"><Link to="/jobs/new">New run</Link></Button>}>
              {mayRun ? "Pick a pipeline and your samples; the run then appears here with its progress." : "Runs started by others in the lab are under Runs."}
            </Empty>
          )}
          <div className="divide-y divide-line/60">
            {myRuns.slice(0, 6).map((r) => {
              const active = ACTIVE.includes(r.status);
              const total = r.progress.total ?? 0, done = r.progress.done ?? 0;
              return (
                <Link key={r.id} to={`/runs/${r.id}`} className="block px-4 py-2.5 hover:bg-raised/50">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13.5px] font-medium">{r.name}</span>
                    <RunStatusBadge status={r.status} />
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-3 text-xs text-muted">
                    <span className="truncate">{r.pipeline_name} {r.pipeline_version}{r.experiment_name ? `, ${r.experiment_name}` : ""}</span>
                    <span className="shrink-0">{active ? "started " : ""}<Ago ts={active ? r.started_at ?? r.created_at : r.finished_at ?? r.created_at} /></span>
                  </div>
                  {active && total > 0 && (
                    <div className="mt-1.5 flex items-center gap-3">
                      <Meter value={done} max={total} tone="run" className="flex-1" />
                      <span className="w-24 text-right text-xs tabular-nums text-muted">{done}/{total} steps</span>
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </Panel>
        <Panel>
          <PanelHeader title={myExperiments.length || !experiments.data?.length ? "Your experiments" : "Experiments in the lab"}
            description={myExperiments.length ? "Sample tables you created, most recently changed first" : experiments.data?.length ? "You have not created one yet; these are the most recently changed" : undefined}
            actions={<Button asChild size="sm" variant="ghost"><Link to="/experiments">All experiments</Link></Button>} />
          {experiments.isLoading && <div className="space-y-2 p-4">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>}
          {experiments.isError && !experiments.data && <div className="p-4"><QueryError error={experiments.error} what="the experiments" onRetry={() => experiments.refetch()} /></div>}
          {experiments.data && shownExperiments.length === 0 && (
            <Empty icon={<FlaskConical />} title="No experiments yet" className="py-8"
              action={mayRun && <Button asChild size="sm" variant="primary"><Link to="/experiments">Add samples</Link></Button>}>
              An experiment is the table of your samples: their files, conditions and replicates.
            </Empty>
          )}
          <div className="divide-y divide-line/60">
            {shownExperiments.map((e) => (
              <div key={e.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-raised/50">
                <Link to={`/experiments/${e.id}`} className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{e.name}</span>
                  <span className="block truncate text-xs text-muted">{e.sample_count} sample{e.sample_count === 1 ? "" : "s"}, {e.assay}{e.created_by && e.created_by !== user?.username ? `, by ${e.created_by}` : ""}, changed <Ago ts={e.updated_at} /></span>
                </Link>
                {mayRun && e.sample_count > 0 && <Button asChild size="sm" variant="secondary" title="Start a run with these samples"><Link to={`/jobs/new?experiment=${e.id}`}><Play />Run</Link></Button>}
              </div>
            ))}
          </div>
        </Panel>
      </div>
      {!newcomer && quickStart}

      <h2 className="mb-3 mt-8 text-[15px] font-semibold">{admin ? "Cluster overview" : "The lab's computers"}</h2>
      {q.isLoading && <Skeleton className="h-72" />}
      {q.isError && !d && <QueryError error={q.error} what="the state of the computers" onRetry={() => q.refetch()} />}
      {d && !admin && (
        <div className="grid gap-5 lg:grid-cols-5">
          <Panel className="p-4 lg:col-span-3">
            <div className="grid grid-cols-4 gap-3">
              <RunCount label="Running" n={d.runs.active} tone="text-run" to="/jobs?status=running" />
              <RunCount label="Queued" n={d.runs.queued} tone="text-wait" to="/jobs?status=queued" />
              <RunCount label="Completed" n={d.runs.completed} tone="text-ok" to="/jobs?status=completed" />
              <RunCount label="Failed" n={d.runs.failed} tone="text-bad" to="/jobs?status=failed" />
            </div>
            <p className="mt-1 text-xs text-muted">Runs of everyone in the lab.</p>
            <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-[13px]">
              <EngineLine ok={d.nodes.eligible_now > 0} label={`${d.nodes.online} computer${d.nodes.online === 1 ? "" : "s"} online`}
                detail={d.nodes.eligible_now > 0 ? `${d.resources.cpu_allocatable} CPU cores and ${bytes(d.resources.mem_allocatable, 0)} of memory available for runs` : "none is accepting runs right now"} />
              {!d.engine.nextflow.available && <EngineLine ok={false} label="Nextflow" detail="not installed on the controller: Nextflow pipelines cannot be started" />}
            </div>
            <AlertList alerts={d.alerts.filter((a) => a.level !== "info")} className="mt-3 border-t border-line" compact />
          </Panel>
          <RunsInProgress d={d} mayRun={mayRun} className="lg:col-span-2" />
        </div>
      )}
      {d && admin && (
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
              <Stat label="CPU cores available for runs" value={d.resources.cpu_allocatable} sub={`of ${d.resources.cpu_total} on online nodes`} />
              <Stat label="Memory available for runs" value={bytes(d.resources.mem_allocatable, 0)} sub={`${bytes(d.resources.mem_available, 0)} free of ${bytes(d.resources.mem_total, 0)}`} />
              <Stat label="GPUs" value={d.resources.gpus} sub={d.resources.gpus ? "detected on online nodes" : "none detected"} />
              <Stat label="Accepting runs right now" value={`${d.nodes.eligible_now} node${d.nodes.eligible_now === 1 ? "" : "s"}`} sub="policy, hours and power permitting" />
              <div className="col-span-2 space-y-1.5">
                <div className="flex justify-between text-xs text-muted"><span>Share of cores given to BioCompute</span><span className="tabular-nums">{Math.round((d.resources.cpu_allocatable / (d.resources.cpu_total || 1)) * 100)}%</span></div>
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
                <EngineLine ok={d.engine.bcflow} label="BioCompute native engine" detail={d.engine.bcflow ? "enabled (runs on the controller)" : "switched off"} />
                <p className="pt-1 text-xs text-muted">
                  <Link className="hover:text-text" to="/pipelines">{d.counts.pipelines} installed pipelines</Link>, {d.counts.templates} catalog templates, <Link className="hover:text-text" to="/experiments">{d.counts.experiments} experiments</Link>
                </p>
              </div>
            </Panel>
            <Panel>
              <PanelHeader title="Alerts" />
              <AlertList alerts={d.alerts} className="max-h-56 overflow-y-auto" />
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
                          labelFormatter={(t) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} formatter={(v: number, n) => [`${v}%`, n === "cpu" ? "CPU" : "Memory"]} />
                        <Area type="monotone" dataKey="cpu" stroke="rgb(var(--accent))" strokeWidth={1.75} fill="url(#gcpu)" />
                        <Area type="monotone" dataKey="mem" stroke="rgb(var(--run))" strokeWidth={1.75} fill="url(#gmem)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
              </div>
            </Panel>
            <RunsInProgress d={d} mayRun={mayRun} className="lg:col-span-2" />
          </div>
        </div>
      )}
    </>
  );
}

/** The three things a scientist does, in order, each with its button. */
function QuickStart({ haveSamples, haveRun }: { haveSamples: boolean; haveRun: boolean }) {
  const steps = [
    { n: 1, title: "Add samples", text: "Describe your samples in an experiment: their FASTQ files, conditions and replicates.", to: "/experiments", action: haveSamples ? "Open experiments" : "Add samples", done: haveSamples },
    { n: 2, title: "Choose a pipeline", text: "Browse the installed pipelines, read what each one does and look at its parameters.", to: "/pipelines", action: "Choose a pipeline", done: false },
    { n: 3, title: "Run", text: "Combine pipeline and samples, check the parameters and start. Progress and results appear on this page.", to: "/jobs/new", action: "New run", done: haveRun },
  ];
  return (
    <Panel className="mb-5 p-4" role="region" aria-label="Quick start">
      <p className="mb-3 text-sm font-semibold">From samples to results in three steps</p>
      <ol className="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-stretch">
        {steps.map((s, i) => (
          <li key={s.n} className="contents">
            <div className="flex flex-col rounded-lg border border-line p-3">
              <p className="flex items-center gap-2 text-[13.5px] font-medium">
                <span className={cn("grid size-6 place-items-center rounded-full border text-xs font-semibold", s.done ? "border-ok/50 bg-ok/15 text-ok" : "border-line text-muted")}>{s.n}</span>{s.title}
              </p>
              <p className="mt-1 flex-1 text-[12.5px] text-muted">{s.text}</p>
              <Button asChild size="sm" variant={s.n === 3 ? "primary" : "secondary"} className="mt-2 self-start"><Link to={s.to}>{s.action}</Link></Button>
            </div>
            {i < steps.length - 1 && <ArrowRight className="hidden size-4 self-center text-muted md:block" aria-hidden />}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function AlertList({ alerts, className, compact }: { alerts: Dashboard["alerts"]; className?: string; compact?: boolean }) {
  if (compact && alerts.length === 0) return null;
  return (
    <div className={cn("divide-y divide-line/60", className)}>
      {alerts.length === 0 && <p className="px-4 py-6 text-[13px] text-muted">No alerts. Everything is running normally.</p>}
      {alerts.map((a, i) => (
        <div key={i} className={cn("flex gap-2.5 py-2.5", compact ? "px-0" : "px-4")}>
          {a.level === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" /> : a.level === "warning" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-wait" /> : <Info className="mt-0.5 size-4 shrink-0 text-muted" />}
          <div className="min-w-0 text-[13px]">
            <p className="font-medium">{a.run_id ? <Link to={`/runs/${a.run_id}`} className="hover:underline">{a.title}</Link> : a.title}</p>
            <p className="text-muted line-clamp-2 break-words">{a.message}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Every run that is going on in the lab right now, then the ones that finished last. */
function RunsInProgress({ d, mayRun, className }: { d: Dashboard; mayRun: boolean; className?: string }) {
  return (
    <Panel className={className}>
      <PanelHeader title="Runs in progress" description="Everyone's runs" actions={<Button asChild size="sm" variant="ghost"><Link to="/jobs">All runs</Link></Button>} />
      <div className="divide-y divide-line/60">
        {d.active_runs.length === 0 && (
          <Empty icon={<Boxes />} title="No runs in progress" className="py-8"
            action={mayRun && <Button asChild size="sm" variant="primary"><Link to="/jobs/new">New run</Link></Button>}>
            {d.recent_runs.length ? "The runs that finished last are listed below." : "The computers are free."}
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
                <span className="text-xs text-muted tabular-nums w-24 text-right">{r.progress.done ?? 0}/{r.progress.total ?? 0} steps</span>
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
            <span className="flex items-center gap-2 shrink-0"><Ago ts={r.finished_at ?? r.created_at} className="text-xs text-muted" /><RunStatusBadge status={r.status} /></span>
          </Link>
        ))}
      </div>
    </Panel>
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
                    <span className={cn("size-1.5 rounded-full", n.state === "active" || n.is_controller ? (n.eligible ? "bg-ok" : "bg-wait") : "bg-muted")} title={n.eligible ? "accepting runs" : "not accepting runs right now"} />
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
