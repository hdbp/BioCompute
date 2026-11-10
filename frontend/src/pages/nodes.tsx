import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, CircleDashed, Copy, KeyRound, Laptop, Loader2, MinusCircle, Plus, Radar, Server, ShieldCheck, Terminal, Trash2 } from "lucide-react";
import { api, errMsg, qs } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { Allocation, ClusterNode } from "@/lib/types";
import { ago, bytes, cn, gb } from "@/lib/utils";
import { KV, PageHeader } from "@/components/page";
import { Badge, Checkbox, Empty, Panel, Skeleton, Slider, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Tip } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, Sheet } from "@/components/ui/dialog";
import { CoreLattice, LatticeLegend } from "@/components/lattice";
import { SOURCES, SourceTag, TailnetTag, sourceKey } from "@/components/source-tag";
import { NodeStateBadge, nodeStateHelp } from "@/components/status";

const FILTERS = [
  { id: "all", label: "All", states: null },
  { id: "participating", label: "Enrolled", states: ["active", "enrolled", "draining", "offline"] },
  { id: "candidate", label: "Authorized", states: ["candidate"] },
  { id: "discovered", label: "Discovered", states: ["discovered"] },
  { id: "disabled", label: "Disabled", states: ["disabled"] },
];
type Presets = Record<string, { label: string; description: string }>;

