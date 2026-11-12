import { useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Play, Workflow } from "lucide-react";
import { api, qs } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { PipelineDetail } from "@/lib/types";
import { usePageTitle } from "@/components/page";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Badge } from "@/components/ui/misc";
import { PipelineMapFull } from "@/components/pipeline-map";
import { PipelineTabs, VersionSelect } from "@/components/pipeline-tabs";
import { ForkDialog } from "@/components/fork-dialog";

/** The Map tab of a pipeline, full-window and laid out like Pipeline Studio: steps on the left, the graph, details on the right. */
export default function PipelineMapPage() {
  const { id = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const user = useAuth((s) => s.user);
  const p = useQuery({ queryKey: ["pipeline", id], queryFn: () => api.get<PipelineDetail>(`/api/pipelines/${id}`) });
  const dirty = useRef(false);
  const [fork, setFork] = useState<{ versionId?: string; version?: string; studio: boolean } | null>(null);
  const d = p.data;
  usePageTitle(d?.name, [{ label: "Pipelines", to: "/pipelines" }]);
  const versionId = sp.get("version") ?? undefined;
  const current = versionId ?? d?.latest_version?.id ?? "";
  const switchVersion = async (vid: string | undefined) => {
    if (dirty.current && !(await confirmDialog({
      title: "Discard unsaved step settings?", body: "The step settings you changed have not been saved. Switching to another version discards them.",
      confirmLabel: "Discard and switch", cancelLabel: "Keep editing", danger: true,
    }))) return;
    setSp(vid ? { version: vid } : {}, { replace: true });
  };
  const toolbar = (
    <>
      <Button asChild size="icon" variant="ghost" aria-label="All pipelines" title="All pipelines"><Link to="/pipelines"><ArrowLeft /></Link></Button>
      <Workflow className="size-4 text-accent" />
      <span className="max-w-[28ch] truncate text-[14px] font-semibold" title={d?.name}>{d?.name ?? "Pipeline"}</span>
      {d && <Badge tone={d.kind === "studio" ? "ok" : "neutral"} title={d.kind === "studio" ? "Built from modules in Pipeline Studio" : "A pipeline written as Nextflow code"}>{d.kind === "studio" ? "Built in Studio" : "Nextflow code"}</Badge>}
      {d && <VersionSelect d={d} value={current} onChange={switchVersion} />}
      {d && <Button asChild size="sm" variant="secondary" title="Configure and run this version"><Link to={`/jobs/new${qs({ pipeline: d.id, version: versionId })}`}><Play />Run</Link></Button>}
    </>
  );
  return (
    <>
      <PipelineMapFull pid={id} versionId={versionId} toolbar={toolbar} canFork={can(user, "scientist")} onDirty={(x) => { dirty.current = x; }}
        tabs={d && <PipelineTabs compact pid={id} kind={d.kind} hasReadme={!!d.readme} runCount={d.run_count} active="map" versionId={versionId} />}
        onFork={(m) => setFork({ versionId: m.version_id, version: m.version, studio: m.kind === "studio" })} />
      {d && <ForkDialog open={!!fork} onOpenChange={(o) => !o && setFork(null)} pid={d.id} name={d.name} version={fork?.version} versionId={fork?.versionId} studio={!!fork?.studio} />}
    </>
  );
}
