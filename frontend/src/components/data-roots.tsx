import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FolderPlus, Lock, Trash2 } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import { Badge, Panel, PanelHeader, Switch } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { ControllerFolderPicker } from "@/components/folder-picker";

export interface DataRootInfo { name: string; path: string; restricted: boolean; writable: boolean; description: string; exists: boolean; source?: "settings" | "ui" }
interface Check {
  path: string; ok: boolean; errors: string[]; warnings: string[]; exists: boolean; readable?: boolean; writable_possible?: boolean;
  entries?: string[]; entry_count?: number; suggested_name?: string;
}

/** Settings panel: the folders BioCompute may use. Admins add folders that hold their data here. */
export function DataRootsPanel({ roots, admin }: { roots: DataRootInfo[]; admin: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["settings"] }); qc.invalidateQueries({ queryKey: ["roots"] }); };
  const patch = useMutation({
    mutationFn: ({ name, body }: { name: string; body: Record<string, unknown> }) => api.patch(`/api/datasets/roots/${name}`, body),
    onSuccess: refresh, onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (name: string) => api.del(`/api/datasets/roots/${name}`),
    onSuccess: () => { refresh(); toast.success("Data folder removed. The files themselves were not touched."); }, onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Panel>
      <PanelHeader title="Data folders"
        description="The only folders BioCompute can browse, read and write: pick pipeline inputs from them and send results to them. Restricted folders never leave this controller's site."
        actions={admin && <Button size="sm" variant="primary" onClick={() => setOpen(true)}><FolderPlus />Add folder</Button>} />
      <div className="divide-y divide-line/60">
        {roots.length === 0 && <p className="p-4 text-[13px] text-bad">No data folders yet. Add the folders that hold your sequencing data.</p>}
        {roots.map((r) => (
          <div key={r.name} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.name}</span>
              {r.restricted && <Badge tone="wait"><Lock className="size-3" />restricted</Badge>}
              <Badge>{r.writable ? "writable" : "read-only"}</Badge>
              {!r.exists && <Badge tone="bad">missing on disk</Badge>}
              <span className="ml-auto text-[11px] text-muted">{r.source === "ui" ? "added here" : "from BIOCOMPUTE_DATA_ROOTS"}</span>
            </div>
            <p className="mt-0.5 font-mono text-[12px] text-muted">{r.path}</p>
            {r.description && <p className="text-xs text-muted">{r.description}</p>}
            {admin && r.source === "ui" && (
              <div className="mt-2 flex flex-wrap items-center gap-4 text-[12.5px]">
                <label className="flex items-center gap-2"><Switch checked={r.restricted} onCheckedChange={(v) => patch.mutate({ name: r.name, body: { restricted: v } })} />Restricted</label>
                <label className="flex items-center gap-2"><Switch checked={r.writable} onCheckedChange={(v) => patch.mutate({ name: r.name, body: { writable: v } })} />Results can be written here</label>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => window.confirm(`Remove “${r.name}” from BioCompute? The folder and its files stay on disk; experiments that point into it will stop finding their files.`) && del.mutate(r.name)}>
                  <Trash2 />Remove
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <AddRootDialog open={open} onOpenChange={setOpen} existing={roots.map((r) => r.name)} onAdded={refresh} />
    </Panel>
  );
}

function AddRootDialog({ open, onOpenChange, existing, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; existing: string[]; onAdded: () => void }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [desc, setDesc] = useState("");
  const [restricted, setRestricted] = useState(true);
  const [writable, setWritable] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState(false);

  useEffect(() => { if (open) { setPath(""); setName(""); setNameTouched(false); setDesc(""); setRestricted(true); setWritable(false); setCheck(null); } }, [open]);
  useEffect(() => {
    if (!path.trim()) { setCheck(null); return; }
    const t = setTimeout(() => {
      api.get<Check>(`/api/datasets/roots/check${qs({ path })}`).then((c) => {
        setCheck(c);
        if (!nameTouched && c.suggested_name) setName(unique(c.suggested_name, existing));
      }).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [path, nameTouched, existing]);

  const save = async () => {
    setSaving(true);
    try {
      await api.post("/api/datasets/roots", { name, path, restricted, writable, description: desc });
      toast.success(`Added “${name}”. Its files now appear in file pickers, the experiment designer and Data Explorer.`);
      onAdded();
      onOpenChange(false);
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a data folder"
        description="A folder on the controller (the computer running BioCompute). Data on another computer must be mounted on the controller first, e.g. an NFS/SMB share or an external drive.">
        <div className="space-y-4">
          <div className="flex items-start gap-2">
            <Field label="Folder path on the controller" className="flex-1" hint="Browse to pick or create it, or type it, e.g. /data/sequencing/2026, /mnt/nas/chipseq or ~/projects/rnaseq">
              <Input autoFocus className="font-mono text-[12.5px]" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/your/data" />
            </Field>
            <Button type="button" variant="secondary" className="mt-[26px]" onClick={() => setPicker(true)}>Browse…</Button>
          </div>
          <ControllerFolderPicker open={picker} onOpenChange={setPicker} start={check?.ok ? check.path : undefined} onPick={setPath} />
          {check && (
            <div aria-live="polite" className="space-y-1 text-[12.5px]">
              {check.errors.map((e) => <p key={e} className="flex gap-1.5 text-bad"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{e}</p>)}
              {check.ok && (
                <p className="flex gap-1.5 text-ok"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                  {check.entry_count} item{check.entry_count === 1 ? "" : "s"}{check.entries?.length ? `: ${check.entries.join(", ")}${(check.entry_count ?? 0) > check.entries.length ? ", …" : ""}` : " (empty folder)"}</p>
              )}
              {check.warnings.map((w) => <p key={w} className="flex gap-1.5 text-wait"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{w}</p>)}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="Paths in this folder are written name:sub/folder/file">
              <Input value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} placeholder="chipseq" />
            </Field>
            <Field label="Description (optional)"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="ChIP-seq runs 2026" /></Field>
          </div>
          <label className="flex items-start gap-3 text-[13px]"><Switch checked={restricted} onCheckedChange={setRestricted} className="mt-0.5" />
            <span><b className="font-medium">Restricted</b><span className="block text-xs text-muted">The data never leaves this controller's site: runs using it are not sent to home or off-site computers. Keep it on for raw lab data.</span></span></label>
          <label className="flex items-start gap-3 text-[13px]"><Switch checked={writable} disabled={check?.writable_possible === false} onCheckedChange={setWritable} className="mt-0.5" />
            <span><b className="font-medium">Results can be written here</b><span className="block text-xs text-muted">{check?.writable_possible === false ? "The BioCompute account cannot write to this folder." : "Off keeps raw data read-only. Use a separate folder for results."}</span></span></label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!check?.ok || !name} onClick={save}>Add folder</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function unique(base: string, taken: string[]) {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}
