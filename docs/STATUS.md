# Implementation status

Each item is marked:

- **Demonstrated**: it ran for real in the development environment, through the automated tests or in a browser walkthrough.
- **Implemented**: the code exists and has unit or API tests, but needs infrastructure that wasn't available here.
- **Planned**: not built yet.

## Development environment limits

These limits apply to everything below.

- **Nextflow could not be run here.** Installing the bioconda Nextflow distribution was blocked by the environment's
  permission policy. As a result:
  - The bundled pipeline and the Studio pipelines were *executed* only with the native `bcflow` engine.
  - The Nextflow adapter's generated command line and config are covered by unit tests.
  - The generated DSL2 has not been run by Nextflow in this environment.
- **HTCondor, Tailscale and extra machines were not available.**
  - Discovery providers for these degrade gracefully and report "not available".
  - Multi-node execution is untested.

## Milestone 1: working application

| Feature | Status | Evidence |
|---|---|---|
| Web UI: dashboard, navigation, dark and light themes | Demonstrated | Browser walkthrough with Playwright screenshots |
| Login, roles, audit log | Demonstrated | `tests/test_security.py` |
| PostgreSQL persistence and Alembic migrations | Demonstrated | Migration applied to PostgreSQL 16; app ran against it |
| Restart without losing configuration | Demonstrated | Restarted the controller; presets, experiments and runs persisted |
| Pipeline library: installed vs catalog templates, search, filters, favorites | Demonstrated | UI + API tests |
| Import from Git, with a pinned version | Demonstrated | Real `nf-core/chipseq` at tag 2.1.0 cloned and registered |
| Import from a local folder, duplicate, version pinning | Demonstrated | `test_end_to_end.py` |
| Schema-driven forms: nf-core draft-07 and 2020-12 schemas | Demonstrated | Real nf-core chipseq (82 parameters) and rnaseq schemas |
| Parameter presets, compare, export JSON/YAML, restore defaults | Demonstrated | UI + API tests |
| Generic parameter editor and schema-authoring wizard | Demonstrated | `test_duplicate_and_schema_wizard` |
| Data-root browser with path-traversal and symlink protection | Demonstrated | `test_path_traversal_blocked` |
| Experiments: spreadsheet editor, FASTQ pair and lane detection, CSV/TSV import, validation | Demonstrated | Fork browser test + API tests |
| Samplesheet generation from the pipeline's `schema_input.json` (lanes become rows) | Demonstrated | `test_samplesheet_generation_expands_lanes` |
| Proteomics metadata model with OpenMS/quantms experimental-design TSV | Implemented | Code path exists; no proteomics pipeline was run |
| Launch with preflight checks, detached execution, live logs (SSE), per-process progress | Demonstrated | Browser walkthrough; native engine run of the bundled pipeline |
| Cancel, resume (cached tasks reused), "lost" detection, re-attach after restart | Demonstrated | Tests, plus a manual controller restart during a run |
| Provenance: params, inputs (size and mtime), versions, host, outputs | Demonstrated | `biocompute_provenance.json` written next to outputs |
| Results browser with HTML report, table and text preview | Demonstrated | Browser walkthrough |
| Nextflow execution (`nextflow run` with params file, trace, report, timeline, `-resume`) | Implemented | Adapter unit test; **not run** here (see limits above) |
| Docker Compose (PostgreSQL + nginx), native systemd controller | Implemented | Files written; Compose stack not started here; the PostgreSQL service in Compose matches the one tested |

## Milestone 2: cluster management

