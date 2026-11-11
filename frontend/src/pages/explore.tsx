import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ChevronRight, Database, Dna, Download, File, FileImage, FileSpreadsheet, FileText, Folder, FolderOpen, Lock, Loader2, Telescope,
} from "lucide-react";
import { api, authed, errMsg, qs } from "@/lib/api";
import type { Run } from "@/lib/types";
import { bytes, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { TableView } from "@/components/explore/table-view";
import { MissingDataHint } from "@/components/missing-data-hint";
import { trackId, useExplorer, type TrackRef } from "@/components/explore/store";

const GenomeBrowser = lazy(() => import("@/components/explore/genome-browser"));

interface Root { name: string; restricted: boolean; writable: boolean; description: string; exists: boolean }
interface Entry { name: string; path: string; type: "dir" | "file"; kind: string; size: number | null; mtime: string }
interface Listing { path: string; entries: Entry[]; truncated?: boolean }
interface Info {
  path: string; name: string; size: number; viewer: "table" | "pdf" | "image" | "html" | "track" | "text" | "binary";
  table_format: string | null; restricted: boolean;
  track: { type: string; format: string; index: string | null; indexed: boolean; needs_index: boolean; too_big_unindexed: boolean } | null;
}

export default function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const path = params.get("path");
  const tab = params.get("tab") === "genome" ? "genome" : "files";
  const roots = useQuery({ queryKey: ["roots"], queryFn: () => api.get<Root[]>("/api/datasets/roots") });
  const dir = params.get("dir") ?? (path ? parentOf(path) : roots.data?.[0] ? `${roots.data[0].name}:` : null);
  const [genomeMounted, setGenomeMounted] = useState(tab === "genome");
  useEffect(() => { if (tab === "genome") setGenomeMounted(true); }, [tab]);
  const nTracks = useExplorer((s) => s.tracks.length);

  const go = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v === null ? n.delete(k) : n.set(k, v)));
    setParams(n, { replace: false });
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-surface" aria-label="Files">
        <FileTree roots={roots.data ?? []} dir={dir} selected={path} onDir={(d) => go({ dir: d, tab: null })}
          onFile={(p) => go({ path: p, dir: parentOf(p), tab: null })} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-line bg-surface px-3 pt-2">
          <Telescope className="mr-1 size-4 text-accent" />
          {([["files", "File viewer", FileText], ["genome", "Genome browser", Dna]] as const).map(([k, l, Icon]) => (
            <button key={k} onClick={() => go({ tab: k === "files" ? null : "genome" })} aria-pressed={tab === k}
              className={cn("-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px]", tab === k ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>
              <Icon className="size-3.5" />{l}{k === "genome" && nTracks > 0 && <span className="rounded bg-raised px-1 text-[11px] tabular-nums">{nTracks}</span>}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <div className={tab === "files" ? "" : "hidden"}>
            {path ? <FileView path={path} onOpenGenome={() => go({ tab: "genome" })} /> : <Intro />}
          </div>
          {genomeMounted && (
            <div className={tab === "genome" ? "" : "hidden"}>
              <Suspense fallback={<p className="flex items-center gap-2 text-[13px] text-muted"><Loader2 className="size-4 animate-spin" />Loading the genome browser…</p>}>
                <GenomeBrowser visible={tab === "genome"} />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const parentOf = (p: string) => {
  const [root, rel = ""] = p.split(/:(.*)/s);
  const parts = rel.split("/").filter(Boolean);
  parts.pop();
  return `${root}:${parts.join("/")}`;
};

function Intro() {
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <Telescope className="mx-auto mb-3 size-8 text-accent" />
      <p className="font-medium">Explore your data</p>
      <p className="mt-1 text-[13px] text-muted">
        Pick a file on the left. Tables open with sorting, filtering and density-coloured plots; PDFs, images and reports open in place;
        BAM, bigWig, BED, peaks and VCF files go to the genome browser, next to tracks from public hubs.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- file tree
const ICON: Record<string, typeof File> = { table: FileSpreadsheet, image: FileImage, report: FileText, bed: Dna, bam: Dna, bigwig: Dna, vcf: Dna, fasta: Dna };

function FileTree({ roots, dir, selected, onDir, onFile }: {
  roots: Root[]; dir: string | null; selected: string | null; onDir: (d: string) => void; onFile: (p: string) => void;
}) {
  const ls = useQuery({ queryKey: ["browse", dir], queryFn: () => api.get<Listing>(`/api/datasets/browse${qs({ path: dir })}`), enabled: !!dir });
  const runs = useQuery({ queryKey: ["results"], queryFn: () => api.get<Run[]>("/api/results") });
  const [root, rel = ""] = (dir ?? "").split(/:(.*)/s);
  const crumbs = rel.split("/").filter(Boolean);
  const openRun = async (id: string) => {
    try {
      const r = await api.get<{ vpath: string | null }>(`/api/results/${id}`);
      if (r.vpath) onDir(r.vpath); else toast.error("This run's outputs are outside the data folders");
    } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <>
      <div className="space-y-2 border-b border-line p-3">
        <Select aria-label="Data folder" className="h-8" value={root} onChange={(e) => onDir(`${e.target.value}:`)}>
          {roots.map((r) => <option key={r.name} value={r.name}>{r.name}{r.restricted ? " (restricted)" : ""}</option>)}
        </Select>
        {(runs.data?.length ?? 0) > 0 && (
          <Select aria-label="Run outputs" className="h-8" value="" onChange={(e) => e.target.value && openRun(e.target.value)}>
            <option value="">Jump to a run's outputs…</option>
            {runs.data!.slice(0, 50).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        )}
        <nav className="flex flex-wrap items-center gap-0.5 text-[12px] text-muted" aria-label="Folder path">
          <button className="hover:text-text" onClick={() => onDir(`${root}:`)}><Database className="mr-1 inline size-3" />{root}</button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5"><ChevronRight className="size-3" />
              <button className="hover:text-text" onClick={() => onDir(`${root}:${crumbs.slice(0, i + 1).join("/")}`)}>{c}</button></span>
          ))}
        </nav>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {ls.isLoading && <li className="p-3 text-[13px] text-muted">Loading…</li>}
        {ls.isError && <li className="p-3 text-[13px] text-bad">{errMsg(ls.error)}</li>}
        {ls.data?.entries.length === 0 && <li className="p-3 text-[13px] text-muted">Empty folder.</li>}
        {ls.data?.entries.map((e) => {
          const Icon = e.type === "dir" ? Folder : ICON[e.kind] ?? File;
          return (
            <li key={e.path}>
              <button onClick={() => (e.type === "dir" ? onDir(e.path) : onFile(e.path))} title={e.name}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-raised", selected === e.path && "bg-raised text-accent")}>
                <Icon className={cn("size-3.5 shrink-0", e.type === "dir" ? "text-accent" : "text-muted")} />
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {e.size != null && <span className="shrink-0 text-[11px] text-muted tabular-nums">{bytes(e.size)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <MissingDataHint className="border-t border-line px-3 py-2" />
    </>
  );
}

// ---------------------------------------------------------------- file view
function FileView({ path, onOpenGenome }: { path: string; onOpenGenome: () => void }) {
  const info = useQuery({ queryKey: ["explore-info", path], queryFn: () => api.get<Info>(`/api/explore/info${qs({ path })}`) });
  const { tracks, addTracks, setGenome } = useExplorer();
  if (info.isError) return <p className="text-[13px] text-bad">{errMsg(info.error)}</p>;
  const d = info.data;
  if (!d) return <p className="flex items-center gap-2 text-[13px] text-muted"><Loader2 className="size-4 animate-spin" />Opening…</p>;
  const tr = d.track;
  const onBrowser = tracks.some((t) => t.path === d.path);
  const addTrack = () => {
    if (!tr) return;
    if (tr.needs_index && !tr.indexed) { toast.error(`${d.name} has no index next to it. Create one (samtools index / tabix) and try again.`); return; }
    if (tr.too_big_unindexed && !window.confirm(`${d.name} is ${bytes(d.size)} and not indexed, so the genome browser must read all of it. Continue?`)) return;
    const ref: TrackRef = { id: trackId("file"), source: "file", name: d.name, type: tr.type, format: tr.format, path: d.path, index: tr.index };
    addTracks([ref]);
    toast.success(`Added ${d.name} to the genome browser`, { action: { label: "Show", onClick: onOpenGenome } });
  };
  const useAsGenome = () => {
    if (!tr?.index) { toast.error(`No .fai index for ${d.name}. Create one with: samtools faidx ${d.name}`); return; }
    setGenome({ kind: "fasta", name: d.name.replace(/\.(fa|fasta|fna)(\.gz)?$/i, ""), path: d.path, index: tr.index });
    onOpenGenome();
  };
  const raw = authed(`/api/explore/raw${qs({ path: d.path })}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <FolderOpen className="size-4 text-muted" />
        <h1 className="min-w-0 truncate text-[15px] font-semibold" title={d.path}>{d.name}</h1>
        <span className="text-xs text-muted tabular-nums">{bytes(d.size)}</span>
        {d.restricted && <Badge tone="wait"><Lock className="size-3" />restricted data</Badge>}
        <div className="ml-auto flex gap-2">
          {tr && tr.type !== "reference" && (
            onBrowser ? <Button size="sm" variant="secondary" onClick={onOpenGenome}><Dna />Show in genome browser</Button>
              : <Button size="sm" variant="primary" onClick={addTrack}><Dna />Add to genome browser</Button>
          )}
          {tr?.type === "reference" && <Button size="sm" variant="primary" onClick={useAsGenome}><Dna />Use as genome</Button>}
          <a href={authed(`/api/datasets/download${qs({ path: d.path })}`)} className="inline-flex"><Button size="sm" variant="secondary" tabIndex={-1}><Download />Download</Button></a>
        </div>
      </div>
      {tr && tr.needs_index && !tr.indexed && tr.type !== "reference" && (
        <p className="rounded-md border border-wait/40 bg-wait/10 px-3 py-2 text-[12.5px]">No index found next to this file. The genome browser needs one: <code>samtools index {d.name}</code>.</p>
      )}
      {d.viewer === "table" && <TableView path={d.path} />}
      {d.viewer === "pdf" && <iframe title={d.name} src={raw} className="h-[80vh] w-full rounded-lg border border-line bg-white" />}
      {d.viewer === "image" && <div className="overflow-auto rounded-lg border border-line bg-white p-2"><img src={raw} alt={d.name} className="mx-auto max-w-full" /></div>}
      {d.viewer === "html" && (
        <>
          <p className="text-[12px] text-muted">Shown in a sandbox: its scripts run, but it cannot reach BioCompute or your session.</p>
          <iframe title={d.name} src={raw} sandbox="allow-scripts allow-popups" className="h-[80vh] w-full rounded-lg border border-line bg-white" />
        </>
      )}
      {d.viewer === "text" && <TextView path={d.path} />}
      {d.viewer === "track" && (
        <div className="rounded-lg border border-line bg-surface p-4 text-[13px]">
          <p><b className="font-medium">{tr?.format}</b> {tr?.type === "reference" ? "reference sequence" : "track"}{tr?.indexed ? `, indexed (${tr.index?.split("/").pop()})` : ""}.</p>
          <p className="mt-1 text-muted">{tr?.type === "reference" ? "Use it as the genome in the genome browser, for assemblies that are not public or when working offline."
            : "Binary genomic data: open it in the genome browser to look at the signal or alignments."}</p>
        </div>
      )}
      {d.viewer === "binary" && <p className="text-[13px] text-muted">Binary file; no preview. Download it to open it elsewhere.</p>}
    </div>
  );
}

function TextView({ path }: { path: string }) {
  const q = useQuery({ queryKey: ["preview", path], queryFn: () => api.get<{ content: string | null; truncated: boolean; binary: boolean }>(`/api/datasets/preview${qs({ path })}`) });
  if (!q.data) return <p className="text-[13px] text-muted">{q.isError ? errMsg(q.error) : "Loading…"}</p>;
  return (
    <div className="space-y-1">
      <pre className="max-h-[75vh] overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-[12px] leading-relaxed">{q.data.content}</pre>
      {q.data.truncated && <p className="text-xs text-muted">Showing the first 64 kB.</p>}
    </div>
  );
}
