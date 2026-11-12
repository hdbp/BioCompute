import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow,
  type Edge, type Node, type NodeProps, type NodeTypes,
} from "@xyflow/react";
import { ArrowLeft, ArrowRight, Box, Copy, Database, FileCode2, FileInput, FolderOutput, Layers, Maximize2, Pencil, Search, Workflow } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import type { StudioModule } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/theme";
import { Button } from "@/components/ui/button";
import { Badge, Panel, Skeleton } from "@/components/ui/misc";
import { nodeTypes as studioNodeTypes } from "@/components/studio/module-node";
import { deserialize, effective, StudioContext, type PortTypes, type StudioCtx } from "@/components/studio/model";

// ---------------------------------------------------------------------------- data
interface NfNode extends Record<string, unknown> {
  id: string; kind: "input" | "process" | "subworkflow"; label: string; name?: string; file?: string | null; detail?: string;
  outputs?: string[]; container?: string | null; resource_label?: string | null; condition?: string | null; steps?: string[] | null;
  position: { x: number; y: number };
}
interface NfMap { ok: boolean; reason?: string; workflow?: string; file?: string; nodes: NfNode[]; edges: { id: string; source: string; target: string }[] }
export interface MapResponse {
  kind: "studio" | "nextflow" | "none"; reason?: string; version_id?: string; version?: string;
  studio?: { workflow_id: string; workflow_exists: boolean; can_view_workflow: boolean; can_edit: boolean; graph: { nodes: unknown[]; edges: unknown[] } | null;
    exact: boolean; next_version: string; latest: boolean };
  nextflow?: NfMap;
}

export function usePipelineMap(pid: string | undefined, versionId?: string) {
  return useQuery({
    queryKey: ["pipeline-map", pid, versionId ?? null], enabled: !!pid,
    queryFn: () => api.get<MapResponse>(`/api/pipelines/${pid}/map${qs({ version_id: versionId })}`),
  });
}

/** One step in the list / inspector, whatever the pipeline kind. */
interface Item { id: string; label: string; sub?: string; group: "Inputs" | "Steps" | "Outputs"; icon: typeof Box; hint?: string }
interface MapView {
  kind: "studio" | "nextflow";
  nodes: Node[]; edges: Edge[]; nodeTypes: NodeTypes; ctx?: StudioCtx;
  items: Item[]; details: (id: string) => ReactNode;
}

