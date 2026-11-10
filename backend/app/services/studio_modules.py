"""Pipeline Studio module library.

Each module is a bash (or R / Python) script body that reads its inputs, parameters and
resources from environment variables:

* ``BC_PREFIX``   - sample id (per-sample modules) or module name (aggregate)
* ``BC_CPUS``     - CPUs granted to the task
* ``BC_IN_<NAME>``  - space-separated input file paths for input port <NAME>
* ``BC_PARAM_<NAME>`` - module parameter values

The same script is executed by Nextflow (via a generated process) and by the native
bcflow engine, so a Studio graph has one behaviour regardless of engine.
"""
from __future__ import annotations

from typing import Any

PORT_TYPES = {
    "fastq": {"label": "FASTQ reads", "color": "#38bdf8"},
    "bam": {"label": "Alignments (BAM)", "color": "#a78bfa"},
    "peaks": {"label": "Peaks / intervals", "color": "#f472b6"},
    "bigwig": {"label": "Coverage track", "color": "#fb923c"},
    "fasta": {"label": "Reference FASTA", "color": "#facc15"},
    "index": {"label": "Aligner index", "color": "#eab308"},
    "annotation": {"label": "Annotation (GTF/BED)", "color": "#84cc16"},
    "qc": {"label": "QC report data", "color": "#34d399"},
    "table": {"label": "Table (TSV/CSV)", "color": "#2dd4bf"},
    "html": {"label": "HTML report", "color": "#4ade80"},
    "rds": {"label": "R object", "color": "#60a5fa"},
    "any": {"label": "Any file", "color": "#94a3b8"},
}

_FASTQ_STATS = r'''set -euo pipefail
out="${BC_PREFIX}.stats.tsv"
printf "sample\tfile\treads\tbases\tmean_length\tgc_percent\tmean_quality\treads_ge_min_length\n" > "$out"
for f in $BC_IN_READS; do
  case "$f" in *.gz) reader="gzip -dc";; *) reader="cat";; esac
  $reader "$f" | awk -v s="$BC_PREFIX" -v fn="$(basename "$f")" -v minlen="${BC_PARAM_MIN_LENGTH:-0}" '
    BEGIN { for (i = 33; i < 127; i++) ord[sprintf("%c", i)] = i }
    NR % 4 == 2 { n++; L = length($0); b += L; if (L >= minlen) keep++; gc += gsub(/[GCgc]/, "") }
    NR % 4 == 0 { for (i = 1; i <= length($0); i++) q += ord[substr($0, i, 1)] - 33; qn += length($0) }
    END { printf "%s\t%s\t%d\t%d\t%.2f\t%.2f\t%.2f\t%d\n", s, fn, n, b, (n ? b / n : 0), (b ? 100 * gc / b : 0), (qn ? q / qn : 0), keep }' >> "$out"
done
'''

_SUBSAMPLE = r'''set -euo pipefail
i=1
for f in $BC_IN_READS; do
  case "$f" in *.gz) reader="gzip -dc";; *) reader="cat";; esac
  { $reader "$f" || true; } | head -n $(( 4 * ${BC_PARAM_READS:-10000} )) | gzip -c > "${BC_PREFIX}_sub_R${i}.fastq.gz"
  i=$((i + 1))
done
'''

_SUMMARY = r'''#!/usr/bin/env python3
import csv, html, os, sys
files = os.environ.get("BC_IN_TABLES", "").split()
rows, header = [], None
for f in sorted(files):
    with open(f, newline="") as fh:
        r = csv.reader(fh, delimiter="\t")
        h = next(r, None)
        header = header or h
        rows.extend(r)
title = os.environ.get("BC_PARAM_TITLE", "BioCompute summary")
with open("summary.tsv", "w", newline="") as out:
    w = csv.writer(out, delimiter="\t")
    if header:
        w.writerow(header)
    w.writerows(rows)
cells = "".join("<tr>" + "".join(f"<td>{html.escape(c)}</td>" for c in r) + "</tr>" for r in rows)
head = "".join(f"<th>{html.escape(c)}</th>" for c in (header or []))
with open("summary.html", "w") as out:
    out.write(f"<!doctype html><meta charset=utf-8><title>{html.escape(title)}</title>"
              "<style>body{font:14px system-ui;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style>"
              f"<h1>{html.escape(title)}</h1><p>{len(rows)} rows from {len(files)} file(s)</p><table><tr>{head}</tr>{cells}</table>")
'''

