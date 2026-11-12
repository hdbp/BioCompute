import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Dna, Download, FilePlus2, FlaskConical, Play, Redo2, Save, Table2, Undo2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { ExperimentDetail, ExperimentDetail as ED } from "@/lib/types";
import { cn, download } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { confirmDialog } from "@/components/ui/confirm";
import { Ago, QueryError, usePageTitle } from "@/components/page";
import { useUnsavedGuard } from "@/hooks/unsaved";
import { SampleTable } from "@/components/experiment/sample-table";
import { DesignPanel } from "@/components/experiment/design-panel";
import { AddFilesFlow, EditFilesDialog, ImportDialog } from "@/components/experiment/file-dialogs";
import { ValidationPanel, type ValidationResult } from "@/components/experiment/validation";
import { useReferences } from "@/components/reference-picker";
import {
  ASSAYS, assayLabel, buildColumns, fromRows, localIssues, runsOf, serverIssueMap, toRows, type CellIssue, type Row,
} from "@/components/experiment/model";

type MetaPatch = Partial<Pick<ED, "name" | "description" | "assay" | "genome" | "conditions" | "contrasts" | "custom_columns">>;

export default function ExperimentEditorPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const readOnly = !can(user, "scientist");
  const q = useQuery({ queryKey: ["experiment", id], queryFn: () => api.get<ExperimentDetail>(`/api/experiments/${id}`) });
  const exp = q.data;

  const [rows, setRows] = useState<Row[]>([]);
  const [baseline, setBaseline] = useState("[]");
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [filesFor, setFilesFor] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [pipelineId, setPipelineId] = useState("");

  const serialized = useMemo(() => JSON.stringify(fromRows(rows)), [rows]);
  const dirty = serialized !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;

  // Undo history of the sample table: every edit, paste, fill-down, added or deleted row is one step.
  const history = useRef<{ undo: Row[][]; redo: Row[][] }>({ undo: [], redo: [] });
  const [steps, setSteps] = useState({ undo: 0, redo: 0 });
  const syncSteps = () => setSteps({ undo: history.current.undo.length, redo: history.current.redo.length });

  const undo = useCallback(() => {
    const prev = history.current.undo.pop();
    if (!prev) return;
    history.current.redo.push(rowsRef.current);
    rowsRef.current = prev;
    setRows(prev);
    syncSteps();
  }, []);
  const redo = useCallback(() => {
    const next = history.current.redo.pop();
    if (!next) return;
    history.current.undo.push(rowsRef.current);
    rowsRef.current = next;
    setRows(next);
    syncSteps();
  }, []);

  /** Every change to the sample rows goes through here so that it can be undone. */
  const changeRows = useCallback((next: Row[], opts: { quiet?: boolean } = {}) => {
    const prev = rowsRef.current;
    if (next === prev) return;
    history.current.undo.push(prev);
    if (history.current.undo.length > 200) history.current.undo.shift();
    history.current.redo = [];
    rowsRef.current = next;
    setRows(next);
    syncSteps();
    const kept = new Set(next.map((r) => r._k));
    const removed = prev.map((row, i) => ({ row, i })).filter(({ row }) => !kept.has(row._k));
    // rows with nothing in them (a blank row that was added and removed again) are not worth a message
    const lost = removed.filter(({ row }) => row.sample_id || Object.keys(row.files ?? {}).length);
    if (lost.length && !opts.quiet) {
      toast(lost.length === 1 ? `Sample ${lost[0].row.sample_id || "row"} deleted` : `${lost.length} samples deleted`, {
        description: "Not final until you save the table.",
        action: {
          label: "Undo",
          onClick: () => {
            // nothing else happened since: a plain undo; otherwise put the rows back where they were
            if (rowsRef.current === next && history.current.undo[history.current.undo.length - 1] === prev) { undo(); return; }
            const out = [...rowsRef.current];
            removed.forEach(({ row, i }) => { if (!out.some((r) => r._k === row._k)) out.splice(Math.min(i, out.length), 0, row); });
            changeRows(out);
          },
        },
      });
    }
  }, [undo]);

  /** Replace the table with what the server has (after loading, saving or importing); the undo history starts over. */
  const reset = useCallback((e: ExperimentDetail) => {
    const r = toRows(e.samples);
    history.current = { undo: [], redo: [] };
    syncSteps();
    rowsRef.current = r;
    setRows(r);
    setBaseline(JSON.stringify(fromRows(r)));
  }, []);

  // load server samples into the table whenever they change, unless the user has unsaved edits
  // (a change of name, assay, genome or design returns the same samples and must not clear the undo history)
  useEffect(() => {
    if (!exp || dirtyRef.current) return;
    if (JSON.stringify(fromRows(toRows(exp.samples))) !== baselineRef.current) reset(exp);
  }, [exp, reset]);

  useUnsavedGuard(dirty, "sample changes");
  usePageTitle(exp?.name, [{ label: "Experiments", to: "/experiments" }]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!exp) return false;
    const errs = [...localIssues(rows).values()].flatMap((m) => [...m.values()]).filter((i) => i.level === "error");
    if (rows.some((r) => !r.sample_id)) { toast.error("Every sample needs an ID before saving."); return false; }
    setSaving(true);
    try {
      const r = await api.put<ExperimentDetail>(`/api/experiments/${id}/samples`, { samples: fromRows(rows) });
      qc.setQueryData(["experiment", id], r);
      reset(r);
      qc.invalidateQueries({ queryKey: ["experiments"] });
      toast.success(errs.length ? `Saved with ${errs.length} problem${errs.length === 1 ? "" : "s"} still marked` : "Samples saved");
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    } finally {
      setSaving(false);
    }
  }, [exp, rows, id, qc, reset]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirtyRef.current && !readOnly) save(); return; }
      // undo/redo of the table; inside a text field the browser's own undo of the typed text applies
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (readOnly || typing || !mod || e.altKey || document.querySelector('[role="dialog"]')) return;
      if (e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [save, readOnly, undo, redo]);

  const updateMeta = async (patch: MetaPatch) => {
    if (!exp) return;
    const body = { name: exp.name, description: exp.description, assay: exp.assay, genome: exp.genome ?? null, custom_columns: exp.custom_columns,
      conditions: exp.conditions, contrasts: exp.contrasts, ...patch };
    qc.setQueryData<ExperimentDetail>(["experiment", id], { ...exp, ...patch }); // optimistic
    try {
      const r = await api.put<ExperimentDetail>(`/api/experiments/${id}`, body);
      qc.setQueryData(["experiment", id], r);
      qc.invalidateQueries({ queryKey: ["experiments"] });
    } catch (e) {
      qc.setQueryData(["experiment", id], exp);
      toast.error(errMsg(e));
    }
  };

  const columns = useMemo(() => (exp ? buildColumns(exp) : []), [exp]);
  const local = useMemo(() => localIssues(rows), [rows]);
  const merged = useMemo(() => {
    const m = new Map<string, Map<string, CellIssue>>();
    const add = (src: Map<string, Map<string, CellIssue>>) => src.forEach((cols, k) => {
      if (!m.has(k)) m.set(k, new Map());
      cols.forEach((v, c) => { const cur = m.get(k)!.get(c); if (!cur || (cur.level === "warning" && v.level === "error")) m.get(k)!.set(c, v); });
    });
    if (validation) add(serverIssueMap(rows, validation.issues));
    add(local);
    return m;
  }, [rows, local, validation]);
  const localErrors = [...local.values()].reduce((n, m) => n + [...m.values()].filter((i) => i.level === "error").length, 0);

  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-80" /><Skeleton className="h-96" /></div>;
  if (q.isError && (q.error as { status?: number } | null)?.status !== 404) return <QueryError error={q.error} onRetry={() => q.refetch()} what="this experiment" />;
  if (q.isError || !exp) return <Empty icon={<FlaskConical />} title="Experiment not found" action={<Button asChild><Link to="/experiments">Back to experiments</Link></Button>}>{q.error ? errMsg(q.error) : null}</Empty>;

  const proteomics = exp.assay === "proteomics";
  const paired = rows.filter((r) => runsOf(r).length && runsOf(r).every((x) => x.fastq_2)).length;
  const withFiles = rows.filter((r) => (proteomics ? r.files?.raw : runsOf(r).length)).length;
  const multiLane = rows.filter((r) => runsOf(r).length > 1).length;
  const controls = rows.filter((r) => r.is_control).length;

  return (
    <div className="space-y-5">
      <div>
        <Link to="/experiments" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ArrowLeft className="size-3.5" />Experiments
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[16rem] flex-1 space-y-1">
            <HeaderText value={exp.name} disabled={readOnly} className="text-[22px] font-semibold leading-tight"
              onSave={(v) => v.trim() && updateMeta({ name: v.trim() })} label="Experiment name" />
            <HeaderText value={exp.description} disabled={readOnly} multiline placeholder="Add a description of the biological question, protocol or sequencing run"
              className="text-[13.5px] text-muted max-w-3xl" onSave={(v) => updateMeta({ description: v })} label="Description" />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {readOnly ? <Badge tone="accent">{assayLabel(exp.assay)}</Badge> : (
                <Select value={exp.assay} aria-label="Assay" className="h-7 w-auto"
                  onChange={async (e) => {
                    const assay = e.target.value;
                    const switching = (assay === "proteomics") !== proteomics;
                    if (switching && rows.length && !(await confirmDialog({
                      title: `Change the assay to ${assayLabel(assay)}?`,
                      body: "Switching between sequencing and proteomics changes which file columns are shown. Existing file assignments are kept but hidden.",
                      confirmLabel: "Change assay",
                    }))) return;
                    updateMeta({ assay });
                  }}>
                  {ASSAYS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </Select>
              )}
              <GenomeSelect value={exp.genome ?? ""} disabled={readOnly} onChange={(g) => updateMeta({ genome: g || null })} />
              <span className="text-xs text-muted">Updated <Ago ts={exp.updated_at} />{exp.created_by ? ` by ${exp.created_by}` : ""}</span>
            </div>
            {!readOnly && (
              <p className="flex items-center gap-1 pt-0.5 text-xs text-muted">
                <Check className="size-3 text-ok" />Name, description, assay, genome and the design are saved automatically. Sample rows are saved with the Save button.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={async () => {
              try { download(`${exp.name.replace(/\W+/g, "_")}_metadata.tsv`, await api.get<string>(`/api/experiments/${id}/export`), "text/tab-separated-values"); }
              catch (e) { toast.error(errMsg(e)); }
            }}><Download />Export metadata</Button>
            {rows.length
              ? <Button variant="primary" asChild><Link to={`/jobs/new?experiment=${id}`}><Play />Run analysis</Link></Button>
              : <Button variant="primary" disabled><Play />Run analysis</Button>}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
        <span><span className="text-text font-medium tabular-nums">{rows.length}</span> samples</span>
        <span><span className="text-text font-medium tabular-nums">{withFiles}</span> with {proteomics ? "raw files" : "reads"}</span>
        {!proteomics && <span><span className="text-text font-medium tabular-nums">{paired}</span> paired-end</span>}
        {multiLane > 0 && <span><span className="text-text font-medium tabular-nums">{multiLane}</span> multi-lane</span>}
        <span><span className="text-text font-medium tabular-nums">{controls}</span> controls</span>
        <span><span className="text-text font-medium tabular-nums">{exp.conditions.length}</span> conditions</span>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {!readOnly && <>
              <Button onClick={() => setAddOpen(true)}><FilePlus2 />Add {proteomics ? "raw files" : "files"}</Button>
              <Button onClick={() => setImportOpen(true)}><Upload />Import table</Button>
            </>}
            <div className="ml-auto flex items-center gap-2">
              {!readOnly && <>
                <Button variant="ghost" disabled={!steps.undo} onClick={undo} title="Undo the last change to the sample table (Ctrl+Z)"><Undo2 />Undo</Button>
                <Button variant="ghost" size="icon" disabled={!steps.redo} onClick={redo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><Redo2 /></Button>
              </>}
              {!readOnly && (dirty
                ? <span role="status" className="inline-flex items-center gap-1.5 text-[13px] text-wait"><span className="size-1.5 rounded-full bg-wait" />Unsaved rows</span>
                : <span className="inline-flex items-center gap-1 text-xs text-muted"><Check className="size-3 text-ok" />All rows saved</span>)}
              {dirty && <Button variant="ghost" onClick={() => exp && changeRows(toRows(exp.samples), { quiet: true })} title="Go back to the last saved table (can be undone)"><X />Discard</Button>}
              {!readOnly && <Button variant="primary" disabled={!dirty} loading={saving} onClick={save} title="Save the sample rows (Ctrl+S)"><Save />Save rows</Button>}
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line bg-surface">
              <Empty icon={<Table2 />} title="No samples yet"
                action={!readOnly && <div className="flex gap-2">
                  <Button variant="primary" onClick={() => setAddOpen(true)}><FilePlus2 />Add {proteomics ? "raw files" : "sequencing files"}</Button>
                  <Button onClick={() => setImportOpen(true)}><Upload />Import a samplesheet</Button>
                </div>}>
                {proteomics
                  ? "Pick instrument raw files from a data folder, or import an existing design table. Fractions, labels and acquisition batches are edited in the table."
                  : "Pick FASTQ files or scan a run folder; read pairs and lanes are matched automatically and sample names are suggested from file names. You can also paste rows from a spreadsheet."}
              </Empty>
            </div>
          ) : (
            <SampleTable exp={exp} rows={rows} onChange={changeRows} columns={columns} issues={merged} readOnly={readOnly}
              onEditFiles={(k) => (proteomics ? undefined : setFilesFor(k))} />
          )}
        </div>
        <aside className="space-y-5 min-w-0">
          <ValidationPanel expId={id} pipelineId={pipelineId} setPipelineId={setPipelineId} dirty={dirty} saveFirst={save}
            result={validation} setResult={setValidation} sampleCount={rows.length} localErrors={localErrors} />
          <DesignPanel exp={exp} rows={rows} readOnly={readOnly} onMeta={updateMeta}
            onRenameCondition={(from, to) => {
              if (!rows.some((r) => r.condition === from)) return;
              changeRows(rows.map((r) => (r.condition === from ? { ...r, condition: to } : r)));
              toast.info(to ? `Samples in "${from}" moved to "${to}". Save the table to keep this.` : `Samples in "${from}" no longer have a condition. Save the table to keep this.`);
            }} />
        </aside>
      </div>

      <AddFilesFlow open={addOpen} onOpenChange={setAddOpen} rows={rows} proteomics={proteomics}
        onAdd={(nr) => changeRows([...rows.filter((r) => r.sample_id || Object.keys(r.files).length), ...nr])} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} dirty={dirty}
        onImport={async (content, mode) => {
          try {
            const r = await api.post<ExperimentDetail>(`/api/experiments/${id}/import-samplesheet`, { content, mode });
            qc.setQueryData(["experiment", id], r);
            reset(r);
            toast.success(`Imported. ${r.samples.length} samples in the experiment.`);
          } catch (e) {
            toast.error(errMsg(e));
            throw e;
          }
        }} />
      <EditFilesDialog row={rows.find((r) => r._k === filesFor) ?? null} onClose={() => setFilesFor(null)}
        onSave={(files) => changeRows(rows.map((r) => (r._k === filesFor ? { ...r, files } : r)))} />
    </div>
  );
}