function useMapView(m: MapResponse | undefined): { view: MapView | null; loading: boolean } {
  const graph = m?.kind === "studio" ? m.studio?.graph ?? null : null;
  const mods = useQuery({
    queryKey: ["studio-modules"], enabled: !!graph, staleTime: 300_000,
    queryFn: () => api.get<{ modules: StudioModule[]; port_types: PortTypes }>("/api/studio/modules"),
  });
  const view = useMemo<MapView | null>(() => {
    if (!m) return null;
    if (graph) {
      if (!mods.data) return null;
      const modIndex = Object.fromEntries(mods.data.modules.map((x) => [x.id, x]));
      const portTypes = mods.data.port_types;
      const g = deserialize(graph);
      const edges = g.edges.map((e) => {
        const src = g.nodes.find((n) => n.id === e.source);
        const out = src ? effective(modIndex[src.data.module], src.data).outputs.find((p) => `out:${p.name}` === e.sourceHandle) : undefined;
        return { ...e, selectable: false, style: { stroke: portTypes[out?.type ?? "any"]?.color ?? "rgb(var(--muted))", strokeWidth: 1.75 } };
      });
      const items: Item[] = g.nodes.map((n) => {
        const mod = modIndex[n.data.module];
        const group = mod?.kind === "source" ? "Inputs" : mod?.kind === "sink" ? "Outputs" : "Steps";
        const icon = mod?.kind === "source" ? (mod.id === "input_file" ? Database : FileInput) : mod?.kind === "sink" ? FolderOutput : Layers;
        const pn = n.data.params?.param_name;
        return { id: n.id, label: n.data.label, sub: pn ? `params.${pn}` : mod && mod.name !== n.data.label ? mod.name : undefined, group, icon };
      });
      const details = (id: string) => {
        const n = g.nodes.find((x) => x.id === id);
        if (!n) return null;
        const mod = modIndex[n.data.module];
        const spec = effective(mod, n.data);
        const params = Object.entries(n.data.params ?? {}).filter(([, v]) => v !== "" && v !== null && v !== undefined);
        return (
          <>
            {mod && <Section title="Module"><p>{mod.name}</p>{mod.description && <p className="text-muted">{mod.description}</p>}
              {mod.tools?.length ? <p className="text-muted">tools: {mod.tools.join(", ")}</p> : null}</Section>}
            <Section title="Settings">
              {params.length ? <dl className="space-y-1">{params.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[minmax(0,40%)_1fr] gap-2"><dt className="truncate text-muted" title={k}>{k.replace(/_/g, " ")}</dt><dd className="min-w-0 break-all font-mono text-[11.5px]">{String(v)}</dd></div>
              ))}</dl> : <p className="text-muted">Default settings.</p>}
            </Section>
            {(spec.inputs.length > 0 || spec.outputs.length > 0) && (
              <Section title="Ports">
                {spec.inputs.length > 0 && <p><span className="text-muted">in</span> {spec.inputs.map((p) => `${p.name} (${portTypes[p.type]?.label ?? p.type})`).join(", ")}</p>}
                {spec.outputs.length > 0 && <p><span className="text-muted">out</span> {spec.outputs.map((p) => `${p.name} (${portTypes[p.type]?.label ?? p.type})`).join(", ")}</p>}
              </Section>
            )}
          </>
        );
      };
      return { kind: "studio", nodes: g.nodes, edges, nodeTypes: studioNodeTypes, ctx: { modules: modIndex, portTypes, issuesByNode: {} }, items, details };
    }
    const nf = m.nextflow;
    if (!nf?.ok) return null;
    const nodes: Node[] = nf.nodes.map((n) => ({ id: n.id, type: "nf", position: n.position, data: n }));
    const edges: Edge[] = nf.edges.map((e) => ({ ...e, selectable: false, style: { stroke: "rgb(var(--muted))", strokeWidth: 1.5 } }));
    const items: Item[] = nf.nodes.map((n) => ({
      id: n.id, label: n.label, sub: n.name && n.name !== n.label ? n.name : n.kind === "input" ? n.detail : n.container ?? undefined,
      group: n.kind === "input" ? "Inputs" : "Steps", icon: n.kind === "input" ? Database : n.kind === "subworkflow" ? Layers : Box,
      hint: n.condition ? `only if ${n.condition}` : undefined,
    }));
    const details = (id: string) => {
      const n = nf.nodes.find((x) => x.id === id);
      if (!n) return null;
      return (
        <>
          <Section title={n.kind === "input" ? "Input" : n.kind === "subworkflow" ? "Subworkflow" : "Process"}>
            {n.name && n.name !== n.label && <p>{n.kind === "subworkflow" ? "workflow" : "process"} <span className="font-mono">{n.name}</span></p>}
            {n.detail && <p className="text-muted">{n.detail}</p>}
            {n.file && <p className="break-all font-mono text-[11.5px] text-muted">{n.file}</p>}
          </Section>
          {(n.container || n.resource_label) && (
            <Section title="Runs with">
              {n.container && <p><span className="text-muted">container</span> {n.container}</p>}
              {n.resource_label && <p><span className="text-muted">resources</span> {n.resource_label}</p>}
            </Section>
          )}
          {n.condition && <Section title="Condition"><p className="font-mono text-[11.5px] text-wait">{n.condition}</p></Section>}
          {n.steps?.length ? <Section title={`Steps inside (${n.steps.length})`}><ul className="space-y-0.5 font-mono text-[11.5px]">{n.steps.map((s) => <li key={s}>{s}</li>)}</ul></Section> : null}
          {n.outputs?.length ? <Section title="Outputs"><p className="font-mono text-[11.5px]">{n.outputs.join(", ")}</p></Section> : null}
        </>
      );
    };
    return { kind: "nextflow", nodes, edges, nodeTypes: nfNodeTypes, items, details };
  }, [m, graph, mods.data]);
  return { view, loading: !!graph && mods.isLoading };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1 border-t border-line/60 px-4 py-3 first:border-t-0">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted">{title}</h4>
      <div className="space-y-1 text-[12.5px]">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------- Nextflow node