export default function NodesPage() {
  const [sp, setSp] = useSearchParams();
  const filter = sp.get("filter") ?? "all";
  const user = useAuth((s) => s.user);
  const admin = can(user, "admin");
  const qc = useQueryClient();
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => api.get<ClusterNode[]>("/api/nodes"), refetchInterval: 15000 });
  const presets = useQuery({ queryKey: ["presets"], queryFn: () => api.get<Presets>("/api/allocations/presets") });
  const [selected, setSelected] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState<false | { label: string; site: string }>(false);
  const net = sp.get("net") ?? "all";                     // all | in | out (tailnet)
  const srcs = (sp.get("src") ?? "").split(",").filter(Boolean);
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v); else next.delete(k);
    setSp(next, { replace: true });
  };

  // network + source filters apply first; the lifecycle tabs then count within them
  const scoped = useMemo(() => (nodes.data ?? []).filter((n) =>
    (net === "all" || (net === "in") === n.tailnet.member) &&
    (!srcs.length || n.discovery_sources.some((s) => srcs.includes(sourceKey(s))))), [nodes.data, net, srcs]);
  const list = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter);
    return scoped.filter((n) => !f?.states || f.states.includes(n.state) || (f.id === "participating" && n.is_controller));
  }, [scoped, filter]);
  const counts = (states: string[] | null) => scoped.filter((n) => !states || states.includes(n.state) || (states.includes("active") && n.is_controller)).length;
  const sourceCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of nodes.data ?? []) for (const k of new Set(n.discovery_sources.map(sourceKey))) c[k] = (c[k] ?? 0) + 1;
    return c;
  }, [nodes.data]);
  const tailnetCount = (nodes.data ?? []).filter((n) => n.tailnet.member).length;
  const controllerTailnet = nodes.data?.find((n) => n.is_controller)?.tailnet;
  const node = nodes.data?.find((n) => n.id === selected) ?? null;

  const applyPreset = useMutation({
    mutationFn: (p: string) => api.post<{ nodes: number }>(`/api/allocations/apply-preset${qs({ preset: p })}`),
    onSuccess: (r, p) => { toast.success(`Applied ${presets.data?.[p]?.label ?? p} to ${r.nodes} nodes`); qc.invalidateQueries({ queryKey: ["nodes"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const current = nodes.data?.find((n) => n.is_controller)?.allocation?.preset;

  return (
    <>
      <PageHeader title="Nodes"
        description="Computers BioCompute knows about. Being discovered never grants permission to run work: an administrator authorizes a device, its owner installs the agent, and participation is switched on explicitly."
        actions={admin && <>
          <Button variant="secondary" onClick={() => setTokenOpen({ label: "", site: "home" })}><KeyRound />Enrollment tokens</Button>
          <Button variant="secondary" onClick={() => setManualOpen(true)}><Plus />Add manually</Button>
          <Button variant="primary" onClick={() => setScanOpen(true)}><Radar />Discover</Button>
        </>} />

      <Panel className="mb-5 p-4">
        <div className="flex flex-wrap items-start gap-6">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-[13.5px]">Cluster resource preset</p>
            <p className="text-xs text-muted mt-0.5">Presets rewrite every enrolled node's limits, idle rules, hours and power rules. Edit a node afterwards to customise it.</p>
          </div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Cluster preset">
            {Object.entries(presets.data ?? {}).map(([id, p]) => (
              <Tip key={id} content={p.description}>
                <button role="radio" aria-checked={current === id} disabled={!admin || applyPreset.isPending}
                  onClick={() => applyPreset.mutate(id)}
                  className={cn("rounded-md border px-3 py-1.5 text-[13px] disabled:opacity-60", current === id ? "border-accent bg-accent/10 text-accent" : "border-line hover:bg-raised")}>
                  {p.label}
                </button>
              </Tip>
            ))}
            <span className={cn("rounded-md border px-3 py-1.5 text-[13px]", current === "custom" ? "border-accent bg-accent/10 text-accent" : "border-line text-muted")}>Custom</span>
          </div>
        </div>
      </Panel>

      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted">Network</span>
          <div className="inline-flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="Tailnet filter">
            {[["all", "All networks"], ["in", `In my tailnet (${tailnetCount})`], ["out", "Outside tailnet"]].map(([id, label]) => (
              <button key={id} role="radio" aria-checked={net === id} onClick={() => setParam("net", id === "all" ? null : id)}
                className={cn("rounded px-2.5 py-1 text-[13px]", net === id ? "bg-raised text-text" : "text-muted hover:text-text")}>{label}</button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-[13px] text-muted">Found by</span>
          {Object.keys(SOURCES).filter((k) => sourceCounts[k]).map((k) => (
            <SourceTag key={k} source={k} count={sourceCounts[k]} active={srcs.length ? srcs.includes(k) : undefined}
              onClick={() => setParam("src", (srcs.includes(k) ? srcs.filter((x) => x !== k) : [...srcs, k]).join(",") || null)} />
          ))}
          {(srcs.length > 0 || net !== "all") && (
            <button className="ml-1 text-xs text-muted hover:text-text underline-offset-2 hover:underline"
              onClick={() => { const next = new URLSearchParams(sp); next.delete("src"); next.delete("net"); setSp(next, { replace: true }); }}>Clear filters</button>
          )}
        </div>
      </div>

      <Tabs value={filter} onValueChange={(v) => setParam("filter", v === "all" ? null : v)}>
        <TabsList className="mb-4">
          {FILTERS.map((f) => <TabsTrigger key={f.id} value={f.id}>{f.label} <span className="ml-1 text-xs text-muted tabular-nums">{counts(f.states)}</span></TabsTrigger>)}
        </TabsList>
      </Tabs>

      {nodes.isLoading && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-48" />)}</div>}
      {nodes.data && list.length === 0 && (
        <Panel><Empty icon={<Radar />} title={!nodes.data.length ? "No computers known yet" : "No computers match these filters"}
          action={admin && !nodes.data.length ? <Button variant="primary" onClick={() => setScanOpen(true)}>Discover computers</Button> : undefined}>
          {filter === "discovered" ? "Devices found by mDNS, Tailscale, HTCondor, the neighbour table or discovery agents appear here." : "Run discovery or add a machine manually."}
        </Empty></Panel>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list.map((n) => <NodeCard key={n.id} n={n} onOpen={() => setSelected(n.id)} />)}
      </div>
      {list.length > 0 && <div className="mt-4"><LatticeLegend /></div>}

      {node && <NodeSheet node={node} admin={admin} onClose={() => setSelected(null)}
        onEnroll={() => setTokenOpen({ label: node.display_name || node.hostname, site: node.site || (node.tailnet.member ? "home" : "lab") })} />}
      <ScanDialog open={scanOpen} onOpenChange={setScanOpen} />
      <ManualDialog open={manualOpen} onOpenChange={setManualOpen} />
      <TokenDialog open={!!tokenOpen} initial={tokenOpen || undefined} controllerTailnet={controllerTailnet} onOpenChange={(o) => !o && setTokenOpen(false)} />
    </>
  );
}

function NodeCard({ n, onOpen }: { n: ClusterNode; onOpen: () => void }) {
  const laptop = n.utilization?.power?.has_battery;
  const a = n.allocation;
  const participating = !["discovered", "candidate"].includes(n.state);
  return (
    <button onClick={onOpen} className={cn("text-left rounded-lg border bg-surface p-4 hover:border-muted/60 transition-colors", n.is_controller ? "border-accent/50" : "border-line")}>
      <div className="flex items-start gap-3">
        <div className={cn("grid size-9 place-items-center rounded-md", n.is_controller ? "bg-accent/15 text-accent" : "bg-raised text-muted")}>
          {laptop ? <Laptop className="size-5" /> : <Server className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold truncate">{n.display_name || n.hostname}</p>
            {n.is_controller && <Badge tone="accent">Controller</Badge>}
          </div>
          <p className="text-xs text-muted truncate">{[n.os && `${n.os} ${n.os_version ?? ""}`.trim(), n.arch, n.site && `site ${n.site}`].filter(Boolean).join(", ") || n.addresses.join(", ") || "No details yet"}</p>
        </div>
        <NodeStateBadge state={n.state} />
      </div>
      {n.cpu_logical ? (
        <div className="mt-4 flex items-end justify-between gap-4">
          <CoreLattice total={n.cpu_logical} allocated={a?.enabled ? a.max_cpus : 0} busyPercent={n.utilization?.cpu_percent} size="sm" />
          <div className="text-right text-xs text-muted tabular-nums shrink-0">
            <p><span className="text-text font-medium">{a?.enabled ? a.max_cpus : 0}</span>/{n.cpu_logical} cores</p>
            <p><span className="text-text font-medium">{a?.enabled ? `${a.max_memory_gb} GB` : "0 GB"}</span>/{gb(n.mem_total)}</p>
            {n.gpus.length > 0 && <p>{n.gpus.length} GPU</p>}
          </div>
        </div>
      ) : <p className="mt-4 text-xs text-muted">Hardware unknown until the BioCompute agent reports.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
        {participating && (n.eligibility.eligible
          ? <Badge tone="ok">Accepting work</Badge>
          : <Tip content={n.eligibility.reasons.join("; ")}><span><Badge tone="wait">Not eligible: {n.eligibility.reasons[0]}</Badge></span></Tip>)}
        <TailnetTag tailnet={n.tailnet} />
        {n.discovery_sources.map((s) => <SourceTag key={s} source={s} />)}
        {n.last_seen && !n.is_controller && <span className="text-muted ml-auto">seen {ago(n.last_seen)}</span>}
      </div>
    </button>
  );
}

function NodeSheet({ node: n, admin, onClose, onEnroll }: { node: ClusterNode; admin: boolean; onClose: () => void; onEnroll: () => void }) {
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ["nodes"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); };
  const transition = useMutation({
    mutationFn: (action: string) => api.post<ClusterNode>(`/api/nodes/${n.id}/transition`, { action }),
    onSuccess: (_, a) => { toast.success(`Node ${a === "remove" ? "removed" : a + "d"}`.replace("ed d", "ed")); refresh(); if (a === "remove") onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const condor = useQuery({ queryKey: ["condor", n.id, n.allocation], queryFn: () => api.get<string>(`/api/nodes/${n.id}/condor-config`), enabled: !!n.allocation });
  const metrics = useQuery({ queryKey: ["metrics", n.id], queryFn: () => api.get<{ cpu: number }[]>(`/api/nodes/${n.id}/metrics?minutes=60`) });
  const participating = !["discovered", "candidate"].includes(n.state);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={n.display_name || n.hostname} description={nodeStateHelp(n.state)} width="max-w-2xl">
      <Tabs defaultValue={participating ? "allocation" : "details"} className="px-5 pt-2">
        <TabsList>
          {participating && <TabsTrigger value="allocation">Resource allocation</TabsTrigger>}
          <TabsTrigger value="details">Hardware and software</TabsTrigger>
          {n.allocation && <TabsTrigger value="condor">HTCondor policy</TabsTrigger>}
        </TabsList>
        {participating && (
          <TabsContent value="allocation" className="py-4">
            {!n.eligibility.eligible && (
              <div className="mb-4 rounded-md border border-wait/30 bg-wait/10 px-3 py-2 text-[13px]">
                <p className="font-medium text-wait">Not accepting work right now</p>
                <ul className="mt-1 list-disc pl-5 text-muted">{n.eligibility.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              </div>
            )}
            <AllocationForm node={n} disabled={!admin} onSaved={refresh} />
          </TabsContent>
        )}
        <TabsContent value="details" className="py-4">
          {!participating && !n.is_controller && admin && n.tailnet.member && <SshEnroll node={n} />}
          {!participating && !n.is_controller && <EnrollSteps node={n} admin={admin} onEnroll={onEnroll} manualOnly={admin && n.tailnet.member} />}
          {n.cpu_logical && <div className="mb-4"><CoreLattice total={n.cpu_logical} allocated={n.allocation?.enabled ? n.allocation.max_cpus : 0} busyPercent={n.utilization.cpu_percent} size="md" /></div>}
          <dl>
            <KV k="Hostname" v={n.hostname} />
            <KV k="Operating system" v={[n.os, n.os_version].filter(Boolean).join(" ")} />
            <KV k="Architecture" v={n.arch} />
            <KV k="CPU" v={n.cpu_model ? `${n.cpu_model} (${n.cpu_physical ?? "?"} physical / ${n.cpu_logical ?? "?"} logical)` : n.cpu_logical ? `${n.cpu_logical} logical cores` : null} />
            <KV k="Memory" v={n.mem_total ? `${gb(n.mem_total)} total, ${gb(n.mem_available)} available` : null} />
            <KV k="GPUs" v={n.gpus.length ? n.gpus.map((g) => `${g.name ?? g.vendor}${g.memory_mb ? ` (${Math.round(g.memory_mb / 1024)} GB)` : ""}`).join(", ") : "None detected"} />
            <KV k="Disks" v={n.disks.length ? n.disks.map((d) => `${d.path}: ${bytes(d.free)} free of ${bytes(d.total)}`).join("; ") : null} />
            <KV k="Addresses" v={n.addresses.join(", ")} mono />
            <KV k="Discovered via" v={<span className="flex flex-wrap gap-1">{n.discovery_sources.map((s) => <SourceTag key={s} source={s} />)}</span>} />
            <KV k="Tailnet" v={n.tailnet.member
              ? `Member (from ${n.tailnet.via})${n.tailnet.online === true ? ", online" : n.tailnet.online === false ? ", offline" : ""}${n.tailnet.dns_name ? `, ${n.tailnet.dns_name}` : ""}${n.tailnet.ips.length ? `, ${n.tailnet.ips.join(", ")}` : ""}`
              : "Not seen in your tailnet"} />
            <KV k="Site" v={n.site} />
            <KV k="Agent" v={n.agent_installed ? `installed (${n.agent_version ?? "unknown version"})` : "not installed"} />
            <KV k="HTCondor" v={Object.keys(n.htcondor).length ? JSON.stringify(n.htcondor) : n.software.htcondor ? `installed ${n.software.htcondor}` : "not detected"} />
            <KV k="Software" v={Object.keys(n.software).length ? Object.entries(n.software).map(([k, v]) => `${k} ${v}`).join(", ") : "unknown"} />
            <KV k="Power" v={n.utilization.power?.has_battery ? `battery ${n.utilization.power.percent ?? "?"}%, ${n.utilization.power.on_ac ? "on AC" : "on battery"}` : "mains"} />
            <KV k="Load" v={n.utilization.load?.map((l) => l.toFixed(2)).join(" / ")} />
            <KV k="Samples (1 h)" v={metrics.data ? `${metrics.data.length} utilization samples` : null} />
            <KV k="Last seen" v={n.last_seen ? ago(n.last_seen) : "never"} />
          </dl>
          {n.notes && <p className="mt-3 whitespace-pre-wrap text-xs text-muted">{n.notes}</p>}
        </TabsContent>
        {n.allocation && (
          <TabsContent value="condor" className="py-4">
            <p className="text-[13px] text-muted mb-2">Install this on the worker as <code className="font-mono text-[12px]">/etc/condor/config.d/90-biocompute.conf</code> and run <code className="font-mono text-[12px]">condor_reconfig</code>. BioCompute never edits remote machines itself.</p>
            <pre className="max-h-96 overflow-auto rounded-md border border-line bg-ink p-3 font-mono text-[12px] leading-relaxed">{condor.data ?? "Loading…"}</pre>
            <Button size="sm" className="mt-2" onClick={() => { navigator.clipboard.writeText(condor.data ?? ""); toast.success("Copied"); }}><Copy />Copy</Button>
          </TabsContent>
        )}
      </Tabs>
      {admin && !n.is_controller && (
        <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-line bg-surface px-5 py-3">
          {n.state === "discovered" && <Button variant="primary" onClick={() => transition.mutate("authorize")}><ShieldCheck />Authorize for enrollment</Button>}
          {n.state === "candidate" && <Button variant="primary" onClick={onEnroll}><KeyRound />Create enrollment token</Button>}
          {participating && n.state !== "disabled" && (n.allocation?.draining
            ? <Button onClick={() => transition.mutate("undrain")}>Resume accepting work</Button>
            : <Button onClick={() => transition.mutate("drain")}>Drain for maintenance</Button>)}
          {participating && (n.state === "disabled" ? <Button onClick={() => transition.mutate("enable")}>Re-enable</Button> : <Button variant="danger" onClick={() => transition.mutate("disable")}>Disable</Button>)}
          {n.state !== "discovered" && <Button variant="ghost" onClick={() => transition.mutate("revoke")}>Revoke authorization</Button>}
          <Button variant="ghost" className="ml-auto text-bad" onClick={() => confirm(`Remove ${n.hostname} from BioCompute?`) && transition.mutate("remove")}><Trash2 />Remove</Button>
        </div>
      )}
    </Sheet>
  );
}

interface SshStep { id: string; title: string; state: "pending" | "running" | "done" | "failed" | "skipped"; output: string }
interface SshStatus { state: "running" | "done" | "warning" | "failed"; steps: SshStep[]; error: string | null; hint: string | null; host: string; user: string; port?: number; started_at: string }
interface SshInfo { available: boolean; reasons: string[]; targets: string[]; controller_url: string | null; site: string; ssh_bin: string; status: SshStatus | null }

const SSH_USER_KEY = "biocompute.sshUser";
const SSH_PORTS_KEY = "biocompute.sshPorts"; // { [nodeId]: port }

function loadPorts(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SSH_PORTS_KEY) ?? "{}"); } catch { return {}; }
}

function SshEnroll({ node: n }: { node: ClusterNode }) {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const info = useQuery({
    queryKey: ["ssh-enroll", n.id],
    queryFn: () => api.get<SshInfo>(`/api/nodes/${n.id}/ssh-enroll`),
    refetchInterval: running ? 1500 : false,
  });
  const st = info.data?.status ?? null;
  useEffect(() => {
    const isRunning = st?.state === "running";
    if (running && !isRunning && st) {
      if (st.state === "done") toast.success(`${n.hostname} enrolled. Participation is off until you enable it.`);
      else if (st.state === "warning") toast.warning(`${n.hostname} enrolled, but no heartbeat from the service yet`);
      else toast.error(`Enrollment of ${n.hostname} failed`);
      qc.invalidateQueries({ queryKey: ["nodes"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    }
    setRunning(isRunning);
  }, [st, running, n.hostname, qc]);

  const [f, setF] = useState({ ssh_user: "", host: "", ssh_port: "", controller_url: "", site: "", install_service: true, allow_discovery_reports: false });
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!info.data) return;
    let saved = "";
    try { saved = localStorage.getItem(SSH_USER_KEY) ?? ""; } catch { /* storage unavailable */ }
    const lastPort = info.data.status?.port ?? loadPorts()[n.id];
    setF((x) => ({ ...x, ssh_user: x.ssh_user || saved, host: x.host || info.data!.targets[0] || "",
      ssh_port: x.ssh_port || (lastPort ? String(lastPort) : "22"),
      controller_url: x.controller_url || info.data!.controller_url || "", site: x.site || info.data!.site }));
  }, [info.data]);
  const start = useMutation({
    mutationFn: () => api.post<SshStatus>(`/api/nodes/${n.id}/ssh-enroll`, { ...f, ssh_port: Number(f.ssh_port), site: f.site || null }),
    onSuccess: () => {
      try {
        localStorage.setItem(SSH_USER_KEY, f.ssh_user);
        localStorage.setItem(SSH_PORTS_KEY, JSON.stringify({ ...loadPorts(), [n.id]: Number(f.ssh_port) }));
      } catch { /* ignore */ }
      setConfirming(false); setRunning(true); qc.invalidateQueries({ queryKey: ["ssh-enroll", n.id] });
    },
    onError: (e) => { setConfirming(false); toast.error(errMsg(e)); },
  });
  if (!info.data || (!info.data.available && !st)) return null;
  const busy = st?.state === "running" || start.isPending;
  const portNum = Number(f.ssh_port);
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const valid = /^[A-Za-z_][A-Za-z0-9._-]*$/.test(f.ssh_user) && !!f.host && portOk && /^https?:\/\//.test(f.controller_url);

  return (
    <div className="mb-5 rounded-md border p-4" style={{ borderColor: "rgb(var(--src-tailscale) / 0.45)", backgroundColor: "rgb(var(--src-tailscale) / 0.06)" }}>
      <div className="flex items-start gap-2">
        <Terminal className="mt-0.5 size-4" style={{ color: "rgb(var(--src-tailscale))" }} />
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium">Enroll automatically over Tailscale SSH</p>
          <p className="text-xs text-muted mt-0.5">
            The controller connects to this machine through your tailnet, installs the agent in your home folder and enrolls it.
            It needs Tailscale SSH (always port 22 on the tailnet address) or your own sshd with the controller's key, on whatever
            port it listens on, and Python 3.9+ on the machine. Nothing needs root.
          </p>
        </div>
      </div>

      {!st || st.state !== "running" ? (
        info.data.available && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="SSH user on that machine" required>
              <Input value={f.ssh_user} onChange={(e) => setF({ ...f, ssh_user: e.target.value.trim() })} placeholder="hugo" autoComplete="off" />
            </Field>
            <div className="grid grid-cols-[1fr_96px] gap-3">
              <Field label="Connect to">
                <Select value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })}>
                  {info.data.targets.map((t) => <option key={t}>{t}</option>)}
                </Select>
              </Field>
              <Field label="SSH port" error={f.ssh_port && !portOk ? "1 to 65535" : null}>
                <Input type="number" min={1} max={65535} value={f.ssh_port} aria-invalid={!portOk}
                  onChange={(e) => setF({ ...f, ssh_port: e.target.value.replace(/\D/g, "") })} />
              </Field>
            </div>
            <Field label="Controller address, as seen from that machine" required className="sm:col-span-2"
              hint="Use the controller's tailnet name and the nginx/TLS port (8080 or 443). The API port 8000 only listens locally unless you bound it to the tailnet.">
              <Input value={f.controller_url} onChange={(e) => setF({ ...f, controller_url: e.target.value.trim() })} placeholder="http://lab-ws.tail1234.ts.net:8080" className="font-mono text-[12px]" />
            </Field>
            <Field label="Site"><Input value={f.site} onChange={(e) => setF({ ...f, site: e.target.value })} /></Field>
            <div className="space-y-2 self-end pb-1 text-[13px]">
              <label className="flex items-center gap-2"><Checkbox checked={f.install_service} onCheckedChange={(v) => setF({ ...f, install_service: !!v })} />Install as a background service</label>
              <label className="flex items-center gap-2"><Checkbox checked={f.allow_discovery_reports} onCheckedChange={(v) => setF({ ...f, allow_discovery_reports: !!v })} />Report devices on its network</label>
            </div>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={!valid || busy} onClick={() => setConfirming(true)}><Terminal />{st?.state === "failed" ? "Try again" : "Enroll automatically"}</Button>
              {st && st.state !== "running" && <span className="text-xs text-muted">Last attempt: {st.state} ({ago(st.started_at)})</span>}
            </div>
          </div>
        )
      ) : null}

      {st && <SshProgress st={st} />}

      <ControllerKey user={f.ssh_user} host={f.host} port={f.ssh_port || "22"}
        open={!!st?.hint && /SSH key/.test(st.hint)} />

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent title={`Enroll ${n.hostname} automatically?`} description="BioCompute will run exactly these steps on that machine, as the SSH user you entered.">
          <ol className="list-decimal space-y-1.5 pl-5 text-[13px]">
            <li>Connect with <code className="font-mono text-[12px]">{info.data.ssh_bin} -p {f.ssh_port} {f.ssh_user}@{f.host}</code> (no password prompts) and check for Python 3.9+.</li>
            <li>Check the machine can reach <code className="font-mono text-[12px]">{f.controller_url}</code>.</li>
            <li>Copy the agent to <code className="font-mono text-[12px]">~/.local/share/biocompute-agent</code>.</li>
            <li>Enroll with a one-time token sent over the encrypted connection (never on a command line).</li>
            {f.install_service && <li>Install a per-user background service (systemd user unit or launchd agent).</li>}
          </ol>
          <p className="mt-3 text-xs text-muted">No root access, no other software and no open ports. The node joins with participation switched off. This is recorded in the audit log.</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>Enroll {n.hostname}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface KeyInfo { exists: boolean; public_key: string | null; path: string; fingerprint: string | null }

function ControllerKey({ user, host, port, open }: { user: string; host: string; port: string; open: boolean }) {
  const qc = useQueryClient();
  const [show, setShow] = useState(open);
  useEffect(() => { if (open) setShow(true); }, [open]);
  const key = useQuery({ queryKey: ["ssh-key"], queryFn: () => api.get<KeyInfo>("/api/discovery/ssh-key"), enabled: show });
  const create = useMutation({
    mutationFn: () => api.post<KeyInfo>("/api/discovery/ssh-key"),
    onSuccess: (k) => { qc.setQueryData(["ssh-key"], k); toast.success("SSH key created"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const k = key.data;
  const who = `${user || "USER"}@${host || "MACHINE"}`;
  const onMachine = k?.public_key
    ? `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${k.public_key}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
    : "";
  const fromController = k?.public_key ? `ssh-copy-id -i ${k.path}.pub -p ${port} ${who}` : "";
  const copy = (t: string) => { navigator.clipboard.writeText(t); toast.success("Copied"); };

  return (
    <div className="mt-4 border-t border-line pt-3">
      <button type="button" className="flex items-center gap-2 text-[13px] font-medium hover:underline" onClick={() => setShow(!show)} aria-expanded={show}>
        <KeyRound className="size-4 text-muted" />Controller SSH key
        <span className="font-normal text-xs text-muted">for machines using their own sshd (e.g. Macs with Remote Login)</span>
      </button>
      {show && (
        <div className="mt-3 space-y-3 text-[13px]">
          {key.isLoading && <Skeleton className="h-10" />}
          {k && !k.exists && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-muted">BioCompute has no SSH key yet. It creates one for itself on the controller (no passphrase, readable only by the account running BioCompute).</p>
              <Button size="sm" variant="primary" loading={create.isPending} onClick={() => create.mutate()}><KeyRound />Create SSH key</Button>
            </div>
          )}
          {k?.exists && (
            <>
              <p className="text-muted">Authorize this key once on the machine, then click <span className="text-text">Try again</span>. Fingerprint <code className="font-mono text-[12px]">{k.fingerprint}</code>.</p>
              <div>
                <p className="mb-1 font-medium">Option 1: on the controller (asks for {user || "the user"}'s password on that machine once)</p>
                <CopyBlock text={fromController} onCopy={copy} />
              </div>
              <div>
                <p className="mb-1 font-medium">Option 2: on the machine itself, in a terminal as {user || "that user"}</p>
                <CopyBlock text={onMachine} onCopy={copy} />
              </div>
              <p className="text-xs text-muted">
                Option 1 must run as the account that runs BioCompute (for the systemd install: <code className="font-mono">sudo -u biocompute …</code>).
                On a Mac, Remote Login must be on: System Settings, General, Sharing.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CopyBlock({ text, onCopy }: { text: string; onCopy: (t: string) => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-ink/60 p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-[11.5px]">{text}</code>
      <button type="button" className="shrink-0 rounded p-1 text-muted hover:bg-raised hover:text-text" onClick={() => onCopy(text)} aria-label="Copy command"><Copy className="size-3.5" /></button>
    </div>
  );
}

function SshProgress({ st }: { st: SshStatus }) {
  const icon = (s: SshStep["state"]) => ({
    done: <CheckCircle2 className="size-4 text-ok" />, failed: <CircleAlert className="size-4 text-bad" />,
    running: <Loader2 className="size-4 animate-spin text-accent" />, skipped: <MinusCircle className="size-4 text-muted" />,
    pending: <CircleDashed className="size-4 text-muted" />,
  })[s];
  return (
    <div className="mt-4 rounded-md border border-line bg-surface p-3">
      <ul className="space-y-2">
        {st.steps.map((s) => (
          <li key={s.id} className="text-[13px]">
            <div className="flex items-center gap-2">{icon(s.state)}<span className={cn(s.state === "skipped" && "text-muted")}>{s.title}</span></div>
            {s.output && (s.state === "failed" || s.state === "done") && (
              <pre className="ml-6 mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-ink/60 px-2 py-1 font-mono text-[11.5px] text-muted">{s.output}</pre>
            )}
          </li>
        ))}
      </ul>
      {st.error && <p className="mt-3 text-[13px] text-bad">{st.error}</p>}
      {st.hint && <p className="mt-1 text-[13px] text-muted">{st.hint}</p>}
    </div>
  );
}

function EnrollSteps({ node: n, admin, onEnroll, manualOnly }: { node: ClusterNode; admin: boolean; onEnroll: () => void; manualOnly?: boolean }) {
  const qc = useQueryClient();
  const authorize = useMutation({
    mutationFn: () => api.post(`/api/nodes/${n.id}/transition`, { action: "authorize" }),
    onSuccess: () => { toast.success("Authorized for enrollment"); qc.invalidateQueries({ queryKey: ["nodes"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const step = n.state === "discovered" ? 1 : 2;
  const steps: [string, React.ReactNode][] = [
    ["Authorize this machine", step === 1
      ? (admin ? <Button size="sm" variant="primary" loading={authorize.isPending} onClick={() => authorize.mutate()}><ShieldCheck />Authorize for enrollment</Button>
               : "An administrator authorizes it.")
      : "Done."],
    ["Create a one-time enrollment token", step === 2 && admin ? <Button size="sm" variant="primary" onClick={onEnroll}><KeyRound />Create enrollment token</Button> : "Single use; it expires after the time you choose."],
    ["On that machine, enroll and install the agent", <>The token dialog shows the exact command (needs Python 3.9+), then <code className="font-mono text-[12px]">./install.sh</code> for systemd or launchd. Nothing is installed remotely.</>],
    ["Set its resource allocation and switch participation on", "The node then appears as Online with participation off until you enable it."],
  ];
  return (
    <div className="mb-5 rounded-md border border-accent/30 bg-accent/5 p-4">
      <p className="text-[13.5px] font-medium">{manualOnly ? "Or enroll manually" : "Enroll this machine"}</p>
      <ol className="mt-3 space-y-3">
        {steps.map(([title, body], i) => (
          <li key={title} className="flex gap-3">
            <span className={cn("grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold",
              i + 1 < step ? "border-ok/50 bg-ok/15 text-ok" : i + 1 === step ? "border-accent text-accent" : "border-line text-muted")}>{i + 1}</span>
            <div className="min-w-0 text-[13px]"><p className="font-medium">{title}</p><div className="mt-1 text-muted">{body}</div></div>
          </li>
        ))}
      </ol>
      {n.tailnet.member && !manualOnly && <p className="mt-3 text-xs text-muted">This machine is in your tailnet, so its agent can reach the controller through Tailscale even from another network.</p>}
    </div>
  );
}

function AllocationForm({ node, disabled, onSaved }: { node: ClusterNode; disabled: boolean; onSaved: () => void }) {
  const a = node.allocation;
  const [f, setF] = useState<Allocation | null>(a);
  useEffect(() => setF(node.allocation), [node.allocation]);
  const save = useMutation({
    mutationFn: (body: Partial<Allocation>) => api.put<ClusterNode>(`/api/allocations/${node.id}`, body),
    onSuccess: () => { toast.success("Allocation saved"); onSaved(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!f) return <Empty title="No allocation configured" action={!disabled && <Button onClick={() => api.post(`/api/nodes/${node.id}/transition`, { action: "enable" }).then(onSaved)}>Create from Balanced preset</Button>} />;
  const set = <K extends keyof Allocation>(k: K, v: Allocation[K]) => setF({ ...f, [k]: v });
  const memMax = Math.max(1, Math.floor((node.mem_total ?? 2 ** 30) / 2 ** 30));
  const dirty = JSON.stringify(f) !== JSON.stringify(a);
  return (
    <fieldset disabled={disabled} className="space-y-5">
      <div className="flex items-center justify-between rounded-md border border-line px-3 py-2.5">
        <div>
          <p className="font-medium text-[13.5px]">Participate in BioCompute</p>
          <p className="text-xs text-muted">Off means the scheduler never places work here.</p>
        </div>
        <Switch checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label="Participate" />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={`Maximum CPU cores: ${f.max_cpus} of ${node.cpu_logical ?? "?"}`}>
          <Slider min={1} max={node.cpu_logical ?? 64} step={1} value={[f.max_cpus]} onValueChange={([v]) => set("max_cpus", v)} aria-label="Maximum CPU cores" />
        </Field>
        <Field label={`Maximum memory: ${f.max_memory_gb} GB of ${memMax}`}>
          <Slider min={1} max={memMax} step={1} value={[f.max_memory_gb]} onValueChange={([v]) => set("max_memory_gb", v)} aria-label="Maximum memory" />
        </Field>
        <Field label="GPUs available to jobs" hint={`${node.gpus.length} detected`}>
          <Input type="number" min={0} max={node.gpus.length} value={f.gpus_allowed} onChange={(e) => set("gpus_allowed", +e.target.value)} />
        </Field>
        <Field label="Scratch storage limit (GB)">
          <Input type="number" min={0} value={f.scratch_limit_gb} onChange={(e) => set("scratch_limit_gb", +e.target.value)} />
        </Field>
        <Field label="Maximum concurrent jobs">
          <Input type="number" min={1} value={f.max_concurrent_jobs} onChange={(e) => set("max_concurrent_jobs", +e.target.value)} />
        </Field>
        <Field label={`Execution priority: ${f.priority}`} hint="Higher priority nodes are preferred when several are eligible.">
          <Slider min={0} max={100} value={[f.priority]} onValueChange={([v]) => set("priority", v)} aria-label="Priority" />
        </Field>
        <Field label="Allowed hours" hint="Local time, e.g. 19:00-07:00. Empty means any time.">
          <Input value={f.allowed_hours ?? ""} placeholder="any time" onChange={(e) => set("allowed_hours", e.target.value || null)} />
        </Field>
        <Field label="Data transfer policy" hint="Restricted lab data never leaves the controller's site regardless of this setting.">
          <Select value={f.data_policy} onChange={(e) => set("data_policy", e.target.value as Allocation["data_policy"])}>
            <option value="local-only">Local data only (no staging)</option>
            <option value="approved-staging">Approved intermediate files may be staged</option>
            <option value="any" disabled={!node.is_controller && node.site !== "lab"}>Any non-restricted data</option>
          </Select>
        </Field>
      </div>
      <div className="space-y-2.5">
        {[
          ["idle_only", "Only when idle", "Wait until nobody is using the keyboard and load is low; suspend jobs when the user returns."],
          ["require_ac_power", "Only on AC power", "Laptops stop accepting work on battery."],
          ["draining", "Draining", "Finish running work, accept nothing new (before maintenance)."],
        ].map(([k, label, help]) => (
          <label key={k} className="flex items-start gap-3 cursor-pointer">
            <Checkbox checked={!!f[k as keyof Allocation]} onCheckedChange={(v) => set(k as "idle_only", !!v)} className="mt-0.5" />
            <span><span className="text-[13.5px] font-medium">{label}</span><span className="block text-xs text-muted">{help}</span></span>
          </label>
        ))}
      </div>
      <Field label="Preferred workloads" hint="Comma-separated, e.g. alignment, R, proteomics. Used to rank nodes.">
        <Input value={f.preferred_workloads.join(", ")} onChange={(e) => set("preferred_workloads", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
      </Field>
      <p className="text-xs text-muted">
        Limits are scheduler requests: Nextflow's executor limits and HTCondor slot definitions keep BioCompute within them. Hard OS enforcement needs cgroups (Linux); on macOS the limits are advisory.
      </p>
      {!disabled && (
        <div className="flex gap-2">
          <Button variant="primary" disabled={!dirty} loading={save.isPending}
            onClick={() => save.mutate({ ...f, allowed_hours: f.allowed_hours ?? "" } as Partial<Allocation>)}>Save allocation</Button>
          {dirty && <Button variant="ghost" onClick={() => setF(a)}>Discard changes</Button>}
          <span className="ml-auto self-center text-xs text-muted">Preset: {a?.preset}</span>
        </div>
      )}
    </fieldset>
  );
}

function ScanDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["discovery-config"], queryFn: () => api.get<{ authorized_cidrs: string[]; mdns: boolean; tailscale: boolean; htcondor: boolean; neighbors: boolean; site: string }>("/api/discovery/config"), enabled: open });
  const [methods, setMethods] = useState(["controller", "tailscale", "htcondor", "mdns", "neighbors"]);
  const [result, setResult] = useState<Record<string, { available: boolean; detail?: string; found: number; errors?: string[] }> | null>(null);
  const scan = useMutation({
    mutationFn: () => api.post<Record<string, { available: boolean; detail?: string; found: number; errors?: string[] }>>(`/api/discovery/scan${qs({ methods: methods.join(",") })}`),
    onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ["nodes"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const M = [
    ["controller", "This controller", "Re-inventory the lab workstation itself."],
    ["tailscale", "Tailscale devices", "Reads `tailscale status` if the CLI is installed."],
    ["htcondor", "HTCondor pool", "Reads `condor_status` for existing workers."],
    ["mdns", "mDNS / Bonjour", "Listens for BioCompute agents, SSH and workstation announcements on this LAN."],
    ["neighbors", "Network neighbours", "Reads the ARP/NDP cache passively. Sends no packets."],
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setResult(null); }}>
      <DialogContent title="Discover computers" description="Discovery only records devices. Nothing is installed or executed on them.">
        <div className="space-y-2.5">
          {M.map(([id, label, help]) => {
            const enabled = id === "controller" || (cfg.data?.[id as "mdns"] ?? true);
            return (
              <label key={id} className={cn("flex items-start gap-3", !enabled && "opacity-50")}>
                <Checkbox className="mt-0.5" disabled={!enabled} checked={methods.includes(id) && enabled}
                  onCheckedChange={(v) => setMethods((m) => (v ? [...m, id] : m.filter((x) => x !== id)))} />
                <span>
                  <span className="text-[13.5px] font-medium">{label}</span>
                  {!enabled && <Badge className="ml-2">disabled in settings</Badge>}
                  {result?.[id] && <Badge tone={result[id].available ? "ok" : "neutral"} className="ml-2">{result[id].available ? `${result[id].found} found` : result[id].detail ?? "unavailable"}</Badge>}
                  <span className="block text-xs text-muted">{help}</span>
                  {result?.[id]?.errors?.length ? <span className="block text-xs text-wait">{result[id].detail}: {result[id].errors!.join("; ")}</span> : null}
                </span>
              </label>
            );
          })}
        </div>
        <p className="mt-4 text-xs text-muted">
          Active probing is limited to authorized networks: {cfg.data?.authorized_cidrs.length ? cfg.data.authorized_cidrs.join(", ") : "none configured"}.
          For the home network, enroll a discovery agent there; it reports devices to this controller.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="primary" loading={scan.isPending} onClick={() => scan.mutate()} disabled={!methods.length}><Radar />Run discovery</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManualDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ hostname: "", addresses: "", site: "", os: "", ssh_port: "", probe: false });
  const add = useMutation({
    mutationFn: () => api.post("/api/nodes/manual", {
      hostname: f.hostname, addresses: f.addresses.split(",").map((s) => s.trim()).filter(Boolean), site: f.site || null, os: f.os || null,
      ssh_port: f.ssh_port ? +f.ssh_port : null, probe: f.probe,
    }),
    onSuccess: () => { toast.success("Added as a discovered device"); qc.invalidateQueries({ queryKey: ["nodes"] }); onOpenChange(false); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a computer manually" description="Recorded as discovered. Authorize it and install the agent to enroll it.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Hostname" required className="sm:col-span-2"><Input value={f.hostname} onChange={(e) => setF({ ...f, hostname: e.target.value })} placeholder="home-server" /></Field>
          <Field label="IP addresses" hint="Comma-separated" className="sm:col-span-2"><Input value={f.addresses} onChange={(e) => setF({ ...f, addresses: e.target.value })} placeholder="100.64.0.12, 192.168.1.20" /></Field>
          <Field label="Site" hint="Data-locality domain, e.g. lab or home"><Input value={f.site} onChange={(e) => setF({ ...f, site: e.target.value })} /></Field>
          <Field label="Operating system"><Select value={f.os} onChange={(e) => setF({ ...f, os: e.target.value })}><option value="">Unknown</option><option>Linux</option><option>macOS</option></Select></Field>
          <Field label="SSH port" hint="Optional endpoint note"><Input type="number" value={f.ssh_port} onChange={(e) => setF({ ...f, ssh_port: e.target.value })} placeholder="22" /></Field>
          <label className="flex items-center gap-2 self-end pb-2 text-[13px]"><Checkbox checked={f.probe} onCheckedChange={(v) => setF({ ...f, probe: !!v })} />Test reachability (authorized networks only)</label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={add.isPending} disabled={!f.hostname} onClick={() => add.mutate()}>Add computer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TokenDialog({ open, onOpenChange, initial, controllerTailnet }: {
  open: boolean; onOpenChange: (o: boolean) => void; initial?: { label: string; site: string };
  controllerTailnet?: ClusterNode["tailnet"];
}) {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api.get<{ id: string; label: string; site: string | null; expires_at: string; used_by_node: string | null; allow_discovery_reports: boolean }[]>("/api/discovery/tokens"), enabled: open });
  const [f, setF] = useState({ label: "", site: "home", ttl_hours: 24, allow_discovery_reports: false });
  const [issued, setIssued] = useState<string | null>(null);
  useEffect(() => {
    if (open && initial) { setF((x) => ({ ...x, label: initial.label, site: initial.site })); setIssued(null); }
  }, [open, initial]);
  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>("/api/discovery/tokens", f),
    onSuccess: (r) => { setIssued(r.token); qc.invalidateQueries({ queryKey: ["tokens"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/api/discovery/tokens/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens"] }) });
  const local = /^(localhost|127\.|\[::1\])/.test(window.location.hostname);
  const tsHost = controllerTailnet?.member ? controllerTailnet.dns_name || controllerTailnet.ips[0] : null;
  const origin = local && tsHost ? `${window.location.protocol}//${tsHost}${window.location.port ? `:${window.location.port}` : ""}` : window.location.origin;
  const cmd = issued ? `python3 biocompute_agent.py enroll --controller ${origin} --token ${issued}${f.allow_discovery_reports ? " --discovery" : ""}` : "";
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setIssued(null); }}>
      <DialogContent wide title="Enrollment tokens" description="A token lets one machine's owner enroll it with the agent. Tokens are single-use and expire.">
        {issued ? (
          <div className="space-y-3">
            <p className="text-[13px]">Token created. It is shown only once. On the worker, from the <code className="font-mono text-[12px]">agent/</code> folder of this repository:</p>
            <pre className="whitespace-pre-wrap break-all rounded-md border border-line bg-ink p-3 font-mono text-[12px]">{cmd}</pre>
            <Button size="sm" onClick={() => { navigator.clipboard.writeText(cmd); toast.success("Copied"); }}><Copy />Copy command</Button>
            <p className="text-xs text-muted">
              The <code className="font-mono">--controller</code> address must be reachable from that machine{local ? " (this browser is using a local address)" : ""}.
              {tsHost ? <> Over Tailscale use <code className="font-mono">{tsHost}</code>.</> : " Use the controller's LAN name, tailnet name or public TLS address."}
              {" "}The API itself listens on 127.0.0.1, so point agents at the nginx/TLS front end (port 8080 or 443), not port 8000.
            </p>
            <p className="text-xs text-muted">Then install the background service with <code className="font-mono">install.sh</code> (systemd on Linux, launchd on macOS). See docs/worker-agent.md. The node joins with participation switched off.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Label"><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="iMac at home" /></Field>
            <Field label="Site"><Input value={f.site} onChange={(e) => setF({ ...f, site: e.target.value })} /></Field>
            <Field label="Valid for (hours)"><Input type="number" min={1} max={720} value={f.ttl_hours} onChange={(e) => setF({ ...f, ttl_hours: +e.target.value })} /></Field>
            <label className="flex items-start gap-2 self-end pb-1 text-[13px]"><Checkbox className="mt-0.5" checked={f.allow_discovery_reports} onCheckedChange={(v) => setF({ ...f, allow_discovery_reports: !!v })} />
              <span>Allow this agent to report other devices on its network<span className="block text-xs text-muted">Use for one agent per remote network segment.</span></span></label>
            <div className="sm:col-span-2"><Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}><KeyRound />Create token</Button></div>
          </div>
        )}
        <div className="mt-6">
          <p className="text-[13px] font-medium mb-2">Issued tokens</p>
          <div className="rounded-md border border-line divide-y divide-line/60 text-[13px]">
            {tokens.data?.length === 0 && <p className="p-3 text-muted">None yet.</p>}
            {tokens.data?.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-3 py-2">
                <span className="flex-1 truncate">{t.label || "Unlabelled"} <span className="text-muted">({t.site ?? "no site"})</span></span>
                {t.allow_discovery_reports && <Badge>discovery</Badge>}
                {t.used_by_node ? <Badge tone="ok">Used</Badge> : new Date(t.expires_at + (t.expires_at.endsWith("Z") ? "" : "Z")) < new Date() ? <Badge>Expired</Badge> : <Badge tone="accent">Unused</Badge>}
                {!t.used_by_node && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(t.id)}>Revoke</Button>}
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
