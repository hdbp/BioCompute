# Pipeline Studio

Studio builds workflows from a palette of modules and compiles them into a pipeline folder containing:

* `main.nf`, a Nextflow DSL2 script with one process per module;
* `nextflow.config`, holding the params, the docker/apptainer/singularity/conda profiles and the manifest;
* `nextflow_schema.json`, a 2020-12 nf-schema: one group per module, plus reference files and I/O. The generated pipeline therefore gets a schema-driven form automatically;
* `assets/schema_input.json`, the samplesheet schema;
* `bcflow.json`, so the same graph runs on the BioCompute native engine;
* `bin/bc_<process>.{sh,py,R}`, the module scripts. Both engines execute these identical scripts.

*Publish* writes the folder to the managed pipeline store and registers it, adding a new version
each time you publish. *Export* downloads it as a zip.

## Supported graph subset

| Construct | Support |
|---|---|
| Samplesheet source: per-sample FASTQ reads | One per graph. Several rows of one sample are merged (`BC_MERGE_LANES`) |
| Parameter-file source (genome, index, GTF…) | Any number; becomes a required path parameter and a value channel |
| Per-sample module | One task per sample. Several per-sample inputs are joined on sample ID |
| Aggregate module | One task over all samples. Inputs are flattened and collected; `multiple` ports mix several branches |
| Aggregate output into a per-sample module | Broadcast as a value channel to every sample |
| Branches (fan-out) | Unrestricted |
| Cycles, conditional logic, `when:` clauses, channel operators beyond the above | Not supported |
| Importing an existing `.nf` file into a graph | Not supported. Arbitrary Nextflow cannot be round-tripped faithfully |

Validation rejects anything outside this subset before code is generated.

## Where the data comes from

The **Samplesheet reads** node (it can be renamed, e.g. "PRO-seq reads"; the node still shows the module name
underneath) declares that the pipeline takes per-sample FASTQ reads. The actual data is chosen **at launch**,
in step 2 (*Samples*):

* **Experiment:** samples with conditions, replicates and controls. BioCompute writes the samplesheet.
* **Samplesheet file:** a CSV/TSV with `sample, fastq_1, fastq_2` (and any columns the pipeline needs).
  File paths may be absolute or data-folder paths (`raw:run1/A_R1.fastq.gz`).
* **Folder of FASTQ files:** searched recursively. Samples, lanes and R1/R2 pairs are detected from the file names,
  and lanes are merged. Condition, replicate and control columns stay empty.

In Studio you can set a default samplesheet or FASTQ folder on the node (Inspector → *samplesheet* /
*fastq folder*). The node shows `data: …`, and the launch form is pre-filled with it. **Reference / parameter
file** nodes likewise take a *default path* (an index, a FASTA, a GTF). All paths must be inside a data folder
(Settings → Data folders), or a refgenie reference such as `refgenie://hg38/bowtie2_index.dir`
(DNA button next to the path; see [reference-genomes.md](reference-genomes.md)).

## Module contract

A module script reads everything from environment variables:

| Variable | Meaning |
|---|---|
| `BC_PREFIX` | Sample ID, or the module name for aggregate modules |
| `BC_CPUS` | CPUs granted to the task |
| `BC_IN_<PORT>` | Space-separated input paths |
| `BC_PARAM_<NAME>` | Parameter values |

Outputs are files matching the declared pattern; `{prefix}` expands to the sample ID. Custom bash,
Python and R modules use the same contract. Admins can disable custom code with
`BIOCOMPUTE_ALLOW_CUSTOM_CODE_MODULES=false`.

Bioinformatics modules declare a biocontainers image and a conda package. Run with `-profile apptainer`,
`docker` or `conda` to get the tools, or have them on PATH. Under the native engine, tools must be on PATH.

## Your own modules (installed software)

When you install new software (another peak caller, aligner or quantifier), make a module for it.
Click **Add software as a module** at the top of the module library.

* **Scan.** BioCompute looks on the controller's PATH for about 30 common programs. These include MACS2/3, Genrich,
  SEACR, HOMER, epic2, GoPeaks, BWA/BWA-MEM2, HISAT2, STAR, minimap2, Salmon, Trim Galore, cutadapt and Picard.
  Programs with a template open as a ready-made module for you to review. Any other program opens as a skeleton.
* **Find.** Type any command name, such as `LanceOtron` or `chromap`, to check whether it is installed.
* **Draft.** If the assistant is on, it writes the module from the program's own `--help` text.
* **Blank module** or **Import JSON** (a file exported from another BioCompute).