type NfFlowNode = Node<NfNode, "nf">;
const NfNodeView = memo(function NfNodeView({ data, selected }: NodeProps<NfFlowNode>) {
  const Icon = data.kind === "input" ? Database : data.kind === "subworkflow" ? Layers : Box;
  return (
    <div className={cn("w-[220px] rounded-lg border bg-surface text-[12px] shadow-lg shadow-black/20", selected ? "border-accent ring-2 ring-accent/25" : "border-line",
      data.condition && !selected && "border-dashed")}>
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
const nfNodeTypes: NodeTypes = { nf: NfNodeView };

// ---------------------------------------------------------------------------- pieces
const READABLE = 0.85; // below this zoom node text is too small to read
function Canvas({ view, selected, onSelect, focus }: { view: MapView; selected: string | null; onSelect: (id: string | null) => void; focus: number }) {
  const { theme } = useTheme();
  const rf = useReactFlow();
  // React Flow's own node state, so it can record the measured sizes (needed before placing the view)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(view.nodes);
  useEffect(() => setNodes(view.nodes), [view.nodes, setNodes]);
  useEffect(() => setNodes((ns) => ns.map((n) => (n.selected === (n.id === selected) ? n : { ...n, selected: n.id === selected }))), [selected, view.nodes, setNodes]);
  const box = useRef<HTMLDivElement>(null);
  const ready = useNodesInitialized();
  const placed = useRef<MapView | null>(null);
  // first view: the whole pipeline when it fits at a readable size; otherwise readable, starting at its inputs (pan for the rest)
  useEffect(() => {
    if (!ready || placed.current === view || !box.current) return;
    placed.current = view;
    const { width: w, height: h } = box.current.getBoundingClientRect();
    const b = rf.getNodesBounds(view.nodes.map((n) => n.id));
    const pad = 48;
    const fit = Math.min((w - 2 * pad) / Math.max(b.width, 1), (h - 2 * pad) / Math.max(b.height, 1), 1);
    if (fit >= READABLE) rf.fitView({ padding: 0.12, maxZoom: 1 });
    else {
      const z = READABLE;
      const y = b.height * z <= h - 2 * pad ? h / 2 - (b.y + b.height / 2) * z : pad - b.y * z;
      rf.setViewport({ x: pad - b.x * z, y, zoom: z });
    }
  }, [ready, view, rf]);
  // a step picked in the list: bring it into view (after the details panel has opened and narrowed the canvas)
  useEffect(() => {
    if (!focus || !selected) return;
    const t = setTimeout(() => rf.fitView({ nodes: [{ id: selected }], maxZoom: 1.1, minZoom: READABLE, padding: 0.5, duration: 350 }), 60);
    return () => clearTimeout(t);
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const flow = (
    <ReactFlow nodes={nodes} edges={view.edges} nodeTypes={view.nodeTypes} colorMode={theme} onNodesChange={onNodesChange}
      nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null} multiSelectionKeyCode={null}
      onNodeClick={(_, n) => onSelect(n.id)} onPaneClick={() => onSelect(null)}
      minZoom={0.1} maxZoom={2} proOptions={{ hideAttribution: true }}>
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="rgb(var(--line))" />
      <Controls position="bottom-left" showInteractive={false} />
      <MiniMap position="bottom-right" pannable zoomable className="!rounded-md !border !border-line"
        nodeColor={(n) => (n.id === selected ? "rgb(var(--wait))" : "rgb(var(--accent))")} maskColor="rgb(var(--ink) / 0.6)" />
    </ReactFlow>
  );
  return <div ref={box} className="h-full w-full">{view.ctx ? <StudioContext.Provider value={view.ctx}>{flow}</StudioContext.Provider> : flow}</div>;
}

function StepList({ view, selected, onPick }: { view: MapView; selected: string | null; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const shown = view.items.filter((i) => !ql || `${i.label} ${i.sub ?? ""}`.toLowerCase().includes(ql));
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface md:flex" aria-label="Steps">
      <div className="space-y-2 border-b border-line p-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a step" aria-label="Find a step"
            className="h-8 w-full rounded-md border border-line bg-ink/40 pl-8 pr-2 text-[13px] placeholder:text-muted/70 focus:border-accent focus:outline-none" />
        </label>
        <p className="text-[11.5px] text-muted">{plural(view.items.filter((i) => i.group === "Steps").length, "step")} · click one to find it on the map</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {(["Inputs", "Steps", "Outputs"] as const).map((g) => {
          const items = shown.filter((i) => i.group === g);
          if (!items.length) return null;
          return (
            <div key={g} className="py-1">
              <p className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">{g}</p>
              {items.map((i) => (
                <button key={i.id} onClick={() => onPick(i.id)} aria-current={selected === i.id}
                  className={cn("flex w-full items-start gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-raised", selected === i.id && "bg-accent/10 text-text")}>
                  <i.icon className="mt-0.5 size-3.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{i.label}</span>
                    {i.sub && <span className="block truncate text-[11px] text-muted">{i.sub}</span>}
                    {i.hint && <span className="block truncate text-[11px] text-wait">{i.hint}</span>}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
        {!shown.length && <p className="px-3 py-2 text-[13px] text-muted">No step matches.</p>}
      </div>
    </aside>
  );
}

function Inspector({ view, id, onPick, floating }: { view: MapView; id: string; onPick: (id: string) => void; floating?: boolean }) {
  const item = view.items.find((i) => i.id === id);
  if (!item) return null;
  const name = (x: string) => view.items.find((i) => i.id === x)?.label ?? x;
  const ups = [...new Set(view.edges.filter((e) => e.target === id).map((e) => e.source))];
  const downs = [...new Set(view.edges.filter((e) => e.source === id).map((e) => e.target))];
  const Link_ = ({ ids, dir }: { ids: string[]; dir: "from" | "to" }) => (
    <div className="flex flex-wrap gap-1">
      {ids.map((x) => (
        <button key={x} onClick={() => onPick(x)} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-px text-[11.5px] hover:border-accent hover:text-text">
          {dir === "from" && <ArrowLeft className="size-3" />}{name(x)}{dir === "to" && <ArrowRight className="size-3" />}
        </button>
      ))}
    </div>
  );
  return (
    <aside className={cn("flex flex-col bg-surface", floating ? "absolute right-3 top-3 z-10 max-h-[calc(100%-1.5rem)] w-80 rounded-lg border border-line shadow-xl" : "w-80 shrink-0 border-l border-line")}
      aria-label="Step details">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <item.icon className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
        <Badge>{item.group === "Steps" ? "step" : item.group === "Inputs" ? "input" : "output"}</Badge>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view.details(id)}
        {(ups.length > 0 || downs.length > 0) && (
          <Section title="Connected to">
            {ups.length > 0 && <div className="space-y-1"><p className="text-[11.5px] text-muted">receives from</p><Link_ ids={ups} dir="from" /></div>}
            {downs.length > 0 && <div className="space-y-1"><p className="text-[11.5px] text-muted">sends to</p><Link_ ids={downs} dir="to" /></div>}
          </Section>
        )}
      </div>
    </aside>
  );
}

/** What this map is and what can be done with it. */
function Explanation({ m }: { m: MapResponse }) {
  const s = m.studio;
  if (m.kind === "studio" && s) {
    return (
      <>
        {s.graph ? <>Built in Pipeline Studio: the graph of <b className="font-medium text-text">{m.version}</b>.</>
          : <>{m.version} was published before graphs were kept with each version; this map is read from its generated code.</>}
        {s.can_edit && !s.graph && !s.latest && <> Studio can open the current workflow, not this version.</>}
        {s.can_edit && <> Change it in Studio and <b className="font-medium text-text">Publish</b> to save it as <b className="font-medium text-text">{s.next_version}</b>; earlier versions stay available.</>}
        {!s.can_edit && s.workflow_exists && <> It belongs to someone else: make your own copy to change it.</>}
      </>
    );
  }
  const nf = m.nextflow;
  return (
    <>Read from the Nextflow code: workflow <span className="font-mono text-text">{nf?.workflow}</span> in <span className="font-mono">{nf?.file}</span>.
      Arrows follow the channels in the code, dashed steps only run when their condition holds. Nextflow pipelines are changed in their code, not in Studio.</>
  );
}

function Actions({ m, pid, canCopy, onCopy, size }: { m: MapResponse; pid: string; canCopy: boolean; onCopy?: () => void; size?: "sm" }) {
  const s = m.studio;
  if (m.kind !== "studio" || !s) return null;
  const editTo = s.graph && !(s.latest && s.exact) ? `/studio/${s.workflow_id}${qs({ pipeline: pid, version: m.version_id })}` : `/studio/${s.workflow_id}`;
  return (
    <>
      {s.can_edit && (
        <Button asChild size={size} variant="primary">
          <Link to={editTo}><Pencil />{s.latest ? "Edit in Pipeline Studio" : s.graph ? `Edit ${m.version} in Studio` : "Open current workflow in Studio"}</Link>
        </Button>
      )}
      {!s.can_edit && s.can_view_workflow && <Button asChild size={size} variant="secondary"><Link to={`/studio/${s.workflow_id}`}><Workflow />Open in Studio (read-only)</Link></Button>}
      {!s.can_edit && canCopy && onCopy && <Button size={size} variant="primary" onClick={onCopy}><Copy />Make my own copy</Button>}
    </>
  );
}

// ---------------------------------------------------------------------------- inline preview (pipeline page, launch form)
/** Map inside a page: fills the window height; "Open full view" gives the Studio-like page. */
export default function PipelineMap(props: { pid: string; versionId?: string; canCopy: boolean; onCopy: () => void; newTab?: boolean }) {
  return <ReactFlowProvider><Preview {...props} /></ReactFlowProvider>;
}

function Preview({ pid, versionId, canCopy, onCopy, newTab }: { pid: string; versionId?: string; canCopy: boolean; onCopy: () => void; newTab?: boolean }) {
  const q = usePipelineMap(pid, versionId);
  const { view, loading } = useMapView(q.data);
  const [sel, setSel] = useState<string | null>(null);
  const h = "h-[max(520px,calc(100dvh-17rem))]";
  if (q.isLoading || loading) return <Skeleton className={h} />;
  if (q.isError) return <Panel className="p-4 text-[13px] text-bad">{errMsg(q.error)}</Panel>;
  const m = q.data!;
  if (m.kind === "none" || !view) return <Panel className="p-6 text-[13px] text-muted">No map for this pipeline{m.reason ? `: ${m.reason}` : m.nextflow?.reason ? `: ${m.nextflow.reason}` : ""}.</Panel>;
  const full = `/pipelines/${pid}/map${qs({ version: versionId })}`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {m.kind === "nextflow" && <FileCode2 className="size-4 shrink-0 text-muted" />}
        <p className="min-w-0 flex-1 text-muted"><Explanation m={m} /></p>
        <Button asChild variant="secondary">
          <Link to={full} target={newTab ? "_blank" : undefined}><Maximize2 />Open full view</Link>
        </Button>
        <Actions m={m} pid={pid} canCopy={canCopy} onCopy={onCopy} />
      </div>
      <div className={cn("relative overflow-hidden rounded-lg border border-line bg-ink/40", h)}>
        <Canvas view={view} selected={sel} onSelect={setSel} focus={0} />
        {sel && <Inspector view={view} id={sel} onPick={setSel} floating />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- full view (its own page)
export function PipelineMapFull(props: {
  pid: string; versionId?: string; toolbar: ReactNode; canCopy: boolean; onCopy: () => void;
}) {
  return <ReactFlowProvider><Full {...props} /></ReactFlowProvider>;
}

function Full({ pid, versionId, toolbar, canCopy, onCopy }: { pid: string; versionId?: string; toolbar: ReactNode; canCopy: boolean; onCopy: () => void }) {
  const q = usePipelineMap(pid, versionId);
  const { view, loading } = useMapView(q.data);
  const [sel, setSel] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  useEffect(() => setSel(null), [versionId]);
  const pick = (id: string | null) => { setSel(id); if (id) setFocus((f) => f + 1); };
  const m = q.data;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        {toolbar}
        <div className="flex-1" />
        {m && <Actions m={m} pid={pid} canCopy={canCopy} onCopy={onCopy} size="sm" />}
      </div>
      <div className="flex min-h-0 flex-1">
        {view && <StepList view={view} selected={sel} onPick={pick} />}
        <div className="relative min-w-0 flex-1 bg-ink/40">
          {(q.isLoading || loading) && <div className="flex h-full items-center justify-center text-[13px] text-muted">Loading the map…</div>}
          {q.isError && <p className="p-6 text-[13px] text-bad">{errMsg(q.error)}</p>}
          {m && (m.kind === "none" || (!view && !loading)) && <p className="p-6 text-[13px] text-muted">No map for this pipeline{m.reason ? `: ${m.reason}` : ""}.</p>}
          {view && <Canvas view={view} selected={sel} onSelect={setSel} focus={focus} />}
        </div>
        {view && sel && <Inspector view={view} id={sel} onPick={pick} />}
      </div>
      {m && view && (
        <div className="flex items-center gap-3 border-t border-line bg-surface px-3 py-1.5 text-[12px] text-muted">
          <span className="tabular-nums">{plural(view.items.filter((i) => i.group === "Steps").length, "step")}, {plural(view.edges.length, "connection")}</span>
          <span className="min-w-0 flex-1"><Explanation m={m} /></span>
        </div>
      )}
    </div>
  );
}
