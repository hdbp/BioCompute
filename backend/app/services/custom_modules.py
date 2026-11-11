"""User-defined Pipeline Studio modules: wrap software installed on the controller/workers.

* ModuleDef is the single definition format (API, JSON export/import and AI drafts).
* `scan_tools()` looks for known bioinformatics executables on the controller's PATH;
  `TEMPLATES` turns many of them into a ready-to-review module.
* `check_module()` validates a definition: schema, port/param names, script syntax
  (bash -n / Python compile / R parse) and whether the required tools are installed.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from ..models import CustomModule
from .studio_modules import MODULE_INDEX, PORT_TYPES

NAME = r"^[a-z][a-z0-9_]{0,39}$"
PortType = Literal[tuple(PORT_TYPES)]  # type: ignore[valid-type]


class InPort(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(pattern=NAME)
    type: PortType = "any"  # type: ignore[valid-type]
    multiple: bool = False


class OutPort(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(pattern=NAME)
    type: PortType = "any"  # type: ignore[valid-type]
    pattern: str = Field(min_length=1, max_length=200)


class Param(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(pattern=NAME)
    type: Literal["string", "integer", "number", "boolean"] = "string"
    default: str | int | float | bool | None = None
    enum: list[str | int | float] | None = None
    description: str = ""


class ModuleDef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,40}$")
    name: str = Field(min_length=1, max_length=80)
    category: str = "My modules"
    description: str = ""
    scope: Literal["per_sample", "aggregate"] = "per_sample"
    language: Literal["bash", "python", "r"] = "bash"
    inputs: list[InPort] = Field(min_length=1)
    outputs: list[OutPort] = Field(min_length=1)
    params: list[Param] = []
    tools: list[str] = []
    conda: str = ""
    container: str = ""
    cpus: int = Field(default=1, ge=1, le=256)
    memory_gb: float = Field(default=2, gt=0, le=4096)
    script: str = Field(min_length=1, max_length=50_000)


def to_index_entry(d: ModuleDef) -> dict[str, Any]:
    e = d.model_dump()
    e.update(kind="module", user=True)
    if not e["conda"]:
        e.pop("conda")
    if not e["container"]:
        e.pop("container")
    return e


def index(db: Session) -> dict[str, dict[str, Any]]:
    """Built-in modules plus the user's own (used by validate/compile/publish)."""
    merged = dict(MODULE_INDEX)
    for m in db.query(CustomModule).all():
        try:
            merged[m.id] = to_index_entry(ModuleDef.model_validate(m.definition))
        except ValidationError:
            continue  # a definition that no longer validates is skipped (shown as an error when edited)
    return merged


