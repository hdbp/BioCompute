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
  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <CoreLattice total={32} allocated={24} busyPercent={30} size="sm" className="mb-6" />
        {setup.isLoading ? null : setup.data?.needed ? <SetupForm s={setup.data} onDone={() => setup.refetch()} /> : <SignIn />}
      </div>
    </div>
  );
}

function SignIn() {
  const setSession = useAuth((s) => s.setSession);
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
          hint={<>Forgotten it? On the controller run <code className="font-mono">python -m app.cli reset-password &lt;name&gt;</code> in <code className="font-mono">backend/</code> (demo: <code className="font-mono">scripts/dev.sh admin reset-password</code>). No account? Ask your BioCompute administrator, or create one on the controller with <code className="font-mono">python -m app.cli reset-password &lt;name&gt; --create</code>.</>}>
          <Input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Sign in</Button>
      </form>
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
