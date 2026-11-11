import { memo, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider,
  type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import { AlertTriangle, Box, Copy, Database, FileCode2, Layers, Pencil, Workflow } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import type { StudioModule } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/theme";
import { Button } from "@/components/ui/button";
import { Badge, Panel, Skeleton } from "@/components/ui/misc";
import { nodeTypes as studioNodeTypes } from "@/components/studio/module-node";
import { deserialize, effective, StudioContext, type PortTypes, type StudioNode } from "@/components/studio/model";

interface NfNode extends Record<string, unknown> {
  id: string; kind: "input" | "process" | "subworkflow"; label: string; name?: string; file?: string | null; detail?: string;
  outputs?: string[]; container?: string | null; resource_label?: string | null; condition?: string | null; steps?: string[] | null;
  position: { x: number; y: number };
}
interface NfMap { ok: boolean; reason?: string; workflow?: string; file?: string; nodes: NfNode[]; edges: { id: string; source: string; target: string }[] }
interface MapResponse {
  kind: "studio" | "nextflow" | "none"; reason?: string; version_id?: string; version?: string;
  studio?: { workflow_id: string; workflow_exists: boolean; can_view_workflow: boolean; can_edit: boolean; graph: { nodes: unknown[]; edges: unknown[] } | null;
    exact: boolean; next_version: string; latest: boolean };
  nextflow?: NfMap;
}

/** Pipeline page: what the pipeline does, step by step, for the selected version; Studio pipelines open in Studio from here. */
export default function PipelineMap(props: { pid: string; versionId?: string; canCopy: boolean; onCopy: () => void }) {
  return <ReactFlowProvider><MapInner {...props} /></ReactFlowProvider>;
}

function MapInner({ pid, versionId, canCopy, onCopy }: { pid: string; versionId?: string; canCopy: boolean; onCopy: () => void }) {
  const q = useQuery({ queryKey: ["pipeline-map", pid, versionId ?? null], queryFn: () => api.get<MapResponse>(`/api/pipelines/${pid}/map${qs({ version_id: versionId })}`) });
  if (q.isLoading) return <Skeleton className="h-[560px]" />;
  if (q.isError) return <Panel className="p-4 text-[13px] text-bad">{errMsg(q.error)}</Panel>;
  const m = q.data!;
  if (m.kind === "none") return <Panel className="p-6 text-[13px] text-muted">No map for this pipeline: {m.reason}</Panel>;

  if (m.kind === "studio" && m.studio) {
    const s = m.studio;
    const editTo = `/studio/${s.workflow_id}${s.latest && s.exact ? "" : `${qs({ pipeline: pid, version: m.version_id })}`}`;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <p className="min-w-0 flex-1 text-muted">
            {s.graph ? <>Built in Pipeline Studio. This is the graph of <b className="font-medium text-text">{m.version}</b>.</>
              : <>{m.version} was published before BioCompute kept Studio graphs with each version, so this map is read from its generated code.</>}
            {s.can_edit && !s.graph && !s.latest && <> Studio can open the current workflow, not this version.</>}
            {s.can_edit && <> Change it in Studio and <b className="font-medium text-text">Publish</b> to save it as <b className="font-medium text-text">{s.next_version}</b>; earlier versions stay available.</>}
            {!s.can_edit && s.workflow_exists && <> It belongs to someone else: make your own copy to change it.</>}
          </p>
          {s.can_edit && (
            <Button asChild variant="primary">
              <Link to={s.graph ? editTo : `/studio/${s.workflow_id}`}><Pencil />{s.latest ? "Edit in Pipeline Studio" : s.graph ? `Edit ${m.version} in Pipeline Studio` : "Open the current workflow in Studio"}</Link>
            </Button>
          )}
          {!s.can_edit && s.can_view_workflow && <Button asChild variant="secondary"><Link to={`/studio/${s.workflow_id}`}><Workflow />Open in Studio (read-only)</Link></Button>}
          {!s.can_edit && canCopy && <Button variant="primary" onClick={onCopy}><Copy />Make my own copy</Button>}
        </div>
        {s.graph ? <StudioGraph graph={s.graph} /> : m.nextflow?.ok ? <NextflowGraph map={m.nextflow} /> : null}
      </div>
    );
  }

  const nf = m.nextflow!;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3 text-[13px] text-muted">
        <FileCode2 className="mt-0.5 size-4 shrink-0" />
        <p className="min-w-0 flex-1">
          Read from the Nextflow code: workflow <span className="font-mono text-text">{nf.workflow}</span> in <span className="font-mono">{nf.file}</span>.
          Arrows follow the channels in the code; steps with a condition only run when it holds. This pipeline is written in Nextflow,
          so it is changed in its code (then fetch or import the new version), not in Studio.
        </p>
      </div>
      <NextflowGraph map={nf} />
    </div>
  );
}

