import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CopyPlus, FileInput, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import type { ExperimentDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Checkbox, Kbd, Tip } from "@/components/ui/misc";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { blankRow, conditionColor, newKey, runsOf, type CellIssue, type Column, type Row } from "./model";

interface Props {
  exp: ExperimentDetail;
  rows: Row[];
  onChange: (rows: Row[]) => void;
  columns: Column[];
  issues: Map<string, Map<string, CellIssue>>;
  readOnly?: boolean;
  onEditFiles: (key: string) => void;
}

type Pos = { r: number; c: number };

export function SampleTable({ exp, rows, onChange, columns, issues, readOnly, onEditFiles }: Props) {
  const [active, setActive] = useState<Pos | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const after = useRef<HTMLSpanElement>(null);
  // Tab moves between cells; after Esc the next Tab leaves the table instead (so that the keyboard is not trapped)
  const [released, setReleased] = useState(false);

  // keep selection consistent with rows
  useEffect(() => {
    setSelected((s) => {
      const keys = new Set(rows.map((r) => r._k));
      const n = new Set([...s].filter((k) => keys.has(k)));
      return n.size === s.size ? s : n;
    });
    setActive((a) => (a && a.r >= rows.length ? (rows.length ? { r: rows.length - 1, c: a.c } : null) : a));
  }, [rows]);

  const editable = useCallback((c: Column) => !readOnly && !c.readonly, [readOnly]);

  /** Apply a value to a cell; renaming a sample also updates matched-control references. */
  const applyCells = useCallback((updates: { k: string; col: Column; value: string }[], base: Row[] = rows, extra?: (rs: Row[]) => Row[]) => {
    let next = base.map((r) => r);
    for (const u of updates) {
      const idx = next.findIndex((r) => r._k === u.k);
      if (idx < 0 || !editable(u.col)) continue;
      const old = next[idx];
      const val = u.col.kind === "int" ? u.value.replace(/[^\d]/g, "") : u.value;
      next[idx] = u.col.set(old, val);
      if (u.col.id === "sample_id" && old.sample_id && old.sample_id !== next[idx].sample_id) {
        const renamed = next[idx].sample_id;
        next = next.map((r) => (r.control_id === old.sample_id ? { ...r, control_id: renamed || null } : r));
      }
    }
    if (extra) next = extra(next);
    onChange(next);
  }, [rows, onChange, editable]);

  const focusGrid = () => requestAnimationFrame(() => wrap.current?.focus({ preventScroll: true }));

  const startEdit = (pos: Pos, initial?: string) => {
    const col = columns[pos.c];
    const row = rows[pos.r];
    if (!col || !row) return;
    if (col.kind === "files") { if (!readOnly) onEditFiles(row._k); return; }
    if (!editable(col)) return;
    if (col.kind === "check") { applyCells([{ k: row._k, col, value: row.is_control ? "" : "true" }]); return; }
    setActive(pos);
    setEdit(initial ?? col.get(row));
  };

  const commit = (move?: Pos, explicit?: string) => {
    const v = explicit ?? edit;
    if (active && v !== null) {
      const col = columns[active.c];
      const row = rows[active.r];
      if (row && col.get(row) !== v) applyCells([{ k: row._k, col, value: v }]);
    }
    setEdit(null);
    if (move) setActive(clamp(move));
    focusGrid();
  };

  const clamp = (p: Pos): Pos => ({ r: Math.max(0, Math.min(rows.length - 1, p.r)), c: Math.max(0, Math.min(columns.length - 1, p.c)) });

  const selectedRowsOrdered = useMemo(() => rows.filter((r) => selected.has(r._k)), [rows, selected]);

  function fillDown() {
    if (!active) return;
    const col = columns[active.c];
    if (!editable(col)) return;
    if (selectedRowsOrdered.length > 1) {
      const v = col.get(selectedRowsOrdered[0]);
      applyCells(selectedRowsOrdered.slice(1).map((r) => ({ k: r._k, col, value: v })));
    } else if (active.r > 0) {
      applyCells([{ k: rows[active.r]._k, col, value: col.get(rows[active.r - 1]) }]);
    }
  }

  function clearCells() {
    if (!active) return;
    const col = columns[active.c];
    const targets = selected.size > 1 ? selectedRowsOrdered : [rows[active.r]];
    applyCells(targets.map((r) => ({ k: r._k, col, value: "" })));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (edit !== null) return; // the editor handles its own keys
    if (!rows.length) return;
    const target = e.target as HTMLElement;
    // keys pressed in a row menu (rendered outside the table) or on a button inside it belong to that control, not to the grid
    if (!e.currentTarget.contains(target)) return;
    const onControl = target !== e.currentTarget && !!target.closest("button, a, input, select, textarea");
    const a = active ?? { r: 0, c: 0 };
    const mod = e.ctrlKey || e.metaKey;
    const go = (p: Pos) => { e.preventDefault(); setActive(clamp(p)); };
    if (e.key === "Tab" && released) {
      // let the browser move on from the edge of the table: before it (Shift+Tab) or after it (Tab)
      (e.shiftKey ? wrap.current : after.current)?.focus({ preventScroll: true });
      return;
    }
    if (released && e.key !== "Escape" && e.key !== "Shift") setReleased(false);
    switch (e.key) {
      case "ArrowDown": return go({ r: a.r + 1, c: a.c });
      case "ArrowUp": return go({ r: a.r - 1, c: a.c });
      case "ArrowRight": return go({ r: a.r, c: a.c + 1 });
      case "ArrowLeft": return go({ r: a.r, c: a.c - 1 });
      case "Tab": return go(e.shiftKey ? { r: a.r, c: a.c - 1 } : { r: a.r, c: a.c + 1 });
      case "Home": return go({ r: a.r, c: 0 });
      case "End": return go({ r: a.r, c: columns.length - 1 });
      case "Enter": case "F2": if (onControl) return; e.preventDefault(); return startEdit(a);
      case " ": if (onControl) return; if (columns[a.c]?.kind === "check") { e.preventDefault(); return startEdit(a); } break;
      case "Delete": case "Backspace": e.preventDefault(); return clearCells();
      case "Escape": setSelected(new Set()); setReleased(true); return;
    }
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); fillDown(); return; }
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(new Set(rows.map((r) => r._k))); return; }
    if (!mod && !e.altKey && e.key.length === 1 && active && !onControl) {
      const col = columns[a.c];
      if (["text", "int", "path"].includes(col.kind) && editable(col)) { e.preventDefault(); startEdit(a, e.key); }
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    if (edit !== null || readOnly) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, "").split("\n");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    const grid = lines.map((l) => l.split("\t"));
    const a = active ?? { r: 0, c: 0 };
    // single value + multi-row selection -> apply to all selected rows
    if (grid.length === 1 && grid[0].length === 1 && selected.size > 1) {
      const col = columns[a.c];
      applyCells(selectedRowsOrdered.map((r) => ({ k: r._k, col, value: grid[0][0].trim() })));
      return;
    }
    let base = rows;
    const needed = a.r + grid.length - rows.length;
    if (needed > 0) base = [...rows, ...Array.from({ length: needed }, () => blankRow())];
    const updates: { k: string; col: Column; value: string }[] = [];
    grid.forEach((cells, i) => cells.forEach((v, j) => {
      const col = columns[a.c + j];
      const row = base[a.r + i];
      if (col && row) updates.push({ k: row._k, col, value: v.trim() });
    }));
    applyCells(updates, base);
  }

  function onCopy(e: React.ClipboardEvent) {
    if (edit !== null) return;
    if (selected.size > 0) {
      e.preventDefault();
      e.clipboardData.setData("text/plain", selectedRowsOrdered.map((r) => columns.map((c) => c.get(r)).join("\t")).join("\n"));
    } else if (active) {
      e.preventDefault();
      e.clipboardData.setData("text/plain", columns[active.c].get(rows[active.r]));
    }
  }

  function toggleRow(i: number, shift: boolean) {
    const k = rows[i]._k;
    setSelected((s) => {
      const n = new Set(s);
      if (shift && anchor !== null) {
        const [lo, hi] = [Math.min(anchor, i), Math.max(anchor, i)];
        const on = !s.has(k);
        rows.slice(lo, hi + 1).forEach((r) => (on ? n.add(r._k) : n.delete(r._k)));
      } else if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
    setAnchor(i);
  }

  const duplicate = (keys: string[]) => {
    const out: Row[] = [];
    const taken = new Set(rows.map((r) => r.sample_id));
    for (const r of rows) {
      out.push(r);
      if (keys.includes(r._k)) {
        let name = `${r.sample_id}_copy`;
        let n = 2;
        while (taken.has(name)) name = `${r.sample_id}_copy${n++}`;
        taken.add(name);
        out.push({ ...r, id: undefined, _k: newKey(), sample_id: name, files: {}, attributes: { ...r.attributes } });
      }
    }
    onChange(out);
  };
  const remove = (keys: string[]) => { onChange(rows.filter((r) => !keys.includes(r._k))); setSelected(new Set()); };
  const insertBelow = (k: string) => {
    const i = rows.findIndex((r) => r._k === k);
    onChange([...rows.slice(0, i + 1), blankRow(), ...rows.slice(i + 1)]);
  };

  const allSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <div className="space-y-2">
      {selected.size > 0 && !readOnly && (
        <BulkBar count={selected.size} columns={columns.filter(editable)} exp={exp}
          onApply={(col, value) => applyCells(selectedRowsOrdered.map((r) => ({ k: r._k, col, value })))}
          onDuplicate={() => duplicate([...selected])} onDelete={() => remove([...selected])} onClear={() => setSelected(new Set())} />
      )}
      <div ref={wrap} tabIndex={0} onKeyDown={onKeyDown} onPaste={onPaste} onCopy={onCopy}
        onMouseDown={() => released && setReleased(false)} onBlur={(e) => { if (released && !e.currentTarget.contains(e.relatedTarget)) setReleased(false); }}
        aria-describedby="sample-table-keys"
        className="relative overflow-auto rounded-lg border border-line bg-surface max-h-[62vh] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
        role="grid" aria-label="Samples" aria-rowcount={rows.length + 1}>
        <table className="border-separate border-spacing-0 text-[13px]" style={{ minWidth: "100%" }}>
          <thead className="sticky top-0 z-20">
            <tr>
              <th style={{ minWidth: 56, width: 56, maxWidth: 56 }} className="sticky left-0 z-30 bg-raised border-b border-line px-2 py-2 text-left">
                <div className="flex items-center gap-2">
                  <Checkbox checked={allSelected ? true : selected.size ? "indeterminate" : false} aria-label="Select all samples"
                    onCheckedChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r._k)))} />
                </div>
              </th>
              {columns.map((c) => (
                <th key={c.id} style={{ minWidth: c.width, width: c.width }}
                  className={cn("bg-raised border-b border-l border-line px-2 py-2 text-left font-medium text-muted whitespace-nowrap", c.id === "sample_id" && "sticky left-14 z-30")}>
                  {c.help ? <Tip content={c.help}><span className="cursor-help">{c.label}</span></Tip> : c.label}
                </th>
              ))}
              <th className="bg-raised border-b border-l border-line w-10" aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => {
              const rowIssues = issues.get(row._k);
              const sel = selected.has(row._k);
              return (
                <tr key={row._k} aria-selected={sel} className="group">
                  <td style={{ minWidth: 56, width: 56, maxWidth: 56 }} className={cn("sticky left-0 z-10 border-b border-line bg-surface px-2 py-1", sel && "shadow-[inset_0_0_0_999px_rgb(var(--accent)/0.08)]")}>
                    <div className="flex items-center gap-2">
                      <Checkbox checked={sel} aria-label={`Select ${row.sample_id || `row ${ri + 1}`}`}
                        onClick={(e) => { e.preventDefault(); toggleRow(ri, e.shiftKey); }} />
                      <span className="text-[11px] text-muted tabular-nums">{ri + 1}</span>
                    </div>
                  </td>
                  {columns.map((col, ci) => {
                    const isActive = active?.r === ri && active?.c === ci;
                    const iss = rowIssues?.get(col.id);
                    return (
                      <td key={col.id} role="gridcell" aria-invalid={iss?.level === "error" || undefined}
                        onMouseDown={() => { if (!(isActive && edit !== null)) { if (edit !== null) commit(); setActive({ r: ri, c: ci }); } }}
                        onDoubleClick={() => startEdit({ r: ri, c: ci })}
                        className={cn("relative border-b border-l border-line/70 bg-surface px-0 py-0 h-8 align-middle",
                          col.id === "sample_id" && "sticky left-14 z-10",
                          sel && "shadow-[inset_0_0_0_999px_rgb(var(--accent)/0.08)]",
                          iss?.level === "error" && "shadow-[inset_0_0_0_999px_rgb(var(--bad)/0.10)]",
                          iss?.level === "warning" && !sel && "shadow-[inset_0_0_0_999px_rgb(var(--wait)/0.09)]",
                          isActive && "outline-2 outline-accent -outline-offset-2 z-[5]")}>
                        {isActive && edit !== null ? (
                          <CellEditor col={col} row={row} rows={rows} value={edit} onChange={setEdit}
                            onPick={(v) => commit(undefined, v)}
                            onCommit={(dir) => commit(dir === "down" ? { r: ri + 1, c: ci } : dir === "right" ? { r: ri, c: ci + 1 } : dir === "left" ? { r: ri, c: ci - 1 } : undefined)}
                            onCancel={() => { setEdit(null); focusGrid(); }} />
                        ) : (
                          <CellView col={col} row={row} exp={exp} issue={iss} readOnly={readOnly}
                            onToggle={() => startEdit({ r: ri, c: ci })} onEditFiles={() => onEditFiles(row._k)} />
                        )}
                      </td>
                    );
                  })}
                  <td className="border-b border-l border-line/70 bg-surface px-1">
                    {!readOnly && (
                      <DropdownMenu>
                        <DropdownMenuTrigger className="rounded p-1 text-muted opacity-60 hover:bg-raised hover:text-text group-hover:opacity-100" aria-label={`Actions for ${row.sample_id || "row"}`}>
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {exp.assay !== "proteomics" && <DropdownMenuItem onSelect={() => onEditFiles(row._k)}><FileInput />Edit files</DropdownMenuItem>}
                          <DropdownMenuItem onSelect={() => setTimeout(() => startEdit({ r: ri, c: 0 }), 0)}>Rename sample</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => insertBelow(row._k)}><Plus />Insert row below</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => duplicate([row._k])}><CopyPlus />Duplicate</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem danger onSelect={() => remove([row._k])}><Trash2 />Delete</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span ref={after} tabIndex={-1} className="sr-only" />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        {!readOnly ? (
          <Button size="sm" variant="ghost" onClick={() => { onChange([...rows, blankRow()]); setActive({ r: rows.length, c: 0 }); focusGrid(); }}>
            <Plus />Add blank row
          </Button>
        ) : <span />}
        <p id="sample-table-keys" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span><Kbd>Enter</Kbd> edit</span>
          <span><Kbd>Ctrl</Kbd>+<Kbd>D</Kbd> fill down</span>
          <span><Kbd>Ctrl</Kbd>+<Kbd>V</Kbd> paste from a spreadsheet</span>
          {!readOnly && <span><Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> undo</span>}
          <span><Kbd>Shift</Kbd>+click to select a range</span>
          <span className={cn(released && "text-accent")} aria-live="polite">
            {released ? <>Press <Kbd>Tab</Kbd> to leave the table</> : <><Kbd>Tab</Kbd> next cell, <Kbd>Esc</Kbd> then <Kbd>Tab</Kbd> to leave the table</>}
          </span>
        </p>
      </div>
    </div>
  );
}

