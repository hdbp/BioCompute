import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, X } from "lucide-react";
import { api } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { ClusterNode, Pipeline } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Panel } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";

const KEY = "biocompute.getting-started";

/** Checklist shown after first-run setup until dismissed. Each step is ticked from the real state of the installation. */
export function GettingStarted() {
  const user = useAuth((s) => s.user);
  const [show, setShow] = useState(() => { try { return localStorage.getItem(KEY) === "show"; } catch { return false; } });
  const enabled = show && can(user, "admin");
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ data_roots: { source?: string; description: string }[] }>("/api/settings"), enabled });
  const pipelines = useQuery({ queryKey: ["pipelines"], queryFn: () => api.get<Pipeline[]>("/api/pipelines"), enabled });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => api.get<ClusterNode[]>("/api/nodes"), enabled });
  const results = useQuery({ queryKey: ["results"], queryFn: () => api.get<unknown[]>("/api/results"), enabled });
  const ai = useQuery({ queryKey: ["assistant-status"], queryFn: () => api.get<{ enabled: boolean }>("/api/assistant/status"), enabled });
  if (!enabled) return null;

  const dismiss = () => { try { localStorage.setItem(KEY, "dismissed"); } catch { /* ignore */ } setShow(false); };
  const steps = [
    { done: (settings.data?.data_roots ?? []).some((r) => r.source === "ui" || !/demo|bundled/i.test(r.description)),
      title: "Add the folders that hold your data", text: "Sequencing runs, references and a folder for results, on this computer or mounted on it.",
      to: "/settings?tab=system", action: "Add data folders" },
    { done: (pipelines.data ?? []).some((p) => p.kind !== "template" && p.slug !== "biocompute-fastq-qc"),
      title: "Get a pipeline", text: "Install an nf-core pipeline, import your own, or build one in Pipeline Studio.",
      to: "/pipelines", action: "Open Pipelines" },
    { done: (results.data?.length ?? 0) > 0,
      title: "Run an analysis", text: "Pick a pipeline and its samples: an experiment, a samplesheet or a folder of FASTQ files.",
      to: "/jobs/new", action: "Launch analysis" },
    { done: (nodes.data ?? []).some((n) => !n.is_controller && ["enrolled", "active", "draining"].includes(n.state)), optional: true,
      title: "Add more computers", text: "Enroll the other machines in your lab so long jobs can use them.", to: "/nodes", action: "Open Nodes" },
    { done: !!ai.data?.enabled, optional: true,
      title: "Turn on the pipeline assistant", text: "Claude, ChatGPT or Claude Code can build and review pipelines with you.",
      to: "/settings?tab=assistant", action: "Set up" },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <Panel className="mb-6 p-4">
      <div className="mb-3 flex items-start gap-3">
        <div className="flex-1">
          <p className="font-semibold">Getting started</p>
          <p className="text-[13px] text-muted">{doneCount} of {steps.length} done. Your account is ready; these steps make BioCompute useful.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={dismiss} aria-label="Hide getting started"><X />Hide</Button>
      </div>
      <ol className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {steps.map((s) => (
          <li key={s.title} className={cn("flex gap-3 rounded-lg border border-line p-3", s.done && "opacity-70")}>
            {s.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted" />}
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium">{s.title}{s.optional && <span className="ml-1.5 text-xs font-normal text-muted">optional</span>}</p>
              <p className="text-[12.5px] text-muted">{s.text}</p>
              {!s.done && <Link to={s.to} className="mt-1 inline-block text-[12.5px] text-accent hover:underline">{s.action}</Link>}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
