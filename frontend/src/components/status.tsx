import { Badge } from "@/components/ui/misc";
import type { NodeState, RunStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const RUN: Record<RunStatus, { tone: "neutral" | "accent" | "ok" | "bad" | "run" | "wait"; label: string; help: string }> = {
  pending: { tone: "neutral", label: "Pending", help: "Created; not started yet." },
  preflight: { tone: "accent", label: "Checking", help: "Checking inputs, tools and free space before starting (preflight)." },
  queued: { tone: "wait", label: "Queued", help: "Waiting for another run to finish." },
  running: { tone: "run", label: "Running", help: "Steps are being executed." },
  cancelling: { tone: "wait", label: "Cancelling", help: "Stopping the steps that are still running." },
  completed: { tone: "ok", label: "Completed", help: "Finished without errors." },
  failed: { tone: "bad", label: "Failed", help: "Stopped with an error. Open the run to see which step failed." },
  cancelled: { tone: "neutral", label: "Cancelled", help: "Stopped by a user." },
  lost: { tone: "bad", label: "Lost", help: "The run stopped reporting, for example after a restart of the computer. It can be resumed." },
};

/** Plain-word label of a run status ("Checking" for preflight). */
export const runStatusLabel = (status: RunStatus | string) => RUN[status as RunStatus]?.label ?? String(status);

export function RunStatusBadge({ status, className }: { status: RunStatus | string; className?: string }) {
  const s = RUN[status as RunStatus] ?? { tone: "neutral" as const, label: status, help: "" };
  return (
    <Badge tone={s.tone} className={className} title={s.help || undefined}>
      <span className={cn("size-1.5 rounded-full bg-current", (status === "running" || status === "cancelling") && "pulse-run")} />
      {s.label}
    </Badge>
  );
}

const NODE: Record<NodeState, { tone: "neutral" | "accent" | "ok" | "bad" | "run" | "wait"; label: string; help: string }> = {
  discovered: { tone: "neutral", label: "Discovered", help: "Seen on the network. Not authorized to run anything." },
  candidate: { tone: "accent", label: "Authorized", help: "Approved for enrollment; waiting for the owner to install the agent." },
  enrolled: { tone: "accent", label: "Enrolled", help: "Agent installed; waiting for a heartbeat." },
  active: { tone: "ok", label: "Online", help: "Agent reporting. Runs work if participation is enabled." },
  draining: { tone: "wait", label: "Draining", help: "Finishing current work; accepts no new runs." },
  disabled: { tone: "bad", label: "Disabled", help: "Blocked by an administrator." },
  offline: { tone: "neutral", label: "Offline", help: "No heartbeat in the last 3 minutes." },
};

export function NodeStateBadge({ state }: { state: NodeState }) {
  const s = NODE[state] ?? NODE.discovered;
  return <Badge tone={s.tone} title={s.help}>{s.label}</Badge>;
}
export const nodeStateHelp = (s: NodeState) => NODE[s]?.help ?? "";
