import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, Link2, Trash2, UserCheck, X } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge, Panel, PanelHeader, Switch } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { confirmDialog } from "@/components/ui/confirm";
import { Ago } from "@/components/page";

interface Req { id: string; username: string; requested_at: string | null; note: string }
interface Invite { id: string; role: string; note: string; created_by: string; created_at: string; expires_at: string; used_by: string | null; used_at: string | null; status: "open" | "used" | "expired" }

const ROLE_HELP: Record<string, string> = { viewer: "browse results", scientist: "build and run analyses", admin: "also manage users, data folders and computers" };

/** How new people get in: approve requests from the sign-in page, or send invite links. */
export function UserOnboarding() {
  const qc = useQueryClient();
  const reqs = useQuery({ queryKey: ["account-requests"], queryFn: () => api.get<Req[]>("/api/auth/requests") });
  const invites = useQuery({ queryKey: ["invites"], queryFn: () => api.get<Invite[]>("/api/auth/invites") });
  const settings = useQuery({ queryKey: ["account-settings"], queryFn: () => api.get<{ requests: boolean }>("/api/auth/account-settings") });
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [inv, setInv] = useState({ role: "scientist", days: 7, note: "" });
  const [link, setLink] = useState<string | null>(null);
  const refresh = () => { ["account-requests", "invites", "users", "dashboard"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };

  const approve = useMutation({
    mutationFn: (r: Req) => api.post(`/api/auth/requests/${r.id}/approve`, { role: roles[r.id] ?? "scientist" }),
    onSuccess: (_x, r) => { refresh(); toast.success(`${r.username} can now sign in`); }, onError: (e) => toast.error(errMsg(e)),
  });
  const decline = useMutation({
    mutationFn: (r: Req) => api.del(`/api/auth/requests/${r.id}`),
    onSuccess: (_x, r) => { refresh(); toast.success(`Declined ${r.username}`); }, onError: (e) => toast.error(errMsg(e)),
  });
  const toggle = useMutation({
    mutationFn: (v: boolean) => api.put("/api/auth/account-settings", { requests: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account-settings"] }), onError: (e) => toast.error(errMsg(e)),
  });
  const create = useMutation({
    mutationFn: () => api.post<Invite & { token: string; base_url: string | null }>("/api/auth/invites", inv),
    onSuccess: (r) => { setLink(`${r.base_url ?? window.location.origin}/invite/${r.token}`); refresh(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/api/auth/invites/${id}`), onSuccess: refresh, onError: (e) => toast.error(errMsg(e)) });
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast.success("Link copied"); } catch { toast.message("Select the link and copy it"); } };
  const pending = reqs.data ?? [];

  return (
    <div className="mb-5 grid gap-5 lg:grid-cols-2">
      <Panel>
        <PanelHeader title={<span className="flex items-center gap-2">Account requests{pending.length > 0 && <Badge tone="wait">{pending.length} waiting</Badge>}</span>}
          description="People can ask for an account on the sign-in page. They choose their own password; you choose what they can do." />
        <div className="divide-y divide-line/60">
          {pending.length === 0 && <p className="px-4 py-3 text-[13px] text-muted">No requests waiting.</p>}
          {pending.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{r.username}</p>
                <p className="truncate text-xs text-muted">{r.note || "No note"}{r.requested_at && <> · <Ago ts={r.requested_at} /></>}</p>
              </div>
              <Select aria-label={`Role for ${r.username}`} className="h-8 w-32" value={roles[r.id] ?? "scientist"} onChange={(e) => setRoles({ ...roles, [r.id]: e.target.value })}>
                <option value="viewer">Viewer</option><option value="scientist">Scientist</option><option value="admin">Admin</option>
              </Select>
              <Button size="sm" variant="primary" onClick={() => approve.mutate(r)} loading={approve.isPending && approve.variables?.id === r.id}><Check />Approve</Button>
              <Button size="sm" variant="ghost" onClick={async () => {
                if (await confirmDialog({
                  title: `Decline the request from ${r.username}?`,
                  body: "The request is deleted and the username becomes free again. The person is not notified; they can send a new request.",
                  confirmLabel: "Decline request", danger: true,
                })) decline.mutate(r);
              }} aria-label={`Decline ${r.username}`}><X />Decline</Button>
            </div>
          ))}
        </div>
        <label className="flex items-center gap-3 border-t border-line px-4 py-3 text-[13px]">
          <Switch checked={settings.data?.requests ?? true} onCheckedChange={(v) => toggle.mutate(v)} />
          <span>Show <b className="font-medium">Request an account</b> on the sign-in page<span className="block text-xs text-muted">Turn off to allow only accounts you create or invite.</span></span>
        </label>
      </Panel>

      <Panel>
        <PanelHeader title="Invite links" description="A single-use link: whoever opens it chooses a username and password and gets the role you pick, no approval step." />
        <div className="space-y-3 px-4 pb-3">
          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field label="Role" hint={ROLE_HELP[inv.role]}>
              <Select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>
                <option value="viewer">Viewer</option><option value="scientist">Scientist</option><option value="admin">Admin</option>
              </Select>
            </Field>
            <Field label="Valid for">
              <Select value={inv.days} onChange={(e) => setInv({ ...inv, days: Number(e.target.value) })}>
                {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} day{d > 1 ? "s" : ""}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="For (optional)"><Input value={inv.note} onChange={(e) => setInv({ ...inv, note: e.target.value })} placeholder="e.g. Ana, new postdoc" /></Field>
          <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending}><Link2 />Create invite link</Button>
          {link && (
            <div className="space-y-1.5 rounded-md border border-accent/40 bg-accent/5 p-2.5">
              <p className="text-xs text-muted">Send this link to the person (it is shown only now and works once):</p>
              {/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(link) && (
                <p className="text-xs text-wait">This link points to “localhost”, which only works on this computer. Replace that part with the address
                  others use to reach BioCompute (e.g. its Tailscale name), or set BIOCOMPUTE_PUBLIC_URL so links are made with it.</p>
              )}
              <div className="flex gap-2">
                <Input readOnly value={link} className="font-mono text-[12px]" onFocus={(e) => e.target.select()} aria-label="Invite link" />
                <Button size="sm" variant="secondary" onClick={() => copy(link)}><Copy />Copy</Button>
              </div>
            </div>
          )}
        </div>
        {(invites.data ?? []).length > 0 && (
          <ul className="divide-y divide-line/60 border-t border-line">
            {invites.data!.slice(0, 10).map((i) => (
              <li key={i.id} className="flex items-center gap-2 px-4 py-2 text-[12.5px]">
                <Badge tone={i.status === "open" ? "accent" : "neutral"}>{i.status}</Badge>
                <span className="min-w-0 flex-1 truncate">{i.role}{i.note ? ` · ${i.note}` : ""}
                  <span className={cn("ml-1 text-muted")}>{i.status === "used" ? `· joined as ${i.used_by}` : i.status === "open" ? `· until ${new Date(i.expires_at).toLocaleDateString()}` : ""}</span></span>
                {i.status === "open" && <Button size="icon" variant="ghost" aria-label="Revoke invite" title="Revoke: the link stops working"
                  onClick={async () => {
                    if (await confirmDialog({ title: "Revoke this invite link?", body: `The ${i.role} link${i.note ? ` for ${i.note}` : ""} stops working; whoever has it can no longer create an account with it.`, confirmLabel: "Revoke link", danger: true })) revoke.mutate(i.id);
                  }}><Trash2 /></Button>}
                {i.status === "used" && <UserCheck className="size-4 text-ok" />}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
