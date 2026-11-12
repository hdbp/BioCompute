import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { CheckCircle2, Circle, X } from "lucide-react";
import { api } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { ClusterNode, Experiment, Pipeline, Run } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Panel } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";

const KEY = "biocompute.getting-started";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable: the choice lasts until the page is reloaded */ } };

interface Step { done: boolean; optional?: boolean; title: string; text: string; to: string; action: string; onGo?: () => void }

/**
 * Getting started on the Home page. The administrator who ran first-time setup gets the setup checklist;
 * every other scientist gets the three steps from samples to a first run, until they are done or hidden.
 */
export function GettingStarted() {
  const user = useAuth((s) => s.user);
  return can(user, "admin") ? <AdminChecklist /> : <ScientistChecklist />;
}

function Checklist({ steps, intro, onHide }: { steps: Step[]; intro: string; onHide: () => void }) {
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <Panel className="mb-6 p-4" role="region" aria-label="Getting started">
      <div className="mb-3 flex items-start gap-3">
        <div className="flex-1">
          <p className="font-semibold">Getting started</p>
          <p className="text-[13px] text-muted">{doneCount} of {steps.length} done. {intro}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onHide} aria-label="Hide getting started"><X />Hide</Button>
      </div>
      <ol className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {steps.map((s) => (
          <li key={s.title} className={cn("flex gap-3 rounded-lg border border-line p-3", s.done && "opacity-70")}>
            {s.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-label="Done" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted" aria-label="To do" />}
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium">{s.title}{s.optional && <span className="ml-1.5 text-xs font-normal text-muted">optional</span>}</p>
              <p className="text-[12.5px] text-muted">{s.text}</p>
              {!s.done && <Link to={s.to} onClick={s.onGo} className="mt-1 inline-block text-[12.5px] text-accent hover:underline">{s.action}</Link>}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** Checklist shown after first-run setup until dismissed. Each step is ticked from the real state of the installation. */
function AdminChecklist() {
  const [show, setShow] = useState(() => read(KEY) === "show");
  const enabled = show;
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ data_roots: { source?: string; description: string }[] }>("/api/settings"), enabled });
  const pipelines = useQuery({ queryKey: ["pipelines"], queryFn: () => api.get<Pipeline[]>("/api/pipelines"), enabled });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => api.get<ClusterNode[]>("/api/nodes"), enabled });
  const results = useQuery({ queryKey: ["results"], queryFn: () => api.get<unknown[]>("/api/results"), enabled });
  const ai = useQuery({ queryKey: ["assistant-status"], queryFn: () => api.get<{ enabled: boolean }>("/api/assistant/status"), enabled });
  if (!enabled) return null;

  const steps: Step[] = [
    { done: (settings.data?.data_roots ?? []).some((r) => r.source === "ui" || !/demo|bundled/i.test(r.description)),
      title: "Add the folders that hold your data", text: "Sequencing runs, references and a folder for results, on this computer or mounted on it.",
      to: "/settings?tab=system", action: "Add data folders" },
    { done: (pipelines.data ?? []).some((p) => p.kind !== "template" && p.slug !== "biocompute-fastq-qc"),
      title: "Get a pipeline", text: "Install an nf-core pipeline, import your own, or build one in Pipeline Studio.",
      to: "/pipelines", action: "Open Pipelines" },
    { done: (results.data?.length ?? 0) > 0,
      title: "Start a run", text: "Pick a pipeline and its samples: an experiment, a samplesheet or a folder of FASTQ files.",
      to: "/jobs/new", action: "New run" },
    { done: (nodes.data ?? []).some((n) => !n.is_controller && ["enrolled", "active", "draining"].includes(n.state)), optional: true,
      title: "Add more computers", text: "Enroll the other machines in your lab so long runs can use them.", to: "/nodes", action: "Open Nodes" },
    { done: !!ai.data?.enabled, optional: true,
      title: "Turn on the pipeline assistant", text: "Claude, ChatGPT or Claude Code can build and review pipelines with you.",
      to: "/settings?tab=assistant", action: "Set up" },
  ];
  return <Checklist steps={steps} intro="Your account is ready; these steps make BioCompute useful." onHide={() => { write(KEY, "dismissed"); setShow(false); }} />;
}

// ---------------------------------------------------------------------------- scientists
// Hidden and "looked at a pipeline" are remembered per person in this browser; a small store keeps every user of the hook in step.
const flag = (kind: "hidden" | "pipeline", username: string) => `${KEY}.${kind}.${username}`;
const useFlags = create<{ v: Record<string, boolean>; set: (k: string) => void }>((set) => ({
  v: {}, set: (k) => { write(k, "1"); set((s) => ({ v: { ...s.v, [k]: true } })); },
}));
const useFlag = (k: string): [boolean, () => void] => {
  const on = useFlags((s) => s.v[k]) ?? read(k) === "1";
  const set = useFlags((s) => s.set);
  return [on, () => set(k)];
};

/**
 * The three steps of a scientist who is new here, ticked from what they really did (an experiment of theirs, a run of theirs).
 * `visible` is false for administrators and viewers, once hidden, and once all three are done.
 */
export function useScientistChecklist(): { visible: boolean; steps: Step[]; hide: () => void } {
  const user = useAuth((s) => s.user);
  const me = user?.username ?? "";
  const eligible = !!user && user.role === "scientist";
  const [hidden, hide] = useFlag(flag("hidden", me));
  const [sawPipeline, markPipeline] = useFlag(flag("pipeline", me));
  const enabled = eligible && !hidden;
  const experiments = useQuery({ queryKey: ["experiments"], queryFn: () => api.get<Experiment[]>("/api/experiments"), enabled });
  const runs = useQuery({ queryKey: ["runs", "home"], queryFn: () => api.get<Run[]>("/api/runs?limit=100"), enabled });
  const myExperiments = (experiments.data ?? []).filter((e) => e.created_by === me).length;
  const myRuns = (runs.data ?? []).filter((r) => r.created_by === me).length;
  const steps: Step[] = [
    { done: myExperiments > 0, title: "Create an experiment",
      text: "The table of your samples: their FASTQ files, conditions and replicates. Files are picked from the lab's data folders.",
      to: "/experiments", action: "Add samples" },
    { done: sawPipeline || myRuns > 0, title: "Look at a pipeline",
      text: "See what the installed pipelines do, which samples they expect and which parameters they offer.",
      to: "/pipelines", action: "Browse pipelines", onGo: markPipeline },
    { done: myRuns > 0, title: "Start a run",
      text: "Combine a pipeline with your experiment, check the parameters and start. You are told when it finishes.",
      to: "/jobs/new", action: "New run" },
  ];
  // wait for the real state before showing anything, so the list does not flash for someone who did all of this long ago
  const known = !!experiments.data && !!runs.data;
  return { visible: enabled && known && steps.some((s) => !s.done), steps, hide };
}

function ScientistChecklist() {
  const { visible, steps, hide } = useScientistChecklist();
  if (!visible) return null;
  return <Checklist steps={steps} intro="Three steps from your samples to your first results." onHide={hide} />;
}
