import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Search } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import type { StudioModule } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";

interface Preview {
  ok: boolean; step: string; notes?: string[]; warnings?: string[]; diff?: string; changed_files?: string[];
  consumers?: string[]; input?: string | null; message?: string; version?: string; version_id?: string;
}
export interface StructNode { id: string; kind: string; label: string; outputs?: string[]; output_shapes?: Record<string, string> }

export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md border border-line bg-ink/60 p-2 font-mono text-[11.5px] leading-[1.5]">
      {diff.split("\n").map((l, i) => (
        <div key={i} className={cn(l.startsWith("+") && !l.startsWith("+++") ? "text-ok" : l.startsWith("-") && !l.startsWith("---") ? "text-bad" : l.startsWith("@@") ? "text-accent" : "text-muted")}>{l || " "}</div>
      ))}
    </pre>
  );
}

function PreviewBlock({ p }: { p: Preview }) {
  return (
    <div className="space-y-2 text-[12.5px]">
      {p.notes?.map((n) => <p key={n}>{n}</p>)}
      {p.warnings?.map((w) => <p key={w} className="flex gap-1.5 text-wait"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{w}</p>)}
      {p.diff && <details open><summary className="cursor-pointer text-muted">Code changes ({p.changed_files?.length ?? 0} file{p.changed_files?.length === 1 ? "" : "s"})</summary><div className="mt-1.5"><DiffView diff={p.diff} /></div></details>}
    </div>
  );
}

const post = (pid: string, body: Record<string, unknown>) => api.post<Preview>(`/api/pipelines/${pid}/structure`, body);

