import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useAuth } from "@/lib/auth";

/** Genomes igv.js resolves by id (from igv.org's genome list). Any other assembly: a GenArk accession, a hub, or a local FASTA. */
export const GENOMES: { id: string; label: string }[] = [
  { id: "hg38", label: "Human GRCh38 (hg38)" },
  { id: "hs1", label: "Human T2T-CHM13 v2.0 (hs1)" },
  { id: "hg19", label: "Human GRCh37 (hg19)" },
  { id: "mm39", label: "Mouse GRCm39 (mm39)" },
  { id: "mm10", label: "Mouse GRCm38 (mm10)" },
  { id: "rn7", label: "Rat mRatBN7.2 (rn7)" },
  { id: "danRer11", label: "Zebrafish GRCz11 (danRer11)" },
  { id: "dm6", label: "Fly BDGP6 (dm6)" },
  { id: "ce11", label: "Worm WBcel235 (ce11)" },
  { id: "sacCer3", label: "Yeast R64 (sacCer3)" },
  { id: "galGal6", label: "Chicken GRCg6a (galGal6)" },
  { id: "tair10", label: "Arabidopsis TAIR10" },
];

export type GenomeChoice =
  | { kind: "igv"; id: string }
  | { kind: "genark"; accession: string }
  | { kind: "hub"; url: string; name: string }
  | { kind: "fasta"; name: string; path: string; index: string; annotation?: string | null };

export interface TrackRef {
  id: string;
  name: string;
  source: "file" | "url" | "hub";
  type: string;
  format?: string;
  path?: string;          // data-root path (source "file")
  index?: string | null;  // data-root path of the index
  url?: string;           // external URL (source "url")
  indexURL?: string;
  config?: Record<string, unknown>; // a track hub's own config (source "hub")
}

interface ExplorerState {
  genome: GenomeChoice;
  locus: string;
  tracks: TrackRef[];
  setGenome: (g: GenomeChoice) => void;
  setLocus: (l: string) => void;
  addTracks: (t: TrackRef[]) => void;
  removeTrack: (id: string) => void;
  clearTracks: () => void;
}

export const useExplorer = create<ExplorerState>()(persist((set) => ({
  genome: { kind: "igv", id: "hg38" },
  locus: "",
  tracks: [],
  setGenome: (genome) => set({ genome, locus: "" }),
  setLocus: (locus) => set({ locus }),
  addTracks: (t) => set((s) => ({ tracks: [...s.tracks, ...t.filter((x) => !s.tracks.some((y) => y.id === x.id))] })),
  removeTrack: (id) => set((s) => ({ tracks: s.tracks.filter((t) => t.id !== id) })),
  clearTracks: () => set({ tracks: [] }),
}), { name: "biocompute.explorer", partialize: (s) => ({ genome: s.genome, locus: s.locus, tracks: s.tracks }) }));

export const rawUrl = (path: string) => `${window.location.origin}/api/explore/raw?path=${encodeURIComponent(path)}`;
const authHeaders = () => ({ Authorization: `Bearer ${useAuth.getState().token ?? ""}` });

/** igv.js track config. Files on the controller are read with HTTP range requests, authenticated by header. */
export function igvTrack(t: TrackRef): Record<string, unknown> {
  if (t.source === "hub") return { ...t.config, bcId: t.id };
  if (t.source === "url") {
    return { name: t.name, url: t.url, ...(t.indexURL ? { indexURL: t.indexURL } : {}), ...(t.format ? { format: t.format } : {}),
      ...(t.type ? { type: t.type } : {}), bcId: t.id };
  }
  return {
    name: t.name, type: t.type, format: t.format, url: rawUrl(t.path!), headers: authHeaders(),
    ...(t.index ? { indexURL: rawUrl(t.index) } : t.type !== "alignment" ? { indexed: false } : {}),
    ...(t.type === "wig" ? { autoscale: true } : {}),
    bcId: t.id,
  };
}

export function igvGenome(g: GenomeChoice): string | Record<string, unknown> {
  if (g.kind === "igv") return g.id;
  if (g.kind === "genark") return { genarkAccession: g.accession };
  if (g.kind === "hub") return { hubURL: g.url, name: g.name };
  return {
    id: g.name, name: g.name, fastaURL: rawUrl(g.path), indexURL: rawUrl(g.index), headers: authHeaders(),
    ...(g.annotation ? { tracks: [{ name: "Annotation", url: rawUrl(g.annotation), format: g.annotation.toLowerCase().includes(".gtf") ? "gtf" : "gff3", headers: authHeaders(), indexed: false, displayMode: "EXPANDED" }] } : {}),
  };
}

export const genomeLabel = (g: GenomeChoice) =>
  g.kind === "igv" ? GENOMES.find((x) => x.id === g.id)?.label ?? g.id
    : g.kind === "genark" ? g.accession : g.name;

/** The id a UCSC hub's trackDb uses for this genome (hubs list their assemblies by UCSC name). */
export const genomeDb = (g: GenomeChoice) => (g.kind === "igv" ? g.id : g.kind === "genark" ? g.accession : g.name);

let n = 0;
export const trackId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(n++).toString(36)}`;
