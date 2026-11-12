import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { ExperimentDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Panel, PanelHeader, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/misc";
import { confirmDialog } from "@/components/ui/confirm";
import { CONDITION_COLORS, conditionColor, type Row } from "./model";

type Meta = Pick<ExperimentDetail, "conditions" | "contrasts" | "custom_columns">;

export function DesignPanel({ exp, rows, readOnly, onMeta, onRenameCondition }: {
  exp: ExperimentDetail; rows: Row[]; readOnly?: boolean;
  onMeta: (patch: Partial<Meta>) => Promise<void> | void;
  onRenameCondition: (from: string, to: string | null) => void;
}) {
  const [newCond, setNewCond] = useState("");
  const [newCol, setNewCol] = useState("");
  const [ct, setCt] = useState({ treatment: "", reference: "" });
  const counts = new Map<string, number>();
  rows.forEach((r) => r.condition && counts.set(r.condition, (counts.get(r.condition) ?? 0) + 1));
  const undefinedConds = [...counts.keys()].filter((c) => !exp.conditions.some((x) => x.name === c));

  const addCondition = (name: string) => {
    const n = name.trim();
    if (!n || exp.conditions.some((c) => c.name === n)) return;
    onMeta({ conditions: [...exp.conditions, { name: n, color: CONDITION_COLORS[exp.conditions.length % CONDITION_COLORS.length] }] });
    setNewCond("");
  };
  const removeCondition = async (name: string) => {
    const used = exp.contrasts.filter((c) => c.treatment === name || c.reference === name);
    const n = counts.get(name) ?? 0;
    const ok = await confirmDialog({
      title: `Remove the condition “${name}”?`,
      body: (
        <div className="space-y-2">
          {used.length > 0 && (
            <p>
              {used.length === 1 ? "This comparison uses it and is removed too:" : `These ${used.length} comparisons use it and are removed too:`}{" "}
              <span className="font-medium">{used.map((c) => `${c.treatment} vs ${c.reference}`).join(", ")}</span>.
            </p>
          )}
          {n > 0 && <p>{n === 1 ? "1 sample loses" : `${n} samples lose`} this condition in the table (you can undo that until you save the rows).</p>}
          {!used.length && !n && <p>No sample or comparison uses it.</p>}
          <p className="text-muted">The design is saved immediately, so removing the condition{used.length ? " and its comparisons" : ""} cannot be undone.</p>
        </div>
      ),
      confirmLabel: used.length ? `Remove condition and ${used.length === 1 ? "1 comparison" : `${used.length} comparisons`}` : "Remove condition",
      danger: true,
    });
    if (!ok) return;
    onMeta({ conditions: exp.conditions.filter((c) => c.name !== name), contrasts: exp.contrasts.filter((c) => c.treatment !== name && c.reference !== name) });
    if (counts.get(name)) onRenameCondition(name, null);
  };
  const renameCondition = (from: string, to: string) => {
    const t = to.trim();
    if (!t || t === from || exp.conditions.some((c) => c.name === t)) return;
    onMeta({
      conditions: exp.conditions.map((c) => (c.name === from ? { ...c, name: t } : c)),
      contrasts: exp.contrasts.map((c) => ({ ...c, treatment: c.treatment === from ? t : c.treatment, reference: c.reference === from ? t : c.reference })),
    });
    onRenameCondition(from, t);
  };
  const recolor = (name: string, color: string) => onMeta({ conditions: exp.conditions.map((c) => (c.name === name ? { ...c, color } : c)) });

  const addContrast = () => {
    if (!ct.treatment || !ct.reference || ct.treatment === ct.reference) return;
    const name = `${ct.treatment}_vs_${ct.reference}`;
    if (exp.contrasts.some((c) => c.name === name)) return;
    onMeta({ contrasts: [...exp.contrasts, { id: name, name, ...ct }] });
    setCt({ treatment: "", reference: "" });
  };

  const addColumn = () => {
    const n = newCol.trim().replace(/\s+/g, "_");
    if (!n || exp.custom_columns.includes(n) || ["sample_id", "condition", "replicate", "batch", "files"].includes(n)) return;
    onMeta({ custom_columns: [...exp.custom_columns, n] });
    setNewCol("");
  };

  return (
    <Panel>
      <PanelHeader title="Design" description={`Conditions, comparisons and metadata columns for this experiment.${readOnly ? "" : " Changes here are saved automatically."}`} />
      <div className="divide-y divide-line">
        <section className="p-4 space-y-2.5" aria-label="Conditions">
          <h4 className="text-[13px] font-medium">Conditions</h4>
          {exp.conditions.length === 0 && <p className="text-xs text-muted">No conditions yet. Add treatment groups such as control and treated.</p>}
          <ul className="space-y-1">
            {exp.conditions.map((c) => (
              <li key={c.name} className="flex items-center gap-2">
                <ColorDot color={conditionColor(exp, c.name)!} disabled={readOnly} onPick={(col) => recolor(c.name, col)} />
                <EditableText value={c.name} disabled={readOnly} onSave={(v) => renameCondition(c.name, v)} />
                <span className="ml-auto text-xs text-muted tabular-nums">{counts.get(c.name) ?? 0} samples</span>
                {!readOnly && (
                  <button className="rounded p-1 text-muted hover:text-bad" onClick={() => removeCondition(c.name)} aria-label={`Remove condition ${c.name}`}>
                    <X className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {undefinedConds.length > 0 && !readOnly && (
            <p className="text-xs text-wait">
              Used in the table but not defined:{" "}
              {undefinedConds.map((c) => (
                <button key={c} className="underline underline-offset-2 mr-2" onClick={() => addCondition(c)}>add {c}</button>
              ))}
            </p>
          )}
          {!readOnly && (
            <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); addCondition(newCond); }}>
              <Input value={newCond} onChange={(e) => setNewCond(e.target.value)} placeholder="New condition" className="h-7.5" aria-label="New condition name" />
              <Button size="sm" type="submit" disabled={!newCond.trim()}><Plus />Add</Button>
            </form>
          )}
        </section>

        <section className="p-4 space-y-2.5" aria-label="Contrasts">
          <h4 className="text-[13px] font-medium">Comparisons</h4>
          {exp.contrasts.length === 0 && <p className="text-xs text-muted">Define which conditions to compare in differential analyses.</p>}
          <ul className="space-y-1">
            {exp.contrasts.map((c) => (
              <li key={c.name} className="flex items-center gap-2 text-[13px]">
                <span className="size-2 rounded-full" style={{ background: conditionColor(exp, c.treatment) }} />
                <span>{c.treatment}</span>
                <span className="text-muted">vs</span>
                <span className="size-2 rounded-full" style={{ background: conditionColor(exp, c.reference) }} />
                <span>{c.reference}</span>
                {!readOnly && (
                  <button className="ml-auto rounded p-1 text-muted hover:text-bad" aria-label={`Remove comparison ${c.name}`}
                    onClick={() => onMeta({ contrasts: exp.contrasts.filter((x) => x.name !== c.name) })}>
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!readOnly && exp.conditions.length >= 2 && (
            <div className="flex items-center gap-1.5">
              <Select value={ct.treatment} onChange={(e) => setCt({ ...ct, treatment: e.target.value })} className="h-7.5" aria-label="Treatment">
                <option value="">Treatment</option>
                {exp.conditions.map((c) => <option key={c.name}>{c.name}</option>)}
              </Select>
              <span className="text-xs text-muted">vs</span>
              <Select value={ct.reference} onChange={(e) => setCt({ ...ct, reference: e.target.value })} className="h-7.5" aria-label="Reference">
                <option value="">Reference</option>
                {exp.conditions.filter((c) => c.name !== ct.treatment).map((c) => <option key={c.name}>{c.name}</option>)}
              </Select>
              <Button size="sm" onClick={addContrast} disabled={!ct.treatment || !ct.reference}>Add</Button>
            </div>
          )}
        </section>

        <section className="p-4 space-y-2.5" aria-label="Metadata columns">
          <h4 className="text-[13px] font-medium">Metadata columns</h4>
          <div className="flex flex-wrap gap-1.5">
            {exp.custom_columns.length === 0 && <p className="text-xs text-muted">Add columns such as antibody, strandedness, tissue or donor.</p>}
            {exp.custom_columns.map((c) => (
              <span key={c} className="inline-flex items-center gap-1 rounded border border-line bg-raised px-1.5 py-0.5 text-xs">
                {c}
                {!readOnly && (
                  <button onClick={() => onMeta({ custom_columns: exp.custom_columns.filter((x) => x !== c) })} aria-label={`Remove column ${c}`}
                    className="text-muted hover:text-bad" title="Removes the column from the table; stored values are kept">
                    <X className="size-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
          {!readOnly && (
            <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); addColumn(); }}>
              <Input value={newCol} onChange={(e) => setNewCol(e.target.value)} placeholder="Column name" className="h-7.5" aria-label="New metadata column" />
              <Button size="sm" type="submit" disabled={!newCol.trim()}><Plus />Add</Button>
            </form>
          )}
        </section>
      </div>
    </Panel>
  );
}

function EditableText({ value, onSave, disabled }: { value: string; onSave: (v: string) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  if (!editing || disabled)
    return (
      <button className={cn("text-[13px] truncate text-left", !disabled && "hover:underline underline-offset-2 decoration-dotted")}
        onClick={() => { if (!disabled) { setV(value); setEditing(true); } }} disabled={disabled} title={disabled ? undefined : "Rename"}>
        {value}
      </button>
    );
  return (
    <Input autoFocus value={v} onChange={(e) => setV(e.target.value)} className="h-7 w-36"
      onBlur={() => { setEditing(false); onSave(v); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setV(value); setEditing(false); } }} />
  );
}

function ColorDot({ color, onPick, disabled }: { color: string; onPick: (c: string) => void; disabled?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger disabled={disabled} className="size-3.5 shrink-0 rounded-full ring-1 ring-line" style={{ background: color }} aria-label="Change colour" />
      <PopoverContent className="w-auto p-2">
        <div className="grid grid-cols-4 gap-1.5">
          {CONDITION_COLORS.map((c) => (
            <button key={c} onClick={() => onPick(c)} className={cn("size-5 rounded-full", c === color && "ring-2 ring-text ring-offset-2 ring-offset-surface")}
              style={{ background: c }} aria-label={`Colour ${c}`} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
