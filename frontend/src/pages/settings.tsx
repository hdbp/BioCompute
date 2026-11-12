import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, CircleSlash, Copy, KeyRound, RefreshCw, UserPlus } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { User } from "@/lib/types";
import { AssistantSettings } from "@/components/assistant-settings";
import { DataRootsPanel } from "@/components/data-roots";
import { ReferencesSettingsPanel } from "@/components/references-settings";
import { UserOnboarding } from "@/components/user-onboarding";
import { cn, when } from "@/lib/utils";
import { KV, PageHeader, QueryError, usePageTitle } from "@/components/page";
import { Badge, Panel, PanelHeader, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { confirmDialog } from "@/components/ui/confirm";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { PathInput } from "@/components/file-browser";
import { useTheme } from "@/hooks/theme";

interface SettingsData {
  site_name: string; environment: string; database: string; pipelines_dir: string; runs_dir: string; max_concurrent_runs: number;
  allow_custom_code_modules: boolean; enable_demo_engine: boolean;
  data_roots: { name: string; path: string; restricted: boolean; writable: boolean; description: string; exists: boolean; source?: "settings" | "ui" }[];
  software: Record<string, string | null | { available: boolean; version?: string; detail?: string; path?: string }>;
  module_tools?: { tool: string; package: string; modules: string[]; path: string | null }[];
  discovery: { authorized_cidrs: string[]; mdns: boolean; tailscale: boolean; htcondor: boolean; neighbors: boolean };
  ui: { default_output_dir?: string | null };
}

export default function SettingsPage() {
  const user = useAuth((s) => s.user);
  const admin = can(user, "admin");
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsData>("/api/settings") });
  const refreshTools = useMutation({
    mutationFn: () => api.post("/api/settings/refresh-tools"),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); toast.success("Software re-detected"); },
    onError: (e) => toast.error(`Could not re-detect the software: ${errMsg(e)}`),
  });
  usePageTitle("Settings");
  const d = s.data;
  const { theme, toggle } = useTheme();
  const [params, setParams] = useSearchParams();
  return (
    <>
      <PageHeader title="Settings"
        description={admin
          ? "Data folders, reference genomes, the AI assistant, users and your own preferences are managed here and apply at once. The controller's paths and limits listed under Controller are fixed when the server starts (its environment file, see .env.example)."
          : "Your own preferences, and what this BioCompute controller is set up with. Data folders, reference genomes, the AI assistant and users are managed by an administrator."} />
      {s.isLoading && <div className="mb-5 space-y-3"><Skeleton className="h-9 w-96 max-w-full" /><Skeleton className="h-48" /></div>}
      {s.isError && !d && <QueryError error={s.error} onRetry={() => s.refetch()} what="the settings" className="mb-5" />}
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
              <Panel>
                <PanelHeader title="Controller" description="Read-only: set in the controller's environment file when the server starts." />
                <dl className="px-4 pb-3">
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
              <p className="p-4 text-xs text-muted">Missing something? On the controller, run <code className="font-mono">scripts/tools.sh</code> in the BioCompute folder: it offers to install Nextflow (with Java), refgenie and the module tools this computer does not have yet. Then click Re-detect.</p>
            </Panel>
          )}
          {d?.module_tools && (
            <Panel className="mt-5">
              <PanelHeader title="Tools of the built-in pipeline modules"
                description={d.module_tools.every((t) => t.path) ? "All present: every built-in module can run on this controller."
                  : `${d.module_tools.filter((t) => !t.path).length} missing: the modules that need them cannot run on this controller until they are installed.`} />
              <div className="grid sm:grid-cols-2 lg:grid-cols-3">
                {d.module_tools.map((t) => (
                  <div key={t.tool} className="flex items-start gap-2.5 border-b border-line/60 px-4 py-3">
                    {t.path ? <CheckCircle2 className="mt-0.5 size-4 text-ok" /> : <CircleSlash className="mt-0.5 size-4 text-wait" />}
                    <div className="min-w-0"><p className="font-medium text-[13.5px]">{t.tool}</p>
                      <p className="text-xs text-muted break-all">{t.path ?? `not found (${t.package.replace(/^.*::/, "")})`}</p>
                      <p className="text-[11px] text-muted">used by {t.modules.join(", ")}</p></div>
                  </div>
                ))}
              </div>
              {d.module_tools.some((t) => !t.path) && (
                <p className="p-4 text-xs text-muted">To install only the missing ones: <code className="font-mono">scripts/tools.sh</code> on the controller (a private bioconda environment; your own programs are not touched and keep priority), then Re-detect.</p>
              )}
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
  const save = useMutation({
    mutationFn: () => api.put("/api/settings/ui", { default_output_dir: v || null }),
    onSuccess: () => { toast.success(v ? "Default output folder saved" : "Default output folder cleared"); qc.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (e) => toast.error(`Could not save the default output folder: ${errMsg(e)}`),
  });
  return (
    <Field label="Default output folder" hint="New launches put results in a timestamped folder under this location.">
      <div className="flex gap-2"><div className="flex-1"><PathInput mode="dir" value={v} onChange={setV} writableOnly /></div><Button onClick={() => save.mutate()} loading={save.isPending} disabled={v === initial}>Save</Button></div>
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

const ROLES: { value: User["role"]; label: string; help: string }[] = [
  { value: "viewer", label: "Viewer", help: "reads results, cannot start runs" },
  { value: "scientist", label: "Scientist", help: "builds and runs analyses" },
  { value: "admin", label: "Admin", help: "also manages users, data folders and nodes" },
];
const roleLabel = (r: string) => ROLES.find((x) => x.value === r)?.label ?? r;

function Users() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/api/auth/users") });
  const [f, setF] = useState({ username: "", password: "", role: "scientist" });
  const [resetFor, setResetFor] = useState<User | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });
  const create = useMutation({ mutationFn: () => api.post("/api/auth/users", f), onSuccess: () => { toast.success(`User ${f.username} created`); setF({ username: "", password: "", role: "scientist" }); refresh(); }, onError: (e) => toast.error(errMsg(e)) });
  const update = useMutation({
    mutationFn: ({ u, ...patch }: { u: User; role?: User["role"]; is_active?: boolean }) => api.patch<User>(`/api/auth/users/${u.id}`, patch),
    onSuccess: (r, v) => {
      toast.success(v.role ? `${r.username} is now ${r.role === "admin" ? "an" : "a"} ${roleLabel(r.role).toLowerCase()}` : r.is_active ? `${r.username} can sign in again` : `${r.username} deactivated`);
      refresh();
    },
    onError: (e) => { toast.error(errMsg(e)); refresh(); },
  });
  const activeAdmins = (users.data ?? []).filter((u) => u.role === "admin" && u.is_active).length;

  async function changeRole(u: User, role: User["role"]) {
    if (role === u.role) return;
    const gains = role === "admin", loses = u.role === "admin";
    if ((gains || loses) && !(await confirmDialog({
      title: gains ? `Make ${u.username} an administrator?` : `Remove administrator rights from ${u.username}?`,
      body: gains
        ? "Administrators manage users, data folders, the AI assistant and the nodes of the cluster, and see the audit log."
        : `${u.username} becomes a ${roleLabel(role).toLowerCase()} (${ROLES.find((x) => x.value === role)?.help}) and can no longer manage users, data folders or nodes. This applies at once.`,
      confirmLabel: gains ? "Make administrator" : "Remove administrator rights", danger: loses,
    }))) return;
    update.mutate({ u, role });
  }
  async function deactivate(u: User) {
    if (await confirmDialog({
      title: `Deactivate ${u.username}?`,
      body: `${u.username} is signed out and can no longer sign in. Their experiments, pipelines and runs are kept, and you can reactivate the account at any time.`,
      confirmLabel: "Deactivate", danger: true,
    })) update.mutate({ u, is_active: false });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <Panel>
        <PanelHeader title="Users" description="Change what a person may do, give them a temporary password, or switch their sign-in off and on again." />
        {users.isLoading && <div className="space-y-2 p-4"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>}
        {users.isError && <QueryError error={users.error} onRetry={() => users.refetch()} what="the users" className="m-4" />}
        <ul className="divide-y divide-line/60">
          {users.data?.map((u) => {
            const self = u.id === me?.id || u.username === me?.username;
            const lastAdmin = u.role === "admin" && u.is_active && activeAdmins <= 1;
            const busy = update.isPending && update.variables?.u.id === u.id;
            return (
              <li key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13.5px]">
                <span className="min-w-[8rem] flex-1 truncate">
                  <span className={cn("font-medium", !u.is_active && "text-muted")}>{u.username}</span>
                  {self && <span className="ml-1.5 text-xs text-muted">(you)</span>}
                </span>
                {!u.is_active && <Badge tone="wait"><CircleSlash className="size-3" aria-hidden />Deactivated</Badge>}
                <Select aria-label={`Role of ${u.username}`} className="h-8 w-32" value={u.role} disabled={self || !u.is_active || busy}
                  title={self ? "You cannot change your own role; ask another administrator" : !u.is_active ? "Reactivate the account to change its role" : lastAdmin ? "The last active administrator cannot be demoted" : undefined}
                  onChange={(e) => changeRole(u, e.target.value as User["role"])}>
                  {ROLES.map((r) => <option key={r.value} value={r.value} disabled={lastAdmin && r.value !== "admin"}>{r.label}</option>)}
                </Select>
                <div className="flex w-56 justify-end gap-1">
                  {!self && u.is_active && <Button size="sm" variant="ghost" onClick={() => setResetFor(u)}><KeyRound />Reset password</Button>}
                  {!self && (u.is_active
                    ? <Button size="sm" variant="ghost" disabled={lastAdmin || busy} title={lastAdmin ? "The last active administrator cannot be deactivated" : undefined} onClick={() => deactivate(u)}>Deactivate</Button>
                    : <Button size="sm" variant="secondary" loading={busy} onClick={() => update.mutate({ u, is_active: true })}>Reactivate</Button>)}
                  {self && <span className="self-center text-xs text-muted">Change your password under Preferences</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>
      <Panel className="p-4 space-y-3 self-start">
        <p className="font-semibold">Add user</p>
        <Field label="Username"><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" /></Field>
        <Field label="Initial password" hint="At least 10 characters"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        <Field label="Role" hint="Viewers read only; scientists run analyses; admins manage nodes and users.">
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select>
        </Field>
        <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!f.username || f.password.length < 10}><UserPlus />Add user</Button>
      </Panel>
      {resetFor && <ResetPasswordDialog user={resetFor} onClose={() => setResetFor(null)} />}
    </div>
  );
}

/** An administrator gives someone a temporary password: generated (shown once) or typed. */
function ResetPasswordDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const [mode, setMode] = useState<"generate" | "type">("generate");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState<{ generated: boolean; password: string | null } | null>(null);
  const reset = useMutation({
    mutationFn: () => api.post<{ generated: boolean; password: string | null }>(`/api/auth/users/${user.id}/reset-password`, mode === "type" ? { password } : {}),
    onSuccess: (r) => { setDone(r); setPassword(""); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast.success("Password copied"); } catch { toast.message("Select the password and copy it"); } };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Reset the password of ${user.username}`}
        description={done ? undefined : `The current password of ${user.username} stops working at once.`}>
        {done ? (
          <div className="space-y-3 text-[13.5px]">
            <p className="flex items-center gap-2 font-medium text-ok"><CheckCircle2 className="size-4" />The password of {user.username} was reset</p>
            {done.password ? (
              <>
                <p>Give this temporary password to {user.username}. It is shown only now; BioCompute keeps no readable copy.</p>
                <div className="flex gap-2">
                  <Input readOnly value={done.password} className="font-mono" onFocus={(e) => e.target.select()} aria-label="Temporary password" />
                  <Button variant="secondary" onClick={() => copy(done.password!)}><Copy />Copy</Button>
                </div>
              </>
            ) : <p>Give {user.username} the password you typed.</p>}
            <p className="text-muted">Ask them to choose their own afterwards under Settings, Preferences, Change password.</p>
            <DialogFooter><Button variant="primary" onClick={onClose}>Done</Button></DialogFooter>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (mode === "generate" || password.length >= 10) reset.mutate(); }}>
            <div role="radiogroup" aria-label="New password" className="space-y-2 text-[13.5px]">
              <label className="flex items-start gap-2.5">
                <input type="radio" name="reset-mode" className="mt-1 accent-[rgb(var(--accent))]" checked={mode === "generate"} onChange={() => setMode("generate")} />
                <span>Generate a temporary password<span className="block text-xs text-muted">Shown once on the next screen, for you to pass on.</span></span>
              </label>
              <label className="flex items-start gap-2.5">
                <input type="radio" name="reset-mode" className="mt-1 accent-[rgb(var(--accent))]" checked={mode === "type"} onChange={() => setMode("type")} />
                <span>Set a temporary password myself</span>
              </label>
            </div>
            {mode === "type" && (
              <Field label="Temporary password" hint="At least 10 characters">
                <Input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </Field>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" loading={reset.isPending} disabled={mode === "type" && password.length < 10}><KeyRound />Reset password</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Audit() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api.get<{ id: number; ts: string; actor: string; action: string; target: string | null; detail: Record<string, unknown> }[]>("/api/auth/audit?limit=300") });
  if (q.isError) return <QueryError error={q.error} onRetry={() => q.refetch()} what="the audit log" />;
  if (q.isLoading) return <Skeleton className="h-64" />;
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