function CellView({ col, row, exp, issue, readOnly, onToggle, onEditFiles }: {
  col: Column; row: Row; exp: ExperimentDetail; issue?: CellIssue; readOnly?: boolean; onToggle: () => void; onEditFiles: () => void;
}) {
  const v = col.get(row);
  let content: React.ReactNode = v ? <span className="truncate">{v}</span> : <span className="text-muted/50">—</span>;
  if (col.kind === "check") {
    content = (
      <button type="button" disabled={readOnly} onClick={(e) => { e.stopPropagation(); onToggle(); }} aria-pressed={row.is_control}
        className={cn("grid size-4 place-items-center rounded-[4px] border", row.is_control ? "bg-accent border-accent text-accent-ink" : "border-line")}
        aria-label={row.is_control ? "Control sample" : "Not a control"}>
        {row.is_control && <Check className="size-3" strokeWidth={3} />}
      </button>
    );
  } else if (col.id === "condition" && v) {
    const color = conditionColor(exp, v);
    content = (
      <span className="inline-flex items-center gap-1.5 truncate">
        <span className="size-2 shrink-0 rounded-full" style={{ background: color ?? "rgb(var(--muted))" }} />
        <span className={cn(!color && "text-wait")} title={!color ? "Not one of the experiment's conditions" : undefined}>{v}</span>
      </span>
    );
  } else if (col.kind === "files") {
    const runs = runsOf(row);
    const all = runs.flatMap((r) => [r.fastq_1, r.fastq_2]).filter(Boolean) as string[];
    content = runs.length ? (
      <Tip content={<span className="font-mono text-[11px] whitespace-pre-line">{all.join("\n")}</span>}>
        <button type="button" onClick={(e) => { e.stopPropagation(); onEditFiles(); }} className="flex min-w-0 items-center gap-1.5 text-left">
          <span className={cn("rounded px-1 text-[10.5px] font-medium", runs.every((r) => r.fastq_2) ? "bg-run/12 text-run" : "bg-raised text-muted")}>
            {runs.every((r) => r.fastq_2) ? "PE" : "SE"}
          </span>
          <span className="truncate font-mono text-[11.5px]">{v}</span>
        </button>
      </Tip>
    ) : (
      <button type="button" disabled={readOnly} onClick={(e) => { e.stopPropagation(); onEditFiles(); }} className="text-muted/70 hover:text-accent">
        {readOnly ? "—" : "Assign files"}
      </button>
    );
  } else if (col.kind === "path" && v) {
    content = <span className="truncate font-mono text-[11.5px]" title={v}>{v.split(/[/:]/).pop()}</span>;
  } else if (col.kind === "int" && v) {
    content = <span className="tabular-nums">{v}</span>;
  }
  return (
    <div className="flex h-8 items-center px-2 min-w-0 gap-1.5">
      <div className="flex min-w-0 flex-1 items-center">{content}</div>
      {issue && (
        <Tip content={issue.message}>
          <span className={cn("size-1.5 shrink-0 rounded-full", issue.level === "error" ? "bg-bad" : "bg-wait")} aria-label={issue.message} />
        </Tip>
      )}
    </div>
  );
}

