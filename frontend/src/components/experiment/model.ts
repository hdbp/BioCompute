import type { ExperimentDetail, Issue, Sample } from "@/lib/types";

export type Row = Sample & { _k: string };

let counter = 0;
export const newKey = () => `r${Date.now().toString(36)}${(counter++).toString(36)}`;

export const toRows = (samples: Sample[]): Row[] =>
  samples.map((s) => ({ ...s, files: { ...(s.files ?? {}) }, attributes: { ...(s.attributes ?? {}) }, _k: s.id ?? newKey() }));

export const fromRows = (rows: Row[]): Sample[] =>
  rows.map(({ _k: _ignored, position: _p, ...s }) => {
    void _ignored; void _p;
    return s;
  });

export const blankRow = (sample_id = ""): Row => ({
  _k: newKey(), sample_id, condition: null, replicate: null, technical_replicate: null, batch: null,
  is_control: false, control_id: null, files: {}, attributes: {},
});

export const ASSAYS = [
  { value: "genomics", label: "Genomics (generic sequencing)" },
  { value: "rnaseq", label: "RNA-seq" },
  { value: "chipseq", label: "ChIP-seq" },
  { value: "atacseq", label: "ATAC-seq" },
  { value: "cutandrun", label: "CUT&RUN / CUT&Tag" },
  { value: "methylation", label: "Methylation (bisulfite)" },
  { value: "proteomics", label: "Proteomics / mass spectrometry" },
  { value: "generic", label: "Other" },
];
export const assayLabel = (a: string) => ASSAYS.find((x) => x.value === a)?.label ?? a;

// Distinguishable on both themes; assigned to conditions in order.
export const CONDITION_COLORS = ["#8AA4FF", "#46C2D8", "#5CC98A", "#E8B04B", "#F06A7B", "#C08CF0", "#F59ABF", "#9DB86A"];
export function conditionColor(exp: Pick<ExperimentDetail, "conditions">, name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const i = exp.conditions.findIndex((c) => c.name === name);
  if (i < 0) return undefined;
  return exp.conditions[i].color ?? CONDITION_COLORS[i % CONDITION_COLORS.length];
}

export type ColKind = "text" | "int" | "select" | "check" | "control" | "files" | "path";

export interface Column {
  id: string;
  label: string;
  kind: ColKind;
  width: number;
  help?: string;
  get: (r: Row) => string;
  set: (r: Row, v: string) => Row;
  options?: (rows: Row[], r: Row) => { value: string; label: string }[];
  readonly?: boolean;
}

const attr = (key: string, label: string, width = 120, kind: ColKind = "text", help?: string): Column => ({
  id: `attr:${key}`, label, kind, width, help,
  get: (r) => (r.attributes?.[key] == null ? "" : String(r.attributes[key])),
  set: (r, v) => {
    const a = { ...r.attributes };
    if (v === "") delete a[key];
    else a[key] = kind === "int" && /^-?\d+$/.test(v) ? Number(v) : v;
    return { ...r, attributes: a };
  },
});

const intOrNull = (v: string) => (v.trim() === "" || !/^\d+$/.test(v.trim()) ? null : Number(v.trim()));

export function buildColumns(exp: ExperimentDetail): Column[] {
  const cols: Column[] = [
    {
      id: "sample_id", label: "Sample ID", kind: "text", width: 170, help: "Biological sample name used in samplesheets (letters, digits, _ . -)",
      get: (r) => r.sample_id ?? "", set: (r, v) => ({ ...r, sample_id: v.trim() }),
    },
    {
      id: "condition", label: "Condition", kind: "select", width: 140,
      get: (r) => r.condition ?? "", set: (r, v) => ({ ...r, condition: v || null }),
      options: () => [{ value: "", label: "—" }, ...exp.conditions.map((c) => ({ value: c.name, label: c.name }))],
    },
    {
      id: "replicate", label: "Bio rep", kind: "int", width: 72, help: "Biological replicate number",
      get: (r) => (r.replicate == null ? "" : String(r.replicate)), set: (r, v) => ({ ...r, replicate: intOrNull(v) }),
    },
    {
      id: "technical_replicate", label: "Tech rep", kind: "int", width: 76, help: "Technical replicate (allows repeated sample IDs)",
      get: (r) => (r.technical_replicate == null ? "" : String(r.technical_replicate)), set: (r, v) => ({ ...r, technical_replicate: intOrNull(v) }),
    },
    { id: "batch", label: "Batch", kind: "text", width: 100, get: (r) => r.batch ?? "", set: (r, v) => ({ ...r, batch: v || null }) },
    {
      id: "is_control", label: "Control", kind: "check", width: 70, help: "Input / IgG / background control sample",
      get: (r) => (r.is_control ? "true" : ""), set: (r, v) => ({ ...r, is_control: ["true", "1", "yes", "y", "x"].includes(v.toLowerCase()) }),
    },
    {
      id: "control_id", label: "Matched control", kind: "control", width: 150, help: "Input/control sample paired with this sample",
      get: (r) => r.control_id ?? "", set: (r, v) => ({ ...r, control_id: v || null }),
      options: (rows, r) => [{ value: "", label: "—" }, ...Array.from(new Set(rows.filter((x) => x._k !== r._k && x.sample_id && x.sample_id !== r.sample_id).map((x) => x.sample_id)))
        .sort((a, b) => Number(rows.find((x) => x.sample_id === b)?.is_control) - Number(rows.find((x) => x.sample_id === a)?.is_control) || a.localeCompare(b))
        .map((s) => ({ value: s, label: s }))],
    },
  ];
  if (exp.assay === "proteomics") {
    cols.push(
      {
        id: "raw", label: "Raw file", kind: "path", width: 220, help: "Instrument raw file (.raw, .wiff, .d, .mzML)",
        get: (r) => String(r.files?.raw ?? ""), set: (r, v) => ({ ...r, files: v ? { ...r.files, raw: v } : omit(r.files, "raw") }),
      },
      attr("fraction", "Fraction", 80, "int"),
      attr("fraction_group", "Fraction group", 110, "int"),
      attr("label", "Label", 80, "text", "Label / channel (1 for label-free)"),
      attr("acquisition_batch", "Acquisition batch", 130),
    );
  } else {
    cols.push({
      id: "files", label: "Reads", kind: "files", width: 260, readonly: true, help: "FASTQ files. Use Edit files or Add files.",
      get: (r) => filesSummary(r), set: (r) => r,
    });
  }
  // files are what scientists check first: show them right after the sample ID
  const fi = cols.findIndex((c) => c.id === "files" || c.id === "raw");
  if (fi > 1) cols.splice(1, 0, ...cols.splice(fi, 1));
  for (const c of exp.custom_columns) {
    if (exp.assay === "proteomics" && ["fraction", "fraction_group", "label", "acquisition_batch"].includes(c)) continue;
    cols.push(attr(c, c, 120));
  }
  return cols;
}

