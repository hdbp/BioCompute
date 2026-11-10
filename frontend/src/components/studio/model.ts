import { createContext, useContext } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { Issue, StudioModule } from "@/lib/types";

export type Port = { name: string; type: string; multiple?: boolean; pattern?: string };

export interface ModuleData extends Record<string, unknown> {
  module: string;
  label: string;
  params: Record<string, unknown>;
  cpus?: number;
  memory_gb?: number;
  publish?: boolean;
  env?: "container" | "conda" | "system";
  script?: string;
  custom?: {
    language?: string;
    scope?: "per_sample" | "aggregate";
    inputs?: Port[];
    outputs?: Port[];
  };
}

export type StudioNode = Node<ModuleData, "module">;
export type Graph = { nodes: StudioNode[]; edges: Edge[] };
export type PortTypes = Record<string, { label: string; color: string }>;

export interface StudioCtx {
  modules: Record<string, StudioModule>;
  portTypes: PortTypes;
  issuesByNode: Record<string, Issue[]>;
}
export const StudioContext = createContext<StudioCtx>({ modules: {}, portTypes: {}, issuesByNode: {} });
export const useStudio = () => useContext(StudioContext);

/** Effective spec of a node = module definition + per-node custom overrides (mirrors backend Graph._spec). */
export function effective(mod: StudioModule | undefined, data: ModuleData) {
  const inputs: Port[] = data.custom?.inputs ?? mod?.inputs ?? [];
  let outputs: Port[] = data.custom?.outputs ?? mod?.outputs ?? [];
  if (mod?.id === "input_file") outputs = [{ name: "file", type: String(data.params?.file_type ?? "any") }];
  const scope = mod?.kind === "source" ? (mod.id === "input_samplesheet" ? "per_sample" : "value") : (data.custom?.scope ?? mod?.scope ?? "per_sample");
  return { inputs, outputs, scope, language: data.custom?.language ?? mod?.language ?? "bash" };
}

let seq = 0;
export const newId = (prefix = "n") => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export function makeNode(mod: StudioModule, position: { x: number; y: number }, overrides: Partial<ModuleData> = {}, id?: string): StudioNode {
  const params: Record<string, unknown> = {};
  for (const p of mod.params) params[p.name] = p.default;
  return {
    id: id ?? newId(mod.id.slice(0, 6)),
    type: "module",
    position,
    data: {
      module: mod.id,
      label: mod.name,
      params: { ...params, ...(overrides.params ?? {}) },
      cpus: mod.cpus,
      memory_gb: mod.memory_gb,
      publish: mod.kind === "module" ? true : undefined,
      env: mod.container ? "container" : mod.conda ? "conda" : "system",
      ...overrides,
      ...(overrides.params ? { params: { ...params, ...overrides.params } } : {}),
    },
  };
}

export function serialize(g: Graph) {
  return {
    nodes: g.nodes.map((n) => ({ id: n.id, type: "module", position: n.position, data: n.data })),
    edges: g.edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle })),
  };
}

export function deserialize(raw: { nodes?: unknown[]; edges?: unknown[] } | undefined): Graph {
  const nodes = ((raw?.nodes ?? []) as StudioNode[]).map((n) => ({ ...n, type: "module" as const }));
  const edges = ((raw?.edges ?? []) as Edge[]).map((e) => ({ ...e }));
  return { nodes, edges };
}