| Feature | Status | Notes |
|---|---|---|
| Controller inventory: CPU topology, RAM, GPU, disks, software, power | Demonstrated | psutil plus OS probes; macOS paths (sysctl, ioreg, pmset) not run here |
| Node lifecycle: discovered, authorized, enrolled, active, draining or disabled | Demonstrated | `test_cluster.py` |
| Worker agent: enroll with a single-use token, then heartbeat | Demonstrated | Real agent enrolled against the running controller |
| Agent services (systemd user unit, launchd agent) | Implemented | `install.sh` tested with stubbed systemctl/loginctl; launchd path not run here |
| One-click enrollment of tailnet machines over SSH | Demonstrated | End-to-end test and browser run with a stand-in `ssh` that executes locally; not yet run against a real Tailscale SSH host |
| Tailnet membership filter and discovery-source tags | Demonstrated | Tests + browser |
| Password-assisted enrollment (installs BioCompute's key, then key-only) | Demonstrated | Real OpenSSH 9.6 server with password login in the dev container |
| Spec-aware placement (free cores, RAM, scratch, GPU, measured link speed) | Demonstrated | Scenario tests; agent speed test against a live controller; browser |
| Discovery: Tailscale, HTCondor, mDNS, neighbour table, agent reports, manual entry | Implemented | Agent reports and manual entry tested; the others degrade cleanly when absent |
| De-duplication by machine ID, hostname, and address within a site | Demonstrated | Tests, including the "same private IP on two networks" case |
| Per-node allocation (cores, RAM, GPUs, scratch, jobs, priority, idle-only, hours, AC power, data policy, drain) | Demonstrated | UI + tests |
| Eco, Balanced and Maximum presets that become concrete policies | Demonstrated | `test_presets_translate_to_policy` |
| HTCondor slot/START policy generated for each node | Implemented | Text verified by tests; not loaded into a real condor_startd |
| Selecting nodes for a run, which switches to Nextflow's condor executor | Implemented | Requires a shared filesystem; untested |

## Milestone 3: Pipeline Studio

| Feature | Status |
|---|---|
| React Flow editor: palette, typed ports, connection rules, inspector, undo/redo, subworkflows | Demonstrated (browser) |
| Graph validation: types, cycles, missing inputs, scope mixing | Demonstrated (tests) |
| DSL2 + `nextflow_schema.json` + `bcflow.json` generation, zip export | Demonstrated (tests) |
| Publish to the library and run (native engine) | Demonstrated (`test_publish_and_run_studio_pipeline`) |
| Run generated DSL2 with Nextflow | Implemented, **untested** here |
| Pipeline map: Studio graph per published version, edit a version in Studio and publish it as the next version, copies of others' Studio pipelines stay editable | Demonstrated (`test_pipeline_map.py`, browser) |
| Edit as new pipeline: Studio copy as a new workflow, Nextflow copy with a code editor; saves are new version folders of the copy; originals refused by the server | Demonstrated (`test_edit_as_new_pipeline_never_touches_the_original`, browser) |
| Interactive step settings on the map of a Nextflow copy (off, tool arguments, CPUs/memory/time, container; steps left without input shown), saved as a config on a new version | Demonstrated (`test_step_settings_on_the_map_are_a_config_on_a_new_version`, browser); the generated config was **not run with Nextflow** here (no Nextflow on the dev controller) |
| Add a library module as a step / remove a step of a Nextflow copy from Studio (code rewritten, previewed as a diff, saved as a new version, re-parsed to confirm) | Demonstrated on the nf-core-shaped fixture (`test_add_and_remove_steps_of_a_nextflow_copy`, browser); the rewritten code was **not run with Nextflow** here |
| Read-only map of Nextflow DSL2 pipelines from their code (processes, subworkflows, aliases, conditions, channel flow) | Demonstrated on the bundled pipeline and an nf-core-shaped fixture (`test_pipeline_map.py`, browser); not yet checked against real nf-core releases (not downloadable here) |
| Import arbitrary Nextflow scripts back into a graph | Not supported by design |
| User modules for installed software: scan PATH, 15 templates (Genrich, SEACR, HOMER, epic2, GoPeaks, …), builder with live checks, edit/export/import/delete | Demonstrated (`test_custom_modules.py`, browser); a user-made module ran end to end on the native engine |
| Input nodes with default samplesheet / FASTQ folder / reference path; launch from an experiment, a samplesheet file or a FASTQ folder (recursive pair detection) | Demonstrated (`test_launch_studio_pipeline_from_a_fastq_folder_default`, browser launch completed) |
| Assistant Build creates, checks and saves modules for missing software, then redesigns with them; custom nodes saved as modules | Demonstrated with a stub provider (`test_build_creates_and_saves_missing_modules`); not yet with a real model |
| Assistant: Build (validate + up to 2 repair rounds), Review, Ask, Draft module | Demonstrated with Claude Code (one real Build call: valid 9-node CUT&RUN graph, ~30 s, $0.33); prompt/repair logic covered by tests with a stub provider |
| Assistant via Anthropic API (`claude-opus-5-5`, structured outputs, server-side fallback) | Implemented; request accepted by the API up to authentication (no key here), so **no real completion tested** |
| Assistant via OpenAI API (structured outputs) | Implemented, **untested** (API not reachable from the dev sandbox) |

## Users and ownership

| Feature | Status |
|---|---|
| New accounts after the first: requests from the sign-in page approved by an admin (role chosen), single-use invite links with role and expiry, on/off switch | Demonstrated (`test_account_requests_and_invites`, three-person browser test) |
| Per-user pipelines, Studio workflows and modules: private by default, shared with the lab on request; others can view/run/copy but not change; admins see all; per-user favorites; sharing a workflow shares its modules and pipeline | Demonstrated (`test_ownership.py`, two-user browser test); migration keeps existing items shared |

## Storage and intermediate files

| Feature | Status |
|---|---|
| Intermediate files deleted during a run: bcflow removes a step's folder once every step that reads it has finished; Nextflow runs get `cleanup = true`; the work folder is removed after a successful run (failed runs keep it for Resume). Opt out per run ("Keep intermediate files") or globally (`BIOCOMPUTE_CLEANUP_INTERMEDIATES=false`) | bcflow and the post-run clean-up demonstrated (`test_storage_cleanup.py`); the Nextflow `cleanup` setting is written to the config but not run with real Nextflow here |
| Run page: delete intermediate files, delete a run (with its results folder only when BioCompute created it and no other run writes there) | Demonstrated (`test_storage_cleanup.py`) |
| Settings, Storage (admins): space used by work folders, logs and pipeline versions, free disk per folder, bulk clean-up of finished runs, deleting unused pipeline versions | Demonstrated (`test_storage_cleanup.py`) |
| Pipeline versions: unchanged files shared by hard links inside the store only, written by replace-on-save; a version no run used can be deleted | Demonstrated (`test_storage_cleanup.py`) |
| Runs on the controller reserve their CPU cores and memory against its allocation; a run that does not fit waits in the queue (reason on the run page, free capacity in the launch form), first come, first served; HTCondor runs reserve nothing locally. Systemd unit: `OOMPolicy=continue` | Admission rules demonstrated (`test_admission.py`); limits are scheduling limits, not OS-enforced |
| Machine usage samples pruned after `BIOCOMPUTE_METRICS_RETENTION_DAYS` | Implemented, not tested |

## Separate account for pipeline runs

| Feature | Status |
|---|---|
| Pipeline code runs as `biocompute-run` through a root-owned helper (sudo for that helper only): cannot read the database, signing key or configuration; its files stay readable and removable by the controller; cancel and hard stop through the helper | Demonstrated with a real second account and setpriv (`test_run_account.py`); `systemd-run` itself not run here (no systemd in the test container) |
| Each run a systemd unit with `CPUQuota`, `MemoryMax`, `NoNewPrivileges`, private `/tmp`, the database and keys inaccessible | Unit command checked (`test_run_account.py`, `test_runas_helper.py`); not started under systemd here |
| Helper refuses other units, relative commands, control characters, privileged or wrong accounts, other callers | Demonstrated (`test_runas_helper.py`) |
| Preflight as the run account: inputs, tools and output folders reachable, otherwise the fixing command | Demonstrated (`test_run_account.py`) |
| `scripts/run-account.py` setup / grant / status / remove; `install.sh` runs setup by default | setup, sudo rule, ACL access and denial, status and remove exercised in the test container with stand-in accounts; `install.sh` itself not run |

## Installation

| Feature | Status |
|---|---|
| `./install.sh`: prerequisites, venv, UI build, config, `--data` folders, systemd service as the user, health check, `tailscale serve` + public URL, re-run updates, `--uninstall` | Tested end to end as a normal user with `systemctl`/`sudo`/`tailscale` stand-ins (no systemd in the dev sandbox); generated unit passes `systemd-analyze verify`. **Not yet run on a real systemd host or a real tailnet.** |

## Interface review (independent) applied

| Feature | Status |
|---|---|
| Navigation in analysis order (Home, Experiments, Pipelines, Studio, Runs, Results, Data Explorer; System: Nodes, Settings), foldable sidebar, breadcrumbs, page titles, run-finished notifications, crash panel | Demonstrated (browser, desktop and phone width) |
| Unsaved-changes guard on in-app navigation (code, step settings, sample rows, launch form kept in the session); browser popups replaced by dialogs that state the consequence | Demonstrated (browser: leaving the code editor with an edit asks first) |
| Launch: blocking reasons listed, parameters handed over from a pipeline page, generic parameters for pipelines without a form, Advanced section; Runs list sort/filter/bulk cancel in the URL; failure panel with the failed step, sample, error and next actions | Demonstrated (browser: a real run started from a FASTQ folder; a failing run shows its step, sample and gzip error) |
| One set of pipeline tabs, one copy action, Home with your runs and experiments and a quick start, user admin (role, reset password, reactivate; last admin protected), sample-table undo, Studio toolbar with a More menu and overlays below xl | Demonstrated (browser; user admin by `test_user_admin.py`) |

## Tools check at install

| Feature | Status |
|---|---|
| `scripts/tools.sh` (called by `install.sh`): reports Nextflow, Java, refgenie and the built-in modules' programs, and offers to install only the missing ones (Nextflow installer, distro OpenJDK, refgenie into BioCompute's venv, bioconda environment via conda/mamba/micromamba); writes paths to the configuration; Settings lists module tools | Flow demonstrated with stand-ins for the downloads (fake installer, pip and conda); the real downloads were **not executed** in the dev sandbox |

