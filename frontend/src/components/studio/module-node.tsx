import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertTriangle, Code2, Database, FileInput, FolderOutput, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { effective, useStudio, type StudioNode } from "./model";

function ModuleNodeImpl({ id, data, selected }: NodeProps<StudioNode>) {
  const { modules, portTypes, issuesByNode } = useStudio();
  const mod = modules[data.module];
  const spec = effective(mod, data);
  const issues = issuesByNode[id] ?? [];
  const errors = issues.filter((i) => i.level === "error");
  const color = (t: string) => portTypes[t]?.color ?? "#94a3b8";
  const typeName = (t: string) => portTypes[t]?.label ?? t;
  const Icon = mod?.kind === "source" ? (mod.id === "input_file" ? Database : FileInput) : mod?.kind === "sink" ? FolderOutput : mod?.custom ? Code2 : Layers;
  const rows = Math.max(spec.inputs.length, spec.outputs.length);

  return (
    <div
      className={cn(
        "min-w-[210px] max-w-[260px] rounded-lg border bg-surface shadow-lg shadow-black/20 text-[12.5px]",
        selected ? "border-accent ring-2 ring-accent/25" : errors.length ? "border-bad/60" : "border-line",
      )}
    >
      <div className={cn("flex items-center gap-2 rounded-t-lg border-b border-line px-2.5 py-2",
        mod?.kind === "source" ? "bg-run/10" : mod?.kind === "sink" ? "bg-ok/10" : "bg-raised/60")}>
        <Icon className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate font-medium text-text" title={data.label}>{data.label}</span>
          {mod && mod.name !== data.label && <span className="block truncate text-[10.5px] font-normal text-muted">{mod.name}</span>}
        </span>
        {errors.length > 0 && (
          <span title={errors.map((e) => e.message).join("\n")} className="text-bad"><AlertTriangle className="size-3.5" /></span>
        )}
        {!errors.length && issues.length > 0 && (
          <span title={issues.map((e) => e.message).join("\n")} className="text-wait"><AlertTriangle className="size-3.5" /></span>
        )}
      </div>
      <div className="px-0 py-1.5">
        {Array.from({ length: rows }, (_, i) => {
          const inp = spec.inputs[i];
          const out = spec.outputs[i];
          return (
            <div key={i} className="relative flex h-6 items-center justify-between gap-3 px-3">
              {inp ? (
                <>
                  <Handle type="target" position={Position.Left} id={`in:${inp.name}`} style={{ background: color(inp.type), left: -6 }}
                    title={`Input ${inp.name}: ${typeName(inp.type)}${inp.multiple ? " (accepts several)" : ""}`}
                    aria-label={`Input ${inp.name}, type ${typeName(inp.type)}${inp.multiple ? ", accepts several connections" : ""}`} />
                  <span className="truncate text-muted" title={`${inp.name}: ${typeName(inp.type)}`}>{inp.name}{inp.multiple && <span className="text-muted/60"> +</span>}</span>
                </>
              ) : <span />}
              {out ? (
                <>
                  <span className="truncate text-right text-muted" title={`${out.name}: ${typeName(out.type)}`}>{out.name}</span>
                  <Handle type="source" position={Position.Right} id={`out:${out.name}`} style={{ background: color(out.type), right: -6 }}
                    title={`Output ${out.name}: ${typeName(out.type)}`} aria-label={`Output ${out.name}, type ${typeName(out.type)}`} />
                </>
              ) : <span />}
            </div>
          );
        })}
      </div>
      {mod?.kind === "module" && (
        <div className="flex items-center gap-1.5 border-t border-line px-2.5 py-1.5 text-[11px] text-muted">
          <span className={cn("rounded px-1 py-px", spec.scope === "aggregate" ? "bg-wait/12 text-wait" : "bg-run/12 text-run")}>
            {spec.scope === "aggregate" ? "All samples" : "Per sample"}
          </span>
          <span className="tabular-nums">{data.cpus ?? mod.cpus ?? 1} cpu, {data.memory_gb ?? mod.memory_gb ?? 1} GB</span>
          {data.publish === false && <span className="ml-auto">not published</span>}
        </div>
      )}
      {mod?.id === "input_samplesheet" && (() => {
        const src = String(data.params?.samplesheet || data.params?.fastq_folder || "");
        return (
          <div className="truncate border-t border-line px-2.5 py-1.5 text-[11px] text-muted" title={src || "Chosen when the pipeline is launched"}>
            data: {src ? <span className="font-mono">{src}</span> : "chosen at launch"}
          </div>
        );
      })()}
      {mod?.id === "input_file" && (
        <div className="border-t border-line px-2.5 py-1.5 font-mono text-[11px] text-muted truncate" title={String(data.params?.default_path ?? "")}>
          params.{String(data.params?.param_name ?? "")}{data.params?.default_path ? ` = ${String(data.params.default_path)}` : ""}
        </div>
      )}
    </div>
  );
}

export const ModuleNode = memo(ModuleNodeImpl);
export const nodeTypes = { module: ModuleNode };