function omit<T extends Record<string, unknown>>(o: T, k: string): T {
  const c = { ...o };
  delete c[k];
  return c;
}

export const baseName = (p: unknown) => (typeof p === "string" ? p.split(/[/:]/).pop() ?? p : "");

export interface Run { lane?: string | null; fastq_1?: string | null; fastq_2?: string | null }
export function runsOf(r: Row): Run[] {
  const f = r.files ?? {};
  if (Array.isArray(f.runs)) return f.runs as Run[];
  if (f.fastq_1 || f.fastq_2) return [{ fastq_1: f.fastq_1 as string, fastq_2: (f.fastq_2 as string) ?? null }];
  return [];
}
export function filesSummary(r: Row): string {
  const runs = runsOf(r);
  if (!runs.length) return "";
  if (runs.length > 1) return `${runs.length} lanes, ${runs.every((x) => x.fastq_2) ? "paired" : "single"}-end`;
  return [runs[0].fastq_1, runs[0].fastq_2].filter(Boolean).map(baseName).join("  +  ");
}

/** Map backend issue fields to table column ids. */
export function issueColumn(field: string | null | undefined): string | null {
  if (!field) return null;
  if (["fastq_1", "fastq_2", "files", "runs"].includes(field)) return "files";
  if (field === "sample" || field === "sample_id" || field === "id") return "sample_id";
  if (field === "control") return "control_id";
  if (field === "replicate") return "replicate";
  return field;
}

export interface CellIssue { level: "error" | "warning"; message: string }

/** Instant client-side checks (mirrors a subset of backend validation). */
export function localIssues(rows: Row[]): Map<string, Map<string, CellIssue>> {
  const out = new Map<string, Map<string, CellIssue>>();
  const add = (k: string, col: string, level: "error" | "warning", message: string) => {
    if (!out.has(k)) out.set(k, new Map());
    const m = out.get(k)!;
    if (!m.has(col) || level === "error") m.set(col, { level, message });
  };
  const counts = new Map<string, number>();
  rows.forEach((r) => r.sample_id && counts.set(r.sample_id, (counts.get(r.sample_id) ?? 0) + 1));
  const ids = new Set(rows.map((r) => r.sample_id));
  for (const r of rows) {
    if (!r.sample_id) add(r._k, "sample_id", "error", "Sample ID is required");
    else if (!/^[\w.-]+$/.test(r.sample_id)) add(r._k, "sample_id", "error", "Only letters, digits, '_', '.', '-' are allowed");
    else if ((counts.get(r.sample_id) ?? 0) > 1 && !r.technical_replicate) add(r._k, "sample_id", "error", "Duplicate sample ID (set a technical replicate if intended)");
    if (r.control_id && !ids.has(r.control_id)) add(r._k, "control_id", "error", `'${r.control_id}' is not a sample in this experiment`);
    if (r.control_id && r.control_id === r.sample_id) add(r._k, "control_id", "error", "A sample cannot be its own control");
    const runs = runsOf(r);
    for (const run of runs) {
      if (run.fastq_1 && run.fastq_2 && run.fastq_1 === run.fastq_2) add(r._k, "files", "error", "fastq_1 and fastq_2 are the same file");
    }
  }
  return out;
}

export function serverIssueMap(rows: Row[], issues: Issue[]): Map<string, Map<string, CellIssue>> {
  const out = new Map<string, Map<string, CellIssue>>();
  for (const i of issues) {
    if (!i.sample || i.level === "info") continue;
    const col = issueColumn(i.field) ?? "sample_id";
    for (const r of rows.filter((x) => x.sample_id === i.sample)) {
      if (!out.has(r._k)) out.set(r._k, new Map());
      const m = out.get(r._k)!;
      if (!m.has(col) || i.level === "error") m.set(col, { level: i.level as "error" | "warning", message: i.message });
    }
  }
  return out;
}
