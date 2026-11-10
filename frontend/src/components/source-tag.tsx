import { cn } from "@/lib/utils";

/** How a machine became known to BioCompute. Each source has its own colour (tokens in index.css). */
export const SOURCES: Record<string, { label: string; token: string; help: string }> = {
  controller: { label: "Controller", token: "--src-controller", help: "This machine runs BioCompute." },
  agent: { label: "Agent", token: "--src-agent", help: "The BioCompute agent is installed and reporting." },
  tailscale: { label: "Tailscale", token: "--src-tailscale", help: "Listed by `tailscale status` on the controller." },
  neighbors: { label: "Neighbour table", token: "--src-neighbors", help: "Seen in the controller's ARP/NDP cache (passive)." },
  mdns: { label: "mDNS", token: "--src-mdns", help: "Announced itself with Bonjour/mDNS on the local network." },
  htcondor: { label: "HTCondor", token: "--src-htcondor", help: "Listed by `condor_status` as part of the HTCondor pool." },
  manual: { label: "Manual", token: "--src-manual", help: "Added by hand." },
  "agent-report": { label: "Reported", token: "--src-report", help: "Reported by a discovery agent on another network." },
};

export const sourceKey = (s: string) => s.split(":")[0];

export function sourceInfo(s: string) {
  const key = sourceKey(s);
  const base = SOURCES[key] ?? { label: key, token: "--src-manual", help: "" };
  if (key === "agent-report" && s.includes(":")) {
    const by = s.slice(s.indexOf(":") + 1);
    return { ...base, label: `Reported by ${by}`, help: `Reported by the discovery agent on ${by}.` };
  }
  return base;
}

export function SourceTag({ source, className, count, active, onClick }: {
  source: string; className?: string; count?: number; active?: boolean; onClick?: () => void;
}) {
  const info = sourceInfo(source);
  const color = `rgb(var(${info.token}))`;
  const style = {
    color,
    borderColor: `rgb(var(${info.token}) / ${active === false ? 0.25 : 0.45})`,
    backgroundColor: `rgb(var(${info.token}) / ${active ? 0.2 : active === false ? 0 : 0.12})`,
  };
  const content = (
    <>
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {info.label}
      {count !== undefined && <span className="tabular-nums opacity-70">{count}</span>}
    </>
  );
  const cls = cn("inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11.5px] font-medium whitespace-nowrap", className);
  return onClick
    ? <button type="button" onClick={onClick} aria-pressed={active} title={info.help} className={cn(cls, "hover:brightness-110", active === false && "opacity-70")} style={style}>{content}</button>
    : <span title={info.help} className={cls} style={style}>{content}</span>;
}

/** Tailnet membership pill, with online state when Tailscale reported it. */
export function TailnetTag({ tailnet }: { tailnet: { member: boolean; via: string | null; online: boolean | null; dns_name: string | null; ips: string[] } }) {
  if (!tailnet.member) return null;
  const color = "rgb(var(--src-tailscale))";
  const state = tailnet.online === true ? "online" : tailnet.online === false ? "offline" : null;
  const title = [`In your tailnet (${tailnet.via})`, tailnet.dns_name, tailnet.ips.join(", "), state && `Tailscale reports it ${state}`].filter(Boolean).join("\n");
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11.5px] font-medium"
      style={{ color, borderColor: "rgb(var(--src-tailscale) / 0.45)" }}>
      <span className={cn("size-1.5 rounded-full", tailnet.online === true ? "bg-ok" : tailnet.online === false ? "bg-muted" : "")}
        style={tailnet.online === null ? { backgroundColor: color } : undefined} />
      Tailnet{state ? `, ${state}` : ""}
    </span>
  );
}