const frameCls = "relative h-[560px] overflow-hidden rounded-lg border border-line bg-ink/40";

function StudioGraph({ graph }: { graph: { nodes: unknown[]; edges: unknown[] } }) {
  const { theme } = useTheme();
  const mods = useQuery({ queryKey: ["studio-modules"], queryFn: () => api.get<{ modules: StudioModule[]; port_types: PortTypes }>("/api/studio/modules"), staleTime: 300_000 });
  const modIndex = useMemo(() => Object.fromEntries((mods.data?.modules ?? []).map((x) => [x.id, x])), [mods.data]);
  const portTypes = mods.data?.port_types ?? {};
  const g = useMemo(() => deserialize(graph), [graph]);
  const [sel, setSel] = useState<StudioNode | null>(null);
  const edges = useMemo(() => g.edges.map((e) => {
    const src = g.nodes.find((n) => n.id === e.source);
    const out = src ? effective(modIndex[src.data.module], src.data).outputs.find((p) => `out:${p.name}` === e.sourceHandle) : undefined;
    return { ...e, selectable: false, style: { stroke: portTypes[out?.type ?? "any"]?.color ?? "rgb(var(--muted))", strokeWidth: 1.75 } };
  }), [g, modIndex, portTypes]);
  const ctx = useMemo(() => ({ modules: modIndex, portTypes, issuesByNode: {} }), [modIndex, portTypes]);
  if (mods.isLoading) return <Skeleton className="h-[560px]" />;
  const mod = sel ? modIndex[sel.data.module] : undefined;
  const params = Object.entries(sel?.data.params ?? {}).filter(([, v]) => v !== "" && v !== null && v !== undefined);
  return (
    <StudioContext.Provider value={ctx}>
      <div className={frameCls}>
        <ReactFlow<StudioNode, Edge> nodes={g.nodes} edges={edges} nodeTypes={studioNodeTypes} colorMode={theme}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable edgesFocusable={false} deleteKeyCode={null}
          onNodeClick={(_, n) => setSel(n)} onPaneClick={() => setSel(null)}
          fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.15} maxZoom={2} proOptions={{ hideAttribution: true }}>
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="rgb(var(--line))" />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap position="bottom-right" pannable zoomable className="!rounded-md !border !border-line" nodeColor={() => "rgb(var(--accent))"} maskColor="rgb(var(--ink) / 0.6)" />
        </ReactFlow>
        {sel && (
          <div className="absolute right-3 top-3 z-10 w-72 space-y-2 rounded-lg border border-line bg-surface p-3 text-[12.5px] shadow-lg">
            <p className="font-medium">{sel.data.label}</p>
            {mod && <p className="text-muted">{mod.name}{mod.description ? `: ${mod.description}` : ""}</p>}
            {params.length > 0 ? (
              <dl className="space-y-1">{params.map(([k, v]) => (
                <div key={k} className="flex gap-2"><dt className="shrink-0 text-muted">{k.replace(/_/g, " ")}</dt><dd className="min-w-0 break-all font-mono text-[11.5px]">{String(v)}</dd></div>
              ))}</dl>
            ) : <p className="text-muted">Default settings.</p>}
          </div>
        )}
      </div>
    </StudioContext.Provider>
  );
}

type NfFlowNode = Node<NfNode, "nf">;

