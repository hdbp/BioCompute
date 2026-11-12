import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";

/** "Edit as new pipeline", the one copy action: your own copy of one version; the original is never changed. */
export function ForkDialog({ open, onOpenChange, pid, name, version, versionId, studio }: {
  open: boolean; onOpenChange: (o: boolean) => void; pid: string; name: string; version?: string; versionId?: string; studio: boolean;
}) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [n, setN] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setN(`${name} (my copy)`); }, [open, name]);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ kind: "studio" | "nextflow"; workflow_id?: string; pipeline_id?: string; from: string }>(
        `/api/pipelines/${pid}/fork`, { name: n.trim(), version_id: versionId ?? null });
      qc.invalidateQueries({ queryKey: ["pipelines"] });
      qc.invalidateQueries({ queryKey: ["studio-workflows"] });
      onOpenChange(false);
      if (r.kind === "studio") {
        toast.success(`“${n.trim()}” is your copy of ${r.from}. Publish it in Studio to add it to Pipelines; the original is not changed.`, { duration: 10000 });
        nav(`/studio/${r.workflow_id}`);
      } else {
        toast.success(`“${n.trim()}” is your copy of ${r.from}, open in the step editor. Click a step to change it, or Edit code for anything else; each save is a new version of your copy.`, { duration: 10000 });
        nav(`/studio/pipeline/${r.pipeline_id}`);
      }
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Edit as new pipeline"
        description={studio
          ? `Copies ${version ?? "this version"} of “${name}” into a new draft of yours in Pipeline Studio. Change it there and publish it as a new pipeline.`
          : `Copies ${version ?? "this version"} of “${name}” into a new pipeline of yours and opens it in Pipeline Studio's step editor, where you switch steps off, change their settings and add or remove steps (the code can be edited too). Every save is a new version of your copy.`}>
        <p className="mb-3 rounded-md border border-line bg-raised/40 px-3 py-2 text-[12.5px] text-muted">The original is never changed: “{name}” stays exactly as it is, for you and for everyone who uses it. The copy is private to you until you share it.</p>
        <Field label="Name of the new pipeline"><Input autoFocus value={n} onChange={(e) => setN(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && n.trim() && !busy) go(); }} /></Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!n.trim()} onClick={go}>Create my copy</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
