import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import igv from "igv";
import { ArrowLeft, ExternalLink, Loader2, RefreshCw, Search } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge, Checkbox } from "@/components/ui/misc";
import { genomeDb, genomeLabel, trackId, type GenomeChoice, type TrackRef } from "./store";

interface PublicHub { url: string; short_label: string; long_label: string; genomes: string[]; description_url: string | null }
interface HubList { hubs: PublicHub[]; source: string | null; cached?: boolean; stale?: boolean; disabled?: boolean; error?: string }
interface Container { name: string; label: string; tracks: Record<string, unknown>[]; children: Container[] }
interface Hub { getGroupedTrackConfigurations: (genomeId: string) => Promise<Container[]>; genomeStanzas?: unknown[] }
const loadHub = (igv as unknown as { loadHub: (url: string) => Promise<Hub> }).loadHub;

/** Browse UCSC's public track hubs (or any hub.txt URL) and add chosen tracks to the genome browser. */
export function HubDialog({ open, onOpenChange, genome, onAddTracks, onUseGenome }: {
  open: boolean; onOpenChange: (o: boolean) => void; genome: GenomeChoice;
  onAddTracks: (t: TrackRef[]) => void; onUseGenome: (g: GenomeChoice) => void;
}) {
  const db = genomeDb(genome);
  const list = useQuery({ queryKey: ["public-hubs"], queryFn: () => api.get<HubList>("/api/explore/hubs"), staleTime: 3_600_000, retry: false });
  const [q, setQ] = useState("");
  const [onlyGenome, setOnlyGenome] = useState(true);
  const [custom, setCustom] = useState("");
  const [hub, setHub] = useState<{ url: string; label: string; groups: Container[] } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const hubs = useMemo(() => {
    const f = q.toLowerCase();
    return (list.data?.hubs ?? []).filter((h) => (!onlyGenome || h.genomes.includes(db))
      && (!f || h.short_label.toLowerCase().includes(f) || h.long_label.toLowerCase().includes(f) || h.genomes.some((g) => g.toLowerCase() === f)));
  }, [list.data, q, onlyGenome, db]);

  const openHub = async (url: string, label: string) => {
    setOpening(url);
    setHubError(null);
    try {
      const h = await loadHub(url);
      const groups = (await h.getGroupedTrackConfigurations(db)).filter((g) => count(g) > 0);
      setHub({ url, label, groups });
      setPicked(new Set());
    } catch (e) {
      setHubError(`${errMsg(e)}. The hub's server may not allow access from a browser (CORS), or it may be offline.`);
    } finally {
      setOpening(null);
    }
  };

  const allTracks = useMemo(() => (hub ? hub.groups.flatMap(flatten) : []), [hub]);
  const add = () => {
    const chosen = allTracks.filter((t) => picked.has(key(t)));
    onAddTracks(chosen.map((cfg) => ({
      id: trackId("hub"), source: "hub" as const, name: String(cfg.name ?? "track"), type: String(cfg.type ?? ""),
      config: JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>,
    })));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide title={hub ? hub.label : "Public track hubs"}
        description={hub ? `Tracks for ${genomeLabel(genome)}. Choose the ones to show.` : "Track hubs registered with the UCSC Genome Browser, plus any hub by URL. Data is read by your browser from each hub's own server."}>
        {hub ? (
          <div className="space-y-3">
            <Button size="sm" variant="ghost" onClick={() => setHub(null)}><ArrowLeft />All hubs</Button>
            {hub.groups.length === 0 ? (
              <div className="space-y-2 text-[13px]">
                <p>This hub has no tracks for {genomeLabel(genome)}.</p>
                <Button size="sm" variant="secondary" onClick={() => onUseGenome({ kind: "hub", url: hub.url, name: hub.label })}>Switch to this hub's own genome</Button>
              </div>
            ) : (
              <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
                {hub.groups.map((g, i) => <Group key={i} c={g} picked={picked} setPicked={setPicked} />)}
              </div>
            )}
            <DialogFooter>
              <span className="mr-auto self-center text-xs text-muted">{picked.size} of {allTracks.length} selected</span>
              <Button variant="primary" disabled={!picked.size} onClick={add}>Add {picked.size || ""} track{picked.size === 1 ? "" : "s"}</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (/^https?:\/\/.+/.test(custom)) openHub(custom, custom.split("/").slice(-2, -1)[0] || "Hub"); }}>
              <Input value={custom} onChange={(e) => setCustom(e.target.value.trim())} placeholder="Open a hub by its hub.txt URL" aria-label="Hub URL" />
              <Button type="submit" size="sm" variant="secondary" loading={opening === custom}>Open</Button>
            </form>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-2.5 size-3.5 text-muted" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search hubs (e.g. ENCODE, methylation, Roadmap)" className="h-8 pl-7" aria-label="Search hubs" />
              </div>
              <label className="flex items-center gap-2 text-[12.5px] text-muted">
                <Checkbox checked={onlyGenome} onCheckedChange={(c) => setOnlyGenome(!!c)} />Only hubs with {db}
              </label>
            </div>
            {hubError && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12.5px]">{hubError}</p>}
            {list.isLoading ? <p className="flex items-center gap-2 py-6 text-[13px] text-muted"><Loader2 className="size-4 animate-spin" />Loading the hub list…</p>
              : list.isError ? <p className="py-3 text-[13px] text-bad">{errMsg(list.error)}</p>
              : list.data?.disabled ? <p className="py-3 text-[13px] text-muted">The public hub list is turned off on this controller (BIOCOMPUTE_EXPLORER_PUBLIC_HUBS_URL is empty). You can still open a hub by URL.</p>
              : (
                <>
                  <p className="flex items-center gap-2 text-xs text-muted">
                    {hubs.length} of {list.data?.hubs.length ?? 0} hubs
                    {list.data?.stale && <Badge tone="wait">offline copy</Badge>}
                    <button className="ml-auto inline-flex items-center gap-1 hover:text-text" onClick={() => api.get<HubList>("/api/explore/hubs?refresh=true").then(() => list.refetch())}><RefreshCw className="size-3" />Refresh</button>
                  </p>
                  <ul className="max-h-[48vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
                    {hubs.slice(0, 300).map((h) => (
                      <li key={h.url} className="flex items-start gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 text-[13.5px] font-medium">{h.short_label}
                            {h.description_url && <a href={h.description_url} target="_blank" rel="noreferrer" className="text-muted hover:text-text" aria-label="Hub description"><ExternalLink className="size-3" /></a>}</p>
                          <p className="line-clamp-2 text-[12px] text-muted">{h.long_label}</p>
                          <p className="mt-0.5 truncate text-[11px] text-muted">{h.genomes.slice(0, 8).join(", ")}{h.genomes.length > 8 ? ` +${h.genomes.length - 8}` : ""}</p>
                        </div>
                        <Button size="sm" variant="secondary" loading={opening === h.url} onClick={() => openHub(h.url, h.short_label)}>Open</Button>
                      </li>
                    ))}
                    {hubs.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">No hubs match{onlyGenome ? ` for ${db}` : ""}.</li>}
                  </ul>
                </>
              )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const key = (t: Record<string, unknown>) => String(t.url ?? t.name);
const flatten = (c: Container): Record<string, unknown>[] => [...c.tracks, ...(c.children ?? []).flatMap(flatten)];
const count = (c: Container): number => flatten(c).length;

function Group({ c, picked, setPicked, depth = 0 }: { c: Container; picked: Set<string>; setPicked: (s: Set<string>) => void; depth?: number }) {
  const all = flatten(c);
  const sel = all.filter((t) => picked.has(key(t))).length;
  const toggleAll = () => {
    const n = new Set(picked);
    if (sel === all.length) all.forEach((t) => n.delete(key(t))); else all.forEach((t) => n.add(key(t)));
    setPicked(n);
  };
  return (
    <details open={depth === 0 && all.length <= 40} className="rounded-md border border-line/70">
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[13px]">
        <Checkbox checked={sel === all.length ? true : sel ? "indeterminate" : false} onCheckedChange={toggleAll} onClick={(e) => e.stopPropagation()} aria-label={`Select all in ${c.label || c.name || "group"}`} />
        <span className="font-medium">{c.label || c.name || "Tracks"}</span>
        <span className="text-xs text-muted">{sel ? `${sel}/` : ""}{all.length}</span>
      </summary>
      <div className="space-y-0.5 border-t border-line/70 px-2 py-1.5">
        {c.tracks.map((t) => (
          <label key={key(t)} className="flex items-center gap-2 py-0.5 text-[12.5px]">
            <Checkbox checked={picked.has(key(t))} onCheckedChange={(v) => { const n = new Set(picked); if (v) n.add(key(t)); else n.delete(key(t)); setPicked(n); }} />
            <span className="truncate">{String(t.name ?? t.url)}</span>
            {t.format ? <span className="text-[11px] text-muted">{String(t.format)}</span> : null}
          </label>
        ))}
        {(c.children ?? []).filter((x) => count(x) > 0).map((ch, i) => <Group key={i} c={ch} picked={picked} setPicked={setPicked} depth={depth + 1} />)}
      </div>
    </details>
  );
}
