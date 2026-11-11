# Reference genomes (refgenie)

BioCompute uses an existing [refgenie](https://refgenie.databio.org) setup **read-only**. It never pulls, builds,
tags or removes assets and never writes to your `genome_config.yaml`; keep managing genomes with refgenie itself.

## Finding the config

The first of these that exists is used (Settings → Controller → *Reference genomes* shows which):

1. The path saved in **Settings** (a `genome_config.yaml` or the genome folder that holds it).
2. `BIOCOMPUTE_REFGENIE_CONFIG` in the controller configuration. `install.sh` writes it from your shell's
   `$REFGENIE`, because the systemd service does not see your shell environment.
3. `$REFGENIE` in the controller's environment.
4. Common places: `~/.refgenie/genome_config.yaml`, `~/refgenie/…`, `~/refgenomes/…`, `/data/refgenie/…`, `/opt/refgenie/…`.

A path set explicitly (1 or 2) that does not exist is reported as an error rather than silently replaced by a guess.
Configs older than refgenie 0.10 must be upgraded with `refgenie upgrade` first; BioCompute does not upgrade them.

The genome folder is added as the read-only, non-restricted data folder **refgenie**, so assets can be browsed in
Data Explorer and picked in any file picker.

## References

A pipeline parameter can hold a reference instead of a path:

```
refgenie://<genome>/<asset>[.<seek_key>][:<tag>]

refgenie://hg38/fasta                 the FASTA (default tag)
refgenie://hg38/fasta.fai             a specific file of the asset
refgenie://hg38/bowtie2_index         the index prefix aligners expect (…/hg38)
refgenie://hg38/bowtie2_index.dir     the index folder (nf-core style parameters)
refgenie://hg38/star_index:2.7.11b    a specific tag
```

Genome aliases (`hg38`, `GRCh38`, …) and digests both work. References are resolved on the controller when a run
starts; an unknown genome, asset, tag or seek key, or an asset whose files are missing, stops the launch with a clear
error instead of starting a run that fails later. Each run writes `references.json` into its run folder, and its
provenance lists every reference with the resolved path, the genome digest and the asset digest, so the exact
reference used can be identified later even if the tag is moved.

## Where they appear

* **Launch form, step 3:** choose a genome (pre-selected from the experiment's genome) and *Fill reference parameters*.
  Parameters such as `fasta`, `gtf`, `bowtie2_index`, `star_index`, `salmon_index`, `blacklist`, `chrom_sizes` are
  matched to assets; folder parameters get `.dir`. Paths you typed are never replaced. For nf-core pipelines
  `igenomes_ignore` is turned on so iGenomes is not downloaded as well.
* **Any file or folder parameter:** the DNA button opens the asset picker (genome, asset, tag, file); the field then
  shows what the reference resolves to.
* **Experiments:** a *genome* field next to the assay.
* **Pipeline Studio:** the same picker on the *default path* of reference nodes. The assistant sees the available
  genomes and assets and uses `refgenie://` references only for assets that exist.
* **Data Explorer → Reference genomes:** every genome with its assets, tags, digests and seek keys; copy a reference,
  or open the genome (FASTA + GTF) in the genome browser, offline.

## Workers

References are resolved to paths on the controller. Runs sent to another computer need the same genome folder at the
same path there (for example a shared mount); this is not checked yet.
