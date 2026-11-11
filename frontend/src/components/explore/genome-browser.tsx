import { useEffect, useRef, useState } from "react";
import igv, { type Browser } from "igv";
import { toast } from "sonner";
import { Dna, Globe2, Link2, Loader2, Trash2 } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { PathInput } from "@/components/file-browser";
import { GENOMES, genomeLabel, igvGenome, igvTrack, trackId, useExplorer, type GenomeChoice } from "./store";
import { HubDialog } from "./hub-dialog";
import { refgenieGenomeChoice, useReferences } from "@/components/reference-picker";

/** igv.js genome browser. Tracks and genome live in the explorer store (persisted), so the view survives navigation. */
export default function GenomeBrowser({ visible }: { visible: boolean }) {
  const { genome, locus, tracks, setGenome, setLocus, addTracks, removeTrack, clearTracks } = useExplorer();
  const div = useRef<HTMLDivElement>(null);
  const browser = useRef<Browser | null>(null);
  const loaded = useRef<Set<string>>(new Set());
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | "url" | "hub" | "genome">(null);
  const genomeKey = JSON.stringify(genome);

  // (re)create the browser whenever the genome changes
  useEffect(() => {
    let cancelled = false;
    let b: Browser | null = null;
    setState("loading");
    setError(null);
    const { tracks: initial, locus: initialLocus } = useExplorer.getState();
    igv.createBrowser(div.current!, {
      genome: igvGenome(genome) as never,
      ...(initialLocus ? { locus: initialLocus } : {}),
      tracks: initial.map((t) => igvTrack(t)) as never,
    } as never).then((br) => {
      if (cancelled) { igv.removeBrowser(br); return; }
      b = br;
      browser.current = br;
      loaded.current = new Set(initial.map((t) => t.id));
      let timer: ReturnType<typeof setTimeout>;
      br.on("locuschange", (loci: { getLocusString: () => string }[]) => {
        clearTimeout(timer);
        timer = setTimeout(() => setLocus(loci?.[0]?.getLocusString?.() ?? ""), 400);
      });
      br.on("trackremoved", (removed) => {
        for (const t of removed as unknown as { config?: { bcId?: string } }[]) {
          const id = t.config?.bcId;
          if (id) { loaded.current.delete(id); removeTrack(id); }
        }
      });
      setState("ready");
    }).catch((e) => {
      if (cancelled) return;
      setState("error");
      setError(errMsg(e));
    });
    return () => {
      cancelled = true;
      if (b) igv.removeBrowser(b);
      browser.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genomeKey]);

  // keep igv's tracks in step with the store
  useEffect(() => {
    const br = browser.current;
    if (!br || state !== "ready") return;
    for (const t of tracks) {
      if (loaded.current.has(t.id)) continue;
      loaded.current.add(t.id);
      br.loadTrack(igvTrack(t) as never).catch((e: unknown) => {
        toast.error(`Could not load “${t.name}”: ${errMsg(e)}`);
        loaded.current.delete(t.id);
        removeTrack(t.id);
      });
    }
    for (const id of [...loaded.current]) {
      if (!tracks.some((t) => t.id === id)) {
        loaded.current.delete(id);
        for (const tr of br.findTracks((x) => (x as unknown as { config?: { bcId?: string } }).config?.bcId === id)) br.removeTrack(tr);
      }
    }
  }, [tracks, state, removeTrack]);

  useEffect(() => { if (visible && browser.current) igv.visibilityChange(); }, [visible]);

  const choice = genome.kind === "igv" ? genome.id : `custom`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Dna className="size-4 text-accent" />
        <Select aria-label="Genome" className="h-8 w-64" value={choice}
          onChange={(e) => (e.target.value === "custom" ? setDlg("genome") : setGenome({ kind: "igv", id: e.target.value }))}>
          {GENOMES.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          <option value="custom">{genome.kind === "igv" ? "Other genome…" : `${genomeLabel(genome)} (custom)…`}</option>
        </Select>
        <Button size="sm" variant="secondary" onClick={() => setDlg("hub")}><Globe2 />Public track hubs</Button>
        <Button size="sm" variant="secondary" onClick={() => setDlg("url")}><Link2 />Track from URL</Button>
        <span className="ml-auto text-xs text-muted tabular-nums">{tracks.length} track{tracks.length === 1 ? "" : "s"}{locus ? ` · ${locus}` : ""}</span>
        {tracks.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => window.confirm("Remove all tracks?") && clearTracks()}><Trash2 />Clear</Button>
        )}
      </div>
      {state === "loading" && <p className="flex items-center gap-2 text-[13px] text-muted"><Loader2 className="size-4 animate-spin" />Loading {genomeLabel(genome)}…</p>}
      {state === "error" && (
        <div className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-[13px]">
          <p className="font-medium">Could not load the genome {genomeLabel(genome)}.</p>
          <p className="mt-1 text-muted">{error}</p>
          <p className="mt-1 text-muted">Built-in genomes and hubs are downloaded from igv.org and UCSC by your browser. Without internet access,
            use <b>Other genome…</b> and pick a FASTA (with its .fai index) from your data folders.</p>
        </div>
      )}
      <div ref={div} className="igv-host relative isolate z-0 min-h-[420px] rounded-lg border border-line bg-white p-1 text-black" />
      <p className="text-[11.5px] text-muted">
        Your files are read straight from the controller, a few kilobytes at a time; nothing is uploaded anywhere. Public genomes,
        hubs and URL tracks are fetched by your browser from their own servers.
      </p>

      <UrlTrackDialog open={dlg === "url"} onOpenChange={(o) => setDlg(o ? "url" : null)}
        onAdd={(t) => addTracks([{ id: trackId("url"), source: "url", ...t }])} />
      <GenomeDialog open={dlg === "genome"} onOpenChange={(o) => setDlg(o ? "genome" : null)} onPick={(g) => { setGenome(g); setDlg(null); }} />
      {dlg === "hub" && <HubDialog open onOpenChange={(o) => setDlg(o ? "hub" : null)} genome={genome}
        onAddTracks={(ts) => addTracks(ts)} onUseGenome={(g) => { setGenome(g); setDlg(null); }} />}
    </div>
  );
}

