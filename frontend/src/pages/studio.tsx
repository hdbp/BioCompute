import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addEdge, Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type IsValidConnection,
} from "@xyflow/react";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, ChevronDown, Code2, Download, FilePlus2, FolderOpen, Info, Layers, Loader2, Redo2, Rocket, Save,
  ShieldCheck, Trash2, Undo2, Workflow,
} from "lucide-react";
import { api, errMsg } from "@/lib/api";
import type { Issue, StudioModule, StudioWorkflow } from "@/lib/types";
import { ago, cn } from "@/lib/utils";
import { useTheme } from "@/hooks/theme";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge, Tip } from "@/components/ui/misc";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { nodeTypes } from "@/components/studio/module-node";
import { DND_MODULE, DND_SUBWORKFLOW, Palette } from "@/components/studio/palette";
import { Inspector } from "@/components/studio/inspector";
import { CodePreview } from "@/components/studio/code-preview";
import { chipseqExample, portableExample } from "@/components/studio/examples";
import {
  deserialize, effective, makeNode, newId, serialize, StudioContext, type Graph, type ModuleData, type PortTypes, type StudioNode,
} from "@/components/studio/model";

interface ModulesResponse { modules: StudioModule[]; port_types: PortTypes; custom_code_allowed: boolean }
interface ValidateResponse { valid: boolean; issues: Issue[]; order?: string[] }
interface CompileResponse extends ValidateResponse { files: Record<string, string> }

export default function StudioPage() {
  return (
    <ReactFlowProvider>
      <StudioInner />
    </ReactFlowProvider>
  );
}

