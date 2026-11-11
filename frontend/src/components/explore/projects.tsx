import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { File, Folder, FolderPlus, FolderTree, ListPlus, Play, Plus, Trash2, X } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { Project, ProjectDetail, ProjectItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { ShareButton, SharingBadge } from "@/components/sharing";

export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });

/** Left-pane project switcher; with a project chosen, its folders, files and runs are one click away. */
export function ProjectPanel({ projectId, onSelect, currentDir, onOpenDir, onOpenFile }: {
  projectId: string | null; onSelect: (id: string | null) => void; currentDir: string | null;
  onOpenDir: (vpath: string) => void; onOpenFile: (vpath: string) => void;
}) {
  const qc = useQueryClient();
  const sci = can(useAuth((s) => s.user), "scientist");
  const list = useProjects();
  const p = useQuery({ queryKey: ["project", projectId], queryFn: () => api.get<ProjectDetail>(`/api/projects/${projectId}`), enabled: !!projectId, retry: false });
  const [creating, setCreating] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["project"] }); qc.invalidateQueries({ queryKey: ["projects"] }); };
  useEffect(() => { if (p.isError) onSelect(null); }, [p.isError, onSelect]);

  const addDir = async () => {
    if (!projectId || !currentDir) return;
    try { await api.post(`/api/projects/${projectId}/items`, { ref: currentDir }); refresh(); toast.success("Folder added to the project"); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async (it: ProjectItem) => {
    try { await api.del(`/api/projects/${projectId}/items/${it.id}`); refresh(); } catch (e) { toast.error(errMsg(e)); }
  };
  const open = (it: ProjectItem) => {
    if (it.kind === "run") { if (it.output) onOpenDir(it.output); else toast.error("This run's outputs are not in a data folder"); }
    else if (it.kind === "folder") onOpenDir(it.ref);
    else onOpenFile(it.ref);
  };
  const d = p.data;

  return (
    <div className="border-b border-line p-3 space-y-2">
      <div className="flex gap-1.5">
        <Select aria-label="Project" className="h-8" value={projectId ?? ""} onChange={(e) => (e.target.value === "__new" ? setCreating(true) : onSelect(e.target.value || null))}>
          <option value="">All data folders</option>
          {(list.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}{x.owner && x.visibility === "lab" ? " (shared)" : ""}</option>)}
          {sci && <option value="__new">+ New project…</option>}
        </Select>
        {projectId && <Button size="icon" variant="ghost" className="size-8" onClick={() => onSelect(null)} aria-label="Leave project"><X /></Button>}
      </div>
      {d && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <SharingBadge owner={d.owner} visibility={d.visibility} />
            {d.can_edit && <ShareButton visibility={d.visibility} onChange={async (v) => { try { await api.patch(`/api/projects/${d.id}`, { visibility: v }); refresh(); } catch (e) { toast.error(errMsg(e)); } }} />}
          </div>
          {d.description && <p className="text-[12px] text-muted">{d.description}</p>}
          {d.home && (
            <div className="flex flex-wrap gap-1">
              {(["data", "results", "analyses"] as const).map((k) => (
                <button key={k} onClick={() => onOpenDir(d.folders[k]!)} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11.5px] text-muted hover:text-text">
                  <FolderTree className="size-3" />{k}
                </button>
              ))}
            </div>
          )}
          <ul className="max-h-48 space-y-0.5 overflow-y-auto">
            {d.items.length === 0 && <li className="text-[12px] text-muted">Nothing here yet. Browse to a folder or file and add it, or launch runs into this project.</li>}
            {d.items.map((it) => {
              const Icon = it.kind === "run" ? Play : it.kind === "folder" ? Folder : File;
              return (
                <li key={it.id} className="group flex items-center gap-1">
                  <button onClick={() => open(it)} disabled={!it.exists} title={it.ref}
                    className={cn("flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] hover:bg-raised", !it.exists && "opacity-50 line-through")}>
                    <Icon className="size-3.5 shrink-0 text-accent" /><span className="truncate">{it.label}</span>
                    {it.kind === "run" && it.status && <span className="ml-auto text-[10.5px] text-muted">{it.status}</span>}
                  </button>
                  {d.can_edit && <button onClick={() => remove(it)} className="rounded p-1 text-muted opacity-0 hover:text-bad group-hover:opacity-100 focus:opacity-100" aria-label={`Remove ${it.label} from the project`}><X className="size-3" /></button>}
                </li>
              );
            })}
          </ul>
          {d.can_edit && currentDir && !d.items.some((i) => i.ref === currentDir) && (
            <Button size="sm" variant="ghost" className="h-7 w-full justify-start" onClick={addDir}><Plus />Add this folder ({currentDir.split(/[:/]/).filter(Boolean).pop()})</Button>
          )}
          {d.can_edit && (
            <button className="text-[11.5px] text-muted hover:text-bad" onClick={async () => {
              if (!window.confirm(`Delete the project “${d.name}”? Its folders and files stay on disk.`)) return;
              try { await api.del(`/api/projects/${d.id}`); onSelect(null); refresh(); } catch (e) { toast.error(errMsg(e)); }
            }}><Trash2 className="mr-1 inline size-3" />Delete project</button>
          )}
        </div>
      )}
      <NewProjectDialog open={creating} onOpenChange={setCreating} onCreated={(id) => { refresh(); onSelect(id); }} />
    </div>
  );
}

function NewProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const roots = useQuery({ queryKey: ["roots"], queryFn: () => api.get<{ name: string; writable: boolean }[]>("/api/datasets/roots") });
  const writable = (roots.data ?? []).filter((r) => r.writable);
  const [f, setF] = useState({ name: "", description: "", visibility: "private" as "private" | "lab", home_root: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setF({ name: "", description: "", visibility: "private", home_root: writable[0]?.name ?? "" }); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const slug = f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  const submit = async () => {
    setBusy(true);
    try {
      const p = await api.post<ProjectDetail>("/api/projects", { name: f.name, description: f.description, visibility: f.visibility, home_root: f.home_root || null });
      toast.success(p.home ? `Created ${p.home} with data/, results/ and analyses/` : "Project created");
      onCreated(p.id);
      onOpenChange(false);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New project" description="Keep one study's data together: its folders, files, runs and saved analyses.">
        <div className="space-y-4">
          <Field label="Name"><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. H3K27ac in differentiation 2026" /></Field>
          <Field label="Description (optional)"><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Project folder" hint={f.home_root ? `Creates ${f.home_root}:projects/${slug}/ with data/, results/ and analyses/. Runs can write their results there and saved analyses land in analyses/.` : "No folder: the project only collects existing folders, files and runs."}>
            <Select value={f.home_root} onChange={(e) => setF({ ...f, home_root: e.target.value })}>
              {writable.map((r) => <option key={r.name} value={r.name}>Create it in {r.name}</option>)}
              <option value="">No project folder</option>
            </Select>
          </Field>
          <Field label="Who can see it">
            <Select value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value as "private" | "lab" })}>
              <option value="private">Only me</option><option value="lab">Everyone in the lab</option>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!f.name.trim()} onClick={submit}><FolderPlus />Create project</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Add to project" for the file being viewed. */
export function AddToProject({ path, current }: { path: string; current: string | null }) {
  const qc = useQueryClient();
  const list = useProjects();
  const editable = (list.data ?? []).filter((p) => p.can_edit);
  const add = async (pid: string) => {
    try {
      await api.post(`/api/projects/${pid}/items`, { ref: path });
      qc.invalidateQueries({ queryKey: ["project"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`Added to ${editable.find((p) => p.id === pid)?.name}`);
    } catch (e) { toast.error(errMsg(e)); }
  };
  if (!editable.length) return null;
  if (current && editable.some((p) => p.id === current)) {
    return <Button size="sm" variant="secondary" onClick={() => add(current)}><ListPlus />Add to project</Button>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="sm" variant="secondary"><ListPlus />Add to project</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Projects you can change</DropdownMenuLabel>
        {editable.map((p) => <DropdownMenuItem key={p.id} onSelect={() => add(p.id)}><FolderTree />{p.name}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
