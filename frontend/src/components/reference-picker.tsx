import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dna } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/misc";
import type { GenomeChoice } from "@/components/explore/store";

export interface RefTag { tag: string; digest: string | null; size: string | null; path: string | null; exists: boolean; seek_keys: Record<string, string> }
export interface RefAsset { name: string; description: string; default_tag: string | null; tags: RefTag[] }
export interface RefGenome { name: string; aliases: string[]; digest: string; assets: RefAsset[] }
export interface RefStatus { ok: boolean; config: string | null; found_by: string | null; error: string | null; version?: string; genome_folder?: string; servers?: string[]; genomes?: number; assets?: number; data_folder?: string | null; env_refgenie?: string | null }

export function useReferences() {
  const status = useQuery({ queryKey: ["ref-status"], queryFn: () => api.get<RefStatus>("/api/references/status"), staleTime: 60_000 });
  const genomes = useQuery({ queryKey: ["ref-genomes"], queryFn: () => api.get<RefGenome[]>("/api/references/genomes"), enabled: !!status.data?.ok, staleTime: 60_000 });
  return { status: status.data, genomes: genomes.data ?? [], loading: status.isLoading || genomes.isLoading };
}

export const refUri = (genome: string, asset: string, seek?: string | null, tag?: string | null, defaultTag?: string | null) =>
  `refgenie://${genome}/${asset}${seek && seek !== asset ? `.${seek}` : ""}${tag && tag !== defaultTag ? `:${tag}` : ""}`;

