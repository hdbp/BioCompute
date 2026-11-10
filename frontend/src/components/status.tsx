import { Badge } from "@/components/ui/misc";
import type { NodeState, RunStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const RUN: Record<RunStatus, { tone: "neutral" | "accent" | "ok" | "bad" | "run" | "wait"; label: string }> = {
  pending: { tone: "neutral", label: "Pending" },
  preflight: { tone: "accent", label: "Preflight" },
  queued: { tone: "wait", label: "Queued" },
  running: { tone: "run", label: "Running" },
  cancelling: { tone: "wait", label: "Cancelling" },
  completed: { tone: "ok", label: "Completed" },
  failed: { tone: "bad", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  lost: { tone: "bad", label: "Lost" },
};

export function RunStatusBadge({ status, className }: { status: RunStatus | string; className?: string }) {
  const s = RUN[status as RunStatus] ?? { tone: "neutral", label: status };
  return (
    <Badge tone={s.tone} className={className}>
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
  draining: { tone: "wait", label: "Draining", help: "Finishing current work; accepts no new jobs." },
  disabled: { tone: "bad", label: "Disabled", help: "Blocked by an administrator." },
  offline: { tone: "neutral", label: "Offline", help: "No heartbeat in the last 3 minutes." },
};

export function NodeStateBadge({ state }: { state: NodeState }) {
  const s = NODE[state] ?? NODE.discovered;
  return <Badge tone={s.tone} title={s.help}>{s.label}</Badge>;
}
export const nodeStateHelp = (s: NodeState) => NODE[s]?.help ?? "";
