import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/misc";
import { ControllerFolderPicker } from "@/components/folder-picker";
import { useReferences, type RefStatus } from "@/components/reference-picker";

/** Settings: which refgenie config BioCompute reads. Read-only use; refgenie itself manages the genomes. */
export function ReferencesSettingsPanel({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const { status } = useReferences();
  const [path, setPath] = useState("");
  const [picker, setPicker] = useState(false);
  useEffect(() => { if (status?.found_by === "Settings" && status.config) setPath(status.config); }, [status?.config, status?.found_by]);
  const save = useMutation({
    mutationFn: (config: string | null) => api.put<RefStatus>("/api/references/config", { config }),
    onSuccess: (st) => {
      qc.setQueryData(["ref-status"], st);
      qc.invalidateQueries({ queryKey: ["ref-genomes"] });
      qc.invalidateQueries({ queryKey: ["roots"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      if (st.ok) toast.success(`Reading ${st.genomes} genome${st.genomes === 1 ? "" : "s"} from ${st.config}`);
      else toast.error(st.error ?? "No refgenie config found");
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Panel id="references">
      <PanelHeader title="Reference genomes (refgenie)"
        description="BioCompute reads an existing refgenie setup: genomes appear in launch forms, Pipeline Studio and the genome browser, and runs record asset digests. Your refgenie files are never changed." />
      <div className="space-y-3 p-4 text-[13px]">
        {status?.ok ? (
          <p className="flex gap-1.5"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
            <span><span className="text-ok">{status.genomes} genome{status.genomes === 1 ? "" : "s"}, {status.assets} assets</span> from{" "}
              <span className="break-all font-mono text-[12px]">{status.config}</span> <span className="text-muted">({status.found_by})</span></span></p>
        ) : (
          <p className="flex gap-1.5 text-muted"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-wait" /><span className="break-all">{status?.error ?? "Checking…"}{status?.config ? <> ({status.config})</> : null}</span></p>
        )}
        {status?.ok && status.genome_folder && (
          <p className="text-xs text-muted">Genome folder <span className="font-mono">{status.genome_folder}</span>{status.data_folder ? <> is browsable read-only as data folder “{status.data_folder}”.</> : "."}</p>
        )}
        {status?.env_refgenie && status.found_by !== "$REFGENIE" && <p className="text-xs text-muted">$REFGENIE on the controller: <span className="font-mono">{status.env_refgenie}</span></p>}
        {admin && (
          <>
            <div className="flex items-start gap-2">
              <Field label="refgenie config file or genome folder" className="flex-1"
                hint="Leave empty to use $REFGENIE (captured by install.sh) or ~/.refgenie/genome_config.yaml">
                <Input className="font-mono text-[12.5px]" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/data/refgenie/genome_config.yaml" />
              </Field>
              <Button type="button" variant="secondary" className="mt-[26px]" onClick={() => setPicker(true)}>Browse…</Button>
            </div>
            <ControllerFolderPicker open={picker} onOpenChange={setPicker} start={path || undefined} onPick={setPath} />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(path.trim() || null)}>Save</Button>
              {status?.found_by === "Settings" && <Button size="sm" variant="ghost" onClick={() => { setPath(""); save.mutate(null); }}>Use automatic detection</Button>}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
