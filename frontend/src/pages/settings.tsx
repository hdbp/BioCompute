import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, CircleSlash, RefreshCw, UserPlus } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { User } from "@/lib/types";
import { AssistantSettings } from "@/components/assistant-settings";
import { DataRootsPanel } from "@/components/data-roots";
import { ReferencesSettingsPanel } from "@/components/references-settings";
import { UserOnboarding } from "@/components/user-onboarding";
import { cn, when } from "@/lib/utils";
import { KV, PageHeader } from "@/components/page";
import { Badge, Panel, PanelHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { PathInput } from "@/components/file-browser";
import { useTheme } from "@/hooks/theme";

interface SettingsData {
  site_name: string; environment: string; database: string; pipelines_dir: string; runs_dir: string; max_concurrent_runs: number;
  allow_custom_code_modules: boolean; enable_demo_engine: boolean;
  data_roots: { name: string; path: string; restricted: boolean; writable: boolean; description: string; exists: boolean; source?: "settings" | "ui" }[];
  software: Record<string, string | null | { available: boolean; version?: string; detail?: string; path?: string }>;
  discovery: { authorized_cidrs: string[]; mdns: boolean; tailscale: boolean; htcondor: boolean; neighbors: boolean };
  ui: { default_output_dir?: string | null };
}

export default function SettingsPage() {
  const user = useAuth((s) => s.user);
  const admin = can(user, "admin");
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsData>("/api/settings") });
  const refreshTools = useMutation({ mutationFn: () => api.post("/api/settings/refresh-tools"), onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast.success("Software re-detected"); } });
  const d = s.data;
  const { theme, toggle } = useTheme();
  const [params, setParams] = useSearchParams();
  return (
    <>
      <PageHeader title="Settings" description="Controller configuration comes from environment variables (see .env.example); this page shows the effective values." />
      <Tabs value={params.get("tab") ?? "system"} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList className="mb-5">
          <TabsTrigger value="system">Controller</TabsTrigger>
          <TabsTrigger value="execution">Execution environment</TabsTrigger>
          <TabsTrigger value="assistant">AI assistant</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
          {admin && <TabsTrigger value="users">Users</TabsTrigger>}
          {admin && <TabsTrigger value="audit">Audit log</TabsTrigger>}
        </TabsList>
        <TabsContent value="system">
          {d && (
            <div className="grid gap-5 lg:grid-cols-2">
              <DataRootsPanel roots={d.data_roots} admin={admin} />
              <ReferencesSettingsPanel admin={admin} />
              <Panel className="p-4">
                <dl>
                  <KV k="Site" v={d.site_name} />
                  <KV k="Environment" v={d.environment} />
                  <KV k="Database" v={d.database} />
                  <KV k="Pipeline store" v={d.pipelines_dir} mono />
                  <KV k="Run directories" v={d.runs_dir} mono />
                  <KV k="Concurrent runs" v={d.max_concurrent_runs} />
                  <KV k="Custom code modules" v={d.allow_custom_code_modules ? "allowed in Pipeline Studio" : "disabled"} />
                  <KV k="Native engine" v={d.enable_demo_engine ? "enabled" : "disabled"} />
                  <KV k="Discovery" v={["mdns", "tailscale", "htcondor", "neighbors"].filter((k) => d.discovery[k as "mdns"]).join(", ")} />
                  <KV k="Authorized networks" v={d.discovery.authorized_cidrs.join(", ") || "none (no active probing)"} />
                </dl>
              </Panel>
            </div>
          )}
        </TabsContent>
        <TabsContent value="execution">
          {d && (
            <Panel>
              <PanelHeader title="Software detected on the controller" description="What the execution service can see on its PATH. Nextflow runs natively on the host, not in a container."
                actions={admin && <Button size="sm" onClick={() => refreshTools.mutate()} loading={refreshTools.isPending}><RefreshCw />Re-detect</Button>} />
              <div className="grid sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(d.software).map(([k, v]) => {
                  const obj = typeof v === "object" && v !== null ? v : null;
                  const ok = obj ? obj.available : !!v;
                  return (
                    <div key={k} className="flex items-start gap-2.5 border-b border-line/60 px-4 py-3">
                      {ok ? <CheckCircle2 className="mt-0.5 size-4 text-ok" /> : <CircleSlash className="mt-0.5 size-4 text-muted" />}
                      <div className="min-w-0"><p className="font-medium text-[13.5px]">{k}</p>
                        <p className="text-xs text-muted break-all">{obj ? (obj.available ? `${obj.version} at ${obj.path}` : obj.detail) : (v as string | null) ?? "not found"}</p></div>
                    </div>
                  );
                })}
              </div>
              <p className="p-4 text-xs text-muted">Install Nextflow (Java 17+) for the user that runs the BioCompute service, then click Re-detect. See docs/deployment.md.</p>
            </Panel>
          )}
        </TabsContent>
        <TabsContent value="assistant"><AssistantSettings admin={admin} /></TabsContent>
        <TabsContent value="preferences">
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel className="p-4 space-y-4">
              <Field label="Theme"><Select value={theme} onChange={(e) => e.target.value !== theme && toggle()}><option value="dark">Darkfield (dark)</option><option value="light">Brightfield (light)</option></Select></Field>
              {admin && d && <DefaultOutput initial={d.ui.default_output_dir ?? ""} />}
            </Panel>
            <PasswordForm />
          </div>
        </TabsContent>
        {admin && <TabsContent value="users"><UserOnboarding /><Users /></TabsContent>}
        {admin && <TabsContent value="audit"><Audit /></TabsContent>}
      </Tabs>
    </>
  );
}