/** Add a library module as a new step after an existing one. */
export function AddStepDialog({ open, onOpenChange, pid, baseVersionId, nextLabel, nodes, defaultAfter, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; pid: string; baseVersionId: string; nextLabel: string;
  nodes: StructNode[]; defaultAfter?: string | null; onDone: (r: Preview) => void;
}) {
  const mods = useQuery({ queryKey: ["studio-modules"], queryFn: () => api.get<{ modules: StudioModule[] }>("/api/studio/modules"), staleTime: 300_000, enabled: open });
  const steps = nodes.filter((n) => n.kind === "process" || n.kind === "subworkflow");
  const [q, setQ] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [after, setAfter] = useState("");
  const [output, setOutput] = useState("");
  const [name, setName] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setQ(""); setModuleId(""); setName(""); setExtra({}); setPreview(null);
    setAfter(defaultAfter && steps.some((s) => s.id === defaultAfter) ? defaultAfter : steps.at(-1)?.id ?? "");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const node = steps.find((s) => s.id === after);
  const outs = (node?.outputs ?? []).filter((o) => o !== "versions");
  useEffect(() => { setOutput(outs[0] ?? ""); setPreview(null); }, [after]); // eslint-disable-line react-hooks/exhaustive-deps
  const library = useMemo(() => (mods.data?.modules ?? []).filter((m) => m.kind === "module"), [mods.data]);
  const ql = q.trim().toLowerCase();
  const shown = library.filter((m) => !ql || `${m.name} ${m.id} ${m.category} ${m.description}`.toLowerCase().includes(ql));
  const mod = library.find((m) => m.id === moduleId);
  const body = { base_version_id: baseVersionId, op: "add", module_id: moduleId, after, output, step: name.trim() || null, extra_params: extra };
  const run = async (dry: boolean) => {
    setBusy(true);
    try {
      const r = await post(pid, { ...body, dry_run: dry });
      if (dry) setPreview(r); else { onDone(r); onOpenChange(false); }
    } catch (e) { toast.error(errMsg(e)); setPreview(null); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a step" wide
        description="A module from BioCompute's library runs right after a step of this pipeline, on one of its outputs. BioCompute writes the Nextflow code; you see it before anything is saved.">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <span className="text-[12.5px] font-medium">Module</span>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
              <Input className="h-8 pl-8 text-[13px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a module (MACS3, deepTools, …)" aria-label="Find a module" />
            </label>
            <div className="max-h-64 overflow-y-auto rounded-md border border-line" role="listbox" aria-label="Modules">
              {mods.isLoading && <p className="p-3 text-[12.5px] text-muted">Loading…</p>}
              {mods.isError && <p className="p-3 text-[12.5px] text-bad">Could not load the modules: {errMsg(mods.error)} <button className="underline" onClick={() => mods.refetch()}>Try again</button></p>}
              {mods.data && shown.length === 0 && <p className="p-3 text-[12.5px] text-muted">No module matches.</p>}
              {shown.map((m) => (
                <button key={m.id} role="option" aria-selected={moduleId === m.id} onClick={() => { setModuleId(m.id); setPreview(null); }}
                  className={cn("block w-full px-3 py-1.5 text-left hover:bg-raised", moduleId === m.id && "bg-accent/10")}>
                  <span className="block text-[13px]">{m.name}</span>
                  <span className="block truncate text-[11px] text-muted">{m.category} · {m.scope === "aggregate" ? "all samples together" : "per sample"} · in: {m.inputs.map((i) => i.type).join(", ")}</span>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted">Your own modules (Studio → Add software as a module) are listed too.</p>
          </div>
          <div className="space-y-3">
            <Field label="Runs after">
              <Select value={after} onChange={(e) => setAfter(e.target.value)}>{steps.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
            </Field>
            <Field label={`Reads this output of ${after || "the step"}`}>
              <Select value={output} onChange={(e) => { setOutput(e.target.value); setPreview(null); }}>
                {outs.map((o) => <option key={o} value={o}>{o}{node?.output_shapes?.[o] === "tuple" ? " (per sample)" : node?.output_shapes?.[o] === "path" ? " (files, no sample)" : ""}</option>)}
              </Select>
            </Field>
            {mod && (
              <>
                <Field label="Name of the new step" hint="Upper case, used in the code and for its results folder">
                  <Input value={name} onChange={(e) => { setName(e.target.value.toUpperCase()); setPreview(null); }} placeholder={mod.id.toUpperCase()} />
                </Field>
                {mod.inputs.slice(1).map((i) => (
                  <Field key={i.name} label={`${i.name} (${i.type})`} hint="Not produced by the step above: it becomes a pipeline parameter you set at launch">
                    <Input value={extra[i.name] ?? ""} placeholder={`${(name || mod.id).toLowerCase()}_${i.name}`} onChange={(e) => { setExtra((x) => ({ ...x, [i.name]: e.target.value })); setPreview(null); }} />
                  </Field>
                ))}
                {mod.params.length > 0 && <p className="text-[11.5px] text-muted">Its settings ({mod.params.map((p) => p.name).join(", ")}) become pipeline parameters, shown in the launch form.</p>}
              </>
            )}
          </div>
        </div>
        {preview && <div className="mt-3 border-t border-line pt-3"><PreviewBlock p={preview} /></div>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          {!preview ? <Button variant="secondary" loading={busy} disabled={!mod || !after || !output} onClick={() => run(true)}>Preview the change</Button>
            : <Button variant="primary" loading={busy} onClick={() => run(false)}>Add {preview.step} as {nextLabel}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Remove a step; when other steps read its output, optionally connect them to its input instead. */
export function RemoveStepDialog({ open, onOpenChange, pid, baseVersionId, nextLabel, step, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; pid: string; baseVersionId: string; nextLabel: string; step: string; onDone: (r: Preview) => void;
}) {
  const [connect, setConnect] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [first, setFirst] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (c: boolean) => {
    setBusy(true); setError(null);
    try {
      const r = await post(pid, { base_version_id: baseVersionId, op: "remove", step, connect: c, dry_run: true });
      setPreview(r);
      if (!c) setFirst(r);
    } catch (e) { setError(errMsg(e)); setPreview(null); } finally { setBusy(false); }
  };
  useEffect(() => { if (open) { setConnect(false); setFirst(null); load(false); } }, [open, step]); // eslint-disable-line react-hooks/exhaustive-deps
  const apply = async () => {
    setBusy(true);
    try { const r = await post(pid, { base_version_id: baseVersionId, op: "remove", step, connect, dry_run: false }); onDone(r); onOpenChange(false); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Remove ${step}`} wide description="BioCompute removes the step from the Nextflow code and tidies what depended on it. You see the change before anything is saved; earlier versions keep the step.">
        {error && <p className="flex gap-1.5 text-[13px] text-bad"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{error}</p>}
        {first && !first.ok && (
          <div className="space-y-2 rounded-md border border-wait/40 bg-wait/5 p-3 text-[13px]">
            <p>{first.message}</p>
            {first.input ? (
              <label className="flex items-start gap-3">
                <Switch checked={connect} onCheckedChange={(v) => { setConnect(v); if (v) load(true); else setPreview(first); }} className="mt-0.5" />
                <span>Connect {first.consumers?.join(", ")} to what {step} was given instead (<span className="font-mono">{first.input}</span>)
                  <span className="block text-[11.5px] text-muted">Only sensible when that is the same kind of data (e.g. reads in, reads out). Otherwise remove {first.consumers?.join(", ")} first.</span></span>
              </label>
            ) : <p className="text-muted">Remove {first.consumers?.join(", ")} first, or change the code.</p>}
          </div>
        )}
        {preview?.ok && <PreviewBlock p={preview} />}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!preview?.ok} onClick={apply}>Remove as {nextLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