## First run

| Feature | Status |
|---|---|
| First-run screen creates the administrator account (no code from the controller itself; one-time setup code from other computers or through a proxy; legacy generated admin taken over); Getting started checklist | Demonstrated (`test_setup.py` against real server processes, browser) |

## Projects and differential expression

| Feature | Status |
|---|---|
| Projects: own folder (data/results/analyses), folders/files/runs as items, launch into a project, private/shared | Demonstrated (`test_projects_de.py`, browser) |
| DE view: DESeq2/edgeR/limma column detection, volcano and MA plots with live cut-offs, density-shaded groups, labels, gene search, filtered table, CSV/TSV export, save with parameters into a project | Demonstrated (`test_projects_de.py`, browser with a 20,000-gene table, dark and light) |

## Data folders

| Feature | Status |
|---|---|
| Admins add/edit/remove data folders in Settings (DB-backed, merged with `BIOCOMPUTE_DATA_ROOTS`); live check of the path; system, home, hidden and state folders refused; restricted by default | Demonstrated (`test_data_roots.py`, browser) |

## Data Explorer

| Feature | Status |
|---|---|
| File viewer: tables (sort/filter/page, gz, headerless genomic formats, `NA` as missing), PDF, images, sandboxed HTML, text | Demonstrated (`test_explore.py`, browser) |
| Density-coloured scatter (viridis, log density, hover), histogram, log10/−log10 axes, volcano/MA suggestions, trim outliers | Demonstrated (browser, 20,000-row table, dark and light) |
| Genome browser (igv.js 3.8.10): local FASTA genome + indexed BAM, bigWig and narrowPeak over HTTP range requests | Demonstrated (browser, real pysam/pyBigWig files) |
| Built-in genomes (igv.org), GenArk accessions, UCSC public hub list, opening hubs, URL tracks | Implemented, **untested**: igv.org, UCSC and hub hosts are not reachable from the dev sandbox. The list API response is parsed defensively and the hub list UI was checked with a canned list |

