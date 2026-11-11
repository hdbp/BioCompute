import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowUp, Folder, FolderPlus, HardDrive, Loader2, Lock } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface Listing {
  path: string; parent: string | null; files: number; writable: boolean;
  entries: { name: string; path: string; readable: boolean; writable: boolean }[];
  shortcuts: { label: string; path: string }[];
}

/** Administrators: pick (or create) a folder on the controller to add as a data folder. Folders only, no file names. */
export function ControllerFolderPicker({ open, onOpenChange, start, onPick }: {
  open: boolean; onOpenChange: (o: boolean) => void; start?: string; onPick: (path: string) => void;
}) {
  const [path, setPath] = useState<string | undefined>(start || undefined);
  const [typed, setTyped] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (open) { setPath(start || undefined); setNewName(""); } }, [open, start]);
  const q = useQuery({
    queryKey: ["controller-folders", path ?? "~"],
    queryFn: () => api.get<Listing>(`/api/datasets/roots/folders${qs({ path })}`),
    enabled: open, retry: false,
  });
  useEffect(() => { if (q.data) setTyped(q.data.path); }, [q.data]);
  const d = q.data;

  const create = async () => {
    if (!d || !newName.trim()) return;
    setCreating(true);
    try {
      const r = await api.post<{ path: string }>("/api/datasets/roots/folders", { parent: d.path, name: newName.trim() });
      toast.success(`Created ${r.path}`);
      setNewName("");
      setPath(r.path);
    } catch (e) { toast.error(errMsg(e)); } finally { setCreating(false); }
  };

  const crumbs = (d?.path ?? "").split("/").filter(Boolean);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide title="Choose a folder on the controller" description="Folders on the computer running BioCompute. Only folder names are shown.">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {(d?.shortcuts ?? []).map((s) => (
              <button key={s.path} onClick={() => setPath(s.path)} className={cn("inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[12px] hover:bg-raised", d?.path === s.path && "border-accent text-accent")}>
                <HardDrive className="size-3" />{s.label}
              </button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) setPath(typed.trim()); }}>
            <Input aria-label="Folder path" className="font-mono text-[12.5px]" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <Button type="submit" size="sm" variant="secondary">Go</Button>
          </form>
          {d && (
            <nav className="flex flex-wrap items-center gap-0.5 text-[12px] text-muted" aria-label="Folder path">
              <button className="hover:text-text" onClick={() => setPath("/")}>/</button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-0.5">
                  <button className="hover:text-text" onClick={() => setPath("/" + crumbs.slice(0, i + 1).join("/"))}>{c}</button>
                  {i < crumbs.length - 1 && <span>/</span>}
                </span>
              ))}
            </nav>
          )}
          <div className="h-72 overflow-y-auto rounded-lg border border-line">
            {q.isLoading && <p className="flex items-center gap-2 p-3 text-[13px] text-muted"><Loader2 className="size-4 animate-spin" />Loading…</p>}
            {q.isError && <p className="p-3 text-[13px] text-bad">{errMsg(q.error)}</p>}
            {d && (
              <ul>
                {d.parent && (
                  <li><button onClick={() => setPath(d.parent!)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted hover:bg-raised"><ArrowUp className="size-3.5" />Up</button></li>
                )}
                {d.entries.map((e) => (
                  <li key={e.path}>
                    <button onClick={() => e.readable && setPath(e.path)} disabled={!e.readable} title={e.readable ? e.path : "Not readable by the account running BioCompute"}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-raised disabled:opacity-50">
                      {e.readable ? <Folder className="size-3.5 text-accent" /> : <Lock className="size-3.5" />}
                      <span className="truncate">{e.name}</span>
                    </button>
                  </li>
                ))}
                {d.entries.length === 0 && <li className="px-3 py-4 text-[13px] text-muted">No sub-folders.</li>}
              </ul>
            )}
          </div>
          {d && <p className="text-xs text-muted">{d.entries.length} folder{d.entries.length === 1 ? "" : "s"}{d.files ? ` and ${d.files} file${d.files === 1 ? "" : "s"}` : ""} in {d.path}</p>}
          {d?.writable && (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); create(); }}>
              <Input aria-label="New folder name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={`New folder in ${d.path.split("/").pop() || "/"}`} />
              <Button type="submit" size="sm" variant="secondary" loading={creating} disabled={!newName.trim()}><FolderPlus />Create</Button>
            </form>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!d} onClick={() => { if (d) { onPick(d.path); onOpenChange(false); } }}>Use this folder</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
