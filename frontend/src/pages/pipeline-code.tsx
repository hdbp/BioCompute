import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ChevronDown, ChevronRight, FileCode2, FilePlus2, FileText, Folder, FolderTree, GitFork, Lock, Save, Search, Trash2, Undo2, Workflow, X } from "lucide-react";
import { api, ApiError, errMsg, qs } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { PipelineDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useUnsavedGuard } from "@/hooks/unsaved";
import { QueryError, usePageTitle } from "@/components/page";
import { Button } from "@/components/ui/button";
import { confirmDialog, promptDialog } from "@/components/ui/confirm";
import { Badge, Empty, Tip } from "@/components/ui/misc";
import { ForkDialog } from "@/components/fork-dialog";
import { PipelineTabs, VersionSelect } from "@/components/pipeline-tabs";

interface FileEntry { path: string; size: number; text: boolean }
interface FilesResponse { version_id: string; version: string; editable: boolean; files: FileEntry[] }

const FIRST = ["main.nf", "nextflow.config", "nextflow_schema.json", "conf/base.config", "conf/modules.config"];

/** The Code tab of a pipeline. Your own copies are editable; each save is a new version. Originals are read-only. */
export default function PipelineCodePage() {
  const { id = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const p = useQuery({ queryKey: ["pipeline", id], queryFn: () => api.get<PipelineDetail>(`/api/pipelines/${id}`) });
  const versionId = sp.get("version") ?? undefined;
  const files = useQuery({ queryKey: ["pipeline-files", id, versionId ?? null], queryFn: () => api.get<FilesResponse>(`/api/pipelines/${id}/files${qs({ version_id: versionId })}`) });
  const d = p.data;
  usePageTitle(d ? "Code" : null, [{ label: "Pipelines", to: "/pipelines" }, ...(d ? [{ label: d.name, to: `/pipelines/${d.id}/map` }] : [])]);
  const fs = files.data;
  const editable = !!fs?.editable;

  // edits not saved yet: path -> new content (null = delete); kept across file switches
  const [changes, setChanges] = useState<Record<string, string | null>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false); // the file list as a drawer on small screens
  const [tabLeaves, setTabLeaves] = useState(false); // after Esc in the editor, Tab moves focus instead of indenting
  const dirty = Object.keys(changes).length > 0;
  useEffect(() => { setChanges({}); setAdded([]); setOpen(null); }, [fs?.version_id]);
  useEffect(() => {
    if (!fs || open) return;
    const first = FIRST.find((f) => fs.files.some((x) => x.path === f)) ?? fs.files.find((x) => x.text)?.path ?? null;
    setOpen(first);
  }, [fs, open]);
  // leaving the page (in the app, or closing the tab) with unsaved edits asks first
  useUnsavedGuard(dirty, "code changes");

  const content = useQuery({
    queryKey: ["pipeline-file", id, fs?.version_id, open], enabled: !!fs && !!open && !added.includes(open ?? ""),
    queryFn: () => api.get<string>(`/api/pipelines/${id}/files/content${qs({ path: open!, version_id: fs!.version_id })}`),
    staleTime: Infinity, retry: false,
  });
  const text = open ? (open in changes ? changes[open] ?? "" : added.includes(open) ? "" : content.data ?? "") : "";
  const setText = (v: string) => { if (open) setChanges((c) => ({ ...c, [open]: v })); };

  const save = async () => {
    if (!fs || !dirty) return;
    setSaving(true);
    try {
      const r = await api.post<{ version_id: string; version: string }>(`/api/pipelines/${id}/files`, { base_version_id: fs.version_id, changes });
      toast.success(`Saved as ${r.version}. ${fs.version} is kept as it was.`);
      setChanges({}); setAdded([]);
      qc.invalidateQueries({ queryKey: ["pipeline", id] });
      qc.invalidateQueries({ queryKey: ["pipelines"] });
      qc.invalidateQueries({ queryKey: ["pipeline-map", id] });
      setSp({}, { replace: true }); // the new version is the current one
      qc.invalidateQueries({ queryKey: ["pipeline-files", id] });
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); if (editable) save(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const pickFile = (path: string) => { setOpen(path); setTreeOpen(false); };
  const newFile = async () => {
    setTreeOpen(false);
    const path = await promptDialog({
      title: "New file", label: "Path inside the pipeline", placeholder: "modules/local/my_tool/main.nf",
      hint: `Folders are created as needed. The file becomes part of ${nextLabel || "the next version"} when you save.`, confirmLabel: "Create file",
    });
    if (!path) return;
    const clean = path.trim().replace(/^\/+/, "");
    if (!clean) return;
    if (fs?.files.some((f) => f.path === clean) || added.includes(clean)) { setOpen(clean); return; }
    setAdded((a) => [...a, clean]);
    setChanges((c) => ({ ...c, [clean]: "" }));
    setOpen(clean);
  };
  const del = async (path: string) => {
    const isNew = added.includes(path);
    if (!(await confirmDialog({
      title: `Delete ${path}?`,
      body: isNew ? "This new file and what you typed in it are discarded. It was never saved."
        : `The file is left out of ${nextLabel || "the next version"} when you save. Earlier versions keep it, and until you save you can bring it back with “Keep file”.`,
      confirmLabel: "Delete file", danger: true,
    }))) return;
    if (added.includes(path)) {
      setAdded((a) => a.filter((x) => x !== path));
      setChanges((c) => { const n = { ...c }; delete n[path]; return n; });
    } else setChanges((c) => ({ ...c, [path]: null }));
  };
  const revert = (path: string) => setChanges((c) => { const n = { ...c }; delete n[path]; return n; });
  const switchVersion = async (vid: string | undefined) => {
    const n = Object.keys(changes).length;
    if (dirty && !(await confirmDialog({
      title: "Discard unsaved code changes?", body: `You changed ${n} file${n === 1 ? "" : "s"} without saving. Switching to another version discards these changes.`,
      confirmLabel: "Discard and switch", cancelLabel: "Keep editing", danger: true,
    }))) return;
    setSp(vid ? { version: vid } : {}, { replace: true });
  };

  const all = useMemo(() => [...(fs?.files ?? []), ...added.map((path) => ({ path, size: 0, text: true }))], [fs, added]);
  const current = versionId ?? d?.latest_version?.id ?? "";
  const nextLabel = d ? `v${Math.max(0, ...d.versions.map((v) => Number(/^v(\d+)$/.exec(v.version)?.[1] ?? 0))) + 1}` : "";
  const deleted = open ? changes[open] === null : false;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Button size="sm" variant={treeOpen ? "secondary" : "ghost"} className="md:hidden" onClick={() => setTreeOpen((o) => !o)}
          aria-expanded={treeOpen} aria-controls="pipeline-file-list" title="Show the list of files"><FolderTree />Files</Button>
        <Button asChild size="icon" variant="ghost" aria-label="All pipelines" title="All pipelines"><Link to="/pipelines"><ArrowLeft /></Link></Button>
        <FileCode2 className="size-4 text-accent" />
        <span className="max-w-[28ch] truncate text-[14px] font-semibold" title={d?.name}>{d?.name ?? "Pipeline"}</span>
        {fs && (editable ? <Badge tone="ok">your copy</Badge> : <Tip content="Originals are never changed. Edit as new pipeline makes your own copy."><Badge tone="wait" className="cursor-help"><Lock className="size-3" />read-only original</Badge></Tip>)}
        {d && <VersionSelect d={d} value={current} onChange={switchVersion} />}
        {dirty && <Badge tone="wait" title="Files changed, added or deleted since the last save">{Object.keys(changes).length} unsaved</Badge>}
        <div className="flex-1" />
        {editable && <Button asChild size="sm" variant="ghost" title="Opens the step editor of Pipeline Studio: switch steps off, change their settings, add or remove steps"><Link to={`/studio/pipeline/${id}${qs({ version: versionId })}`}><Workflow />Edit in Pipeline Studio</Link></Button>}
        {!editable && can(user, "scientist") && d && <Button size="sm" variant="primary" onClick={() => setForkOpen(true)}><GitFork />Edit as new pipeline</Button>}
        {editable && (
          <Tip content={`Saves your changes as ${nextLabel} of this copy (Ctrl+S). ${fs?.version ?? ""} and every earlier version stay as they are.`}>
            <Button size="sm" variant="primary" disabled={!dirty} loading={saving} onClick={save}><Save />Save as {nextLabel}</Button>
          </Tip>
        )}
      </div>
      {d && (
        <div className="border-b border-line bg-surface px-1.5">
          <PipelineTabs compact pid={id} kind={d.kind} hasReadme={!!d.readme} runCount={d.run_count} active="code" versionId={versionId} />
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        {treeOpen && <div className="absolute inset-0 z-[25] bg-black/50 md:hidden" onClick={() => setTreeOpen(false)} aria-hidden />}
        <FileTree files={all} open={open} onOpen={pickFile} changes={changes} added={added} editable={editable} onNew={newFile} loading={files.isLoading}
          drawer={treeOpen} onClose={() => setTreeOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col bg-ink/40">
          {files.isError && !fs ? (
            files.error instanceof ApiError && files.error.status === 404
              ? <Empty title="Pipeline not found" action={<Button asChild><Link to="/pipelines">All pipelines</Link></Button>}>It was deleted, or it is private to someone else.</Empty>
              : <div className="max-w-xl p-6"><QueryError error={files.error} onRetry={() => files.refetch()} what="the files of this pipeline" /></div>
          ) : open ? (
            <>
              <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-[12.5px]">
                <span className="min-w-0 flex-1 truncate font-mono" title={open}>{open}</span>
                {editable && !deleted && (
                  <span id="code-tab-hint" aria-live="polite" className={cn("hidden shrink-0 text-[11.5px] sm:inline", tabLeaves ? "text-accent" : "text-muted")}>
                    {tabLeaves ? "Tab now leaves the editor" : "Tab indents · Esc, then Tab to leave"}
                  </span>
                )}
                {open in changes && changes[open] !== null && !added.includes(open) && <Button size="sm" variant="ghost" onClick={() => revert(open)}><Undo2 />Undo changes</Button>}
                {deleted && <Button size="sm" variant="ghost" onClick={() => revert(open)}><Undo2 />Keep file</Button>}
                {editable && !deleted && <Button size="sm" variant="ghost" onClick={() => del(open)} aria-label={`Delete ${open}`} title="Delete this file"><Trash2 /></Button>}
              </div>
              {deleted ? <p className="p-6 text-[13px] text-muted">{open} will be deleted in {nextLabel}.</p>
                : content.isError && !added.includes(open) ? <div className="max-w-xl p-6"><QueryError error={content.error} onRetry={() => content.refetch()} what={open} /></div>
                : <CodeEditor value={text} onChange={setText} readOnly={!editable} loading={content.isLoading && !added.includes(open)} tabLeaves={tabLeaves} setTabLeaves={setTabLeaves} />}
            </>
          ) : <p className="p-6 text-[13px] text-muted">{files.isLoading ? "Loading files…" : <>Choose a file <span className="hidden md:inline">on the left</span><span className="md:hidden">with the Files button</span>.</>}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-line bg-surface px-3 py-1.5 text-[12px] text-muted">
        <span className="shrink-0">{all.length} file{all.length === 1 ? "" : "s"}</span>
        <span className="hidden min-w-0 flex-1 sm:block">
          {editable ? "Your copy: every save is a new version in its own folder; nothing is written over an earlier version, and the pipeline you copied is never changed."
            : "Read-only: this is an original. Use Edit as new pipeline to adapt it."}
        </span>
      </div>
      {d && <ForkDialog open={forkOpen} onOpenChange={setForkOpen} pid={d.id} name={d.name} version={fs?.version} versionId={fs?.version_id} studio={d.kind === "studio"} />}
    </div>
  );
}

/** The file list: a column from md up; below md a drawer over the editor, opened from the toolbar (`drawer`). */
function FileTree({ files, open, onOpen, changes, added, editable, onNew, loading, drawer, onClose }: {
  files: FileEntry[]; open: string | null; onOpen: (p: string) => void; changes: Record<string, string | null>; added: string[];
  editable: boolean; onNew: () => void; loading: boolean; drawer: boolean; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set(["tests", "modules", "subworkflows", "assets", "docs", ".github"]));
  const ql = q.trim().toLowerCase();
  // folders first, then files; a search shows matching files flat
  const tree = useMemo(() => {
    type Dir = { dirs: Map<string, Dir>; files: FileEntry[] };
    const root: Dir = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split("/");
      let d = root;
      for (const part of parts.slice(0, -1)) { if (!d.dirs.has(part)) d.dirs.set(part, { dirs: new Map(), files: [] }); d = d.dirs.get(part)!; }
      d.files.push(f);
    }
    return root;
  }, [files]);
  const mark = (path: string) => (changes[path] === null ? "deleted" : added.includes(path) ? "new" : path in changes ? "changed" : null);
  const row = (f: FileEntry, depth: number, label?: string) => {
    const m = mark(f.path);
    return (
      <button key={f.path} onClick={() => f.text && onOpen(f.path)} disabled={!f.text} aria-current={open === f.path}
        title={f.text ? f.path : `${f.path} (not a text file)`}
        style={{ paddingLeft: 12 + depth * 14 }}
        className={cn("flex w-full items-center gap-1.5 py-1 pr-3 text-left text-[12.5px] hover:bg-raised disabled:opacity-40", open === f.path && "bg-accent/10 text-text",
          m === "deleted" && "line-through")}>
        <FileText className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{label ?? f.path.split("/").pop()}</span>
        {m && <span className={cn("text-[10px]", m === "deleted" ? "text-bad" : "text-wait")}>{m}</span>}
      </button>
    );
  };
  type Dir = { dirs: Map<string, Dir>; files: FileEntry[] };
  const render = (d: Dir, prefix: string, depth: number): React.ReactNode[] => [
    ...[...d.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, sub]) => {
      const path = prefix ? `${prefix}/${name}` : name;
      const isClosed = closed.has(path);
      return [
        <button key={`d:${path}`} onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(path)) n.delete(path); else n.add(path); return n; })}
          style={{ paddingLeft: 8 + depth * 14 }} className="flex w-full items-center gap-1 py-1 pr-3 text-left text-[12.5px] text-muted hover:bg-raised">
          {isClosed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}<Folder className="size-3.5" />{name}
        </button>,
        ...(isClosed ? [] : render(sub, path, depth + 1)),
      ];
    }),
    ...d.files.sort((a, b) => a.path.localeCompare(b.path)).map((f) => row(f, depth)),
  ];
  return (
    <aside id="pipeline-file-list" aria-label="Files" onKeyDown={(e) => { if (e.key === "Escape" && drawer) onClose(); }}
      className={cn("w-72 shrink-0 flex-col border-r border-line bg-surface md:static md:flex md:max-w-none md:shadow-none",
        drawer ? "absolute inset-y-0 left-0 z-30 flex max-w-[85vw] shadow-2xl shadow-black/40" : "hidden")}>
      <div className="space-y-2 border-b border-line p-3">
        <div className="flex items-center justify-between md:hidden">
          <span className="text-[13px] font-medium">Files</span>
          <button onClick={onClose} aria-label="Close the file list" className="rounded p-1 text-muted hover:bg-raised hover:text-text"><X className="size-4" /></button>
        </div>
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a file" aria-label="Find a file"
            className="h-8 w-full rounded-md border border-line bg-ink/40 pl-8 pr-2 text-[13px] placeholder:text-muted/70 focus:border-accent focus:outline-none" />
        </label>
        {editable && <Button size="sm" variant="secondary" className="w-full" onClick={onNew}><FilePlus2 />New file</Button>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading && <p className="px-3 py-2 text-[13px] text-muted">Loading…</p>}
        {ql ? files.filter((f) => f.path.toLowerCase().includes(ql)).map((f) => row(f, 0, f.path)) : render(tree, "", 0)}
        {ql && !files.some((f) => f.path.toLowerCase().includes(ql)) && <p className="px-3 py-2 text-[13px] text-muted">No file matches.</p>}
      </div>
    </aside>
  );
}

