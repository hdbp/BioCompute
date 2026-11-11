import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { User } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { CoreLattice } from "@/components/lattice";

interface SetupStatus { needed: boolean; code_required?: boolean; local?: boolean; code_file?: string; existing_admin?: string | null; suggested_username?: string }
export const GETTING_STARTED_KEY = "biocompute.getting-started";

export default function LoginPage() {
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupStatus>("/api/auth/setup"), retry: 1 });
  const invite = window.location.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
  const [mode, setMode] = useState<"signin" | "request">("signin");
  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <CoreLattice total={32} allocated={24} busyPercent={30} size="sm" className="mb-6" />
        {setup.isLoading ? null
          : setup.data?.needed ? <SetupForm s={setup.data} onDone={() => setup.refetch()} />
          : invite ? <InviteForm token={invite} />
          : mode === "request" ? <RequestForm onBack={() => setMode("signin")} />
          : <SignIn onRequest={() => setMode("request")} />}
      </div>
    </div>
  );
}

const leaveInvitePath = () => { if (window.location.pathname.startsWith("/invite/")) window.history.replaceState(null, "", "/"); };

/** Someone who was sent an invite link chooses their username and password. */
function InviteForm({ token }: { token: string }) {
  const setSession = useAuth((st) => st.setSession);
  const check = useQuery({ queryKey: ["invite", token], queryFn: () => api.get<{ role: string; expires_at: string; invited_by: string }>(`/api/auth/invites/check?token=${encodeURIComponent(token)}`), retry: false });
  const [f, setF] = useState({ username: "", password: "", repeat: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = /^[A-Za-z0-9_.-]{2,80}$/.test(f.username) && f.password.length >= 10 && f.password === f.repeat;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ access_token: string; user: User }>("/api/auth/invites/accept", { token, username: f.username, password: f.password });
      leaveInvitePath();
      setSession(r.access_token, r.user);
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  };
  if (check.isLoading) return null;
  if (check.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Invite link</h1>
        <p className="text-[13.5px] text-bad">{errMsg(check.error)}</p>
        <Button variant="secondary" onClick={() => { leaveInvitePath(); window.location.reload(); }}>Go to sign in</Button>
      </div>
    );
  }
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Join BioCompute</h1>
        <p className="mt-1 text-[13.5px] text-muted">{check.data!.invited_by} invited you as a <b className="font-medium text-text">{check.data!.role}</b>. Choose your username and password.</p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username" hint="Letters, digits, '.', '_' or '-'."><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="username" required autoFocus /></Field>
        <Field label="Password" hint="At least 10 characters." error={f.password && f.password.length < 10 ? "At least 10 characters" : null}>
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" required />
        </Field>
        <Field label="Repeat password" error={f.repeat && f.repeat !== f.password ? "The passwords do not match" : null}>
          <Input type="password" value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value })} autoComplete="new-password" required />
        </Field>
        {error && <p className="text-[13px] text-bad" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!ok}>Create account and sign in</Button>
      </form>
    </>
  );
}

/** Ask for an account; an administrator approves it with a role. */
function RequestForm({ onBack }: { onBack: () => void }) {
  const [f, setF] = useState({ username: "", password: "", repeat: "", note: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const ok = /^[A-Za-z0-9_.-]{2,80}$/.test(f.username) && f.password.length >= 10 && f.password === f.repeat;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      await api.post("/api/auth/request-account", { username: f.username, password: f.password, note: f.note });
      setSent(true);
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  };
  if (sent) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Request sent</h1>
        <p className="text-[13.5px] text-muted">An administrator has to approve your account (and choose what you can do) before you can sign in as <b className="font-medium text-text">{f.username}</b> with the password you chose.</p>
        <Button variant="secondary" onClick={onBack}>Back to sign in</Button>
      </div>
    );
  }
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Request an account</h1>
        <p className="mt-1 text-[13.5px] text-muted">Choose a username and password. You can sign in once an administrator approves the request.</p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username" hint="Letters, digits, '.', '_' or '-'."><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="username" required autoFocus /></Field>
        <Field label="Password" hint="At least 10 characters." error={f.password && f.password.length < 10 ? "At least 10 characters" : null}>
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" required />
        </Field>
        <Field label="Repeat password" error={f.repeat && f.repeat !== f.password ? "The passwords do not match" : null}>
          <Input type="password" value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value })} autoComplete="new-password" required />
        </Field>
        <Field label="Who are you? (optional)" hint="Helps the administrator: your name, group or project.">
          <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Ana, postdoc, ChIP-seq project" />
        </Field>
        {error && <p className="text-[13px] text-bad" role="alert">{error}</p>}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onBack}>Back</Button>
          <Button type="submit" variant="primary" className="flex-1" loading={busy} disabled={!ok}>Send request</Button>
        </div>
      </form>
    </>
  );
}