function StudioInner() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const rf = useReactFlow<StudioNode, Edge>();
  // React Flow adds a "light"/"dark" class to its root; it must match the app theme because the
  // design tokens are scoped to those class names.
  const { theme } = useTheme();

  const modulesQ = useQuery({ queryKey: ["studio-modules"], queryFn: () => api.get<ModulesResponse>("/api/studio/modules"), staleTime: 300_000 });
  const workflowsQ = useQuery({ queryKey: ["studio-workflows"], queryFn: () => api.get<StudioWorkflow[]>("/api/studio/workflows") });
  const modIndex = useMemo(() => Object.fromEntries((modulesQ.data?.modules ?? []).map((m) => [m.id, m])), [modulesQ.data]);
  const portTypes = modulesQ.data?.port_types ?? {};

  const [nodes, setNodes, onNodesChange] = useNodesState<StudioNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [wfId, setWfId] = useState<string | null>(null);
  const [name, setName] = useState("Untitled workflow");
  const [description, setDescription] = useState("");
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [validating, setValidating] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "publish" | "export" | "compile">(null);
  const [codeFiles, setCodeFiles] = useState<Record<string, string> | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [openDlg, setOpenDlg] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [subDlg, setSubDlg] = useState(false);
  const [subName, setSubName] = useState("");
  const loadedRef = useRef<string | null>(null);

  // ------------------------------------------------------------------ history (undo / redo)
  const graphRef = useRef<Graph>({ nodes: [], edges: [] });
  graphRef.current = { nodes, edges };
  const past = useRef<Graph[]>([]);
  const future = useRef<Graph[]>([]);
  const lastCoalesce = useRef<{ key: string; t: number }>({ key: "", t: 0 });
  const [, bump] = useState(0);

  const snapshot = useCallback((coalesceKey?: string) => {
    const now = Date.now();
    if (coalesceKey && lastCoalesce.current.key === coalesceKey && now - lastCoalesce.current.t < 1000) {
      lastCoalesce.current.t = now;
      return;
    }
    lastCoalesce.current = { key: coalesceKey ?? "", t: now };
    const g = graphRef.current;
    past.current.push({ nodes: g.nodes.map((n) => ({ ...n, data: structuredClone(n.data) })), edges: g.edges.map((e) => ({ ...e })) });
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    setDirty(true);
    bump((x) => x + 1);
  }, []);

  const restore = useCallback((g: Graph) => {
    setNodes(g.nodes);
    setEdges(g.edges);
    setDirty(true);
    bump((x) => x + 1);
  }, [setNodes, setEdges]);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(graphRef.current);
    restore(prev);
  }, [restore]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(graphRef.current);
    restore(next);
  }, [restore]);

  const replaceGraph = useCallback((g: Graph, resetHistory = true) => {
    if (resetHistory) { past.current = []; future.current = []; } else snapshot();
    setNodes(g.nodes);
    setEdges(g.edges);
    setIssues([]);
    setTimeout(() => rf.fitView({ padding: 0.2, maxZoom: 1, duration: 300 }), 50);
    bump((x) => x + 1);
  }, [rf, setNodes, setEdges, snapshot]);

  // ------------------------------------------------------------------ load workflow from route
  useEffect(() => {
    if (!routeId) {
      if (loadedRef.current !== null) {
        loadedRef.current = null;
        setWfId(null);
      }
      return;
    }
    if (loadedRef.current === routeId) return;
    loadedRef.current = routeId;
    api.get<StudioWorkflow>(`/api/studio/workflows/${routeId}`).then((w) => {
      setWfId(w.id);
      setName(w.name);
      setDescription(w.description);
      replaceGraph(deserialize(w.graph));
      setDirty(false);
    }).catch((e) => {
      toast.error(`Could not open workflow: ${errMsg(e)}`);
      navigate("/studio", { replace: true });
    });
  }, [routeId, navigate, replaceGraph]);

  // ------------------------------------------------------------------ live validation (markers)
  useEffect(() => {
    if (!nodes.length) { setIssues([]); return; }
    const t = setTimeout(() => {
      api.post<ValidateResponse>("/api/studio/validate", { name, graph: serialize({ nodes, edges }) })
        .then((r) => setIssues(r.issues)).catch(() => { /* surfaced on explicit validate */ });
    }, 700);
    return () => clearTimeout(t);
    // positions do not affect validity; key on structure + data only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(nodes.map((n) => [n.id, n.data])), JSON.stringify(edges.map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle]))]);

  const issuesByNode = useMemo(() => {
    const m: Record<string, Issue[]> = {};
    issues.forEach((i) => { if (i.node) (m[i.node] ??= []).push(i); });
    return m;
  }, [issues]);
  const issueEdges = useMemo(() => new Set(issues.filter((i) => i.edge && i.level === "error").map((i) => i.edge!)), [issues]);
  const errorCount = issues.filter((i) => i.level === "error").length;
  const warnCount = issues.filter((i) => i.level === "warning").length;

  // ------------------------------------------------------------------ connections
  const portOf = useCallback((nodeId: string | null | undefined, handle: string | null | undefined, side: "in" | "out") => {
    const n = graphRef.current.nodes.find((x) => x.id === nodeId);
    if (!n) return null;
    const spec = effective(modIndex[n.data.module], n.data);
    const name = (handle ?? "").replace(/^(in|out):/, "");
    return (side === "in" ? spec.inputs : spec.outputs).find((p) => p.name === name) ?? null;
  }, [modIndex]);

  const isValidConnection: IsValidConnection<Edge> = useCallback((c) => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const out = portOf(c.source, c.sourceHandle, "out");
    const inp = portOf(c.target, c.targetHandle, "in");
    if (!out || !inp) return false;
    if (!(out.type === inp.type || out.type === "any" || inp.type === "any")) return false;
    const existing = graphRef.current.edges.filter((e) => e.target === c.target && e.targetHandle === c.targetHandle);
    if (existing.some((e) => e.source === c.source && e.sourceHandle === c.sourceHandle)) return false;
    if (!inp.multiple && existing.length > 0) return false;
    return true;
  }, [portOf]);

  const onConnect = useCallback((c: Connection) => {
    snapshot();
    setEdges((es) => addEdge({ ...c, id: newId("e") }, es));
  }, [setEdges, snapshot]);

  const styledEdges = useMemo(() => edges.map((e) => {
    const out = portOf(e.source, e.sourceHandle, "out");
    const bad = issueEdges.has(e.id);
    return {
      ...e,
      animated: false,
      style: { stroke: bad ? "rgb(var(--bad))" : portTypes[out?.type ?? "any"]?.color ?? "rgb(var(--muted))", strokeWidth: e.selected ? 2.5 : 1.75, strokeDasharray: bad ? "5 4" : undefined },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [edges, issueEdges, portTypes, portOf, nodes]);

  // ------------------------------------------------------------------ add / insert
  const viewportCenter = useCallback(() => {
    const el = document.querySelector(".react-flow") as HTMLElement | null;
    const r = el?.getBoundingClientRect();
    const p = rf.screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 800) / 2, y: (r?.top ?? 0) + (r?.height ?? 600) / 2 });
    return { x: p.x - 100 + (Math.random() - 0.5) * 60, y: p.y - 40 + (Math.random() - 0.5) * 60 };
  }, [rf]);

  const addModule = useCallback((m: StudioModule, pos?: { x: number; y: number }) => {
    snapshot();
    const n = makeNode(m, pos ?? viewportCenter());
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...n, selected: true }]);
  }, [setNodes, snapshot, viewportCenter]);

  const insertSubworkflow = useCallback((w: StudioWorkflow, pos?: { x: number; y: number }) => {
    const g = deserialize(w.graph);
    if (!g.nodes.length) return;
    snapshot();
    const at = pos ?? viewportCenter();
    const minX = Math.min(...g.nodes.map((n) => n.position.x));
    const minY = Math.min(...g.nodes.map((n) => n.position.y));
    const idMap: Record<string, string> = {};
    const ns = g.nodes.map((n) => {
      idMap[n.id] = newId(n.data.module.slice(0, 6));
      return { ...n, id: idMap[n.id], selected: true, position: { x: n.position.x - minX + at.x, y: n.position.y - minY + at.y }, data: structuredClone(n.data) };
    });
    const es = g.edges.filter((e) => idMap[e.source] && idMap[e.target])
      .map((e) => ({ ...e, id: newId("e"), source: idMap[e.source], target: idMap[e.target] }));
    setNodes((cur) => [...cur.map((x) => ({ ...x, selected: false })), ...ns]);
    setEdges((cur) => [...cur, ...es]);
    toast.success(`Inserted “${w.name}” (${ns.length} nodes)`);
  }, [setNodes, setEdges, snapshot, viewportCenter]);

  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }, []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const mid = e.dataTransfer.getData(DND_MODULE);
    if (mid && modIndex[mid]) return addModule(modIndex[mid], { x: pos.x - 100, y: pos.y - 30 });
    const sid = e.dataTransfer.getData(DND_SUBWORKFLOW);
    const w = workflowsQ.data?.find((x) => x.id === sid);
    if (w) insertSubworkflow(w, pos);
  }, [rf, modIndex, addModule, insertSubworkflow, workflowsQ.data]);

  // ------------------------------------------------------------------ node edits
  const updateNodeData = useCallback((id: string, patch: Partial<ModuleData>) => {
    snapshot(`${id}:${Object.keys(patch).join(",")}`);
    setNodes((ns) => ns.map((n) => {
      if (n.id !== id) return n;
      const data = { ...n.data, ...patch };
      if ("script" in patch && patch.script === undefined) delete data.script;
      return { ...n, data };
    }));
  }, [setNodes, snapshot]);

  const deleteNodes = useCallback((ids: string[]) => {
    snapshot();
    setNodes((ns) => ns.filter((n) => !ids.includes(n.id)));
    setEdges((es) => es.filter((e) => !ids.includes(e.source) && !ids.includes(e.target)));
  }, [setNodes, setEdges, snapshot]);

  const duplicateNode = useCallback((n: StudioNode) => {
    snapshot();
    const copy: StudioNode = { ...n, id: newId(n.data.module.slice(0, 6)), position: { x: n.position.x + 40, y: n.position.y + 60 }, data: { ...structuredClone(n.data), label: `${n.data.label} copy` }, selected: true };
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), copy]);
  }, [setNodes, snapshot]);

  const selectNode = useCallback((id: string) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    const n = graphRef.current.nodes.find((x) => x.id === id);
    if (n) rf.setCenter(n.position.x + 110, n.position.y + 50, { zoom: Math.max(rf.getZoom(), 0.9), duration: 300 });
  }, [rf, setNodes]);

  const selected = nodes.filter((n) => n.selected);
  const single = selected.length === 1 ? selected[0] : null;

  // ------------------------------------------------------------------ persistence
  const save = useCallback(async (silent = false): Promise<string | null> => {
    if (!name.trim()) { toast.error("Give the workflow a name first"); return null; }
    setBusy("save");
    try {
      const body = { name: name.trim(), description, graph: serialize(graphRef.current) };
      let w: StudioWorkflow;
      if (wfId) w = await api.put<StudioWorkflow>(`/api/studio/workflows/${wfId}`, body);
      else {
        w = await api.post<StudioWorkflow>("/api/studio/workflows", body);
        setWfId(w.id);
        loadedRef.current = w.id;
        navigate(`/studio/${w.id}`, { replace: true });
      }
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["studio-workflows"] });
      if (!silent) toast.success("Workflow saved");
      return w.id;
    } catch (e) {
      toast.error(`Save failed: ${errMsg(e)}`);
      return null;
    } finally {
      setBusy(null);
    }
  }, [name, description, wfId, navigate, qc]);

  const validate = useCallback(async () => {
    setValidating(true);
    try {
      const r = await api.post<ValidateResponse>("/api/studio/validate", { name, graph: serialize(graphRef.current) });
      setIssues(r.issues);
      setIssuesOpen(true);
      if (r.valid) toast.success(r.issues.length ? "Valid, with notes" : "Workflow is valid");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setValidating(false);
    }
  }, [name]);

  const showCode = useCallback(async () => {
    setBusy("compile");
    try {
      const r = await api.post<CompileResponse>("/api/studio/compile", { name, description, graph: serialize(graphRef.current) });
      setIssues(r.issues);
      if (!r.valid) {
        setIssuesOpen(true);
        toast.error("Fix the errors before generating code");
        return;
      }
      setCodeFiles(r.files);
      setCodeOpen(true);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  }, [name, description]);

  const exportZip = useCallback(async () => {
    setBusy("export");
    try {
      const res = await api.raw("POST", "/api/studio/export", { name, description, graph: serialize(graphRef.current) });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pipeline";
      Object.assign(document.createElement("a"), { href: url, download: `${slug}.zip` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Exported Nextflow pipeline");
    } catch (e) {
      const iss = (e as { issues?: Issue[] }).issues;
      if (iss?.length) { setIssues(iss); setIssuesOpen(true); }
      toast.error(`Export failed: ${errMsg(e)}`);
    } finally {
      setBusy(null);
    }
  }, [name, description]);

  const publish = useCallback(async () => {
    const id = await save(true);
    if (!id) return;
    setBusy("publish");
    try {
      const r = await api.post<{ pipeline_id: string; version: string }>(`/api/studio/workflows/${id}/publish`);
      qc.invalidateQueries({ queryKey: ["pipelines"] });
      toast.success(`Published to the pipeline library as ${r.version}`, {
        action: { label: "Open pipeline", onClick: () => navigate(`/pipelines/${r.pipeline_id}`) },
      });
    } catch (e) {
      const iss = (e as { issues?: Issue[] }).issues;
      if (iss?.length) { setIssues(iss); setIssuesOpen(true); }
      toast.error(`Publish failed: ${errMsg(e)}`);
    } finally {
      setBusy(null);
    }
  }, [save, qc, navigate]);

  const confirmDiscard = () => !dirty || !graphRef.current.nodes.length || window.confirm("Discard unsaved changes to this workflow?");

  const newWorkflow = () => {
    if (!confirmDiscard()) return;
    loadedRef.current = null;
    setWfId(null);
    setName("Untitled workflow");
    setDescription("");
    replaceGraph({ nodes: [], edges: [] });
    setDirty(false);
    navigate("/studio");
  };

  const loadExample = (which: "chip" | "qc") => {
    if (graphRef.current.nodes.length && !window.confirm("Replace the current canvas with the example?")) return;
    const g = which === "chip" ? chipseqExample(modIndex) : portableExample(modIndex);
    replaceGraph(g, false);
    if (!wfId) setName(which === "chip" ? "ChIP-seq peak calling" : "Portable FASTQ QC");
    setDirty(true);
  };

  const saveSubworkflow = async () => {
    const sel = graphRef.current.nodes.filter((n) => n.selected);
    if (!sel.length || !subName.trim()) return;
    const ids = new Set(sel.map((n) => n.id));
    const graph = {
      ...serialize({ nodes: sel, edges: graphRef.current.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }),
      meta: { kind: "subworkflow" },
    };
    try {
      await api.post("/api/studio/workflows", { name: subName.trim(), description: `${sel.length} nodes`, graph });
      qc.invalidateQueries({ queryKey: ["studio-workflows"] });
      toast.success(`Saved subworkflow “${subName.trim()}”`);
      setSubDlg(false);
      setSubName("");
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const deleteWorkflow = async (w: StudioWorkflow) => {
    if (!window.confirm(`Delete “${w.name}”? Published pipelines are not affected.`)) return;
    try {
      await api.del(`/api/studio/workflows/${w.id}`);
      qc.invalidateQueries({ queryKey: ["studio-workflows"] });
      if (w.id === wfId) newWorkflow();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  // ------------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y")) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, save]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty && graphRef.current.nodes.length) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const workflows = (workflowsQ.data ?? []).filter((w) => w.graph?.meta?.kind !== "subworkflow");
  const subworkflows = (workflowsQ.data ?? []).filter((w) => w.graph?.meta?.kind === "subworkflow");
  const ctx = useMemo(() => ({ modules: modIndex, portTypes, issuesByNode }), [modIndex, portTypes, issuesByNode]);

  return (
    <StudioContext.Provider value={ctx}>
      <div className="flex h-full flex-col">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <Workflow className="size-4 text-accent" />
          <input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} aria-label="Workflow name"
            className="min-w-0 w-48 rounded-md bg-transparent px-1.5 py-1 text-[14px] font-semibold hover:bg-raised focus:bg-raised focus:outline-none" />
          {dirty ? <Badge tone="wait">Unsaved</Badge> : wfId ? <Badge>Saved</Badge> : null}
          <Tip content={<div className="space-y-1"><p>Graphs export to a supported subset of Nextflow DSL2: per-sample and all-sample steps, branches, joins and merges.</p><p className="text-muted">Arbitrary Nextflow scripts cannot be imported back into a graph.</p></div>}>
            <span tabIndex={0} className="hidden 2xl:inline-flex cursor-help rounded border border-line px-1.5 py-px text-[11.5px] text-muted">DSL2 subset</span>
          </Tip>
          <div className="mx-1 h-5 w-px bg-line" />
          <Tip content="New workflow"><Button size="icon" variant="ghost" onClick={newWorkflow} aria-label="New workflow"><FilePlus2 /></Button></Tip>
          <Tip content="Open a saved workflow"><Button size="icon" variant="ghost" onClick={() => setOpenDlg(true)} aria-label="Open workflow"><FolderOpen /></Button></Tip>
          <Tip content="Name and description"><Button size="icon" variant="ghost" onClick={() => setDetailsOpen(true)} aria-label="Workflow details"><Info /></Button></Tip>
          <Tip content="Save (Ctrl+S)"><Button size="sm" variant="ghost" onClick={() => save()} loading={busy === "save"}><Save />Save</Button></Tip>
          <div className="mx-1 h-5 w-px bg-line" />
          <Tip content="Undo (Ctrl+Z)"><Button size="icon" variant="ghost" onClick={undo} disabled={!past.current.length} aria-label="Undo"><Undo2 /></Button></Tip>
          <Tip content="Redo (Ctrl+Shift+Z)"><Button size="icon" variant="ghost" onClick={redo} disabled={!future.current.length} aria-label="Redo"><Redo2 /></Button></Tip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="ghost">Examples<ChevronDown /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Replaces the canvas</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => loadExample("chip")}><Workflow />ChIP-seq: FastQC, fastp, Bowtie2, MACS3, MultiQC</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => loadExample("qc")}><Workflow />Portable QC (runs anywhere, no extra tools)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {selected.length > 0 && (
            <Tip content="Save the selected nodes as a reusable subworkflow"><Button size="sm" variant="ghost" onClick={() => { setSubName(""); setSubDlg(true); }}><Layers /><span className="hidden 2xl:inline">Save as subworkflow</span></Button></Tip>
          )}
          <div className="flex-1" />
          <Button size="sm" variant="secondary" onClick={validate} loading={validating} aria-label="Validate"><ShieldCheck /><span className="hidden xl:inline">Validate</span></Button>
          <Button size="sm" variant="secondary" onClick={showCode} loading={busy === "compile"} disabled={!nodes.length} aria-label="Show generated code"><Code2 /><span className="hidden xl:inline">Code</span></Button>
          <Button size="sm" variant="secondary" onClick={exportZip} loading={busy === "export"} disabled={!nodes.length} aria-label="Export Nextflow pipeline"><Download /><span className="hidden xl:inline">Export</span></Button>
          <Button size="sm" variant="primary" onClick={publish} loading={busy === "publish"} disabled={!nodes.length}><Rocket />Publish</Button>
        </div>

        <div className="flex min-h-0 flex-1">
          {modulesQ.data ? (
            <Palette modules={modulesQ.data.modules} portTypes={portTypes} customAllowed={modulesQ.data.custom_code_allowed}
              subworkflows={subworkflows} onAdd={(m) => addModule(m)} onInsertSub={(w) => insertSubworkflow(w)} onDeleteSub={deleteWorkflow} />
          ) : (
            <aside className="flex w-64 items-center justify-center border-r border-line bg-surface text-muted">
              {modulesQ.isError ? <p className="px-4 text-center text-[13px] text-bad">{errMsg(modulesQ.error)}</p> : <Loader2 className="size-5 animate-spin" />}
            </aside>
          )}

          <div className="relative flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1" onDragOver={onDragOver} onDrop={onDrop}>
              <ReactFlow<StudioNode, Edge>
                nodes={nodes}
                edges={styledEdges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                isValidConnection={isValidConnection}
                onNodeDragStart={() => snapshot()}
                onBeforeDelete={async () => { snapshot(); return true; }}
                deleteKeyCode={["Backspace", "Delete"]}
                multiSelectionKeyCode={["Meta", "Control", "Shift"]}
                colorMode={theme}
                fitView
                fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                minZoom={0.2}
                maxZoom={2}
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{ type: "default" }}
              >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="rgb(var(--line))" />
                <Controls position="bottom-left" showInteractive={false} />
                <MiniMap position="bottom-right" pannable zoomable className="!rounded-md !border !border-line"
                  nodeColor={(n) => (issuesByNode[n.id]?.some((i) => i.level === "error") ? "rgb(var(--bad))" : "rgb(var(--accent))")}
                  maskColor="rgb(var(--ink) / 0.6)" />
              </ReactFlow>

              {nodes.length === 0 && modulesQ.data && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
                  <div className="pointer-events-auto max-w-md rounded-xl border border-line bg-surface/95 p-6 text-center shadow-xl">
                    <Workflow className="mx-auto mb-3 size-7 text-accent" />
                    <p className="font-medium">Build a workflow</p>
                    <p className="mt-1 text-[13px] text-muted">
                      Drag modules from the library on the left and connect outputs to inputs of the same type.
                      Start with a samplesheet input, or load a complete example.
                    </p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      <Button size="sm" variant="secondary" onClick={() => loadExample("qc")}>Portable QC example</Button>
                      <Button size="sm" variant="secondary" onClick={() => loadExample("chip")}>ChIP-seq example</Button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* issues panel / status bar */}
            <div className="border-t border-line bg-surface">
              <button onClick={() => setIssuesOpen((o) => !o)} className="flex w-full items-center gap-3 px-3 py-1.5 text-[12.5px] text-muted hover:text-text" aria-expanded={issuesOpen}>
                {errorCount ? <span className="inline-flex items-center gap-1 text-bad"><AlertTriangle className="size-3.5" />{errorCount} error{errorCount === 1 ? "" : "s"}</span>
                  : nodes.length ? <span className="inline-flex items-center gap-1 text-ok"><CheckCircle2 className="size-3.5" />No errors</span> : <span>Empty canvas</span>}
                {warnCount > 0 && <span className="text-wait">{warnCount} warning{warnCount === 1 ? "" : "s"}</span>}
                <span>{nodes.length} node{nodes.length === 1 ? "" : "s"}, {edges.length} connection{edges.length === 1 ? "" : "s"}</span>
                <span className="ml-auto">{issuesOpen ? "Hide problems" : "Show problems"}</span>
                <ChevronDown className={cn("size-3.5 transition-transform", issuesOpen && "rotate-180")} />
              </button>
              {issuesOpen && (
                <ul className="max-h-44 overflow-y-auto border-t border-line px-2 py-1.5">
                  {issues.length === 0 && <li className="px-2 py-2 text-[13px] text-muted">No problems found. Run Validate after editing to re-check.</li>}
                  {issues.map((i, k) => (
                    <li key={k}>
                      <button onClick={() => i.node && selectNode(i.node)} disabled={!i.node}
                        className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-raised disabled:hover:bg-transparent">
                        <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", i.level === "error" ? "bg-bad" : i.level === "warning" ? "bg-wait" : "bg-muted")} />
                        <span className="flex-1">{i.message}</span>
                        {i.node && <span className="text-xs text-muted">Show node</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {single ? (
            <Inspector key={single.id} node={single} mod={modIndex[single.data.module]} portTypes={portTypes} issues={issuesByNode[single.id] ?? []}
              onChange={(p) => updateNodeData(single.id, p)} onDelete={() => deleteNodes([single.id])} onDuplicate={() => duplicateNode(single)} />
          ) : selected.length > 1 ? (
            <aside className="w-80 shrink-0 border-l border-line bg-surface p-4 space-y-3">
              <p className="text-sm font-semibold">{selected.length} nodes selected</p>
              <p className="text-[13px] text-muted">Save them as a reusable subworkflow, or delete them together.</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => { setSubName(""); setSubDlg(true); }}><Layers />Save as subworkflow</Button>
                <Button size="sm" variant="danger" onClick={() => deleteNodes(selected.map((n) => n.id))}><Trash2 />Delete</Button>
              </div>
            </aside>
          ) : null}
        </div>
      </div>

      <CodePreview open={codeOpen} onOpenChange={setCodeOpen} files={codeFiles} />

      <Dialog open={openDlg} onOpenChange={setOpenDlg}>
        <DialogContent title="Open workflow" description="Workflows saved in Pipeline Studio. Subworkflows are listed in the module library.">
          {workflows.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted">No saved workflows yet. Build one and choose Save.</p>
          ) : (
            <ul className="divide-y divide-line">
              {workflows.map((w) => (
                <li key={w.id} className="flex items-center gap-3 py-2">
                  <button className="min-w-0 flex-1 text-left" onClick={() => {
                    setOpenDlg(false);
                    if (w.id === wfId || !confirmDiscard()) return;
                    navigate(`/studio/${w.id}`);
                  }}>
                    <p className="truncate text-[13.5px] font-medium hover:text-accent">{w.name}</p>
                    <p className="truncate text-xs text-muted">{w.graph.nodes.length} nodes, updated {ago(w.updated_at)}{w.created_by ? ` by ${w.created_by}` : ""}</p>
                  </button>
                  {w.id === wfId && <Badge tone="accent">Open</Badge>}
                  <Button size="icon" variant="ghost" onClick={() => deleteWorkflow(w)} aria-label={`Delete ${w.name}`}><Trash2 /></Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent title="Workflow details">
          <div className="space-y-4">
            <Field label="Name"><Input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} /></Field>
            <Field label="Description" hint="Shown in the pipeline library after publishing.">
              <Textarea value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="primary" onClick={() => setDetailsOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={subDlg} onOpenChange={setSubDlg}>
        <DialogContent title="Save selection as subworkflow"
          description={`${selected.length} node${selected.length === 1 ? "" : "s"} and the connections between them. Inserting a subworkflow adds copies of these nodes; the exported DSL2 is flat.`}>
          <form onSubmit={(e) => { e.preventDefault(); saveSubworkflow(); }}>
            <Field label="Name"><Input autoFocus value={subName} onChange={(e) => setSubName(e.target.value)} placeholder="e.g. Trim and align" /></Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setSubDlg(false)}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!subName.trim()}>Save subworkflow</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </StudioContext.Provider>
  );
}
