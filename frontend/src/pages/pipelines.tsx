import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, GitBranch, FolderInput, Search, Star, Boxes, Workflow } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { Pipeline } from "@/lib/types";
import { ago, cn } from "@/lib/utils";
import { PageHeader } from "@/components/page";
import { Badge, Empty, Panel, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { PathInput } from "@/components/file-browser";
import { RunStatusBadge } from "@/components/status";

const KINDS = [
  { id: "all", label: "All" },
  { id: "installed", label: "Installed" },
  { id: "studio", label: "Built in Studio" },
  { id: "template", label: "Catalog" },
];

export default function PipelinesPage() {
  const user = useAuth((s) => s.user);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [importOpen, setImportOpen] = useState<null | { url?: string; name?: string; category?: string }>(null);
  const list = useQuery({ queryKey: ["pipelines"], queryFn: () => api.get<Pipeline[]>("/api/pipelines") });

  const categories = useMemo(() => [...new Set((list.data ?? []).map((p) => p.category))].sort(), [list.data]);
  const items = useMemo(() => {
    const ql = q.toLowerCase();
    return (list.data ?? []).filter((p) =>
      (kind === "all" || p.kind === kind) && (!category || p.category === category) && (!favOnly || p.favorite) &&
      (!ql || [p.name, p.description, p.category, ...p.tags].some((s) => s.toLowerCase().includes(ql))));
  }, [list.data, kind, q, category, favOnly]);

  const fav = useMutation({
    mutationFn: (p: Pipeline) => api.patch(`/api/pipelines/${p.id}`, { favorite: !p.favorite }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipelines"] }),
  });

  const installed = items.filter((p) => p.kind !== "template");
  const templates = items.filter((p) => p.kind === "template");

  return (
    <>
      <PageHeader title="Pipelines"
        description="Installed pipelines can run now. Catalog entries are nf-core pipelines that are known but not installed until you import them."
        actions={can(user, "scientist") && <>
          <Button variant="secondary" onClick={() => nav("/studio")}><Workflow />Build in Studio</Button>
          <Button variant="primary" onClick={() => setImportOpen({})}><Download />Import pipeline</Button>
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-72 max-w-full">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, category, tag" className="pl-8" aria-label="Search pipelines" />
        </div>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-48" aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <button onClick={() => setFavOnly(!favOnly)} aria-pressed={favOnly}
          className={cn("inline-flex h-8.5 items-center gap-1.5 rounded-md border px-3 text-[13px]", favOnly ? "border-wait/50 text-wait bg-wait/10" : "border-line text-muted hover:text-text")}>
          <Star className={cn("size-4", favOnly && "fill-current")} />Favorites
        </button>
      </div>
      <Tabs value={kind} onValueChange={setKind}>
        <TabsList className="mb-5">{KINDS.map((k) => <TabsTrigger key={k.id} value={k.id}>{k.label}</TabsTrigger>)}</TabsList>
        <TabsContent value={kind}>
          {list.isLoading && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}</div>}
          {list.data && items.length === 0 && <Panel><Empty icon={<Boxes />} title="No pipelines match">Clear the search or filters, or import a pipeline from Git or a local folder.</Empty></Panel>}
          {installed.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 mb-8">
              {installed.map((p) => <PipelineCard key={p.id} p={p} onFav={() => fav.mutate(p)} />)}
            </div>
          )}
          {templates.length > 0 && (
            <>
              {kind === "all" && <h2 className="mb-1 text-[15px] font-semibold">nf-core catalog</h2>}
              {kind === "all" && <p className="mb-3 text-[13px] text-muted">Not installed. Importing clones the repository onto the controller (needs network access to GitHub).</p>}
              <Panel className="divide-y divide-line/60">
                {templates.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-[13.5px]">{p.name} <Badge className="ml-1.5">{p.category}</Badge></p>
                      <p className="text-[13px] text-muted truncate">{p.description}</p>
                    </div>
                    {p.source_url && <a href={p.source_url} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-text">Repository</a>}
                    {can(user, "scientist") && <Button size="sm" onClick={() => setImportOpen({ url: p.source_url ?? "", name: p.name.replace("/", "-"), category: p.category })}><Download />Install</Button>}
                  </div>
                ))}
              </Panel>
            </>
          )}
        </TabsContent>
      </Tabs>
      <ImportDialog init={importOpen} onClose={() => setImportOpen(null)} onDone={(id) => nav(`/pipelines/${id}`)} />
    </>
  );
}