function CellEditor({ col, row, rows, value, onChange, onPick, onCommit, onCancel }: {
  col: Column; row: Row; rows: Row[]; value: string; onChange: (v: string) => void; onPick: (v: string) => void;
  onCommit: (dir?: "down" | "right" | "left") => void; onCancel: () => void;
}) {
  const done = useRef(false);
  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (["Enter", "Tab", "Escape"].includes(e.key)) done.current = true;
    if (e.key === "Enter") { e.preventDefault(); onCommit("down"); }
    else if (e.key === "Tab") { e.preventDefault(); onCommit(e.shiftKey ? "left" : "right"); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };
  if (col.kind === "select" || col.kind === "control") {
    const opts = col.options?.(rows, row) ?? [];
    const has = opts.some((o) => o.value === value);
    return (
      <Select autoFocus value={value} onKeyDown={keys} onBlur={() => !done.current && onCommit()}
        onChange={(e) => { done.current = true; onChange(e.target.value); onPick(e.target.value); }} className="h-8 rounded-none border-0 bg-raised">
        {!has && value && <option value={value}>{value} (not defined)</option>}
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    );
  }
  return (
    <Input autoFocus value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={keys} onBlur={() => !done.current && onCommit()}
      inputMode={col.kind === "int" ? "numeric" : undefined}
      className={cn("h-8 rounded-none border-0 bg-raised focus-visible:ring-0", col.kind === "path" && "font-mono text-[12px]")}
      onFocus={(e) => { const l = e.target.value.length; e.target.setSelectionRange(l, l); }} />
  );
}

