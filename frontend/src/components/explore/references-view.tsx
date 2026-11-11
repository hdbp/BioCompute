import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle, Copy, Dna, FolderOpen, Loader2 } from "lucide-react";
import { errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Badge, Panel } from "@/components/ui/misc";
import { refgenieGenomeChoice, refUri, useReferences, type RefGenome } from "@/components/reference-picker";
import { useExplorer } from "./store";

const copy = async (text: string) => {
  try { await navigator.clipboard.writeText(text); toast.success("Copied"); } catch { toast.message(text); }
};

/** Data Explorer tab: reference genomes from the controller's refgenie setup (read-only). */
export function ReferencesView({ onOpenGenome, onBrowse }: { onOpenGenome: () => void; onBrowse: (dir: string) => void }) {
  const { status, genomes, loading } = useReferences();
  const user = useAuth((s) => s.user);
  const setGenome = useExplorer((s) => s.setGenome);
  const [busy, setBusy] = useState<string | null>(null);

  if (loading) return <p className="flex items-center gap-2 text-[13px] text-muted"><Loader2 className="size-4 animate-spin" />Reading refgenie…</p>;
  if (!status?.ok) {
    return (
      <div className="mx-auto max-w-xl space-y-3 py-10 text-[13.5px]">
        <p className="flex items-center gap-2 font-medium"><Dna className="size-5 text-accent" />Reference genomes from refgenie</p>
        {status?.error
          ? <p className="flex gap-1.5 text-bad"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{status.error}</p>
          : <p className="text-muted">No refgenie configuration was found on the controller.</p>}
        <p className="text-muted">
          If you manage genomes with <a className="text-accent underline-offset-2 hover:underline" href="https://refgenie.databio.org" target="_blank" rel="noreferrer">refgenie</a>,
          BioCompute reads its <code>genome_config.yaml</code> (from <code>$REFGENIE</code>, Settings, or <code>~/.refgenie</code>) and offers every asset in launch forms,
          Pipeline Studio and the genome browser. It never changes your refgenie files.
        </p>
        {can(user, "admin")
          ? <Button asChild variant="secondary"><Link to="/settings?tab=system#references">Set the refgenie config in Settings</Link></Button>
          : <p className="text-muted">Ask an admin to set the refgenie config in Settings.</p>}
      </div>
    );
  }

  const openInBrowser = async (g: RefGenome) => {
    setBusy(g.name);
    try { setGenome(await refgenieGenomeChoice(g.name)); onOpenGenome(); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
        <h2 className="text-[15px] font-semibold">Reference genomes</h2>
        <span className="text-muted">{status.genomes} genome{status.genomes === 1 ? "" : "s"}, {status.assets} assets · refgenie config {status.config} ({status.found_by})</span>
        {status.data_folder && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onBrowse(`${status.data_folder}:`)}><FolderOpen />Browse files</Button>}
      </div>
      <p className="text-xs text-muted">
        Use an asset as a pipeline input by its reference, e.g. <code>refgenie://{genomes[0]?.name}/fasta</code>. BioCompute resolves it when a run starts and records the asset digest with the run.
        To add or update genomes, use refgenie itself (<code>refgenie pull</code>, <code>refgenie build</code>); this page refreshes from its config.
      </p>
      {genomes.map((g) => {
        const hasFasta = g.assets.some((a) => a.name === "fasta");
        return (
          <Panel key={g.digest}>
            <div className="flex flex-wrap items-center gap-2 border-b border-line/60 px-4 py-3">
              <Dna className="size-4 text-accent" />
              <span className="font-medium">{g.name}</span>
              {g.aliases.filter((x) => x !== g.name).map((x) => <Badge key={x}>{x}</Badge>)}
              <button className="font-mono text-[11px] text-muted hover:text-text" title="Genome digest (copy)" onClick={() => copy(g.digest)}>{g.digest.slice(0, 12)}…</button>
              {hasFasta && (
                <Button size="sm" variant="secondary" className="ml-auto" loading={busy === g.name} onClick={() => openInBrowser(g)}>Open in genome browser</Button>
              )}
            </div>
            <table className="w-full text-[12.5px]">
              <thead className="text-left text-[11px] uppercase tracking-wide text-muted">
                <tr><th className="px-4 py-1.5 font-medium">Asset</th><th className="px-2 py-1.5 font-medium">Tags</th><th className="px-2 py-1.5 font-medium">Files</th><th className="px-2 py-1.5 font-medium">Size</th><th className="px-4 py-1.5" /></tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {g.assets.map((a) => {
                  const def = a.tags.find((t) => t.tag === a.default_tag) ?? a.tags[0];
                  const uri = refUri(g.name, a.name);
                  return (
                    <tr key={a.name} className="align-top">
                      <td className="px-4 py-2">
                        <span className="font-medium">{a.name}</span>
                        {a.description && <span className="block text-[11.5px] text-muted">{a.description}</span>}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-wrap gap-1">
                          {a.tags.map((t) => (
                            <Badge key={t.tag} tone={t.exists ? (t.tag === a.default_tag ? "accent" : "neutral") : "bad"} title={t.digest ? `digest ${t.digest}` : undefined}>
                              {t.tag}{t.exists ? "" : " (missing)"}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-muted">{def ? Object.keys(def.seek_keys).join(", ") : ""}</td>
                      <td className="px-2 py-2 tabular-nums text-muted">{def?.size ?? ""}</td>
                      <td className="px-4 py-2 text-right">
                        <Button size="sm" variant="ghost" title={`Copy ${uri}`} onClick={() => copy(uri)}><Copy />Copy reference</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        );
      })}
    </div>
  );
}
