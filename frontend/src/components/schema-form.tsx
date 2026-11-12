import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, CircleHelp, RotateCcw, Search, X } from "lucide-react";
import type { FormField, FormGroup } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Badge, Popover, PopoverContent, PopoverTrigger, Switch } from "@/components/ui/misc";
import { PathInput } from "@/components/file-browser";
import { ReferenceHint, ReferencePicker } from "@/components/reference-picker";

export type Params = Record<string, unknown>;

/** Client-side checks mirroring the JSON schema (the server re-validates authoritatively). */
export function fieldError(f: FormField, v: unknown): string | null {
  const empty = v === undefined || v === null || v === "";
  if (empty) return f.required ? "Required" : null;
  if (f.type === "integer" && !Number.isInteger(Number(v))) return "Must be a whole number";
  if ((f.type === "number" || f.type === "integer") && isNaN(Number(v))) return "Must be a number";
  if (f.minimum != null && Number(v) < f.minimum) return `Minimum ${f.minimum}`;
  if (f.maximum != null && Number(v) > f.maximum) return `Maximum ${f.maximum}`;
  if (f.enum && !f.enum.map(String).includes(String(v))) return `One of: ${f.enum.join(", ")}`;
  if (f.pattern && typeof v === "string" && !v.includes(":") ) {
    try { if (!new RegExp(f.pattern).test(v)) return `Does not match ${f.pattern}`; } catch { /* non-JS regex */ }
  }
  return null;
}

export function formErrors(groups: FormGroup[], params: Params, skip: string[] = []) {
  const out: Record<string, string> = {};
  for (const g of groups) for (const f of g.fields) {
    if (skip.includes(f.name)) continue;
    const e = fieldError(f, params[f.name]);
    if (e) out[f.name] = e;
  }
  return out;
}

const ACRONYMS: Record<string, string> = {
  fasta: "FASTA", fastq: "FASTQ", fastqc: "FastQC", multiqc: "MultiQC", gtf: "GTF", gff: "GFF", bam: "BAM", cram: "CRAM", sam: "SAM",
  bed: "BED", vcf: "VCF", rna: "RNA", dna: "DNA", rrna: "rRNA", umi: "UMI", qc: "QC", id: "ID", url: "URL", cpus: "CPUs", cpu: "CPU",
  gpu: "GPU", igenomes: "iGenomes", star: "STAR", bwa: "BWA", pca: "PCA", tsv: "TSV", csv: "CSV", html: "HTML", pe: "PE", se: "SE",
  s3: "S3", aws: "AWS", ncbi: "NCBI", sra: "SRA", gc: "GC", snp: "SNP", indel: "indel", bp: "bp", tss: "TSS", macs: "MACS",
};

/** A readable label for a parameter name: `save_trimmed_fastq` becomes "Save trimmed FASTQ". The raw name stays visible next to it. */
export function humanLabel(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_\-.\s]+/).filter(Boolean);
  if (!words.length) return name;
  const out = words.map((w) => ACRONYMS[w.toLowerCase()] ?? w.toLowerCase());
  if (out[0] === out[0].toLowerCase()) out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1);
  return out.join(" ");
}

/** True when a value was set to something other than the pipeline default. */
export function isChanged(value: unknown, def: unknown): boolean {
  if (value === undefined) return false;
  if (value === "" && (def === undefined || def === null || def === "")) return false;
  return JSON.stringify(value) !== JSON.stringify(def ?? undefined);
}

const matches = (f: FormField, q: string) =>
  [f.name, f.name.replace(/[_\-.]+/g, " "), humanLabel(f.name), f.description, f.help].some((t) => (t ?? "").toLowerCase().includes(q));

const coerce = (f: FormField, raw: string): unknown => {
  if (raw === "") return "";
  if (f.type === "integer") return Number.isNaN(parseInt(raw)) ? raw : parseInt(raw);
  if (f.type === "number") return Number.isNaN(parseFloat(raw)) ? raw : parseFloat(raw);
  return raw;
};

