import type { Edge } from "@xyflow/react";
import type { StudioModule } from "@/lib/types";
import { makeNode, type Graph, type StudioNode } from "./model";

const e = (s: string, sh: string, t: string, th: string): Edge => ({ id: `e_${s}_${sh}_${t}_${th}`, source: s, sourceHandle: `out:${sh}`, target: t, targetHandle: `in:${th}` });

function build(mods: Record<string, StudioModule>, specs: [string, string, number, number, Record<string, unknown>?][]): StudioNode[] {
  return specs.filter(([, m]) => mods[m]).map(([id, m, x, y, over]) => makeNode(mods[m], { x, y }, over ?? {}, id));
}

export function chipseqExample(mods: Record<string, StudioModule>): Graph {
  const nodes = build(mods, [
    ["in", "input_samplesheet", 0, 160],
    ["idx", "input_file", 300, 340, { label: "Bowtie2 index", params: { param_name: "bowtie2_index", file_type: "index", format: "directory-path" } }],
    ["qc", "fastqc", 300, 0],
    ["trim", "fastp", 300, 170],
    ["aln", "bowtie2", 620, 220],
    ["flt", "bam_filter", 920, 220],
    ["peaks", "macs3", 1210, 220],
    ["mqc", "multiqc", 1500, 60],
  ]);
  return {
    nodes,
    edges: [
      e("in", "reads", "qc", "reads"), e("in", "reads", "trim", "reads"), e("trim", "reads", "aln", "reads"),
      e("idx", "file", "aln", "index"), e("aln", "bam", "flt", "bam"), e("flt", "bam", "peaks", "bam"),
      e("qc", "zip", "mqc", "reports"), e("trim", "json", "mqc", "reports"), e("aln", "log", "mqc", "reports"), e("peaks", "xls", "mqc", "reports"),
    ],
  };
}

export function portableExample(mods: Record<string, StudioModule>): Graph {
  const nodes = build(mods, [
    ["in", "input_samplesheet", 0, 100],
    ["sub", "subsample", 290, 100, { params: { reads: 5000 } }],
    ["st", "fastq_stats", 580, 100, { label: "Read statistics" }],
    ["rep", "summary_report", 870, 100, { params: { title: "Portable QC summary" } }],
    ["out", "output_results", 1160, 100],
  ]);
  return {
    nodes,
    edges: [e("in", "reads", "sub", "reads"), e("sub", "reads", "st", "reads"), e("st", "stats", "rep", "tables"), e("rep", "html", "out", "results")],
  };
}