function PipelineCard({ p, onFav }: { p: Pipeline; onFav: () => void }) {
  const v = p.latest_version;
  return (
    <Panel className="flex flex-col p-4 hover:border-muted/60 transition-colors">
      <div className="flex items-start gap-2">
        <Link to={`/pipelines/${p.id}`} className="min-w-0 flex-1">
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
        {p.has_schema ? <Badge tone="ok">schema</Badge> : <Badge tone="wait">no schema</Badge>}
        {p.kind === "studio" && <Badge>Studio</Badge>}
        {p.tags.slice(0, 2).map((t) => <Badge key={t}>{t}</Badge>)}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1 font-mono text-[11px]"><GitBranch className="size-3" />{v?.version}{v?.git_commit ? ` @ ${v.git_commit.slice(0, 7)}` : ""}</span>
        <span className="flex items-center gap-2">{p.run_count} run{p.run_count === 1 ? "" : "s"}{p.last_run_status && <RunStatusBadge status={p.last_run_status} />}</span>
      </div>
      <div className="mt-3 flex gap-2">
        <Button asChild size="sm" variant="primary"><Link to={`/jobs/new?pipeline=${p.id}`}>Configure and run</Link></Button>
        <Button asChild size="sm" variant="ghost"><Link to={`/pipelines/${p.id}`}>Details</Link></Button>
        <span className="ml-auto self-center text-[11px] text-muted">updated {ago(p.updated_at)}</span>
      </div>
    </Panel>
  );
}

function ImportDialog({ init, onClose, onDone }: { init: null | { url?: string; name?: string; category?: string }; onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState("git");
  const [git, setGit] = useState({ url: "", ref: "", name: "", category: "" });
  const [local, setLocal] = useState({ path: "", name: "", category: "", copy_files: true });
  const open = init !== null;
  const [seeded, setSeeded] = useState<typeof init>(null);
  if (open && init !== seeded) {
    setSeeded(init);
    setGit({ url: init?.url ?? "", ref: "", name: init?.name ?? "", category: init?.category ?? "" });
    setTab("git");
  }
  const run = useMutation({
    mutationFn: () => (tab === "git"
      ? api.post<Pipeline>("/api/pipelines/import/git", { url: git.url, ref: git.ref || null, name: git.name || null, category: git.category || null })
      : api.post<Pipeline>("/api/pipelines/import/local", { ...local, name: local.name || null, category: local.category || null })),
    onSuccess: (p) => { toast.success(`Imported ${p.name}`); qc.invalidateQueries({ queryKey: ["pipelines"] }); onClose(); onDone(p.id); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Import a pipeline" description="BioCompute reads main.nf, nextflow.config, nextflow_schema.json and assets/schema_input.json. Nothing is executed during import.">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="git"><GitBranch className="inline size-3.5 mr-1" />Git repository</TabsTrigger>
            <TabsTrigger value="local"><FolderInput className="inline size-3.5 mr-1" />Local folder</TabsTrigger>
          </TabsList>
          <TabsContent value="git" className="space-y-4">
            <Field label="Repository URL" required hint="https:// or ssh. nf-core pipelines: https://github.com/nf-core/<name>">
              <Input value={git.url} onChange={(e) => setGit({ ...git, url: e.target.value })} placeholder="https://github.com/nf-core/chipseq" className="font-mono text-[12px]" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Version (tag, branch or commit)" hint="Pinned for reproducibility. Empty means default branch.">
                <Input value={git.ref} onChange={(e) => setGit({ ...git, ref: e.target.value })} placeholder="2.1.0" />
              </Field>
              <Field label="Category"><Input value={git.category} onChange={(e) => setGit({ ...git, category: e.target.value })} placeholder="Epigenomics" /></Field>
              <Field label="Display name" className="sm:col-span-2"><Input value={git.name} onChange={(e) => setGit({ ...git, name: e.target.value })} placeholder="from the repository" /></Field>
            </div>
          </TabsContent>
          <TabsContent value="local" className="space-y-4">
            <Field label="Pipeline folder" required hint="Must contain main.nf (Nextflow) or bcflow.json (native engine).">
              <PathInput mode="dir" value={local.path} onChange={(v) => setLocal({ ...local, path: v })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Display name"><Input value={local.name} onChange={(e) => setLocal({ ...local, name: e.target.value })} /></Field>
              <Field label="Category"><Input value={local.category} onChange={(e) => setLocal({ ...local, category: e.target.value })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={local.copy_files} onChange={(e) => setLocal({ ...local, copy_files: e.target.checked })} className="accent-[rgb(var(--accent))]" />
              Copy into the managed pipeline store (recommended; the original may change)
            </label>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={run.isPending} disabled={tab === "git" ? !git.url : !local.path} onClick={() => run.mutate()}>Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