# --------------------------------------------------------------------------- installed tools
TOOL_CATALOG: list[dict[str, Any]] = [
    # peak callers
    {"exe": "macs3", "name": "MACS3", "category": "Peak calling", "version": ["--version"]},
    {"exe": "macs2", "name": "MACS2", "category": "Peak calling", "version": ["--version"], "template": "macs2"},
    {"exe": "Genrich", "name": "Genrich", "category": "Peak calling", "version": ["--version"], "template": "genrich"},
    {"exe": "SEACR_1.3.sh", "name": "SEACR", "category": "Peak calling", "version": None, "template": "seacr"},
    {"exe": "findPeaks", "name": "HOMER findPeaks", "category": "Peak calling", "version": None, "template": "homer_findpeaks"},
    {"exe": "epic2", "name": "epic2", "category": "Peak calling", "version": ["--version"], "template": "epic2"},
    {"exe": "gopeaks", "name": "GoPeaks", "category": "Peak calling", "version": ["--version"], "template": "gopeaks"},
    {"exe": "hmmratac", "name": "HMMRATAC", "category": "Peak calling", "version": None},
    # aligners / quantifiers
    {"exe": "bowtie2", "name": "Bowtie2", "category": "Alignment", "version": ["--version"]},
    {"exe": "bwa", "name": "BWA", "category": "Alignment", "version": None, "template": "bwa_mem"},
    {"exe": "bwa-mem2", "name": "BWA-MEM2", "category": "Alignment", "version": ["version"], "template": "bwa_mem2"},
    {"exe": "hisat2", "name": "HISAT2", "category": "Alignment", "version": ["--version"], "template": "hisat2"},
    {"exe": "STAR", "name": "STAR", "category": "Alignment", "version": ["--version"], "template": "star"},
    {"exe": "minimap2", "name": "minimap2", "category": "Alignment", "version": ["--version"], "template": "minimap2"},
    {"exe": "salmon", "name": "Salmon", "category": "Quantification", "version": ["--version"], "template": "salmon"},
    {"exe": "kallisto", "name": "kallisto", "category": "Quantification", "version": ["version"]},
    {"exe": "featureCounts", "name": "featureCounts", "category": "Quantification", "version": ["-v"]},
    {"exe": "htseq-count", "name": "HTSeq", "category": "Quantification", "version": ["--version"]},
    # preprocessing / QC / utilities
    {"exe": "fastqc", "name": "FastQC", "category": "Quality control", "version": ["--version"]},
    {"exe": "fastp", "name": "fastp", "category": "Preprocessing", "version": ["--version"]},
    {"exe": "trim_galore", "name": "Trim Galore", "category": "Preprocessing", "version": ["--version"], "template": "trim_galore"},
    {"exe": "cutadapt", "name": "cutadapt", "category": "Preprocessing", "version": ["--version"], "template": "cutadapt"},
    {"exe": "multiqc", "name": "MultiQC", "category": "Reporting", "version": ["--version"]},
    {"exe": "samtools", "name": "samtools", "category": "Utilities", "version": ["--version"]},
    {"exe": "bedtools", "name": "bedtools", "category": "Utilities", "version": ["--version"]},
    {"exe": "picard", "name": "Picard", "category": "Utilities", "version": None, "template": "picard_markdup"},
    {"exe": "bamCoverage", "name": "deepTools", "category": "Visualization", "version": ["--version"]},
    {"exe": "Rscript", "name": "R", "category": "Statistics", "version": ["--version"]},
    {"exe": "python3", "name": "Python 3", "category": "Statistics", "version": ["--version"]},
    {"exe": "nextflow", "name": "Nextflow", "category": "Workflow", "version": ["-version"]},
]


def _probe(entry: dict[str, Any]) -> dict[str, Any] | None:
    path = shutil.which(entry["exe"])
    if not path:
        return None
    version = None
    if entry.get("version"):
        try:
            p = subprocess.run([path, *entry["version"]], capture_output=True, text=True, timeout=8)
            m = re.search(r"\d+\.\d+(?:\.\d+)?[\w.-]*", (p.stdout or "") + (p.stderr or ""))
            version = m.group(0) if m else None
        except (OSError, subprocess.TimeoutExpired):
            pass
    builtin = any(entry["exe"] in (m.get("tools") or []) for m in MODULE_INDEX.values())
    return {**{k: entry.get(k) for k in ("exe", "name", "category", "template")}, "path": path, "version": version,
            "has_builtin_module": builtin}


def scan_tools() -> list[dict[str, Any]]:
    with ThreadPoolExecutor(max_workers=8) as pool:
        return [r for r in pool.map(_probe, TOOL_CATALOG) if r]


def check_tool(name: str) -> dict[str, Any]:
    if not re.fullmatch(r"[\w.+-]{1,64}", name):
        raise HTTPException(400, "Invalid program name")
    path = shutil.which(name)
    if not path:
        return {"exe": name, "found": False}
    out = ""
    for args in (["--version"], ["-version"], ["version"]):
        try:
            p = subprocess.run([path, *args], capture_output=True, text=True, timeout=5)
            out = ((p.stdout or "") + (p.stderr or "")).strip()
            if out and p.returncode == 0:
                break
        except (OSError, subprocess.TimeoutExpired):
            continue
    m = re.search(r"\d+\.\d+(?:\.\d+)?[\w.-]*", out)
    return {"exe": name, "found": True, "path": path, "version": m.group(0) if m else None}


def tool_help(name: str, limit: int = 6000) -> str | None:
    """`<tool> --help` text, used to ground AI-drafted modules in the real options."""
    if not re.fullmatch(r"[\w.+-]{1,64}", name) or not shutil.which(name):
        return None
    for args in (["--help"], ["-h"], []):
        try:
            p = subprocess.run([shutil.which(name), *args], capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired):
            continue
        text = ((p.stdout or "") + (p.stderr or "")).strip()
        if len(text) > 80:
            return text[:limit]
    return None