function DefaultOutput({ initial }: { initial: string }) {
  const qc = useQueryClient();
  const [v, setV] = useState(initial);
  const save = useMutation({ mutationFn: () => api.put("/api/settings/ui", { default_output_dir: v || null }), onSuccess: () => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["settings"] }); } });
  return (
    <Field label="Default output folder" hint="New launches put results in a timestamped folder under this location.">
      <div className="flex gap-2"><div className="flex-1"><PathInput mode="dir" value={v} onChange={setV} writableOnly /></div><Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button></div>
    </Field>
  );
}

function PasswordForm() {
  const [f, setF] = useState({ current_password: "", new_password: "" });
  const m = useMutation({ mutationFn: () => api.post("/api/auth/password", f), onSuccess: () => { toast.success("Password changed"); setF({ current_password: "", new_password: "" }); }, onError: (e) => toast.error(errMsg(e)) });
  return (
    <Panel className="p-4 space-y-4">
      <p className="font-semibold">Change password</p>
      <Field label="Current password"><Input type="password" value={f.current_password} onChange={(e) => setF({ ...f, current_password: e.target.value })} autoComplete="current-password" /></Field>
      <Field label="New password" hint="At least 10 characters"><Input type="password" value={f.new_password} onChange={(e) => setF({ ...f, new_password: e.target.value })} autoComplete="new-password" /></Field>
      <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={f.new_password.length < 10}>Change password</Button>
    </Panel>
  );
}

function Users() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/api/auth/users") });
  const [f, setF] = useState({ username: "", password: "", role: "scientist" });
  const create = useMutation({ mutationFn: () => api.post("/api/auth/users", f), onSuccess: () => { toast.success("User created"); setF({ username: "", password: "", role: "scientist" }); qc.invalidateQueries({ queryKey: ["users"] }); }, onError: (e) => toast.error(errMsg(e)) });
  const deact = useMutation({ mutationFn: (id: string) => api.del(`/api/auth/users/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }), onError: (e) => toast.error(errMsg(e)) });
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <Panel className="divide-y divide-line/60">
        {users.data?.map((u) => (
          <div key={u.id} className="flex items-center gap-3 px-4 py-2.5 text-[13.5px]">
            <span className={cn("flex-1", !u.is_active && "text-muted line-through")}>{u.username}</span>
            <Badge tone={u.role === "admin" ? "accent" : "neutral"}>{u.role}</Badge>
            {u.is_active && <Button size="sm" variant="ghost" onClick={() => confirm(`Deactivate ${u.username}?`) && deact.mutate(u.id)}>Deactivate</Button>}
          </div>
        ))}
      </Panel>
      <Panel className="p-4 space-y-3">
        <p className="font-semibold">Add user</p>
        <Field label="Username"><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label="Initial password" hint="At least 10 characters"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Role" hint="Viewers read only; scientists run analyses; admins manage nodes and users.">
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="viewer">Viewer</option><option value="scientist">Scientist</option><option value="admin">Admin</option></Select>
        </Field>
        <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!f.username || f.password.length < 10}><UserPlus />Add user</Button>
      </Panel>
    </div>
  );
}

function Audit() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api.get<{ id: number; ts: string; actor: string; action: string; target: string | null; detail: Record<string, unknown> }[]>("/api/auth/audit?limit=300") });
  return (
    <Panel className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-[13px]">
        <thead><tr className="border-b border-line text-left text-xs text-muted"><th className="px-4 py-2 font-medium">When</th><th className="font-medium">Who</th><th className="font-medium">Action</th><th className="font-medium">Target</th><th className="px-4 font-medium">Detail</th></tr></thead>
        <tbody>{q.data?.map((a) => (
          <tr key={a.id} className="border-b border-line/50">
            <td className="px-4 py-1.5 whitespace-nowrap text-muted">{when(a.ts)}</td><td>{a.actor}</td>
            <td className="font-mono text-[12px]">{a.action}</td><td className="truncate max-w-48">{a.target}</td>
            <td className="px-4 font-mono text-[11.5px] text-muted truncate max-w-80">{Object.keys(a.detail).length ? JSON.stringify(a.detail) : ""}</td>
          </tr>))}</tbody>
      </table>
    </Panel>
  );
}