const MODIFIERS = ["Shift", "Control", "Alt", "Meta", "CapsLock"];

/**
 * Plain-text editor with line numbers (no external editor library). Tab inserts four spaces; so that the keyboard is
 * not trapped, Esc releases it: the next Tab (or Shift+Tab) moves focus as usual. Typing or coming back re-arms it.
 */
function CodeEditor({ value, onChange, readOnly, loading, tabLeaves, setTabLeaves }: {
  value: string; onChange: (v: string) => void; readOnly: boolean; loading: boolean; tabLeaves: boolean; setTabLeaves: (v: boolean) => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split("\n").length, [value]);
  if (loading) return <p className="p-6 text-[13px] text-muted">Loading…</p>;
  return (
    <div className="relative flex min-h-0 flex-1 font-mono text-[12.5px] leading-[1.6]">
      <div ref={gutter} aria-hidden className="w-14 shrink-0 select-none overflow-hidden border-r border-line/60 bg-surface/60 py-3 pr-2 text-right text-muted/70">
        {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <textarea ref={ta} value={value} readOnly={readOnly} spellCheck={false} aria-label="File contents" aria-describedby={readOnly ? undefined : "code-tab-hint"}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setTabLeaves(false)} onBlur={() => setTabLeaves(false)}
        onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
        onKeyDown={(e) => {
          if (readOnly) return;
          if (e.key === "Escape") { setTabLeaves(true); return; }
          if (e.key !== "Tab") { if (tabLeaves && !MODIFIERS.includes(e.key)) setTabLeaves(false); return; }
          if (tabLeaves || e.ctrlKey || e.metaKey || e.altKey) return; // released with Esc: let the browser move focus
          e.preventDefault();
          const el = e.currentTarget; const s = el.selectionStart; const t = el.selectionEnd;
          onChange(value.slice(0, s) + "    " + value.slice(t));
          requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 4; });
        }}
        className={cn("min-h-0 flex-1 resize-none whitespace-pre bg-transparent px-3 py-3 text-text outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0", readOnly && "text-text/90")}
        wrap="off" />
    </div>
  );
}