# --------------------------------------------------------------------------- templates
_ALIGN_PE = 'set -- $BC_IN_READS\nif [ $# -ge 2 ]; then R1="$1"; R2="$2"; else R1="$1"; R2=""; fi\n'
TEMPLATES: dict[str, dict[str, Any]] = {
    "genrich": {"name": "Genrich peaks", "category": "Peak calling", "tools": ["Genrich", "samtools"],
                "description": "Peak calling with Genrich (ChIP-seq or ATAC-seq mode). Input BAM is name-sorted automatically.",
                "inputs": [{"name": "bam", "type": "bam"}], "outputs": [{"name": "peaks", "type": "peaks", "pattern": "{prefix}.genrich.narrowPeak"}],
                "params": [{"name": "atac_mode", "type": "boolean", "default": False, "description": "ATAC-seq mode (-j)"},
                           {"name": "remove_duplicates", "type": "boolean", "default": True, "description": "Remove PCR duplicates (-r)"},
                           {"name": "qvalue", "type": "number", "default": 0.05, "description": "Maximum q-value (-q)"}],
                "cpus": 2, "memory_gb": 8, "conda": "bioconda::genrich=0.6.1 bioconda::samtools=1.21",
                "script": 'set -euo pipefail\nsamtools sort -n -@ "$BC_CPUS" -o name_sorted.bam $BC_IN_BAM\nflags="-q $BC_PARAM_QVALUE"\n'
                          '[ "$BC_PARAM_ATAC_MODE" = "true" ] && flags="$flags -j"\n[ "$BC_PARAM_REMOVE_DUPLICATES" = "true" ] && flags="$flags -r"\n'
                          'Genrich -t name_sorted.bam -o "${BC_PREFIX}.genrich.narrowPeak" $flags\n'},
    "seacr": {"name": "SEACR peaks", "category": "Peak calling", "tools": ["SEACR_1.3.sh", "bedtools", "Rscript"],
              "description": "CUT&RUN / CUT&Tag peak calling with SEACR on a bedGraph made from the BAM.",
              "inputs": [{"name": "bam", "type": "bam"}], "outputs": [{"name": "peaks", "type": "peaks", "pattern": "{prefix}.*.bed"}],
              "params": [{"name": "threshold", "type": "number", "default": 0.01, "description": "Top fraction of signal blocks (no IgG control)"},
                         {"name": "mode", "type": "string", "default": "stringent", "enum": ["stringent", "relaxed"]},
                         {"name": "normalize", "type": "string", "default": "non", "enum": ["non", "norm"]}],
              "cpus": 1, "memory_gb": 4, "conda": "bioconda::seacr=1.3 bioconda::bedtools=2.31.1",
              "script": 'set -euo pipefail\nbedtools genomecov -bg -ibam $BC_IN_BAM > "${BC_PREFIX}.bedgraph"\n'
                        'SEACR_1.3.sh "${BC_PREFIX}.bedgraph" "$BC_PARAM_THRESHOLD" "$BC_PARAM_NORMALIZE" "$BC_PARAM_MODE" "$BC_PREFIX"\n'},
    "homer_findpeaks": {"name": "HOMER findPeaks", "category": "Peak calling", "tools": ["makeTagDirectory", "findPeaks"],
                        "description": "Peak calling with HOMER (factor or histone style).",
                        "inputs": [{"name": "bam", "type": "bam"}], "outputs": [{"name": "peaks", "type": "peaks", "pattern": "{prefix}.homer_peaks.txt"}],
                        "params": [{"name": "style", "type": "string", "default": "factor", "enum": ["factor", "histone"]}],
                        "cpus": 1, "memory_gb": 8, "conda": "bioconda::homer=4.11",
                        "script": 'set -euo pipefail\nmakeTagDirectory tags $BC_IN_BAM\nfindPeaks tags -style "$BC_PARAM_STYLE" -o "${BC_PREFIX}.homer_peaks.txt"\n'},
    "epic2": {"name": "epic2 broad peaks", "category": "Peak calling", "tools": ["epic2"],
              "description": "Broad histone-mark domains with epic2 (SICER algorithm).",
              "inputs": [{"name": "bam", "type": "bam"}], "outputs": [{"name": "peaks", "type": "peaks", "pattern": "{prefix}.epic2.bed"}],
              "params": [{"name": "genome", "type": "string", "default": "hg38", "description": "Genome assembly name known to epic2"},
                         {"name": "fdr", "type": "number", "default": 0.05}],
              "cpus": 1, "memory_gb": 8, "conda": "bioconda::epic2=0.0.52",
              "script": 'set -euo pipefail\nepic2 -t $BC_IN_BAM -gn "$BC_PARAM_GENOME" -fdr "$BC_PARAM_FDR" -o "${BC_PREFIX}.epic2.bed"\n'},
    "gopeaks": {"name": "GoPeaks", "category": "Peak calling", "tools": ["gopeaks"],
                "description": "CUT&Tag peak calling with GoPeaks.",
                "inputs": [{"name": "bam", "type": "bam"}], "outputs": [{"name": "peaks", "type": "peaks", "pattern": "{prefix}_peaks.bed"}],
                "params": [{"name": "broad", "type": "boolean", "default": False}], "cpus": 1, "memory_gb": 4,
                "conda": "bioconda::gopeaks=1.0.0",
                "script": 'set -euo pipefail\nextra=""\n[ "$BC_PARAM_BROAD" = "true" ] && extra="--broad"\ngopeaks -b $BC_IN_BAM -o "$BC_PREFIX" $extra\n'},
    "macs2": {"name": "MACS2 peaks", "category": "Peak calling", "tools": ["macs2"],
              "description": "Narrow peaks with MACS2.",
              "inputs": [{"name": "bam", "type": "bam"}], "outputs": [{"name": "peaks", "type": "peaks", "pattern": "{prefix}_peaks.narrowPeak"}],
              "params": [{"name": "gsize", "type": "string", "default": "hs"}, {"name": "qvalue", "type": "number", "default": 0.05},
                         {"name": "format", "type": "string", "default": "BAM", "enum": ["BAM", "BAMPE"]}],
              "cpus": 1, "memory_gb": 8, "conda": "bioconda::macs2=2.2.9.1",
              "script": 'set -euo pipefail\nmacs2 callpeak -t $BC_IN_BAM -f "$BC_PARAM_FORMAT" -g "$BC_PARAM_GSIZE" -q "$BC_PARAM_QVALUE" -n "$BC_PREFIX" --outdir .\n'},
    "bwa_mem": {"name": "BWA-MEM alignment", "category": "Alignment", "tools": ["bwa", "samtools"],
                "description": "Align reads with bwa mem and coordinate-sort.",
                "inputs": [{"name": "reads", "type": "fastq"}, {"name": "index", "type": "index"}],
                "outputs": [{"name": "bam", "type": "bam", "pattern": "{prefix}.sorted.bam"}], "params": [], "cpus": 8, "memory_gb": 16,
                "conda": "bioconda::bwa=0.7.18 bioconda::samtools=1.21",
                "script": 'set -euo pipefail\n' + _ALIGN_PE + 'idx=$(find -L $BC_IN_INDEX -name "*.bwt" | head -n 1 | sed "s/\\.bwt$//")\n'
                          'bwa mem -t "$BC_CPUS" -R "@RG\\tID:${BC_PREFIX}\\tSM:${BC_PREFIX}" "$idx" $R1 $R2 | samtools sort -@ "$BC_CPUS" -o "${BC_PREFIX}.sorted.bam" -\n'
                          'samtools index "${BC_PREFIX}.sorted.bam"\n'},
    "bwa_mem2": {"name": "BWA-MEM2 alignment", "category": "Alignment", "tools": ["bwa-mem2", "samtools"],
                 "description": "Align reads with bwa-mem2 and coordinate-sort.",
                 "inputs": [{"name": "reads", "type": "fastq"}, {"name": "index", "type": "index"}],
                 "outputs": [{"name": "bam", "type": "bam", "pattern": "{prefix}.sorted.bam"}], "params": [], "cpus": 8, "memory_gb": 32,
                 "conda": "bioconda::bwa-mem2=2.2.1 bioconda::samtools=1.21",
                 "script": 'set -euo pipefail\n' + _ALIGN_PE + 'idx=$(find -L $BC_IN_INDEX -name "*.bwt.2bit.64" | head -n 1 | sed "s/\\.bwt\\.2bit\\.64$//")\n'
                           'bwa-mem2 mem -t "$BC_CPUS" "$idx" $R1 $R2 | samtools sort -@ "$BC_CPUS" -o "${BC_PREFIX}.sorted.bam" -\n'
                           'samtools index "${BC_PREFIX}.sorted.bam"\n'},
    "hisat2": {"name": "HISAT2 alignment", "category": "Alignment", "tools": ["hisat2", "samtools"],
               "description": "Spliced RNA-seq alignment with HISAT2.",
               "inputs": [{"name": "reads", "type": "fastq"}, {"name": "index", "type": "index"}],
               "outputs": [{"name": "bam", "type": "bam", "pattern": "{prefix}.sorted.bam"}, {"name": "log", "type": "qc", "pattern": "{prefix}.hisat2.log"}],
               "params": [{"name": "strandedness", "type": "string", "default": "", "enum": ["", "FR", "RF", "F", "R"]}],
               "cpus": 8, "memory_gb": 16, "conda": "bioconda::hisat2=2.2.1 bioconda::samtools=1.21",
               "script": 'set -euo pipefail\n' + _ALIGN_PE + 'idx=$(find -L $BC_IN_INDEX -name "*.1.ht2*" | head -n 1 | sed -E "s/\\.1\\.ht2l?$//")\n'
                         'strand=""\n[ -n "$BC_PARAM_STRANDEDNESS" ] && strand="--rna-strandness $BC_PARAM_STRANDEDNESS"\n'
                         'if [ -n "$R2" ]; then in="-1 $R1 -2 $R2"; else in="-U $R1"; fi\n'
                         'hisat2 -p "$BC_CPUS" -x "$idx" $in $strand 2> "${BC_PREFIX}.hisat2.log" | samtools sort -@ "$BC_CPUS" -o "${BC_PREFIX}.sorted.bam" -\n'
                         'samtools index "${BC_PREFIX}.sorted.bam"\n'},
    "star": {"name": "STAR alignment", "category": "Alignment", "tools": ["STAR", "samtools"],
             "description": "Spliced RNA-seq alignment with STAR (index directory as input).",
             "inputs": [{"name": "reads", "type": "fastq"}, {"name": "index", "type": "index"}],
             "outputs": [{"name": "bam", "type": "bam", "pattern": "{prefix}.Aligned.sortedByCoord.out.bam"},
                         {"name": "log", "type": "qc", "pattern": "{prefix}.Log.final.out"}],
             "params": [], "cpus": 12, "memory_gb": 40, "conda": "bioconda::star=2.7.11b bioconda::samtools=1.21",
             "script": 'set -euo pipefail\nset -- $BC_IN_READS\ncase "$1" in *.gz) rc="--readFilesCommand zcat";; *) rc="";; esac\n'
                       'STAR --runThreadN "$BC_CPUS" --genomeDir $BC_IN_INDEX --readFilesIn "$@" $rc --outSAMtype BAM SortedByCoordinate '
                       '--outFileNamePrefix "${BC_PREFIX}."\nsamtools index "${BC_PREFIX}.Aligned.sortedByCoord.out.bam"\n'},
    "minimap2": {"name": "minimap2 alignment", "category": "Alignment", "tools": ["minimap2", "samtools"],
                 "description": "Long- or short-read alignment with minimap2 against a FASTA reference.",
                 "inputs": [{"name": "reads", "type": "fastq"}, {"name": "reference", "type": "fasta"}],
                 "outputs": [{"name": "bam", "type": "bam", "pattern": "{prefix}.sorted.bam"}],
                 "params": [{"name": "preset", "type": "string", "default": "sr", "enum": ["sr", "map-ont", "map-pb", "map-hifi", "splice"]}],
                 "cpus": 8, "memory_gb": 16, "conda": "bioconda::minimap2=2.28 bioconda::samtools=1.21",
                 "script": 'set -euo pipefail\nminimap2 -t "$BC_CPUS" -ax "$BC_PARAM_PRESET" $BC_IN_REFERENCE $BC_IN_READS | samtools sort -@ "$BC_CPUS" -o "${BC_PREFIX}.sorted.bam" -\n'
                           'samtools index "${BC_PREFIX}.sorted.bam"\n'},
    "salmon": {"name": "Salmon quantification", "category": "Quantification", "tools": ["salmon"],
               "description": "Transcript quantification with Salmon (selective alignment index as input).",
               "inputs": [{"name": "reads", "type": "fastq"}, {"name": "index", "type": "index"}],
               "outputs": [{"name": "quant", "type": "table", "pattern": "{prefix}.quant.sf"}],
               "params": [{"name": "libtype", "type": "string", "default": "A", "description": "Library type (A = automatic)"}],
               "cpus": 8, "memory_gb": 16, "conda": "bioconda::salmon=1.10.3",
               "script": 'set -euo pipefail\n' + _ALIGN_PE + 'if [ -n "$R2" ]; then in="-1 $R1 -2 $R2"; else in="-r $R1"; fi\n'
                         'salmon quant -i $BC_IN_INDEX -l "$BC_PARAM_LIBTYPE" $in -p "$BC_CPUS" --validateMappings -o salmon_out\n'
                         'cp salmon_out/quant.sf "${BC_PREFIX}.quant.sf"\n'},
    "trim_galore": {"name": "Trim Galore", "category": "Preprocessing", "tools": ["trim_galore", "cutadapt"],
                    "description": "Adapter/quality trimming with Trim Galore (auto-detects paired-end).",
                    "inputs": [{"name": "reads", "type": "fastq"}],
                    "outputs": [{"name": "reads", "type": "fastq", "pattern": "{prefix}*_val_*.fq.gz"},
                                {"name": "report", "type": "qc", "pattern": "*trimming_report.txt"}],
                    "params": [{"name": "quality", "type": "integer", "default": 20}], "cpus": 4, "memory_gb": 4,
                    "conda": "bioconda::trim-galore=0.6.10",
                    "script": 'set -euo pipefail\nset -- $BC_IN_READS\npe=""\n[ $# -ge 2 ] && pe="--paired"\n'
                              'trim_galore --cores "$BC_CPUS" -q "$BC_PARAM_QUALITY" --basename "$BC_PREFIX" --gzip $pe "$@"\n'
                              '[ $# -ge 2 ] || mv "${BC_PREFIX}_trimmed.fq.gz" "${BC_PREFIX}_val_1.fq.gz"\n'},
    "cutadapt": {"name": "cutadapt", "category": "Preprocessing", "tools": ["cutadapt"],
                 "description": "Remove a given 3' adapter with cutadapt.",
                 "inputs": [{"name": "reads", "type": "fastq"}], "outputs": [{"name": "reads", "type": "fastq", "pattern": "{prefix}_trimmed_R*.fastq.gz"}],
                 "params": [{"name": "adapter", "type": "string", "default": "AGATCGGAAGAGC"},
                            {"name": "min_length", "type": "integer", "default": 20}], "cpus": 4, "memory_gb": 2,
                 "conda": "bioconda::cutadapt=4.9",
                 "script": 'set -euo pipefail\nset -- $BC_IN_READS\nif [ $# -ge 2 ]; then\n'
                           '  cutadapt -j "$BC_CPUS" -a "$BC_PARAM_ADAPTER" -A "$BC_PARAM_ADAPTER" -m "$BC_PARAM_MIN_LENGTH" -o "${BC_PREFIX}_trimmed_R1.fastq.gz" -p "${BC_PREFIX}_trimmed_R2.fastq.gz" "$1" "$2"\n'
                           'else\n  cutadapt -j "$BC_CPUS" -a "$BC_PARAM_ADAPTER" -m "$BC_PARAM_MIN_LENGTH" -o "${BC_PREFIX}_trimmed_R1.fastq.gz" "$1"\nfi\n'},
    "picard_markdup": {"name": "Picard MarkDuplicates", "category": "Alignment", "tools": ["picard"],
                       "description": "Mark (or remove) PCR duplicates with Picard.",
                       "inputs": [{"name": "bam", "type": "bam"}],
                       "outputs": [{"name": "bam", "type": "bam", "pattern": "{prefix}.markdup.bam"},
                                   {"name": "metrics", "type": "qc", "pattern": "{prefix}.markdup.metrics.txt"}],
                       "params": [{"name": "remove_duplicates", "type": "boolean", "default": False}], "cpus": 2, "memory_gb": 8,
                       "conda": "bioconda::picard=3.2.0",
                       "script": 'set -euo pipefail\npicard MarkDuplicates I=$BC_IN_BAM O="${BC_PREFIX}.markdup.bam" M="${BC_PREFIX}.markdup.metrics.txt" '
                                 'REMOVE_DUPLICATES="$BC_PARAM_REMOVE_DUPLICATES" CREATE_INDEX=true\n'},
}


