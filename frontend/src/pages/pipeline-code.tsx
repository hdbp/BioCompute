import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ChevronDown, ChevronRight, FileCode2, FilePlus2, FileText, Folder, GitFork, Info, Lock, Network, Save, Search, Trash2, Undo2 } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { PipelineDetail } from "@/lib/types";
import { cn, when } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge, Tip } from "@/components/ui/misc";
import { ForkDialog } from "@/components/fork-dialog";

interface FileEntry { path: string; size: number; text: boolean }
interface FilesResponse { version_id: string; version: string; editable: boolean; files: FileEntry[] }

const FIRST = ["main.nf", "nextflow.config", "nextflow_schema.json", "conf/base.config", "conf/modules.config"];

/** A pipeline's code. Your own copies are editable; each save is a new version. Originals are read-only. */
export default function PipelineCodePage() {
  const { id = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const p = useQuery({ queryKey: ["pipeline", id], queryFn: () => api.get<PipelineDetail>(`/api/pipelines/${id}`) });
  const versionId = sp.get("version") ?? undefined;
  const files = useQuery({ queryKey: ["pipeline-files", id, versionId ?? null], queryFn: () => api.get<FilesResponse>(`/api/pipelines/${id}/files${qs({ version_id: versionId })}`) });
  const d = p.data;
  const fs = files.data;
  const editable = !!fs?.editable;

  // edits not saved yet: path -> new content (null = delete); kept across file switches
  const [changes, setChanges] = useState<Record<string, string | null>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const dirty = Object.keys(changes).length > 0;
  useEffect(() => { setChanges({}); setAdded([]); setOpen(null); }, [fs?.version_id]);
  useEffect(() => {
    if (!fs || open) return;
    const first = FIRST.find((f) => fs.files.some((x) => x.path === f)) ?? fs.files.find((x) => x.text)?.path ?? null;
    setOpen(first);
  }, [fs, open]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

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

  const newFile = () => {
    const path = window.prompt("Path of the new file, e.g. modules/local/my_tool/main.nf");
    if (!path?.trim()) return;
    const clean = path.trim().replace(/^\/+/, "");
    if (fs?.files.some((f) => f.path === clean) || added.includes(clean)) { setOpen(clean); return; }
    setAdded((a) => [...a, clean]);
    setChanges((c) => ({ ...c, [clean]: "" }));
    setOpen(clean);
  };
  const del = (path: string) => {
    if (!window.confirm(`Delete ${path} in the next version? Earlier versions keep it.`)) return;
    if (added.includes(path)) {
      setAdded((a) => a.filter((x) => x !== path));
      setChanges((c) => { const n = { ...c }; delete n[path]; return n; });
    } else setChanges((c) => ({ ...c, [path]: null }));
  };
  const revert = (path: string) => setChanges((c) => { const n = { ...c }; delete n[path]; return n; });
  const switchVersion = (vid: string) => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    setSp(vid === d?.latest_version?.id ? {} : { version: vid }, { replace: true });
  };

  const all = useMemo(() => [...(fs?.files ?? []), ...added.map((path) => ({ path, size: 0, text: true }))], [fs, added]);
  const current = versionId ?? d?.latest_version?.id ?? "";
  const nextLabel = d ? `v${Math.max(0, ...d.versions.map((v) => Number(/^v(\d+)$/.exec(v.version)?.[1] ?? 0))) + 1}` : "";
  const deleted = open ? changes[open] === null : false;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Button asChild size="icon" variant="ghost" aria-label="Back to the map" title="Back to the map"><Link to={`/pipelines/${id}/map${qs({ version: versionId })}`}><ArrowLeft /></Link></Button>
        <FileCode2 className="size-4 text-accent" />
        <span className="max-w-[28ch] truncate text-[14px] font-semibold" title={d?.name}>{d?.name ?? "Pipeline"}</span>
        {fs && (editable ? <Badge tone="ok">your copy</Badge> : <Tip content="Originals are never changed. Edit as new pipeline makes your own copy."><Badge tone="wait" className="cursor-help"><Lock className="size-3" />read-only original</Badge></Tip>)}
        {d && d.versions.length > 0 && (
          <Select className="h-8 w-auto" aria-label="Version" value={current} onChange={(e) => switchVersion(e.target.value)}>
            {[...d.versions].reverse().map((v) => <option key={v.id} value={v.id}>{v.version}{v.id === d.latest_version?.id ? " (current)" : ""} · {when(v.created_at)}</option>)}
          </Select>
        )}
        {dirty && <Badge tone="wait">{Object.keys(changes).length} unsaved</Badge>}
        <div className="flex-1" />
        <Button asChild size="sm" variant="ghost"><Link to={`/pipelines/${id}/map${qs({ version: versionId })}`}><Network />Map</Link></Button>
        <Button asChild size="sm" variant="ghost"><Link to={`/pipelines/${id}`}><Info />Details</Link></Button>
        {!editable && can(user, "scientist") && d && <Button size="sm" variant="primary" onClick={() => setForkOpen(true)}><GitFork />Edit as new pipeline</Button>}
        {editable && (
          <Tip content={`Saves your changes as ${nextLabel} of this copy (Ctrl+S). ${fs?.version ?? ""} and every earlier version stay as they are.`}>
            <Button size="sm" variant="primary" disabled={!dirty} loading={saving} onClick={save}><Save />Save as {nextLabel}</Button>
          </Tip>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <FileTree files={all} open={open} onOpen={setOpen} changes={changes} added={added} editable={editable} onNew={newFile} loading={files.isLoading} />
        <div className="flex min-w-0 flex-1 flex-col bg-ink/40">
          {open ? (
            <>
              <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-[12.5px]">
                <span className="min-w-0 flex-1 truncate font-mono">{open}</span>
                {open in changes && changes[open] !== null && !added.includes(open) && <Button size="sm" variant="ghost" onClick={() => revert(open)}><Undo2 />Undo changes</Button>}
                {deleted && <Button size="sm" variant="ghost" onClick={() => revert(open)}><Undo2 />Keep file</Button>}
                {editable && !deleted && <Button size="sm" variant="ghost" onClick={() => del(open)} aria-label={`Delete ${open}`}><Trash2 /></Button>}
              </div>
              {deleted ? <p className="p-6 text-[13px] text-muted">{open} will be deleted in {nextLabel}.</p>
                : content.isError && !added.includes(open) ? <p className="p-6 text-[13px] text-muted">{errMsg(content.error)}</p>
                : <CodeEditor value={text} onChange={setText} readOnly={!editable} loading={content.isLoading && !added.includes(open)} />}
            </>
          ) : <p className="p-6 text-[13px] text-muted">{files.isLoading ? "Loading files…" : "Choose a file on the left."}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-line bg-surface px-3 py-1.5 text-[12px] text-muted">
        <span>{all.length} files</span>
        <span className="min-w-0 flex-1">
          {editable ? "Your copy: every save is a new version in its own folder; nothing is written over an earlier version, and the pipeline you copied is never changed."
            : "Read-only: this is an original. Use Edit as new pipeline to adapt it."}
        </span>
      </div>
      {d && <ForkDialog open={forkOpen} onOpenChange={setForkOpen} pid={d.id} name={d.name} version={fs?.version} versionId={fs?.version_id} studio={d.kind === "studio"} />}
    </div>
  );
}

function FileTree({ files, open, onOpen, changes, added, editable, onNew, loading }: {
  files: FileEntry[]; open: string | null; onOpen: (p: string) => void; changes: Record<string, string | null>; added: string[];
  editable: boolean; onNew: () => void; loading: boolean;
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
    <aside className="hidden w-72 shrink-0 flex-col border-r border-line bg-surface md:flex" aria-label="Files">
      <div className="space-y-2 border-b border-line p-3">
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
      </div>
    </aside>
  );
}

/** Plain-text editor with line numbers (no external editor library). Tab inserts four spaces. */
function CodeEditor({ value, onChange, readOnly, loading }: { value: string; onChange: (v: string) => void; readOnly: boolean; loading: boolean }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split("\n").length, [value]);
  if (loading) return <p className="p-6 text-[13px] text-muted">Loading…</p>;
  return (
    <div className="relative flex min-h-0 flex-1 font-mono text-[12.5px] leading-[1.6]">
      <div ref={gutter} aria-hidden className="w-14 shrink-0 select-none overflow-hidden border-r border-line/60 bg-surface/60 py-3 pr-2 text-right text-muted/70">
        {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <textarea ref={ta} value={value} readOnly={readOnly} spellCheck={false} aria-label="File contents"
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
        onKeyDown={(e) => {
          if (e.key !== "Tab" || readOnly) return;
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
