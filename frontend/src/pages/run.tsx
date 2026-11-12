import { memo, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDownToLine, ArrowLeft, Ban, CheckCircle2, CircleAlert, FileText, FolderOpen, RotateCw, SlidersHorizontal, Telescope } from "lucide-react";
import { api, ApiError, authed, errMsg, qs, ensureMediaCookie } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import { setLaunchPrefill } from "@/lib/handoff";
import type { FormSchema, ProcessProgress, RunDetail, Task } from "@/lib/types";
import { bytes, cn, duration, when } from "@/lib/utils";
import { Ago, KV, PageHeader, QueryError, usePageTitle } from "@/components/page";
import { Badge, Empty, Meter, Panel, PanelHeader, Skeleton, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { humanLabel, isChanged } from "@/components/schema-form";
import { RunStatusBadge } from "@/components/status";

const TERMINAL = ["completed", "failed", "cancelled", "lost"];
const isFailedTask = (t: Task) => ["FAILED", "ABORTED"].includes((t.status ?? "").toUpperCase());
const exploreUrl = (vpath: string) => `/explore${qs({ dir: vpath })}`;
const engineName = (e: string) => (e === "bcflow" ? "BioCompute native engine" : e === "nextflow" ? "Nextflow" : e);
interface Check { name: string; ok: boolean; detail: string; level: string }

/** What a step's exit code usually means, in plain words. */
function exitHint(code?: string | null): string | null {
  const n = Number(code);
  if (code == null || code === "" || code === "-" || Number.isNaN(n)) return null;
  if (n === 137) return "stopped by the system, usually because it ran out of memory";
  if (n === 143 || n === 140) return "stopped from outside: a time limit, or the run was cancelled";
  if (n === 127) return "a command was not found: a tool is not installed or not on the PATH";
  if (n === 126) return "a command could not be executed (permissions)";
  if (n === 139) return "the tool crashed (segmentation fault)";
  if (n === 130) return "interrupted";
  if (n === 1 || n === 2) return "the tool reported an error; its message is in the log";
  return null;
}

export default function RunPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const run = useQuery({ queryKey: ["run", id], queryFn: () => api.get<RunDetail>(`/api/runs/${id}`), refetchInterval: (q) => (q.state.data && TERMINAL.includes(q.state.data.status) ? false : 3000) });
  const r = run.data;
  usePageTitle(r?.name ?? (run.isLoading ? null : "Run"), [{ label: "Runs", to: "/jobs" }]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["run", id] }); qc.invalidateQueries({ queryKey: ["runs"] }); };
  const cancel = useMutation({ mutationFn: () => api.post(`/api/runs/${id}/cancel`), onSuccess: () => { toast.success("Cancellation requested"); refresh(); }, onError: (e) => toast.error(errMsg(e)) });
  const resume = useMutation({ mutationFn: () => api.post(`/api/runs/${id}/resume`), onSuccess: () => { toast.success("Resumed; finished steps are reused, not repeated"); refresh(); }, onError: (e) => toast.error(errMsg(e)) });
  const [tab, setTab] = useState("log");

  const back = <Button asChild variant="secondary"><Link to="/jobs"><ArrowLeft />Back to Runs</Link></Button>;
  if (run.isLoading) return <Skeleton className="h-96" />;
  if (!r) {
    // only a 404 means the run does not exist; anything else (server down, no permission) is said as it is, with a retry
    if (run.error instanceof ApiError && run.error.status === 404) {
      return <Empty title="Run not found" action={back}>There is no run with this address. It may have been deleted, or the link is incomplete.</Empty>;
    }
    return (
      <div className="mx-auto max-w-xl space-y-4 py-8">
        <QueryError error={run.error} what="this run" onRetry={() => run.refetch()} />
        {back}
      </div>
    );
  }
  const active = !TERMINAL.includes(r.status);
  const failed = r.status === "failed" || r.status === "lost";
  const procs = Object.entries(r.progress.processes ?? {});
  const pct = r.progress.total ? Math.round(((r.progress.done ?? 0) / r.progress.total) * 100) : r.status === "completed" ? 100 : 0;
  const preflight = r.events.find((e) => e.kind === "preflight");
  const checks = ((preflight?.data.checks as Check[] | undefined) ?? []);
  const mayAct = can(user, "scientist") && r.can_edit !== false;  // whoever started it, or an administrator
  const askCancel = async () => {
    if (await confirmDialog({ title: `Cancel ${r.name}?`, body: "The steps that are still running are stopped. Results written so far stay in the output folder, and the run can be resumed later.", confirmLabel: "Cancel run", cancelLabel: "Keep running", danger: true })) cancel.mutate();
  };
  // open the New run form with this run's pipeline, version, samples and parameters filled in
  const runAgain = () => {
    const { input: _input, outdir: _outdir, ...params } = r.params;   // samples and output folder are chosen again on the form
    setLaunchPrefill({ pipeline_id: r.pipeline_id, version_id: r.pipeline_version_id, params, from: `run "${r.name}"` });
    nav(`/jobs/new${qs({ pipeline: r.pipeline_id, version: r.pipeline_version_id, experiment: r.experiment_id })}`);
  };
  const showLog = () => { setTab("log"); requestAnimationFrame(() => document.getElementById("run-log")?.scrollIntoView({ behavior: "smooth", block: "start" })); };

  return (
    <>
      <PageHeader title={<span className="flex flex-wrap items-center gap-3">{r.name}<RunStatusBadge status={r.status} /></span>}
        description={<>
          <Link className="hover:text-text" to={`/pipelines/${r.pipeline_id}`}>{r.pipeline_name} {r.pipeline_version}</Link>
          {r.experiment_name && <>{" on "}<Link className="hover:text-text" to={`/experiments/${r.experiment_id}`}>{r.experiment_name}</Link></>}
          {`, ${engineName(r.engine)}`}{r.attempt > 1 ? `, attempt ${r.attempt}` : ""}
        </>}
        actions={<>
          {mayAct && active && <Button variant="danger" loading={cancel.isPending} onClick={askCancel}><Ban />Cancel</Button>}
          {mayAct && !active && r.status !== "completed" && <Button variant="primary" loading={resume.isPending} onClick={() => resume.mutate()} title="Continue from the steps that already finished"><RotateCw />Resume</Button>}
          {mayAct && !active && r.status === "completed" && <Button variant="secondary" loading={resume.isPending} onClick={() => resume.mutate()} title="Finished steps are reused from the cache; only what changed is computed again"><RotateCw />Run again</Button>}
          {mayAct && !active && !failed && <Button variant="secondary" onClick={runAgain}><SlidersHorizontal />Change parameters and run again</Button>}
          {!active && r.output_vpath && <Button asChild variant="secondary" title={r.status === "completed" ? undefined : "Results written before the run stopped"}><Link to={exploreUrl(r.output_vpath)}><Telescope />Open in Data Explorer</Link></Button>}
          {!active && <Button asChild variant={r.status === "completed" ? "primary" : "secondary"}><Link to={`/results/${r.id}`}><FolderOpen />{r.status === "completed" ? "Open results" : "Open partial results"}</Link></Button>}
        </>} />
      {run.isError && <p className="mb-4 text-[13px] text-wait" role="status">This page could not be refreshed ({errMsg(run.error)}); it shows the last known state. <button type="button" className="text-accent hover:underline" onClick={() => run.refetch()}>Try again</button></p>}

      {failed && <FailurePanel r={r} checks={checks} mayAct={mayAct} resuming={resume.isPending} onResume={() => resume.mutate()} onRunAgain={runAgain} onShowLog={showLog} />}

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-5">
          <Panel className="p-4">
            <div className="flex items-baseline justify-between">
              <p className="text-[13.5px] font-medium">{r.progress.done ?? 0} of {r.progress.total ?? 0} steps finished{r.progress.failed ? `, ${r.progress.failed} failed` : ""}</p>
              <p className="text-xs text-muted tabular-nums">{r.started_at ? `${duration(r.started_at, r.finished_at)} elapsed` : "not started"}</p>
            </div>
            <Meter value={pct} tone={failed ? "bad" : r.status === "completed" ? "ok" : "run"} className="mt-2 h-2" />
            {procs.length > 0 && (
              <div className="mt-4 space-y-2">
                {procs.map(([name, p]) => <ProcessRow key={name} name={name} p={p} />)}
              </div>
            )}
            {procs.length === 0 && active && <p className="mt-3 text-[13px] text-muted">Waiting for the first step to start.</p>}
          </Panel>
          {r.error && !failed && (
            <Panel className="border-bad/40">
              <PanelHeader title={<span className="text-bad">Error</span>} description={r.exit_code != null ? `The engine ended with exit code ${r.exit_code}` : undefined} />
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-4 font-mono text-[12px] leading-relaxed">{r.error}</pre>
            </Panel>
          )}
          <Tabs value={tab} onValueChange={setTab} id="run-log" className="scroll-mt-20">
            <TabsList>
              <TabsTrigger value="log">Log</TabsTrigger>
              <TabsTrigger value="tasks">Steps <span className="ml-1 text-xs text-muted">{r.progress.tasks?.length ?? 0}</span></TabsTrigger>
              <TabsTrigger value="params">Parameters</TabsTrigger>
              <TabsTrigger value="provenance">Provenance</TabsTrigger>
            </TabsList>
            <TabsContent value="log" className="mt-3"><LiveLog runId={r.id} active={active} engine={r.engine} /></TabsContent>
            <TabsContent value="tasks" className="mt-3">
              <Panel className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-[13px]">
                  <thead><tr className="border-b border-line text-left text-xs text-muted"><th className="px-4 py-2 font-medium" title="The engine's identifier of this step run">ID</th><th className="font-medium">Step</th><th className="font-medium">Status</th><th className="font-medium">Exit code</th><th className="font-medium">Duration</th><th className="px-4 font-medium">Peak memory</th></tr></thead>
                  <tbody>
                    {(r.progress.tasks ?? []).map((t) => (
                      <tr key={t.hash} className="border-b border-line/50 last:border-0" title={t.workdir ? `Working folder: ${t.workdir}` : undefined}>
                        <td className="px-4 py-1.5 font-mono text-[11.5px] text-muted">{t.hash}</td>
                        <td className="py-1.5">{t.process}{t.tag ? <span className="text-muted"> ({t.tag})</span> : ""}</td>
                        <td><Badge tone={t.status === "COMPLETED" ? "ok" : t.status === "CACHED" ? "accent" : isFailedTask(t) ? "bad" : "run"} title={t.status === "CACHED" ? "Reused from an earlier attempt, not computed again" : undefined}>{t.status === "SUBMITTED" ? "running" : t.status === "CACHED" ? "reused" : t.status?.toLowerCase()}</Badge></td>
                        <td className="tabular-nums" title={exitHint(t.exit) ?? undefined}>{t.exit ?? "—"}</td>
                        <td className="tabular-nums text-muted">{t.realtime ?? t.duration ?? "—"}</td>
                        <td className="px-4 tabular-nums text-muted">{t.peak_rss || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!r.progress.tasks?.length && <p className="p-4 text-[13px] text-muted">No steps recorded yet.</p>}
              </Panel>
            </TabsContent>
            <TabsContent value="params" className="mt-3">
              <Panel className="p-4">
                {Object.keys(r.params).length === 0 && <p className="text-[13px] text-muted">This run has no parameters.</p>}
                <dl>{Object.entries(r.params).map(([k, v]) => <KV key={k} k={<span className="font-mono text-[12px]" title={humanLabel(k)}>{k}</span>} v={typeof v === "object" ? JSON.stringify(v) : String(v)} mono />)}</dl>
              </Panel>
            </TabsContent>
            <TabsContent value="provenance" className="mt-3"><Provenance r={r} /></TabsContent>
          </Tabs>
        </div>
        <aside className="space-y-5">
          <Panel className="p-4">
            <dl>
              <KV k="Run ID" v={r.id} mono />
              <KV k="Created" v={`${when(r.created_at)} by ${r.created_by ?? "?"}`} />
              <KV k="Started" v={when(r.started_at)} />
              <KV k="Finished" v={when(r.finished_at)} />
              <KV k="Runs on" v={((r.placement.selected as string[]) ?? []).join(", ")} />
              <KV k="Scheduling" v={<span title={`Executor: ${String(r.resources.executor ?? "local")}`}>{r.resources.executor === "condor" ? "Cluster scheduler (HTCondor)" : "Directly on the controller"}</span>} />
              <KV k="Limits" v={`${r.resources.max_cpus ?? "?"} cores, ${r.resources.max_memory_gb ?? "?"} GB`} />
              {r.resources.profile ? <KV k="Tools from" v={<span title="Nextflow -profile">{String(r.resources.profile)}</span>} /> : null}
              <KV k="Output folder" mono v={r.output_vpath
                ? <Link to={exploreUrl(r.output_vpath)} className="hover:text-accent hover:underline" title="Open in Data Explorer">{r.output_vpath}</Link>
                : r.output_dir} />
              <KV k={<span title="Where the engine keeps the intermediate files of every step">Work folder</span>} v={r.work_dir} mono />
            </dl>
          </Panel>
          <Panel>
            <PanelHeader title="Run files" />
            <div className="p-2 grid grid-cols-2 gap-1">
              {["report.html", "timeline.html", "trace.txt", "params.json", "samplesheet.csv", "provenance.json", "command.json", "nextflow.log"]
                .filter((f) => r.engine === "nextflow" || !["report.html", "timeline.html", "nextflow.log"].includes(f))
                .map((f) => (
                  <a key={f} href={authed(`/api/runs/${r.id}/files/${f}`)} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[13px] text-muted hover:bg-raised hover:text-text">
                    <FileText className="size-3.5" />{f}
                  </a>
                ))}
            </div>
          </Panel>
          {preflight && (
            <Panel>
              <PanelHeader title="Checks before the start" description={checks.length ? `${checks.filter((c) => c.ok).length} of ${checks.length} passed` : preflight.message} />
              <ul className="p-3 space-y-1.5 text-[13px]">
                {checks.map((c) => (
                  <li key={c.name} className="flex gap-2">
                    {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <Ban className="mt-0.5 size-4 shrink-0 text-bad" />}
                    <span><span className="font-medium">{c.name}</span><span className="block text-xs text-muted break-all">{c.detail}</span></span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel>
            <PanelHeader title="Events" />
            <ol className="max-h-80 overflow-y-auto p-3 space-y-2">
              {r.events.slice().reverse().map((e) => (
                <li key={e.id} className="flex gap-2 text-[13px]">
                  <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", e.kind === "status" ? "bg-accent" : e.kind === "task" ? "bg-bad" : "bg-muted")} />
                  <span className="min-w-0"><span className="break-words">{e.message}</span><Ago ts={e.ts} className="block text-[11px] text-muted" /></span>
                </li>
              ))}
            </ol>
          </Panel>
        </aside>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------- failure
const lastLines = (text: string, n: number) => text.replace(/\s+$/, "").split("\n").slice(-n);

/** Shown first on a failed or lost run: what failed, the message, the end of the log, and what to do next. */
function FailurePanel({ r, checks, mayAct, resuming, onResume, onRunAgain, onShowLog }: {
  r: RunDetail; checks: Check[]; mayAct: boolean; resuming: boolean; onResume: () => void; onRunAgain: () => void; onShowLog: () => void;
}) {
  const failedTasks = (r.progress.tasks ?? []).filter(isFailedTask);
  // steps that failed according to the per-step counts but whose individual runs are no longer in the (capped) list
  const failedSteps = Object.entries(r.progress.processes ?? {}).filter(([name, p]) => p.failed > 0 && !failedTasks.some((t) => t.process === name));
  const failedChecks = checks.filter((c) => !c.ok && c.level !== "warning" && c.level !== "info");
  const tail = useQuery({
    queryKey: ["run", r.id, "log-tail"], staleTime: 60_000,
    queryFn: async () => {
      // the log endpoint reads forward from an offset: look up the size first, then read the end
      let part = await api.get<{ content: string; offset: number; size: number }>(`/api/runs/${r.id}/log?which=stdout`);
      if (part.size > part.offset) part = await api.get(`/api/runs/${r.id}/log${qs({ which: "stdout", offset: Math.max(0, part.size - 24_000) })}`);
      return lastLines(part.content, 30);
    },
  });
  const error = (r.error ?? "").trim();
  const tailText = (tail.data ?? []).join("\n").trim();
  const tailRepeatsError = !!error && !!tailText && (error === tailText || error.endsWith(tailText) || tailText.endsWith(error));
  const lost = r.status === "lost";
  const nothingNamed = failedTasks.length === 0 && failedSteps.length === 0 && failedChecks.length === 0;
  const nFailed = Math.max(failedTasks.length + failedSteps.reduce((n, [, p]) => n + p.failed, 0), r.progress.failed ?? 0);

  return (
    <Panel className="mb-5 border-bad/40" role="region" aria-label="Why this run stopped">
      <div className="flex items-start gap-3 px-4 pt-4">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-bad" />
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-bad">
            {lost ? "BioCompute lost track of this run"
              : failedTasks.length + failedSteps.length > 0 ? `This run failed in ${nFailed === 1 ? "one step" : `${nFailed} steps`}`
              : failedChecks.length ? "This run did not start: a check before the start failed" : "This run failed"}
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {lost ? "The process that supervises it disappeared, typically because the computer was restarted. Steps that had finished are kept, so Resume continues from there."
              : nothingNamed ? "No single step is recorded as failed, so the cause is in the message below."
              : `${r.progress.done ?? 0} of ${r.progress.total ?? 0} steps had finished and are kept. After fixing the cause, Resume repeats only what is missing.`}
            {r.exit_code != null && !lost ? ` The engine ended with exit code ${r.exit_code}.` : ""}
          </p>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        {failedChecks.length > 0 && (
          <div>
            <p className="mb-1.5 text-[13px] font-medium">Checks that failed</p>
            <ul className="space-y-1.5 text-[13px]">
              {failedChecks.map((c) => <li key={c.name} className="flex gap-2"><Ban className="mt-0.5 size-4 shrink-0 text-bad" /><span><span className="font-medium">{c.name}</span><span className="block break-all text-xs text-muted">{c.detail}</span></span></li>)}
            </ul>
          </div>
        )}
        {(failedTasks.length > 0 || failedSteps.length > 0) && (
          <div>
            <p className="mb-1.5 text-[13px] font-medium">What failed</p>
            <ul className="divide-y divide-line/60 rounded-md border border-line text-[13px]">
              {failedTasks.slice(0, 8).map((t) => {
                const hint = exitHint(t.exit);
                return (
                  <li key={t.hash} className="px-3 py-2">
                    <p>
                      <span className="font-mono text-[12.5px] font-medium">{t.process}</span>
                      {t.tag ? <> for sample <span className="font-medium">{t.tag}</span></> : null}
                      {t.exit != null && t.exit !== "" && t.exit !== "-" ? <span className="text-muted">, exit code {t.exit}</span> : null}
                    </p>
                    {hint && <p className="text-xs text-wait">Exit code {t.exit}: {hint}.</p>}
                    {t.workdir && <p className="mt-0.5 break-all font-mono text-[11.5px] text-muted" title="The step's working folder. Its .command.log and .command.err files hold the tool's own messages.">{t.workdir}</p>}
                  </li>
                );
              })}
              {failedSteps.map(([name, p]) => (
                <li key={name} className="px-3 py-2"><span className="font-mono text-[12.5px] font-medium">{name}</span><span className="text-muted">, failed for {p.failed} of {p.submitted} sample{p.submitted === 1 ? "" : "s"}</span></li>
              ))}
              {failedTasks.length > 8 && <li className="px-3 py-2 text-muted">and {failedTasks.length - 8} more: see the Steps tab below</li>}
            </ul>
          </div>
        )}
        {error && (
          <div>
            <p className="mb-1.5 text-[13px] font-medium">{tailRepeatsError ? "Message (the last lines of the log)" : lost ? "Message" : "Message from the engine"}</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink/60 p-3 font-mono text-[12px] leading-relaxed">{error}</pre>
          </div>
        )}
        {!tailRepeatsError && (
          <div>
            <p className="mb-1.5 flex items-center gap-2 text-[13px] font-medium">Last lines of the log
              <button type="button" className="text-xs font-normal text-accent hover:underline" onClick={onShowLog}>Show the whole log</button></p>
            {tail.isLoading ? <Skeleton className="h-24" />
              : tail.isError ? <p className="text-[13px] text-bad">The log could not be read: {errMsg(tail.error)} <button type="button" className="text-accent hover:underline" onClick={() => tail.refetch()}>Try again</button></p>
              : tailText ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-ink/60 p-3 font-mono text-[12px] leading-[1.6]">{tailText}</pre>
              : <p className="text-[13px] text-muted">The run wrote nothing to its log.</p>}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <span className="mr-1 text-[13px] text-muted">What next</span>
        {mayAct && <Button variant="primary" loading={resuming} onClick={onResume} title="Continue from the steps that already finished"><RotateCw />Resume</Button>}
        {mayAct && <Button variant="secondary" onClick={onRunAgain} title="Opens the New run form with this run's pipeline, samples and parameters"><SlidersHorizontal />Change parameters and run again</Button>}
        <Button asChild variant="secondary"><Link to={r.output_vpath ? exploreUrl(r.output_vpath) : `/results/${r.id}`}><FolderOpen />Open results folder</Link></Button>
        {!mayAct && <span className="text-xs text-muted">Your account can view runs but not restart them.</span>}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------- provenance
interface Prov {
  created_by?: string | null; created_at?: string; finished_at?: string; status?: string; exit_code?: number | null; params_sha256?: string;
  pipeline?: { name?: string; slug?: string; source?: string | null; version?: string; git_commit?: string | null; path?: string | null };
  engine?: { name?: string; version?: string | null };
  host?: { hostname?: string; os?: string; python?: string; cpus?: number };
  software?: Record<string, unknown>;
  references?: { param?: string; uri?: string; path?: string; genome?: string; genome_digest?: string; asset?: string; tag?: string; asset_digest?: string }[];
  experiment?: { id?: string; name?: string; samples?: number } | null;
  inputs?: { sample?: string; role?: string; path?: string; size?: number; error?: string }[];
  outputs?: { size?: number }[];
}
const show = (v: unknown) => (v === undefined || v === null || v === "" ? "not set" : typeof v === "object" ? JSON.stringify(v) : String(v));
const Digest = ({ value }: { value?: string | null }) => value
  ? <code className="select-all font-mono text-[11.5px] text-muted" title={`${value} (click to select)`}>{value.length > 16 ? `${value.slice(0, 12)}…` : value}</code> : null;

/** The record of how the results were made, as sentences and short tables; the raw JSON stays one click away. */
function Provenance({ r }: { r: RunDetail }) {
  const p = r.provenance as Prov;
  const schema = useQuery({
    queryKey: ["schema", r.pipeline_id, r.pipeline_version_id],
    queryFn: () => api.get<FormSchema>(`/api/pipeline-schemas/${r.pipeline_id}${qs({ version_id: r.pipeline_version_id })}`), staleTime: 300_000,
  });
  const changed = schema.data
    ? Object.entries(r.params).filter(([k, v]) => !["input", "outdir"].includes(k) && isChanged(v, schema.data.defaults[k]))
    : null;
  const inputs = p.inputs ?? [];
  const inputBytes = inputs.reduce((n, i) => n + (i.size ?? 0), 0);
  const unresolved = inputs.filter((i) => i.error).length;
  const outputs = p.outputs ?? [];
  const software = Object.entries(p.software ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : (v as { version?: string } | null)?.version] as const).filter(([, v]) => !!v);
  const refs = p.references ?? [];
  if (!Object.keys(r.provenance ?? {}).length) return <Panel className="p-4"><p className="text-[13px] text-muted">Nothing was recorded for this run: it did not get as far as starting.</p></Panel>;

  return (
    <Panel className="p-4">
      <p className="mb-3 text-[13px] text-muted">What was run, on which data and with which settings, so the results can be reproduced. The same record is saved as <code className="font-mono text-[12px]">biocompute_provenance.json</code> in the output folder when the run finishes.</p>
      <dl>
        <KV k="Pipeline" v={<>
          <Link to={`/pipelines/${r.pipeline_id}`} className="hover:underline">{p.pipeline?.name ?? r.pipeline_name}</Link> {p.pipeline?.version ?? r.pipeline_version}
          {p.pipeline?.git_commit && <span className="text-muted">, commit <Digest value={p.pipeline.git_commit} /></span>}
          {p.pipeline?.source && <span className="block break-all text-xs text-muted">{p.pipeline.source}</span>}
        </>} />
        <KV k="Engine" v={`${engineName(p.engine?.name ?? r.engine)}${p.engine?.version ? ` ${p.engine.version}` : ""}`} />
        <KV k="Started by" v={<>{p.created_by ?? r.created_by ?? "unknown"} on {when(p.created_at ?? r.created_at)}</>} />
        <KV k="Finished" v={r.finished_at ? `${when(r.finished_at)}, after ${duration(r.started_at, r.finished_at)}${r.exit_code != null ? ` (exit code ${r.exit_code})` : ""}` : "not yet"} />
        {p.host && <KV k="Computer" v={`${p.host.hostname ?? "?"}${p.host.cpus ? `, ${p.host.cpus} cores` : ""}${p.host.os ? `, ${p.host.os}` : ""}`} />}
        {p.experiment && <KV k="Experiment" v={<><Link to={`/experiments/${p.experiment.id}`} className="hover:underline">{p.experiment.name}</Link>, {p.experiment.samples} samples</>} />}
        <KV k="Input files" v={inputs.length
          ? <>
            {inputs.length} file{inputs.length === 1 ? "" : "s"}, {bytes(inputBytes)}{unresolved ? <span className="text-wait">, {unresolved} could not be found</span> : null}
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-accent hover:underline">List the files</summary>
              <ul className="mt-1 max-h-56 space-y-0.5 overflow-auto font-mono text-[11.5px] text-muted">
                {inputs.map((i, k) => <li key={k} className="break-all"><span className="text-text">{i.sample}</span> {i.role}: {i.path}{i.error ? <span className="text-wait"> ({i.error})</span> : i.size != null ? ` (${bytes(i.size)})` : ""}</li>)}
              </ul>
            </details>
          </>
          : r.experiment_id ? "none recorded" : "from a samplesheet or folder (see samplesheet.csv under Run files)"} />
        <KV k="References" v={refs.length
          ? <ul className="space-y-1.5">
            {refs.map((x, k) => (
              <li key={k}>
                <span className="font-medium">{x.genome}</span> {x.asset}{x.tag ? `:${x.tag}` : ""} <span className="text-muted">for <code className="font-mono text-[12px]">{x.param}</code></span>
                <span className="block text-xs text-muted">{x.asset_digest ? <>asset digest <Digest value={x.asset_digest} /></> : null}{x.asset_digest && x.genome_digest ? ", " : ""}{x.genome_digest ? <>genome digest <Digest value={x.genome_digest} /></> : null}</span>
                {x.path && <span className="block break-all font-mono text-[11.5px] text-muted">{x.path}</span>}
              </li>
            ))}
          </ul>
          : <span className="text-muted">No managed reference genome was used; reference files, if any, are plain paths in the parameters.</span>} />
        <KV k="Parameters" v={<>
          {schema.isLoading ? <span className="text-muted">Comparing with the pipeline's defaults…</span>
            : !changed ? <span className="text-muted">Could not be compared with the pipeline's defaults; all values are on the Parameters tab.</span>
            : changed.length === 0 ? "All at the pipeline's defaults."
            : (
              <>
                {changed.length} differ{changed.length === 1 ? "s" : ""} from the pipeline's defaults:
                <ul className="mt-1 space-y-1">
                  {changed.map(([k, v]) => (
                    <li key={k} className="break-all"><code className="font-mono text-[12px]" title={humanLabel(k)}>{k}</code> = <span className="font-mono text-[12px] font-medium">{show(v)}</span>
                      <span className="text-xs text-muted"> (default: {show(schema.data!.defaults[k])})</span></li>
                  ))}
                </ul>
              </>
            )}
          {p.params_sha256 && <span className="mt-1 block text-xs text-muted" title="SHA-256 of all parameter values: two runs with the same fingerprint used identical parameters">Fingerprint of all values: <Digest value={p.params_sha256} /></span>}
        </>} />
        {software.length > 0 && <KV k="Software" v={<span className="flex flex-wrap gap-1">{software.map(([k, v]) => <Badge key={k}>{k} {v}</Badge>)}</span>} />}
        {outputs.length > 0 && <KV k="Results" v={`${outputs.length} file${outputs.length === 1 ? "" : "s"}, ${bytes(outputs.reduce((n, o) => n + (o.size ?? 0), 0))}`} />}
      </dl>
      <details className="mt-4">
        <summary className="cursor-pointer text-[13px] text-muted hover:text-text">Full record (JSON)</summary>
        <pre className="mt-2 max-h-[480px] overflow-auto rounded-md bg-ink p-3 font-mono text-[12px]">{JSON.stringify(r.provenance, null, 2)}</pre>
      </details>
    </Panel>
  );
}

function ProcessRow({ name, p }: { name: string; p: ProcessProgress }) {
  const done = p.completed + p.cached;
  return (
    <div className="grid grid-cols-[minmax(120px,220px)_1fr_auto] items-center gap-3 text-[13px]">
      <span className="truncate font-mono text-[12px]" title={name}>{name}</span>
      <div className="flex h-2 overflow-hidden rounded-full bg-raised">
        <div className="bg-ok" style={{ width: `${(p.completed / (p.submitted || 1)) * 100}%` }} />
        <div className="bg-accent/70" style={{ width: `${(p.cached / (p.submitted || 1)) * 100}%` }} />
        <div className="bg-run pulse-run" style={{ width: `${(p.running / (p.submitted || 1)) * 100}%` }} />
        <div className="bg-bad" style={{ width: `${(p.failed / (p.submitted || 1)) * 100}%` }} />
      </div>
      <span className="text-xs text-muted tabular-nums w-28 text-right">{done}/{p.submitted}{p.cached ? ` (${p.cached} cached)` : ""}{p.failed ? `, ${p.failed} failed` : ""}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------- log
const BLOCK = 250;        // lines per block: only the last block re-renders when output arrives
const MAX_BLOCKS = 20;    // 5000 lines are kept on screen; the download has everything
interface LogState { blocks: { id: number; lines: string[] }[]; tail: string; dropped: number }
const EMPTY_LOG: LogState = { blocks: [], tail: "", dropped: 0 };

/** Append a chunk of output: complete lines go into fixed-size blocks, an unfinished last line waits in `tail`. */
function appendLog(s: LogState, chunk: string): LogState {
  const parts = (s.tail + chunk).split("\n");
  const tail = parts.pop() ?? "";
  if (!parts.length) return tail === s.tail ? s : { ...s, tail };
  const blocks = s.blocks.slice();
  let i = 0;
  while (i < parts.length) {
    const last = blocks[blocks.length - 1];
    if (last && last.lines.length < BLOCK) {
      const take = parts.slice(i, i + BLOCK - last.lines.length);
      blocks[blocks.length - 1] = { id: last.id, lines: last.lines.concat(take) };
      i += take.length;
    } else {
      const take = parts.slice(i, i + BLOCK);
      blocks.push({ id: last ? last.id + 1 : 0, lines: take });
      i += take.length;
    }
  }
  const over = Math.max(0, blocks.length - MAX_BLOCKS);
  return { blocks: over ? blocks.slice(over) : blocks, tail, dropped: s.dropped + over * BLOCK };
}

const lineTone = (l: string) => /ERROR|error|FAILED/.test(l) ? "text-bad" : /Submitted process|Cached process/.test(l) ? "text-run"
  : /completed successfully|Succeeded/.test(l) ? "text-ok" : l.startsWith("[biocompute]") ? "text-accent" : "";
const LogBlock = memo(function LogBlock({ lines }: { lines: string[] }) {
  return <>{lines.map((l, i) => <span key={i} className={cn("block", lineTone(l))}>{l || " "}</span>)}</>;
});

function LiveLog({ runId, active, engine }: { runId: string; active: boolean; engine: string }) {
  const [log, setLog] = useState<LogState>(EMPTY_LOG);
  const [which, setWhich] = useState<"stdout" | "nextflow">("stdout");
  const [follow, setFollow] = useState(true);
  const [live, setLive] = useState(false);
  const [state, setState] = useState<{ loading: boolean; error: unknown; partial: boolean }>({ loading: false, error: null, partial: false });
  const [attempt, setAttempt] = useState(0);
  const ref = useRef<HTMLPreElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    setLog(EMPTY_LOG);
    setState({ loading: false, error: null, partial: false });
    if (which === "stdout" && active) {
      let es: EventSource | null = null;
      let closed = false;
      // the stream is opened with the file cookie, which must be there first (an EventSource refused once does not retry)
      ensureMediaCookie().then(() => {
        if (closed) return;
        const src = es = new EventSource(authed(`/api/runs/${runId}/stream`));
        let lastStatus = "";
        // every (re)connection starts again from the recent end of the log, so what is on screen is replaced, not repeated
        src.addEventListener("open", () => { setLive(true); setLog(EMPTY_LOG); });
        src.addEventListener("log", (e) => { const chunk = JSON.parse((e as MessageEvent).data) as string; setLog((s) => appendLog(s, chunk)); });
        src.addEventListener("status", (e) => {   // sent every few seconds; refresh the page only when something changed
          const data = (e as MessageEvent).data as string;
          if (data !== lastStatus) { if (lastStatus) qc.invalidateQueries({ queryKey: ["run", runId] }); lastStatus = data; }
        });
        src.addEventListener("end", () => { src.close(); setLive(false); qc.invalidateQueries({ queryKey: ["run", runId] }); });
        src.onerror = () => setLive(false);
      });
      return () => { closed = true; es?.close(); setLive(false); };
    }
    let stale = false;
    setState({ loading: true, error: null, partial: false });
    (async () => {
      // the endpoint reads forward from an offset: for a long log, show its end rather than its beginning
      let part = await api.get<{ content: string; offset: number; size: number }>(`/api/runs/${runId}/log?which=${which}`);
      let partial = false;
      if (part.size > part.offset) {
        part = await api.get(`/api/runs/${runId}/log${qs({ which, offset: Math.max(0, part.size - 250_000) })}`);
        partial = true;
        part.content = part.content.slice(part.content.indexOf("\n") + 1);   // the first line is cut somewhere in the middle
      }
      if (stale) return;
      setLog(appendLog(EMPTY_LOG, part.content));
      setState({ loading: false, error: null, partial });
    })().catch((error) => { if (!stale) setState({ loading: false, error, partial: false }); });
    return () => { stale = true; };
  }, [runId, which, active, qc, attempt]);

  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [log, follow]);
  const empty = log.blocks.length === 0 && !log.tail;

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        {engine === "nextflow" && (
          <div className="flex gap-1">
            {(["stdout", "nextflow"] as const).map((w) => <Button key={w} size="sm" variant={which === w ? "secondary" : "ghost"} onClick={() => setWhich(w)} title={w === "stdout" ? "What the pipeline printed" : "Nextflow's own detailed log (.nextflow.log)"}>{w === "stdout" ? "Output" : "Engine log"}</Button>)}
          </div>
        )}
        {live && <Badge tone="run"><span className="size-1.5 rounded-full bg-current pulse-run" />Live</Badge>}
        {(log.dropped > 0 || state.partial) && <span className="text-xs text-muted">Showing the last {log.blocks.reduce((n, b) => n + b.lines.length, 0).toLocaleString()} lines; download for the whole log</span>}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">Follow<Switch checked={follow} onCheckedChange={setFollow} /></label>
        <a href={authed(`/api/runs/${runId}/files/${which === "stdout" ? "stdout.log" : "nextflow.log"}`)} download className="text-muted hover:text-text" aria-label="Download log" title="Download the whole log"><ArrowDownToLine className="size-4" /></a>
      </div>
      {state.error
        ? <div className="p-4"><QueryError error={state.error} what="the log" onRetry={() => setAttempt((n) => n + 1)} /></div>
        : (
          <pre ref={ref} className="h-[440px] overflow-auto whitespace-pre-wrap break-all bg-ink/60 p-4 font-mono text-[12px] leading-[1.6]">
            {empty
              ? <span className="text-muted">{state.loading ? "Loading the log…" : active && which === "stdout" && !live ? "Connecting to the run…" : "No output yet."}</span>
              : <>
                {log.blocks.map((b) => <LogBlock key={b.id} lines={b.lines} />)}
                {log.tail && <span className={cn("block", lineTone(log.tail))}>{log.tail}</span>}
              </>}
          </pre>
        )}
    </Panel>
  );
}