def template(key: str) -> dict[str, Any]:
    t = TEMPLATES.get(key)
    if not t:
        raise HTTPException(404, "Unknown template")
    return {"id": f"u_{key}", "scope": "per_sample", "language": "bash", **t}


def skeleton(exe: str) -> dict[str, Any]:
    """Generic starting point for a tool without a template."""
    slug = re.sub(r"[^a-z0-9]+", "_", exe.lower()).strip("_") or "tool"
    return {"id": f"u_{slug}"[:40], "name": exe, "category": "My modules", "description": f"Runs {exe}.",
            "scope": "per_sample", "language": "bash", "inputs": [{"name": "input", "type": "any"}],
            "outputs": [{"name": "output", "type": "any", "pattern": "{prefix}.out"}], "params": [], "tools": [exe],
            "cpus": 1, "memory_gb": 2,
            "script": f'set -euo pipefail\n# Inputs: $BC_IN_INPUT (space-separated paths); threads: $BC_CPUS; sample: $BC_PREFIX\n'
                      f'{exe} $BC_IN_INPUT > "${{BC_PREFIX}}.out"\n'}


# --------------------------------------------------------------------------- validation
def _syntax(language: str, script: str) -> str | None:
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "script"
        f.write_text(script)
        if language == "bash":
            exe = shutil.which("bash")
            if not exe:
                return None
            p = subprocess.run([exe, "-n", str(f)], capture_output=True, text=True, timeout=10)
            return (p.stderr or "").replace(str(f), "script").strip() or None if p.returncode else None
        if language == "python":
            try:
                compile(script, "script.py", "exec")
            except SyntaxError as exc:
                return f"line {exc.lineno}: {exc.msg}"
            return None
        if language == "r":
            exe = shutil.which("Rscript")
            if not exe:
                return None
            p = subprocess.run([exe, "-e", f"invisible(parse(file='{f}'))"], capture_output=True, text=True, timeout=20)
            return (p.stderr or "").strip()[-500:] or None if p.returncode else None
    return None


