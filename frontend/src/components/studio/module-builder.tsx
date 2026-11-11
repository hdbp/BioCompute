import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Plus, Sparkles, Trash2 } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import type { AssistantStatus, ModuleCheck, ModuleDef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import type { PortTypes } from "./model";

export const emptyModule = (): ModuleDef => ({
  id: "u_", name: "", category: "My modules", description: "", scope: "per_sample", language: "bash",
  inputs: [{ name: "input", type: "any", multiple: false }],
  outputs: [{ name: "output", type: "any", pattern: "{prefix}.out" }],
  params: [], tools: [], conda: "", container: "", cpus: 1, memory_gb: 2,
  script: 'set -euo pipefail\n# Inputs: $BC_IN_INPUT   Threads: $BC_CPUS   Sample: $BC_PREFIX\n',
});

/** Fill in fields an imported or template definition may leave out. */
export function normalizeModule(raw: unknown): ModuleDef {
  const { biocompute_module: _v, kind: _k, user: _u, ...rest } = (raw ?? {}) as Record<string, unknown>;
  const m = { ...emptyModule(), ...rest } as ModuleDef;
  type P<T> = Partial<T> & Record<string, unknown>;
  m.inputs = ((m.inputs ?? []) as P<ModuleDef["inputs"][number]>[]).map((p) => ({ name: "", type: "any", multiple: false, ...p }) as ModuleDef["inputs"][number]);
  m.outputs = ((m.outputs ?? []) as P<ModuleDef["outputs"][number]>[]).map((p) => ({ name: "", type: "any", pattern: "", ...p }) as ModuleDef["outputs"][number]);
  m.params = ((m.params ?? []) as P<ModuleDef["params"][number]>[]).map((p) => ({ name: "", type: "string", default: null, enum: null, description: "", ...p }) as ModuleDef["params"][number]);
  return m;
}

const TEXT = "font-mono text-[12.5px]";

export function ModuleBuilder({ open, onOpenChange, initial, editing, portTypes, notes }: {
  open: boolean; onOpenChange: (o: boolean) => void; initial: ModuleDef; editing: boolean; portTypes: PortTypes; notes?: string | null;
}) {
  const qc = useQueryClient();
  const [m, setM] = useState<ModuleDef>(initial);
  const [check, setCheck] = useState<ModuleCheck | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiNotes, setAiNotes] = useState<string | null>(notes ?? null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const ai = useQuery({ queryKey: ["assistant-status"], queryFn: () => api.get<AssistantStatus>("/api/assistant/status"), staleTime: 60_000 });

  useEffect(() => { if (open) { setM(initial); setAiNotes(notes ?? null); setCheck(null); } }, [open, initial, notes]);

  // live server-side check (schema, names, script syntax, installed tools)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api.post<ModuleCheck>(`/api/studio/modules/check${editing ? `?existing_id=${encodeURIComponent(initial.id)}` : ""}`, m)
        .then(setCheck).catch(() => undefined);
    }, 600);
    return () => clearTimeout(t);
  }, [m, open, editing, initial.id]);

  const set = <K extends keyof ModuleDef>(k: K, v: ModuleDef[K]) => setM((x) => ({ ...x, [k]: v }));
  const types = Object.keys(portTypes);
  const errors = check?.issues.filter((i) => i.level === "error") ?? [];

  const save = async () => {
    setSaving(true);
    try {
      if (editing) await api.put(`/api/studio/modules/${initial.id}`, m);
      else await api.post("/api/studio/modules", m);
      qc.invalidateQueries({ queryKey: ["studio-modules"] });
      toast.success(`${editing ? "Updated" : "Added"} module “${m.name}”. It is in the library under ${m.category}.`);
      onOpenChange(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const draft = async () => {
    setAiBusy(true);
    try {
      const tool = m.tools[0] ?? "";
      const r = await api.post<{ module: ModuleDef; notes: string; grounded_on_help: boolean }>("/api/assistant/draft-module",
        { description: aiPrompt || m.description || `A module for ${tool}`, tool: tool || null });
      setM(normalizeModule(editing ? { ...r.module, id: initial.id } : r.module));
      setAiNotes(`${r.notes}${r.grounded_on_help ? "" : "\n(The tool's --help text was not available, so options were not checked against it.)"}`);
      toast.success("Draft loaded. Review it before saving.");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide className="max-w-5xl" title={editing ? `Edit module ${initial.id}` : "New module"}
        description="Wrap a program installed on the controller or the workers. The script reads its inputs and parameters from environment variables and writes outputs to the working directory.">
        <div className="grid gap-5 lg:grid-cols-[1fr_1.15fr]">
          <div className="space-y-4">
            {ai.data?.enabled && (
              <div className="rounded-lg border border-line bg-raised/40 p-3 space-y-2">
                <p className="flex items-center gap-1.5 text-[13px] font-medium"><Sparkles className="size-3.5 text-accent" />Draft with the assistant</p>
                <Textarea rows={2} value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="e.g. Call peaks with Genrich on name-sorted paired-end BAMs, ATAC mode optional" />
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={draft} loading={aiBusy}>Draft module</Button>
                  <span className="text-xs text-muted">Uses the first tool listed below and its --help text. Nothing is saved until you choose Save.</span>
                </div>
              </div>
            )}
            {aiNotes && <p className="whitespace-pre-wrap rounded-md border border-wait/40 bg-wait/10 px-3 py-2 text-[12.5px]">{aiNotes}</p>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name"><Input value={m.name} onChange={(e) => set("name", e.target.value)} placeholder="Genrich peaks" /></Field>
              <Field label="Id" hint={editing ? "Fixed: workflows refer to it" : "u_ + lowercase letters, digits, _"}>
                <Input className={TEXT} value={m.id} disabled={editing} onChange={(e) => set("id", e.target.value.toLowerCase())} />
              </Field>
              <Field label="Category"><Input value={m.category} onChange={(e) => set("category", e.target.value)} /></Field>
              <Field label="Runs">
                <Select value={m.scope} onChange={(e) => set("scope", e.target.value as ModuleDef["scope"])}>
                  <option value="per_sample">Once per sample</option>
                  <option value="aggregate">Once for all samples</option>
                </Select>
              </Field>
            </div>
            <Field label="Description"><Textarea rows={2} value={m.description} onChange={(e) => set("description", e.target.value)} /></Field>

            <ListEditor title="Inputs" onAdd={() => set("inputs", [...m.inputs, { name: `in${m.inputs.length + 1}`, type: "any", multiple: false }])}>
              {m.inputs.map((p, i) => (
                <Row key={i} cols="grid-cols-[minmax(0,1fr)_9rem_auto_auto]" onRemove={m.inputs.length > 1 ? () => set("inputs", m.inputs.filter((_, j) => j !== i)) : undefined}>
                  <Input aria-label="Input name" className={cn(TEXT, "h-8")} value={p.name} onChange={(e) => set("inputs", m.inputs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                  <TypeSelect types={types} portTypes={portTypes} value={p.type} onChange={(v) => set("inputs", m.inputs.map((x, j) => j === i ? { ...x, type: v } : x))} />
                  <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted">
                    <Checkbox checked={p.multiple} onCheckedChange={(c) => set("inputs", m.inputs.map((x, j) => j === i ? { ...x, multiple: !!c } : x))} />several
                  </label>
                </Row>
              ))}
            </ListEditor>
            <ListEditor title="Outputs" hint="File name pattern; {prefix} becomes the sample id" onAdd={() => set("outputs", [...m.outputs, { name: `out${m.outputs.length + 1}`, type: "any", pattern: "{prefix}.txt" }])}>
              {m.outputs.map((p, i) => (
                <Row key={i} onRemove={m.outputs.length > 1 ? () => set("outputs", m.outputs.filter((_, j) => j !== i)) : undefined}>
                  <Input aria-label="Output name" className={cn(TEXT, "h-8")} value={p.name} onChange={(e) => set("outputs", m.outputs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                  <TypeSelect types={types} portTypes={portTypes} value={p.type} onChange={(v) => set("outputs", m.outputs.map((x, j) => j === i ? { ...x, type: v } : x))} />
                  <Input aria-label="Output pattern" className={cn(TEXT, "h-8")} value={p.pattern} onChange={(e) => set("outputs", m.outputs.map((x, j) => j === i ? { ...x, pattern: e.target.value } : x))} />
                </Row>
              ))}
            </ListEditor>
            <ListEditor title="Parameters" hint="Shown in the launch form; read as $BC_PARAM_<NAME>" onAdd={() => set("params", [...m.params, { name: `param${m.params.length + 1}`, type: "string", default: "", enum: null, description: "" }])}>
              {m.params.map((p, i) => {
                const upd = (patch: Partial<ModuleDef["params"][number]>) => set("params", m.params.map((x, j) => j === i ? { ...x, ...patch } : x));
                return (
                  <div key={i} className="space-y-1.5 rounded-md border border-line/70 p-2">
                    <Row cols="grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_auto]" onRemove={() => set("params", m.params.filter((_, j) => j !== i))}>
                      <Input aria-label="Parameter name" className={cn(TEXT, "h-8")} value={p.name} onChange={(e) => upd({ name: e.target.value })} />
                      <Select aria-label="Parameter type" className="h-8" value={p.type} onChange={(e) => upd({ type: e.target.value as never, default: coerce(String(p.default ?? ""), e.target.value) })}>
                        {["string", "integer", "number", "boolean"].map((t) => <option key={t}>{t}</option>)}
                      </Select>
                      <Input aria-label="Default value" placeholder="default" className={cn(TEXT, "h-8")} value={p.default === null ? "" : String(p.default)}
                        onChange={(e) => upd({ default: coerce(e.target.value, p.type) })} />
                    </Row>
                    <div className="grid grid-cols-2 gap-2">
                      <Input aria-label="Description" placeholder="description" className="h-8" value={p.description} onChange={(e) => upd({ description: e.target.value })} />
                      <Input aria-label="Choices" placeholder="choices, comma separated (optional)" className="h-8" value={(p.enum ?? []).join(", ")}
                        onChange={(e) => { const v = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); upd({ enum: v.length ? v.map((x) => coerce(x, p.type) as string | number) : null }); }} />
                    </div>
                  </div>
                );
              })}
            </ListEditor>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3">
              <Field label="Programs it needs" hint="Checked on the controller's PATH">
                <Input className={TEXT} value={m.tools.join(", ")} onChange={(e) => set("tools", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} placeholder="Genrich, samtools" />
              </Field>
              <Field label="CPUs"><Input type="number" min={1} className="w-20" value={m.cpus} onChange={(e) => set("cpus", Number(e.target.value) || 1)} /></Field>
              <Field label="Memory GB"><Input type="number" min={0.5} step={0.5} className="w-24" value={m.memory_gb} onChange={(e) => set("memory_gb", Number(e.target.value) || 1)} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Conda package" hint="Used with the conda profile"><Input className={TEXT} value={m.conda} onChange={(e) => set("conda", e.target.value)} placeholder="bioconda::genrich=0.6.1" /></Field>
              <Field label="Container image" hint="Used with docker/apptainer profiles"><Input className={TEXT} value={m.container} onChange={(e) => set("container", e.target.value)} placeholder="quay.io/biocontainers/…" /></Field>
            </div>
            <div className="flex items-end gap-3">
              <Field label="Script language" className="w-40">
                <Select value={m.language} onChange={(e) => set("language", e.target.value as ModuleDef["language"])}>
                  <option value="bash">Bash</option><option value="python">Python</option><option value="r">R</option>
                </Select>
              </Field>
              <p className="pb-2 text-[11.5px] text-muted">
                Available: <code>$BC_PREFIX</code> <code>$BC_CPUS</code> {m.inputs.map((p) => <code key={p.name}>$BC_IN_{p.name.toUpperCase()} </code>)}
                {m.params.map((p) => <code key={p.name}>$BC_PARAM_{p.name.toUpperCase()} </code>)}
              </p>
            </div>
            <Field label="Script">
              <Textarea spellCheck={false} rows={16} className={cn(TEXT, "leading-relaxed")} value={m.script} onChange={(e) => set("script", e.target.value)} />
            </Field>
            <div aria-live="polite" className="space-y-1">
              {!check ? <p className="text-[12.5px] text-muted">Checking…</p>
                : check.issues.length === 0 ? <p className="flex items-center gap-1.5 text-[12.5px] text-ok"><CheckCircle2 className="size-3.5" />Definition and script check out.</p>
                : check.issues.map((i, k) => (
                  <p key={k} className={cn("flex items-start gap-1.5 text-[12.5px]", i.level === "error" ? "text-bad" : "text-wait")}>
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span>{i.field ? <b className="font-medium">{i.field}: </b> : null}{i.message}</span>
                  </p>
                ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!check || errors.length > 0}>{editing ? "Save changes" : "Add to library"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function coerce(v: string, type: string): string | number | boolean | null {
  if (v === "") return type === "string" ? "" : null;
  if (type === "integer") return Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : v;
  if (type === "number") return Number.isFinite(Number(v)) ? Number(v) : v;
  if (type === "boolean") return ["true", "1", "yes"].includes(v.toLowerCase());
  return v;
}

function ListEditor({ title, hint, onAdd, children }: { title: string; hint?: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="flex w-full items-center gap-2 pb-1">
        <span className="text-[13px] font-medium">{title}</span>
        {hint && <span className="text-[11.5px] text-muted">{hint}</span>}
        <Button type="button" size="sm" variant="ghost" className="ml-auto h-7" onClick={onAdd}><Plus />Add</Button>
      </legend>
      {children}
    </fieldset>
  );
}

function Row({ children, onRemove, cols = "grid-cols-[minmax(0,1fr)_9rem_minmax(0,1fr)_auto]" }: { children: React.ReactNode; onRemove?: () => void; cols?: string }) {
  return (
    <div className={cn("grid items-center gap-2", cols)}>
      {children}
      <button type="button" onClick={onRemove} disabled={!onRemove} aria-label="Remove"
        className="rounded p-1 text-muted hover:text-bad disabled:invisible"><Trash2 className="size-3.5" /></button>
    </div>
  );
}

function TypeSelect({ types, portTypes, value, onChange }: { types: string[]; portTypes: PortTypes; value: string; onChange: (v: string) => void }) {
  return (
    <Select aria-label="Port type" className="h-8" value={value} onChange={(e) => onChange(e.target.value)}
      style={{ borderLeft: `3px solid ${portTypes[value]?.color ?? "#94a3b8"}` }}>
      {types.map((t) => <option key={t} value={t}>{portTypes[t]?.label ?? t}</option>)}
    </Select>
  );
}
