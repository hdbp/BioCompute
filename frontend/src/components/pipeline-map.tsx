import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Background, BackgroundVariant, ControlButton, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow,
  type Edge, type Node, type NodeProps, type NodeTypes,
} from "@xyflow/react";
import { ArrowLeft, ArrowRight, Box, LayoutGrid, Database, FileCode2, FileInput, FolderOutput, GitFork, Layers, ListTree, Plus, RotateCcw, Save, Search, Trash2, Workflow, X } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import type { StudioModule } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/theme";
import { useUnsavedGuard } from "@/hooks/unsaved";
import { QueryError } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { nodeTypes as studioNodeTypes } from "@/components/studio/module-node";
import { deserialize, effective, StudioContext, type PortTypes, type StudioCtx } from "@/components/studio/model";
import { AddStepDialog, RemoveStepDialog } from "@/components/structure-dialogs";
import { cleanOverride, StepForm, stepStates, useStepSettings, type Overrides, type StepInfo, type StepOverride } from "@/components/step-settings";

// ---------------------------------------------------------------------------- data
interface NfNode extends Record<string, unknown> {
  id: string; kind: "input" | "process" | "subworkflow"; label: string; name?: string; file?: string | null; detail?: string;
  outputs?: string[]; output_shapes?: Record<string, string>; container?: string | null; resource_label?: string | null; condition?: string | null; steps?: string[] | null;
  step_info?: StepInfo[] | null; supports_when?: boolean; supports_args?: boolean; state?: "off" | "starved" | "edited";
  position: { x: number; y: number };
}
interface NfMap { ok: boolean; reason?: string; workflow?: string; file?: string; nodes: NfNode[]; edges: { id: string; source: string; target: string }[] }
export interface MapResponse {
  kind: "studio" | "nextflow" | "none"; reason?: string; version_id?: string; version?: string; copy_of?: string | null; can_edit_code?: boolean;
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
              <Section title="Inputs and outputs">
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
          <Section title={n.kind === "input" ? "Input" : n.kind === "subworkflow" ? "Group of steps" : "Step"}>
            {n.name && n.name !== n.label && <p><span className="text-muted">{n.kind === "subworkflow" ? "named in the code (workflow)" : "named in the code (process)"}</span> <span className="font-mono">{n.name}</span></p>}
            {n.detail && <p className="text-muted">{n.detail}</p>}
            {n.file && <p className="break-all font-mono text-[11.5px] text-muted">{n.file}</p>}
          </Section>
          {(n.container || n.resource_label) && (
            <Section title="Runs with">
              {n.container && <p><span className="text-muted">container</span> {n.container}</p>}
              {n.resource_label && <p><span className="text-muted">resources</span> {n.resource_label}</p>}
            </Section>
          )}
          {n.condition && <Section title="Only runs if"><p className="font-mono text-[11.5px] text-wait">{n.condition}</p></Section>}
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
    <div className={cn("w-[220px] rounded-lg border bg-surface text-[12px] shadow-lg shadow-black/20", selected ? "border-accent ring-2 ring-accent/25" : data.state === "edited" ? "border-wait/70" : "border-line",
      data.condition && !selected && "border-dashed", (data.state === "off" || data.state === "starved") && "opacity-45")}>
      {data.kind !== "input" && <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-muted" />}
      <div className={cn("flex items-center gap-2 rounded-t-lg px-2.5 py-2", data.kind === "input" ? "bg-run/10" : data.kind === "subworkflow" ? "bg-accent/10" : "bg-raised/60")}>
        <Icon className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate font-medium" title={data.label}>{data.label}</span>
          {data.name && data.name !== data.label && <span className="block truncate text-[10.5px] text-muted">{data.name}</span>}
          {data.kind === "input" && <span className="block truncate text-[10.5px] text-muted">{data.detail}</span>}
        </span>
        {data.state === "off" ? <span className="rounded bg-bad/15 px-1 text-[10px] font-medium text-bad">off</span>
          : data.state === "starved" ? <span className="rounded bg-ink/40 px-1 text-[10px] text-muted" title="Everything this step reads comes from steps that are off">no input</span>
          : data.state === "edited" ? <span className="rounded bg-wait/15 px-1 text-[10px] font-medium text-wait">edited</span>
          : data.container && <span className="truncate rounded bg-ink/40 px-1 text-[10px] text-muted" title={`container: ${data.container}`}>{data.container}</span>}
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

/** Where the user moved the steps of a pipeline (this browser only; the arrangement is not part of the pipeline). */
type Layout = Record<string, { x: number; y: number }>;
const layoutStore = (key: string) => `bc.map-layout.${key}`;
function readLayout(key: string): Layout {
  try { return JSON.parse(localStorage.getItem(layoutStore(key)) || "{}") as Layout; } catch { return {}; }
}
function writeLayout(key: string, l: Layout) {
  try {
    if (Object.keys(l).length) localStorage.setItem(layoutStore(key), JSON.stringify(l));
    else localStorage.removeItem(layoutStore(key));
  } catch { /* storage off: the arrangement lasts until the page is left */ }
}
const arranged = (ns: Node[], l: Layout) => ns.map((n) => (l[n.id] ? { ...n, position: l[n.id] } : n));

function Canvas({ view, selected, onSelect, focus, states, layoutKey }: {
  view: MapView; selected: string | null; onSelect: (id: string | null) => void; focus: number; states?: Record<string, string>; layoutKey: string;
}) {
  const { theme } = useTheme();
  const rf = useReactFlow();
  const layout = useRef<Layout>(readLayout(layoutKey));
  const [moved, setMoved] = useState(() => Object.keys(layout.current).length > 0);
  // React Flow's own node state, so it can record the measured sizes (needed before placing the view)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(arranged(view.nodes, layout.current));
  useEffect(() => {
    layout.current = readLayout(layoutKey);
    setMoved(Object.keys(layout.current).length > 0);
    setNodes(arranged(view.nodes, layout.current));
  }, [view.nodes, layoutKey, setNodes]);
  const saveDrag = (dragged: Node[]) => {
    for (const n of dragged) layout.current[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    writeLayout(layoutKey, layout.current);
    setMoved(true);
  };
  const resetLayout = () => {
    layout.current = {};
    writeLayout(layoutKey, {});
    setMoved(false);
    setNodes((ns) => ns.map((n) => {
      const auto = view.nodes.find((v) => v.id === n.id);
      return auto ? { ...n, position: auto.position } : n;
    }));
    setTimeout(() => rf.fitView({ padding: 0.12, maxZoom: 1, duration: 300 }), 30);
  };
  useEffect(() => setNodes((ns) => ns.map((n) => (n.selected === (n.id === selected) ? n : { ...n, selected: n.id === selected }))), [selected, view.nodes, setNodes]);
  useEffect(() => setNodes((ns) => ns.map((n) => {
    const st = states?.[n.id];
    return (n.data as { state?: string }).state === st ? n : { ...n, data: { ...n.data, state: st } };
  })), [states, view.nodes, setNodes]);
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
      nodesDraggable nodeDragThreshold={4} nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null} multiSelectionKeyCode={null}
      onNodeDragStop={(_, _n, dragged) => saveDrag(dragged)}
      onNodeClick={(_, n) => onSelect(n.id)} onPaneClick={() => onSelect(null)}
      minZoom={0.1} maxZoom={2} proOptions={{ hideAttribution: true }}>
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="rgb(var(--line))" />
      <Controls position="bottom-left" showInteractive={false}>
        <ControlButton onClick={resetLayout} disabled={!moved} title={moved ? "Arrange the steps automatically again" : "Drag steps to arrange them; this button puts them back"}
          aria-label="Arrange the steps automatically"><LayoutGrid /></ControlButton>
      </Controls>
      <MiniMap position="bottom-right" pannable zoomable className="!rounded-md !border !border-line"
        nodeColor={(n) => (n.id === selected ? "rgb(var(--wait))" : "rgb(var(--accent))")} maskColor="rgb(var(--ink) / 0.6)" />
    </ReactFlow>
  );
  return <div ref={box} className="h-full w-full">{view.ctx ? <StudioContext.Provider value={view.ctx}>{flow}</StudioContext.Provider> : flow}</div>;
}

/** The step list: a column from md up; below md a drawer over the canvas, opened from the toolbar (`open`). */
function StepList({ view, selected, onPick, onAdd, open, onClose }: {
  view: MapView; selected: string | null; onPick: (id: string) => void; onAdd?: () => void; open: boolean; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const shown = view.items.filter((i) => !ql || `${i.label} ${i.sub ?? ""}`.toLowerCase().includes(ql));
  return (
    <aside id="pipeline-step-list" aria-label="Steps" onKeyDown={(e) => { if (e.key === "Escape" && open) onClose(); }}
      className={cn("w-64 shrink-0 flex-col border-r border-line bg-surface md:static md:flex md:max-w-none md:shadow-none",
        open ? "absolute inset-y-0 left-0 z-30 flex max-w-[85vw] shadow-2xl shadow-black/40" : "hidden")}>
      <div className="space-y-2 border-b border-line p-3">
        <div className="flex items-center justify-between md:hidden">
          <span className="text-[13px] font-medium">Steps</span>
          <button onClick={onClose} aria-label="Close the step list" className="rounded p-1 text-muted hover:bg-raised hover:text-text"><X className="size-4" /></button>
        </div>
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a step" aria-label="Find a step"
            className="h-8 w-full rounded-md border border-line bg-ink/40 pl-8 pr-2 text-[13px] placeholder:text-muted/70 focus:border-accent focus:outline-none" />
        </label>
        {onAdd && <Button size="sm" variant="secondary" className="w-full" onClick={onAdd}><Plus />Add step</Button>}
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

function Inspector({ view, id, onPick, onClose, extra }: { view: MapView; id: string; onPick: (id: string) => void; onClose: () => void; extra?: ReactNode }) {
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
    <aside aria-label="Step details"
      className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[90vw] shrink-0 flex-col border-l border-line bg-surface shadow-2xl shadow-black/40 md:static md:max-w-none md:shadow-none">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <item.icon className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-medium" title={item.label}>{item.label}</span>
        <Badge>{item.group === "Steps" ? "step" : item.group === "Inputs" ? "input" : "output"}</Badge>
        <button onClick={onClose} aria-label="Close the step details" title="Close" className="-mr-1.5 rounded p-1 text-muted hover:bg-raised hover:text-text"><X className="size-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {extra}
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
function Explanation({ m, mode }: { m: MapResponse; mode: "view" | "edit" }) {
  const s = m.studio;
  const keep = <> <b className="font-medium text-text">Edit as new pipeline</b> makes your own copy; the original is never changed.</>;
  if (m.kind === "studio" && s) {
    return (
      <>
        {s.graph ? <>Built in Pipeline Studio: the graph of <b className="font-medium text-text">{m.version}</b>.</>
          : <>{m.version} was published before graphs were kept with each version; this map is read from its generated code.</>}
        {keep}
      </>
    );
  }
  const nf = m.nextflow;
  return (
    <>Read from the pipeline's Nextflow code (workflow <span className="font-mono text-text">{nf?.workflow}</span> in <span className="font-mono">{nf?.file}</span>).
      Arrows show which step passes data to which; dashed steps only run when their condition holds.
      {!m.can_edit_code ? keep : mode === "edit"
        ? <> This is your copy{m.copy_of ? <> of <span className="font-mono">{m.copy_of}</span></> : null}: click a step to switch it off or change its arguments, resources or container; <b className="font-medium text-text">Edit code</b> for anything else. Each save is a new version.</>
        : <> This is your copy{m.copy_of ? <> of <span className="font-mono">{m.copy_of}</span></> : null}: <b className="font-medium text-text">Edit in Pipeline Studio</b> to change its steps.</>}</>
  );
}

function Actions({ m, pid, canFork, onFork, size, mode }: { m: MapResponse; pid: string; canFork: boolean; onFork: () => void; size?: "sm"; mode: "view" | "edit" }) {
  const forkable = canFork && (m.kind === "nextflow" || !!m.studio?.graph);
  if (mode === "view" && m.can_edit_code) {
    return (
      <>
        <Button asChild size={size} variant="primary" title="Opens the step editor of Pipeline Studio: switch steps off, change their settings, add or remove steps"><Link to={`/studio/pipeline/${pid}${qs({ version: m.version_id })}`}><Workflow />Edit in Pipeline Studio</Link></Button>
        {forkable && <Button size={size} variant="ghost" onClick={onFork} aria-label="Edit as new pipeline" title="Edit as new pipeline: another copy; this one is not changed"><GitFork /></Button>}
      </>
    );
  }
  return (
    <>
      {m.can_edit_code && (
        <Button asChild size={size} variant="secondary"><Link to={`/pipelines/${pid}/code${qs({ version: m.version_id })}`}><FileCode2 />Edit code</Link></Button>
      )}
      {forkable && (
        <Button size={size} variant={m.can_edit_code ? "ghost" : "primary"} onClick={onFork} title="Edit as new pipeline: your own copy; this one is not changed">
          <GitFork />{m.can_edit_code ? <span className="hidden 2xl:inline">Edit as new pipeline</span> : "Edit as new pipeline"}
        </Button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------- full view (its own page)
export function PipelineMapFull(props: {
  pid: string; versionId?: string; toolbar: ReactNode; canFork: boolean; onFork: (m: MapResponse) => void; onDirty?: (d: boolean) => void;
  /** view: the pipeline's map; edit: Pipeline Studio's step editor for your own Nextflow copy (step settings are editable) */
  mode?: "view" | "edit";
  /** a second toolbar row, e.g. the pipeline's tab strip */
  tabs?: ReactNode;
}) {
  return <ReactFlowProvider><Full {...props} /></ReactFlowProvider>;
}

function Full({ pid, versionId, toolbar, tabs, canFork, onFork, onDirty, mode = "view" }: {
  pid: string; versionId?: string; toolbar: ReactNode; tabs?: ReactNode; canFork: boolean; onFork: (m: MapResponse) => void; onDirty?: (d: boolean) => void; mode?: "view" | "edit";
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = usePipelineMap(pid, versionId);
  const { view, loading } = useMapView(q.data);
  const [sel, setSel] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  useEffect(() => setSel(null), [pid, versionId]);
  const [listOpen, setListOpen] = useState(false); // the step list as a drawer on small screens
  const pick = (id: string | null) => { setSel(id); setListOpen(false); if (id) setFocus((f) => f + 1); };
  const m = q.data;
  const nf = m?.kind === "nextflow" ? m.nextflow : undefined;
  const steps = useStepSettings(pid, versionId, !!nf?.ok);
  const [pending, setPending] = useState<Overrides>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (steps.data) setPending(steps.data.overrides ?? {}); }, [steps.data]);
  const saved = steps.data?.overrides ?? {};
  const dirty = JSON.stringify(normalize(pending)) !== JSON.stringify(normalize(saved));
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
  // leaving the page (in the app, or closing the tab) with unsaved step settings asks first
  useUnsavedGuard(dirty, "step settings");
  const states = useMemo(() => (nf?.ok ? stepStates(nf.nodes, nf.edges, normalize(pending)) : undefined), [nf, pending]);
  const editable = mode === "edit" && !!steps.data?.editable;
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [selectAfterLoad, setSelectAfterLoad] = useState<string | null>(null);
  useEffect(() => {
    if (selectAfterLoad && nf?.nodes.some((n) => n.id === selectAfterLoad)) { setSel(selectAfterLoad); setFocus((f) => f + 1); setSelectAfterLoad(null); }
  }, [nf, selectAfterLoad]);
  const guard = (fn: () => void) => () => { if (dirty) toast.message("Save or discard your step settings first."); else fn(); };
  const structureDone = (verb: string) => (r: { step: string; version?: string }) => {
    toast.success(`${verb} ${r.step} as ${r.version}. Earlier versions are kept as they were.`);
    qc.invalidateQueries({ queryKey: ["pipeline", pid] });
    qc.invalidateQueries({ queryKey: ["pipelines"] });
    qc.invalidateQueries({ queryKey: ["pipeline-map", pid] });
    qc.invalidateQueries({ queryKey: ["pipeline-steps", pid] });
    setSel(null);
    if (verb === "Added") setSelectAfterLoad(r.step);
    nav(`/studio/pipeline/${pid}`, { replace: true });
  };
  const setStep = (id: string, o: StepOverride) => setPending((p) => {
    const n = { ...p };
    const c = cleanOverride(o);
    // keep partly typed values while editing; empty means the pipeline's own settings
    if (c || Object.values(o).some((v) => v !== undefined && v !== "")) n[id] = o; else delete n[id];
    return n;
  });
  const save = async () => {
    if (!steps.data) return;
    setSaving(true);
    try {
      const r = await api.post<{ version_id: string; version: string }>(`/api/pipelines/${pid}/steps`, { base_version_id: steps.data.version_id, overrides: normalize(pending) });
      toast.success(`Saved as ${r.version}. ${steps.data.version} is kept as it was.`);
      qc.invalidateQueries({ queryKey: ["pipeline", pid] });
      qc.invalidateQueries({ queryKey: ["pipelines"] });
      qc.invalidateQueries({ queryKey: ["pipeline-map", pid] });
      qc.invalidateQueries({ queryKey: ["pipeline-steps", pid] });
      onDirty?.(false);
      nav(`/studio/pipeline/${pid}`, { replace: true });
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  const nextLabel = (() => {
    const d = qc.getQueryData<{ versions: { version: string }[] }>(["pipeline", pid]);
    const n = Math.max(0, ...(d?.versions ?? []).map((v) => Number(/^v(\d+)$/.exec(v.version)?.[1] ?? 0)));
    return n ? `v${n + 1}` : "a new version";
  })();

  // settings form for the selected step (a process, or each process inside a subworkflow)
  const node = nf?.nodes.find((n) => n.id === sel);
  const extra = node && node.kind !== "input" && steps.data ? (
    <section className="space-y-3 border-b border-line/60 bg-raised/30 px-4 py-3">
      <h4 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted">
        Settings{!editable && <span className="normal-case tracking-normal text-muted/80">· {steps.data.editable ? "view" : "read-only original"}</span>}
      </h4>
      {node.kind === "process" ? (
        <StepForm info={node} current={steps.data.current[node.id] ?? []} value={pending[node.id] ?? {}} onChange={(o) => setStep(node.id, o)} editable={editable} />
      ) : (node.step_info ?? []).filter((s) => s.kind === "process").map((s) => (
        <details key={s.id} className="rounded-md border border-line/70 bg-surface" open={!!pending[s.id]}>
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[12.5px] font-medium">
            {s.id}{pending[s.id]?.enabled === false ? <span className="text-[10.5px] text-bad">off</span> : pending[s.id] ? <span className="text-[10.5px] text-wait">edited</span> : null}
          </summary>
          <div className="border-t border-line/60 p-3">
            <StepForm compact info={s} current={steps.data!.current[s.id] ?? []} value={pending[s.id] ?? {}} onChange={(o) => setStep(s.id, o)} editable={editable} />
          </div>
        </details>
      ))}
      {editable && (
        <Button size="sm" variant="danger" onClick={guard(() => setRemoving(node.id))}><Trash2 />Remove this step</Button>
      )}
      {!editable && (steps.data.editable
        ? <p className="text-[11.5px] text-muted"><Link className="text-accent hover:underline" to={`/studio/pipeline/${pid}${qs({ version: versionId })}`}>Edit in Pipeline Studio</Link> to change it.</p>
        : <p className="text-[11.5px] text-muted">Use <b className="font-medium text-text">Edit as new pipeline</b> to change it in your own copy.</p>)}
    </section>
  ) : null;

  const structNodes = (nf?.nodes ?? []).map((n) => ({ id: n.id, kind: n.kind, label: n.label, outputs: n.outputs, output_shapes: n.output_shapes as Record<string, string> | undefined }));
  return (
    <div className="flex h-full flex-col">
      {editable && steps.data && (
        <>
          <AddStepDialog open={addOpen} onOpenChange={setAddOpen} pid={pid} baseVersionId={steps.data.version_id} nextLabel={nextLabel}
            nodes={structNodes} defaultAfter={sel} onDone={structureDone("Added")} />
          {removing && <RemoveStepDialog open onOpenChange={(o) => !o && setRemoving(null)} pid={pid} baseVersionId={steps.data.version_id} nextLabel={nextLabel}
            step={removing} onDone={structureDone("Removed")} />}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        {view && (
          <Button size="sm" variant={listOpen ? "secondary" : "ghost"} className="md:hidden" onClick={() => setListOpen((o) => !o)}
            aria-expanded={listOpen} aria-controls="pipeline-step-list" title="Show the list of steps"><ListTree />Steps</Button>
        )}
        {toolbar}
        <div className="flex-1" />
        {dirty && <Button size="sm" variant="ghost" onClick={() => setPending(saved)} title="Discard unsaved step settings"><RotateCcw /><span className="hidden 2xl:inline">Discard</span></Button>}
        {m && <Actions m={m} pid={pid} canFork={canFork} onFork={guard(() => onFork(m))} size="sm" mode={mode} />}
        {editable && (
          <Button size="sm" variant="primary" disabled={!dirty} loading={saving} onClick={save} title={`Saves the step settings as ${nextLabel} of your copy; earlier versions stay as they are`}>
            <Save />{dirty ? `Save as ${nextLabel}` : "Saved"}
          </Button>
        )}
      </div>
      {tabs && <div className="border-b border-line bg-surface px-1.5">{tabs}</div>}
      <div className="relative flex min-h-0 flex-1">
        {listOpen && <div className="absolute inset-0 z-[25] bg-black/50 md:hidden" onClick={() => setListOpen(false)} aria-hidden />}
        {view && <StepList view={view} selected={sel} onPick={pick} open={listOpen} onClose={() => setListOpen(false)}
          onAdd={editable ? guard(() => { setListOpen(false); setAddOpen(true); }) : undefined} />}
        <div className="relative min-w-0 flex-1 bg-ink/40">
          {(q.isLoading || loading) && <div className="flex h-full items-center justify-center text-[13px] text-muted">Loading the map…</div>}
          {q.isError && !m && <div className="max-w-xl p-6"><QueryError error={q.error} onRetry={() => q.refetch()} what="the map of this pipeline" /></div>}
          {m && (m.kind === "none" || (!view && !loading)) && <p className="p-6 text-[13px] text-muted">No map for this pipeline{m.reason ? `: ${m.reason}` : ""}.</p>}
          {view && <Canvas view={view} selected={sel} onSelect={setSel} focus={focus} states={states} layoutKey={`${pid}.${view.kind}`} />}
          {editable && !sel && view && (
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-line bg-surface/95 px-3 py-1.5 text-[12.5px] text-muted shadow">
              Click a step to change it
            </div>
          )}
        </div>
        {view && sel && <Inspector view={view} id={sel} onPick={pick} onClose={() => setSel(null)} extra={extra} />}
      </div>
      {m && view && (
        <div className="flex items-center gap-3 border-t border-line bg-surface px-3 py-1.5 text-[12px] text-muted">
          <span className="shrink-0 tabular-nums">{plural(view.items.filter((i) => i.group === "Steps").length, "step")}, {plural(view.edges.length, "connection")}</span>
          {states && Object.values(states).some((x) => x === "off") && <span className="text-bad">{plural(Object.values(states).filter((x) => x === "off").length, "step")} off</span>}
          <span className="hidden min-w-0 flex-1 sm:block"><Explanation m={m} mode={mode} /></span>
        </div>
      )}
    </div>
  );
}

function normalize(o: Overrides): Overrides {
  const out: Overrides = {};
  for (const k of Object.keys(o).sort()) { const c = cleanOverride(o[k]); if (c) out[k] = c; }
  return out;
}
