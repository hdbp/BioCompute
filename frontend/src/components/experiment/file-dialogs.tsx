import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, FileUp, FolderSearch, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Badge, Checkbox, Switch } from "@/components/ui/misc";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { FileBrowser, PathInput } from "@/components/file-browser";
import { baseName, blankRow, runsOf, type Row, type Run } from "./model";

interface Detected {
  samples: { sample_id: string; runs: Run[]; paired: boolean }[];
  unmatched: string[];
  warnings: string[];
}

/** Pick FASTQ files or a folder, detect read pairs/lanes, review suggested sample names, append rows. */
export function AddFilesFlow({ open, onOpenChange, rows, onAdd, proteomics }: {
  open: boolean; onOpenChange: (o: boolean) => void; rows: Row[]; onAdd: (newRows: Row[]) => void; proteomics: boolean;
}) {
  const [picker, setPicker] = useState<null | "files" | "dir">(null);
  const [recursive, setRecursive] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [result, setResult] = useState<Detected | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [include, setInclude] = useState<boolean[]>([]);
  const existing = useMemo(() => new Set(rows.map((r) => r.sample_id)), [rows]);
  const usedFiles = useMemo(() => new Set(rows.flatMap((r) => [...runsOf(r).flatMap((x) => [x.fastq_1, x.fastq_2]), r.files?.raw as string]).filter(Boolean)), [rows]);

  useEffect(() => { if (!open) { setResult(null); setPicker(null); } }, [open]);

  async function detect(body: { paths?: string[]; directory?: string; recursive?: boolean }) {
    setDetecting(true);
    try {
      let d: Detected;
      if (proteomics) {
        d = { samples: (body.paths ?? []).map((p) => ({ sample_id: baseName(p).replace(/\.(raw|wiff2?|d|mzml|mzxml|mgf)$/i, "").replace(/[^\w.-]+/g, "_"), runs: [{ fastq_1: p }], paired: false })), unmatched: [], warnings: [] };
      } else {
        d = await api.post<Detected>("/api/experiments/detect-pairs", body);
      }
      setResult(d);
      setNames(d.samples.map((s) => s.sample_id));
      setInclude(d.samples.map((s) => !existing.has(s.sample_id) && !s.runs.some((r) => usedFiles.has(r.fastq_1 ?? ""))));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setDetecting(false);
    }
  }

  function add() {
    if (!result) return;
    const out: Row[] = [];
    result.samples.forEach((s, i) => {
      if (!include[i]) return;
      const r = blankRow(names[i].trim());
      if (proteomics) r.files = { raw: s.runs[0].fastq_1 };
      else if (s.runs.length > 1) r.files = { runs: s.runs.map((x) => ({ lane: x.lane ?? null, fastq_1: x.fastq_1, fastq_2: x.fastq_2 ?? null })) };
      else r.files = { fastq_1: s.runs[0].fastq_1, ...(s.runs[0].fastq_2 ? { fastq_2: s.runs[0].fastq_2 } : {}) };
      out.push(r);
    });
    onAdd(out);
    toast.success(`Added ${out.length} sample${out.length === 1 ? "" : "s"}. Save the table to keep them.`);
    onOpenChange(false);
  }

  const chosen = include.filter(Boolean).length;
  const dupNames = names.filter((n, i) => include[i] && (existing.has(n) || names.filter((m, j) => include[j] && m === n).length > 1));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent wide title={proteomics ? "Add raw files" : "Add sequencing files"}
          description={proteomics ? "Each instrument raw file becomes one sample." : "Read pairs and lanes are detected from file names (R1/R2, _1/_2, L001...)."}>
          {!result ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <button onClick={() => setPicker("files")} className="rounded-lg border border-line p-4 text-left hover:border-accent/60 hover:bg-raised/50">
                <FileUp className="size-5 text-accent mb-2" />
                <p className="font-medium text-[13.5px]">Select files</p>
                <p className="text-xs text-muted mt-0.5">Choose individual {proteomics ? "raw" : "FASTQ"} files.</p>
              </button>
              {!proteomics && (
                <div className="rounded-lg border border-line p-4">
                  <button onClick={() => setPicker("dir")} className="w-full text-left">
                    <FolderSearch className="size-5 text-accent mb-2" />
                    <p className="font-medium text-[13.5px] hover:text-accent">Scan a folder</p>
                    <p className="text-xs text-muted mt-0.5">Find every FASTQ file in a sequencing run folder.</p>
                  </button>
                  <label className="mt-3 flex items-center gap-2 text-xs text-muted">
                    <Switch checked={recursive} onCheckedChange={setRecursive} aria-label="Include subfolders" />Include subfolders
                  </label>
                </div>
              )}
              {detecting && <p className="text-[13px] text-muted sm:col-span-2">Detecting samples…</p>}
            </div>
          ) : (
            <div className="space-y-3">
              {result.samples.length === 0 && <p className="text-[13px] text-muted">No {proteomics ? "raw" : "FASTQ"} files found.</p>}
              {result.samples.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-line">
                  <table className="w-full text-[13px]">
                    <thead className="bg-raised text-muted">
                      <tr>
                        <th className="w-8 px-2 py-1.5">
                          <Checkbox checked={chosen === result.samples.length ? true : chosen ? "indeterminate" : false} aria-label="Include all"
                            onCheckedChange={(v) => setInclude(result.samples.map(() => !!v))} />
                        </th>
                        <th className="px-2 py-1.5 text-left font-medium">Sample ID</th>
                        <th className="px-2 py-1.5 text-left font-medium">Layout</th>
                        <th className="px-2 py-1.5 text-left font-medium">Files</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.samples.map((s, i) => {
                        const clash = existing.has(names[i]);
                        const already = s.runs.some((r) => usedFiles.has(r.fastq_1 ?? ""));
                        return (
                          <tr key={i} className={cn("border-t border-line", !include[i] && "opacity-55")}>
                            <td className="px-2 py-1.5"><Checkbox checked={include[i]} onCheckedChange={(v) => setInclude(include.map((x, j) => (j === i ? !!v : x)))} aria-label={`Include ${names[i]}`} /></td>
                            <td className="px-2 py-1.5">
                              <Input value={names[i]} onChange={(e) => setNames(names.map((x, j) => (j === i ? e.target.value : x)))} className="h-7 w-48" aria-invalid={include[i] && (clash || !/^[\w.-]+$/.test(names[i]))} />
                              {clash && <p className="text-[11px] text-wait mt-0.5">Name already in the table</p>}
                              {already && <p className="text-[11px] text-wait mt-0.5">Files already assigned</p>}
                            </td>
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {proteomics ? <Badge>raw</Badge> : <>
                                <Badge tone={s.paired ? "run" : "neutral"}>{s.paired ? "Paired-end" : "Single-end"}</Badge>
                                {s.runs.length > 1 && <Badge className="ml-1">{s.runs.length} lanes</Badge>}
                              </>}
                            </td>
                            <td className="px-2 py-1.5 font-mono text-[11px] text-muted">
                              {s.runs.map((r, j) => <div key={j} className="truncate max-w-[300px]" title={[r.fastq_1, r.fastq_2].filter(Boolean).join("\n")}>
                                {[r.fastq_1, r.fastq_2].filter(Boolean).map(baseName).join("  +  ")}</div>)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {(result.warnings.length > 0 || result.unmatched.length > 0) && (
                <div className="rounded-lg border border-wait/30 bg-wait/[0.06] p-3 text-[13px] space-y-1">
                  {result.warnings.map((w, i) => <p key={i} className="flex gap-2"><AlertTriangle className="size-4 shrink-0 text-wait" />{w}</p>)}
                  {result.unmatched.length > 0 && <p className="text-muted">{result.unmatched.length} file(s) are not FASTQ and were ignored.</p>}
                </div>
              )}
              {dupNames.length > 0 && <p className="text-xs text-bad">Sample IDs must be unique: {Array.from(new Set(dupNames)).join(", ")}</p>}
            </div>
          )}
          <DialogFooter>
            {result && <Button variant="ghost" onClick={() => setResult(null)}>Choose other files</Button>}
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            {result && <Button variant="primary" onClick={add} disabled={!chosen}><Plus />Add {chosen} sample{chosen === 1 ? "" : "s"}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <FileBrowser open={picker !== null} onOpenChange={(o) => !o && setPicker(null)} mode={picker === "dir" ? "dir" : "files"}
        kinds={picker === "files" ? (proteomics ? ["ms-raw"] : ["fastq"]) : undefined}
        title={picker === "dir" ? "Choose a run folder" : undefined}
        onPick={(paths) => detect(picker === "dir" ? { directory: paths[0], recursive } : { paths })} />
    </>
  );
}

/** Edit the FASTQ files (single run or lanes) of one sample. */
export function EditFilesDialog({ row, onClose, onSave }: { row: Row | null; onClose: () => void; onSave: (files: Row["files"]) => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => { if (row) setRuns(runsOf(row).length ? runsOf(row).map((r) => ({ ...r })) : [{ fastq_1: "", fastq_2: "" }]); }, [row]);
  const save = () => {
    const clean = runs.filter((r) => r.fastq_1).map((r) => ({ lane: r.lane ?? null, fastq_1: r.fastq_1, fastq_2: r.fastq_2 || null }));
    const others = Object.fromEntries(Object.entries(row?.files ?? {}).filter(([k]) => !["runs", "fastq_1", "fastq_2"].includes(k)));
    if (clean.length > 1) onSave({ ...others, runs: clean });
    else if (clean.length === 1) onSave({ ...others, fastq_1: clean[0].fastq_1, ...(clean[0].fastq_2 ? { fastq_2: clean[0].fastq_2 } : {}) });
    else onSave(others);
    onClose();
  };
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide title={`Files for ${row?.sample_id || "sample"}`} description="Leave read 2 empty for single-end data. Add a lane for each sequencing lane or technical run.">
        <div className="space-y-4">
          {runs.map((r, i) => (
            <div key={i} className="rounded-lg border border-line p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-medium">{runs.length > 1 ? `Lane ${r.lane ?? i + 1}` : "Reads"}</p>
                {runs.length > 1 && <Button size="sm" variant="ghost" onClick={() => setRuns(runs.filter((_, j) => j !== i))}><Trash2 />Remove</Button>}
              </div>
              <Field label="Read 1"><PathInput mode="file" kinds={["fastq"]} value={r.fastq_1 ?? ""} onChange={(v) => setRuns(runs.map((x, j) => (j === i ? { ...x, fastq_1: v } : x)))} /></Field>
              <Field label="Read 2"><PathInput mode="file" kinds={["fastq"]} value={r.fastq_2 ?? ""} onChange={(v) => setRuns(runs.map((x, j) => (j === i ? { ...x, fastq_2: v } : x)))} /></Field>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setRuns([...runs, { fastq_1: "", fastq_2: "" }])}><Plus />Add lane</Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Paste or upload a CSV/TSV samplesheet or metadata table. */
export function ImportDialog({ open, onOpenChange, dirty, onImport }: {
  open: boolean; onOpenChange: (o: boolean) => void; dirty: boolean;
  onImport: (content: string, mode: "append" | "merge" | "replace") => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<"append" | "merge" | "replace">("merge");
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => {
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    const delim = (lines[0].match(/\t/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? "\t" : ",";
    return { cols: lines[0].split(delim).map((c) => c.trim()), rows: lines.length - 1, delim: delim === "\t" ? "tab" : "comma" };
  }, [content]);
  const readFile = (f: File) => f.text().then(setContent).catch((e) => toast.error(errMsg(e)));
  async function go() {
    setBusy(true);
    try { await onImport(content, mode); setContent(""); onOpenChange(false); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide title="Import samplesheet or metadata"
        description="A sample column (sample, sample_id or id) is required. condition, replicate, batch and control map to sample fields; fastq_1/fastq_2/raw to files; other columns become metadata.">
        <div className="space-y-3">
          {dirty && <p className="flex gap-2 rounded-md border border-wait/30 bg-wait/[0.07] p-2.5 text-[13px]"><AlertTriangle className="size-4 shrink-0 text-wait" />Unsaved table edits will be discarded by the import. Save the table first to keep them.</p>}
          <div className="flex items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-raised px-3 h-8 text-[13px] hover:border-muted/60">
              <FileUp className="size-4" />Upload CSV/TSV
              <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" className="sr-only" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
            </label>
            <span className="text-xs text-muted">or paste below</span>
          </div>
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={9} className="font-mono text-[12px]"
            placeholder={"sample\tcondition\treplicate\tantibody\nCTRL_rep1\tcontrol\t1\tH3K27ac"} aria-label="Samplesheet content" />
          {preview && <p className="text-xs text-muted">{preview.rows} rows, {preview.cols.length} columns ({preview.delim}-separated): {preview.cols.join(", ")}</p>}
          <Field label="How to combine with existing samples">
            <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="merge">Merge: update samples with matching IDs, add new ones</option>
              <option value="append">Append: add every row as a new sample</option>
              <option value="replace">Replace: remove all current samples first</option>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!preview?.rows} onClick={go}>Import {preview?.rows ?? ""} rows</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
