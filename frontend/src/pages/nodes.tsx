import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, KeyRound, Laptop, Plus, Radar, Server, ShieldCheck, Trash2 } from "lucide-react";
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
  const [tokenOpen, setTokenOpen] = useState(false);

  const list = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter);
    return (nodes.data ?? []).filter((n) => !f?.states || f.states.includes(n.state) || (f.id === "participating" && n.is_controller));
  }, [nodes.data, filter]);
  const counts = (states: string[] | null) => (nodes.data ?? []).filter((n) => !states || states.includes(n.state) || (states.includes("active") && n.is_controller)).length;
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
          <Button variant="secondary" onClick={() => setTokenOpen(true)}><KeyRound />Enrollment tokens</Button>
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

      <Tabs value={filter} onValueChange={(v) => setSp(v === "all" ? {} : { filter: v })}>
        <TabsList className="mb-4">
          {FILTERS.map((f) => <TabsTrigger key={f.id} value={f.id}>{f.label} <span className="ml-1 text-xs text-muted tabular-nums">{counts(f.states)}</span></TabsTrigger>)}
        </TabsList>
      </Tabs>

      {nodes.isLoading && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-48" />)}</div>}
      {nodes.data && list.length === 0 && (
        <Panel><Empty icon={<Radar />} title={filter === "all" ? "No computers known yet" : "Nothing in this category"}
          action={admin && filter === "all" ? <Button variant="primary" onClick={() => setScanOpen(true)}>Discover computers</Button> : undefined}>
          {filter === "discovered" ? "Devices found by mDNS, Tailscale, HTCondor, the neighbour table or discovery agents appear here." : "Run discovery or add a machine manually."}
        </Empty></Panel>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list.map((n) => <NodeCard key={n.id} n={n} onOpen={() => setSelected(n.id)} />)}
      </div>
      {list.length > 0 && <div className="mt-4"><LatticeLegend /></div>}

      {node && <NodeSheet node={node} admin={admin} onClose={() => setSelected(null)} />}
      <ScanDialog open={scanOpen} onOpenChange={setScanOpen} />
      <ManualDialog open={manualOpen} onOpenChange={setManualOpen} />
      <TokenDialog open={tokenOpen} onOpenChange={setTokenOpen} />
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
        {n.discovery_sources.slice(0, 3).map((s) => <Badge key={s}>{s}</Badge>)}
        {n.last_seen && !n.is_controller && <span className="text-muted ml-auto">seen {ago(n.last_seen)}</span>}
      </div>
    </button>
  );
}

function NodeSheet({ node: n, admin, onClose }: { node: ClusterNode; admin: boolean; onClose: () => void }) {
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
            <KV k="Discovered via" v={n.discovery_sources.join(", ")} />
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
          {n.state === "candidate" && <p className="text-[13px] text-muted flex-1">Authorized. Create an enrollment token and have the machine's owner install the agent.</p>}
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

function TokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api.get<{ id: string; label: string; site: string | null; expires_at: string; used_by_node: string | null; allow_discovery_reports: boolean }[]>("/api/discovery/tokens"), enabled: open });
  const [f, setF] = useState({ label: "", site: "home", ttl_hours: 24, allow_discovery_reports: false });
  const [issued, setIssued] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>("/api/discovery/tokens", f),
    onSuccess: (r) => { setIssued(r.token); qc.invalidateQueries({ queryKey: ["tokens"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/api/discovery/tokens/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens"] }) });
  const origin = window.location.origin;
  const cmd = issued ? `python3 biocompute_agent.py enroll --controller ${origin} --token ${issued}${f.allow_discovery_reports ? " --discovery" : ""}` : "";
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setIssued(null); }}>
      <DialogContent wide title="Enrollment tokens" description="A token lets one machine's owner enroll it with the agent. Tokens are single-use and expire.">
        {issued ? (
          <div className="space-y-3">
            <p className="text-[13px]">Token created. It is shown only once. On the worker, from the <code className="font-mono text-[12px]">agent/</code> folder of this repository:</p>
            <pre className="whitespace-pre-wrap break-all rounded-md border border-line bg-ink p-3 font-mono text-[12px]">{cmd}</pre>
            <Button size="sm" onClick={() => { navigator.clipboard.writeText(cmd); toast.success("Copied"); }}><Copy />Copy command</Button>
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
