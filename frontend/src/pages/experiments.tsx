import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FlaskConical, MoreHorizontal, Play, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { Experiment, ExperimentDetail } from "@/lib/types";
import { ago } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { PageHeader } from "@/components/page";
import { ASSAYS, assayLabel, CONDITION_COLORS } from "@/components/experiment/model";

export default function ExperimentsPage() {
  const user = useAuth((s) => s.user);
  const editor = can(user, "scientist");
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["experiments"], queryFn: () => api.get<Experiment[]>("/api/experiments") });
  const [createOpen, setCreateOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Experiment | null>(null);
  const [filter, setFilter] = useState("");
  const [assay, setAssay] = useState("");

  const items = useMemo(() => {
    const f = filter.toLowerCase();
    return (q.data ?? []).filter((e) => (!assay || e.assay === assay) &&
      (!f || e.name.toLowerCase().includes(f) || e.description.toLowerCase().includes(f) || e.conditions.some((c) => c.name.toLowerCase().includes(f))));
  }, [q.data, filter, assay]);

  async function duplicate(e: Experiment) {
    try {
      const r = await api.post<ExperimentDetail>(`/api/experiments/${e.id}/duplicate`);
      qc.invalidateQueries({ queryKey: ["experiments"] });
      toast.success(`Created ${r.name}`);
      nav(`/experiments/${r.id}`);
    } catch (err) {
      toast.error(errMsg(err));
    }
  }

  return (
    <div>
      <PageHeader title="Experiments"
        description="Define samples, conditions, replicates and controls once, then generate the samplesheet each pipeline expects."
        actions={editor && <Button variant="primary" onClick={() => setCreateOpen(true)}><Plus />New experiment</Button>} />

      {(q.data?.length ?? 0) > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          <div className="relative w-72 max-w-full">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search name, description or condition" className="pl-8" aria-label="Search experiments" />
          </div>
          <Select value={assay} onChange={(e) => setAssay(e.target.value)} className="w-56" aria-label="Filter by assay">
            <option value="">All assays</option>
            {ASSAYS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </Select>
        </div>
      )}

      {q.isLoading && <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>}
      {q.isError && <p className="text-bad text-[13px]">{errMsg(q.error)}</p>}
      {q.data?.length === 0 && (
        <div className="rounded-lg border border-dashed border-line bg-surface">
          <Empty icon={<FlaskConical />} title="No experiments yet"
            action={editor && <Button variant="primary" onClick={() => setCreateOpen(true)}><Plus />Create your first experiment</Button>}>
            An experiment groups your samples with their conditions, replicates, batches and matched controls. BioCompute
            detects read pairs and lanes from file names and validates everything before a pipeline runs.
          </Empty>
        </div>
      )}
      {q.data && q.data.length > 0 && items.length === 0 && <p className="py-10 text-center text-[13px] text-muted">No experiments match these filters.</p>}

      {items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-[13px]">
            <thead className="bg-raised text-muted">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Experiment</th>
                <th className="px-3 py-2 text-left font-medium">Assay</th>
                <th className="px-3 py-2 text-right font-medium">Samples</th>
                <th className="px-3 py-2 text-left font-medium">Conditions</th>
                <th className="px-3 py-2 text-left font-medium">Updated</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} className="border-t border-line hover:bg-raised/40">
                  <td className="px-4 py-2.5 max-w-md">
                    <Link to={`/experiments/${e.id}`} className="font-medium hover:text-accent">{e.name}</Link>
                    {e.description && <p className="truncate text-xs text-muted mt-0.5">{e.description}</p>}
                  </td>
                  <td className="px-3 py-2.5"><Badge>{assayLabel(e.assay)}</Badge></td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{e.sample_count}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {e.conditions.length === 0 && <span className="text-muted">—</span>}
                      {e.conditions.slice(0, 4).map((c, i) => (
                        <span key={c.name} className="inline-flex items-center gap-1.5 text-xs">
                          <span className="size-2 rounded-full" style={{ background: c.color ?? CONDITION_COLORS[i % CONDITION_COLORS.length] }} />{c.name}
                        </span>
                      ))}
                      {e.conditions.length > 4 && <span className="text-xs text-muted">+{e.conditions.length - 4} more</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-muted whitespace-nowrap">{ago(e.updated_at)}</td>
                  <td className="px-2 py-2.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger className="rounded p-1 text-muted hover:bg-raised hover:text-text" aria-label={`Actions for ${e.name}`}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onSelect={() => nav(`/experiments/${e.id}`)}><FlaskConical />Open</DropdownMenuItem>
                        <DropdownMenuItem disabled={!e.sample_count} onSelect={() => nav(`/jobs/new?experiment=${e.id}`)}><Play />Run analysis</DropdownMenuItem>
                        {editor && <DropdownMenuItem onSelect={() => duplicate(e)}><Copy />Duplicate</DropdownMenuItem>}
                        {editor && <><DropdownMenuSeparator /><DropdownMenuItem danger onSelect={() => setToDelete(e)}><Trash2 />Delete</DropdownMenuItem></>}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(id) => { qc.invalidateQueries({ queryKey: ["experiments"] }); nav(`/experiments/${id}`); }} />
      <DeleteDialog exp={toDelete} onClose={() => setToDelete(null)} onDeleted={() => qc.invalidateQueries({ queryKey: ["experiments"] })} />
    </div>
  );
}

function CreateDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [assay, setAssay] = useState("genomics");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<ExperimentDetail>("/api/experiments", { name: name.trim(), description, assay });
      onOpenChange(false);
      setName(""); setDescription(""); setAssay("genomics");
      onCreated(r.id);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New experiment" description="You can add samples, conditions and metadata columns next.">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Name" required><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. H3K27ac ChIP-seq, drug time course" maxLength={200} /></Field>
          <Field label="Assay" hint={assay === "proteomics" ? "Proteomics experiments use raw instrument files, fractions, labels and acquisition batches." : "Sequencing experiments use FASTQ files with automatic read-pair detection."}>
            <Select value={assay} onChange={(e) => setAssay(e.target.value)}>
              {ASSAYS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </Select>
          </Field>
          <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Biological question, protocol, sequencing run" /></Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>Create experiment</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ exp, onClose, onDeleted }: { exp: Experiment | null; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    if (!exp) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/experiments/${exp.id}`);
      toast.success(`Deleted ${exp.name}`);
      onDeleted();
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={!!exp} onOpenChange={(o) => { if (!o) { setError(null); onClose(); } }}>
      <DialogContent title={`Delete ${exp?.name ?? "experiment"}?`} description="Samples and their metadata are removed. Data files on disk are not touched.">
        {error && <p className="rounded-md border border-bad/30 bg-bad/10 p-2.5 text-[13px] text-bad">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={go}><Trash2 />Delete experiment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
