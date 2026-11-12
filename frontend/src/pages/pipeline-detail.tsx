import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, FileDiff, GitBranch, GitFork, Pin, Play, Plus, Save, Star, Trash2, Wand2 } from "lucide-react";
import { api, ApiError, errMsg, qs } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import { setLaunchPrefill } from "@/lib/handoff";
import type { FormSchema, PipelineDetail, Preset } from "@/lib/types";
import { cn, download, when } from "@/lib/utils";
import { Ago, KV, PageHeader, QueryError, usePageTitle } from "@/components/page";
import { Badge, Empty, Panel, PanelHeader, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { GenericParamEditor, SchemaForm, type Params } from "@/components/schema-form";
import { RunStatusBadge } from "@/components/status";
import { ShareButton, SharingBadge, type Visibility } from "@/components/sharing";
import { ForkDialog } from "@/components/fork-dialog";
import { DETAIL_TABS, PipelineTabs, pipelineTabHref, VersionSelect, type DetailTab } from "@/components/pipeline-tabs";
import { ImportDialog } from "@/pages/pipelines";

/** Filled in by BioCompute at launch, so never part of "edited parameters". */
const MANAGED = ["input", "outdir"];
const blank = (v: unknown) => v === undefined || v === null || v === "";
const sameValue = (a: unknown, b: unknown) => (blank(a) && blank(b)) || JSON.stringify(a) === JSON.stringify(b);
interface HistoryRun { id: string; name: string; status: string; created_at: string; params: Params }

export default function PipelineDetailPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const [sp, setSp] = useSearchParams();
  const p = useQuery({ queryKey: ["pipeline", id], queryFn: () => api.get<PipelineDetail>(`/api/pipelines/${id}`) });
  usePageTitle(p.data?.name, [{ label: "Pipelines", to: "/pipelines" }]);
  // the tab and the version live in the URL, so Back and links from the Map and Code pages land on the right place
  const versionId = sp.get("version") ?? undefined;
  const wanted = sp.get("tab") ?? "params";
  const go = (patch: { tab?: DetailTab; version?: string | null }) => setSp((prev) => {
    const n = new URLSearchParams(prev);
    if (patch.tab) { if (patch.tab === "params") n.delete("tab"); else n.set("tab", patch.tab); }
    if (patch.version !== undefined) { if (patch.version) n.set("version", patch.version); else n.delete("version"); }
    return n;
  });
  const schema = useQuery({
    queryKey: ["schema", id, versionId], enabled: !!p.data && p.data.kind !== "template",
    queryFn: () => api.get<FormSchema>(`/api/pipeline-schemas/${id}${qs({ version_id: versionId })}`),
  });
  const presets = useQuery({ queryKey: ["presets", id], queryFn: () => api.get<Preset[]>(`/api/pipelines/${id}/presets`), enabled: !!p.data });
  const history = useQuery({ queryKey: ["history", id], queryFn: () => api.get<HistoryRun[]>(`/api/pipelines/${id}/history`), enabled: !!p.data });
  const [params, setParams] = useState<Params>({});
  // start from the defaults of the version shown (again when another version is chosen)
  const [seeded, setSeeded] = useState<FormSchema | null>(null);
  if (schema.data && schema.data !== seeded) { setSeeded(schema.data); setParams(schema.data.defaults); }
  const [forkOpen, setForkOpen] = useState(false);
  const [install, setInstall] = useState<null | { url?: string; name?: string; category?: string }>(null);
  const [compare, setCompare] = useState<Preset | null>(null);
  const edited = useMemo(() => {
    const dflt = schema.data?.defaults;
    if (!dflt) return false;
    return [...new Set([...Object.keys(params), ...Object.keys(dflt)])].some((k) => !MANAGED.includes(k) && !sameValue(params[k], dflt[k]));
  }, [params, schema.data]);

  const refresh = () => { qc.invalidateQueries({ queryKey: ["pipeline", id] }); qc.invalidateQueries({ queryKey: ["pipelines"] }); };

  const savePreset = useMutation({
    mutationFn: (b: { name: string; description: string }) => api.post(`/api/pipelines/${id}/presets`, { ...b, params }),
    onSuccess: () => { toast.success("Preset saved"); qc.invalidateQueries({ queryKey: ["presets", id] }); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const delPreset = useMutation({
    mutationFn: (pr: Preset) => api.del(`/api/pipelines/${id}/presets/${pr.id}`),
    onSuccess: (_r, pr) => { toast.success(`Deleted the preset “${pr.name}”`); qc.invalidateQueries({ queryKey: ["presets", id] }); refresh(); },
    onError: (e) => toast.error(`The preset was not deleted: ${errMsg(e)}`),
  });
  const pin = useMutation({
    mutationFn: (v: { id: string; version: string }) => api.post(`/api/pipeline-versions/${v.id}/pin`),
    onSuccess: (_r, v) => { toast.success(`${v.version} is now the default version: new runs use it`); refresh(); },
    onError: (e) => toast.error(`The default version was not changed: ${errMsg(e)}`),
  });
  const delVersion = useMutation({
    mutationFn: (v: { id: string; version: string }) => api.del(`/api/pipelines/${id}/versions/${v.id}`),
    onSuccess: (_r, v) => { toast.success(`Deleted version ${v.version}`); refresh(); },
    onError: (e) => toast.error(`The version was not deleted: ${errMsg(e)}`),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/pipelines/${id}`),
    onSuccess: () => { toast.success(`Deleted ${p.data?.name ?? "the pipeline"}`); refresh(); nav("/pipelines"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const fav = useMutation({
    mutationFn: () => api.patch(`/api/pipelines/${id}`, { favorite: !p.data?.favorite }),
    onSuccess: refresh,
    onError: (e) => toast.error(`Favorites were not changed: ${errMsg(e)}`),
  });
  const share = useMutation({
    // a pipeline built in Studio follows its workflow (which also shares the modules it uses)
    mutationFn: (v: Visibility) => p.data?.studio_workflow_id
      ? api.put(`/api/studio/workflows/${p.data.studio_workflow_id}/visibility`, { visibility: v })
      : api.patch(`/api/pipelines/${id}`, { visibility: v }),
    onSuccess: (_r, v) => { refresh(); qc.invalidateQueries({ queryKey: ["pipelines"] }); toast.success(v === "lab" ? "Shared with the lab" : "Now private"); },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (p.isLoading) return <Skeleton className="h-96" />;
  if (p.isError && !p.data) {
    return p.error instanceof ApiError && p.error.status === 404
      ? <Empty title="Pipeline not found" action={<Button asChild><Link to="/pipelines">All pipelines</Link></Button>}>It was deleted, or it is private to someone else.</Empty>
      : <QueryError error={p.error} onRetry={() => p.refetch()} what="this pipeline" />;
  }
  if (!p.data) return null;
  const d = p.data;
  const isTemplate = d.kind === "template";
  const sci = can(user, "scientist");
  const tab: DetailTab = (DETAIL_TABS as readonly string[]).includes(wanted) && (wanted !== "readme" || !!d.readme) ? (wanted as DetailTab) : "params";
  const ver = d.versions.find((v) => v.id === versionId) ?? d.latest_version;
  const launchVersion = versionId ?? schema.data?.version_id;
  const launchHref = `/jobs/new${qs({ pipeline: d.id, version: versionId })}`;

  const runWithParams = () => {
    const clean = Object.fromEntries(Object.entries(params).filter(([k]) => !MANAGED.includes(k)));
    setLaunchPrefill({ pipeline_id: d.id, version_id: launchVersion ?? null, params: clean, from: d.name });
    nav(`/jobs/new${qs({ pipeline: d.id, version: launchVersion })}`);
  };
  const switchVersion = async (vid: string | undefined) => {
    if (edited && !(await confirmDialog({
      title: "Show another version?", body: "The parameters you changed on this page start again from the defaults of the other version. Save them as a preset first if you want to keep them.",
      confirmLabel: "Switch version", cancelLabel: "Stay",
    }))) return;
    go({ version: vid ?? null });
  };
  const askDelete = async () => {
    if (await confirmDialog({
      title: `Delete “${d.name}”?`,
      body: "The pipeline, all its versions and its parameter presets are removed and cannot be restored. A pipeline that has runs cannot be deleted, so that those runs stay traceable.",
      confirmLabel: "Delete pipeline", danger: true,
    })) del.mutate();
  };
  const askDeletePreset = async (pr: Preset) => {
    if (await confirmDialog({ title: `Delete the preset “${pr.name}”?`, body: "The saved parameter values are removed for everyone who uses this pipeline. Runs that used them are not affected.", confirmLabel: "Delete preset", danger: true })) delPreset.mutate(pr);
  };

  return (
    <>
      <PageHeader title={<span className="flex items-center gap-2">{d.name}
        <button onClick={() => fav.mutate()} aria-label={d.favorite ? "Remove from favorites" : "Add to favorites"} aria-pressed={d.favorite} title={d.favorite ? "Remove from favorites" : "Add to favorites"}
          className="text-muted hover:text-wait"><Star className={cn("size-5", d.favorite && "fill-wait text-wait")} /></button></span>}
        description={d.description}
        actions={!isTemplate && <>
          {d.can_edit && d.owner && <ShareButton visibility={d.visibility} onChange={(v) => share.mutate(v)} loading={share.isPending} size="md" />}
          {sci && <Button variant="ghost" onClick={() => setForkOpen(true)} title="Your own copy of this version to change; this pipeline is never changed"><GitFork />Edit as new pipeline</Button>}
          {d.can_edit && <Button variant="ghost" loading={del.isPending} onClick={askDelete}><Trash2 />Delete</Button>}
          {edited
            ? <Button variant="primary" onClick={runWithParams} title="Opens the launch form with the parameter values you set on this page"><Play />Run with these parameters</Button>
            : <Button asChild variant="primary"><Link to={launchHref}><Play />Configure and run</Link></Button>}
        </>}>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {d.versions.length > 1 && ver && <VersionSelect d={d} value={ver.id} onChange={switchVersion} className="h-7 text-[12px]" />}
          {d.versions.length === 1 && ver && <Badge title="The only version of this pipeline">{ver.version}</Badge>}
          <Badge>{d.category}</Badge>
          <SharingBadge owner={d.owner} visibility={d.visibility} />
          <Badge tone={isTemplate ? "wait" : "ok"}>{isTemplate ? "Catalog entry, not installed" : d.kind === "studio" ? "Built in Pipeline Studio" : "Installed"}</Badge>
          {d.runnable.map((r) => <Badge key={r.engine} tone={r.available ? "accent" : "neutral"} title={r.detail}>{r.engine === "bcflow" ? "native engine" : r.engine}{r.available ? "" : " (unavailable)"}</Badge>)}
          {d.source_url && (d.source_url.startsWith("http")
            ? <a href={d.source_url} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-text self-center ml-1 font-mono">{d.source_url}</a>
            : <span className="text-xs text-muted self-center ml-1 font-mono">{d.source_url}</span>)}
        </div>
      </PageHeader>

      {isTemplate ? (
        <Panel>
          <Empty title="Not installed yet"
            action={sci ? <Button variant="primary" onClick={() => setInstall({ url: d.source_url ?? "", name: d.name.replace("/", "-"), category: d.category })}><Download />Install this pipeline</Button> : undefined}>
            This is a catalog entry: BioCompute knows where the pipeline is published but has not downloaded it.
            Installing copies it onto the controller (this needs network access to GitHub); after that you can see its parameters and run it.
            {!sci && " Ask a scientist or an administrator of your lab to install it."}
          </Empty>
          <ImportDialog init={install} onClose={() => setInstall(null)} onDone={(newId) => nav(`/pipelines/${newId}`)} />
        </Panel>
      ) : (
        <>
          <PipelineTabs className="mb-5 border-b border-line" pid={d.id} kind={d.kind} hasReadme={!!d.readme} runCount={d.run_count} active={tab} versionId={versionId} />
          {tab === "params" && (
            <div className="grid gap-5 xl:grid-cols-[1fr_300px]">
              <div className="min-w-0">
                {schema.isLoading && <Skeleton className="h-64" />}
                {schema.isError && <QueryError error={schema.error} onRetry={() => schema.refetch()} what="the parameters" />}
                {schema.data && (schema.data.form.has_schema ? (
                  <SchemaForm groups={schema.data.form.groups} params={params} defaults={schema.data.defaults} onChange={setParams}
                    managed={[{ name: "input", note: "Generated from the experiment you choose at launch" }, { name: "outdir", note: "Chosen at launch" }]} />
                ) : <NoSchema pipelineId={d.id} versionId={schema.data.version_id} params={params} setParams={setParams} onDone={() => qc.invalidateQueries({ queryKey: ["schema", id] })} />)}
              </div>
              <aside className="space-y-4">
                {edited && (
                  <Panel className="space-y-2 border-accent/40 p-4">
                    <p className="text-[13px]">You changed parameters on this page. They are only used when you start a run from here.</p>
                    <Button className="w-full" variant="primary" onClick={runWithParams}><Play />Run with these parameters</Button>
                  </Panel>
                )}
                <Panel>
                  <PanelHeader title="Parameter presets" description="Saved parameter values for this pipeline" />
                  <div className="divide-y divide-line/60">
                    {presets.isError && <p className="px-4 py-3 text-[13px] text-bad">Could not load the presets: {errMsg(presets.error)} <button className="underline" onClick={() => presets.refetch()}>Try again</button></p>}
                    {presets.data?.length === 0 && <p className="px-4 py-3 text-[13px] text-muted">No presets yet.</p>}
                    {presets.data?.map((pr) => (
                      <div key={pr.id} className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="flex-1 truncate text-[13.5px] font-medium">{pr.name}</span>
                          <Ago ts={pr.created_at} className="text-[11px] text-muted" />
                        </div>
                        <div className="mt-1.5 flex gap-1">
                          <Button size="sm" variant="secondary" onClick={() => { setParams({ ...schema.data?.defaults, ...pr.params }); toast.success(`Loaded ${pr.name}`); }}>Load</Button>
                          <Button size="sm" variant="ghost" onClick={() => setCompare(pr)}><FileDiff />Compare</Button>
                          {sci && (d.can_edit || pr.created_by === user?.username) && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => askDeletePreset(pr)} aria-label={`Delete ${pr.name}`} title="Delete this preset"><Trash2 /></Button>}
                        </div>
                      </div>
                    ))}
                  </div>
                  {sci && <SavePresetForm onSave={(b) => savePreset.mutate(b)} busy={savePreset.isPending} />}
                </Panel>
                <Panel className="p-4 space-y-2">
                  <Button className="w-full" variant="secondary" disabled={!edited} onClick={() => schema.data && setParams(schema.data.defaults)}>Restore all defaults</Button>
                  <div className="flex gap-2">
                    <ExportButton pid={d.id} params={params} fmt="json" />
                    <ExportButton pid={d.id} params={params} fmt="yaml" />
                  </div>
                  <p className="text-xs text-muted">Downloads the values above as a parameter file, for running the pipeline with Nextflow yourself (<code className="font-mono">-params-file</code>).</p>
                </Panel>
              </aside>
            </div>
          )}
          {tab === "io" && (
            <div className="grid gap-5 lg:grid-cols-2">
              <Panel>
                <PanelHeader title="Sample sheet columns" description="What the pipeline needs to know about each sample. BioCompute writes this sheet from the experiment you choose at launch." />
                {d.input_columns.length === 0 ? <p className="p-4 text-[13px] text-muted">This pipeline does not say which columns it needs, so BioCompute writes a standard sheet with the columns sample, fastq_1, fastq_2, condition and replicate.</p> : (
                  <table className="w-full text-[13px]">
                    <thead><tr className="text-left text-xs text-muted border-b border-line"><th className="px-4 py-2 font-medium">Column</th><th className="px-2 py-2 font-medium">Type</th><th className="px-4 py-2 font-medium">Rule</th></tr></thead>
                    <tbody>{d.input_columns.map((c) => (
                      <tr key={c.name} className="border-b border-line/50 last:border-0 align-top">
                        <td className="px-4 py-2 font-mono text-[12px]">{c.name}{c.required && <span className="text-bad" title="Required"> *</span>}</td>
                        <td className="px-2 py-2 text-muted">{c.types.join(" | ")}{c.format ? `, ${c.format}` : ""}</td>
                        <td className="px-4 py-2 text-muted text-xs">{c.description || c.pattern || "—"}</td>
                      </tr>))}</tbody>
                  </table>)}
              </Panel>
              <Panel>
                <PanelHeader title="Main outputs" description={ver ? `As described by ${ver.version}` : undefined} />
                <div className="p-4 space-y-2 text-[13px]">
                  {(ver?.outputs ?? []).length === 0 && <p className="text-muted">Not documented by the pipeline.</p>}
                  {ver?.outputs.map((o) => <p key={o.name}><span className="font-medium">{o.name}</span>{o.path && <span className="font-mono text-[12px] text-muted"> {o.path}/</span>}{o.description && <span className="block text-xs text-muted">{o.description}</span>}</p>)}
                </div>
                <PanelHeader title="Where its tools come from" className="border-t" />
                <div className="p-4 flex flex-wrap gap-1.5">
                  {(ver?.software ?? []).length ? ver!.software.map((s) => <Badge key={s}>{s}</Badge>) : <span className="text-[13px] text-muted">The pipeline does not say how to get its tools (no container, no conda environment), so they must already be installed on the nodes.</span>}
                </div>
                {Array.isArray(d.manifest.profiles) && (d.manifest.profiles as string[]).length > 0 && (
                  <><PanelHeader title="Profiles" description="Ready-made settings the pipeline offers, chosen at launch" className="border-t" /><div className="p-4 flex flex-wrap gap-1.5">{(d.manifest.profiles as string[]).map((s) => <Badge key={s}>{s}</Badge>)}</div></>
                )}
              </Panel>
            </div>
          )}
          {tab === "versions" && (
            <Panel className="divide-y divide-line/60">
              {d.versions.map((v) => (
                <div key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <GitBranch className="size-4 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-[13.5px]">{v.version}
                      {v.pinned ? <Badge tone="accent" className="ml-1.5" title="New runs use this version until another default is chosen. A different version can still be picked when launching a run.">Default version</Badge>
                        : v.id === d.latest_version?.id && <Badge className="ml-1.5" title="No default version is set, so new runs use the newest one.">Newest · used for new runs</Badge>}
                    </p>
                    <p className="font-mono text-[11.5px] text-muted truncate" title={v.path ?? undefined}>{v.git_commit ? `commit ${v.git_commit.slice(0, 10)}` : "local files"}{v.path ? ` · ${v.path}` : ""}</p>
                  </div>
                  <span className="text-xs text-muted">{when(v.created_at)}</span>
                  <Button asChild size="sm" variant="secondary"><Link to={pipelineTabHref(d.id, "map", v.id)}>Map</Link></Button>
                  <Button asChild size="sm" variant={ver?.id === v.id ? "primary" : "secondary"}><Link to={pipelineTabHref(d.id, "params", v.id)}>Parameters</Link></Button>
                  {sci && d.can_edit && !v.pinned && (
                    <Button size="sm" variant="ghost" loading={pin.isPending && pin.variables?.id === v.id} onClick={() => pin.mutate(v)}
                      title="New runs will use this version, also when newer versions are added. A different version can still be picked when launching a run."><Pin />Use by default</Button>
                  )}
                  {sci && d.can_edit && !v.pinned && (d.versions?.length ?? 0) > 1 && (
                    <Button size="icon" variant="ghost" aria-label={`Delete version ${v.version}`} title="Delete this version (only when no run used it)"
                      loading={delVersion.isPending && delVersion.variables?.id === v.id}
                      onClick={async () => { if (await confirmDialog({ title: `Delete version ${v.version}?`, body: "Only possible when no run used it, so every run stays reproducible. Files in BioCompute's pipeline store are deleted; a folder you imported from is never touched.", confirmLabel: "Delete version", danger: true })) delVersion.mutate(v); }}>
                      <Trash2 />
                    </Button>
                  )}
                </div>
              ))}
              {sci && (d.source_type === "git" || d.source_type === "nf-core") && <FetchVersion pid={d.id} url={d.source_url ?? ""} onDone={refresh} />}
            </Panel>
          )}
          {tab === "runs" && (
            <Panel>
              {history.isLoading && <div className="p-4"><Skeleton className="h-24" /></div>}
              {history.isError && <div className="p-4"><QueryError error={history.error} onRetry={() => history.refetch()} what="the runs of this pipeline" /></div>}
              {history.data?.length === 0 && <Empty title="No runs yet" action={<Button asChild variant="primary"><Link to={launchHref}><Play />Configure and run</Link></Button>}>Runs of this pipeline are listed here, with the parameters they used.</Empty>}
              <div className="divide-y divide-line/60">
                {history.data?.map((h) => (
                  <div key={h.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
                    <Link to={`/runs/${h.id}`} className="min-w-0 flex-1 truncate hover:underline">{h.name}</Link>
                    <span className="text-xs text-muted">{when(h.created_at)}</span>
                    <RunStatusBadge status={h.status} />
                    <Button size="sm" variant="ghost" title="Loads this run's parameters into the Parameters tab, where you can check them and start a new run"
                      onClick={() => { setParams({ ...schema.data?.defaults, ...h.params }); go({ tab: "params" }); toast.success(`Parameters of “${h.name}” loaded. Check them, then choose Run with these parameters.`); }}>Reuse parameters</Button>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          {tab === "readme" && d.readme && (
            <Panel className="p-5"><pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed max-w-[80ch]">{d.readme}</pre></Panel>
          )}
          <ForkDialog open={forkOpen} onOpenChange={setForkOpen} pid={d.id} name={d.name} version={ver?.version} versionId={ver?.id} studio={d.kind === "studio"} />
        </>
      )}
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

function FetchVersion({ pid, url, onDone }: { pid: string; url: string; onDone: () => void }) {
  const [ref, setRef] = useState("");
  const m = useMutation({ mutationFn: () => api.post(`/api/pipelines/${pid}/versions/update`, { url, ref }), onSuccess: () => { toast.success("Version added"); setRef(""); onDone(); }, onError: (e) => toast.error(errMsg(e)) });
  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="tag, branch or commit" className="max-w-56" aria-label="Tag, branch or commit to add as a version" />
      <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!ref}><Plus />Add this version</Button>
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
    onSuccess: () => { toast.success("Parameter form saved"); onDone(); }, onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="space-y-5">
      <Panel className="p-4">
        <p className="font-medium">This pipeline does not describe its parameters</p>
        <p className="text-[13px] text-muted mt-1">It has no <code className="font-mono text-[12px]">nextflow_schema.json</code>, the file BioCompute builds the parameter form from. Set parameters as name and value pairs below, or describe them once so BioCompute can show a form that checks the values.</p>
        <div className="mt-4"><GenericParamEditor params={params} onChange={setParams} /></div>
      </Panel>
      <Panel>
        <PanelHeader title={<span className="flex items-center gap-2"><Wand2 className="size-4 text-accent" />Describe the parameters</span>} description="One line per parameter. BioCompute turns this into the parameter form (stored in the standard nextflow_schema.json format)." />
        <div className="p-4 space-y-2">
          {wizard.map((w, i) => (
            <div key={i} className="grid grid-cols-[1fr_110px_1fr_1.5fr_auto] gap-2 items-center">
              <Input placeholder="name" aria-label="Parameter name" value={w.name} className="font-mono text-[12px]" onChange={(e) => setWizard(wizard.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/\W/g, "_") } : x)))} />
              <Select aria-label="Type" value={w.type} onChange={(e) => setWizard(wizard.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                {["string", "integer", "number", "boolean"].map((t) => <option key={t}>{t}</option>)}
              </Select>
              <Input placeholder="default" aria-label="Default value" value={w.default} onChange={(e) => setWizard(wizard.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)))} />
              <Input placeholder="description" aria-label="Description" value={w.description} onChange={(e) => setWizard(wizard.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              <label className="flex items-center gap-1 text-xs text-muted"><input type="checkbox" checked={w.required} onChange={(e) => setWizard(wizard.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />required</label>
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <Button variant="ghost" onClick={() => setWizard([...wizard, { name: "", type: "string", default: "", description: "", required: false }])}><Plus />Add parameter</Button>
            <Button className="ml-auto" onClick={() => save.mutate(false)} loading={save.isPending} title="The form is kept in BioCompute; the pipeline files are not touched">Save the form</Button>
            <Button variant="primary" onClick={() => save.mutate(true)} loading={save.isPending} title="Also writes nextflow_schema.json into the pipeline folder, so the form travels with the pipeline">Save and add it to the pipeline files</Button>
          </div>
          <KV k="Note" v="The file can only be added to pipelines that BioCompute keeps in its own pipeline folder (imported with “copy”, or your own copies)." />
        </div>
      </Panel>
    </div>
  );
}