const NfNodeView = memo(function NfNodeView({ data, selected }: NodeProps<NfFlowNode>) {
  const Icon = data.kind === "input" ? Database : data.kind === "subworkflow" ? Layers : Box;
  return (
    <div className={cn("w-[220px] rounded-lg border bg-surface text-[12px] shadow-md shadow-black/20", selected ? "border-accent ring-2 ring-accent/25" : "border-line",
      data.condition && "border-dashed")}>
      {data.kind !== "input" && <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-muted" />}
      <div className={cn("flex items-center gap-2 rounded-t-lg px-2.5 py-2", data.kind === "input" ? "bg-run/10" : data.kind === "subworkflow" ? "bg-accent/10" : "bg-raised/60")}>
        <Icon className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate font-medium" title={data.label}>{data.label}</span>
          {data.name && data.name !== data.label && <span className="block truncate text-[10.5px] text-muted">{data.name}</span>}
          {data.kind === "input" && <span className="block truncate text-[10.5px] text-muted">{data.detail}</span>}
        </span>
        {data.container && <span className="truncate rounded bg-ink/40 px-1 text-[10px] text-muted" title={`container: ${data.container}`}>{data.container}</span>}
      </div>
      {(data.condition || data.steps?.length || data.outputs?.length) ? (
        <div className="space-y-1 border-t border-line/60 px-2.5 py-1.5 text-[11px] text-muted">
          {data.condition && <p className="truncate text-wait" title={data.condition}>only if {data.condition}</p>}
          {data.steps?.length ? <p className="truncate" title={data.steps.join(", ")}>{data.steps.length} steps: {data.steps.join(", ")}</p> : null}
          {data.outputs?.length ? <p className="truncate" title={data.outputs.join(", ")}>→ {data.outputs.filter((o) => o !== "versions").join(", ")}</p> : null}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-muted" />
    </div>
  );
});
const nfNodeTypes = { nf: NfNodeView };

function NextflowGraph({ map }: { map: NfMap }) {
  const { theme } = useTheme();
  const [sel, setSel] = useState<NfNode | null>(null);
  const nodes = useMemo<NfFlowNode[]>(() => map.nodes.map((n) => ({ id: n.id, type: "nf", position: n.position, data: n })), [map]);
  const edges = useMemo<Edge[]>(() => map.edges.map((e) => ({ ...e, selectable: false, style: { stroke: "rgb(var(--muted))", strokeWidth: 1.5 } })), [map]);
  if (!map.ok) return <Panel className="p-4 text-[13px] text-muted"><AlertTriangle className="mr-1 inline size-4" />{map.reason}</Panel>;
  return (
    <div className={frameCls}>
      <ReactFlow<NfFlowNode, Edge> nodes={nodes} edges={edges} nodeTypes={nfNodeTypes} colorMode={theme}
        nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null}
        onNodeClick={(_, n) => setSel(n.data)} onPaneClick={() => setSel(null)}
        fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.1} maxZoom={2} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="rgb(var(--line))" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap position="bottom-right" pannable zoomable className="!rounded-md !border !border-line" nodeColor={() => "rgb(var(--accent))"} maskColor="rgb(var(--ink) / 0.6)" />
      </ReactFlow>
      {sel && (
        <div className="absolute right-3 top-3 z-10 w-72 space-y-1.5 rounded-lg border border-line bg-surface p-3 text-[12.5px] shadow-lg">
          <p className="flex items-center gap-2 font-medium">{sel.label}<Badge>{sel.kind}</Badge></p>
          {sel.name && sel.name !== sel.label && <p className="text-muted">{sel.kind === "subworkflow" ? "workflow" : "process"} {sel.name}</p>}
          {sel.file && <p className="break-all font-mono text-[11.5px] text-muted">{sel.file}</p>}
          {sel.detail && <p className="text-muted">{sel.detail}</p>}
          {sel.container && <p><span className="text-muted">container</span> {sel.container}</p>}
          {sel.resource_label && <p><span className="text-muted">resources</span> {sel.resource_label}</p>}
          {sel.condition && <p className="text-wait">only if {sel.condition}</p>}
          {sel.steps?.length ? <p><span className="text-muted">steps</span> {sel.steps.join(", ")}</p> : null}
          {sel.outputs?.length ? <p><span className="text-muted">outputs</span> {sel.outputs.join(", ")}</p> : null}
        </div>
      )}
    </div>
  );
}