_MERGE = r'''set -euo pipefail
first=1
for f in $BC_IN_TABLES; do
  if [ $first -eq 1 ]; then cat "$f"; first=0; else tail -n +2 "$f"; fi
done > merged.tsv
'''

MODULES: list[dict[str, Any]] = [
    # ---------------------------------------------------------------- sources/sinks (structural)
    {"id": "input_samplesheet", "kind": "source", "name": "Samplesheet reads", "category": "Inputs",
     "description": "FASTQ reads from the experiment samplesheet (columns: sample, fastq_1, fastq_2, condition, replicate).",
     "inputs": [], "outputs": [{"name": "reads", "type": "fastq"}], "params": []},
    {"id": "input_file", "kind": "source", "name": "Reference / parameter file", "category": "Inputs",
     "description": "A single file or directory given as a pipeline parameter (e.g. genome FASTA, aligner index, GTF).",
     "inputs": [], "outputs": [{"name": "file", "type": "any"}],
     "params": [{"name": "param_name", "type": "string", "default": "reference", "description": "Pipeline parameter name"},
                {"name": "file_type", "type": "string", "default": "any", "enum": list(PORT_TYPES), "description": "Port type"},
                {"name": "format", "type": "string", "default": "file-path", "enum": ["file-path", "directory-path"]}]},
    {"id": "output_results", "kind": "sink", "name": "Publish results", "category": "Outputs",
     "description": "Outputs connected here are published to the run's output directory.",
     "inputs": [{"name": "results", "type": "any", "multiple": True}], "outputs": [], "params": []},
    # ---------------------------------------------------------------- portable utilities
    {"id": "fastq_stats", "kind": "module", "name": "FASTQ statistics", "category": "Quality control", "scope": "per_sample",
     "description": "Read count, bases, mean length, GC% and mean Phred quality (bash/awk; no external tools).",
     "inputs": [{"name": "reads", "type": "fastq"}], "outputs": [{"name": "stats", "type": "table", "pattern": "{prefix}.stats.tsv"}],
     "params": [{"name": "min_length", "type": "integer", "default": 0, "minimum": 0, "description": "Count reads at least this long"}],
     "tools": ["bash", "awk", "gzip"], "cpus": 1, "memory_gb": 1, "language": "bash", "script": _FASTQ_STATS},
    {"id": "subsample", "kind": "module", "name": "Subsample reads", "category": "Preprocessing", "scope": "per_sample",
     "description": "Keep the first N reads of each FASTQ file (fast smoke tests).",
     "inputs": [{"name": "reads", "type": "fastq"}], "outputs": [{"name": "reads", "type": "fastq", "pattern": "{prefix}_sub_R*.fastq.gz"}],
     "params": [{"name": "reads", "type": "integer", "default": 10000, "minimum": 1, "description": "Reads per file"}],
     "tools": ["bash", "gzip", "head"], "cpus": 1, "memory_gb": 1, "language": "bash", "script": _SUBSAMPLE},
    {"id": "summary_report", "kind": "module", "name": "Summary report", "category": "Reporting", "scope": "aggregate",
     "description": "Concatenate per-sample tables into summary.tsv and an HTML table.",
     "inputs": [{"name": "tables", "type": "table", "multiple": True}],
     "outputs": [{"name": "html", "type": "html", "pattern": "summary.html"}, {"name": "tsv", "type": "table", "pattern": "summary.tsv"}],
     "params": [{"name": "title", "type": "string", "default": "BioCompute summary"}],
     "tools": ["python3"], "cpus": 1, "memory_gb": 1, "language": "python", "script": _SUMMARY},
    {"id": "merge_tables", "kind": "module", "name": "Merge tables", "category": "Reporting", "scope": "aggregate",
     "description": "Row-bind TSV tables with identical headers.",
     "inputs": [{"name": "tables", "type": "table", "multiple": True}], "outputs": [{"name": "merged", "type": "table", "pattern": "merged.tsv"}],
     "params": [], "tools": ["bash"], "cpus": 1, "memory_gb": 1, "language": "bash", "script": _MERGE},
    # ---------------------------------------------------------------- bioinformatics tools
    {"id": "fastqc", "kind": "module", "name": "FastQC", "category": "Quality control", "scope": "per_sample",
     "description": "Per-read-file quality control reports.",
     "inputs": [{"name": "reads", "type": "fastq"}],
     "outputs": [{"name": "zip", "type": "qc", "pattern": "*_fastqc.zip"}, {"name": "html", "type": "html", "pattern": "*_fastqc.html"}],
     "params": [], "tools": ["fastqc"], "cpus": 2, "memory_gb": 4, "language": "bash",
     "conda": "bioconda::fastqc=0.12.1", "container": "quay.io/biocontainers/fastqc:0.12.1--hdfd78af_0",
     "script": 'set -euo pipefail\nfastqc --quiet --threads "$BC_CPUS" --outdir . $BC_IN_READS\n'},
    {"id": "fastp", "kind": "module", "name": "fastp trimming", "category": "Preprocessing", "scope": "per_sample",
     "description": "Adapter and quality trimming with fastp (auto-detects single/paired end).",
     "inputs": [{"name": "reads", "type": "fastq"}],
     "outputs": [{"name": "reads", "type": "fastq", "pattern": "{prefix}_trimmed_R*.fastq.gz"},
                 {"name": "json", "type": "qc", "pattern": "{prefix}.fastp.json"}],
     "params": [{"name": "qualified_quality", "type": "integer", "default": 20, "minimum": 0, "maximum": 40, "description": "Phred quality threshold"},
                {"name": "min_length", "type": "integer", "default": 20, "minimum": 1, "description": "Discard reads shorter than this"}],
     "tools": ["fastp"], "cpus": 4, "memory_gb": 4, "language": "bash",
     "conda": "bioconda::fastp=0.23.4", "container": "quay.io/biocontainers/fastp:0.23.4--h5f740d0_0",
     "script": 'set -euo pipefail\nset -- $BC_IN_READS\nopts="-w $BC_CPUS -q $BC_PARAM_QUALIFIED_QUALITY -l $BC_PARAM_MIN_LENGTH -j ${BC_PREFIX}.fastp.json -h ${BC_PREFIX}.fastp.html"\n'
               'if [ $# -ge 2 ]; then\n  fastp -i "$1" -I "$2" -o "${BC_PREFIX}_trimmed_R1.fastq.gz" -O "${BC_PREFIX}_trimmed_R2.fastq.gz" --detect_adapter_for_pe $opts\n'
               'else\n  fastp -i "$1" -o "${BC_PREFIX}_trimmed_R1.fastq.gz" $opts\nfi\n'},
    {"id": "bowtie2", "kind": "module", "name": "Bowtie2 alignment", "category": "Alignment", "scope": "per_sample",
     "description": "Align reads with Bowtie2 and coordinate-sort with samtools.",
     "inputs": [{"name": "reads", "type": "fastq"}, {"name": "index", "type": "index"}],
     "outputs": [{"name": "bam", "type": "bam", "pattern": "{prefix}.sorted.bam"}, {"name": "log", "type": "qc", "pattern": "{prefix}.bowtie2.log"}],
     "params": [{"name": "extra_args", "type": "string", "default": "--very-sensitive", "description": "Additional Bowtie2 arguments"}],
     "tools": ["bowtie2", "samtools"], "cpus": 8, "memory_gb": 16, "language": "bash",
     "conda": "bioconda::bowtie2=2.5.4 bioconda::samtools=1.21",
     "container": "quay.io/biocontainers/mulled-v2-ac74a7f02cebcfcc07d8e8d1d750af9c83b4d45a:f70b31a2db15c023d641c32f433fb02cd04df5a6-0",
     "script": 'set -euo pipefail\nidx=$(find -L $BC_IN_INDEX -name "*.1.bt2*" | grep -v rev | head -n 1 | sed -E "s/\\.1\\.bt2l?$//")\n'
               '[ -n "$idx" ] || { echo "No Bowtie2 index (*.1.bt2) found in $BC_IN_INDEX" >&2; exit 1; }\nset -- $BC_IN_READS\n'
               'if [ $# -ge 2 ]; then reads="-1 $1 -2 $2"; else reads="-U $1"; fi\n'
               'bowtie2 -p "$BC_CPUS" -x "$idx" $reads $BC_PARAM_EXTRA_ARGS 2> "${BC_PREFIX}.bowtie2.log" | samtools sort -@ "$BC_CPUS" -o "${BC_PREFIX}.sorted.bam" -\n'
               'samtools index "${BC_PREFIX}.sorted.bam"\n'},
    {"id": "bam_filter", "kind": "module", "name": "Filter alignments", "category": "Alignment", "scope": "per_sample",
     "description": "Keep properly mapped reads above a MAPQ threshold; optionally remove duplicates (samtools).",
     "inputs": [{"name": "bam", "type": "bam"}], "outputs": [{"name": "bam", "type": "bam", "pattern": "{prefix}.filtered.bam"}],
     "params": [{"name": "min_mapq", "type": "integer", "default": 30, "minimum": 0, "maximum": 60},
                {"name": "remove_duplicates", "type": "boolean", "default": True}],
     "tools": ["samtools"], "cpus": 4, "memory_gb": 8, "language": "bash",
     "conda": "bioconda::samtools=1.21", "container": "quay.io/biocontainers/samtools:1.21--h50ea8bc_0",
     "script": 'set -euo pipefail\nsamtools view -@ "$BC_CPUS" -b -q "$BC_PARAM_MIN_MAPQ" -F 0x904 $BC_IN_BAM > tmp.q.bam\n'
               'if [ "$BC_PARAM_REMOVE_DUPLICATES" = "true" ]; then\n  samtools collate -@ "$BC_CPUS" -O -u tmp.q.bam | samtools fixmate -m -u - - | samtools sort -@ "$BC_CPUS" -u - | samtools markdup -r - "${BC_PREFIX}.filtered.bam"\n'
               'else\n  samtools sort -@ "$BC_CPUS" -o "${BC_PREFIX}.filtered.bam" tmp.q.bam\nfi\nrm -f tmp.q.bam\nsamtools index "${BC_PREFIX}.filtered.bam"\n'},
    {"id": "macs3", "kind": "module", "name": "MACS3 peak calling", "category": "Peak calling", "scope": "per_sample",
     "description": "Call narrow peaks with MACS3 (treatment only; add a control via extra args).",
     "inputs": [{"name": "bam", "type": "bam"}],
     "outputs": [{"name": "peaks", "type": "peaks", "pattern": "{prefix}_peaks.narrowPeak"}, {"name": "xls", "type": "qc", "pattern": "{prefix}_peaks.xls"}],
     "params": [{"name": "gsize", "type": "string", "default": "hs", "description": "Effective genome size (hs, mm, or a number)"},
                {"name": "qvalue", "type": "number", "default": 0.05, "minimum": 0, "maximum": 1},
                {"name": "format", "type": "string", "default": "BAM", "enum": ["BAM", "BAMPE"]}],
     "tools": ["macs3"], "cpus": 2, "memory_gb": 8, "language": "bash",
     "conda": "bioconda::macs3=3.0.2", "container": "quay.io/biocontainers/macs3:3.0.2--py311h0152c62_1",
     "script": 'set -euo pipefail\nmacs3 callpeak -t $BC_IN_BAM -f "$BC_PARAM_FORMAT" -g "$BC_PARAM_GSIZE" -q "$BC_PARAM_QVALUE" -n "$BC_PREFIX" --outdir .\n'},
    {"id": "bamcoverage", "kind": "module", "name": "Coverage track (deepTools)", "category": "Visualization", "scope": "per_sample",
     "description": "Normalized bigWig coverage with deepTools bamCoverage.",
     "inputs": [{"name": "bam", "type": "bam"}], "outputs": [{"name": "bigwig", "type": "bigwig", "pattern": "{prefix}.bw"}],
     "params": [{"name": "normalize", "type": "string", "default": "CPM", "enum": ["CPM", "RPKM", "BPM", "RPGC", "None"]},
                {"name": "bin_size", "type": "integer", "default": 10, "minimum": 1}],
     "tools": ["bamCoverage"], "cpus": 4, "memory_gb": 8, "language": "bash",
     "conda": "bioconda::deeptools=3.5.5", "container": "quay.io/biocontainers/deeptools:3.5.5--pyhdfd78af_0",
     "script": 'set -euo pipefail\nbamCoverage -b $BC_IN_BAM -o "${BC_PREFIX}.bw" -p "$BC_CPUS" --binSize "$BC_PARAM_BIN_SIZE" --normalizeUsing "$BC_PARAM_NORMALIZE"\n'},
    {"id": "featurecounts", "kind": "module", "name": "featureCounts", "category": "Quantification", "scope": "aggregate",
     "description": "Gene-level read counting for all samples (Subread featureCounts).",
     "inputs": [{"name": "bams", "type": "bam", "multiple": True}, {"name": "gtf", "type": "annotation"}],
     "outputs": [{"name": "counts", "type": "table", "pattern": "counts.txt"}, {"name": "summary", "type": "qc", "pattern": "counts.txt.summary"}],
     "params": [{"name": "strandedness", "type": "integer", "default": 0, "enum": [0, 1, 2]},
                {"name": "paired", "type": "boolean", "default": True}],
     "tools": ["featureCounts"], "cpus": 8, "memory_gb": 8, "language": "bash",
     "conda": "bioconda::subread=2.0.6", "container": "quay.io/biocontainers/subread:2.0.6--he4a0461_0",
     "script": 'set -euo pipefail\npe=""\n[ "$BC_PARAM_PAIRED" = "true" ] && pe="-p --countReadPairs"\nfeatureCounts -T "$BC_CPUS" -s "$BC_PARAM_STRANDEDNESS" $pe -a $BC_IN_GTF -o counts.txt $BC_IN_BAMS\n'},
    {"id": "multiqc", "kind": "module", "name": "MultiQC", "category": "Reporting", "scope": "aggregate",
     "description": "Aggregate QC from FastQC, fastp, Bowtie2, MACS3, featureCounts and more into one report.",
     "inputs": [{"name": "reports", "type": "any", "multiple": True}], "outputs": [{"name": "report", "type": "html", "pattern": "multiqc_report.html"}],
     "params": [{"name": "title", "type": "string", "default": "BioCompute MultiQC"}],
     "tools": ["multiqc"], "cpus": 1, "memory_gb": 4, "language": "bash",
     "conda": "bioconda::multiqc=1.25", "container": "quay.io/biocontainers/multiqc:1.25--pyhdfd78af_0",
     "script": 'set -euo pipefail\nmultiqc -f --title "$BC_PARAM_TITLE" -n multiqc_report.html $BC_IN_REPORTS\n'},
    # ---------------------------------------------------------------- custom code
    {"id": "custom_shell", "kind": "module", "name": "Custom command", "category": "Custom code", "scope": "per_sample", "custom": True,
     "description": "Your own bash commands. Inputs arrive as $BC_IN_IN, parameters as $BC_PARAM_*.",
     "inputs": [{"name": "in", "type": "any"}], "outputs": [{"name": "out", "type": "any", "pattern": "{prefix}.out.txt"}],
     "params": [], "tools": ["bash"], "cpus": 1, "memory_gb": 2, "language": "bash",
     "script": 'set -euo pipefail\n# Example: count lines of each input file\nfor f in $BC_IN_IN; do echo "$(basename $f) $(wc -l < $f)"; done > "${BC_PREFIX}.out.txt"\n'},
    {"id": "custom_python", "kind": "module", "name": "Custom Python", "category": "Custom code", "scope": "per_sample", "custom": True,
     "description": "A Python 3 script. Read inputs with os.environ['BC_IN_IN'].split().",
     "inputs": [{"name": "in", "type": "any"}], "outputs": [{"name": "out", "type": "table", "pattern": "{prefix}.py.tsv"}],
     "params": [], "tools": ["python3"], "cpus": 1, "memory_gb": 2, "language": "python",
     "script": '#!/usr/bin/env python3\nimport os\nprefix = os.environ["BC_PREFIX"]\nfiles = os.environ.get("BC_IN_IN", "").split()\n'
               'with open(f"{prefix}.py.tsv", "w") as out:\n    out.write("file\\tbytes\\n")\n    for f in files:\n        out.write(f"{os.path.basename(f)}\\t{os.path.getsize(f)}\\n")\n'},
    {"id": "custom_r", "kind": "module", "name": "Custom R", "category": "Custom code", "scope": "aggregate", "custom": True,
     "description": "An R script (Rscript). Inputs: strsplit(Sys.getenv('BC_IN_IN'), ' ')[[1]].",
     "inputs": [{"name": "in", "type": "table", "multiple": True}], "outputs": [{"name": "out", "type": "table", "pattern": "r_result.tsv"}],
     "params": [], "tools": ["Rscript"], "cpus": 1, "memory_gb": 4, "language": "r",
     "conda": "conda-forge::r-base=4.4",
     "script": 'files <- strsplit(Sys.getenv("BC_IN_IN"), " ")[[1]]\ntabs <- lapply(files, read.delim)\n'
               'res <- do.call(rbind, tabs)\nwrite.table(res, "r_result.tsv", sep = "\\t", quote = FALSE, row.names = FALSE)\n'},
]

MODULE_INDEX = {m["id"]: m for m in MODULES}
