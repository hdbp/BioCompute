import { Copy, FolderInput, PackagePlus, RotateCcw, Trash2 } from "lucide-react";
import { PathInput } from "@/components/file-browser";
import { ReferenceHint, ReferencePicker } from "@/components/reference-picker";
import type { Issue, ModuleDef, StudioModule } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Badge, Switch } from "@/components/ui/misc";
import { IssueList } from "@/components/page";
import { effective, type ModuleData, type Port, type PortTypes, type StudioNode } from "./model";

export function Inspector({ node, mod, portTypes, issues, onChange, onDelete, onDuplicate, onSaveAsModule }: {
  node: StudioNode; mod: StudioModule | undefined; portTypes: PortTypes; issues: Issue[];
  onChange: (patch: Partial<ModuleData>) => void; onDelete: () => void; onDuplicate: () => void;
  onSaveAsModule?: (def: ModuleDef) => void;
}) {
  const d = node.data;
  const spec = effective(mod, d);
  const isModule = mod?.kind === "module";
  const custom = !!mod?.custom;
  const setParam = (k: string, v: unknown) => onChange({ params: { ...d.params, [k]: v } });
  const setCustom = (patch: NonNullable<ModuleData["custom"]>) => onChange({ custom: { ...(d.custom ?? {}), ...patch } });
  const typeOptions = Object.entries(portTypes);

  const setPort = (side: "inputs" | "outputs", patch: Partial<Port>) => {
    const cur = (side === "inputs" ? spec.inputs : spec.outputs)[0] ?? { name: side === "inputs" ? "in" : "out", type: "any" };
    setCustom({ [side]: [{ ...cur, ...patch }] });
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface" aria-label="Node inspector">
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{d.label}</p>
          <p className="text-xs text-muted">{mod?.name ?? d.module}{mod?.category ? `, ${mod.category.toLowerCase()}` : ""}</p>
        </div>
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" onClick={onDuplicate} aria-label="Duplicate node" title="Duplicate"><Copy /></Button>
          <Button size="icon" variant="ghost" onClick={onDelete} aria-label="Delete node" title="Delete"><Trash2 /></Button>
        </div>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {mod?.description && <p className="text-[12.5px] text-muted">{mod.description}</p>}
        {mod?.kind === "source" && (
          <div className="flex gap-2 rounded-md border border-accent/30 bg-accent/5 p-2.5 text-[12.5px]">
            <FolderInput className="mt-0.5 size-4 shrink-0 text-accent" />
            <p>{mod.id === "input_samplesheet"
              ? "The data is chosen when the pipeline is launched: an experiment, a samplesheet file or a folder of FASTQ files. A default set below is pre-filled at launch and can still be changed there."
              : "The file is chosen when the pipeline is launched. A default set below is pre-filled there."}</p>
          </div>
        )}
        {issues.length > 0 && <IssueList issues={issues} className="rounded-md border border-line bg-ink/40 p-2.5" />}

        <Field label="Label" hint={isModule ? "Also determines the Nextflow process name." : undefined}>
          <Input value={d.label} onChange={(e) => onChange({ label: e.target.value })} />
        </Field>

        {mod && mod.params.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-xs font-medium text-muted">Parameters</h4>
            {mod.params.map((p) => {
              const v = d.params?.[p.name];
              const label = p.name.replace(/_/g, " ");
              if (p.widget === "path") {
                const mode = p.path_mode === "auto" ? (d.params?.format === "directory-path" ? "dir" : "file") : (p.path_mode ?? "file");
                return (
                  <Field key={p.name} label={p.name.replace(/_/g, " ")} hint={p.description}>
                    <div className="flex gap-1.5">
                      <div className="min-w-0 flex-1"><PathInput id={`param-${node.id}-${p.name}`} mode={mode} value={String(v ?? "")} onChange={(x) => setParam(p.name, x)} /></div>
                      <ReferencePicker value={String(v ?? "")} directory={mode === "dir"} onPick={(x) => setParam(p.name, x)} compact />
                    </div>
                    <ReferenceHint value={v} />
                  </Field>
                );
              }
              if (p.enum) {
                return (
                  <Field key={p.name} label={label} hint={p.description}>
                    <Select value={String(v ?? "")} onChange={(e) => {
                      const raw = e.target.value;
                      const orig = p.enum!.find((x) => String(x) === raw);
                      setParam(p.name, orig ?? raw);
                    }}>
                      {p.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                    </Select>
                  </Field>
                );
              }
              if (p.type === "boolean") {
                return (
                  <div key={p.name} className="flex items-center justify-between gap-3">
                    <div><p className="text-[13px] font-medium">{label}</p>{p.description && <p className="text-xs text-muted">{p.description}</p>}</div>
                    <Switch checked={!!v} onCheckedChange={(c) => setParam(p.name, c)} aria-label={label} />
                  </div>
                );
              }
              if (p.type === "integer" || p.type === "number") {
                return (
                  <Field key={p.name} label={label} hint={[p.description, p.minimum != null || p.maximum != null ? `Range ${p.minimum ?? "−∞"} to ${p.maximum ?? "∞"}` : null].filter(Boolean).join(". ")}>
                    <Input type="number" value={v == null ? "" : String(v)} min={p.minimum} max={p.maximum} step={p.type === "integer" ? 1 : "any"}
                      onChange={(e) => setParam(p.name, e.target.value === "" ? null : p.type === "integer" ? parseInt(e.target.value, 10) : parseFloat(e.target.value))} />
                  </Field>
                );
              }
              return (
                <Field key={p.name} label={label} hint={p.description}>
                  <Input value={v == null ? "" : String(v)} onChange={(e) => setParam(p.name, e.target.value)} className={p.name === "param_name" ? "font-mono text-[12px]" : undefined} />
                </Field>
              );
            })}
          </div>
        )}

        {isModule && (
          <>
            <div className="space-y-3">
              <h4 className="text-xs font-medium text-muted">Resources and environment</h4>
              <div className="grid grid-cols-2 gap-3">
                <Field label="CPUs"><Input type="number" min={1} value={d.cpus ?? mod?.cpus ?? 1} onChange={(e) => onChange({ cpus: Math.max(1, parseInt(e.target.value || "1", 10)) })} /></Field>
                <Field label="Memory (GB)"><Input type="number" min={0.5} step={0.5} value={d.memory_gb ?? mod?.memory_gb ?? 1} onChange={(e) => onChange({ memory_gb: Math.max(0.5, parseFloat(e.target.value || "1")) })} /></Field>
              </div>
              <Field label="Software environment" hint={
                d.env === "container" ? (mod?.container ? <span className="font-mono text-[11px] break-all">{mod.container}</span> : "No container defined; tools must be on the PATH.")
                : d.env === "conda" ? (mod?.conda ? <span className="font-mono text-[11px] break-all">{mod.conda}</span> : "No conda recipe defined; tools must be on the PATH.")
                : "Uses tools already installed on the execution node."}>
                <Select value={d.env ?? "system"} onChange={(e) => onChange({ env: e.target.value as ModuleData["env"] })}>
                  <option value="container" disabled={!mod?.container}>Container (Docker / Apptainer profile)</option>
                  <option value="conda" disabled={!mod?.conda}>Conda (conda profile)</option>
                  <option value="system">Installed software</option>
                </Select>
              </Field>
              {mod?.tools?.length ? (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">Requires {mod.tools.map((t) => <Badge key={t} className="font-mono">{t}</Badge>)}</div>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <div><p className="text-[13px] font-medium">Publish outputs</p><p className="text-xs text-muted">Copy results to the run's output folder.</p></div>
                <Switch checked={d.publish !== false} onCheckedChange={(c) => onChange({ publish: c })} aria-label="Publish outputs" />
              </div>
            </div>

            {custom && onSaveAsModule && (
              <Button size="sm" variant="secondary" className="w-full" onClick={() => onSaveAsModule({
                id: `u_${d.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "module"}`,
                name: d.label, category: "My modules", description: mod?.description ?? "", scope: spec.scope === "aggregate" ? "aggregate" : "per_sample",
                language: (spec.language as ModuleDef["language"]) ?? "bash",
                inputs: spec.inputs.map((x) => ({ name: x.name, type: x.type, multiple: !!x.multiple })),
                outputs: spec.outputs.map((x) => ({ name: x.name, type: x.type, pattern: x.pattern ?? "{prefix}.out" })),
                params: [], tools: mod?.tools ?? [], conda: "", container: "", cpus: d.cpus ?? 1, memory_gb: d.memory_gb ?? 2,
                script: String(d.script ?? mod?.script ?? ""),
              })}>
                <PackagePlus />Save as reusable module
              </Button>
            )}
            {custom && (
              <div className="space-y-3">
                <h4 className="text-xs font-medium text-muted">Custom module shape</h4>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Language">
                    <Select value={spec.language} onChange={(e) => setCustom({ language: e.target.value })}>
                      <option value="bash">Bash</option><option value="python">Python 3</option><option value="r">R</option>
                    </Select>
                  </Field>
                  <Field label="Runs">
                    <Select value={spec.scope} onChange={(e) => {
                      const scope = e.target.value as "per_sample" | "aggregate";
                      const cur = spec.inputs[0] ?? { name: "in", type: "any" };
                      setCustom({ scope, inputs: [{ ...cur, multiple: scope === "aggregate" }] });
                    }}>
                      <option value="per_sample">Per sample</option><option value="aggregate">Once, all samples</option>
                    </Select>
                  </Field>
                </div>
                <Field label="Input type" hint={`Available to the script as $BC_IN_${(spec.inputs[0]?.name ?? "in").toUpperCase()}`}>
                  <Select value={spec.inputs[0]?.type ?? "any"} onChange={(e) => setPort("inputs", { type: e.target.value, multiple: spec.scope === "aggregate" })}>
                    {typeOptions.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Output type">
                    <Select value={spec.outputs[0]?.type ?? "any"} onChange={(e) => setPort("outputs", { type: e.target.value })}>
                      {typeOptions.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="Output file pattern" hint="{prefix} = sample id">
                    <Input className="font-mono text-[12px]" value={spec.outputs[0]?.pattern ?? ""} onChange={(e) => setPort("outputs", { pattern: e.target.value })} />
                  </Field>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-medium text-muted">Script ({spec.language === "r" ? "R" : spec.language === "python" ? "Python" : "Bash"})</h4>
                {d.script !== undefined && d.script !== mod?.script && (
                  <button className="inline-flex items-center gap-1 text-xs text-muted hover:text-text" onClick={() => onChange({ script: undefined })}>
                    <RotateCcw className="size-3" />Reset to module default
                  </button>
                )}
              </div>
              <Textarea spellCheck={false} className="min-h-56 font-mono text-[11.5px] leading-relaxed" value={d.script ?? mod?.script ?? ""}
                onChange={(e) => onChange({ script: e.target.value })} aria-label="Module script" />
              <p className="text-[11.5px] text-muted">
                Inputs arrive as <code className="font-mono">$BC_IN_&lt;NAME&gt;</code>, parameters as <code className="font-mono">$BC_PARAM_&lt;NAME&gt;</code>, plus
                <code className="font-mono"> $BC_PREFIX</code> and <code className="font-mono">$BC_CPUS</code>. The same script runs under Nextflow and the native engine.
              </p>
            </div>
          </>
        )}

        {spec.outputs.length > 0 && isModule && (
          <div className="space-y-1">
            <h4 className="text-xs font-medium text-muted">Outputs</h4>
            <ul className="space-y-1 text-[12px]">
              {spec.outputs.map((o) => (
                <li key={o.name} className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ background: portTypes[o.type]?.color }} />
                  <span>{o.name}</span><span className="ml-auto font-mono text-[11px] text-muted truncate">{o.pattern}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}
