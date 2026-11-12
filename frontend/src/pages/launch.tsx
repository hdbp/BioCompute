import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, CircleAlert, Cpu, Lock, Network, Play, Rocket, RotateCcw, Server, ShieldCheck, X } from "lucide-react";
import { api, ApiError, errMsg, qs } from "@/lib/api";
import type { ClusterNode, Experiment, FormSchema, Issue, PipelineDetail, Pipeline, Preset, Project, RunDetail } from "@/lib/types";
import { bytes, cn } from "@/lib/utils";
import { takeLaunchPrefill } from "@/lib/handoff";
import { IssueList, PageHeader, QueryError, usePageTitle } from "@/components/page";
import { Badge, Checkbox, Empty, Panel, Skeleton, Slider } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Field, Input, Select } from "@/components/ui/input";
import { PathInput } from "@/components/file-browser";
import { TailnetTag } from "@/components/source-tag";
import { formErrors, GenericParamEditor, humanLabel, isChanged, SchemaForm, type Params } from "@/components/schema-form";
import { ReferenceGenomeBar } from "@/components/reference-picker";

interface Candidate {
  node_id: string; hostname: string; eligible: boolean; reasons: string[]; warnings: string[]; facts: string[];
  cpus: number; cpus_free: number; memory_gb: number; disk_free_gb: number | null; gpus: number;
  link: { down_mbps: number | null; basis: string }; transfer_seconds: number; compute_seconds: number | null;
  estimated_seconds: number | null; is_controller: boolean; site: string | null;
}
interface Placement {
  recommended: Candidate | null; fastest: Candidate | null; input_bytes: number; restricted: boolean; executor: string;
  requested_disk_gb: number; disk_estimated: boolean; candidates: Candidate[];
  estimate: { speedup_if_recruited: number; additional_cores: number; worthwhile: boolean; assumptions: string; max_transfer_seconds: number } | null;
}

/** Everything the person enters on this page. Kept in sessionStorage per pipeline, so leaving the page (to edit samples, say) loses nothing. */
interface LaunchForm {
  /** the pipeline these entries belong to ("" until the pipeline's parameters have loaded) */
  pid: string;
  versionId: string; experimentId: string;
  /** where the samples come from: an experiment, a samplesheet file, or a folder of FASTQ files */
  source: "experiment" | "file" | "folder"; inputPath: string;
  engine: string; params: Params; outdir: string; projectId: string; name: string; profile: string;
  cpus: number; mem: number; nodeIds: string[];
  needMem: string; needDisk: string; needGpu: boolean;   // hard requirements (empty = none / estimated)
  keepWork: boolean;   // keep intermediate files after the run (they are deleted otherwise)
}
const BLANK: LaunchForm = {
  pid: "", versionId: "", experimentId: "", source: "experiment", inputPath: "", engine: "", params: {}, outdir: "", projectId: "",
  name: "", profile: "", cpus: 0, mem: 0, nodeIds: [], needMem: "", needDisk: "", needGpu: false, keepWork: false,
};

const DRAFT = "biocompute.launch.draft.";
const LAST = "biocompute.launch.last";
function readDraft(pid: string): LaunchForm | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT + pid) ?? "null");
    return d && typeof d === "object" && d.params && typeof d.params === "object" ? { ...BLANK, ...d, pid } : null;
  } catch { return null; }
}
function writeDraft(f: LaunchForm) {
  try { sessionStorage.setItem(DRAFT + f.pid, JSON.stringify(f)); sessionStorage.setItem(LAST, f.pid); } catch { /* storage unavailable: nothing is kept */ }
}
function clearDraft(pid: string) {
  try { sessionStorage.removeItem(DRAFT + pid); if (sessionStorage.getItem(LAST) === pid) sessionStorage.removeItem(LAST); } catch { /* ignore */ }
}
const lastDraftPipeline = () => { try { const pid = sessionStorage.getItem(LAST); return pid && sessionStorage.getItem(DRAFT + pid) ? pid : ""; } catch { return ""; } };