function SignIn({ onRequest }: { onRequest: () => void }) {
  const setSession = useAuth((s) => s.setSession);
  const signup = useQuery({ queryKey: ["signup"], queryFn: () => api.get<{ requests: boolean }>("/api/auth/signup"), retry: 1 });
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ access_token: string; user: User }>("/api/auth/login", { username, password });
      setSession(r.access_token, r.user);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Sign in to BioCompute</h1>
        <p className="mt-1 text-[13.5px] text-muted">Your lab's pipelines, experiments and compute nodes.</p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username"><Input value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" required autoFocus /></Field>
        <Field label="Password" error={error}
          hint={<>Forgotten it? Ask an administrator, or on the controller run <code className="font-mono">python -m app.cli reset-password &lt;name&gt;</code> in <code className="font-mono">backend/</code>.</>}>
          <Input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Sign in</Button>
      </form>
      <div className="mt-6 border-t border-line pt-4 text-[13px] text-muted">
        {signup.data?.requests
          ? <p>New here? <button className="text-accent hover:underline" onClick={onRequest}>Request an account</button>, or open the invite link an administrator sent you.</p>
          : <p>New here? Ask an administrator for an account or an invite link.</p>}
      </div>
    </>
  );
}

function SetupForm({ s, onDone }: { s: SetupStatus; onDone: () => void }) {
  const setSession = useAuth((st) => st.setSession);
  const [username, setU] = useState(s.suggested_username ?? "admin");
  const [password, setP] = useState("");
  const [repeat, setR] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (s.suggested_username) setU(s.suggested_username); }, [s.suggested_username]);

  const pwError = password && password.length < 10 ? "At least 10 characters" : null;
  const repeatError = repeat && repeat !== password ? "The passwords do not match" : null;
  const ok = /^[A-Za-z0-9_.-]{2,40}$/.test(username) && password.length >= 10 && repeat === password && (!s.code_required || code.trim().length >= 8);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ access_token: string; user: User }>("/api/auth/setup", { username, password, code: code || null });
      try { localStorage.setItem(GETTING_STARTED_KEY, "show"); } catch { /* ignore */ }
      setSession(r.access_token, r.user);
    } catch (err) {
      setError(errMsg(err));
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Welcome to BioCompute</h1>
        <p className="mt-1 text-[13.5px] text-muted">
          {s.existing_admin
            ? `Create your administrator account. It replaces the “${s.existing_admin}” account, which still has its default password.`
            : "No account exists yet. Create the administrator account: you will manage data folders, computers and users with it."}
        </p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username" hint="Letters, digits, '.', '_' or '-'."><Input value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" required autoFocus /></Field>
        <Field label="Password" error={pwError} hint="At least 10 characters.">
          <Input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="Repeat password" error={repeatError}><Input type="password" value={repeat} onChange={(e) => setR(e.target.value)} autoComplete="new-password" required /></Field>
        {s.code_required && (
          <Field label="Setup code" hint={<>You are not on the controller itself, so BioCompute asks for the one-time code it printed in its terminal at start-up. It is also in <code className="break-all font-mono">{s.code_file}</code>.</>}>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" className="font-mono tracking-wider" autoComplete="one-time-code" required />
          </Field>
        )}
        {error && <p className="text-[13px] text-bad" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!ok}>Create account and sign in</Button>
        <p className="flex gap-2 text-[12px] text-muted">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          This screen only appears until the first administrator exists. Add colleagues later in Settings, Users.
        </p>
      </form>
    </>
  );
}
