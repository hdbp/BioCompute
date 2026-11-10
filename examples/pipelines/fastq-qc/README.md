# biocompute/fastq-qc

A small, portable Nextflow DSL2 pipeline used as BioCompute's reference end-to-end example.

* **Input**: an nf-core-style samplesheet (`sample,fastq_1,fastq_2,condition,replicate`).
* **Processes**: `FASTQ_STATS` (per sample: reads, bases, GC%, mean quality, %Q30, reads passing
  thresholds, and a 5,000-read sample for plotting) → `QC_REPORT` (all samples: `qc_summary.tsv`
  and a self-contained `qc_report.html` with a density-coloured GC-vs-quality scatter).
* **Software**: bash, awk, gzip, python3 — no containers required.

```bash
nextflow run . --input samplesheet.csv --outdir results
```

The same processes are described in `bcflow.json` so the BioCompute native engine can run the
pipeline on machines without Nextflow. Both engines execute the identical scripts in `bin/`.