function BulkBar({ count, columns, exp, onApply, onDuplicate, onDelete, onClear }: {
  count: number; columns: Column[]; exp: ExperimentDetail; onApply: (col: Column, value: string) => void;
  onDuplicate: () => void; onDelete: () => void; onClear: () => void;
}) {
  const bulkCols = columns.filter((c) => c.id !== "sample_id" && c.kind !== "files");
  const [colId, setColId] = useState(bulkCols.find((c) => c.id === "condition")?.id ?? bulkCols[0]?.id);
  const [value, setValue] = useState("");
  const col = bulkCols.find((c) => c.id === colId);
  useEffect(() => setValue(""), [colId]);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/[0.06] px-3 py-2">
      <span className="text-[13px] font-medium">{count} selected</span>
      <span className="h-4 w-px bg-line" />
      <span className="text-[13px] text-muted">Set</span>
      <Select value={colId} onChange={(e) => setColId(e.target.value)} className="h-7 w-40" aria-label="Column to set">
        {bulkCols.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </Select>
      <span className="text-[13px] text-muted">to</span>
      {col?.kind === "select" ? (
        <Select value={value} onChange={(e) => setValue(e.target.value)} className="h-7 w-40" aria-label="Value">
          {col.options?.([], {} as Row).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      ) : col?.kind === "check" ? (
        <Select value={value} onChange={(e) => setValue(e.target.value)} className="h-7 w-28" aria-label="Value">
          <option value="">No</option><option value="true">Yes</option>
        </Select>
      ) : (
        <Input value={value} onChange={(e) => setValue(e.target.value)} className="h-7 w-40" aria-label="Value"
          placeholder={col?.kind === "int" ? "number" : "value (empty clears)"} onKeyDown={(e) => e.key === "Enter" && col && onApply(col, value)} />
      )}
      <Button size="sm" variant="primary" onClick={() => col && onApply(col, value)} disabled={!col}>Apply</Button>
      <span className="h-4 w-px bg-line" />
      <Button size="sm" variant="ghost" onClick={onDuplicate}><CopyPlus />Duplicate</Button>
      <Button size="sm" variant="ghost" className="text-bad hover:text-bad" onClick={onDelete}><Trash2 />Delete</Button>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear} aria-label="Clear selection"><X /></Button>
      {exp.conditions.length === 0 && colId === "condition" && <span className="text-xs text-wait w-full">Define conditions in the design panel first.</span>}
    </div>
  );
}
