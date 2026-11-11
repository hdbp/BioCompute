# Data Explorer

**Data Explorer** (left menu) opens any file in the configured data folders, including run outputs.
Choose a data folder, or *Jump to a run's outputs*, then pick a file. The viewer depends on the file type.

| File | Viewer |
|---|---|
| TSV/CSV/TXT tables (also `.gz`), featureCounts, DESeq2/edgeR/limma results | Table: sort, filter, page, and plot columns |
| narrowPeak, broadPeak, BED, bedGraph, GTF/GFF, VCF | Table **and** *Add to genome browser* |
| BAM/CRAM, bigWig, bigBed | *Add to genome browser* (BAM/CRAM need their `.bai`/`.crai` next to them) |
| FASTA with `.fai` | *Use as genome* (any assembly, offline) |
| PDF, PNG/JPG/SVG | Shown in place (the browser's own PDF viewer) |
| HTML reports (MultiQC, Qualimap…) | Shown in a sandbox: scripts run, but the report cannot reach BioCompute or your session |
| Other text | First 64 kB |

## Plots

Any numeric column can be plotted as a **scatter** or a **histogram**. Each axis can be linear, `log10` or
`−log10`. Values ≤ 0 are left out of log axes, and the plot says how many were dropped.

* Scatter points are **coloured by local density** (viridis, log scale), with the densest points drawn last.
  This shows where thousands of overlapping points are. Hover over a point for its values. The caption gives
  n and Pearson r.
* The first plot is chosen for you: a volcano plot (log2FC vs −log10 padj) or an MA plot (log10 baseMean vs
  log2FC) for DE tables, and signal vs q-value for peaks.
* *Trim outliers* hides values outside the central 99% on each axis and reports how many were hidden.
* Tables with more than 500,000 rows load their first 500,000 rows. Plots thin evenly to 200,000 points;
  both limits are shown when they apply. `NA`, `.`, empty cells and similar values are treated as missing,
  not as text.

## Projects

Projects keep one study's data together. Choose **+ New project…** at the top of the Explorer's left pane.

* **Project folder:** a project can create its own folder in a writable data folder,
  `<folder>:projects/<name>/`, with `data/`, `results/` and `analyses/`.
* **Adding items:** add folders (*Add this folder*), files (*Add to project* on any file) and runs. A run
  launched with a project (Launch → Execution → *Project*) is listed there automatically, and its output folder
  defaults to the project's `results/`.
* **The project panel** lists everything, and each entry opens with one click. Removing an item, or deleting the
  project, never deletes files.
* **Sharing:** projects are private to you unless you share them with the lab (same rules as pipelines).

## Differential expression (volcano and MA plots)

A table with a log2 fold-change column and a p-value or adjusted p-value column opens in the
**Differential expression** view. This covers DESeq2 (`log2FoldChange`, `padj`, `baseMean`), edgeR (`logFC`,
`FDR`, `logCPM`), limma (`logFC`, `adj.P.Val`, `AveExpr`) and Seurat markers. Other column names can be picked
under *Columns*. *Table & plots* switches back to the generic table.

* **Cut-offs:** adjusted (or raw) p below, |log2 FC| at least, and optionally a minimum mean expression. Counts
  of up, down and not significant genes update as you type. Rows without a test result (`NA`) are counted
  separately.
* **Plots:**
  * **Volcano** plots log2 FC against −log10 p. **MA** plots log10 baseMean (or logCPM/AveExpr as they are)
    against log2 FC.
  * Dashed lines show the cut-offs.
  * Each group has its own hue (up red, down blue, not significant grey). Its shade shows how many genes overlap
    there, so dense regions stay readable.
* **Labels and search:** the top N significant genes are labelled, hovering shows a gene's values, and
  *Find a gene* rings it on the plot and finds it in the table. *PNG* downloads the plot.
* **Results table:** Significant / Up / Down / All, sorted by p.
* **Export:** **CSV/TSV** downloads every original column plus `regulation` for those genes.
* **Save into…** writes the same file into a project's `analyses/` folder (or any writable folder) with a
  `.params.json` next to it recording the cut-offs and counts. Saving into a project also lists the file there.

The statistics are the ones in your file. Nothing is recomputed; the cut-offs only select genes.

## Reference genomes

The *Reference genomes* tab lists the genomes of the controller's refgenie setup with their assets, tags, digests and
files. *Copy reference* gives a `refgenie://` reference for pipeline parameters; *Open in genome browser* loads the
genome's FASTA and GTF from the controller. See [reference-genomes.md](reference-genomes.md).

## Genome browser

The browser is [igv.js](https://github.com/igvteam/igv.js) 3.8. Tracks and genome are remembered in your
browser, so the view survives leaving the page.

* **Your files** are read from the controller with HTTP range requests, a few kilobytes at a time, so a
  multi-gigabyte BAM opens instantly. Requests carry your login. The files are never copied or uploaded anywhere.
* **Genomes:**
  * Built-in: hg38, T2T hs1, hg19, mm39, mm10, rn7, danRer11, dm6, ce11, sacCer3, galGal6, TAIR10. These come
    from igv.org's genome list.
  * **Other genome…** adds three more sources:
    * a FASTA plus `.fai` (and optionally a GTF/GFF) from your data folders, which works without internet;
    * any NCBI assembly by GenArk accession (`GCF_…`/`GCA_…`);
    * an assembly hub's `hub.txt`.
* **Public track hubs** lists the hubs registered with the UCSC Genome Browser (ENCODE, Roadmap, methylation,
  conservation and others), filtered to the current genome. You can also open any hub by its `hub.txt` URL.
  Opening a hub shows its tracks by group, and you pick the ones to add.
* **Track from URL** adds any public bigWig, bigBed, BAM, VCF and so on, for example from ENCODE or GEO.

### What goes over the network

* Built-in genomes, hubs and URL tracks are fetched **by your web browser** from their own servers (igv.org,
  UCSC, hub hosts). Some hub hosts do not allow browser access (CORS). The dialog then says the hub
  could not be read.
* The controller makes one outbound request: the list of public hubs, from
  `https://api.genome.ucsc.edu/list/publicHubs`, cached for 24 h. If it fails, the last good copy is used.
  Set `BIOCOMPUTE_EXPLORER_PUBLIC_HUBS_URL=` (empty) to turn it off. Hubs can still be opened by URL.
* Nothing from your data folders is ever sent out.

## API

`GET /api/explore/info`, `GET|HEAD /api/explore/raw` (byte ranges), `GET /api/explore/table`,
`GET /api/explore/columns`, `GET /api/explore/hubs`. All take data-root paths (`root:relative/path`) and refuse
anything outside the configured roots.
