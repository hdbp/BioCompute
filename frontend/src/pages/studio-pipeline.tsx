import { useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Lock, Network, Play, Workflow } from "lucide-react";
import { api, qs } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { PipelineDetail } from "@/lib/types";
import { usePageTitle } from "@/components/page";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Badge, Tip } from "@/components/ui/misc";
import { PipelineMapFull } from "@/components/pipeline-map";
import { VersionSelect } from "@/components/pipeline-tabs";
import { ForkDialog } from "@/components/fork-dialog";

/**
 * Pipeline Studio's step editor, for a Nextflow pipeline you copied: change its steps on the graph; each save is a new version.
 * (The other Studio editor, /studio, builds a pipeline from modules on a canvas.)
 */
export default function StudioPipelinePage() {
  const { id = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const user = useAuth((s) => s.user);
  const p = useQuery({ queryKey: ["pipeline", id], queryFn: () => api.get<PipelineDetail>(`/api/pipelines/${id}`) });
  const d = p.data;
  usePageTitle(d ? "Step editor" : null, [{ label: "Pipelines", to: "/pipelines" }, ...(d ? [{ label: d.name, to: `/pipelines/${d.id}/map` }] : [])]);
  const versionId = sp.get("version") ?? undefined;
  const current = versionId ?? d?.latest_version?.id ?? "";
  const dirty = useRef(false);
  const [fork, setFork] = useState<{ versionId?: string; version?: string } | null>(null);
  const mine = !!d && d.can_edit && (d.source_url ?? "").match(/^(copy|duplicate):/) && d.kind !== "studio";
  const switchVersion = async (vid: string | undefined) => {
    if (dirty.current && !(await confirmDialog({
      title: "Discard unsaved step settings?", body: "The step settings you changed have not been saved. Switching to another version discards them.",
      confirmLabel: "Discard and switch", cancelLabel: "Keep editing", danger: true,
    }))) return;
    setSp(vid ? { version: vid } : {}, { replace: true });
  };
  const toolbar = (
    <>
      <Workflow className="size-4 text-accent" />
      <span className="max-w-[28ch] truncate text-[14px] font-semibold" title={d?.name}>{d?.name ?? "Pipeline"}</span>
      <Tip content="Pipeline Studio has two editors. This one changes the steps of a Nextflow pipeline you copied: switch steps off, change their settings, add or remove steps. The other one (Pipeline Studio in the menu) builds a new pipeline from modules.">
        <Badge tone="accent" className="cursor-help" tabIndex={0}>Step editor</Badge>
      </Tip>
      {d && (mine ? <Badge tone="ok">Nextflow · your copy</Badge>
        : <Tip content="Originals are never changed. Edit as new pipeline makes your own copy to change."><Badge tone="wait" className="cursor-help" tabIndex={0}><Lock className="size-3" />read-only original</Badge></Tip>)}
      {d && <VersionSelect d={d} value={current} onChange={switchVersion} />}
      {d && <Button asChild size="sm" variant="ghost"><Link to={`/pipelines/${d.id}/map${qs({ version: versionId })}`} aria-label="Back to the pipeline" title="Back to the pipeline: map, parameters, versions, runs"><Network /><span className="hidden 2xl:inline">Pipeline</span></Link></Button>}
      {d && <Button asChild size="sm" variant="secondary" title="Configure and run this version"><Link to={`/jobs/new${qs({ pipeline: d.id, version: versionId })}`}><Play />Run</Link></Button>}
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