The module builder edits:

* the ports (types decide what the module can connect to);
* the parameters (they appear in the launch form);
* the programs the module needs;
* conda and container hints;
* CPUs and memory;
* the script (bash, Python or R).

As you type, the builder checks the definition: names, output patterns, `bash -n` / Python compile / R parse,
unused inputs or parameters, and whether the programs are on the controller's PATH. A missing program
is only a warning, because a conda or container profile may provide it.

User modules sit in the library with the built-in ones. Hover over one to **edit**, **export** (JSON) or **delete** it.
The id cannot change after creation, because saved workflows refer to it. A module that a saved workflow
still uses cannot be deleted. User modules are custom code: `BIOCOMPUTE_ALLOW_CUSTOM_CODE_MODULES=false`
disables creating and running them.

Modules run on whichever node executes the task. The program must be installed there too, or provided
by the module's conda package or container. BioCompute never installs software by itself.

## Assistant (Claude, ChatGPT or Claude Code)

Open **Assistant** in the Studio toolbar. An administrator turns it on in **Settings → AI assistant**:

| Provider | What it needs |
|---|---|
| Claude (Anthropic API) | An API key saved in Settings, or `ANTHROPIC_API_KEY` in the service environment. Default model `claude-opus-5-5`, effort `high` |
| ChatGPT (OpenAI API) | An API key saved in Settings, or `OPENAI_API_KEY`. Default model `gpt-5`; any model that supports structured outputs works |
| Claude Code on the controller | The `claude` command installed and signed in for the account that runs BioCompute. No key is stored |

Keys saved in Settings go to `$STATE_DIR/ai_secrets.json` (mode 0600). The UI never returns them; it shows only
the last four characters.

What it does:

* **Build** can also **create the modules it needs** (on by default). When the design needs software that has no
  module, the assistant drafts one module per program (from its `--help` text when it is installed on the
  controller). BioCompute checks each draft, saves the valid ones to your module library ("Drafted by the
  assistant"), and designs the pipeline again with them. Each module is one extra request. Review the new
  modules before relying on them.
* A **custom script** node can be turned into a reusable module with *Save as reusable module* in the Inspector.
* **Build.** It turns a description ("CUT&RUN, paired-end, IgG control…") into a graph that uses your module library,
  including your own modules. BioCompute's validator checks the graph. If the graph is invalid, the errors go back
  to the model for up to two repair rounds. The answer lists its assumptions (genome, layout, controls) and any
  software that has no module yet, with a button to draft one. You can also ask it to change the pipeline on the canvas.
* **Review.** It checks the pipeline on the canvas, with the scripts of the modules it uses and the validator's report.
  It checks that the pipeline will run and that the analysis makes sense: missing QC or filtering, risky parameters,
  missing controls, resources and reproducibility. Findings link to the nodes they concern.
* **Ask.** Free questions, answered with the current pipeline as context.
* **Draft module.** It writes a module definition from the program's `--help` output. The builder then opens with
  the draft and its caveats.

Nothing is lost if you leave without saving:

* Every answer (build, review, question, module draft) is stored on the controller. The assistant panel lists
  **Earlier builds / reviews / questions**, and clicking one reopens it. Builds are marked *saved* or *not saved*.
* An unsaved canvas is kept in your browser. Coming back to Studio offers **Restore** or **Discard**.
* After **Load into editor**, a **Save now** button appears. Saving links the answer to the new workflow.

Safeguards:

* Every answer is a typed JSON object (structured outputs) and is validated before use.
* Results only *propose* changes. They load into the editor (undo works), and nothing is saved, published or run
  without you.
* Only pipeline structure, module definitions, module scripts and tool help text are sent. Data, sample names and
  file paths are never sent.
* Each request is recorded in the audit log with the user, provider and model, plus the cost for Claude Code.
* For Claude models that support it, the API's server-side fallback is enabled (`fallbacks: "default"`). If a request
  is declined by the primary model's safety classifier, it is retried on a fallback model. Declines and truncated
  answers are reported as errors, never shown as results.

Cost: with an API key (Anthropic or OpenAI) each request is billed by the provider, and the cost is shown under
each answer. With **Claude Code signed in to a Claude subscription** nothing is charged per request; requests count
toward the plan's usage limits, and the panel says *included in your subscription*. Claude Code always reports an
API-price figure; BioCompute keeps it only as an estimate (in the tooltip), not as a cost. Settings shows how
Claude Code is signed in (`claude auth status`).
