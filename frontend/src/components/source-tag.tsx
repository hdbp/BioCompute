import { cn } from "@/lib/utils";

/** How a machine became known to BioCompute. Each source has its own colour (tokens in index.css). */
// order follows the viridis ramp in index.css
export const SOURCES: Record<string, { label: string; token: string; help: string }> = {
  controller: { label: "Controller", token: "--src-controller", help: "This machine runs BioCompute." },
  agent: { label: "Agent", token: "--src-agent", help: "The BioCompute agent is installed and reporting." },
  tailscale: { label: "Tailscale", token: "--src-tailscale", help: "Listed by `tailscale status` on the controller." },
  htcondor: { label: "HTCondor", token: "--src-htcondor", help: "Listed by `condor_status` as part of the HTCondor pool." },
  mdns: { label: "mDNS", token: "--src-mdns", help: "Announced itself with Bonjour/mDNS on the local network." },
  neighbors: { label: "Neighbour table", token: "--src-neighbors", help: "Seen in the controller's ARP/NDP cache (passive)." },
  "agent-report": { label: "Reported", token: "--src-report", help: "Reported by a discovery agent on another network." },
  manual: { label: "Manual", token: "--src-manual", help: "Added by hand." },
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

/** Filled viridis chip; colours per theme in index.css (contrast-checked against the page and the text). */
export function SourceTag({ source, className, count, active, onClick }: {
  source: string; className?: string; count?: number; active?: boolean; onClick?: () => void;
}) {
  const info = sourceInfo(source);
  const off = active === false;  // filter chip that is currently not selected
  const style = off
    ? { color: "rgb(var(--text))", backgroundColor: "transparent", boxShadow: `inset 0 0 0 1.5px rgb(var(${info.token}))` }
    : { color: "rgb(var(--src-ink))", backgroundColor: `rgb(var(${info.token}))`,
        boxShadow: active ? "0 0 0 2px rgb(var(--surface)), 0 0 0 3.5px rgb(var(--text) / 0.6)" : undefined };
  const content = (
    <>
      {info.label}
      {count !== undefined && <span className="tabular-nums opacity-75">{count}</span>}
    </>
  );
  const cls = cn("inline-flex items-center gap-1 rounded px-1.5 py-px text-[11.5px] font-medium whitespace-nowrap", className);
  return onClick
    ? <button type="button" onClick={onClick} aria-pressed={active} title={info.help} className={cn(cls, "hover:brightness-110")} style={style}>{content}</button>
    : <span title={info.help} className={cls} style={style}>{content}</span>;
}

/** Tailnet membership chip (viridis "tailscale" colour), with Tailscale's online state when known. */
export function TailnetTag({ tailnet }: { tailnet: { member: boolean; via: string | null; online: boolean | null; dns_name: string | null; ips: string[] } }) {
  if (!tailnet.member) return null;
  const state = tailnet.online === true ? "online" : tailnet.online === false ? "offline" : null;
  const title = [`In your tailnet (${tailnet.via})`, tailnet.dns_name, tailnet.ips.join(", "), state && `Tailscale reports it ${state}`].filter(Boolean).join("\n");
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11.5px] font-medium"
      style={{ color: "rgb(var(--src-ink))", backgroundColor: "rgb(var(--src-tailscale))" }}>
      {state && <span className={cn("size-1.5 rounded-full", tailnet.online ? "bg-current" : "border border-current")} />}
      Tailnet{state ? `, ${state}` : ""}
    </span>
  );
}