const fmtTime = (s: number | null) => s == null ? "—" : s < 1 ? "< 1 s" : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Step({ n, title, done, children, description }: { n: number; title: string; done?: boolean; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={`launch-step-${n}`} className="relative scroll-mt-20 pl-10" aria-labelledby={`launch-step-${n}-title`}>
      <span className={cn("absolute left-0 top-0 grid size-7 place-items-center rounded-full border text-[13px] font-semibold",
        done ? "border-ok/50 bg-ok/15 text-ok" : "border-line bg-surface text-muted")}>{done ? <CheckCircle2 className="size-4" /> : n}</span>
      <h2 id={`launch-step-${n}-title`} tabIndex={-1} className="text-[15px] font-semibold leading-7 focus-visible:outline-none">{title}</h2>
      {description && <p className="text-[13px] text-muted mb-3">{description}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

interface Blocker { text: string; step: number; field?: string }

export default function LaunchPage() {
  usePageTitle("New run", [{ label: "Runs", to: "/jobs" }]);
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const [pipelineId, setPipelineId] = useState(() => sp.get("pipeline") || lastDraftPipeline());
  const [form, setForm] = useState<LaunchForm>(() => ({ ...BLANK, versionId: sp.get("version") ?? "", experimentId: sp.get("experiment") ?? "", projectId: sp.get("project") ?? "" }));
  // true once the person changed something: only then are the entries remembered
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState<{ kind: "restored" | "prefill"; from?: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [reveal, setReveal] = useState<{ name: string } | null>(null);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  const formRef = useRef(form);
  formRef.current = form;
  /** a change made by the person */
  const edit = (patch: Partial<LaunchForm>) => { setTouched(true); setForm((f) => ({ ...f, ...patch })); };
  /** a default filled in by the page */
  const fill = (patch: Partial<LaunchForm>) => setForm((f) => ({ ...f, ...patch }));
  const setParams = (next: Params | ((p: Params) => Params)) => {
    setTouched(true);
    setForm((f) => ({ ...f, params: typeof next === "function" ? next(f.params) : next }));
  };
  const { versionId, experimentId, source, inputPath, engine, params, outdir, projectId, name, profile, cpus, mem, nodeIds, needMem, needDisk, needGpu, keepWork } = form;

  const pipelines = useQuery({ queryKey: ["pipelines"], queryFn: () => api.get<Pipeline[]>("/api/pipelines") });
  const experiments = useQuery({ queryKey: ["experiments"], queryFn: () => api.get<Experiment[]>("/api/experiments") });
  const detail = useQuery({ queryKey: ["pipeline", pipelineId], queryFn: () => api.get<PipelineDetail>(`/api/pipelines/${pipelineId}`), enabled: !!pipelineId });
  const schema = useQuery({ queryKey: ["schema", pipelineId, versionId || undefined], queryFn: () => api.get<FormSchema>(`/api/pipeline-schemas/${pipelineId}${qs({ version_id: versionId || undefined })}`), enabled: !!pipelineId });
  const presets = useQuery({ queryKey: ["presets", pipelineId], queryFn: () => api.get<Preset[]>(`/api/pipelines/${pipelineId}/presets`), enabled: !!pipelineId });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => api.get<ClusterNode[]>("/api/nodes") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ ui: { default_output_dir?: string } ; data_roots: { name: string; writable: boolean }[] }>("/api/settings") });
  const validation = useQuery({
    queryKey: ["exp-validate", experimentId, pipelineId, versionId],
    queryFn: () => api.post<{ valid: boolean; errors: number; warnings: number; issues: Issue[] }>(`/api/experiments/${experimentId}/validate`, { pipeline_id: pipelineId, version_id: versionId || null }),
    enabled: !!experimentId && !!pipelineId,
  });
  const placement = useQuery({
    queryKey: ["placement", experimentId, nodeIds, needMem, needDisk, needGpu],
    queryFn: () => api.post<Placement>("/api/allocations/placement", {
      experiment_id: experimentId || null, node_ids: nodeIds, requested_mem_gb: Number(needMem) || 0,
      requested_disk_gb: needDisk ? Number(needDisk) : null, requires_gpu: needGpu,
    }),
  });

  useEffect(() => {  // accept a slug in ?pipeline=
    const m = pipelines.data?.find((p) => p.slug === pipelineId);
    if (m) setPipelineId(m.id);
  }, [pipelines.data, pipelineId]);
  // keep the address in step with the choices, so Back (or a reload) returns to the same pipeline and samples
  useEffect(() => {
    const next = new URLSearchParams(sp);
    const put = (k: string, v: string) => { if (v) next.set(k, v); else next.delete(k); };
    put("pipeline", pipelineId); put("version", versionId); put("experiment", experimentId);
    if (next.toString() !== sp.toString()) setSp(next, { replace: true });
  }, [pipelineId, versionId, experimentId, sp, setSp]);

  const controller = nodes.data?.find((n) => n.is_controller);
  const capC = controller?.allocation?.max_cpus ?? 1;
  const capM = controller?.allocation?.max_memory_gb ?? 1;
  useEffect(() => { if (controller && !cpus) fill({ cpus: capC, mem: capM }); }, [controller, capC, capM, cpus]);

  // When a pipeline's parameters arrive: take over parameters handed over by the pipeline page, else restore what was
  // entered earlier for this pipeline, else start from the pipeline's defaults.
  const loaded = useRef({ pid: "", vid: "", defaults: {} as Params });
  const keepParams = useRef(false);
  useEffect(() => {
    const sd = schema.data;
    if (!sd) return;
    const pid = sd.pipeline_id || pipelineId;
    const was = loaded.current;
    const cur = formRef.current;
    if (was.pid !== pid) {
      setServerIssues([]);
      const pre = takeLaunchPrefill(pid) ?? (pipelineId !== pid ? takeLaunchPrefill(pipelineId) : null);
      const draft = readDraft(pid);
      let next: LaunchForm;
      if (draft) {
        // what is chosen right now (by the link that opened this page, or by hand) wins over the remembered entries
        next = { ...draft, versionId: cur.versionId || draft.versionId, experimentId: cur.experimentId || draft.experimentId, projectId: cur.projectId || draft.projectId };
        if (cur.experimentId && cur.experimentId !== draft.experimentId) next.source = "experiment";
        setTouched(true);
        setNote({ kind: "restored" });
      } else {
        next = { ...cur, pid, params: sd.defaults };
        // a pipeline built in Studio can carry a default samplesheet or FASTQ folder
        const def = typeof sd.defaults.input === "string" ? sd.defaults.input : "";
        if (def && !cur.experimentId) { next.source = /\.(csv|tsv)$/i.test(def) ? "file" : "folder"; next.inputPath = def; }
        setNote(null);
      }
      if (pre) {
        next.params = { ...sd.defaults, ...pre.params };
        if (pre.version_id) next.versionId = pre.version_id;
        setTouched(true);
        setNote({ kind: "prefill", from: pre.from });
      }
      keepParams.current = next.versionId !== cur.versionId;   // the parameters for that version load next; keep these values
      setForm(next);
    } else if (was.vid === sd.version_id) {
      keepParams.current = false;
    } else if (keepParams.current) {
      keepParams.current = false;
    } else {
      // another version of the same pipeline: its defaults, plus the values the person had changed (where they still exist)
      setServerIssues([]);
      const known = sd.form.has_schema ? new Set(sd.form.groups.flatMap((g) => g.fields.map((f) => f.name))) : null;
      const kept = Object.fromEntries(Object.entries(cur.params).filter(([k, v]) => isChanged(v, was.defaults[k]) && (!known || known.has(k))));
      setForm((f) => ({ ...f, params: { ...sd.defaults, ...kept } }));
    }
    loaded.current = { pid, vid: sd.version_id, defaults: sd.defaults };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema.data]);
  // remember the entries (this browser tab only) as soon as something was changed
  useEffect(() => { if (touched && form.pid) writeDraft(form); }, [form, touched]);

  const folderPreview = useQuery({
    queryKey: ["detect-pairs", inputPath],
    queryFn: () => api.post<{ samples: { sample_id: string; paired: boolean }[]; warnings: string[] }>("/api/experiments/detect-pairs", { directory: inputPath }),
    enabled: source === "folder" && !!inputPath, retry: false,
  });
  useEffect(() => {
    const avail = detail.data?.runnable.filter((r) => r.available) ?? [];
    if (detail.data && !avail.some((a) => a.engine === engine)) fill({ engine: avail[0]?.engine ?? "" });
  }, [detail.data, engine]);
  useEffect(() => {
    if (!outdir && settings.data) {
      const w = settings.data.data_roots.find((r) => r.writable);
      if (settings.data.ui.default_output_dir) fill({ outdir: `${settings.data.ui.default_output_dir}/${stamp()}` });
      else if (w) fill({ outdir: `${w.name}:runs/${stamp()}` });
    }
  }, [settings.data, outdir]);

  const groups = schema.data?.form.groups ?? [];
  const hasSchema = !!schema.data?.form.has_schema;
  const clientErrors = useMemo(() => formErrors(groups, params, ["input", "outdir"]), [groups, params]);
  const errorNames = Object.keys(clientErrors);
  const exp = experiments.data?.find((e) => e.id === experimentId);
  const needsSamples = !!schema.data?.form.groups.some((g) => g.fields.some((f) => f.name === "input" && f.required));
  const usingExperiment = source === "experiment";
  const haveSamples = usingExperiment ? !!experimentId : !!inputPath && (source !== "folder" || (folderPreview.data?.samples.length ?? 0) > 0);
  const noEngine = !!detail.data && detail.data.runnable.every((r) => !r.available);
  const multiNode = nodeIds.length > 1 || (nodeIds.length === 1 && nodeIds[0] !== controller?.id);

  // every reason the run cannot be started yet, in plain words (the Start button is disabled while any remains)
  const blockers: Blocker[] = [];
  if (!pipelineId) blockers.push({ text: "Choose a pipeline", step: 1 });
  else if (!engine) blockers.push({ text: noEngine ? "No engine can run this pipeline here: install Nextflow on the controller" : detail.isError ? "The pipeline could not be loaded" : "Choose how the pipeline is run", step: 1 });
  // the parameters on screen must be the ones of the chosen pipeline before anything is sent
  const paramsReady = !pipelineId || (!!schema.data && form.pid === (schema.data.pipeline_id || pipelineId));
  if (!paramsReady) blockers.push({ step: 3, text: schema.isError ? "The pipeline's parameters could not be loaded" : "Wait for the pipeline's parameters to load" });
  if (needsSamples && !haveSamples) {
    blockers.push({ step: 2, text: usingExperiment ? "Choose an experiment (the samples to analyse)"
      : source === "file" ? "Choose a samplesheet file"
      : !inputPath ? "Choose a folder of FASTQ files"
      : folderPreview.isLoading ? "Wait for the FASTQ folder to be read" : "The chosen folder has no FASTQ files" });
  }
  if (usingExperiment && experimentId && validation.data?.valid === false) {
    blockers.push({ step: 2, text: `Fix ${plural(validation.data.errors, "problem")} in the samples of ${exp ? `"${exp.name}"` : "the experiment"}` });
  }
  errorNames.slice(0, 4).forEach((k) => blockers.push({ step: 3, field: k, text: `${humanLabel(k)}: ${clientErrors[k] === "Required" ? "a value is required" : clientErrors[k].toLowerCase()}` }));
  if (errorNames.length > 4) blockers.push({ step: 3, field: errorNames[4], text: `${plural(errorNames.length - 4, "more parameter")} to correct` });
  if (!outdir) blockers.push({ text: "Choose an output folder", step: 4 });
  const ready = blockers.length === 0;
  const goTo = (b: Blocker) => {
    if (b.field && hasSchema) { setReveal({ name: b.field }); return; }   // the form opens the group and scrolls to the field
    document.getElementById(`launch-step-${b.step}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById(`launch-step-${b.step}-title`)?.focus({ preventScroll: true });
  };

  const body = (dry: boolean) => ({
    pipeline_id: pipelineId, version_id: versionId || null, engine, name: name || null, output_dir: outdir,
    params: usingExperiment ? params : { ...params, input: inputPath },
    experiment_id: usingExperiment ? experimentId || null : null, node_ids: nodeIds, dry_run: dry, project_id: projectId || null,
    resources: { max_cpus: cpus, max_memory_gb: mem, profile: profile || undefined,
      ...(Number(needMem) ? { min_memory_gb: Number(needMem) } : {}), ...(needDisk ? { min_disk_gb: Number(needDisk) } : {}),
      ...(needGpu ? { requires_gpu: true } : {}), ...(keepWork ? { keep_work: true } : {}) },
  });
  const launch = useMutation({
    mutationFn: (dry: boolean) => api.post<RunDetail>("/api/runs", body(dry)),
    onSuccess: (r, dry) => {
      setServerIssues([]);
      if (dry) toast.success("Validation passed: parameters, samples and the computers to run on are ready");
      else {
        if (form.pid) clearDraft(form.pid);
        setTouched(false);
        toast.success(`Started ${r.name}`);
        nav(`/runs/${r.id}`);
      }
    },
    onError: (e) => {
      if (e instanceof ApiError && e.issues.length) { setServerIssues(e.issues as Issue[]); toast.error("Validation failed; see the problems listed next to the Start button"); }
      else toast.error(errMsg(e));
    },
  });
  const serverByField = Object.fromEntries(serverIssues.filter((i) => i.field).map((i) => [i.field!, i.message]));
  const runnable = (pipelines.data ?? []).filter((p) => p.kind !== "template");

  const startOver = async () => {
    if (!(await confirmDialog({ title: "Start over?", body: "Everything you entered on this page is cleared and the pipeline's default values are restored.", confirmLabel: "Start over", danger: true }))) return;
    if (form.pid) clearDraft(form.pid);
    setTouched(false); setNote(null); setServerIssues([]); setAdvanced(false);
    setForm({ ...BLANK, pid: form.pid, params: schema.data?.defaults ?? {} });
  };
  const choosePipeline = (id: string) => {
    setPipelineId(id);
    setForm((f) => ({ ...f, pid: "", versionId: "" }));   // entries are attached to the new pipeline once its parameters have loaded
    if (!id) { loaded.current = { pid: "", vid: "", defaults: {} }; setNote(null); }
  };
  const advancedChanges = [!!profile, !!controller && cpus > 0 && cpus !== capC, !!controller && mem > 0 && mem !== capM, !!needMem, !!needDisk, needGpu, nodeIds.length > 0, keepWork].filter(Boolean).length;

  return (
    <>
      <PageHeader title="New run" description="Choose a pipeline and its samples (an experiment, a samplesheet or a FASTQ folder), adjust the parameters, then start the run. Runs continue on the controller after you close the browser."
        actions={touched && <Button variant="ghost" onClick={startOver}><RotateCcw />Start over</Button>} />
      {pipelines.isError && <QueryError className="mb-6" error={pipelines.error} what="the pipelines" onRetry={() => pipelines.refetch()} />}
      {note && (
        <div role="status" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1">
            {note.kind === "prefill"
              ? <>Parameters from <span className="font-medium">{note.from || "the pipeline page"}</span>. Check the samples and the output folder, then start the run.</>
              : <>Your earlier entries for this pipeline were restored. They are kept in this browser tab until you start the run.</>}
          </span>
          {note.kind === "restored" && <button type="button" className="text-accent hover:underline" onClick={startOver}>Start over</button>}
          <button type="button" className="text-muted hover:text-text" onClick={() => setNote(null)} aria-label="Dismiss this note"><X className="size-4" /></button>
        </div>
      )}
      <div className="grid gap-8 xl:grid-cols-[1fr_320px]">
        <div className="space-y-10 min-w-0">
          <Step n={1} title="Pipeline" done={!!pipelineId && !!engine}>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Pipeline" className="sm:col-span-2">
                <Select value={pipelineId} onChange={(e) => choosePipeline(e.target.value)}>
                  <option value="">Choose an installed pipeline</option>
                  {runnable.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.category})</option>)}
                </Select>
              </Field>
              <Field label="Version">
                <Select value={versionId} onChange={(e) => edit({ versionId: e.target.value })} disabled={!detail.data}>
                  <option value="">Default version</option>
                  {detail.data?.versions.map((v) => <option key={v.id} value={v.id}>{v.version}{v.git_commit ? ` (${v.git_commit.slice(0, 7)})` : ""}</option>)}
                </Select>
              </Field>
            </div>
            {detail.isError && <QueryError className="mt-3" error={detail.error} what="this pipeline" onRetry={() => detail.refetch()} />}
            {detail.data && (
              <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="How the pipeline is run">
                {detail.data.runnable.map((r) => (
                  <button key={r.engine} type="button" role="radio" aria-checked={engine === r.engine} disabled={!r.available} onClick={() => edit({ engine: r.engine })}
                    className={cn("rounded-md border px-3 py-2 text-left text-[13px] disabled:opacity-50", engine === r.engine ? "border-accent bg-accent/10" : "border-line hover:bg-raised")}>
                    <span className="font-medium">{r.engine === "nextflow" ? "Nextflow" : "BioCompute native engine"}</span>
                    <span className="block text-xs text-muted">{r.available ? r.detail : r.engine === "nextflow" ? "Nextflow is not installed on the controller" : "switched off"}</span>
                  </button>
                ))}
                {noEngine && <p className="text-[13px] text-bad">Nothing on the controller can run this pipeline. Install Nextflow on the controller (see Settings).</p>}
              </div>
            )}
            {pipelineId && detail.data && detail.data.kind !== "template" && (
              <Button asChild size="sm" variant="ghost" className="mt-3">
                <Link to={`/pipelines/${pipelineId}/map${versionId ? `?version=${versionId}` : ""}`} target="_blank"><Network />Open pipeline map</Link>
              </Button>
            )}
          </Step>

          <Step n={2} title="Samples" done={usingExperiment ? !!experimentId && validation.data?.valid : haveSamples}
            description="Where the reads come from. An experiment carries conditions, replicates and controls; a samplesheet file or a FASTQ folder is quicker for simple pipelines.">
            <div className="mb-3 flex w-fit rounded-md border border-line p-0.5 text-[13px]" role="group" aria-label="Sample source">
              {([["experiment", "Experiment"], ["file", "Samplesheet file"], ["folder", "Folder of FASTQ files"]] as const).map(([k, l]) => (
                <button key={k} type="button" onClick={() => edit({ source: k })} aria-pressed={source === k}
                  className={cn("rounded px-3 py-1", source === k ? "bg-raised text-text" : "text-muted hover:text-text")}>{l}</button>
              ))}
            </div>
            {source === "file" && (
              <Field label="Samplesheet" hint="CSV or TSV with sample, fastq_1, fastq_2 (and the columns this pipeline needs). Paths may be absolute or data-folder paths like raw:run1/A_R1.fastq.gz.">
                <PathInput id="launch-samplesheet" mode="file" value={inputPath} onChange={(v) => edit({ inputPath: v })} />
              </Field>
            )}
            {source === "folder" && (
              <div className="space-y-2">
                <Field label="FASTQ folder" hint="Searched recursively. Samples, lanes and R1/R2 pairs are detected from the file names; lanes of a sample are merged.">
                  <PathInput id="launch-fastq-folder" mode="dir" value={inputPath} onChange={(v) => edit({ inputPath: v })} />
                </Field>
                {inputPath && (folderPreview.isLoading ? <Skeleton className="h-5 w-64" />
                  : folderPreview.isError ? <p className="text-[13px] text-bad">{errMsg(folderPreview.error)}</p>
                  : folderPreview.data && (
                    <div className="rounded-md border border-line bg-surface px-4 py-3 text-[13px]">
                      <p className={cn("flex items-center gap-2 font-medium", folderPreview.data.samples.length ? "text-ok" : "text-bad")}>
                        {folderPreview.data.samples.length ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}
                        {folderPreview.data.samples.length
                          ? `${folderPreview.data.samples.length} samples (${folderPreview.data.samples.filter((x) => x.paired).length} paired-end)`
                          : "No FASTQ files found in this folder"}
                      </p>
                      {folderPreview.data.samples.length > 0 && <p className="mt-1 truncate text-xs text-muted">{folderPreview.data.samples.slice(0, 12).map((x) => x.sample_id).join(", ")}{folderPreview.data.samples.length > 12 ? ", …" : ""}</p>}
                      {folderPreview.data.warnings
                        .filter((w) => folderPreview.data!.samples.some((x) => x.paired) || !w.includes("without matching R2")) // all single-end: expected
                        .slice(0, 4).map((w) => <p key={w} className="text-xs text-wait">{w}</p>)}
                      <p className="mt-1 text-xs text-muted">Condition, replicate and control columns stay empty. Use an experiment when the pipeline needs them.</p>
                    </div>
                  ))}
              </div>
            )}
            {usingExperiment && (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Experiment" className="w-96 max-w-full">
                    <Select value={experimentId} onChange={(e) => edit({ experimentId: e.target.value })}>
                      <option value="">{needsSamples ? "Choose an experiment" : "None (this pipeline needs no sample table)"}</option>
                      {experiments.data?.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.sample_count} samples, {e.assay})</option>)}
                    </Select>
                  </Field>
                  {/* leaving for the experiment page is safe: the entries are written down first and restored on return */}
                  <Button asChild variant="ghost">
                    <Link to={experimentId ? `/experiments/${experimentId}` : "/experiments"} onClick={() => { if (form.pid) { setTouched(true); writeDraft(form); } }}>
                      {experimentId ? "Edit samples" : "Create an experiment"}
                    </Link>
                  </Button>
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  {experimentId ? "Editing the samples" : "Creating an experiment"} opens another page. {pipelineId ? "What you entered here is kept: come back with the browser's Back button or New run." : "Choose the pipeline first and your entries here are kept until you come back."}
                </p>
                {experiments.isError && <p className="mt-1.5 text-[13px] text-bad">The experiments could not be loaded: {errMsg(experiments.error)}</p>}
              </>
            )}
            {usingExperiment && experimentId && pipelineId && (
              <div className="mt-3 rounded-md border border-line bg-surface px-4 py-3">
                {validation.isLoading ? <Skeleton className="h-5 w-64" />
                  : validation.isError ? <p className="text-[13px] text-bad">The samples could not be checked: {errMsg(validation.error)}</p>
                  : validation.data && (
                  <>
                    <p className={cn("flex items-center gap-2 text-[13.5px] font-medium", validation.data.valid ? "text-ok" : "text-bad")}>
                      {validation.data.valid ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}
                      <span title="Checked against the pipeline's samplesheet schema">
                        {validation.data.valid ? `${exp?.sample_count ?? "All"} samples have everything this pipeline needs` : `${plural(validation.data.errors, "problem")} to fix before the run can start`}
                      </span>
                      {validation.data.warnings > 0 && <Badge tone="wait">{plural(validation.data.warnings, "warning")}</Badge>}
                    </p>
                    <IssueList issues={validation.data.issues.slice(0, 12)} className="mt-2" />
                  </>
                )}
              </div>
            )}
          </Step>

          <Step n={3} title="Parameters" done={!!schema.data && errorNames.length === 0}
            description={hasSchema ? <span title="The form is generated from the pipeline's nextflow_schema.json">The settings this pipeline offers, filled with its defaults. Change only what you need.</span> : undefined}>
            {!pipelineId && <p className="text-[13px] text-muted">Choose a pipeline first.</p>}
            {schema.isLoading && <Skeleton className="h-48" />}
            {schema.isError && <QueryError error={schema.error} what="the parameters of this pipeline" onRetry={() => schema.refetch()} />}
            {schema.data && (
              <>
                {(presets.data?.length ?? 0) > 0 && (
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="text-muted" title="A preset is a saved set of parameter values">Use saved values</span>
                    {presets.data!.map((p) => <Button key={p.id} size="sm" variant="secondary" title={p.description || undefined} onClick={() => setParams({ ...schema.data!.defaults, ...p.params })}>{p.name}</Button>)}
                  </div>
                )}
                {hasSchema && (
                  <ReferenceGenomeBar fields={groups.flatMap((g) => g.fields)} params={params} initialGenome={usingExperiment ? exp?.genome : null}
                    onApply={(u) => setParams((p) => ({ ...p, ...u }))} />
                )}
                {hasSchema
                  ? <SchemaForm groups={groups} params={params} defaults={schema.data.defaults} onChange={setParams} serverIssues={serverByField} compact reveal={reveal}
                      managed={[{ name: "input", note: !usingExperiment ? (inputPath ? `From ${inputPath} (step 2)` : "Set in step 2") : exp ? `Sample table made from "${exp.name}"` : "Made from the selected experiment" }, { name: "outdir", note: "Set in step 4" }]} />
                  : (
                    <Panel className="p-4">
                      <p className="text-[13.5px] font-medium">This pipeline does not list its parameters</p>
                      <p className="mt-1 mb-3 text-[13px] text-muted" title="The pipeline has no nextflow_schema.json, so no form can be generated">
                        Add the ones you want to set, by name and value. Each is passed to the pipeline as <code className="font-mono text-[12px]">--name value</code>; anything you leave out keeps the pipeline's own default.
                        The samples and the output folder are set in steps 2 and 4.
                      </p>
                      <GenericParamEditor params={params} onChange={setParams} />
                    </Panel>
                  )}
              </>
            )}
          </Step>

          <Step n={4} title="Where and how it runs" done={!!outdir}>
            <div className="grid gap-4 sm:grid-cols-2">
              {(projects.data ?? []).some((p) => p.can_edit) && (
                <Field label="Project" hint="The run is listed in the project in Data Explorer; with a project folder, results go to its results/ folder." className="sm:col-span-2">
                  <Select value={projectId} onChange={(e) => {
                    const pr = projects.data?.find((x) => x.id === e.target.value);
                    edit({ projectId: e.target.value, ...(pr?.home ? { outdir: `${pr.home}/results/${stamp()}` } : {}) });
                  }}>
                    <option value="">No project</option>
                    {projects.data!.filter((p) => p.can_edit).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Output folder" required hint="A data folder you can write to. The results, and a record of how they were made, are saved here." className="sm:col-span-2">
                <PathInput id="launch-outdir" mode="dir" value={outdir} onChange={(v) => edit({ outdir: v })} writableOnly />
              </Field>
              <Field label="Run name" hint="Optional. Without one the run is named after the pipeline and the time." className="sm:col-span-2">
                <Input value={name} onChange={(e) => edit({ name: e.target.value })} />
              </Field>
            </div>

            <div className="mt-5 rounded-lg border border-line">
              <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={advanced} aria-controls="launch-advanced" onClick={() => setAdvanced(!advanced)}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">Advanced</span>
                  <span className="block truncate text-xs text-muted">
                    {multiNode ? `Runs on ${plural(nodeIds.length, "selected computer")}` : "Runs on the controller, next to the data"}, up to {cpus || capC} cores and {mem || capM} GB of memory{profile ? `, tools from ${profile}` : ""}.
                  </span>
                </span>
                {advancedChanges > 0 && <Badge tone="accent">{advancedChanges} changed</Badge>}
                <ChevronDown className={cn("size-4 text-muted transition-transform", !advanced && "-rotate-90")} />
              </button>
              {advanced && (
                <div id="launch-advanced" className="border-t border-line px-4 py-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={`CPU cores for this run: ${cpus} (of ${capC} allowed on the controller)`}>
                      <Slider min={1} max={capC} value={[Math.min(cpus || capC, capC)]} onValueChange={([v]) => edit({ cpus: v })} aria-label="CPU cores" />
                    </Field>
                    <Field label={`Memory for this run: ${mem} GB (of ${capM} GB allowed)`}>
                      <Slider min={1} max={Math.max(1, Math.floor(capM))} value={[Math.min(mem || capM, capM)]} onValueChange={([v]) => edit({ mem: v })} aria-label="Memory" />
                    </Field>
                  </div>
                  <p className="mt-2 text-xs text-muted" title="Passed to Nextflow as executor.cpus, executor.memory and process resourceLimits">
                    Upper limits for this run. The pipeline is told not to use more; the operating system does not enforce them.
                  </p>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <Field label="Where the tools come from" hint={engine === "nextflow" ? <span title="Nextflow -profile">A software profile of the pipeline, for example conda or docker.</span> : "Only used with Nextflow."}>
                      <Select value={profile} onChange={(e) => edit({ profile: e.target.value })} disabled={engine !== "nextflow"}>
                        <option value="">Tools installed on the computer</option>
                        {(schema.data?.profiles ?? []).map((p) => <option key={p}>{p}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <p className="mt-5 text-[13.5px] font-medium">Requirements a computer must meet</p>
                  <div className="mt-2 grid gap-4 sm:grid-cols-3">
                    <Field label="Free memory (GB)" hint="Computers with less free memory are not used.">
                      <Input type="number" min={0} value={needMem} placeholder="no requirement" onChange={(e) => edit({ needMem: e.target.value })} />
                    </Field>
                    <Field label="Free temporary disk space (GB)" hint={placement.data?.disk_estimated ? `Estimated at ${placement.data.requested_disk_gb} GB from the input size (a warning only).` : "Computers with less free space for temporary files are not used."}>
                      <Input type="number" min={0} value={needDisk} placeholder={placement.data ? `~${placement.data.requested_disk_gb} (estimate)` : "estimate"} onChange={(e) => edit({ needDisk: e.target.value })} />
                    </Field>
                    <label className="flex items-center gap-2 self-center text-[13px]"><Checkbox checked={needGpu} onCheckedChange={(v) => edit({ needGpu: !!v })} />Needs a GPU</label>
                    <label className="flex items-start gap-2 text-[13px] sm:col-span-2">
                      <Checkbox className="mt-0.5" checked={keepWork} onCheckedChange={(v) => edit({ keepWork: !!v })} />
                      <span>Keep intermediate files
                        <span className="block text-xs text-muted">Normally files that steps pass to each other are deleted as soon as nothing needs them; the results are kept either way. Keep them to inspect or debug a step. A failed run always keeps them, so Resume can continue.</span>
                      </span>
                    </label>
                  </div>
                  <NodePicker placement={placement.data} nodes={nodes.data ?? []} selected={nodeIds} onChange={(ids) => edit({ nodeIds: ids })} />
                </div>
              )}
            </div>
          </Step>
        </div>

        <aside className="xl:sticky xl:top-6 self-start space-y-4">
          <Panel className="p-4 space-y-3">
            <p className="font-semibold">Summary</p>
            <dl className="space-y-1.5 text-[13px]">
              <Row k="Pipeline" v={detail.data?.name} />
              <Row k="Engine" v={engine === "bcflow" ? "native engine" : engine === "nextflow" ? "Nextflow" : engine || null} />
              <Row k="Samples" v={usingExperiment ? (exp ? `${exp.name}, ${exp.sample_count} samples` : null)
                : source === "folder" ? (inputPath ? `${folderPreview.data?.samples.length ?? "…"} from ${inputPath}` : null) : inputPath || null} />
              <Row k="Input data" v={placement.data ? `${bytes(placement.data.input_bytes)}${placement.data.restricted ? ", restricted" : ""}` : null} />
              <Row k="Runs on" v={multiNode ? <span title="Uses Nextflow's HTCondor executor">{plural(nodeIds.length, "selected computer")}</span> : "the controller, next to the data"} />
              <Row k="Limits" v={`${cpus} cores, ${mem} GB`} />
              <Row k="Output" v={outdir} mono />
            </dl>
            {serverIssues.length > 0 && <IssueList issues={serverIssues} />}
            {blockers.length > 0 && (
              <div id="launch-blockers" className="rounded-md border border-wait/30 bg-wait/5 px-3 py-2.5">
                <p className="text-[12.5px] font-medium text-wait">Before the run can start</p>
                <ul className="mt-1 space-y-1">
                  {blockers.map((b, i) => (
                    <li key={i}>
                      <button type="button" onClick={() => goTo(b)} className="group flex w-full gap-2 text-left text-[12.5px] leading-snug" title={`Go to step ${b.step}`}>
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-wait" />
                        <span className="min-w-0 flex-1 group-hover:underline">{b.text}</span>
                        <span className="shrink-0 text-muted">step {b.step}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button variant="secondary" className="flex-1" disabled={!pipelineId || !engine || !outdir || !paramsReady} loading={launch.isPending && launch.variables === true} onClick={() => launch.mutate(true)}><ShieldCheck />Validate</Button>
              <Button variant="primary" className="flex-1" disabled={!ready} aria-describedby={blockers.length ? "launch-blockers" : undefined} loading={launch.isPending && launch.variables === false} onClick={() => launch.mutate(false)}><Rocket />Start run</Button>
            </div>
            <p className="text-[11.5px] text-muted">Validate runs every check a real start does (parameters, samples, that the files exist, where it can run) without starting anything.</p>
          </Panel>
          {!pipelineId && <Panel><Empty icon={<Play />} title="Pick a pipeline to begin" className="py-8" /></Panel>}
        </aside>
      </div>
    </>
  );
}

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return <div className="flex gap-2"><dt className="w-24 shrink-0 text-muted">{k}</dt><dd className={cn("min-w-0 break-words", mono && "font-mono text-[12px]", !v && "text-muted")}>{v || "—"}</dd></div>;
}

function NodePicker({ placement, nodes, selected, onChange }: { placement?: Placement; nodes: ClusterNode[]; selected: string[]; onChange: (ids: string[]) => void }) {
  if (!placement) return null;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const est = placement.estimate;
  const fastest = placement.fastest;
  const recommended = placement.recommended;
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13.5px] font-medium">Computers to run on</p>
        {placement.restricted && <Badge tone="wait"><Lock className="size-3" />Restricted inputs stay on the lab site</Badge>}
        {fastest && recommended && fastest.node_id !== recommended.node_id && !selected.includes(fastest.node_id) && (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => onChange([fastest.node_id])}>
            Use fastest: {fastest.hostname} ({fmtTime(fastest.estimated_seconds)} vs {fmtTime(recommended.estimated_seconds)})
          </Button>
        )}
      </div>
      <p className="text-xs text-muted mt-0.5 mb-2">
        Ranked by the estimated time to finish: copying the input over each computer's measured network link, plus computing on its free cores.
        With none selected the run stays on the controller, next to the data. <span title="Uses Nextflow's HTCondor executor, which needs a filesystem shared by those nodes">Other computers are reached through the cluster scheduler and need a folder shared with the controller.</span>
      </p>
      <div className="rounded-md border border-line divide-y divide-line/60">
        {placement.candidates.map((c) => {
          const n = nodes.find((x) => x.id === c.node_id);
          const disabled = !c.eligible && !selected.includes(c.node_id);
          return (
            <label key={c.node_id} className={cn("flex items-start gap-3 px-3 py-2.5 text-[13px]", disabled ? "opacity-60" : "cursor-pointer")}>
              <Checkbox className="mt-0.5" checked={selected.includes(c.node_id)} onCheckedChange={() => toggle(c.node_id)} disabled={disabled} />
              <Server className={cn("mt-0.5 size-4", c.is_controller ? "text-accent" : "text-muted")} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{c.hostname}</span>
                  {recommended?.node_id === c.node_id && <Badge tone="accent">Default: next to the data</Badge>}
                  {fastest?.node_id === c.node_id && c.estimated_seconds != null && <Badge tone="ok">Fastest</Badge>}
                  {n?.tailnet.member && <TailnetTag tailnet={n.tailnet} />}
                </span>
                {c.eligible
                  ? <span className="block text-xs text-muted">{c.facts.join(", ")}</span>
                  : <span className="block text-xs text-wait">{c.reasons.join("; ")}</span>}
                {c.warnings.length > 0 && <span className="block text-xs text-wait">{c.warnings.join("; ")}</span>}
              </span>
              <span className="w-20 shrink-0 text-right">
                <span className="block font-medium tabular-nums">{c.eligible ? fmtTime(c.estimated_seconds) : "—"}</span>
                <span className="block text-[11px] text-muted tabular-nums inline-flex items-center gap-1"><Cpu className="size-3" />{n?.utilization.cpu_percent?.toFixed(0) ?? "—"}% busy</span>
              </span>
            </label>
          );
        })}
      </div>
      {placement.input_bytes === 0 && <p className="mt-2 text-xs text-muted">Choose an experiment to get time estimates (they depend on the size of the input).</p>}
      {est && est.additional_cores > 0 && (
        <p className={cn("mt-2 text-xs", est.worthwhile ? "text-ok" : "text-muted")}>
          Using the other {est.additional_cores} free cores as well would make the run an estimated {est.speedup_if_recruited}x faster{est.worthwhile ? "." : ", probably not worth copying the data."} <span className="text-muted">({est.assumptions})</span>
        </p>
      )}
    </div>
  );
}