export function SchemaForm({ groups, params, defaults, onChange, managed = [], serverIssues = {}, readOnly, compact, toolbar = true, reveal }: {
  groups: FormGroup[]; params: Params; defaults: Params; onChange: (p: Params) => void;
  /** params filled in by BioCompute (e.g. input samplesheet, outdir) and therefore not editable here */
  managed?: { name: string; note: string }[];
  serverIssues?: Record<string, string>; readOnly?: boolean; compact?: boolean;
  /** search box and "Changed only" filter above the groups (default on) */
  toolbar?: boolean;
  /** show this parameter: clears the filters, opens its group and scrolls to it (pass a new object to repeat) */
  reveal?: { name: string } | null;
}) {
  const uid = useId();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const hiddenCount = useMemo(() => groups.reduce((n, g) => n + g.fields.filter((f) => f.hidden).length, 0), [groups]);
  const totalCount = useMemo(() => groups.reduce((n, g) => n + g.fields.length, 0), [groups]);
  const set = (k: string, v: unknown) => onChange({ ...params, [k]: v });
  const isManaged = (name: string) => managed.some((m) => m.name === name);
  const changedOf = (f: FormField) => !isManaged(f.name) && isChanged(params[f.name], defaults[f.name]);
  const changedTotal = groups.reduce((n, g) => n + g.fields.filter(changedOf).length, 0);
  // "Changed only" keeps a field on screen once it was listed, so it does not vanish while its value is typed back to the default
  const listed = useRef(new Set<string>());
  if (!changedOnly) listed.current.clear();
  else groups.forEach((g) => g.fields.forEach((f) => { if (changedOf(f)) listed.current.add(f.name); }));
  const q = query.trim().toLowerCase();
  const filtering = !!q || changedOnly;
  // a search or "Changed only" looks through every parameter, advanced ones included, and opens the groups that match
  const visible = groups.map((g) => ({
    g, fields: g.fields.filter((f) => (filtering || showAdvanced || !f.hidden) && (!q || matches(f, q)) && (!changedOnly || listed.current.has(f.name))),
  })).filter((x) => x.fields.length > 0);
  const shown = visible.reduce((n, x) => n + x.fields.length, 0);
  useEffect(() => {
    if (!reveal) return;
    const g = groups.find((x) => x.fields.some((f) => f.name === reveal.name));
    if (!g) return;
    setQuery(""); setChangedOnly(false);
    if (g.fields.find((f) => f.name === reveal.name)?.hidden) setShowAdvanced(true);
    setCollapsed((c) => ({ ...c, [g.id]: false }));
    const t = setTimeout(() => {   // after the group has opened
      const el = document.getElementById(`p-${reveal.name}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus({ preventScroll: true });
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  return (
    <div className="space-y-4">
      {(toolbar || hiddenCount > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">
          {toolbar && (
            <>
              <div className="relative min-w-48 flex-1 sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
                <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a parameter" aria-label="Find a parameter by name or description" className="pl-8 pr-7" />
                {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-2 top-2.5 text-muted hover:text-text"><X className="size-4" /></button>}
              </div>
              <span className="flex items-center gap-2">
                <label htmlFor={`${uid}-chg`} className="cursor-pointer">Changed only{changedTotal > 0 ? ` (${changedTotal})` : ""}</label>
                <Switch id={`${uid}-chg`} checked={changedOnly} onCheckedChange={setChangedOnly} />
              </span>
            </>
          )}
          {hiddenCount > 0 && (
            <span className={cn("flex items-center gap-2", toolbar ? "sm:ml-auto" : "ml-auto")}>
              <label htmlFor={`${uid}-adv`} className="cursor-pointer">Show {hiddenCount} advanced parameter{hiddenCount === 1 ? "" : "s"}</label>
              <Switch id={`${uid}-adv`} checked={showAdvanced || filtering} disabled={filtering} onCheckedChange={setShowAdvanced} />
            </span>
          )}
        </div>
      )}
      {filtering && (
        <p className="text-xs text-muted" role="status">
          {shown === 0
            ? (changedOnly && !q ? "No parameter differs from its default." : `No parameter matches${q ? ` "${query.trim()}"` : ""}${changedOnly ? " among the changed ones" : ""}.`)
            : `Showing ${shown} of ${totalCount} parameters.`}{" "}
          <button type="button" className="text-accent hover:underline" onClick={() => { setQuery(""); setChangedOnly(false); }}>Show all</button>
        </p>
      )}
      {visible.map(({ g, fields }) => {
        const isCollapsed = filtering ? false : collapsed[g.id] ?? (g.advanced && !showAdvanced);
        const changed = g.fields.filter(changedOf).length;
        return (
          <section key={g.id} className="rounded-lg border border-line bg-surface">
            <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={() => setCollapsed({ ...collapsed, [g.id]: !isCollapsed })} aria-expanded={!isCollapsed} disabled={filtering}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{g.title}</p>
                {g.description && <p className="text-xs text-muted truncate">{g.description}</p>}
              </div>
              {changed > 0 && <Badge tone="accent">{changed} changed</Badge>}
              <span className="text-xs text-muted">{fields.length}</span>
              <ChevronDown className={cn("size-4 text-muted transition-transform", isCollapsed && "-rotate-90")} />
            </button>
            {!isCollapsed && (
              <div className={cn("grid gap-x-6 gap-y-4 border-t border-line px-4 py-4", compact ? "md:grid-cols-2" : "lg:grid-cols-2")}>
                {fields.map((f) => {
                  const m = managed.find((x) => x.name === f.name);
                  const err = serverIssues[f.name] ?? (m ? null : fieldError(f, params[f.name]));
                  return <FieldControl key={f.name} f={f} value={params[f.name]} def={defaults[f.name]} error={err} managed={m?.note}
                    readOnly={readOnly} onChange={(v) => set(f.name, v)} />;
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function FieldControl({ f, value, def, error, managed, readOnly, onChange }: {
  f: FormField; value: unknown; def: unknown; error: string | null; managed?: string; readOnly?: boolean; onChange: (v: unknown) => void;
}) {
  const id = `p-${f.name}`;
  const isDefault = value === undefined || JSON.stringify(value) === JSON.stringify(def);
  const wide = f.widget === "file" || f.widget === "directory" || f.widget === "textarea" || (f.description?.length ?? 0) > 90;
  const v = value ?? "";
  let control: React.ReactNode;
  if (managed) {
    control = <div className="rounded-md border border-dashed border-line px-2.5 py-1.5 text-[13px] text-muted">{managed}</div>;
  } else if (f.widget === "toggle") {
    control = <Switch id={id} checked={value === undefined ? !!def : !!value} onCheckedChange={onChange} disabled={readOnly} />;
  } else if (f.widget === "select") {
    control = (
      <Select id={id} value={String(v)} disabled={readOnly} aria-invalid={!!error}
        onChange={(e) => onChange(e.target.value === "" ? "" : f.type === "integer" || f.type === "number" ? Number(e.target.value) : e.target.value)}>
        {!f.required && <option value="">Not set</option>}
        {f.enum!.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
      </Select>
    );
  } else if (f.widget === "file" || f.widget === "directory") {
    control = readOnly ? <Input value={String(v)} readOnly className="font-mono text-[12px]" />
      : (
        <>
          <div className="flex gap-1.5">
            <div className="min-w-0 flex-1"><PathInput id={id} mode={f.widget === "directory" ? "dir" : "file"} value={String(v)} onChange={onChange} invalid={!!error} writableOnly={false} /></div>
            <ReferencePicker value={String(v)} directory={f.widget === "directory"} onPick={onChange} compact />
          </div>
          <ReferenceHint value={v} />
        </>
      );
  } else if (f.widget === "textarea") {
    control = <Textarea id={id} value={String(v)} onChange={(e) => onChange(e.target.value)} readOnly={readOnly} aria-invalid={!!error} />;
  } else {
    control = (
      <Input id={id} type={f.widget === "number" ? "number" : "text"} value={String(v)} readOnly={readOnly} aria-invalid={!!error}
        min={f.minimum ?? undefined} max={f.maximum ?? undefined} step={f.type === "integer" ? 1 : "any"}
        placeholder={def !== undefined && def !== null ? String(def) : undefined}
        onChange={(e) => onChange(f.widget === "number" ? coerce(f, e.target.value) : e.target.value)} />
    );
  }
  return (
    <div className={cn("min-w-0 space-y-1.5", wide && "lg:col-span-2 md:col-span-2")}>
      <div className="flex min-w-0 items-center gap-1.5">
        <label htmlFor={id} className="min-w-0 truncate text-[13px] font-medium text-text" title={`Parameter --${f.name}`}>{humanLabel(f.name)}</label>
        {f.required && <span className="text-bad text-xs" aria-label="required">*</span>}
        <code className="min-w-0 shrink truncate select-all font-mono text-[11.5px] text-muted" title="Parameter name, as used in scripts and on the command line (click to select)">{f.name}</code>
        {f.hidden && <Badge className="text-[10.5px]">advanced</Badge>}
        {f.help && (
          <Popover>
            <PopoverTrigger className="text-muted hover:text-text" aria-label={`Help for ${f.name}`}><CircleHelp className="size-3.5" /></PopoverTrigger>
            <PopoverContent className="max-w-sm text-[13px] whitespace-pre-wrap">{f.help}</PopoverContent>
          </Popover>
        )}
        {!managed && !readOnly && !isDefault && def !== undefined && (
          <button type="button" onClick={() => onChange(def)} className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-muted hover:text-text" title={`Restore default (${String(def)})`}>
            <RotateCcw className="size-3" />default
          </button>
        )}
      </div>
      {control}
      {error ? <p className="text-xs text-bad">{error}</p>
        : f.description ? <p className="text-xs text-muted">{f.description}{f.minimum != null || f.maximum != null ? ` Range ${f.minimum ?? "−∞"} to ${f.maximum ?? "∞"}.` : ""}</p> : null}
    </div>
  );
}

/** Generic key/value editor for pipelines without a usable schema. */
export function GenericParamEditor({ params, onChange }: { params: Params; onChange: (p: Params) => void }) {
  const rows = Object.entries(params);
  const parse = (s: string): unknown => {
    if (s === "true") return true;
    if (s === "false") return false;
    if (s !== "" && !isNaN(Number(s))) return Number(s);
    return s;
  };
  return (
    <div className="space-y-2">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-2">
          <Input value={k} className="w-56 font-mono text-[12px]" aria-label="Parameter name"
            onChange={(e) => { const n = Object.fromEntries(rows.map(([kk, vv], j) => (j === i ? [e.target.value, vv] : [kk, vv]))); onChange(n); }} />
          <Input value={String(v)} aria-label="Value" onChange={(e) => onChange({ ...params, [k]: parse(e.target.value) })} />
          <button type="button" className="px-2 text-muted hover:text-bad" onClick={() => { const n = { ...params }; delete n[k]; onChange(n); }} aria-label={`Remove ${k}`}>×</button>
        </div>
      ))}
      <button type="button" className="text-[13px] text-accent hover:underline" onClick={() => onChange({ ...params, [`param_${rows.length + 1}`]: "" })}>Add parameter</button>
    </div>
  );
}
