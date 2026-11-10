import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, FilePlus2, FlaskConical, Play, Save, Table2, Undo2, Upload } from "lucide-react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { ExperimentDetail, ExperimentDetail as ED } from "@/lib/types";
import { ago, cn, download } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { SampleTable } from "@/components/experiment/sample-table";
import { DesignPanel } from "@/components/experiment/design-panel";
import { AddFilesFlow, EditFilesDialog, ImportDialog } from "@/components/experiment/file-dialogs";
import { ValidationPanel, type ValidationResult } from "@/components/experiment/validation";
import {
  ASSAYS, assayLabel, buildColumns, fromRows, localIssues, runsOf, serverIssueMap, toRows, type CellIssue, type Row,
} from "@/components/experiment/model";

type MetaPatch = Partial<Pick<ED, "name" | "description" | "assay" | "conditions" | "contrasts" | "custom_columns">>;

export default function ExperimentEditorPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
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

  const reset = useCallback((e: ExperimentDetail) => {
    const r = toRows(e.samples);
    setRows(r);
    setBaseline(JSON.stringify(fromRows(r)));
  }, []);

  // load server samples into the table whenever they change, unless the user has unsaved edits
  useEffect(() => { if (exp && !dirtyRef.current) reset(exp); }, [exp, reset]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirtyRef.current && !readOnly) save(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [save, readOnly]);

  const updateMeta = async (patch: MetaPatch) => {
    if (!exp) return;
    const body = { name: exp.name, description: exp.description, assay: exp.assay, custom_columns: exp.custom_columns,
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
  if (q.isError || !exp) return <Empty icon={<FlaskConical />} title="Experiment not found" action={<Button asChild><Link to="/experiments">Back to experiments</Link></Button>}>{q.error ? errMsg(q.error) : null}</Empty>;

  const proteomics = exp.assay === "proteomics";
  const paired = rows.filter((r) => runsOf(r).length && runsOf(r).every((x) => x.fastq_2)).length;
  const withFiles = rows.filter((r) => (proteomics ? r.files?.raw : runsOf(r).length)).length;
  const multiLane = rows.filter((r) => runsOf(r).length > 1).length;
  const controls = rows.filter((r) => r.is_control).length;

  const leave = (to: string) => {
    if (dirty && !window.confirm("You have unsaved sample changes. Leave without saving?")) return;
    nav(to);
  };

  return (
    <div className="space-y-5">
      <div>
        <button onClick={() => leave("/experiments")} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
          <ArrowLeft className="size-3.5" />Experiments
        </button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[16rem] flex-1 space-y-1">
            <HeaderText value={exp.name} disabled={readOnly} className="text-[22px] font-semibold leading-tight"
              onSave={(v) => v.trim() && updateMeta({ name: v.trim() })} label="Experiment name" />
            <HeaderText value={exp.description} disabled={readOnly} multiline placeholder="Add a description of the biological question, protocol or sequencing run"
              className="text-[13.5px] text-muted max-w-3xl" onSave={(v) => updateMeta({ description: v })} label="Description" />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {readOnly ? <Badge tone="accent">{assayLabel(exp.assay)}</Badge> : (
                <Select value={exp.assay} aria-label="Assay" className="h-7 w-auto"
                  onChange={(e) => {
                    const switching = (e.target.value === "proteomics") !== proteomics;
                    if (switching && rows.length && !window.confirm("Switching between sequencing and proteomics changes which file columns are shown. Existing file assignments are kept but hidden. Continue?")) return;
                    updateMeta({ assay: e.target.value });
                  }}>
                  {ASSAYS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </Select>
              )}
              <span className="text-xs text-muted">Updated {ago(exp.updated_at)}{exp.created_by ? ` by ${exp.created_by}` : ""}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={async () => {
              try { download(`${exp.name.replace(/\W+/g, "_")}_metadata.tsv`, await api.get<string>(`/api/experiments/${id}/export`), "text/tab-separated-values"); }
              catch (e) { toast.error(errMsg(e)); }
            }}><Download />Export metadata</Button>
            <Button variant="primary" disabled={!rows.length} onClick={() => leave(`/jobs/new?experiment=${id}`)}><Play />Run analysis</Button>
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
              {dirty && <span className="inline-flex items-center gap-1.5 text-[13px] text-wait"><span className="size-1.5 rounded-full bg-wait" />Unsaved changes</span>}
              {dirty && <Button variant="ghost" onClick={() => exp && reset(exp)}><Undo2 />Discard</Button>}
              {!readOnly && <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}><Save />Save</Button>}
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
                  ? "Pick instrument raw files from a data root, or import an existing design table. Fractions, labels and acquisition batches are edited in the table."
                  : "Pick FASTQ files or scan a run folder; read pairs and lanes are matched automatically and sample names are suggested from file names. You can also paste rows from a spreadsheet."}
              </Empty>
            </div>
          ) : (
            <SampleTable exp={exp} rows={rows} onChange={setRows} columns={columns} issues={merged} readOnly={readOnly}
              onEditFiles={(k) => (proteomics ? undefined : setFilesFor(k))} />
          )}
        </div>
        <aside className="space-y-5 min-w-0">
          <ValidationPanel expId={id} pipelineId={pipelineId} setPipelineId={setPipelineId} dirty={dirty} saveFirst={save}
            result={validation} setResult={setValidation} sampleCount={rows.length} localErrors={localErrors} />
          <DesignPanel exp={exp} rows={rows} readOnly={readOnly} onMeta={updateMeta}
            onRenameCondition={(from, to) => {
              if (!rows.some((r) => r.condition === from)) return;
              setRows(rows.map((r) => (r.condition === from ? { ...r, condition: to } : r)));
              toast.info(to ? `Samples in "${from}" moved to "${to}". Save the table to keep this.` : `Samples in "${from}" no longer have a condition. Save the table to keep this.`);
            }} />
        </aside>
      </div>

      <AddFilesFlow open={addOpen} onOpenChange={setAddOpen} rows={rows} proteomics={proteomics}
        onAdd={(nr) => setRows([...rows.filter((r) => r.sample_id || Object.keys(r.files).length), ...nr])} />
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
        onSave={(files) => setRows(rows.map((r) => (r._k === filesFor ? { ...r, files } : r)))} />
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
