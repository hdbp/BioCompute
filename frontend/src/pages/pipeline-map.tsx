import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Play, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { PipelineDetail } from "@/lib/types";
import { when } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { PipelineMapFull } from "@/components/pipeline-map";
import { DuplicateDialog } from "@/pages/pipeline-detail";

/** Full-window pipeline map, laid out like Pipeline Studio: steps on the left, the graph, details on the right. */
export default function PipelineMapPage() {
  const { id = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const user = useAuth((s) => s.user);
  const p = useQuery({ queryKey: ["pipeline", id], queryFn: () => api.get<PipelineDetail>(`/api/pipelines/${id}`) });
  const [dupOpen, setDupOpen] = useState(false);
  const d = p.data;
  const versionId = sp.get("version") ?? undefined;
  const current = versionId ?? d?.latest_version?.id ?? "";
  const toolbar = (
    <>
      <Button asChild size="icon" variant="ghost" aria-label="Back to the pipeline page"><Link to={`/pipelines/${id}`}><ArrowLeft /></Link></Button>
      <Workflow className="size-4 text-accent" />
      <span className="max-w-[28ch] truncate text-[14px] font-semibold" title={d?.name}>{d?.name ?? "Pipeline"}</span>
      {d && <Badge tone={d.kind === "studio" ? "ok" : "neutral"}>{d.kind === "studio" ? "Built in Studio" : "Nextflow code"}</Badge>}
      {d && d.versions.length > 0 && (
        <Select className="h-8 w-auto" aria-label="Version" value={current}
          onChange={(e) => setSp(e.target.value === d.latest_version?.id ? {} : { version: e.target.value }, { replace: true })}>
          {[...d.versions].reverse().map((v) => <option key={v.id} value={v.id}>{v.version}{v.id === d.latest_version?.id ? " (current)" : ""} · {when(v.created_at)}</option>)}
        </Select>
      )}
      {d && <Button asChild size="sm" variant="secondary"><Link to={`/jobs/new?pipeline=${d.id}${versionId ? `&version=${versionId}` : ""}`}><Play />Configure and run</Link></Button>}
    </>
  );
  return (
    <>
      <PipelineMapFull pid={id} versionId={versionId} toolbar={toolbar} canCopy={can(user, "scientist")} onCopy={() => setDupOpen(true)} />
      {d && <DuplicateDialog open={dupOpen} onOpenChange={setDupOpen} pid={d.id} name={d.name} />}
    </>
  );
}
