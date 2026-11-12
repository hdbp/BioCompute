import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addEdge, Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type IsValidConnection,
} from "@xyflow/react";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, ChevronDown, Code2, Download, FilePlus2, FolderOpen, GitBranch, History, Info, Layers, Loader2, MoreHorizontal,
  PanelLeftOpen, Redo2, Rocket, Save, ShieldCheck, Sparkles, Trash2, Undo2, Workflow, X,
} from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Issue, ModuleDef, Pipeline, StudioModule, StudioWorkflow } from "@/lib/types";
import { publishState } from "@/components/studio-drafts";
import { ShareButton, SharingBadge, type Visibility } from "@/components/sharing";
import { cn } from "@/lib/utils";
import { Ago, usePageTitle } from "@/components/page";
import { confirmDialog } from "@/components/ui/confirm";
import { useTheme } from "@/hooks/theme";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge, Tip } from "@/components/ui/misc";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { nodeTypes } from "@/components/studio/module-node";
import { DND_MODULE, DND_SUBWORKFLOW, Palette } from "@/components/studio/palette";
import { Inspector } from "@/components/studio/inspector";
import { CodePreview } from "@/components/studio/code-preview";
import { emptyModule, ModuleBuilder, normalizeModule } from "@/components/studio/module-builder";
import { ToolFinder } from "@/components/studio/tool-finder";
import { AssistantPanel } from "@/components/studio/assistant-panel";
import { chipseqExample, portableExample } from "@/components/studio/examples";
import {
  deserialize, effective, LinkContext, linkedTo, linkEdgeStyle, makeNode, newId, serialize, StudioContext, type Graph, type ModuleData, type PortTypes, type StudioNode,
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
  const pipelinesQ = useQuery({ queryKey: ["pipelines"], queryFn: () => api.get<Pipeline[]>("/api/pipelines") });
  const publishRef = useRef<() => void>(() => undefined);
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
  // owner and sharing of the open workflow; someone else's shared workflow opens read-only (Save makes a copy)
  const [wfMeta, setWfMeta] = useState<{ created_by: string | null; visibility: Visibility; can_edit: boolean; name: string } | null>(null);
  const me = useAuth((s) => s.user?.username);
  // the assistant answer currently on the canvas, linked to the workflow once saved
  const pendingResult = useRef<string | null>(null);
  // unsaved canvas, kept in this browser so leaving Studio never loses work
  const username = useAuth((s) => s.user?.username ?? "anon");
  const draftKey = `biocompute.studio-draft.${username}`;
  const [draft, setDraft] = useState<Draft | null>(() => readDraft(draftKey));
  const [builder, setBuilder] = useState<{ open: boolean; def: ModuleDef; editing: boolean; notes: string | null }>({ open: false, def: emptyModule(), editing: false, notes: null });
  const [finderOpen, setFinderOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(() => { try { return localStorage.getItem("bc-assistant-open") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("bc-assistant-open", assistantOpen ? "1" : "0"); } catch { /* ignore */ } }, [assistantOpen]);
  // the module library can be hidden to give the canvas more room (remembered; starts hidden on small windows)
  const [paletteOpen, setPaletteOpen] = useState(() => {
    try { const v = localStorage.getItem("bc-studio-palette"); if (v) return v === "1"; } catch { /* ignore */ }
    return typeof window === "undefined" || window.innerWidth >= 1024;
  });
  const togglePalette = (open: boolean) => { setPaletteOpen(open); try { localStorage.setItem("bc-studio-palette", open ? "1" : "0"); } catch { /* ignore */ } };

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
      setWfMeta({ created_by: w.created_by, visibility: w.visibility, can_edit: w.can_edit, name: w.name });
      setName(w.name);
      setDescription(w.description);
      replaceGraph(deserialize(w.graph));
      setDirty(false);
      // opened from a pipeline page for an earlier version: start from that version's graph
      const sp = new URLSearchParams(window.location.search);
      const pid = sp.get("pipeline"), vid = sp.get("version");
      if (pid && vid) {
        window.history.replaceState(null, "", window.location.pathname);
        api.get<{ version: string; studio?: { graph: { nodes: unknown[]; edges: unknown[] } | null; next_version: string } }>(`/api/pipelines/${pid}/map?version_id=${encodeURIComponent(vid)}`)
          .then((m) => {
            if (!m.studio?.graph) return;
            replaceGraph(deserialize(m.studio.graph));
            setDirty(true);
            toast.info(`Loaded ${m.version} of “${w.name}”. Publish saves it as ${m.studio.next_version}; Save alone keeps it as the Studio draft.`, { duration: 10000 });
          })
          .catch((e) => toast.error(`Could not load that version: ${errMsg(e)}`));
      }
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

  // keyed on the ids, so moving a step does not rebuild the highlight (and re-render every step)
  const selKey = nodes.filter((n) => n.selected).map((n) => n.id).join("\n");
  const selectedIds = useMemo(() => new Set(selKey ? selKey.split("\n") : []), [selKey]);
  const linked = useMemo(() => linkedTo(selectedIds, edges), [selectedIds, edges]);
  // until the module list has loaded the steps have no ports yet: React Flow cannot attach the connections then and
  // warns once per render for each of them, so they are drawn as soon as the ports exist
  const modulesReady = !!modulesQ.data;
  const styledEdges = useMemo(() => (!modulesReady ? [] : edges.map((e) => {
    const out = portOf(e.source, e.sourceHandle, "out");
    const bad = issueEdges.has(e.id);
    const lit = selectedIds.has(e.source) || selectedIds.has(e.target);
    return {
      ...e,
      animated: lit,
      zIndex: lit ? 1 : 0,
      style: lit && !bad ? { ...linkEdgeStyle, strokeDasharray: undefined }
        : { stroke: bad ? "rgb(var(--bad))" : portTypes[out?.type ?? "any"]?.color ?? "rgb(var(--muted))", strokeWidth: e.selected ? 2.5 : 1.75, strokeDasharray: bad ? "5 4" : undefined },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [edges, issueEdges, portTypes, portOf, nodes, selectedIds, modulesReady]);

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
    toast.success(`Inserted “${w.name}” (${ns.length} step${ns.length === 1 ? "" : "s"})`);
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
      const copying = !!wfId && !!wfMeta && !wfMeta.can_edit;
      const body = { name: copying && name.trim() === wfMeta!.name ? `${name.trim()} (copy)` : name.trim(), description, graph: serialize(graphRef.current) };
      let w: StudioWorkflow;
      if (wfId && !copying) w = await api.put<StudioWorkflow>(`/api/studio/workflows/${wfId}`, body);
      else {
        if (copying) { setName(body.name); toast.message(`“${wfMeta!.name}” belongs to ${wfMeta!.created_by}; saved as your own copy`); }
        w = await api.post<StudioWorkflow>("/api/studio/workflows", body);
        setWfId(w.id);
        setWfMeta({ created_by: w.created_by, visibility: w.visibility, can_edit: w.can_edit, name: w.name });
        loadedRef.current = w.id;
        navigate(`/studio/${w.id}`, { replace: true });
      }
      setDirty(false);
      clearDraft(draftKey);
      setDraft(null);
      if (pendingResult.current) {
        api.post(`/api/assistant/history/${pendingResult.current}/saved`, { workflow_id: w.id })
          .then(() => qc.invalidateQueries({ queryKey: ["assistant-history"] })).catch(() => undefined);
        pendingResult.current = null;
      }
      qc.invalidateQueries({ queryKey: ["studio-workflows"] });
      if (!silent) {
        const published = (pipelinesQ.data ?? []).some((p) => p.studio_workflow_id === w.id);
        toast.success(published ? "Saved. Publish again to update the pipeline in the library." : "Saved as a Studio draft. Publish it to add it to Pipelines.",
          { duration: 8000, action: { label: published ? "Publish update" : "Publish", onClick: () => publishRef.current() } });
      }
      return w.id;
    } catch (e) {
      toast.error(`Save failed: ${errMsg(e)}`);
      return null;
    } finally {
      setBusy(null);
    }
  }, [name, description, wfId, wfMeta, navigate, qc, draftKey, pipelinesQ.data]);

  const setVisibility = useCallback(async (v: Visibility) => {
    if (!wfId) return;
    try {
      const r = await api.put<{ visibility: Visibility; shared_modules: string[] }>(`/api/studio/workflows/${wfId}/visibility`, { visibility: v });
      setWfMeta((m) => (m ? { ...m, visibility: r.visibility } : m));
      qc.invalidateQueries({ queryKey: ["studio-workflows"] });
      qc.invalidateQueries({ queryKey: ["pipelines"] });
      qc.invalidateQueries({ queryKey: ["studio-modules"] });
      toast.success(v === "lab"
        ? `Shared with the lab${r.shared_modules.length ? `, with the module${r.shared_modules.length === 1 ? "" : "s"} it uses (${r.shared_modules.join(", ")})` : ""}`
        : "Now private: only you can see it");
    } catch (e) { toast.error(errMsg(e)); }
  }, [wfId, qc]);

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
      qc.invalidateQueries({ queryKey: ["studio-workflows"] });
      toast.success(`Published to the pipeline library as ${r.version}`, {
        action: { label: "Open pipeline", onClick: () => navigate(`/pipelines/${r.pipeline_id}/map`) },
      });
    } catch (e) {
      const iss = (e as { issues?: Issue[] }).issues;
      if (iss?.length) { setIssues(iss); setIssuesOpen(true); }
      toast.error(`Publish failed: ${errMsg(e)}`);
    } finally {
      setBusy(null);
    }
  }, [save, qc, navigate]);
  publishRef.current = publish;

  /** Before the canvas is replaced by another workflow: ask when it has unsaved changes. */
  const confirmDiscard = async (next = "open another workflow") => !dirty || !graphRef.current.nodes.length || confirmDialog({
    title: `Discard the unsaved changes to “${name}”?`,
    body: `The changes since the last save are lost when you ${next}. Save first to keep them.`,
    confirmLabel: "Discard changes", cancelLabel: "Keep editing", danger: true,
  });

  const newWorkflow = async (force = false) => {
    if (!force && !(await confirmDiscard("start a new workflow"))) return;
    if (!draft) clearDraft(draftKey); // the stored draft is this canvas; an older one stays offered
    pendingResult.current = null;
    loadedRef.current = null;
    setWfId(null);
    setWfMeta(null);
    setName("Untitled workflow");
    setDescription("");
    replaceGraph({ nodes: [], edges: [] });
    setDirty(false);
    navigate("/studio");
  };

  const loadExample = async (which: "chip" | "qc") => {
    if (graphRef.current.nodes.length && !(await confirmDialog({
      title: "Replace the canvas with the example?",
      body: `The ${graphRef.current.nodes.length} step${graphRef.current.nodes.length === 1 ? "" : "s"} on the canvas are replaced by the example workflow. You can undo this with Ctrl+Z.`,
      confirmLabel: "Replace canvas",
    }))) return;
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
      await api.post("/api/studio/workflows", { name: subName.trim(), description: `${sel.length} step${sel.length === 1 ? "" : "s"}`, graph });
      qc.invalidateQueries({ queryKey: ["studio-workflows"] });
      toast.success(`Saved subworkflow “${subName.trim()}”`);
      setSubDlg(false);
      setSubName("");
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const deleteWorkflow = async (w: StudioWorkflow) => {
    const sub = w.graph?.meta?.kind === "subworkflow";
    const pl = (pipelinesQ.data ?? []).find((p) => p.studio_workflow_id === w.id);
    if (!(await confirmDialog({
      title: sub ? `Delete the subworkflow “${w.name}”?` : `Delete the workflow “${w.name}”?`,
      body: sub
        ? "It is removed from the module library. Workflows it was already inserted into keep their copies of its steps."
        : pl ? `The Studio workflow is deleted for good. The published pipeline “${pl.name}” and its runs are not affected, but it can no longer be edited from this workflow.`
          : "The workflow is deleted for good. It was never published, so nothing of it remains in Pipelines.",
      confirmLabel: sub ? "Delete subworkflow" : "Delete workflow", danger: true,
    }))) return;
    try {
      await api.del(`/api/studio/workflows/${w.id}`);
      qc.invalidateQueries({ queryKey: ["studio-workflows"] });
      toast.success(`Deleted “${w.name}”`);
      if (w.id === wfId) newWorkflow(true);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  // ------------------------------------------------------------------ user modules
  const openBuilder = useCallback((def: ModuleDef, editing = false, notes: string | null = null) => {
    setFinderOpen(false);
    setBuilder({ open: true, def, editing, notes });
  }, []);

  const editModule = useCallback(async (m: StudioModule) => {
    try { openBuilder(normalizeModule(await api.get<ModuleDef>(`/api/studio/modules/${m.id}/export`)), true); }
    catch (e) { toast.error(errMsg(e)); }
  }, [openBuilder]);

  const exportModule = useCallback(async (m: StudioModule) => {
    try {
      const def = await api.get<ModuleDef>(`/api/studio/modules/${m.id}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(def, null, 2)], { type: "application/json" }));
      Object.assign(document.createElement("a"), { href: url, download: `${m.id}.biocompute-module.json` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { toast.error(errMsg(e)); }
  }, []);

  const deleteModule = useCallback(async (m: StudioModule) => {
    if (graphRef.current.nodes.some((n) => n.data.module === m.id)) { toast.error("Remove this module from the canvas first."); return; }
    if (!(await confirmDialog({
      title: `Delete the module “${m.name}”?`,
      body: "It is removed from the module library for good. Published pipelines keep working; saved workflows that use it must be changed before they can be published again.",
      confirmLabel: "Delete module", danger: true,
    }))) return;
    try {
      await api.del(`/api/studio/modules/${m.id}`);
      qc.invalidateQueries({ queryKey: ["studio-modules"] });
      toast.success(`Deleted “${m.name}”`);
    } catch (e) { toast.error(errMsg(e)); }
  }, [qc]);

  const draftModuleFor = useCallback(async (tool: string, reason: string) => {
    const exe = tool.split(/[\s(,]/)[0];
    const t = toast.loading(`Drafting a module for ${exe}…`);
    try {
      const r = await api.post<{ module: ModuleDef; notes: string; grounded_on_help: boolean }>("/api/assistant/draft-module", { description: `${tool}: ${reason}`, tool: exe });
      openBuilder(normalizeModule(r.module), false, `Drafted by the assistant${r.grounded_on_help ? " from the program's --help text" : " without the program's help text (it is not installed on the controller)"}. ${r.notes}`);
      toast.dismiss(t);
    } catch (e) { toast.error(errMsg(e), { id: t }); }
  }, [openBuilder]);

  const loadFromAssistant = useCallback(async (r: { graph: { nodes: unknown[]; edges: unknown[] }; name: string; description: string; result_id?: string }) => {
    if (graphRef.current.nodes.length && !(await confirmDialog({
      title: "Replace the canvas with the assistant's pipeline?",
      body: "The steps on the canvas are replaced. You can undo this with Ctrl+Z.",
      confirmLabel: "Replace canvas",
    }))) return;
    replaceGraph(deserialize(r.graph), false);
    if (!wfId) { setName(r.name); setDescription(r.description); }
    pendingResult.current = r.result_id ?? null;
    setDirty(true);
    toast.success("Loaded into the editor. It is not saved yet.", {
      duration: 10000, action: { label: "Save now", onClick: () => { save(); } },
    });
  }, [replaceGraph, wfId, save]);

  // ------------------------------------------------------------------ local draft
  useEffect(() => {
    if (draft || !dirty || !nodes.length) return;
    const t = setTimeout(() => writeDraft(draftKey, {
      wfId, name, description, graph: serialize(graphRef.current), at: new Date().toISOString(), resultId: pendingResult.current,
    }), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, name, description, dirty, wfId, draft, draftKey]);

  const restoreDraft = () => {
    if (!draft) return;
    loadedRef.current = draft.wfId;
    setWfId(draft.wfId);
    setName(draft.name);
    setDescription(draft.description);
    pendingResult.current = draft.resultId ?? null;
    navigate(draft.wfId ? `/studio/${draft.wfId}` : "/studio", { replace: true });
    replaceGraph(deserialize(draft.graph));
    setDirty(true);
    setDraft(null);
    toast.success("Restored your unsaved workflow. Save it to keep it.");
  };
  const discardDraft = async () => {
    if (!draft || !(await confirmDialog({
      title: `Discard the unsaved workflow “${draft.name}”?`,
      body: `This copy with ${(draft.graph.nodes ?? []).length} steps is kept only in this browser. Discarding it cannot be undone.`,
      confirmLabel: "Discard", danger: true,
    }))) return;
    clearDraft(draftKey);
    setDraft(null);
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
  const nfCopies = (pipelinesQ.data ?? []).filter((p) => p.kind !== "studio" && p.can_edit && /^(copy|duplicate):/.test(p.source_url ?? ""));
  const subworkflows = (workflowsQ.data ?? []).filter((w) => w.graph?.meta?.kind === "subworkflow");
  const ctx = useMemo(() => ({ modules: modIndex, portTypes, issuesByNode }), [modIndex, portTypes, issuesByNode]);
  const recent = useMemo(() => [...workflows]
    .sort((x, y) => Number(x.created_by !== me) - Number(y.created_by !== me) || y.updated_at.localeCompare(x.updated_at)).slice(0, 5),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workflowsQ.data, me]);
  const openWorkflow = async (id: string) => {
    if (id === wfId || !(await confirmDiscard())) return;
    navigate(`/studio/${id}`);
  };
  const openCopy = async (id: string) => { if (await confirmDiscard("open a pipeline copy")) navigate(`/studio/pipeline/${id}`); };
  const deselect = () => setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
  const openSubDialog = () => { setSubName(""); setSubDlg(true); };
  usePageTitle(wfId || nodes.length ? name.trim() || "Untitled workflow" : "Pipeline Studio", wfId || nodes.length ? [{ label: "Pipeline Studio" }] : []);

  return (
    <StudioContext.Provider value={ctx}><LinkContext.Provider value={linked}>
      <div className="flex h-full flex-col">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line bg-surface px-3 py-2">
          <Workflow className="size-4 shrink-0 text-accent" />
          <input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} aria-label="Workflow name" title="Workflow name"
            className="min-w-24 w-48 shrink rounded-md bg-transparent px-1.5 py-1 text-[14px] font-semibold hover:bg-raised focus:bg-raised focus:outline-none" />
          {dirty ? <Badge tone="wait">Unsaved</Badge> : wfId ? <Badge>Saved</Badge> : null}
          {wfId && (() => {
            const w = workflowsQ.data?.find((x) => x.id === wfId);
            if (!w || !pipelinesQ.data) return null;
            const st = publishState(w, pipelinesQ.data);
            return !st.published ? <Tip content="Saved workflows stay in Studio. Publish adds this one to the Pipelines library so it can be run."><span tabIndex={0} className="inline-flex cursor-help rounded"><Badge tone="neutral">Not published</Badge></span></Tip>
              : st.changed || dirty ? <Tip content={`Pipelines has ${st.version}, without your latest changes. Publish to update it.`}><span tabIndex={0} className="inline-flex cursor-help rounded"><Badge tone="wait">{st.version} · changed</Badge></span></Tip>
              : <Tip content={`Pipelines has this workflow as ${st.version}.`}><span tabIndex={0} className="inline-flex cursor-help rounded"><Badge tone="ok"><CheckCircle2 className="size-3" aria-hidden />Published {st.version}</Badge></span></Tip>;
          })()}
          {wfMeta && wfMeta.created_by !== me && <SharingBadge owner={wfMeta.created_by} visibility={wfMeta.visibility} />}
          {wfMeta && !wfMeta.can_edit && <Tip content="You can change it on the canvas; Save keeps your changes as your own copy."><span tabIndex={0} className="inline-flex cursor-help rounded"><Badge tone="wait">Read-only</Badge></span></Tip>}
          {wfMeta?.can_edit && wfMeta.created_by === me && <ShareButton visibility={wfMeta.visibility} onChange={setVisibility} compact />}
          <div className="mx-0.5 h-5 w-px bg-line" />
          <Tip content={wfMeta && !wfMeta.can_edit ? "Save your own copy (Ctrl+S)" : "Save in Studio (Ctrl+S). Publish adds it to Pipelines."}><Button size="sm" variant="ghost" onClick={() => save()} loading={busy === "save"}><Save />{wfMeta && !wfMeta.can_edit ? "Save a copy" : "Save"}</Button></Tip>
          <Tip content="Undo (Ctrl+Z)"><Button size="icon" variant="ghost" onClick={undo} disabled={!past.current.length} aria-label="Undo"><Undo2 /></Button></Tip>
          <Tip content="Redo (Ctrl+Shift+Z)"><Button size="icon" variant="ghost" onClick={redo} disabled={!future.current.length} aria-label="Redo"><Redo2 /></Button></Tip>
          <Tip content={<div className="space-y-1"><p>Every workflow built here can be exported as a Nextflow pipeline (DSL2): per-sample and all-sample steps, branches, joins and merges.</p><p className="text-muted">Nextflow scripts written by hand cannot be imported back onto the canvas.</p></div>}>
            <span tabIndex={0} className="hidden 2xl:inline-flex cursor-help rounded border border-line px-1.5 py-px text-[11.5px] text-muted">Exports to Nextflow</span>
          </Tip>
          <div className="flex-1" />
          <Button size="sm" variant={assistantOpen ? "primary" : "secondary"} onClick={() => setAssistantOpen((o) => !o)} aria-pressed={assistantOpen}><Sparkles />Assistant</Button>
          <Tip content="Check the workflow for problems"><Button size="sm" variant="secondary" onClick={validate} loading={validating}><ShieldCheck />Validate</Button></Tip>
          {(() => {
            const pl = wfId && wfMeta?.can_edit !== false ? (pipelinesQ.data ?? []).find((x) => x.studio_workflow_id === wfId) : undefined;
            const n = Number(/^v(\d+)$/.exec(pl?.latest_version?.version ?? "")?.[1] ?? 0);
            return (
              <Tip content={n ? `Saves the workflow and adds it to “${pl!.name}” as v${n + 1}. Earlier versions stay available and runnable.` : "Saves the workflow and adds it to the Pipelines library, where it can be run."}>
                <Button size="sm" variant="primary" onClick={publish} loading={busy === "publish"} disabled={!nodes.length}><Rocket />{n ? `Publish v${n + 1}` : "Publish"}</Button>
              </Tip>
            );
          })()}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="secondary" aria-label="More actions"><MoreHorizontal />More</Button></DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-64">
              <DropdownMenuItem onSelect={() => { newWorkflow(); }}><FilePlus2 />New workflow</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setOpenDlg(true)}><FolderOpen />Open a saved workflow…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDetailsOpen(true)}><Info />Name and description…</DropdownMenuItem>
              <DropdownMenuItem disabled={!selected.length} onSelect={openSubDialog}><Layers />Save {selected.length > 1 ? `the ${selected.length} selected steps` : "the selected steps"} as a subworkflow…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!nodes.length || busy === "compile"} onSelect={showCode}><Code2 />Show the generated code</DropdownMenuItem>
              <DropdownMenuItem disabled={!nodes.length || busy === "export"} onSelect={exportZip}><Download />Export as a Nextflow pipeline (.zip)</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Examples (replace the canvas)</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => { loadExample("chip"); }}><Workflow />ChIP-seq: FastQC, fastp, Bowtie2, MACS3, MultiQC</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { loadExample("qc"); }}><Workflow />Portable QC (runs anywhere, no extra tools)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="relative flex min-h-0 flex-1">
          {!paletteOpen ? (
            <aside className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-line bg-surface py-2" aria-label="Module library (hidden)">
              <Tip side="right" content="Show the module library">
                <Button size="icon" variant="ghost" onClick={() => togglePalette(true)} aria-label="Show the module library" aria-expanded={false}><PanelLeftOpen /></Button>
              </Tip>
              <span className="text-[11px] font-medium text-muted [writing-mode:vertical-rl]">Modules</span>
            </aside>
          ) : modulesQ.data ? (
            <Palette onCollapse={() => togglePalette(false)} modules={modulesQ.data.modules} portTypes={portTypes} customAllowed={modulesQ.data.custom_code_allowed}
              subworkflows={subworkflows} onAdd={(m) => addModule(m)} onInsertSub={(w) => insertSubworkflow(w)} onDeleteSub={deleteWorkflow}
              onAddSoftware={() => setFinderOpen(true)} onEditModule={editModule} onExportModule={exportModule} onDeleteModule={deleteModule}
              onShareModule={async (m, v) => {
                try {
                  await api.put(`/api/studio/modules/${m.id}/visibility`, { visibility: v });
                  qc.invalidateQueries({ queryKey: ["studio-modules"] });
                  toast.success(v === "lab" ? `“${m.name}” is shared with the lab` : `“${m.name}” is private`);
                } catch (e) { toast.error(errMsg(e)); }
              }} />
          ) : (
            <aside className="flex w-64 items-center justify-center border-r border-line bg-surface text-muted">
              {modulesQ.isError ? (
                <div role="alert" className="space-y-2 px-4 text-center text-[13px]">
                  <p className="text-bad">Could not load the module library: {errMsg(modulesQ.error)}</p>
                  <Button size="sm" variant="secondary" onClick={() => modulesQ.refetch()}>Try again</Button>
                </div>
              ) : <Loader2 className="size-5 animate-spin" aria-label="Loading the module library" />}
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
                  nodeColor={(n) => (n.selected ? "rgb(var(--accent))" : linked[n.id] ? "rgb(var(--link))" : issuesByNode[n.id]?.some((i) => i.level === "error") ? "rgb(var(--bad))" : "rgb(var(--muted) / 0.6)")}
                  maskColor="rgb(var(--ink) / 0.6)" />
              </ReactFlow>

              {draft && (
                <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-wait/50 bg-surface px-3 py-2 text-[13px] shadow-lg" role="status">
                  <History className="size-4 text-wait" />
                  <span>Unsaved workflow <b className="font-medium">{draft.name}</b> from <Ago ts={draft.at} /> ({(draft.graph.nodes ?? []).length} steps)</span>
                  <Button size="sm" variant="primary" onClick={restoreDraft}>Restore</Button>
                  <Button size="sm" variant="ghost" onClick={discardDraft}>Discard</Button>
                </div>
              )}
              {nodes.length === 0 && !draft && (!routeId || wfId === routeId) && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-y-auto p-6">
                  <div className="pointer-events-auto max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-line bg-surface/95 p-5 shadow-xl">
                    <div className="text-center">
                      <Workflow className="mx-auto mb-2 size-7 text-accent" />
                      <h2 className="font-medium">{recent.length || nfCopies.length ? "Continue a workflow, or build a new one" : "Build a workflow"}</h2>
                      <p className="mt-1 text-[13px] text-muted">
                        To start a new one, drag modules from the library on the left and connect outputs to inputs of the same type.
                        Start with a samplesheet input, or load a complete example.
                      </p>
                    </div>
                    {workflowsQ.isError && <p role="alert" className="mt-3 text-center text-[13px] text-bad">Could not load your saved workflows: {errMsg(workflowsQ.error)} <button className="underline underline-offset-2" onClick={() => workflowsQ.refetch()}>Try again</button></p>}
                    {recent.length > 0 && (
                      <section className="mt-4" aria-label="Recent workflows">
                        <div className="mb-1 flex items-center justify-between">
                          <h3 className="text-[11.5px] font-medium uppercase tracking-wide text-muted">Recent workflows</h3>
                          {workflows.length > recent.length && <button className="text-xs text-accent hover:underline" onClick={() => setOpenDlg(true)}>All {workflows.length} workflows</button>}
                        </div>
                        <ul className="divide-y divide-line/70 rounded-lg border border-line">
                          {recent.map((w) => {
                            const st = pipelinesQ.data ? publishState(w, pipelinesQ.data) : null;
                            return (
                              <li key={w.id}>
                                <button className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-raised/70" onClick={() => openWorkflow(w.id)}>
                                  <Workflow className="size-4 shrink-0 text-muted" />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[13.5px] font-medium">{w.name}</span>
                                    <span className="block truncate text-xs text-muted">
                                      {w.graph.nodes.length} step{w.graph.nodes.length === 1 ? "" : "s"}, updated <Ago ts={w.updated_at} />{w.created_by && w.created_by !== me ? ` by ${w.created_by}` : ""}
                                    </span>
                                  </span>
                                  {st && (!st.published ? <Badge>Not published</Badge> : st.changed ? <Badge tone="wait">{st.version} · changed</Badge> : <Badge tone="ok">Published {st.version}</Badge>)}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    )}
                    {nfCopies.length > 0 && (
                      <section className="mt-4" aria-label="Your Nextflow pipeline copies">
                        <h3 className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-muted">Your Nextflow pipeline copies</h3>
                        <ul className="divide-y divide-line/70 rounded-lg border border-line">
                          {nfCopies.slice(0, 4).map((p) => (
                            <li key={p.id}>
                              <button className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-raised/70" onClick={() => openCopy(p.id)}>
                                <GitBranch className="size-4 shrink-0 text-muted" />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[13.5px] font-medium">{p.name}</span>
                                  <span className="block truncate text-xs text-muted">{p.latest_version?.version} · copy of {(p.source_url ?? "").replace(/^(copy|duplicate):/, "")}</span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                        {nfCopies.length > 4 && <button className="mt-1 text-xs text-accent hover:underline" onClick={() => setOpenDlg(true)}>All {nfCopies.length} copies</button>}
                      </section>
                    )}
                    <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                      <span className="text-xs text-muted">Examples:</span>
                      <Button size="sm" variant="secondary" disabled={!modulesQ.data} onClick={() => loadExample("qc")}>Portable QC</Button>
                      <Button size="sm" variant="secondary" disabled={!modulesQ.data} onClick={() => loadExample("chip")}>ChIP-seq</Button>
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
                <span>{nodes.length} step{nodes.length === 1 ? "" : "s"}, {edges.length} connection{edges.length === 1 ? "" : "s"}</span>
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
                        <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", i.level === "error" ? "bg-bad" : i.level === "warning" ? "bg-wait" : "bg-muted")} aria-hidden />
                        <span className="flex-1"><span className={cn("mr-1.5 text-xs font-medium", i.level === "error" ? "text-bad" : i.level === "warning" ? "text-wait" : "text-muted")}>{i.level === "error" ? "Error" : i.level === "warning" ? "Warning" : "Note"}</span>{i.message}</span>
                        {i.node && <span className="text-xs text-muted">Show step</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Step settings and assistant: docked beside the canvas from xl up, laid over its right edge below xl.
              Below 2xl only one shows at a time (the settings of the selected step first; close them to get back to
              the assistant), so a 1366 px laptop keeps a usable canvas. */}
          {(selected.length > 0 || assistantOpen) && (
            <div className="absolute inset-y-0 right-0 z-20 flex max-w-full shadow-2xl shadow-black/40 xl:static xl:z-auto xl:shadow-none">
              {single ? (
                <Inspector key={single.id} node={single} mod={modIndex[single.data.module]} portTypes={portTypes} issues={issuesByNode[single.id] ?? []}
                  onChange={(p) => updateNodeData(single.id, p)} onDelete={() => deleteNodes([single.id])} onDuplicate={() => duplicateNode(single)} onClose={deselect}
                  onSaveAsModule={(def) => openBuilder(normalizeModule(def), false, "Saved modules appear in the library and can be reused in any pipeline. The step on the canvas keeps its own copy of the script.")} />
              ) : selected.length > 1 ? (
                <aside className="w-80 max-w-full shrink-0 border-l border-line bg-surface p-4 space-y-3" aria-label="Selected steps">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold">{selected.length} steps selected</p>
                    <button onClick={deselect} className="rounded p-1 text-muted hover:bg-raised hover:text-text" aria-label="Clear the selection" title="Clear the selection"><X className="size-4" /></button>
                  </div>
                  <p className="text-[13px] text-muted">Save them as a reusable subworkflow, or delete them together.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={openSubDialog}><Layers />Save as subworkflow</Button>
                    <Button size="sm" variant="danger" onClick={() => deleteNodes(selected.map((n) => n.id))}><Trash2 />Delete</Button>
                  </div>
                </aside>
              ) : null}
              {assistantOpen && (
                <AssistantPanel className={cn(selected.length > 0 && "hidden 2xl:flex")}
                  getGraph={() => serialize(graphRef.current)} hasNodes={nodes.length > 0} onClose={() => setAssistantOpen(false)}
                  onLoad={loadFromAssistant} onSelectNode={selectNode} onDraftModule={draftModuleFor}
                  nodeLabel={(id) => nodes.find((n) => n.id === id)?.data.label ?? null} />
              )}
            </div>
          )}
        </div>
      </div>

      <ModuleBuilder open={builder.open} onOpenChange={(o) => setBuilder((b) => ({ ...b, open: o }))} initial={builder.def} editing={builder.editing}
        notes={builder.notes} portTypes={portTypes} />
      <ToolFinder open={finderOpen} onOpenChange={setFinderOpen} modules={modulesQ.data?.modules ?? []} onCreate={(d, notes) => openBuilder(d, false, notes ?? null)} />

      <CodePreview open={codeOpen} onOpenChange={setCodeOpen} files={codeFiles} />

      <Dialog open={openDlg} onOpenChange={setOpenDlg}>
        <DialogContent title="Open a saved workflow" description="Workflows saved in Pipeline Studio. Subworkflows are listed in the module library.">
          {workflows.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted">No saved workflows yet. Build one and choose Save.</p>
          ) : (
            <ul className="divide-y divide-line">
              {[...workflows].sort((x, y) => Number(x.created_by !== me) - Number(y.created_by !== me)).map((w) => (
                <li key={w.id} className="flex items-center gap-3 py-2">
                  <button className="min-w-0 flex-1 text-left" onClick={() => { setOpenDlg(false); openWorkflow(w.id); }}>
                    <p className="truncate text-[13.5px] font-medium hover:text-accent">{w.name}</p>
                    <p className="truncate text-xs text-muted">{w.graph.nodes.length} step{w.graph.nodes.length === 1 ? "" : "s"}, updated <Ago ts={w.updated_at} />{w.created_by ? ` by ${w.created_by === me ? "you" : w.created_by}` : ""}</p>
                  </button>
                  {w.created_by === me ? (w.visibility === "lab" && <Badge tone="accent">shared</Badge>) : <SharingBadge owner={w.created_by} visibility={w.visibility} />}
                  {w.id === wfId && <Badge tone="accent">Open</Badge>}
                  {w.can_edit && <Button size="icon" variant="ghost" onClick={() => deleteWorkflow(w)} aria-label={`Delete ${w.name}`}><Trash2 /></Button>}
                </li>
              ))}
            </ul>
          )}
          {nfCopies.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-muted">Your Nextflow pipeline copies</p>
              <ul className="max-h-64 divide-y divide-line overflow-y-auto">
                {nfCopies.map((p) => (
                  <li key={p.id} className="py-2">
                    <button className="w-full text-left" onClick={() => { setOpenDlg(false); openCopy(p.id); }}>
                      <p className="truncate text-[13.5px] font-medium hover:text-accent">{p.name}</p>
                      <p className="truncate text-xs text-muted">{p.latest_version?.version} · copy of {(p.source_url ?? "").replace(/^(copy|duplicate):/, "")}</p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
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
          description={`${selected.length} step${selected.length === 1 ? "" : "s"} and the connections between them. Inserting a subworkflow adds copies of these steps; in the exported Nextflow pipeline they appear as ordinary steps.`}>
          <form onSubmit={(e) => { e.preventDefault(); saveSubworkflow(); }}>
            <Field label="Name"><Input autoFocus value={subName} onChange={(e) => setSubName(e.target.value)} placeholder="e.g. Trim and align" /></Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setSubDlg(false)}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!subName.trim()}>Save subworkflow</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </LinkContext.Provider></StudioContext.Provider>
  );
}

interface Draft { wfId: string | null; name: string; description: string; graph: { nodes: unknown[]; edges: unknown[] }; at: string; resultId?: string | null }

function readDraft(key: string): Draft | null {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as Draft) : null; } catch { return null; }
}
function writeDraft(key: string, d: Draft) {
  try { localStorage.setItem(key, JSON.stringify(d)); } catch { /* storage full or blocked: the beforeunload warning still applies */ }
}
function clearDraft(key: string) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
