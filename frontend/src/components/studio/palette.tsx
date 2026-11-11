import { useMemo, useState } from "react";
import { Download, Layers, PackagePlus, Pencil, Puzzle, Search, Trash2 } from "lucide-react";
import type { StudioModule, StudioWorkflow } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import type { PortTypes } from "./model";

export const DND_MODULE = "application/x-biocompute-module";
export const DND_SUBWORKFLOW = "application/x-biocompute-subworkflow";

const CATEGORY_ORDER = ["Inputs", "Quality control", "Preprocessing", "Alignment", "Peak calling", "Quantification", "Visualization", "Reporting", "Outputs", "My modules", "Custom code"];

export function Palette({ modules, portTypes, customAllowed, subworkflows, onAdd, onInsertSub, onDeleteSub, onAddSoftware, onEditModule, onExportModule, onDeleteModule }: {
  modules: StudioModule[]; portTypes: PortTypes; customAllowed: boolean; subworkflows: StudioWorkflow[];
  onAdd: (m: StudioModule) => void; onInsertSub: (w: StudioWorkflow) => void; onDeleteSub: (w: StudioWorkflow) => void;
  onAddSoftware: () => void; onEditModule: (m: StudioModule) => void; onExportModule: (m: StudioModule) => void; onDeleteModule: (m: StudioModule) => void;
}) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const f = q.toLowerCase();
    const list = modules.filter((m) => !f || m.name.toLowerCase().includes(f) || m.description.toLowerCase().includes(f) || m.category.toLowerCase().includes(f) || (m.tools ?? []).some((t) => t.toLowerCase().includes(f)));
    const by: Record<string, StudioModule[]> = {};
    list.forEach((m) => (by[m.category] ??= []).push(m));
    return Object.entries(by).sort(([a], [b]) => (CATEGORY_ORDER.indexOf(a) + 100) % 100 - (CATEGORY_ORDER.indexOf(b) + 100) % 100);
  }, [modules, q]);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface" aria-label="Module library">
      <div className="border-b border-line p-3">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 size-3.5 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search modules or tools" className="pl-7 h-8" aria-label="Search modules" />
        </div>
        <p className="mt-2 text-[11.5px] text-muted">Drag onto the canvas, or click to add.</p>
        {customAllowed && (
          <Tip content="Create modules for software installed on your computers (another peak caller, aligner, ...)">
            <Button size="sm" variant="secondary" className="mt-2 w-full" onClick={onAddSoftware}><PackagePlus />Add software as a module</Button>
          </Tip>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {groups.map(([cat, mods]) => (
          <section key={cat} className="mb-3">
            <h4 className="px-1.5 pb-1 text-xs font-medium text-muted">{cat}</h4>
            <ul className="space-y-1">
              {mods.map((m) => {
                const disabled = !!(m.custom || m.user) && !customAllowed;
                const ports = [...m.inputs.map((p) => p.type), ...m.outputs.map((p) => p.type)];
                return (
                  <li key={m.id} className={cn(m.user && "group/mod relative")}>
                    <Tip side="right" content={<div className="space-y-1"><p>{m.description}</p>{m.tools?.length ? <p className="text-muted">Requires: {m.tools.join(", ")}</p> : null}{m.user && <p className="text-muted">Your module ({m.id})</p>}{disabled && <p className="text-wait">Custom code is disabled by the administrator.</p>}</div>}>
                      <button
                        draggable={!disabled}
                        disabled={disabled}
                        onDragStart={(e) => { e.dataTransfer.setData(DND_MODULE, m.id); e.dataTransfer.effectAllowed = "move"; }}
                        onClick={() => onAdd(m)}
                        className={cn("group flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-[13px] hover:border-line hover:bg-raised/70 cursor-grab active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40")}
                      >
                        <span className="flex-1 truncate">{m.name}</span>
                        <span className="flex gap-0.5" aria-hidden>
                          {[...new Set(ports)].slice(0, 4).map((t) => (
                            <span key={t} className="size-2 rounded-full" style={{ background: portTypes[t]?.color ?? "#94a3b8" }} />
                          ))}
                        </span>
                      </button>
                    </Tip>
                    {m.user && (
                      <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center rounded-md bg-surface shadow-sm group-hover/mod:flex group-focus-within/mod:flex">
                        <button onClick={() => onEditModule(m)} className="rounded p-1 text-muted hover:text-text" aria-label={`Edit module ${m.name}`}><Pencil className="size-3.5" /></button>
                        <button onClick={() => onExportModule(m)} className="rounded p-1 text-muted hover:text-text" aria-label={`Export module ${m.name}`}><Download className="size-3.5" /></button>
                        <button onClick={() => onDeleteModule(m)} className="rounded p-1 text-muted hover:text-bad" aria-label={`Delete module ${m.name}`}><Trash2 className="size-3.5" /></button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {groups.length === 0 && <p className="px-2 py-6 text-center text-[13px] text-muted">No modules match “{q}”.</p>}

        <section className="mb-3 border-t border-line pt-3">
          <h4 className="flex items-center gap-1.5 px-1.5 pb-1 text-xs font-medium text-muted"><Puzzle className="size-3.5" />Saved subworkflows</h4>
          {subworkflows.length === 0 ? (
            <p className="px-1.5 text-[12px] text-muted">Select several nodes and choose “Save selection as subworkflow” to reuse them here.</p>
          ) : (
            <ul className="space-y-1">
              {subworkflows.map((w) => (
                <li key={w.id} className="group flex items-center gap-1">
                  <button draggable onDragStart={(e) => { e.dataTransfer.setData(DND_SUBWORKFLOW, w.id); e.dataTransfer.effectAllowed = "move"; }}
                    onClick={() => onInsertSub(w)} title={w.description || "Insert subworkflow"}
                    className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-raised/70 cursor-grab">
                    <Layers className="size-3.5 text-accent" />
                    <span className="flex-1 truncate">{w.name}</span>
                    <span className="text-[11px] text-muted tabular-nums">{w.graph.nodes.length}</span>
                  </button>
                  <button onClick={() => onDeleteSub(w)} className="rounded p-1 text-muted opacity-0 hover:text-bad group-hover:opacity-100 focus:opacity-100" aria-label={`Delete subworkflow ${w.name}`}>
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="border-t border-line pt-3 px-1.5">
          <h4 className="pb-1.5 text-xs font-medium text-muted">Port types</h4>
          <ul className="grid grid-cols-1 gap-1 text-[12px] text-muted">
            {Object.entries(portTypes).map(([k, v]) => (
              <li key={k} className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: v.color }} />{v.label}</li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}
