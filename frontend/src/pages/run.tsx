import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDownToLine, Ban, CheckCircle2, FileText, FolderOpen, RotateCw } from "lucide-react";
import { api, authed, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { ProcessProgress, RunDetail } from "@/lib/types";
import { cn, duration, when } from "@/lib/utils";
import { KV, PageHeader } from "@/components/page";
import { Badge, Empty, Meter, Panel, PanelHeader, Skeleton, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { RunStatusBadge } from "@/components/status";

const TERMINAL = ["completed", "failed", "cancelled", "lost"];

export default function RunPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const run = useQuery({ queryKey: ["run", id], queryFn: () => api.get<RunDetail>(`/api/runs/${id}`), refetchInterval: (q) => (q.state.data && TERMINAL.includes(q.state.data.status) ? false : 3000) });
  const r = run.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ["run", id] }); qc.invalidateQueries({ queryKey: ["runs"] }); };
  const cancel = useMutation({ mutationFn: () => api.post(`/api/runs/${id}/cancel`), onSuccess: () => { toast.success("Cancellation requested"); refresh(); }, onError: (e) => toast.error(errMsg(e)) });
  const resume = useMutation({ mutationFn: () => api.post(`/api/runs/${id}/resume`), onSuccess: () => { toast.success("Resumed; completed tasks are reused from cache"); refresh(); }, onError: (e) => toast.error(errMsg(e)) });

  if (run.isLoading) return <Skeleton className="h-96" />;
  if (!r) return <Empty title="Run not found" />;
  const active = !TERMINAL.includes(r.status);
  const procs = Object.entries(r.progress.processes ?? {});
  const pct = r.progress.total ? Math.round(((r.progress.done ?? 0) / r.progress.total) * 100) : r.status === "completed" ? 100 : 0;
  const preflight = r.events.find((e) => e.kind === "preflight");

  return (
    <>
      <PageHeader title={<span className="flex flex-wrap items-center gap-3">{r.name}<RunStatusBadge status={r.status} /></span>}
        description={<>
          <Link className="hover:text-text" to={`/pipelines/${r.pipeline_id}`}>{r.pipeline_name} {r.pipeline_version}</Link>
          {r.experiment_name && <>{" on "}<Link className="hover:text-text" to={`/experiments/${r.experiment_id}`}>{r.experiment_name}</Link></>}
          {`, ${r.engine === "bcflow" ? "BioCompute native engine" : "Nextflow"}`}{r.attempt > 1 ? `, attempt ${r.attempt}` : ""}
        </>}
        actions={can(user, "scientist") && <>
          {active && <Button variant="danger" loading={cancel.isPending} onClick={() => confirm("Cancel this run? Running tasks are stopped.") && cancel.mutate()}><Ban />Cancel</Button>}
          {!active && r.status !== "completed" && <Button variant="primary" loading={resume.isPending} onClick={() => resume.mutate()}><RotateCw />Resume</Button>}
          {!active && r.status === "completed" && <Button variant="secondary" loading={resume.isPending} onClick={() => resume.mutate()}><RotateCw />Re-run with cache</Button>}
          {r.status === "completed" && <Button asChild variant="primary"><Link to={`/results/${r.id}`}><FolderOpen />Open results</Link></Button>}
        </>} />

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-5">
          <Panel className="p-4">
            <div className="flex items-baseline justify-between">
              <p className="text-[13.5px] font-medium">{r.progress.done ?? 0} of {r.progress.total ?? 0} tasks finished{r.progress.failed ? `, ${r.progress.failed} failed` : ""}</p>
              <p className="text-xs text-muted tabular-nums">{r.started_at ? `${duration(r.started_at, r.finished_at)} elapsed` : "not started"}</p>
            </div>
            <Meter value={pct} tone={r.status === "failed" || r.status === "lost" ? "bad" : r.status === "completed" ? "ok" : "run"} className="mt-2 h-2" />
            {procs.length > 0 && (
              <div className="mt-4 space-y-2">
                {procs.map(([name, p]) => <ProcessRow key={name} name={name} p={p} />)}
              </div>
            )}
            {procs.length === 0 && active && <p className="mt-3 text-[13px] text-muted">Waiting for the engine to submit its first task.</p>}
          </Panel>
          {r.error && (
            <Panel className="border-bad/40">
              <PanelHeader title={<span className="text-bad">Error</span>} description={r.exit_code != null ? `Engine exit code ${r.exit_code}` : undefined} />
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-4 font-mono text-[12px] leading-relaxed">{r.error}</pre>
            </Panel>
          )}
          <Tabs defaultValue="log">
            <TabsList>
              <TabsTrigger value="log">Log</TabsTrigger>
              <TabsTrigger value="tasks">Tasks <span className="ml-1 text-xs text-muted">{r.progress.tasks?.length ?? 0}</span></TabsTrigger>
              <TabsTrigger value="params">Parameters</TabsTrigger>
              <TabsTrigger value="provenance">Provenance</TabsTrigger>
            </TabsList>
            <TabsContent value="log" className="mt-3"><LiveLog runId={r.id} active={active} engine={r.engine} /></TabsContent>
            <TabsContent value="tasks" className="mt-3">
              <Panel className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-[13px]">
                  <thead><tr className="border-b border-line text-left text-xs text-muted"><th className="px-4 py-2 font-medium">Task</th><th className="font-medium">Process</th><th className="font-medium">Status</th><th className="font-medium">Exit</th><th className="font-medium">Duration</th><th className="px-4 font-medium">Peak memory</th></tr></thead>
                  <tbody>
                    {(r.progress.tasks ?? []).map((t) => (
                      <tr key={t.hash} className="border-b border-line/50 last:border-0" title={t.workdir}>
                        <td className="px-4 py-1.5 font-mono text-[11.5px] text-muted">{t.hash}</td>
                        <td className="py-1.5">{t.process}{t.tag ? <span className="text-muted"> ({t.tag})</span> : ""}</td>
                        <td><Badge tone={t.status === "COMPLETED" ? "ok" : t.status === "CACHED" ? "accent" : t.status === "FAILED" ? "bad" : "run"}>{t.status === "SUBMITTED" ? "running" : t.status?.toLowerCase()}</Badge></td>
                        <td className="tabular-nums">{t.exit ?? "—"}</td>
                        <td className="tabular-nums text-muted">{t.realtime ?? t.duration ?? "—"}</td>
                        <td className="px-4 tabular-nums text-muted">{t.peak_rss || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!r.progress.tasks?.length && <p className="p-4 text-[13px] text-muted">No tasks recorded yet.</p>}
              </Panel>
            </TabsContent>
            <TabsContent value="params" className="mt-3">
              <Panel className="p-4"><dl>{Object.entries(r.params).map(([k, v]) => <KV key={k} k={<span className="font-mono text-[12px]">{k}</span>} v={typeof v === "object" ? JSON.stringify(v) : String(v)} mono />)}</dl></Panel>
            </TabsContent>
            <TabsContent value="provenance" className="mt-3">
              <Panel className="p-4">
                <p className="mb-2 text-[13px] text-muted">Also written to <code className="font-mono text-[12px]">biocompute_provenance.json</code> in the output folder when the run finishes.</p>
                <pre className="max-h-[480px] overflow-auto rounded-md bg-ink p-3 font-mono text-[12px]">{JSON.stringify(r.provenance, null, 2)}</pre>
              </Panel>
            </TabsContent>
          </Tabs>
        </div>
        <aside className="space-y-5">
          <Panel className="p-4">
            <dl>
              <KV k="Run ID" v={r.id} mono />
              <KV k="Created" v={`${when(r.created_at)} by ${r.created_by ?? "?"}`} />
              <KV k="Started" v={when(r.started_at)} />
              <KV k="Finished" v={when(r.finished_at)} />
              <KV k="Placement" v={((r.placement.selected as string[]) ?? []).join(", ")} />
              <KV k="Executor" v={String(r.resources.executor ?? "local")} />
              <KV k="Resources" v={`${r.resources.max_cpus ?? "?"} cores, ${r.resources.max_memory_gb ?? "?"} GB`} />
              {r.resources.profile ? <KV k="Profile" v={String(r.resources.profile)} /> : null}
              <KV k="Output folder" v={r.output_vpath ?? r.output_dir} mono />
              <KV k="Work folder" v={r.work_dir} mono />
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
              <PanelHeader title="Preflight checks" description={preflight.message} />
              <ul className="p-3 space-y-1.5 text-[13px]">
                {((preflight.data.checks as { name: string; ok: boolean; detail: string; level: string }[]) ?? []).map((c) => (
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
                  <span className="min-w-0"><span className="break-words">{e.message}</span><span className="block text-[11px] text-muted">{when(e.ts)}</span></span>
                </li>
              ))}
            </ol>
          </Panel>
        </aside>
      </div>
    </>
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

function LiveLog({ runId, active, engine }: { runId: string; active: boolean; engine: string }) {
  const [text, setText] = useState("");
  const [which, setWhich] = useState<"stdout" | "nextflow">("stdout");
  const [follow, setFollow] = useState(true);
  const [live, setLive] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    setText("");
    if (which === "stdout" && active) {
      const es = new EventSource(authed(`/api/runs/${runId}/stream`));
      es.addEventListener("open", () => setLive(true));
      es.addEventListener("log", (e) => setText((t) => (t + JSON.parse((e as MessageEvent).data)).slice(-400_000)));
      es.addEventListener("status", () => qc.invalidateQueries({ queryKey: ["run", runId] }));
      es.addEventListener("end", () => { es.close(); setLive(false); qc.invalidateQueries({ queryKey: ["run", runId] }); });
      es.onerror = () => setLive(false);
      return () => es.close();
    }
    api.get<{ content: string }>(`/api/runs/${runId}/log?which=${which}`).then((r) => setText(r.content)).catch(() => setText(""));
  }, [runId, which, active, qc]);

  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text, follow]);

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        {engine === "nextflow" && (
          <div className="flex gap-1">
            {(["stdout", "nextflow"] as const).map((w) => <Button key={w} size="sm" variant={which === w ? "secondary" : "ghost"} onClick={() => setWhich(w)}>{w === "stdout" ? "Console" : ".nextflow.log"}</Button>)}
          </div>
        )}
        {live && <Badge tone="run"><span className="size-1.5 rounded-full bg-current pulse-run" />Live</Badge>}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">Follow<Switch checked={follow} onCheckedChange={setFollow} /></label>
        <a href={authed(`/api/runs/${runId}/files/${which === "stdout" ? "stdout.log" : "nextflow.log"}`)} download className="text-muted hover:text-text" aria-label="Download log"><ArrowDownToLine className="size-4" /></a>
      </div>
      <pre ref={ref} className="h-[440px] overflow-auto whitespace-pre-wrap break-all bg-ink/60 p-4 font-mono text-[12px] leading-[1.6]">
        {text ? text.split("\n").map((l, i) => (
          <span key={i} className={cn("block", /ERROR|error|FAILED/.test(l) ? "text-bad" : /Submitted process|Cached process/.test(l) ? "text-run" : /completed successfully|Succeeded/.test(l) ? "text-ok" : l.startsWith("[biocompute]") ? "text-accent" : "")}>{l || " "}</span>
        )) : <span className="text-muted">No output yet.</span>}
      </pre>
    </Panel>
  );
}
