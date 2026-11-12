import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArchiveRestore, Download, ExternalLink, FileCode2, GitFork, Globe2, Lock, Map as MapIcon, MoreHorizontal, Pencil, Play,
  SlidersHorizontal, Star, Trash2, Workflow,
} from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { Pipeline } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { Field, Input, Textarea } from "@/components/ui/input";
import { ForkDialog } from "@/components/fork-dialog";
import { usePipelineUninstall } from "@/components/uninstall";

interface Entry { key: string; label: string; icon: ReactNode; run: () => void; danger?: boolean; title?: string }
type Group = Entry[];

/** The actions on one pipeline, for its right-click menu and its "…" button (the same list in both). */
export function usePipelineMenu(p: Pipeline, opts: { onInstall?: () => void } = {}) {
  const user = useAuth((s) => s.user);
  const sci = can(user, "scientist");
  const nav = useNavigate();
  const qc = useQueryClient();
  const [fork, setFork] = useState(false);
  const [details, setDetails] = useState(false);
  const { ask: askUninstall, restore } = usePipelineUninstall();
  const refresh = () => { qc.invalidateQueries({ queryKey: ["pipelines"] }); qc.invalidateQueries({ queryKey: ["pipeline", p.id] }); };
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => p.studio_workflow_id && "visibility" in body
      ? api.put(`/api/studio/workflows/${p.studio_workflow_id}/visibility`, body)   // follows its Studio workflow
      : api.patch(`/api/pipelines/${p.id}`, body),
    onSuccess: (_r, body) => {
      refresh();
      if ("visibility" in body) toast.success(body.visibility === "lab" ? `${p.name} is shared with the lab` : `${p.name} is private to you`);
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const groups: Group[] = [];
  if (p.kind === "template") {
    groups.push([
      ...(sci && opts.onInstall ? [{ key: "install", label: "Install…", icon: <Download />, run: opts.onInstall }] : []),
      { key: "open", label: "Details", icon: <SlidersHorizontal />, run: () => nav(`/pipelines/${p.id}`) },
      ...(p.source_url ? [{ key: "repo", label: "Open its repository", icon: <ExternalLink />, run: () => window.open(p.source_url!, "_blank", "noopener") }] : []),
    ]);
  } else if (p.archived) {
    groups.push([
      { key: "open", label: "Details, versions and runs", icon: <SlidersHorizontal />, run: () => nav(`/pipelines/${p.id}`) },
      ...(p.can_edit ? [{ key: "restore", label: "Restore", icon: <ArchiveRestore />, run: () => restore.mutate(p) }] : []),
    ]);
  } else {
    groups.push([
      { key: "run", label: "Configure and run", icon: <Play />, run: () => nav(`/jobs/new?pipeline=${p.id}`) },
      { key: "map", label: "Open map", icon: <MapIcon />, run: () => nav(`/pipelines/${p.id}/map`) },
      { key: "params", label: "Parameters, versions and runs", icon: <SlidersHorizontal />, run: () => nav(`/pipelines/${p.id}`) },
    ]);
    const edit: Group = [];
    if (p.kind === "studio" && p.studio_workflow_id && p.can_edit) {
      edit.push({ key: "studio", label: "Edit in Pipeline Studio", icon: <Workflow />, run: () => nav(`/studio/${p.studio_workflow_id}`) });
    } else {
      // only copies are changed in place; an original opens read-only (Make a copy to change it)
      const copy = /^(copy|duplicate):/.test(p.source_url ?? "");
      edit.push({ key: "studio", label: copy && p.can_edit ? "Edit in Pipeline Studio" : "Open in Pipeline Studio", icon: <Workflow />, run: () => nav(`/studio/pipeline/${p.id}`),
                  title: copy && p.can_edit ? undefined : "Read-only there: Make a copy to change it" });
    }
    edit.push({ key: "code", label: "Code", icon: <FileCode2 />, run: () => nav(`/pipelines/${p.id}/code`) });
    if (sci) edit.push({ key: "fork", label: "Make a copy…", icon: <GitFork />, run: () => setFork(true), title: "Your own copy to change; this pipeline is never changed" });
    if (sci && p.can_edit) edit.push({ key: "details", label: "Rename and describe…", icon: <Pencil />, run: () => setDetails(true) });
    groups.push(edit);
    const mine: Group = [{ key: "fav", label: p.favorite ? "Remove from favorites" : "Add to favorites", icon: <Star />, run: () => patch.mutate({ favorite: !p.favorite }) }];
    if (p.can_edit && p.owner) {
      mine.push(p.visibility === "lab"
        ? { key: "share", label: "Make private", icon: <Lock />, run: () => patch.mutate({ visibility: "private" }) }
        : { key: "share", label: "Share with the lab", icon: <Globe2 />, run: () => patch.mutate({ visibility: "lab" }) });
    }
    groups.push(mine);
    if (sci && p.can_edit) groups.push([{ key: "uninstall", label: "Uninstall…", icon: <Trash2 />, run: () => askUninstall(p), danger: true }]);
  }

  const dialogs = (
    <>
      {fork && <ForkDialog open={fork} onOpenChange={setFork} pid={p.id} name={p.name} version={p.latest_version?.version} studio={p.kind === "studio"} />}
      {details && <DetailsDialog p={p} onClose={() => setDetails(false)} onSaved={refresh} />}
    </>
  );
  return { groups: groups.filter((g) => g.length), dialogs };
}

type Menu = ReturnType<typeof usePipelineMenu>;

/** Wraps a pipeline card or row: right-click (long-press on touch screens, the menu key on keyboards) opens its actions. */
export function PipelineContextMenu({ p, menu, children }: { p: Pipeline; menu: Menu; children: ReactNode }) {
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent aria-label={`Actions for ${p.name}`}>
          <ContextMenuLabel>{p.name}</ContextMenuLabel>
          {menu.groups.map((g, i) => (
            <div key={i}>
              <ContextMenuSeparator />
              {g.map((e) => <ContextMenuItem key={e.key} danger={e.danger} title={e.title} onSelect={e.run}>{e.icon}{e.label}</ContextMenuItem>)}
            </div>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      {menu.dialogs}
    </>
  );
}

/** The same actions behind a "…" button, for mouse users who do not right-click and for keyboards. */
export function PipelineMenuButton({ p, menu, size = "sm" }: { p: Pipeline; menu: Menu; size?: "sm" | "md" }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant="ghost" aria-label={`Actions for ${p.name}`} title="More actions (or right-click)"><MoreHorizontal /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel>{p.name}</DropdownMenuLabel>
        {menu.groups.map((g, i) => (
          <div key={i}>
            <DropdownMenuSeparator />
            {g.map((e) => <DropdownMenuItem key={e.key} danger={e.danger} title={e.title} onSelect={e.run}>{e.icon}{e.label}</DropdownMenuItem>)}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DetailsDialog({ p, onClose, onSaved }: { p: Pipeline; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description);
  const [category, setCategory] = useState(p.category);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/pipelines/${p.id}`, { name: name.trim(), description: description.trim(), category: category.trim() || "general" }),
    onSuccess: () => { toast.success("Saved"); onSaved(); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={`Rename and describe ${p.name}`}
        description={p.kind === "studio" ? "Shown in the lists and on its pages. Publishing its Studio workflow again uses the workflow's name." : "Shown in the lists and on its pages; the pipeline's code and versions are not changed."}>
        <div className="space-y-3">
          <Field label="Name"><Input autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Category"><Input value={category} maxLength={80} onChange={(e) => setCategory(e.target.value)} /></Field>
          <Field label="Description"><Textarea rows={3} value={description} maxLength={4000} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
