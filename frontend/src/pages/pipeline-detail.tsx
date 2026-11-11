import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Download, FileDiff, GitBranch, Pin, Play, Plus, Save, Star, Trash2, Wand2 } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { FormSchema, PipelineDetail, Preset } from "@/lib/types";
import { ago, cn, download, when } from "@/lib/utils";
import { KV, PageHeader } from "@/components/page";
import { Badge, Empty, Panel, PanelHeader, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { GenericParamEditor, SchemaForm, type Params } from "@/components/schema-form";
import { RunStatusBadge } from "@/components/status";
import { ShareButton, SharingBadge, type Visibility } from "@/components/sharing";

const PipelineMap = lazy(() => import("@/components/pipeline-map"));

export default function PipelineDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const p = useQuery({ queryKey: ["pipeline", id], queryFn: () => api.get<PipelineDetail>(`/api/pipelines/${id}`) });
  const [versionId, setVersionId] = useState<string | undefined>();
  const schema = useQuery({
    queryKey: ["schema", id, versionId], enabled: !!p.data && p.data.kind !== "template",
    queryFn: () => api.get<FormSchema>(`/api/pipeline-schemas/${id}${qs({ version_id: versionId })}`),
  });
  const presets = useQuery({ queryKey: ["presets", id], queryFn: () => api.get<Preset[]>(`/api/pipelines/${id}/presets`), enabled: !!p.data });
  const history = useQuery({ queryKey: ["history", id], queryFn: () => api.get<{ id: string; name: string; status: string; created_at: string; params: Params }[]>(`/api/pipelines/${id}/history`), enabled: !!p.data });
  const [params, setParams] = useState<Params>({});
  const [dupOpen, setDupOpen] = useState(false);
  const [tab, setTab] = useState("map");
  const [compare, setCompare] = useState<Preset | null>(null);

  useEffect(() => { if (schema.data) setParams(schema.data.defaults); }, [schema.data]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["pipeline", id] }); qc.invalidateQueries({ queryKey: ["pipelines"] }); };

  const savePreset = useMutation({
    mutationFn: (b: { name: string; description: string }) => api.post(`/api/pipelines/${id}/presets`, { ...b, params }),
    onSuccess: () => { toast.success("Preset saved"); qc.invalidateQueries({ queryKey: ["presets", id] }); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const delPreset = useMutation({ mutationFn: (pid: string) => api.del(`/api/pipelines/${id}/presets/${pid}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["presets", id] }) });
  const pin = useMutation({ mutationFn: (vid: string) => api.post(`/api/pipeline-versions/${vid}/pin`), onSuccess: () => { toast.success("Version pinned"); refresh(); } });
  const del = useMutation({ mutationFn: () => api.del(`/api/pipelines/${id}`), onSuccess: () => { refresh(); nav("/pipelines"); }, onError: (e) => toast.error(errMsg(e)) });
  const fav = useMutation({ mutationFn: () => api.patch(`/api/pipelines/${id}`, { favorite: !p.data?.favorite }), onSuccess: refresh });
  const share = useMutation({
    // a pipeline built in Studio follows its workflow (which also shares the modules it uses)
    mutationFn: (v: Visibility) => p.data?.studio_workflow_id
      ? api.put(`/api/studio/workflows/${p.data.studio_workflow_id}/visibility`, { visibility: v })
      : api.patch(`/api/pipelines/${id}`, { visibility: v }),
    onSuccess: (_r, v) => { refresh(); qc.invalidateQueries({ queryKey: ["pipelines"] }); toast.success(v === "lab" ? "Shared with the lab" : "Now private"); },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (p.isLoading) return <Skeleton className="h-96" />;
  if (!p.data) return <Empty title="Pipeline not found" action={<Button asChild><Link to="/pipelines">Back to library</Link></Button>} />;
  const d = p.data;
  const isTemplate = d.kind === "template";
  const sci = can(user, "scientist");

  return (
    <>
      <PageHeader title={<span className="flex items-center gap-2">{d.name}
        <button onClick={() => fav.mutate()} aria-label="Toggle favorite" className="text-muted hover:text-wait"><Star className={cn("size-5", d.favorite && "fill-wait text-wait")} /></button></span>}
        description={d.description}
        actions={!isTemplate && <>
          {d.can_edit && d.owner && <ShareButton visibility={d.visibility} onChange={(v) => share.mutate(v)} loading={share.isPending} size="md" />}
          {sci && <Button variant="ghost" onClick={() => setDupOpen(true)}><Copy />{d.can_edit ? "Duplicate" : "Make my own copy"}</Button>}
          {d.can_edit && <Button variant="ghost" onClick={() => confirm(`Delete ${d.name}? Pipelines with run history cannot be deleted.`) && del.mutate()}><Trash2 />Delete</Button>}
          <Button asChild variant="primary"><Link to={`/jobs/new?pipeline=${d.id}${versionId ? `&version=${versionId}` : ""}`}><Play />Configure and run</Link></Button>
        </>}>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge>{d.category}</Badge>
          <SharingBadge owner={d.owner} visibility={d.visibility} />
          <Badge tone={isTemplate ? "wait" : "ok"}>{isTemplate ? "Catalog template, not installed" : d.kind === "studio" ? "Built in Pipeline Studio" : "Installed"}</Badge>
          {d.runnable.map((r) => <Badge key={r.engine} tone={r.available ? "accent" : "neutral"} title={r.detail}>{r.engine === "bcflow" ? "native engine" : r.engine}{r.available ? "" : " (unavailable)"}</Badge>)}
          {d.source_url && <a href={d.source_url.startsWith("http") ? d.source_url : undefined} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-text self-center ml-1 font-mono">{d.source_url}</a>}
        </div>
      </PageHeader>

      {isTemplate ? (
        <Panel><Empty title="Not installed on this controller" action={<Button asChild variant="primary"><Link to="/pipelines">Install from the library</Link></Button>}>
          BioCompute only shows parameters for pipelines that exist locally. Install it to read its schema and run it.
        </Empty></Panel>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-5">
            <TabsTrigger value="map">Map</TabsTrigger>
            <TabsTrigger value="params">Parameters</TabsTrigger>
            <TabsTrigger value="io">Inputs and outputs</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
            <TabsTrigger value="history">Execution history <span className="ml-1 text-xs text-muted">{d.run_count}</span></TabsTrigger>
            {d.readme && <TabsTrigger value="readme">Readme</TabsTrigger>}
          </TabsList>
          <TabsContent value="map">
            {d.versions.length > 1 && (
              <div className="mb-3 flex items-center gap-2 text-[13px]">
                <span className="text-muted">Version</span>
                <Select className="h-8 w-auto" aria-label="Version shown on the map" value={versionId ?? d.latest_version?.id ?? ""} onChange={(e) => setVersionId(e.target.value)}>
                  {[...d.versions].reverse().map((v) => <option key={v.id} value={v.id}>{v.version}{v.id === d.latest_version?.id ? " (current)" : ""} · {when(v.created_at)}</option>)}
                </Select>
              </div>
            )}
            <Suspense fallback={<Skeleton className="h-[560px]" />}>
              <PipelineMap pid={d.id} versionId={versionId} canCopy={sci} onCopy={() => setDupOpen(true)} />
            </Suspense>
          </TabsContent>
          <TabsContent value="params">
            <div className="grid gap-5 xl:grid-cols-[1fr_300px]">
              <div className="min-w-0">
                {schema.isLoading && <Skeleton className="h-64" />}
                {schema.data && (schema.data.form.has_schema ? (
                  <SchemaForm groups={schema.data.form.groups} params={params} defaults={schema.data.defaults} onChange={setParams}
                    managed={[{ name: "input", note: "Generated from the experiment you choose at launch" }, { name: "outdir", note: "Chosen at launch" }]} />
                ) : <NoSchema pipelineId={d.id} versionId={schema.data.version_id} params={params} setParams={setParams} onDone={() => qc.invalidateQueries({ queryKey: ["schema", id] })} />)}
              </div>
              <aside className="space-y-4">
                <Panel>
                  <PanelHeader title="Parameter presets" description="Saved configurations for this pipeline" />
                  <div className="divide-y divide-line/60">
                    {presets.data?.length === 0 && <p className="px-4 py-3 text-[13px] text-muted">No presets yet.</p>}
                    {presets.data?.map((pr) => (
                      <div key={pr.id} className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="flex-1 truncate text-[13.5px] font-medium">{pr.name}</span>
                          <span className="text-[11px] text-muted">{ago(pr.created_at)}</span>
                        </div>
                        <div className="mt-1.5 flex gap-1">
                          <Button size="sm" variant="secondary" onClick={() => { setParams({ ...schema.data?.defaults, ...pr.params }); toast.success(`Loaded ${pr.name}`); }}>Load</Button>
                          <Button size="sm" variant="ghost" onClick={() => setCompare(pr)}><FileDiff />Compare</Button>
                          {sci && (d.can_edit || pr.created_by === user?.username) && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => delPreset.mutate(pr.id)} aria-label={`Delete ${pr.name}`}><Trash2 /></Button>}
                        </div>
                      </div>
                    ))}
                  </div>
                  {sci && <SavePresetForm onSave={(b) => savePreset.mutate(b)} busy={savePreset.isPending} />}
                </Panel>
                <Panel className="p-4 space-y-2">
                  <Button className="w-full" variant="secondary" onClick={() => schema.data && setParams(schema.data.defaults)}>Restore all defaults</Button>
                  <div className="flex gap-2">
                    <ExportButton pid={d.id} params={params} fmt="json" />
                    <ExportButton pid={d.id} params={params} fmt="yaml" />
                  </div>
                  <p className="text-xs text-muted">Exports a Nextflow <code className="font-mono">-params-file</code> with the values above.</p>
                </Panel>
              </aside>
            </div>
          </TabsContent>
          <TabsContent value="io">
            <div className="grid gap-5 lg:grid-cols-2">
              <Panel>
                <PanelHeader title="Samplesheet columns" description="From assets/schema_input.json. BioCompute builds this file from your experiment." />
                {d.input_columns.length === 0 ? <p className="p-4 text-[13px] text-muted">This pipeline does not declare a samplesheet schema. A default sample, fastq_1, fastq_2, condition, replicate sheet is generated.</p> : (
                  <table className="w-full text-[13px]">
                    <thead><tr className="text-left text-xs text-muted border-b border-line"><th className="px-4 py-2 font-medium">Column</th><th className="px-2 py-2 font-medium">Type</th><th className="px-4 py-2 font-medium">Rule</th></tr></thead>
                    <tbody>{d.input_columns.map((c) => (
                      <tr key={c.name} className="border-b border-line/50 last:border-0 align-top">
                        <td className="px-4 py-2 font-mono text-[12px]">{c.name}{c.required && <span className="text-bad"> *</span>}</td>
                        <td className="px-2 py-2 text-muted">{c.types.join(" | ")}{c.format ? `, ${c.format}` : ""}</td>
                        <td className="px-4 py-2 text-muted text-xs">{c.description || c.pattern || "—"}</td>
                      </tr>))}</tbody>
                  </table>)}
              </Panel>
              <Panel>
                <PanelHeader title="Main outputs" />
                <div className="p-4 space-y-2 text-[13px]">
                  {(d.latest_version?.outputs ?? []).length === 0 && <p className="text-muted">Not documented by the pipeline.</p>}
                  {d.latest_version?.outputs.map((o) => <p key={o.name}><span className="font-medium">{o.name}</span>{o.path && <span className="font-mono text-[12px] text-muted"> {o.path}/</span>}{o.description && <span className="block text-xs text-muted">{o.description}</span>}</p>)}
                </div>
                <PanelHeader title="Software environments" className="border-t" />
                <div className="p-4 flex flex-wrap gap-1.5">
                  {(d.latest_version?.software ?? []).length ? d.latest_version!.software.map((s) => <Badge key={s}>{s}</Badge>) : <span className="text-[13px] text-muted">No container or conda profiles declared; tools must be on PATH.</span>}
                </div>
                {Array.isArray(d.manifest.profiles) && (d.manifest.profiles as string[]).length > 0 && (
                  <><PanelHeader title="Profiles" className="border-t" /><div className="p-4 flex flex-wrap gap-1.5">{(d.manifest.profiles as string[]).map((s) => <Badge key={s}>{s}</Badge>)}</div></>
                )}
              </Panel>
            </div>
          </TabsContent>
          <TabsContent value="versions">
            <Panel className="divide-y divide-line/60">
              {d.versions.map((v) => (
                <div key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <GitBranch className="size-4 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-[13.5px]">{v.version} {v.pinned && <Badge tone="accent" className="ml-1">Pinned</Badge>}</p>
                    <p className="font-mono text-[11.5px] text-muted truncate">{v.git_commit ?? "not a git checkout"} {v.path}</p>
                  </div>
                  <span className="text-xs text-muted">{when(v.created_at)}</span>
                  <Button size="sm" variant="secondary" onClick={() => { setVersionId(v.id); setTab("map"); }}>Map</Button>
                  <Button size="sm" variant={versionId === v.id ? "primary" : "secondary"} onClick={() => { setVersionId(v.id); setTab("params"); }}>Parameters</Button>
                  {sci && !v.pinned && <Button size="sm" variant="ghost" onClick={() => pin.mutate(v.id)}><Pin />Pin</Button>}
                </div>
              ))}
              {sci && (d.source_type === "git" || d.source_type === "nf-core") && <FetchVersion pid={d.id} url={d.source_url ?? ""} onDone={refresh} />}
            </Panel>
          </TabsContent>
          <TabsContent value="history">
            <Panel>
              {history.data?.length === 0 && <Empty title="Never run" action={<Button asChild variant="primary"><Link to={`/jobs/new?pipeline=${d.id}`}>Run it now</Link></Button>} />}
              <div className="divide-y divide-line/60">
                {history.data?.map((h) => (
                  <div key={h.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    <Link to={`/runs/${h.id}`} className="flex-1 truncate hover:underline">{h.name}</Link>
                    <span className="text-xs text-muted">{when(h.created_at)}</span>
                    <RunStatusBadge status={h.status} />
                    <Button size="sm" variant="ghost" onClick={() => { setParams(h.params); toast.success("Loaded parameters from this run (Parameters tab)"); }}>Reuse parameters</Button>
                  </div>
                ))}
              </div>
            </Panel>
          </TabsContent>
          {d.readme && (
            <TabsContent value="readme">
              <Panel className="p-5"><pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed max-w-[80ch]">{d.readme}</pre></Panel>
            </TabsContent>
          )}
        </Tabs>
      )}
      <DuplicateDialog open={dupOpen} onOpenChange={setDupOpen} pid={d.id} name={d.name} />
      {compare && <CompareDialog preset={compare} current={params} defaults={schema.data?.defaults ?? {}} onClose={() => setCompare(null)} />}
    </>
  );
}

function SavePresetForm({ onSave, busy }: { onSave: (b: { name: string; description: string }) => void; busy: boolean }) {
  const [name, setName] = useState("");
  return (
    <form className="flex gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); if (name) { onSave({ name, description: "" }); setName(""); } }}>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Preset name" aria-label="Preset name" />
      <Button type="submit" loading={busy} disabled={!name}><Save />Save</Button>
    </form>
  );
}

function ExportButton({ pid, params, fmt }: { pid: string; params: Params; fmt: "json" | "yaml" }) {
  return (
    <Button className="flex-1" variant="ghost" onClick={async () => {
      try {
        const txt = await api.post<string>(`/api/pipeline-schemas/${pid}/export?fmt=${fmt}`, { params });
        download(`params.${fmt}`, typeof txt === "string" ? txt : JSON.stringify(txt, null, 2));
      } catch (e) { toast.error(errMsg(e)); }
    }}><Download />{fmt.toUpperCase()}</Button>
  );
}

function CompareDialog({ preset, current, defaults, onClose }: { preset: Preset; current: Params; defaults: Params; onClose: () => void }) {
  const keys = useMemo(() => [...new Set([...Object.keys(preset.params), ...Object.keys(current)])].sort(), [preset, current]);
  const fmt = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v));
  const rows = keys.map((k) => ({ k, a: current[k] ?? defaults[k], b: preset.params[k] ?? defaults[k] })).filter((r) => fmt(r.a) !== fmt(r.b));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide title={`Compare with "${preset.name}"`} description="Only parameters that differ are shown.">
        {rows.length === 0 ? <p className="text-[13px] text-muted">The current form matches this preset.</p> : (
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-xs text-muted border-b border-line"><th className="py-1.5 font-medium">Parameter</th><th className="font-medium">Current form</th><th className="font-medium">{preset.name}</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.k} className="border-b border-line/50"><td className="py-1.5 font-mono text-[12px]">{r.k}</td><td className="text-accent font-mono text-[12px]">{fmt(r.a)}</td><td className="text-wait font-mono text-[12px]">{fmt(r.b)}</td></tr>)}</tbody>
          </table>)}
      </DialogContent>
    </Dialog>
  );
}

function DuplicateDialog({ open, onOpenChange, pid, name }: { open: boolean; onOpenChange: (o: boolean) => void; pid: string; name: string }) {
  const nav = useNavigate();
  const [n, setN] = useState(`${name} copy`);
  const dup = useMutation({ mutationFn: () => api.post<{ id: string }>(`/api/pipelines/${pid}/duplicate`, { name: n }), onSuccess: (r) => { onOpenChange(false); nav(`/pipelines/${r.id}`); }, onError: (e) => toast.error(errMsg(e)) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Duplicate pipeline" description="Copies the pipeline files into the managed store, together with its presets, so you can modify them independently.">
        <Field label="New name"><Input value={n} onChange={(e) => setN(e.target.value)} /></Field>
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={dup.isPending} onClick={() => dup.mutate()}>Duplicate</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FetchVersion({ pid, url, onDone }: { pid: string; url: string; onDone: () => void }) {
  const [ref, setRef] = useState("");
  const m = useMutation({ mutationFn: () => api.post(`/api/pipelines/${pid}/versions/update`, { url, ref }), onSuccess: () => { toast.success("Version added"); setRef(""); onDone(); }, onError: (e) => toast.error(errMsg(e)) });
  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="tag, branch or commit" className="max-w-56" aria-label="Git ref" />
      <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!ref}><Plus />Fetch version</Button>
    </div>
  );
}

function NoSchema({ pipelineId, versionId, params, setParams, onDone }: { pipelineId: string; versionId: string; params: Params; setParams: (p: Params) => void; onDone: () => void }) {
  const [wizard, setWizard] = useState<{ name: string; type: string; default: string; description: string; required: boolean }[]>([
    { name: "", type: "string", default: "", description: "", required: false },
  ]);
  const save = useMutation({
    mutationFn: (write: boolean) => api.post(`/api/pipeline-schemas/${pipelineId}/author`, {
      version_id: versionId, write_to_pipeline: write,
      fields: wizard.filter((w) => w.name).map((w) => ({ ...w, default: w.default === "" ? undefined : w.type === "integer" ? parseInt(w.default) : w.type === "number" ? parseFloat(w.default) : w.type === "boolean" ? w.default === "true" : w.default })),
    }),
    onSuccess: () => { toast.success("Schema saved"); onDone(); }, onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="space-y-5">
      <Panel className="p-4">
        <p className="font-medium">This pipeline has no nextflow_schema.json</p>
        <p className="text-[13px] text-muted mt-1">Set parameters with the generic editor below, or describe them once with the schema wizard so BioCompute can build a validated form.</p>
        <div className="mt-4"><GenericParamEditor params={params} onChange={setParams} /></div>
      </Panel>
      <Panel>
        <PanelHeader title={<span className="flex items-center gap-2"><Wand2 className="size-4 text-accent" />Schema wizard</span>} description="Creates a draft 2020-12 nf-schema compatible definition." />
        <div className="p-4 space-y-2">
          {wizard.map((w, i) => (
            <div key={i} className="grid grid-cols-[1fr_110px_1fr_1.5fr_auto] gap-2 items-center">
              <Input placeholder="name" value={w.name} className="font-mono text-[12px]" onChange={(e) => setWizard(wizard.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/\W/g, "_") } : x)))} />
              <Select value={w.type} onChange={(e) => setWizard(wizard.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                {["string", "integer", "number", "boolean"].map((t) => <option key={t}>{t}</option>)}
              </Select>
              <Input placeholder="default" value={w.default} onChange={(e) => setWizard(wizard.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)))} />
              <Input placeholder="description" value={w.description} onChange={(e) => setWizard(wizard.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              <label className="flex items-center gap-1 text-xs text-muted"><input type="checkbox" checked={w.required} onChange={(e) => setWizard(wizard.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />required</label>
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <Button variant="ghost" onClick={() => setWizard([...wizard, { name: "", type: "string", default: "", description: "", required: false }])}><Plus />Add parameter</Button>
            <Button className="ml-auto" onClick={() => save.mutate(false)} loading={save.isPending}>Save to BioCompute only</Button>
            <Button variant="primary" onClick={() => save.mutate(true)} loading={save.isPending}>Save and write nextflow_schema.json</Button>
          </div>
          <KV k="Note" v="Writing the file is only allowed for pipelines in BioCompute's managed store." />
        </div>
      </Panel>
    </div>
  );
}