/** Button next to a path field: choose a refgenie asset; the field gets a refgenie:// reference. */
export function ReferencePicker({ value, directory, onPick, compact }: { value?: string; directory?: boolean; onPick: (uri: string) => void; compact?: boolean }) {
  const { status, genomes } = useReferences();
  const [open, setOpen] = useState(false);
  const cur = useMemo(() => {
    const m = /^refgenie:\/\/([^/]+)\/([^.:]+)(?:\.([^:]+))?(?::(.+))?$/.exec(value ?? "");
    return m ? { genome: m[1], asset: m[2], seek: m[3] ?? null, tag: m[4] ?? null } : null;
  }, [value]);
  const [g, setG] = useState("");
  const [a, setA] = useState("");
  const [t, setT] = useState("");
  const [k, setK] = useState("");
  useEffect(() => {
    if (!open) return;
    const gg = cur?.genome ?? genomes[0]?.name ?? "";
    setG(gg); setA(cur?.asset ?? ""); setT(cur?.tag ?? ""); setK(cur?.seek ?? "");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!status?.ok || !genomes.length) return null;
  const genome = genomes.find((x) => x.name === g) ?? genomes[0];
  const asset = genome?.assets.find((x) => x.name === a);
  const tag = asset?.tags.find((x) => x.tag === (t || asset.default_tag)) ?? asset?.tags[0];
  const seekKeys = tag ? Object.keys(tag.seek_keys) : [];
  const seek = k || (directory && asset && !seekKeys.includes(asset.name) ? "dir" : directory && seekKeys.includes("dir") && /index/.test(asset?.name ?? "") ? "dir" : "");
  const uri = genome && asset ? refUri(genome.name, asset.name, seek || null, tag?.tag, asset.default_tag) : "";
  const preview = tag ? (seek ? tag.seek_keys[seek] ?? (seek === "dir" ? tag.path : null) : tag.path) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="secondary" size={compact ? "sm" : undefined} aria-label="Choose a reference genome asset" title="Reference genome asset (refgenie)">
          <Dna />{compact ? null : "Genome"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-3 p-3 text-[13px]">
        <p className="font-medium">Reference genome asset</p>
        <label className="block space-y-1"><span className="text-xs text-muted">Genome</span>
          <Select value={genome?.name ?? ""} onChange={(e) => { setG(e.target.value); setA(""); setT(""); setK(""); }}>
            {genomes.map((x) => <option key={x.digest} value={x.name}>{x.name}{x.aliases.length > 1 ? ` (${x.aliases.slice(1).join(", ")})` : ""}</option>)}
          </Select>
        </label>
        <label className="block space-y-1"><span className="text-xs text-muted">Asset</span>
          <Select value={asset?.name ?? ""} onChange={(e) => { setA(e.target.value); setT(""); setK(""); }}>
            <option value="">Choose…</option>
            {genome?.assets.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </Select>
        </label>
        {asset && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1"><span className="text-xs text-muted">Tag</span>
              <Select value={tag?.tag ?? ""} onChange={(e) => setT(e.target.value)}>
                {asset.tags.map((x) => <option key={x.tag} value={x.tag}>{x.tag}{x.tag === asset.default_tag ? " (default)" : ""}</option>)}
              </Select>
            </label>
            <label className="block space-y-1"><span className="text-xs text-muted">File</span>
              <Select value={seek} onChange={(e) => setK(e.target.value)}>
                <option value="">{asset.name} (default)</option>
                {seekKeys.filter((x) => x !== asset.name).map((x) => <option key={x}>{x}</option>)}
                {!seekKeys.includes("dir") && <option value="dir">dir (whole folder)</option>}
              </Select>
            </label>
          </div>
        )}
        {asset && (
          <div className="space-y-1 rounded-md bg-raised/60 p-2">
            <p className="break-all font-mono text-[11.5px]">{uri}</p>
            {preview && <p className="break-all text-[11px] text-muted">{preview}</p>}
            {tag && !tag.exists && <p className="text-[11.5px] text-bad">This asset's files are missing on the controller.</p>}
            {tag?.digest && <p className="text-[11px] text-muted">digest {tag.digest.slice(0, 16)}… recorded with each run</p>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!asset} onClick={() => { onPick(uri); setOpen(false); }}>Use</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Under a field holding refgenie://…: what it points to, or why it does not resolve. */
export function ReferenceHint({ value }: { value: unknown }) {
  const uri = typeof value === "string" && value.startsWith("refgenie://") ? value : null;
  const q = useQuery({
    queryKey: ["ref-resolve", uri], enabled: !!uri, retry: false, staleTime: 60_000,
    queryFn: () => api.get<{ path: string; asset_digest: string | null; tag: string }>(`/api/references/resolve${qs({ uri })}`),
  });
  if (!uri) return null;
  return (
    <p className={cn("mt-1 break-all text-[11.5px]", q.isError ? "text-bad" : "text-muted")}>
      {q.isError ? errMsg(q.error) : q.data ? <>→ {q.data.path} <span className="text-muted/80">(tag {q.data.tag}{q.data.asset_digest ? `, digest ${q.data.asset_digest.slice(0, 10)}…` : ""})</span></> : "Resolving…"}
    </p>
  );
}

/** Launch form: pick a genome once and fill every reference parameter the controller has an asset for. */
export function ReferenceGenomeBar({ fields, params, initialGenome, onApply }: {
  fields: { name: string; widget: string }[]; params: Record<string, unknown>; initialGenome?: string | null;
  onApply: (updates: Record<string, unknown>, filled: string[]) => void;
}) {
  const { status, genomes } = useReferences();
  const [genome, setGenome] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pathFields = useMemo(() => fields.filter((f) => f.widget === "file" || f.widget === "directory"), [fields]);
  useEffect(() => {
    if (!genomes.length) return;
    const match = initialGenome && genomes.find((g) => g.name === initialGenome || g.aliases.includes(initialGenome));
    setGenome(match ? match.name : (genomes.length === 1 ? genomes[0].name : ""));
  }, [initialGenome, genomes]);
  if (!status?.ok || !genomes.length || !pathFields.length) return null;
  const apply = async () => {
    if (!genome) return;
    setBusy(true); setNote(null);
    try {
      const s = await api.post<Record<string, string>>("/api/references/suggest", { genome, fields: pathFields });
      // never overwrite a path the user typed; refresh earlier refgenie choices
      const updates: Record<string, unknown> = {};
      for (const [k, uri] of Object.entries(s)) {
        const cur = params[k];
        if (cur === undefined || cur === null || cur === "" || (typeof cur === "string" && cur.startsWith("refgenie://"))) updates[k] = uri;
      }
      const filled = Object.keys(updates);
      if (filled.length && fields.some((f) => f.name === "igenomes_ignore")) updates.igenomes_ignore = true;
      onApply(updates, filled);
      const skipped = Object.keys(s).filter((k) => !filled.includes(k));
      setNote(filled.length
        ? `Filled ${filled.join(", ")}${skipped.length ? `; kept your paths for ${skipped.join(", ")}` : ""}.`
        : Object.keys(s).length ? "Every matching parameter already has a path you chose." : `No parameter of this pipeline matches an asset of ${genome}.`);
    } catch (e) { setNote(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="mb-3 rounded-md border border-line bg-raised/40 p-2.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <Dna className="size-4 text-muted" />
        <span className="text-muted">Reference genome</span>
        <Select className="h-8 w-auto min-w-40" value={genome} onChange={(e) => setGenome(e.target.value)} aria-label="Reference genome">
          <option value="">Choose…</option>
          {genomes.map((g) => <option key={g.digest} value={g.name}>{g.name}</option>)}
        </Select>
        <Button size="sm" variant="secondary" disabled={!genome} loading={busy} onClick={apply}>Fill reference parameters</Button>
      </div>
      {note && <p className="mt-1.5 text-xs text-muted" aria-live="polite">{note}</p>}
    </div>
  );
}

/** A refgenie genome as a genome-browser choice: its FASTA, .fai and annotation inside the refgenie data folder. */
export async function refgenieGenomeChoice(genome: string): Promise<GenomeChoice> {
  const g = await api.get<{ name: string; fasta: string; fai: string; annotation: string | null }>(`/api/references/browser-genome${qs({ genome })}`);
  return { kind: "fasta", name: g.name, path: g.fasta, index: g.fai, annotation: g.annotation };
}
