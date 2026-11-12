import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileCode2, Info, Play, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { PipelineDetail } from "@/lib/types";
import { when } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { PipelineMapFull } from "@/components/pipeline-map";
import { ForkDialog } from "@/components/fork-dialog";

/** Full-window pipeline map, laid out like Pipeline Studio: steps on the left, the graph, details on the right. */
export default function PipelineMapPage() {
  const { id = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const user = useAuth((s) => s.user);
  const p = useQuery({ queryKey: ["pipeline", id], queryFn: () => api.get<PipelineDetail>(`/api/pipelines/${id}`) });
  const [fork, setFork] = useState<{ versionId?: string; version?: string; studio: boolean } | null>(null);
  const d = p.data;
  const versionId = sp.get("version") ?? undefined;
  const current = versionId ?? d?.latest_version?.id ?? "";
  const toolbar = (
    <>
      <Button asChild size="icon" variant="ghost" aria-label="All pipelines" title="All pipelines"><Link to="/pipelines"><ArrowLeft /></Link></Button>
      <Workflow className="size-4 text-accent" />
      <span className="max-w-[28ch] truncate text-[14px] font-semibold" title={d?.name}>{d?.name ?? "Pipeline"}</span>
      {d && <Badge tone={d.kind === "studio" ? "ok" : "neutral"}>{d.kind === "studio" ? "Built in Studio" : "Nextflow code"}</Badge>}
      {d && d.versions.length > 0 && (
        <Select className="h-8 w-auto" aria-label="Version" value={current}
          onChange={(e) => setSp(e.target.value === d.latest_version?.id ? {} : { version: e.target.value }, { replace: true })}>
          {[...d.versions].reverse().map((v) => <option key={v.id} value={v.id}>{v.version}{v.id === d.latest_version?.id ? " (current)" : ""} · {when(v.created_at)}</option>)}
        </Select>
      )}
      {d && <Button asChild size="sm" variant="ghost"><Link to={`/pipelines/${d.id}`} title="Details: parameters, versions, history"><Info /><span className="hidden 2xl:inline">Details</span></Link></Button>}
      {d && d.kind !== "studio" && <Button asChild size="sm" variant="ghost"><Link to={`/pipelines/${d.id}/code${versionId ? `?version=${versionId}` : ""}`} title="Code"><FileCode2 /><span className="hidden 2xl:inline">Code</span></Link></Button>}
      {d && <Button asChild size="sm" variant="secondary"><Link to={`/jobs/new?pipeline=${d.id}${versionId ? `&version=${versionId}` : ""}`}><Play />Run</Link></Button>}
    </>
  );
  return (
    <>
      <PipelineMapFull pid={id} versionId={versionId} toolbar={toolbar} canFork={can(user, "scientist")}
        onFork={(m) => setFork({ versionId: m.version_id, version: m.version, studio: m.kind === "studio" })} />
      {d && <ForkDialog open={!!fork} onOpenChange={(o) => !o && setFork(null)} pid={d.id} name={d.name} version={fork?.version} versionId={fork?.versionId} studio={!!fork?.studio} />}
    </>
  );
}
