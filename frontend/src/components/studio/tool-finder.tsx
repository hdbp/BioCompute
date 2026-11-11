import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileUp, Loader2, PackageSearch, Plus, RefreshCw, Sparkles } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import type { AssistantStatus, InstalledTool, ModuleDef, StudioModule } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { emptyModule, normalizeModule } from "./module-builder";

/** Finds bioinformatics programs installed on the controller and turns them into modules. */
export function ToolFinder({ open, onOpenChange, modules, onCreate }: {
  open: boolean; onOpenChange: (o: boolean) => void; modules: StudioModule[];
  onCreate: (def: ModuleDef, notes?: string | null) => void;
}) {
  const scan = useQuery({ queryKey: ["tool-scan"], queryFn: () => api.get<{ tools: InstalledTool[]; templates: string[] }>("/api/studio/tools/scan"), enabled: open, staleTime: 60_000 });
  const ai = useQuery({ queryKey: ["assistant-status"], queryFn: () => api.get<AssistantStatus>("/api/assistant/status"), staleTime: 60_000 });
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // a tool counts as "covered" when a built-in or user module already lists it
  const covered = new Set(modules.flatMap((m) => m.tools ?? []));

  const fromTemplate = async (t: InstalledTool) => {
    setBusy(t.exe);
    try {
      const def = t.template ? await api.get<ModuleDef>(`/api/studio/module-templates/${t.template}`)
        : await api.get<ModuleDef>(`/api/studio/module-skeleton?exe=${encodeURIComponent(t.exe)}`);
      onCreate(normalizeModule(def), t.template ? null : "Generic skeleton: set the ports, parameters and command line for this program.");
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };

  const withAI = async (exe: string) => {
    setBusy(`ai:${exe}`);
    try {
      const r = await api.post<{ module: ModuleDef; notes: string; grounded_on_help: boolean }>("/api/assistant/draft-module",
        { description: `Wrap ${exe} as a BioCompute module with its most useful options as parameters.`, tool: exe });
      onCreate(normalizeModule(r.module), `Drafted by the assistant${r.grounded_on_help ? " from the program's --help text" : ""}. ${r.notes}`);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };

  const checkOther = async () => {
    const name = other.trim();
    if (!name) return;
    setBusy(`check:${name}`);
    try {
      const r = await api.get<{ found: boolean; path?: string; version?: string | null }>(`/api/studio/tools/check?name=${encodeURIComponent(name)}`);
      if (!r.found) { toast.error(`“${name}” is not on the controller's PATH. Install it (or activate its environment for the BioCompute service) and try again.`); return; }
      toast.success(`Found ${r.path}${r.version ? ` (${r.version})` : ""}`);
      if (ai.data?.enabled) await withAI(name);
      else await fromTemplate({ exe: name, name, category: "My modules", template: null, path: r.path ?? "", version: r.version ?? null });
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };

  const importJson = async (f: File) => {
    try {
      const raw = JSON.parse(await f.text());
      onCreate(normalizeModule(raw), `Imported from ${f.name}. Review it before saving.`);
    } catch { toast.error("That file is not a module definition (JSON)."); }
  };

  const tools = scan.data?.tools ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide title="Add software as modules"
        description="Programs found on the controller's PATH. Install new software (e.g. another peak caller), then create a module for it here.">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => scan.refetch()} loading={scan.isFetching}><RefreshCw />Scan again</Button>
            <Button size="sm" variant="secondary" onClick={() => onCreate(emptyModule())}><Plus />Blank module</Button>
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}><FileUp />Import JSON</Button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ""; }} />
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); checkOther(); }}>
            <Input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Another program by its command name, e.g. LanceOtron or chromap" aria-label="Program name" />
            <Button type="submit" size="sm" variant="secondary" loading={!!busy?.startsWith("check:")}>Find</Button>
          </form>
          {scan.isLoading ? <p className="flex items-center gap-2 py-6 text-[13px] text-muted"><Loader2 className="size-4 animate-spin" />Looking for installed programs…</p>
            : scan.isError ? <p className="text-[13px] text-bad">{errMsg(scan.error)}</p>
            : tools.length === 0 ? <p className="py-4 text-[13px] text-muted">None of the known programs are on the controller's PATH.</p> : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {tools.map((t) => (
                <li key={t.exe} className="flex items-center gap-3 px-3 py-2">
                  <PackageSearch className="size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px]"><span className="font-medium">{t.name}</span> <span className="text-muted">{t.version ?? ""}</span></p>
                    <p className="truncate font-mono text-[11.5px] text-muted">{t.path}</p>
                  </div>
                  <Badge>{t.category}</Badge>
                  {covered.has(t.exe) && <Badge tone="ok">has a module</Badge>}
                  <Button size="sm" variant="ghost" onClick={() => fromTemplate(t)} loading={busy === t.exe}>{t.template ? "Use template" : "Skeleton"}</Button>
                  {ai.data?.enabled && (
                    <Button size="sm" variant="ghost" onClick={() => withAI(t.exe)} loading={busy === `ai:${t.exe}`} aria-label={`Draft a ${t.name} module with the assistant`}><Sparkles />Draft</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-muted">
            Modules run on whichever node executes the task, so the program must be installed there too, or provided by the module's
            conda package or container. Nothing is installed automatically.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