## Reference genomes (refgenie)

| Feature | Status |
|---|---|
| Read an existing refgenie 0.13 setup (Settings, `$REFGENIE`, common paths); genome folder as a read-only data folder; config never written | Demonstrated (`test_references.py` with genomes built by the real refgenie CLI) |
| `refgenie://genome/asset[.seek][:tag]` resolved at launch, invalid references refused, digests in provenance and `references.json` | Demonstrated (`test_references.py`, real bcflow run) |
| Asset picker on file/folder parameters and Studio paths, launch-form genome fill, experiment genome, Reference genomes page, refgenie genomes in the genome browser | Demonstrated (browser) |
| Assistant sees available genomes/assets | Demonstrated (`test_references.py` catalog check; not checked against a live model) |
| Pulling/building assets from the UI, checking that workers have the genome folder | Not implemented (planned phases 2 and 3) |

## Milestone 4: advanced distributed execution

| Feature | Status |
|---|---|
| Data-locality-aware placement scoring, restricted-data enforcement | Implemented and tested |
| Speed-up estimate for recruiting more nodes (Amdahl model with a transfer penalty) | Implemented (simple model, documented assumptions) |
| Safe staging of approved intermediate files to remote workers | Planned (policy fields exist; no transfer mechanism yet) |
| Snakemake engine | Planned (the engine adapter interface is in place) |
| Automatic resource recommendations from past traces | Planned |
