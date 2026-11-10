import { useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { User } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { CoreLattice } from "@/components/lattice";

export default function LoginPage() {
  const setSession = useAuth((s) => s.setSession);
  const [username, setU] = useState("admin");
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
    <div className="grid min-h-full place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <CoreLattice total={32} allocated={24} busyPercent={30} size="sm" className="mb-6" />
          <h1 className="text-2xl font-semibold">Sign in to BioCompute</h1>
          <p className="text-[13.5px] text-muted mt-1">Your lab's pipelines, experiments and compute nodes.</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Username"><Input value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" required /></Field>
          <Field label="Password" error={error}
            hint="First run: the initial admin password is in the controller's state directory (initial_admin_password.txt).">
            <Input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required autoFocus />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Sign in</Button>
        </form>
      </div>
    </div>
  );
}
