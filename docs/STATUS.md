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

## Installation

| Feature | Status |
|---|---|
| `./install.sh`: prerequisites, venv, UI build, config, `--data` folders, systemd service as the user, health check, `tailscale serve` + public URL, re-run updates, `--uninstall` | Tested end to end as a normal user with `systemctl`/`sudo`/`tailscale` stand-ins (no systemd in the dev sandbox); generated unit passes `systemd-analyze verify`. **Not yet run on a real systemd host or a real tailnet.** |

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
