import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Rocket, Workflow } from "lucide-react";
import { api, ApiError, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { Pipeline, StudioWorkflow } from "@/lib/types";
import { ago } from "@/lib/utils";
import { Badge, Panel } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";

/** Publish state of a saved Studio workflow, from the pipeline it was published as (if any). */
export function publishState(w: StudioWorkflow, pipelines: Pipeline[]) {
  const p = pipelines.find((x) => x.studio_workflow_id === w.id) ?? null;
  const v = p?.latest_version ?? null;
  // publishing saves first, so a workflow saved within a few seconds before its latest version is up to date
  const changed = !!v && new Date(w.updated_at).getTime() > new Date(v.created_at).getTime() + 5000;
  return { pipeline: p, version: v?.version ?? null, published: !!p, changed };
}

/** Workflows saved in Studio that are not in the pipeline library yet (or changed since publishing). */
export function StudioDrafts({ query }: { query: string }) {
  const user = useAuth((s) => s.user);
  const qc = useQueryClient();
  const nav = useNavigate();
  const wf = useQuery({ queryKey: ["studio-workflows"], queryFn: () => api.get<StudioWorkflow[]>("/api/studio/workflows") });
  const pl = useQuery({ queryKey: ["pipelines"], queryFn: () => api.get<Pipeline[]>("/api/pipelines") });
  const [busy, setBusy] = useState<string | null>(null);
  const ql = query.toLowerCase();
  const drafts = (wf.data ?? [])
    .filter((w) => w.graph?.meta?.kind !== "subworkflow")
    .map((w) => ({ w, s: publishState(w, pl.data ?? []) }))
    .filter(({ w, s }) => (!s.published || s.changed) && (!ql || w.name.toLowerCase().includes(ql) || w.description.toLowerCase().includes(ql)));
  if (!drafts.length) return null;

  const publish = async (w: StudioWorkflow) => {
    setBusy(w.id);
    try {
      const r = await api.post<{ pipeline_id: string; version: string }>(`/api/studio/workflows/${w.id}/publish`);
      qc.invalidateQueries({ queryKey: ["pipelines"] });
      qc.invalidateQueries({ queryKey: ["studio-workflows"] });
      toast.success(`Published “${w.name}” as ${r.version}`, { action: { label: "Open", onClick: () => nav(`/pipelines/${r.pipeline_id}`) } });
    } catch (e) {
      const n = e instanceof ApiError ? e.issues.filter((i) => i.level !== "warning").length : 0;
      toast.error(n ? `“${w.name}” has ${n} error${n === 1 ? "" : "s"} to fix before publishing.` : errMsg(e),
        { action: { label: "Open in Studio", onClick: () => nav(`/studio/${w.id}`) } });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mb-8">
      <h2 className="mb-1 text-[15px] font-semibold">Saved in Studio, not published</h2>
      <p className="mb-3 text-[13px] text-muted">Saving keeps a draft in Studio. Publish it to add it to the library so it can be launched.</p>
      <Panel className="divide-y divide-line/60">
        {drafts.map(({ w, s }) => (
          <div key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Workflow className="size-4 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[13.5px] font-medium">
                <Link to={`/studio/${w.id}`} className="truncate hover:underline">{w.name}</Link>
                {s.changed ? <Badge tone="wait">changed since {s.version}</Badge> : <Badge>draft</Badge>}
              </p>
              <p className="truncate text-xs text-muted">{w.graph.nodes.length} steps · saved {ago(w.updated_at)}{w.created_by ? ` by ${w.created_by}` : ""}{w.description ? ` · ${w.description}` : ""}</p>
            </div>
            <Button asChild size="sm" variant="ghost"><Link to={`/studio/${w.id}`}>Open in Studio</Link></Button>
            {can(user, "scientist") && (
              <Button size="sm" variant="primary" loading={busy === w.id} onClick={() => publish(w)}>
                <Rocket />{s.changed ? `Publish v${Number((s.version ?? "v0").replace(/\D/g, "")) + 1}` : "Publish"}
              </Button>
            )}
          </div>
        ))}
      </Panel>
    </section>
  );
}
