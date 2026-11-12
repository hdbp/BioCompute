import { useQuery } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { api, qs } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch, Tip } from "@/components/ui/misc";

export interface StepOverride { enabled?: false; args?: string; cpus?: number; memory?: string; time?: string; container?: string }
export type Overrides = Record<string, StepOverride>;
interface Current { selector: string; file: string; settings: Record<string, string> }
export interface StepsResponse { version_id: string; version: string; editable: boolean; overrides: Overrides; current: Record<string, Current[]> }
export interface StepInfo { id: string; name?: string; kind?: string; supports_when?: boolean; supports_args?: boolean; container?: string | null; resource_label?: string | null }

export function useStepSettings(pid: string, versionId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["pipeline-steps", pid, versionId ?? null], enabled,
    queryFn: () => api.get<StepsResponse>(`/api/pipelines/${pid}/steps${qs({ version_id: versionId })}`),
  });
}

export const cleanOverride = (o: StepOverride): StepOverride | null => {
  const c: StepOverride = {};
  if (o.enabled === false) c.enabled = false;
  if (o.args?.trim()) c.args = o.args.trim();
  if (o.cpus) c.cpus = o.cpus;
  if (o.memory?.trim()) c.memory = o.memory.trim();
  if (o.time?.trim()) c.time = o.time.trim();
  if (o.container?.trim()) c.container = o.container.trim();
  return Object.keys(c).length ? c : null;
};

/** off: switched off here; starved: everything it reads comes from steps that are off; edited: settings changed. */
export function stepStates(nodes: { id: string; kind: string; step_info?: StepInfo[] | null }[], edges: { source: string; target: string }[], ov: Overrides) {
  const states: Record<string, "off" | "starved" | "edited"> = {};
  const off = new Set<string>();
  for (const n of nodes) {
    const inner = (n.step_info ?? []).map((s) => s.id);
    if (ov[n.id]?.enabled === false || (inner.length > 0 && inner.every((s) => ov[s]?.enabled === false))) off.add(n.id);
  }
  const preds: Record<string, string[]> = {};
  for (const e of edges) (preds[e.target] ??= []).push(e.source);
  const dead = new Set(off);
  for (let changed = true; changed;) {
    changed = false;
    for (const n of nodes) {
      if (dead.has(n.id) || n.kind === "input") continue;
      const ps = preds[n.id] ?? [];
      if (ps.length && ps.every((p) => dead.has(p))) { dead.add(n.id); changed = true; }
    }
  }
  for (const n of nodes) {
    if (off.has(n.id)) states[n.id] = "off";
    else if (dead.has(n.id)) states[n.id] = "starved";
    else if (ov[n.id] || (n.step_info ?? []).some((s) => ov[s.id])) states[n.id] = "edited";
  }
  return states;
}

const unquote = (v: string | undefined) => (v && /^'[^']*'$|^"[^"]*"$/.test(v) ? v.slice(1, -1) : null);

/** Settings of one process: run it or not, tool arguments, resources, container. */
export function StepForm({ info, current, value, onChange, editable, compact }: {
  info: StepInfo; current: Current[]; value: StepOverride; onChange: (o: StepOverride) => void; editable: boolean; compact?: boolean;
}) {
  const pipelineArgs = current.map((c) => c.settings["ext.args"]).filter(Boolean).at(-1);
  const plainArgs = unquote(pipelineArgs);
  const set = (patch: Partial<StepOverride>) => onChange({ ...value, ...patch });
  const disabled = !editable;
  const field = "h-8 text-[12.5px]";
  return (
    <div className={cn("space-y-3", compact && "space-y-2")}>
      <label className={cn("flex items-start gap-3", !info.supports_when && "opacity-60")}>
        <Switch checked={value.enabled !== false} disabled={disabled || !info.supports_when} onCheckedChange={(on) => set({ enabled: on ? undefined : false })} className="mt-0.5" />
        <span className="text-[12.5px]">
          <span className="font-medium">Run this step</span>
          {!info.supports_when && <span className="block text-[11.5px] text-muted" title="Its code has no “when: task.ext.when” condition, which is what this switch sets.">This step cannot be switched off here, because its code has no on/off condition. Remove the step, or change it in the code.</span>}
        </span>
      </label>
      {value.enabled !== false && (
        <>
          <div className="space-y-1">
            <span className="text-[11.5px] text-muted">Tool arguments</span>
            <Input className={cn(field, "font-mono")} disabled={disabled || !info.supports_args} value={value.args ?? ""} onChange={(e) => set({ args: e.target.value })}
              placeholder={info.supports_args ? (plainArgs ?? (pipelineArgs ? "computed by the pipeline" : "none")) : "not supported by this step"} aria-label="Tool arguments" />
            {info.supports_args && (
              <p className="text-[11px] text-muted">
                {pipelineArgs ? <>Pipeline sets <span className="font-mono">{pipelineArgs.length > 80 ? `${pipelineArgs.slice(0, 80)}…` : pipelineArgs}</span>; yours replace it. </> : "Passed to the tool as extra command-line arguments. "}
                {plainArgs && editable && !value.args && <button className="text-accent hover:underline" onClick={() => set({ args: plainArgs })}>Start from it</button>}
              </p>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="space-y-1"><span className="text-[11.5px] text-muted">CPUs</span>
              <Input className={field} type="number" min={1} disabled={disabled} value={value.cpus ?? ""} placeholder={current.map((c) => c.settings.cpus).filter(Boolean).at(-1) ?? "default"}
                onChange={(e) => set({ cpus: e.target.value ? Number(e.target.value) : undefined })} aria-label="CPUs" /></label>
            <label className="space-y-1"><span className="text-[11.5px] text-muted">Memory</span>
              <Input className={field} disabled={disabled} value={value.memory ?? ""} placeholder={unquote(current.map((c) => c.settings.memory).filter(Boolean).at(-1)) ?? "e.g. 8 GB"}
                onChange={(e) => set({ memory: e.target.value })} aria-label="Memory" /></label>
            <label className="space-y-1"><span className="text-[11.5px] text-muted">Time limit</span>
              <Input className={field} disabled={disabled} value={value.time ?? ""} placeholder={unquote(current.map((c) => c.settings.time).filter(Boolean).at(-1)) ?? "e.g. 4h"}
                onChange={(e) => set({ time: e.target.value })} aria-label="Time limit" /></label>
          </div>
          {!compact && info.resource_label && <p className="text-[11px] text-muted">Empty: the pipeline's defaults for “{info.resource_label}”.</p>}
          <label className="block space-y-1"><span className="text-[11.5px] text-muted" title="The packaged software environment (Docker or Singularity image) this step runs in">Container image</span>
            <Input className={cn(field, "font-mono")} disabled={disabled} value={value.container ?? ""} placeholder={info.container ? `pipeline: ${info.container}` : "pipeline default"}
              onChange={(e) => set({ container: e.target.value })} aria-label="Container image" /></label>
        </>
      )}
      {editable && cleanOverride(value) && (
        <Tip content="Back to the pipeline's own settings for this step">
          <Button size="sm" variant="ghost" onClick={() => onChange({})}><RotateCcw />Reset this step</Button>
        </Tip>
      )}
    </div>
  );
}
