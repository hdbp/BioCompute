import { useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Lock, Network, Play, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { PipelineDetail } from "@/lib/types";
import { when } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge, Tip } from "@/components/ui/misc";
import { PipelineMapFull } from "@/components/pipeline-map";
import { ForkDialog } from "@/components/fork-dialog";

/** Pipeline Studio for a Nextflow pipeline you copied: change its steps on the graph; each save is a new version. */
export default function StudioPipelinePage() {
  const { id = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const user = useAuth((s) => s.user);
  const p = useQuery({ queryKey: ["pipeline", id], queryFn: () => api.get<PipelineDetail>(`/api/pipelines/${id}`) });
  const d = p.data;
  const versionId = sp.get("version") ?? undefined;
  const current = versionId ?? d?.latest_version?.id ?? "";
  const dirty = useRef(false);
  const [fork, setFork] = useState<{ versionId?: string; version?: string } | null>(null);
  const mine = !!d && d.can_edit && (d.source_url ?? "").match(/^(copy|duplicate):/) && d.kind !== "studio";
  const toolbar = (
    <>
      <Workflow className="size-4 text-accent" />
      <span className="max-w-[28ch] truncate text-[14px] font-semibold" title={d?.name}>{d?.name ?? "Pipeline"}</span>
      {d && (mine ? <Badge tone="ok">Nextflow · your copy</Badge>
        : <Tip content="Originals are never changed. Edit as new pipeline makes your own copy to change."><Badge tone="wait" className="cursor-help"><Lock className="size-3" />read-only original</Badge></Tip>)}
      {d && d.versions.length > 0 && (
        <Select className="h-8 w-auto" aria-label="Version" value={current}
          onChange={(e) => {
            if (dirty.current && !window.confirm("Discard your unsaved step settings?")) return;
            setSp(e.target.value === d.latest_version?.id ? {} : { version: e.target.value }, { replace: true });
          }}>
          {[...d.versions].reverse().map((v) => <option key={v.id} value={v.id}>{v.version}{v.id === d.latest_version?.id ? " (current)" : ""} · {when(v.created_at)}</option>)}
        </Select>
      )}
      {d && <Button asChild size="sm" variant="ghost"><Link to={`/pipelines/${d.id}/map${versionId ? `?version=${versionId}` : ""}`} title="Map"><Network /><span className="hidden 2xl:inline">Map</span></Link></Button>}
      {d && <Button asChild size="sm" variant="secondary"><Link to={`/jobs/new?pipeline=${d.id}${versionId ? `&version=${versionId}` : ""}`}><Play />Run</Link></Button>}
    </>
  );
  return (
    <>
      <PipelineMapFull pid={id} versionId={versionId} toolbar={toolbar} mode="edit" canFork={can(user, "scientist")}
        onDirty={(x) => { dirty.current = x; }} onFork={(m) => setFork({ versionId: m.version_id, version: m.version })} />
      {d && <ForkDialog open={!!fork} onOpenChange={(o) => !o && setFork(null)} pid={d.id} name={d.name} version={fork?.version} versionId={fork?.versionId} studio={false} />}
    </>
  );
}
