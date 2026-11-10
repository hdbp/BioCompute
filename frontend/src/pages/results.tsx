import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ChevronRight, ExternalLink, File, FileText, Folder, FolderOutput } from "lucide-react";
import { api, authed, qs } from "@/lib/api";
import type { Run } from "@/lib/types";
import { ago, bytes, cn } from "@/lib/utils";
import { PageHeader } from "@/components/page";
import { Empty, Panel, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { RunStatusBadge } from "@/components/status";

interface ResultRun extends Run { output_count: number; output_bytes: number }
interface Entry { name: string; path: string; type: "dir" | "file"; kind: string; size: number | null; mtime: number }

export default function ResultsPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const runs = useQuery({ queryKey: ["runs", "results"], queryFn: () => api.get<ResultRun[]>("/api/results") });
  useEffect(() => { if (!id && runs.data?.length) nav(`/results/${runs.data[0].id}`, { replace: true }); }, [id, runs.data, nav]);

  return (
    <>
      <PageHeader title="Results" description="Outputs of finished runs, read directly from each run's output folder." />
      {runs.data && runs.data.length === 0 ? (
        <Panel><Empty icon={<FolderOutput />} title="No finished runs yet" action={<Button asChild variant="primary"><Link to="/jobs/new">Launch analysis</Link></Button>}>Completed, failed and cancelled runs appear here with their output files and provenance.</Empty></Panel>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
          <Panel className="self-start max-h-[75vh] overflow-y-auto divide-y divide-line/60">
            {runs.isLoading && <div className="p-3 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12" />)}</div>}
            {runs.data?.map((r) => (
              <Link key={r.id} to={`/results/${r.id}`} className={cn("block px-4 py-3 hover:bg-raised/50", r.id === id && "bg-raised")}>
                <div className="flex items-center justify-between gap-2"><span className="truncate text-[13.5px] font-medium">{r.name}</span><RunStatusBadge status={r.status} /></div>
                <p className="mt-0.5 text-xs text-muted truncate">{r.pipeline_name}, {r.output_count} files, {bytes(r.output_bytes)}, {ago(r.finished_at)}</p>
              </Link>
            ))}
          </Panel>
          {id && <RunOutputs runId={id} run={runs.data?.find((r) => r.id === id)} />}
        </div>
      )}
    </>
  );
}

function RunOutputs({ runId, run }: { runId: string; run?: ResultRun }) {
  const [path, setPath] = useState("");
  const [file, setFile] = useState<Entry | null>(null);
  useEffect(() => { setPath(""); setFile(null); }, [runId]);
  const listing = useQuery({ queryKey: ["results", runId, path], queryFn: () => api.get<{ entries: Entry[]; missing: boolean; base: string; vpath: string | null }>(`/api/results/${runId}${qs({ path })}`) });
  const crumbs = path ? path.split("/") : [];
  return (
    <div className="min-w-0 space-y-4">
      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 text-[13px] overflow-x-auto">
            <button className="rounded px-1 font-medium hover:bg-raised" onClick={() => { setPath(""); setFile(null); }}>{run?.name ?? "output"}</button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-0.5"><ChevronRight className="size-3.5 text-muted" />
                <button className="rounded px-1 hover:bg-raised" onClick={() => { setPath(crumbs.slice(0, i + 1).join("/")); setFile(null); }}>{c}</button></span>
            ))}
          </div>
          <Button asChild size="sm" variant="ghost"><Link to={`/runs/${runId}`}>Run details</Link></Button>
        </div>
        <p className="px-4 pt-2 font-mono text-[11.5px] text-muted break-all">{listing.data?.vpath ?? listing.data?.base}</p>
        {listing.data?.missing && <p className="p-4 text-[13px] text-muted">The output folder does not exist (the run may have failed before writing results).</p>}
        <ul className="py-1">
          {listing.data?.entries.map((e) => (
            <li key={e.path}>
              <button onClick={() => (e.type === "dir" ? (setPath(e.path), setFile(null)) : setFile(e))}
                className={cn("flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-[13px] hover:bg-raised/60", file?.path === e.path && "bg-accent/10")}>
                {e.type === "dir" ? <Folder className="size-4 text-accent" /> : e.kind === "table" ? <FileText className="size-4 text-muted" /> : <File className="size-4 text-muted" />}
                <span className="flex-1 truncate">{e.name}</span>
                <span className="text-xs text-muted">{e.kind !== "dir" && e.kind !== "file" ? e.kind : ""}</span>
                <span className="w-20 text-right text-xs text-muted tabular-nums">{e.type === "file" ? bytes(e.size) : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
      {file && <Preview runId={runId} entry={file} />}
    </div>
  );
}

function Preview({ runId, entry }: { runId: string; entry: Entry }) {
  const url = `/api/results/${runId}/file${qs({ path: entry.path })}`;
  const isHtml = /\.html?$/i.test(entry.name);
  const isImg = /\.(png|jpe?g|svg)$/i.test(entry.name);
  const isPdf = /\.pdf$/i.test(entry.name);
  const text = useQuery({ queryKey: ["result-file", runId, entry.path], queryFn: () => api.get<{ binary: boolean; content?: string; truncated?: boolean; size: number }>(url), enabled: !isHtml && !isImg && !isPdf });
  const table = useMemo(() => {
    const c = text.data?.content;
    if (!c || !/\.(tsv|csv|txt)$/i.test(entry.name)) return null;
    const delim = entry.name.endsWith(".csv") ? "," : "\t";
    const lines = c.split("\n").filter(Boolean).slice(0, 501);
    if (lines.length < 2 || !lines[0].includes(delim)) return null;
    return lines.map((l) => l.split(delim));
  }, [text.data, entry.name]);
  return (
    <Panel>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <p className="flex-1 truncate text-[13.5px] font-medium">{entry.name}</p>
        {(isHtml || isPdf) && <a href={authed(url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text"><ExternalLink className="size-4" />Open in tab</a>}
        <a href={authed(`${url}&download=true`)} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text"><ArrowDownToLine className="size-4" />Download</a>
      </div>
      {isHtml && <iframe title={entry.name} src={authed(url)} sandbox="allow-scripts" className="h-[70vh] w-full bg-white" />}
      {isPdf && <iframe title={entry.name} src={authed(url)} className="h-[70vh] w-full" />}
      {isImg && <img src={authed(url)} alt={entry.name} className="max-h-[70vh] mx-auto p-4" />}
      {text.isLoading && <Skeleton className="m-4 h-40" />}
      {text.data?.binary && <p className="p-4 text-[13px] text-muted">Binary file ({bytes(text.data.size)}). Download it to open in a dedicated viewer (e.g. IGV for BAM/bigWig).</p>}
      {table ? (
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-surface"><tr>{table[0].map((h, i) => <th key={i} className="border-b border-line px-3 py-1.5 text-left font-medium text-muted whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>{table.slice(1).map((r, i) => <tr key={i} className="border-b border-line/40">{r.map((c, j) => <td key={j} className="px-3 py-1 whitespace-nowrap tabular-nums">{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : text.data?.content !== undefined && (
        <pre className="max-h-[60vh] overflow-auto p-4 font-mono text-[12px] whitespace-pre-wrap break-all">{text.data.content}{text.data.truncated && "\n… truncated; download for the full file"}</pre>
      )}
    </Panel>
  );
}
