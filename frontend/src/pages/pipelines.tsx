import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArchiveRestore, Download, GitBranch, FolderInput, Search, Star, Boxes, Workflow } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { Pipeline } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Ago, PageHeader, QueryError, usePageTitle } from "@/components/page";
import { Badge, Empty, Panel, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { PathInput } from "@/components/file-browser";
import { RunStatusBadge } from "@/components/status";
import { StudioDrafts } from "@/components/studio-drafts";
import { SharingBadge } from "@/components/sharing";
import { usePipelineUninstall } from "@/components/uninstall";
import { PipelineContextMenu, PipelineMenuButton, usePipelineMenu } from "@/components/pipeline-menu";

const WHOSE = [["all", "Everything"], ["mine", "Mine"], ["others", "Lab & catalog"]] as const;
type Whose = (typeof WHOSE)[number][0];
const KINDS = [
  { id: "all", label: "All" },
  { id: "installed", label: "Installed" },
  { id: "studio", label: "Built in Studio" },
  { id: "template", label: "Catalog" },
  { id: "archived", label: "Uninstalled" },
];

export default function PipelinesPage() {
  const user = useAuth((s) => s.user);
  const qc = useQueryClient();
  const nav = useNavigate();
  usePageTitle("Pipelines");
  // search and filters live in the URL (?q=&kind=&category=&fav=1&whose=), so Back from a pipeline restores them
  const [sp, setSp] = useSearchParams();
  const setFilter = (patch: Record<string, string | null>) => setSp((prev) => {
    const n = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    return n;
  }, { replace: true });
  const kind = KINDS.some((k) => k.id === sp.get("kind")) ? sp.get("kind")! : "all";
  const category = sp.get("category") ?? "";
  const favOnly = sp.get("fav") === "1";
  const whose: Whose = WHOSE.some(([k]) => k === sp.get("whose")) ? (sp.get("whose") as Whose) : "all";
  // the search box keeps its own text (the URL is updated a moment after each key press, which would move the caret)
  const urlQ = sp.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const pushed = useRef(urlQ);
  useEffect(() => { if (urlQ !== pushed.current) { pushed.current = urlQ; setQ(urlQ); } }, [urlQ]); // the URL changed from outside (a link, Back)
  const search = (v: string) => { setQ(v); pushed.current = v; setFilter({ q: v }); };
  const filtered = !!q || !!category || favOnly || whose !== "all" || kind !== "all";
  const clearFilters = () => { pushed.current = ""; setQ(""); setSp({}, { replace: true }); };
  const me = user?.username;
  const [importOpen, setImportOpen] = useState<null | { url?: string; name?: string; category?: string }>(null);
  const list = useQuery({ queryKey: ["pipelines"], queryFn: () => api.get<Pipeline[]>("/api/pipelines") });
  const archived = useQuery({ queryKey: ["pipelines-archived"], queryFn: () => api.get<Pipeline[]>("/api/pipelines?archived=true"), enabled: kind === "archived" });
  const { restore } = usePipelineUninstall();

  const categories = useMemo(() => [...new Set((list.data ?? []).map((p) => p.category))].sort(), [list.data]);
  const items = useMemo(() => {
    const ql = q.toLowerCase();
    return (list.data ?? []).filter((p) =>
      (kind === "all" || p.kind === kind) && (!category || p.category === category) && (!favOnly || p.favorite) &&
      (whose === "all" || (whose === "mine" ? p.owner === me : p.owner !== me)) &&
      (!ql || [p.name, p.description, p.category, ...p.tags].some((s) => s.toLowerCase().includes(ql))));
  }, [list.data, kind, q, category, favOnly, whose, me]);

  const fav = useMutation({
    mutationFn: (p: Pipeline) => api.patch(`/api/pipelines/${p.id}`, { favorite: !p.favorite }),
    onSuccess: (_r, p) => { qc.invalidateQueries({ queryKey: ["pipelines"] }); qc.invalidateQueries({ queryKey: ["pipeline", p.id] }); },
    onError: (e) => toast.error(`Favorites were not changed: ${errMsg(e)}`),
  });

  const installed = items.filter((p) => p.kind !== "template");
  const templates = items.filter((p) => p.kind === "template");

  return (
    <>
      <PageHeader title="Pipelines"
        description="Installed pipelines can run now. Catalog entries are community pipelines (from the nf-core collection) that are listed here but only downloaded when you install them."
        actions={can(user, "scientist") && <>
          <Button variant="secondary" onClick={() => nav("/studio")}><Workflow />Build in Studio</Button>
          <Button variant="primary" onClick={() => setImportOpen({})}><Download />Import pipeline</Button>
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-72 max-w-full">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted" />
          <Input type="search" value={q} onChange={(e) => search(e.target.value)} placeholder="Search name, category, tag" className="pl-8" aria-label="Search pipelines" />
        </div>
        <Select value={category} onChange={(e) => setFilter({ category: e.target.value })} className="w-48" aria-label="Category">
          <option value="">All categories</option>
          {category && !categories.includes(category) && <option>{category}</option>}
          {categories.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <button onClick={() => setFilter({ fav: favOnly ? null : "1" })} aria-pressed={favOnly}
          className={cn("inline-flex h-8.5 items-center gap-1.5 rounded-md border px-3 text-[13px]", favOnly ? "border-wait/50 text-wait bg-wait/10" : "border-line text-muted hover:text-text")}>
          <Star className={cn("size-4", favOnly && "fill-current")} />Favorites
        </button>
        <div className="flex rounded-md border border-line p-0.5 text-[13px]" role="group" aria-label="Whose pipelines">
          {WHOSE.map(([k, l]) => (
            <button key={k} onClick={() => setFilter({ whose: k === "all" ? null : k })} aria-pressed={whose === k}
              className={cn("rounded px-2.5 py-1", whose === k ? "bg-raised text-text" : "text-muted hover:text-text")}>{l}</button>
          ))}
        </div>
        {filtered && <Button size="sm" variant="ghost" onClick={clearFilters}>Clear filters</Button>}
      </div>
      <Tabs value={kind} onValueChange={(k) => setFilter({ kind: k === "all" ? null : k })}>
        <TabsList className="mb-5">{KINDS.map((k) => <TabsTrigger key={k.id} value={k.id}>{k.label}</TabsTrigger>)}</TabsList>
        <TabsContent value={kind}>
          {kind === "archived" ? <Uninstalled q={q} query={archived} onRestore={(p) => restore.mutate(p)} restoring={restore.isPending ? restore.variables?.id : undefined} /> : <>
          {list.isLoading && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}</div>}
          {(kind === "all" || kind === "studio") && whose !== "others" && <StudioDrafts query={q} />}
          {list.isError && !list.data && <QueryError error={list.error} onRetry={() => list.refetch()} what="the pipelines" />}
          {list.data && items.length === 0 && (
            <Panel>
              {filtered
                ? <Empty icon={<Boxes />} title="No pipelines match" action={<Button onClick={clearFilters}>Clear search and filters</Button>}>Nothing fits the search and filters above.</Empty>
                : <Empty icon={<Boxes />} title="No pipelines yet">Import a pipeline from Git or a local folder, or build one in Pipeline Studio.</Empty>}
            </Panel>
          )}
          {installed.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 mb-8">
              {installed.map((p) => <PipelineCard key={p.id} p={p} onFav={() => fav.mutate(p)} />)}
            </div>
          )}
          {templates.length > 0 && (
            <>
              {kind === "all" && <h2 className="mb-1 text-[15px] font-semibold">Catalog (nf-core community pipelines)</h2>}
              {kind === "all" && <p className="mb-3 text-[13px] text-muted">Not installed. Installing downloads the pipeline onto the controller (needs network access to GitHub).</p>}
              <Panel className="divide-y divide-line/60">
                {templates.map((p) => <CatalogRow key={p.id} p={p} onInstall={can(user, "scientist") ? () => setImportOpen({ url: p.source_url ?? "", name: p.name.replace("/", "-"), category: p.category }) : undefined} />)}
              </Panel>
            </>
          )}
          </>}
        </TabsContent>
      </Tabs>
      <ImportDialog init={importOpen} onClose={() => setImportOpen(null)} onDone={(id) => nav(`/pipelines/${id}`)} />
    </>
  );
}

/** Pipelines uninstalled while runs still refer to them: kept for those runs, restorable. */
function Uninstalled({ q, query, onRestore, restoring }: {
  q: string; query: { data?: Pipeline[]; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  onRestore: (p: Pipeline) => void; restoring?: string;
}) {
  const ql = q.toLowerCase();
  const rows = (query.data ?? []).filter((p) => !ql || p.name.toLowerCase().includes(ql));
  if (query.isLoading) return <Skeleton className="h-32" />;
  if (query.isError) return <QueryError error={query.error} onRetry={() => query.refetch()} what="the uninstalled pipelines" />;
  if (!rows.length) return <Panel><Empty icon={<Boxes />} title="No uninstalled pipelines">A pipeline you uninstall after it has run stays here, with the versions its runs used, so you can restore it.</Empty></Panel>;
  return (
    <Panel className="divide-y divide-line/60">
      <p className="px-4 py-2.5 text-[12.5px] text-muted">Hidden from the lists and the launch form. Their runs keep working (records, results, Resume); only the versions those runs used were kept.</p>
      {rows.map((p) => <UninstalledRow key={p.id} p={p} onRestore={() => onRestore(p)} restoring={restoring === p.id} />)}
    </Panel>
  );
}

function UninstalledRow({ p, onRestore, restoring }: { p: Pipeline; onRestore: () => void; restoring: boolean }) {
  const menu = usePipelineMenu(p);
  return (
    <PipelineContextMenu p={p} menu={menu}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium"><Link to={`/pipelines/${p.id}`} className="hover:underline">{p.name}</Link></p>
          <p className="text-[12px] text-muted">{p.run_count} run{p.run_count === 1 ? "" : "s"} · {p.category}{p.owner ? ` · ${p.owner}` : ""}</p>
        </div>
        {p.can_edit && <Button size="sm" variant="secondary" loading={restoring} onClick={onRestore}><ArchiveRestore />Restore</Button>}
        <PipelineMenuButton p={p} menu={menu} />
      </div>
    </PipelineContextMenu>
  );
}

function CatalogRow({ p, onInstall }: { p: Pipeline; onInstall?: () => void }) {
  const menu = usePipelineMenu(p, { onInstall });
  return (
    <PipelineContextMenu p={p} menu={menu}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[13.5px]"><Link to={`/pipelines/${p.id}`} className="hover:underline">{p.name}</Link> <Badge className="ml-1.5">{p.category}</Badge></p>
          <p className="text-[13px] text-muted truncate">{p.description}</p>
        </div>
        {p.source_url && <a href={p.source_url} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-text">Repository</a>}
        {onInstall && <Button size="sm" onClick={onInstall}><Download />Install</Button>}
      </div>
    </PipelineContextMenu>
  );
}

function PipelineCard({ p, onFav }: { p: Pipeline; onFav: () => void }) {
  const v = p.latest_version;
  const menu = usePipelineMenu(p);
  return (
    <PipelineContextMenu p={p} menu={menu}>
    <Panel className="flex flex-col p-4 hover:border-muted/60 transition-colors">
      <div className="flex items-start gap-2">
        <Link to={p.kind === "template" ? `/pipelines/${p.id}` : `/pipelines/${p.id}/map`} className="min-w-0 flex-1">
          <p className="font-semibold truncate hover:underline">{p.name}</p>
          <p className="text-xs text-muted">{p.category}</p>
        </Link>
        <button onClick={onFav} aria-label={p.favorite ? "Remove from favorites" : "Add to favorites"} className="rounded p-1 text-muted hover:text-wait">
          <Star className={cn("size-4", p.favorite && "fill-wait text-wait")} />
        </button>
      </div>
      <p className="mt-2 line-clamp-2 text-[13px] text-muted flex-1">{p.description || "No description."}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {v?.engines.map((e) => <Badge key={e} tone={e === "nextflow" ? "accent" : "neutral"}>{e === "bcflow" ? "native engine" : e}</Badge>)}
        {p.has_schema
          ? <Badge tone="ok" title="This pipeline describes its parameters, so BioCompute shows them as a form with help texts and checks the values you enter.">parameter form</Badge>
          : <Badge tone="wait" title="This pipeline does not describe its parameters. You set them as name and value pairs, and BioCompute cannot check them before the run starts.">no parameter form</Badge>}
        {p.kind === "studio" && <Badge>Studio</Badge>}
        <SharingBadge owner={p.owner} visibility={p.visibility} />
        {p.tags.slice(0, 2).map((t) => <Badge key={t}>{t}</Badge>)}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1 font-mono text-[11px]"><GitBranch className="size-3" />{v?.version}{v?.git_commit ? ` @ ${v.git_commit.slice(0, 7)}` : ""}</span>
        <span className="flex items-center gap-2" title={p.last_run_status ? "Number of runs, and how the last one ended" : undefined}>{p.run_count} run{p.run_count === 1 ? "" : "s"}{p.last_run_status && <RunStatusBadge status={p.last_run_status} />}</span>
      </div>
      <div className="mt-3 flex gap-2">
        <Button asChild size="sm" variant="primary"><Link to={`/jobs/new?pipeline=${p.id}`}>Configure and run</Link></Button>
        {p.kind !== "template" && <Button asChild size="sm" variant="ghost"><Link to={`/pipelines/${p.id}/map`}>Map</Link></Button>}
        <Button asChild size="sm" variant="ghost"><Link to={`/pipelines/${p.id}`} title="Parameters, inputs and outputs, versions and runs">Parameters</Link></Button>
        <span className="ml-auto self-center whitespace-nowrap text-[11px] text-muted">updated <Ago ts={p.updated_at} /></span>
        <PipelineMenuButton p={p} menu={menu} />
      </div>
    </Panel>
    </PipelineContextMenu>
  );
}

/** Import from Git or a local folder; with `init.url` (a catalog entry) it installs that pipeline. Also used by the pipeline page. */
export function ImportDialog({ init, onClose, onDone }: { init: null | { url?: string; name?: string; category?: string }; onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState("git");
  const [git, setGit] = useState({ url: "", ref: "", name: "", category: "" });
  const [local, setLocal] = useState({ path: "", name: "", category: "", copy_files: true });
  const [visibility, setVisibility] = useState<"private" | "lab">("private");
  const open = init !== null;
  const [seeded, setSeeded] = useState<typeof init>(null);
  if (open && init !== seeded) {
    setSeeded(init);
    setGit({ url: init?.url ?? "", ref: "", name: init?.name ?? "", category: init?.category ?? "" });
    setTab("git");
  }
  const catalog = !!seeded?.url; // opened from a catalog entry
  const run = useMutation({
    mutationFn: () => (tab === "git"
      ? api.post<Pipeline>("/api/pipelines/import/git", { url: git.url, ref: git.ref || null, name: git.name || null, category: git.category || null, visibility })
      : api.post<Pipeline>("/api/pipelines/import/local", { ...local, name: local.name || null, category: local.category || null, visibility })),
    onSuccess: (p) => { toast.success(`${catalog ? "Installed" : "Imported"} ${p.name}`); qc.invalidateQueries({ queryKey: ["pipelines"] }); onClose(); onDone(p.id); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={catalog ? `Install ${seeded?.name ?? "this pipeline"}` : "Import a pipeline"}
        description="BioCompute copies the pipeline's files and reads its description, its parameters and the sample sheet it expects. Nothing is run during the import.">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="git"><GitBranch className="inline size-3.5 mr-1" />Git repository</TabsTrigger>
            <TabsTrigger value="local"><FolderInput className="inline size-3.5 mr-1" />Local folder</TabsTrigger>
          </TabsList>
          <TabsContent value="git" className="space-y-4">
            <Field label="Repository URL" required hint="An https:// or ssh address. Community pipelines from nf-core: https://github.com/nf-core/<name>">
              <Input value={git.url} onChange={(e) => setGit({ ...git, url: e.target.value })} placeholder="https://github.com/nf-core/chipseq" className="font-mono text-[12px]" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Version (tag, branch or commit)" hint="Fixes exactly which code is used, so runs can be repeated. Empty: the repository's main branch as it is today.">
                <Input value={git.ref} onChange={(e) => setGit({ ...git, ref: e.target.value })} placeholder="2.1.0" />
              </Field>
              <Field label="Category"><Input value={git.category} onChange={(e) => setGit({ ...git, category: e.target.value })} placeholder="Epigenomics" /></Field>
              <Field label="Display name" className="sm:col-span-2"><Input value={git.name} onChange={(e) => setGit({ ...git, name: e.target.value })} placeholder="from the repository" /></Field>
            </div>
          </TabsContent>
          <TabsContent value="local" className="space-y-4">
            <Field label="Pipeline folder" required hint="The folder that contains the pipeline's main file: main.nf (Nextflow) or bcflow.json (BioCompute's native engine).">
              <PathInput mode="dir" value={local.path} onChange={(v) => setLocal({ ...local, path: v })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Display name"><Input value={local.name} onChange={(e) => setLocal({ ...local, name: e.target.value })} /></Field>
              <Field label="Category"><Input value={local.category} onChange={(e) => setLocal({ ...local, category: e.target.value })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={local.copy_files} onChange={(e) => setLocal({ ...local, copy_files: e.target.checked })} className="accent-[rgb(var(--accent))]" />
              Copy the folder into BioCompute (recommended: later changes to the original folder then cannot alter your runs)
            </label>
          </TabsContent>
        </Tabs>
        <Field label="Who can use it" className="mt-4" hint={visibility === "private" ? "Only you (and administrators). You can share it later." : "Everyone in the lab can see, run and copy it; only you can change it."}>
          <Select value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "lab")}>
            <option value="private">Only me</option>
            <option value="lab">Everyone in the lab</option>
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={run.isPending} disabled={tab === "git" ? !git.url : !local.path} onClick={() => run.mutate()}>{catalog ? "Install" : "Import"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