def check_module(raw: dict[str, Any], *, existing_id: str | None = None, db: Session | None = None) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    try:
        d = ModuleDef.model_validate(raw)
    except ValidationError as exc:
        for e in exc.errors():
            issues.append({"level": "error", "field": ".".join(str(x) for x in e["loc"]), "message": e["msg"]})
        return {"valid": False, "issues": issues, "module": None}
    if d.id in MODULE_INDEX:
        issues.append({"level": "error", "field": "id", "message": "This id belongs to a built-in module; choose another"})
    if db is not None and d.id != existing_id and db.get(CustomModule, d.id):
        issues.append({"level": "error", "field": "id", "message": "A module with this id already exists"})
    for group in ("inputs", "outputs", "params"):
        names = [x.name for x in getattr(d, group)]
        if len(names) != len(set(names)):
            issues.append({"level": "error", "field": group, "message": f"Duplicate {group[:-1]} names"})
    for o in d.outputs:
        if "/" in o.pattern or ".." in o.pattern:
            issues.append({"level": "error", "field": "outputs", "message": f"Output pattern '{o.pattern}' must be a file name pattern"})
        if d.scope == "per_sample" and "{prefix}" not in o.pattern and not any(c in o.pattern for c in "*?"):
            issues.append({"level": "warning", "field": "outputs",
                           "message": f"'{o.pattern}' has no {{prefix}}: every sample writes the same file name"})
    script_vars = set(re.findall(r"BC_(?:IN|PARAM)_([A-Z0-9_]+)", d.script))
    for x in d.inputs:
        if x.name.upper() not in script_vars:
            issues.append({"level": "warning", "field": "script", "message": f"Script never uses input '{x.name}' ($BC_IN_{x.name.upper()})"})
    for x in d.params:
        if x.name.upper() not in script_vars:
            issues.append({"level": "warning", "field": "script", "message": f"Script never uses parameter '{x.name}' ($BC_PARAM_{x.name.upper()})"})
    err = _syntax(d.language, d.script)
    if err:
        issues.append({"level": "error", "field": "script", "message": f"Syntax error: {err}"})
    missing = [t for t in d.tools if not shutil.which(t)]
    if missing:
        issues.append({"level": "warning", "field": "tools",
                       "message": f"Not found on the controller: {', '.join(missing)} (fine if a conda/container profile provides it)"})
    return {"valid": not any(i["level"] == "error" for i in issues), "issues": issues, "module": d.model_dump()}