const URL_FORMATS = [
  ["", "Detect from the file name"], ["bigwig", "bigWig"], ["bigbed", "bigBed"], ["bam", "BAM"], ["cram", "CRAM"], ["bed", "BED"],
  ["narrowpeak", "narrowPeak"], ["bedgraph", "bedGraph"], ["vcf", "VCF"], ["gtf", "GTF"], ["gff3", "GFF3"], ["seg", "SEG"],
];

function UrlTrackDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; onAdd: (t: { name: string; url: string; indexURL?: string; format?: string; type: string }) => void }) {
  const [f, setF] = useState({ url: "", index: "", name: "", format: "" });
  const ok = /^https?:\/\//.test(f.url);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a track from a URL" description="Any public file over HTTPS, e.g. an ENCODE or GEO bigWig. The server must allow cross-origin and range requests.">
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          if (!ok) return;
          const name = f.name || decodeURIComponent(f.url.split("?")[0].split("/").pop() || "track");
          onAdd({ name, url: f.url, indexURL: f.index || undefined, format: f.format || undefined, type: "" });
          setF({ url: "", index: "", name: "", format: "" });
          onOpenChange(false);
        }}>
          <Field label="File URL"><Input autoFocus value={f.url} onChange={(e) => setF({ ...f, url: e.target.value.trim() })} placeholder="https://…/signal.bigWig" /></Field>
          <Field label="Index URL" hint="Needed for BAM/CRAM and indexed VCF/BED (.bai, .crai, .tbi)"><Input value={f.index} onChange={(e) => setF({ ...f, index: e.target.value.trim() })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="from the file name" /></Field>
            <Field label="Format"><Select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}>{URL_FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!ok}>Add track</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GenomeDialog({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (g: GenomeChoice) => void }) {
  const { genomes: refGenomes } = useReferences();
  const [mode, setMode] = useState<"refgenie" | "fasta" | "genark" | "hub">("fasta");
  const [refName, setRefName] = useState("");
  useEffect(() => { if (open && refGenomes.length) { setMode("refgenie"); setRefName((n) => n || refGenomes[0].name); } }, [open, refGenomes]);
  const [fasta, setFasta] = useState("");
  const [annot, setAnnot] = useState("");
  const [acc, setAcc] = useState("");
  const [hub, setHub] = useState("");
  const [busy, setBusy] = useState(false);

  const useFasta = async () => {
    setBusy(true);
    try {
      const info = await api.get<{ track: { type: string; index: string | null } | null; name: string }>(`/api/explore/info?path=${encodeURIComponent(fasta)}`);
      if (info.track?.type !== "reference") throw new Error("That is not a FASTA file (.fa, .fasta, .fna)");
      if (!info.track.index) throw new Error(`No index next to it. Create one with: samtools faidx ${info.name}`);
      onPick({ kind: "fasta", name: info.name.replace(/\.(fa|fasta|fna)(\.gz)?$/i, ""), path: fasta, index: info.track.index, annotation: annot || null });
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const useRef_ = async () => {
    setBusy(true);
    try { onPick(await refgenieGenomeChoice(refName)); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Other genome" description="Use a reference from your data folders (works offline), any NCBI assembly through UCSC GenArk, or an assembly hub.">
        <div className="space-y-4">
          <div className="flex gap-1 rounded-md border border-line p-0.5 text-[13px]" role="group">
            {([...(refGenomes.length ? [["refgenie", "refgenie"]] as const : []), ["fasta", "FASTA on the controller"], ["genark", "GenArk accession"], ["hub", "Assembly hub"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setMode(k)} className={`flex-1 rounded px-2 py-1 ${mode === k ? "bg-raised text-text" : "text-muted"}`} aria-pressed={mode === k}>{l}</button>
            ))}
          </div>
          {mode === "refgenie" && (
            <>
              <Field label="Genome from refgenie on the controller" hint="Its FASTA (with .fai) and, if present, a GTF annotation. Works offline.">
                <Select value={refName} onChange={(e) => setRefName(e.target.value)}>
                  {refGenomes.map((g) => <option key={g.digest} value={g.name}>{g.name}</option>)}
                </Select>
              </Field>
              <DialogFooter><Button variant="primary" onClick={useRef_} loading={busy} disabled={!refName}>Use this genome</Button></DialogFooter>
            </>
          )}
          {mode === "fasta" && (
            <>
              <Field label="Reference FASTA" hint="Needs a samtools faidx index (.fai) next to it"><PathInput mode="file" value={fasta} onChange={setFasta} kinds={["fasta"]} /></Field>
              <Field label="Gene annotation (optional)" hint="GTF or GFF3"><PathInput mode="file" value={annot} onChange={setAnnot} /></Field>
              <DialogFooter><Button variant="primary" onClick={useFasta} loading={busy} disabled={!fasta}>Use this genome</Button></DialogFooter>
            </>
          )}
          {mode === "genark" && (
            <>
              <Field label="Assembly accession" hint="e.g. GCF_000001405.40 (human) or GCA_… for any of the thousands of assemblies on UCSC GenArk">
                <Input value={acc} onChange={(e) => setAcc(e.target.value.trim())} placeholder="GCF_…" />
              </Field>
              <DialogFooter><Button variant="primary" disabled={!/^GC[AF]_\d+\.\d+$/.test(acc)} onClick={() => onPick({ kind: "genark", accession: acc })}>Use this genome</Button></DialogFooter>
            </>
          )}
          {mode === "hub" && (
            <>
              <Field label="hub.txt URL of an assembly hub"><Input value={hub} onChange={(e) => setHub(e.target.value.trim())} placeholder="https://…/hub.txt" /></Field>
              <DialogFooter><Button variant="primary" disabled={!/^https?:\/\/.+hub\.txt$/.test(hub)} onClick={() => onPick({ kind: "hub", url: hub, name: hub.split("/").slice(-2, -1)[0] || "hub" })}>Use this genome</Button></DialogFooter>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
