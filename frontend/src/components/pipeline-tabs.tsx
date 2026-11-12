import { Link } from "react-router-dom";
import { qs } from "@/lib/api";
import type { PipelineDetail } from "@/lib/types";
import { cn, when } from "@/lib/utils";
import { Select } from "@/components/ui/input";

/** The sections of one pipeline. Map and Code are full-window pages; the others are tabs of the pipeline page (?tab=). */
export type PipelineTab = "map" | "params" | "io" | "versions" | "runs" | "code" | "readme";
export const DETAIL_TABS = ["params", "io", "versions", "runs", "readme"] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/** Where a section of a pipeline lives; `versionId` is kept in the URL so every section shows the same version. */
export function pipelineTabHref(pid: string, tab: PipelineTab, versionId?: string | null) {
  const version = versionId || undefined;
  if (tab === "map" || tab === "code") return `/pipelines/${pid}/${tab}${qs({ version })}`;
  return `/pipelines/${pid}${qs({ tab: tab === "params" ? undefined : tab, version })}`;
}

/**
 * The one tab strip of a pipeline, in the same order on every page:
 * Map · Parameters · Inputs and outputs · Versions · Runs · Code (· Readme).
 */
export function PipelineTabs({ pid, kind, hasReadme, runCount, active, versionId, compact, className }: {
  pid: string; kind?: PipelineDetail["kind"]; hasReadme?: boolean; runCount?: number; active: PipelineTab;
  versionId?: string | null; compact?: boolean; className?: string;
}) {
  const tabs: { id: PipelineTab; label: string; title: string; count?: number }[] = [
    { id: "map", label: "Map", title: "The steps of the pipeline and how data flows between them" },
    { id: "params", label: "Parameters", title: "The pipeline's parameters and your saved presets" },
    { id: "io", label: "Inputs and outputs", title: "What the pipeline needs for each sample and what it produces" },
    { id: "versions", label: "Versions", title: "Every version of this pipeline" },
    { id: "runs", label: "Runs", title: "Runs of this pipeline", count: runCount },
    ...(kind !== "studio" ? [{ id: "code" as const, label: "Code", title: "The pipeline's files" }] : []),
    ...(hasReadme ? [{ id: "readme" as const, label: "Readme", title: "The description that came with the pipeline" }] : []),
  ];
  return (
    <nav aria-label="Pipeline sections" className={cn("flex min-w-0 items-stretch gap-1 overflow-x-auto", className)}>
      {tabs.map((t) => (
        <Link key={t.id} to={pipelineTabHref(pid, t.id, versionId)} title={t.title} aria-current={active === t.id ? "page" : undefined}
          className={cn("relative shrink-0 whitespace-nowrap text-muted hover:text-text after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
            compact ? "px-2.5 py-1.5 text-[12.5px]" : "px-3 py-2 text-[13px]",
            active === t.id && "text-text after:bg-accent")}>
          {t.label}
          {t.count !== undefined && <span className="ml-1 text-xs text-muted tabular-nums">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** Version picker shared by the pipeline pages. `onChange(undefined)` means the default version (no ?version= in the URL). */
export function VersionSelect({ d, value, onChange, className }: {
  d: Pick<PipelineDetail, "versions" | "latest_version">; value: string; onChange: (versionId: string | undefined) => void; className?: string;
}) {
  if (!d.versions.length) return null;
  return (
    <Select className={cn("h-8 w-auto", className)} aria-label="Version" title="Version shown. New runs use the default version unless you choose another one."
      value={value} onChange={(e) => onChange(e.target.value === d.latest_version?.id ? undefined : e.target.value)}>
      {[...d.versions].reverse().map((v) => <option key={v.id} value={v.id}>{v.version}{v.id === d.latest_version?.id ? " (default)" : ""} · {when(v.created_at)}</option>)}
    </Select>
  );
}
