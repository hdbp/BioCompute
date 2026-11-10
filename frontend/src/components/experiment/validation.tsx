import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Download, FileSpreadsheet, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import type { Issue, Pipeline } from "@/lib/types";
import { cn, download } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/misc";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { IssueList } from "@/components/page";

export interface ValidationResult { valid: boolean; errors: number; warnings: number; issues: Issue[]; pipelineName?: string }

export function usePipelinesForExperiments() {
  return useQuery({
    queryKey: ["pipelines", "runnable"],
    queryFn: () => api.get<Pipeline[]>("/api/pipelines"),
    select: (ps) => ps.filter((p) => p.kind !== "template" && p.latest_version),
  });
}

export function ValidationPanel({ expId, pipelineId, setPipelineId, dirty, saveFirst, result, setResult, sampleCount, localErrors }: {
  expId: string; pipelineId: string; setPipelineId: (id: string) => void; dirty: boolean; saveFirst: () => Promise<boolean>;
  result: ValidationResult | null; setResult: (r: ValidationResult | null) => void; sampleCount: number; localErrors: number;
}) {
  const pipelines = usePipelinesForExperiments();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);

  async function validate() {
    setBusy(true);
    try {
      if (dirty && !(await saveFirst())) return;
      const r = await api.post<ValidationResult>(`/api/experiments/${expId}/validate`, { pipeline_id: pipelineId || null });
      setResult({ ...r, pipelineName: pipelines.data?.find((p) => p.id === pipelineId)?.name });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const groups = result ? (["error", "warning", "info"] as const).map((l) => ({ l, items: result.issues.filter((i) => i.level === l) })).filter((g) => g.items.length) : [];

  return (
    <Panel>
      <PanelHeader title="Validation" description="Check samples, files and the design against a pipeline's samplesheet schema." />
      <div className="p-4 space-y-3">
        <div className="space-y-1.5">
          <label className="text-[13px] font-medium" htmlFor="val-pipeline">Target pipeline</label>
          <Select id="val-pipeline" value={pipelineId} onChange={(e) => { setPipelineId(e.target.value); setResult(null); }}>
            <option value="">Design checks only (no pipeline)</option>
            {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={validate} loading={busy} disabled={!sampleCount}>
            <ShieldCheck />{dirty ? "Save and validate" : "Validate"}
          </Button>
          <Button onClick={() => setPreview(true)} disabled={!sampleCount || dirty} title={dirty ? "Save the table first" : undefined}>
            <FileSpreadsheet />Preview samplesheet
          </Button>
        </div>
        {localErrors > 0 && <p className="text-xs text-bad">{localErrors} problem{localErrors === 1 ? "" : "s"} marked in the table.</p>}
        {result && (
          <div className="space-y-2.5 pt-1">
            <div className={cn("flex items-center gap-2 rounded-md px-3 py-2 text-[13px]", result.valid ? "bg-ok/10 text-ok" : "bg-bad/10 text-bad")}>
              {result.valid ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
              <span className="font-medium">
                {result.valid ? "Ready to run" : `${result.errors} error${result.errors === 1 ? "" : "s"}`}
                {result.warnings ? `, ${result.warnings} warning${result.warnings === 1 ? "" : "s"}` : ""}
              </span>
              {result.pipelineName && <span className="ml-auto truncate text-xs opacity-80">for {result.pipelineName}</span>}
            </div>
            {groups.map((g) => (
              <div key={g.l}>
                <p className="mb-1 text-xs text-muted">{g.l === "error" ? "Errors" : g.l === "warning" ? "Warnings" : "Notes"}</p>
                <IssueList issues={g.items} className="max-h-64 overflow-y-auto pr-1" />
              </div>
            ))}
          </div>
        )}
      </div>
      <SamplesheetPreview open={preview} onOpenChange={setPreview} expId={expId} pipelineId={pipelineId}
        pipelineName={pipelines.data?.find((p) => p.id === pipelineId)?.name} />
    </Panel>
  );
}

function SamplesheetPreview({ open, onOpenChange, expId, pipelineId, pipelineName }: {
  open: boolean; onOpenChange: (o: boolean) => void; expId: string; pipelineId: string; pipelineName?: string;
}) {
  const q = useQuery({
    queryKey: ["samplesheet", expId, pipelineId],
    queryFn: () => api.post<{ columns: string[]; rows: Record<string, unknown>[]; csv: string; format: string }>(`/api/experiments/${expId}/samplesheet`, { pipeline_id: pipelineId || null }),
    enabled: open,
    gcTime: 0,
  });
  const tsv = q.data?.format === "openms-design-tsv";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide className="max-w-5xl" title="Generated samplesheet"
        description={pipelineName ? `Columns follow the input schema of ${pipelineName}. Lanes become separate rows of the same sample.` : "Default columns (no pipeline selected)."}>
        {q.isLoading && <p className="text-[13px] text-muted">Generating…</p>}
        {q.isError && <p className="text-[13px] text-bad">{errMsg(q.error)}</p>}
        {q.data && (
          <div className="overflow-auto rounded-lg border border-line max-h-[55vh]">
            <table className="text-[12px]">
              <thead className="sticky top-0 bg-raised">
                <tr>{q.data.columns.map((c) => <th key={c} className="px-2.5 py-1.5 text-left font-medium text-muted whitespace-nowrap">{c}</th>)}</tr>
              </thead>
              <tbody>
                {q.data.rows.map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    {q.data.columns.map((c) => (
                      <td key={c} className={cn("px-2.5 py-1.5 whitespace-nowrap", /fastq|file|raw|path/i.test(c) && "font-mono text-[11px] text-muted")}>{String(r[c] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="primary" disabled={!q.data} onClick={() => q.data && download(tsv ? "experimental_design.tsv" : "samplesheet.csv", q.data.csv, tsv ? "text/tab-separated-values" : "text/csv")}>
            <Download />Download {tsv ? "TSV" : "CSV"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
