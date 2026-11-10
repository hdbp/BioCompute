import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, File, FileText, Folder, FolderPlus, HardDrive, Lock, Search } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import type { DataRoot, Listing } from "@/lib/types";
import { bytes, cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Checkbox, Empty, Skeleton } from "@/components/ui/misc";
import { toast } from "sonner";

export type PickMode = "file" | "files" | "dir";

const KIND_TONE: Record<string, string> = {
  fastq: "text-run", bam: "text-accent", "ms-raw": "text-wait", table: "text-ok", report: "text-ok", bed: "text-[#f472b6]",
};

/** Browse configured data roots and pick files or a directory. Returns virtual paths ("root:rel/path"). */
export function FileBrowser({ open, onOpenChange, mode, onPick, title, start, kinds, writableOnly }: {
  open: boolean; onOpenChange: (o: boolean) => void; mode: PickMode; onPick: (paths: string[]) => void;
  title?: string; start?: string; kinds?: string[]; writableOnly?: boolean;
}) {
  const qc = useQueryClient();
  const roots = useQuery({ queryKey: ["roots"], queryFn: () => api.get<DataRoot[]>("/api/datasets/roots"), enabled: open });
  const [path, setPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [newDir, setNewDir] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setFilter("");
    if (start && start.includes(":")) setPath(start);
  }, [open, start]);

  useEffect(() => {
    if (open && !path && roots.data?.length) {
      const r = roots.data.find((x) => !writableOnly || x.writable) ?? roots.data[0];
      setPath(`${r.name}:`);
    }
  }, [open, path, roots.data, writableOnly]);

  const listing = useQuery({
    queryKey: ["browse", path],
    queryFn: () => api.get<Listing>(`/api/datasets/browse${qs({ path: path! })}`),
    enabled: open && !!path,
    retry: false,
  });

  const entries = useMemo(() => {
    const f = filter.toLowerCase();
    return (listing.data?.entries ?? []).filter((e) => !f || e.name.toLowerCase().includes(f));
  }, [listing.data, filter]);
  const selectable = (kind: string, type: string) =>
    mode === "dir" ? type === "dir" : type === "file" && (!kinds || kinds.includes(kind));
  const crumbs = useMemo(() => {
    if (!path) return [];
    const [root, rel] = path.split(":");
    const parts = rel ? rel.split("/").filter(Boolean) : [];
    return [{ label: root, path: `${root}:` }, ...parts.map((p, i) => ({ label: p, path: `${root}:${parts.slice(0, i + 1).join("/")}` }))];
  }, [path]);

  const toggle = (p: string) => {
    if (mode === "files") setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));
    else setSelected([p]);
  };
  const selectAllVisible = () => setSelected(entries.filter((e) => selectable(e.kind, e.type)).map((e) => e.path));
  const rootInfo = listing.data?.root;

  async function createDir() {
    if (!newDir || !path) return;
    const target = `${path}${path.endsWith(":") ? "" : "/"}${newDir}`;
    try {
      await api.post("/api/datasets/mkdir", { path: target });
      setNewDir(null);
      await qc.invalidateQueries({ queryKey: ["browse", path] });
      setPath(target);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  const confirm = () => {
    const out = mode === "dir" ? (selected.length ? selected : path ? [path] : []) : selected;
    if (!out.length) return;
    onPick(out);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide title={title ?? (mode === "dir" ? "Choose a folder" : "Choose files")}
        description="Only folders inside the data roots configured for this controller are visible.">
        <div className="grid grid-cols-[180px_1fr] gap-4 min-h-[380px]">
          <nav className="space-y-0.5 border-r border-line pr-3" aria-label="Data roots">
            {roots.isLoading && <Skeleton className="h-8" />}
            {roots.data?.length === 0 && <p className="text-xs text-muted">No data roots configured. Set BIOCOMPUTE_DATA_ROOTS on the controller.</p>}
            {roots.data?.map((r) => (
              <button key={r.name} onClick={() => setPath(`${r.name}:`)} disabled={writableOnly && !r.writable}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-raised disabled:opacity-40",
                  path?.startsWith(`${r.name}:`) && "bg-raised text-text")}>
                <HardDrive className="size-4 text-muted" />
                <span className="truncate flex-1">{r.name}</span>
                {r.restricted && <Lock className="size-3 text-wait" aria-label="restricted data" />}
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <div className="flex min-w-0 flex-1 items-center gap-0.5 text-[13px] overflow-x-auto">
                {crumbs.map((c, i) => (
                  <span key={c.path} className="flex items-center gap-0.5 shrink-0">
                    {i > 0 && <ChevronRight className="size-3.5 text-muted" />}
                    <button className="rounded px-1 hover:bg-raised" onClick={() => setPath(c.path)}>{c.label}</button>
                  </span>
                ))}
              </div>
              <div className="relative w-40">
                <Search className="absolute left-2 top-2.5 size-3.5 text-muted" />
                <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="pl-7 h-8" aria-label="Filter files" />
              </div>
            </div>
            {rootInfo && (
              <div className="mb-2 flex gap-1.5">
                {rootInfo.restricted && <Badge tone="wait"><Lock className="size-3" />Restricted: stays on lab site</Badge>}
                <Badge>{rootInfo.writable ? "Writable" : "Read-only"}</Badge>
              </div>
            )}
            <div className="flex-1 overflow-y-auto rounded-md border border-line max-h-[46vh]">
              {listing.isLoading && <div className="p-3 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-6" />)}</div>}
              {listing.isError && <p className="p-4 text-[13px] text-bad">{errMsg(listing.error)}</p>}
              {listing.data && entries.length === 0 && <Empty title="This folder is empty" className="py-10" />}
              <ul role="listbox" aria-multiselectable={mode === "files"}>
                {entries.map((e) => {
                  const sel = selected.includes(e.path);
                  const can = selectable(e.kind, e.type);
                  return (
                    <li key={e.path} role="option" aria-selected={sel}
                      className={cn("group flex items-center gap-2.5 px-3 py-1.5 text-[13px] border-b border-line/50 last:border-0",
                        sel ? "bg-accent/10" : "hover:bg-raised/60", !can && e.type === "file" && "opacity-50")}
                      onClick={() => (can ? toggle(e.path) : e.type === "dir" && setPath(e.path))}
                      onDoubleClick={() => e.type === "dir" && setPath(e.path)}>
                      {mode === "files" && <Checkbox checked={sel} disabled={!can} onClick={(ev) => ev.stopPropagation()} onCheckedChange={() => can && toggle(e.path)} aria-label={`Select ${e.name}`} />}
                      {e.type === "dir" ? <Folder className="size-4 text-accent" /> : e.kind === "table" ? <FileText className="size-4 text-muted" /> : <File className="size-4 text-muted" />}
                      <span className="flex-1 truncate">{e.name}</span>
                      {e.type === "file" && <span className={cn("text-[11px]", KIND_TONE[e.kind] ?? "text-muted")}>{e.kind !== "file" ? e.kind : ""}</span>}
                      <span className="w-20 text-right text-xs text-muted tabular-nums">{e.type === "file" ? bytes(e.size) : ""}</span>
                      {e.type === "dir" && (
                        <button className="rounded p-0.5 text-muted hover:text-text" onClick={(ev) => { ev.stopPropagation(); setPath(e.path); }} aria-label={`Open ${e.name}`}>
                          <ChevronRight className="size-4" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted">
              {mode === "files" && entries.some((e) => selectable(e.kind, e.type)) && (
                <button className="hover:text-text underline-offset-2 hover:underline" onClick={selectAllVisible}>Select all {kinds?.join("/") ?? ""} files here</button>
              )}
              {mode === "dir" && rootInfo?.writable && (newDir === null
                ? <button className="inline-flex items-center gap-1 hover:text-text" onClick={() => setNewDir("")}><FolderPlus className="size-3.5" />New folder</button>
                : <span className="flex items-center gap-1.5">
                    <Input autoFocus value={newDir} onChange={(e) => setNewDir(e.target.value.replace(/[^\w.-]/g, "_"))} className="h-7 w-44" placeholder="folder name"
                      onKeyDown={(e) => e.key === "Enter" && createDir()} />
                    <Button size="sm" onClick={createDir}>Create</Button>
                  </span>)}
              <span className="ml-auto">{mode === "dir" ? `Selected: ${(selected[0] ?? path) || "—"}` : `${selected.length} selected`}</span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={confirm} disabled={mode !== "dir" && !selected.length}>
            {mode === "dir" ? "Use this folder" : `Add ${selected.length || ""} file${selected.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Input + browse button for a single virtual path. */
export function PathInput({ value, onChange, mode, placeholder, kinds, writableOnly, invalid, id }: {
  value: string; onChange: (v: string) => void; mode: "file" | "dir"; placeholder?: string; kinds?: string[]; writableOnly?: boolean; invalid?: boolean; id?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-1.5">
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? (mode === "dir" ? "root:folder" : "root:path/to/file")}
        className="font-mono text-[12px]" aria-invalid={invalid} />
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Browse</Button>
      <FileBrowser open={open} onOpenChange={setOpen} mode={mode} kinds={kinds} writableOnly={writableOnly}
        start={value && value.includes(":") ? (mode === "dir" ? value : value.slice(0, value.lastIndexOf("/") > 0 ? value.lastIndexOf("/") : value.indexOf(":") + 1)) : undefined}
        onPick={(p) => onChange(p[0])} />
    </div>
  );
}
