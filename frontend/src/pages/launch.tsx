import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, Cpu, Lock, Play, Rocket, Server, ShieldCheck } from "lucide-react";
import { api, ApiError, errMsg, qs } from "@/lib/api";
import type { ClusterNode, Experiment, FormSchema, Issue, PipelineDetail, Pipeline, Preset, RunDetail } from "@/lib/types";
import { bytes, cn } from "@/lib/utils";
import { IssueList, PageHeader } from "@/components/page";
import { Badge, Checkbox, Empty, Panel, Skeleton, Slider } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { PathInput } from "@/components/file-browser";
import { formErrors, SchemaForm, type Params } from "@/components/schema-form";

interface Placement {
  recommended: { node_id: string; hostname: string } | null; input_bytes: number; restricted: boolean; executor: string;
  candidates: { node_id: string; hostname: string; eligible: boolean; reasons: string[]; cpus: number; memory_gb: number; transfer_seconds: number; score: number; is_controller: boolean; site: string | null }[];
  estimate: { speedup_if_recruited: number; additional_cores: number; worthwhile: boolean; assumptions: string; max_transfer_seconds: number } | null;
}

function Step({ n, title, done, children, description }: { n: number; title: string; done?: boolean; description?: string; children: React.ReactNode }) {
  return (
    <section className="relative pl-10">
      <span className={cn("absolute left-0 top-0 grid size-7 place-items-center rounded-full border text-[13px] font-semibold",
        done ? "border-ok/50 bg-ok/15 text-ok" : "border-line bg-surface text-muted")}>{done ? <CheckCircle2 className="size-4" /> : n}</span>
      <h2 className="text-[15px] font-semibold leading-7">{title}</h2>
      {description && <p className="text-[13px] text-muted mb-3">{description}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

export default function LaunchPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [pipelineId, setPipelineId] = useState(sp.get("pipeline") ?? "");
  const [versionId, setVersionId] = useState(sp.get("version") ?? "");
  const [experimentId, setExperimentId] = useState(sp.get("experiment") ?? "");
  const [engine, setEngine] = useState("");
  const [params, setParams] = useState<Params>({});
  const [outdir, setOutdir] = useState("");
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("");
  const [cpus, setCpus] = useState(0);
  const [mem, setMem] = useState(0);
  const [nodeIds, setNodeIds] = useState<string[]>([]);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);

  const pipelines = useQuery({ queryKey: ["pipelines"], queryFn: () => api.get<Pipeline[]>("/api/pipelines") });
  const experiments = useQuery({ queryKey: ["experiments"], queryFn: () => api.get<Experiment[]>("/api/experiments") });
  const detail = useQuery({ queryKey: ["pipeline", pipelineId], queryFn: () => api.get<PipelineDetail>(`/api/pipelines/${pipelineId}`), enabled: !!pipelineId });
  const schema = useQuery({ queryKey: ["schema", pipelineId, versionId || undefined], queryFn: () => api.get<FormSchema>(`/api/pipeline-schemas/${pipelineId}${qs({ version_id: versionId || undefined })}`), enabled: !!pipelineId });
  const presets = useQuery({ queryKey: ["presets", pipelineId], queryFn: () => api.get<Preset[]>(`/api/pipelines/${pipelineId}/presets`), enabled: !!pipelineId });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => api.get<ClusterNode[]>("/api/nodes") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ ui: { default_output_dir?: string } ; data_roots: { name: string; writable: boolean }[] }>("/api/settings") });
  const validation = useQuery({
    queryKey: ["exp-validate", experimentId, pipelineId, versionId],
    queryFn: () => api.post<{ valid: boolean; errors: number; warnings: number; issues: Issue[] }>(`/api/experiments/${experimentId}/validate`, { pipeline_id: pipelineId, version_id: versionId || null }),
    enabled: !!experimentId && !!pipelineId,
  });
  const placement = useQuery({
    queryKey: ["placement", experimentId, nodeIds],
    queryFn: () => api.post<Placement>("/api/allocations/placement", { experiment_id: experimentId || null, node_ids: nodeIds }),
  });

  useEffect(() => {  // accept a slug in ?pipeline=
    const m = pipelines.data?.find((p) => p.slug === pipelineId);
    if (m) setPipelineId(m.id);
  }, [pipelines.data, pipelineId]);
  const controller = nodes.data?.find((n) => n.is_controller);
  const capC = controller?.allocation?.max_cpus ?? 1;
  const capM = controller?.allocation?.max_memory_gb ?? 1;
  useEffect(() => { if (controller && !cpus) { setCpus(capC); setMem(capM); } }, [controller, capC, capM, cpus]);
  useEffect(() => { if (schema.data) { setParams(schema.data.defaults); setServerIssues([]); } }, [schema.data]);
  useEffect(() => {
    const avail = detail.data?.runnable.filter((r) => r.available) ?? [];
    if (detail.data && !avail.some((a) => a.engine === engine)) setEngine(avail[0]?.engine ?? "");
  }, [detail.data, engine]);
  useEffect(() => {
    if (!outdir && settings.data) {
      const w = settings.data.data_roots.find((r) => r.writable);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      if (settings.data.ui.default_output_dir) setOutdir(`${settings.data.ui.default_output_dir}/${stamp}`);
      else if (w) setOutdir(`${w.name}:runs/${stamp}`);
    }
  }, [settings.data, outdir]);

  const groups = schema.data?.form.groups ?? [];
  const clientErrors = useMemo(() => formErrors(groups, params, ["input", "outdir"]), [groups, params]);
  const exp = experiments.data?.find((e) => e.id === experimentId);
  const needsSamples = !!schema.data?.form.groups.some((g) => g.fields.some((f) => f.name === "input" && f.required));
  const ready = !!pipelineId && !!engine && !!outdir && Object.keys(clientErrors).length === 0 && (!needsSamples || !!experimentId) && (!experimentId || validation.data?.valid !== false);
  const multiNode = nodeIds.length > 1 || (nodeIds.length === 1 && nodeIds[0] !== controller?.id);

  const body = (dry: boolean) => ({
    pipeline_id: pipelineId, version_id: versionId || null, engine, name: name || null, params, output_dir: outdir,
    experiment_id: experimentId || null, node_ids: nodeIds, dry_run: dry,
    resources: { max_cpus: cpus, max_memory_gb: mem, profile: profile || undefined },
  });
  const launch = useMutation({
    mutationFn: (dry: boolean) => api.post<RunDetail>("/api/runs", body(dry)),
    onSuccess: (r, dry) => {
      setServerIssues([]);
      if (dry) toast.success("Validation passed: parameters, samplesheet and placement are ready");
      else { toast.success(`Launched ${r.name}`); nav(`/runs/${r.id}`); }
    },
    onError: (e) => {
      if (e instanceof ApiError && e.issues.length) { setServerIssues(e.issues as Issue[]); toast.error("Validation failed; see the issues below"); }
      else toast.error(errMsg(e));
    },
  });
  const serverByField = Object.fromEntries(serverIssues.filter((i) => i.field).map((i) => [i.field!, i.message]));
  const runnable = (pipelines.data ?? []).filter((p) => p.kind !== "template");

  return (
    <>
      <PageHeader title="Launch analysis" description="Choose a pipeline and an experiment, adjust parameters and resources, then launch. Runs continue on the controller after you close the browser." />
      <div className="grid gap-8 xl:grid-cols-[1fr_320px]">
        <div className="space-y-10 min-w-0">
          <Step n={1} title="Pipeline" done={!!pipelineId && !!engine}>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Pipeline" className="sm:col-span-2">
                <Select value={pipelineId} onChange={(e) => { setPipelineId(e.target.value); setVersionId(""); }}>
                  <option value="">Choose an installed pipeline</option>
                  {runnable.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.category})</option>)}
                </Select>
              </Field>
              <Field label="Version">
                <Select value={versionId} onChange={(e) => setVersionId(e.target.value)} disabled={!detail.data}>
                  <option value="">Pinned / latest</option>
                  {detail.data?.versions.map((v) => <option key={v.id} value={v.id}>{v.version}{v.git_commit ? ` (${v.git_commit.slice(0, 7)})` : ""}</option>)}
                </Select>
              </Field>
            </div>
            {detail.data && (
              <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Execution engine">
                {detail.data.runnable.map((r) => (
                  <button key={r.engine} role="radio" aria-checked={engine === r.engine} disabled={!r.available} onClick={() => setEngine(r.engine)}
                    className={cn("rounded-md border px-3 py-2 text-left text-[13px] disabled:opacity-50", engine === r.engine ? "border-accent bg-accent/10" : "border-line hover:bg-raised")}>
                    <span className="font-medium">{r.engine === "nextflow" ? "Nextflow" : "BioCompute native engine"}</span>
                    <span className="block text-xs text-muted">{r.available ? r.detail : r.engine === "nextflow" ? "Nextflow is not installed on the controller" : "disabled"}</span>
                  </button>
                ))}
                {detail.data.runnable.every((r) => !r.available) && <p className="text-[13px] text-bad">No engine available for this pipeline. Install Nextflow on the controller (see Settings).</p>}
              </div>
            )}
          </Step>

          <Step n={2} title="Experiment" done={!!experimentId && validation.data?.valid} description="Samples, conditions and files. BioCompute writes the pipeline's samplesheet from it.">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Experiment" className="w-96 max-w-full">
                <Select value={experimentId} onChange={(e) => setExperimentId(e.target.value)}>
                  <option value="">{needsSamples ? "Choose an experiment" : "None (pipeline needs no samplesheet)"}</option>
                  {experiments.data?.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.sample_count} samples, {e.assay})</option>)}
                </Select>
              </Field>
              <Button asChild variant="ghost"><Link to={experimentId ? `/experiments/${experimentId}` : "/experiments"}>{experimentId ? "Edit samples" : "Create an experiment"}</Link></Button>
            </div>
            {experimentId && pipelineId && (
              <div className="mt-3 rounded-md border border-line bg-surface px-4 py-3">
                {validation.isLoading ? <Skeleton className="h-5 w-64" /> : validation.data && (
                  <>
                    <p className={cn("flex items-center gap-2 text-[13.5px] font-medium", validation.data.valid ? "text-ok" : "text-bad")}>
                      {validation.data.valid ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}
                      {validation.data.valid ? `${exp?.sample_count} samples match this pipeline's samplesheet schema` : `${validation.data.errors} problem${validation.data.errors === 1 ? "" : "s"} to fix before launching`}
                      {validation.data.warnings > 0 && <Badge tone="wait">{validation.data.warnings} warning{validation.data.warnings === 1 ? "" : "s"}</Badge>}
                    </p>
                    <IssueList issues={validation.data.issues.slice(0, 12)} className="mt-2" />
                  </>
                )}
              </div>
            )}
          </Step>

          <Step n={3} title="Parameters" done={!!schema.data && Object.keys(clientErrors).length === 0} description={schema.data?.form.has_schema ? "Generated from the pipeline's nextflow_schema.json." : undefined}>
            {!pipelineId && <p className="text-[13px] text-muted">Choose a pipeline first.</p>}
            {schema.isLoading && <Skeleton className="h-48" />}
            {schema.data && (
              <>
                {(presets.data?.length ?? 0) > 0 && (
                  <div className="mb-3 flex items-center gap-2 text-[13px]">
                    <span className="text-muted">Load preset</span>
                    {presets.data!.map((p) => <Button key={p.id} size="sm" variant="secondary" onClick={() => setParams({ ...schema.data!.defaults, ...p.params })}>{p.name}</Button>)}
                  </div>
                )}
                {schema.data.form.has_schema
                  ? <SchemaForm groups={groups} params={params} defaults={schema.data.defaults} onChange={setParams} serverIssues={serverByField} compact
                      managed={[{ name: "input", note: exp ? `Samplesheet generated from "${exp.name}"` : "Generated from the selected experiment" }, { name: "outdir", note: "Set in step 4" }]} />
                  : <p className="text-[13px] text-muted">No schema: parameters can be set on the pipeline page with the generic editor or the schema wizard.</p>}
              </>
            )}
          </Step>

          <Step n={4} title="Execution" done={!!outdir}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Output folder" required hint="A writable data root. Results and provenance are written here." className="sm:col-span-2">
                <PathInput mode="dir" value={outdir} onChange={setOutdir} writableOnly />
              </Field>
              <Field label="Run name" hint="Optional; defaults to pipeline and timestamp"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Software profile" hint={engine === "nextflow" ? "Nextflow -profile" : "Only used by Nextflow"}>
                <Select value={profile} onChange={(e) => setProfile(e.target.value)} disabled={engine !== "nextflow"}>
                  <option value="">None (tools on PATH)</option>
                  {(schema.data?.profiles ?? []).map((p) => <option key={p}>{p}</option>)}
                </Select>
              </Field>
              <Field label={`CPU cores for this run: ${cpus} (controller allocation ${capC})`}>
                <Slider min={1} max={capC} value={[Math.min(cpus || capC, capC)]} onValueChange={([v]) => setCpus(v)} aria-label="CPU cores" />
              </Field>
              <Field label={`Memory for this run: ${mem} GB (allocation ${capM} GB)`}>
                <Slider min={1} max={Math.max(1, Math.floor(capM))} value={[Math.min(mem || capM, capM)]} onValueChange={([v]) => setMem(v)} aria-label="Memory" />
              </Field>
            </div>
            <p className="mt-2 text-xs text-muted">These are scheduler limits passed to the engine (Nextflow executor.cpus / executor.memory and process resourceLimits). They are not enforced by the operating system.</p>
            <NodePicker placement={placement.data} nodes={nodes.data ?? []} selected={nodeIds} onChange={setNodeIds} />
          </Step>
        </div>

        <aside className="xl:sticky xl:top-6 self-start space-y-4">
          <Panel className="p-4 space-y-3">
            <p className="font-semibold">Summary</p>
            <dl className="space-y-1.5 text-[13px]">
              <Row k="Pipeline" v={detail.data?.name} />
              <Row k="Engine" v={engine === "bcflow" ? "native engine" : engine || null} />
              <Row k="Experiment" v={exp ? `${exp.name}, ${exp.sample_count} samples` : null} />
              <Row k="Input data" v={placement.data ? `${bytes(placement.data.input_bytes)}${placement.data.restricted ? ", restricted" : ""}` : null} />
              <Row k="Placement" v={multiNode ? `HTCondor on ${nodeIds.length} node(s)` : "controller (data-local)"} />
              <Row k="Resources" v={`${cpus} cores, ${mem} GB`} />
              <Row k="Output" v={outdir} mono />
            </dl>
            {Object.keys(clientErrors).length > 0 && <p className="text-xs text-bad">{Object.keys(clientErrors).length} parameter{Object.keys(clientErrors).length === 1 ? "" : "s"} need attention: {Object.keys(clientErrors).join(", ")}</p>}
            {serverIssues.length > 0 && <IssueList issues={serverIssues} />}
            <div className="flex gap-2 pt-1">
              <Button variant="secondary" className="flex-1" disabled={!pipelineId || !engine || !outdir} loading={launch.isPending && launch.variables === true} onClick={() => launch.mutate(true)}><ShieldCheck />Validate</Button>
              <Button variant="primary" className="flex-1" disabled={!ready} loading={launch.isPending && launch.variables === false} onClick={() => launch.mutate(false)}><Rocket />Launch</Button>
            </div>
            <p className="text-[11.5px] text-muted">Validate runs every check the launch does (schema, samplesheet, file existence, placement) without starting anything.</p>
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
  return (
    <div className="mt-5">
      <div className="flex items-center gap-2">
        <p className="text-[13.5px] font-medium">Execution nodes</p>
        {placement.restricted && <Badge tone="wait"><Lock className="size-3" />Restricted inputs stay on the lab site</Badge>}
      </div>
      <p className="text-xs text-muted mt-0.5 mb-2">Leave all unchecked for data-local execution on the controller (recommended). Selecting other nodes uses Nextflow's HTCondor executor, which needs a filesystem shared by those nodes.</p>
      <div className="rounded-md border border-line divide-y divide-line/60">
        {placement.candidates.map((c) => {
          const n = nodes.find((x) => x.id === c.node_id);
          return (
            <label key={c.node_id} className={cn("flex items-start gap-3 px-3 py-2.5 text-[13px]", !c.eligible && !selected.includes(c.node_id) ? "opacity-60" : "cursor-pointer")}>
              <Checkbox className="mt-0.5" checked={selected.includes(c.node_id)} onCheckedChange={() => toggle(c.node_id)} disabled={!c.eligible && !selected.includes(c.node_id)} />
              <Server className={cn("mt-0.5 size-4", c.is_controller ? "text-accent" : "text-muted")} />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{c.hostname}</span>
                {placement.recommended?.node_id === c.node_id && <Badge tone="accent" className="ml-2">Recommended</Badge>}
                <span className="block text-xs text-muted">
                  {c.eligible ? `${c.cpus} cores, ${c.memory_gb} GB allocated${c.transfer_seconds ? `, about ${Math.round(c.transfer_seconds / 60)} min to stage inputs` : ""}` : c.reasons.join("; ")}
                </span>
              </span>
              <span className="text-xs text-muted tabular-nums inline-flex items-center gap-1"><Cpu className="size-3" />{n?.utilization.cpu_percent?.toFixed(0) ?? "—"}%</span>
            </label>
          );
        })}
      </div>
      {est && est.additional_cores > 0 && (
        <p className={cn("mt-2 text-xs", est.worthwhile ? "text-ok" : "text-muted")}>
          Recruiting the other {est.additional_cores} eligible cores would give an estimated {est.speedup_if_recruited}x speed-up{est.worthwhile ? "." : ", probably not worth the data movement."} <span className="text-muted">({est.assumptions})</span>
        </p>
      )}
    </div>
  );
}