function HeaderText({ value, onSave, disabled, className, multiline, placeholder, label }: {
  value: string; onSave: (v: string) => void; disabled?: boolean; className?: string; multiline?: boolean; placeholder?: string; label: string;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (!editing)
    return (
      <button type="button" disabled={disabled} onClick={() => setEditing(true)} aria-label={`Edit ${label.toLowerCase()}`}
        className={cn("block max-w-full text-left rounded px-1 -mx-1", !disabled && "hover:bg-raised/60", className, !value && "italic text-muted/70")}>
        {value || (disabled ? "" : placeholder)}
      </button>
    );
  const finish = () => { setEditing(false); if (v !== value) onSave(v); };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setV(value); setEditing(false); }
    if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(); }
  };
  return multiline
    ? <Textarea autoFocus aria-label={label} value={v} onChange={(e) => setV(e.target.value)} onBlur={finish} onKeyDown={keys} rows={2} className="max-w-3xl" />
    : <Input autoFocus aria-label={label} value={v} onChange={(e) => setV(e.target.value)} onBlur={finish} onKeyDown={keys} className="h-10 max-w-xl text-lg font-semibold" />;
}

/** The reference genome the samples were sequenced against: refgenie genomes on the controller, or any name. */
function GenomeSelect({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (g: string) => void }) {
  const { genomes } = useReferences();
  const names = genomes.map((g) => g.name);
  const [custom, setCustom] = useState(false);
  if (disabled) return value ? <Badge><Dna className="size-3" />{value}</Badge> : null;
  if (custom || (value && !names.includes(value) && !genomes.some((g) => g.aliases.includes(value))) || !names.length) {
    return (
      <Input className="h-7 w-40" aria-label="Reference genome" placeholder="Genome, e.g. hg38" defaultValue={value}
        onBlur={(e) => { if (e.target.value.trim() !== value) onChange(e.target.value.trim()); if (!e.target.value.trim()) setCustom(false); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
    );
  }
  return (
    <Select value={value} aria-label="Reference genome" className="h-7 w-auto" title="Reference genome: the launch form fills reference parameters from it"
      onChange={(e) => e.target.value === "__other" ? setCustom(true) : onChange(e.target.value)}>
      <option value="">No genome set</option>
      {genomes.map((g) => <option key={g.digest} value={g.name}>{g.name}</option>)}
      <option value="__other">Other…</option>
    </Select>
  );
}
