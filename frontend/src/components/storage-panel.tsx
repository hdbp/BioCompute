import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eraser, HardDrive, Trash2 } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { bytes, cn } from "@/lib/utils";
import { Ago, QueryError } from "@/components/page";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Field, Input } from "@/components/ui/input";
import { Badge, Meter, Panel, PanelHeader, Skeleton } from "@/components/ui/misc";
import { RunStatusBadge } from "@/components/status";

interface Storage {
  work_bytes: number; log_bytes: number; pipeline_bytes: number; cleanup_intermediates: boolean;
  runs: { id: string; name: string; status: string; created_by: string | null; finished_at: string | null; work_bytes: number; log_bytes: number; keep_work: boolean }[];
  pipelines: { id: string; name: string; owner: string | null; versions: { id: string; version: string; bytes: number; in_store: boolean; pinned: boolean; runs: number }[] }[];
  folders: { name: string; path: string; disk: { total: number; free: number } | null }[];
}

/** Settings, Storage (admins): what uses disk, and cleaning it up. */
export function StoragePanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["storage"], queryFn: () => api.get<Storage>("/api/storage") });
  const [days, setDays] = useState("14");
  const refresh = () => qc.invalidateQueries({ queryKey: ["storage"] });
  const clean = useMutation({
    mutationFn: (d: number) => api.post<{ runs: number; freed: number }>("/api/storage/clean-work", { older_than_days: d }),
    onSuccess: (r) => { toast.success(r.runs ? `Intermediate files of ${r.runs} run${r.runs === 1 ? "" : "s"} deleted: ${bytes(r.freed)} freed` : "Nothing to delete"); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const cleanRun = useMutation({
    mutationFn: (id: string) => api.post<{ freed: number }>(`/api/runs/${id}/clean-work`),
    onSuccess: (r) => { toast.success(`${bytes(r.freed)} freed`); refresh(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const delVersion = useMutation({
    mutationFn: (v: { pid: string; vid: string }) => api.del(`/api/pipelines/${v.pid}/versions/${v.vid}`),
    onSuccess: () => { toast.success("Version deleted"); refresh(); qc.invalidateQueries({ queryKey: ["pipelines"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} what="storage use" />;
  const d = q.data!;
  const askClean = async () => {
    const n = Math.max(0, Number(days) || 0);
    if (await confirmDialog({
      title: "Delete intermediate files of finished runs?",
      body: <>For runs that finished more than {n} day{n === 1 ? "" : "s"} ago (completed, failed, cancelled or lost). Results and logs are kept. Those runs can then only be repeated from the start.</>,
      confirmLabel: "Delete intermediate files", danger: true,
    })) clean.mutate(n);
  };
  const withWork = d.runs.filter((r) => r.work_bytes > 0);
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel className="p-4">
          <p className="text-xs text-muted">Intermediate files of runs</p>
          <p className="text-xl font-semibold tabular-nums">{bytes(d.work_bytes)}</p>
          <p className="mt-1 text-xs text-muted">{d.cleanup_intermediates ? "Deleted automatically once no longer needed, unless a run keeps them; failed runs keep them for Resume." : "Automatic deletion is off (BIOCOMPUTE_CLEANUP_INTERMEDIATES=false)."}</p>
        </Panel>
        <Panel className="p-4"><p className="text-xs text-muted">Run logs and records</p><p className="text-xl font-semibold tabular-nums">{bytes(d.log_bytes)}</p></Panel>
        <Panel className="p-4"><p className="text-xs text-muted">Pipeline versions in the store</p><p className="text-xl font-semibold tabular-nums">{bytes(d.pipeline_bytes)}</p>
          <p className="mt-1 text-xs text-muted">Versions of a copy share unchanged files.</p></Panel>
      </div>

      <Panel>
        <PanelHeader title="Free space" description="The folders BioCompute writes to: its own state folder (runs, pipelines, database) and the data folders." />
        <div className="divide-y divide-line/60">
          {d.folders.map((f) => {
            const used = f.disk ? f.disk.total - f.disk.free : 0;
            const pct = f.disk ? Math.round((used / f.disk.total) * 100) : 0;
            return (
              <div key={f.name + f.path} className="grid items-center gap-3 px-4 py-2.5 text-[13px] sm:grid-cols-[12rem_1fr_10rem]">
                <span className="flex items-center gap-2 font-medium"><HardDrive className="size-3.5 text-muted" />{f.name}</span>
                <span className="min-w-0 truncate font-mono text-[11.5px] text-muted" title={f.path}>{f.path}</span>
                {f.disk ? (
                  <span className="space-y-1">
                    <Meter value={pct} tone={pct > 90 ? "bad" : pct > 75 ? "wait" : "accent"} />
                    <span className={cn("block text-xs", pct > 90 ? "text-bad" : "text-muted")}>{bytes(f.disk.free)} free of {bytes(f.disk.total)}</span>
                  </span>
                ) : <span className="text-xs text-muted">not available</span>}
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Intermediate files kept by runs" description="Delete them for one run, or for every run finished before a date. Results and logs are not touched."
          actions={<div className="flex items-end gap-2">
            <Field label="Finished over N days ago" className="w-44"><Input type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
            <Button variant="secondary" loading={clean.isPending} onClick={askClean}><Eraser />Delete</Button>
          </div>} />
        {withWork.length === 0 ? <p className="px-4 py-3 text-[13px] text-muted">No run keeps intermediate files.</p> : (
          <table className="w-full text-[13px]">
            <tbody className="divide-y divide-line/60">
              {withWork.slice(0, 50).map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2"><Link to={`/runs/${r.id}`} className="font-medium hover:text-accent">{r.name}</Link>
                    <span className="block text-xs text-muted">{r.created_by ?? "—"}{r.keep_work ? " · asked to keep them" : ""}</span></td>
                  <td className="px-2 py-2"><RunStatusBadge status={r.status} /></td>
                  <td className="px-2 py-2 text-muted"><Ago ts={r.finished_at} /></td>
                  <td className="px-2 py-2 text-right tabular-nums">{bytes(r.work_bytes)}</td>
                  <td className="px-4 py-2 text-right">
                    {!["running", "queued", "cancelling", "pending", "preflight"].includes(r.status) && (
                      <Button size="sm" variant="ghost" loading={cleanRun.isPending && cleanRun.variables === r.id} onClick={() => cleanRun.mutate(r.id)}><Eraser />Delete</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Pipeline versions" description="Largest first. A version no run used, and that is not the default, can be deleted; versions used by runs are kept so those runs stay reproducible." />
        {d.pipelines.length === 0 ? <p className="px-4 py-3 text-[13px] text-muted">No pipeline versions in the store.</p> : (
          <div className="divide-y divide-line/60">
            {d.pipelines.slice(0, 30).map((p) => (
              <div key={p.id} className="px-4 py-2.5 text-[13px]">
                <Link to={`/pipelines/${p.id}?tab=versions`} className="font-medium hover:text-accent">{p.name}</Link>
                {p.owner && <span className="ml-2 text-xs text-muted">{p.owner}</span>}
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {p.versions.map((v) => (
                    <span key={v.id} className="inline-flex items-center gap-1.5 rounded border border-line px-2 py-0.5 text-xs">
                      {v.version} · {bytes(v.bytes)}
                      {v.pinned && <Badge tone="accent">default</Badge>}
                      {v.runs > 0 && <span className="text-muted">{v.runs} run{v.runs === 1 ? "" : "s"}</span>}
                      {!v.pinned && v.runs === 0 && p.versions.length > 1 && (
                        <button className="text-muted hover:text-bad" aria-label={`Delete ${p.name} ${v.version}`} title="Delete this version"
                          onClick={async () => { if (await confirmDialog({ title: `Delete ${p.name} ${v.version}?`, body: "No run used this version. Its files in the pipeline store are deleted.", danger: true })) delVersion.mutate({ pid: p.id, vid: v.id }); }}>
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
