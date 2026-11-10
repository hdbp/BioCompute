# Architecture

```
            browser (React SPA)                         worker machines
                  │  HTTPS (nginx / TLS)                 ┌─────────────────────────┐
                  ▼                                      │ biocompute_agent.py     │
 ┌────────────────────────────────────────┐  heartbeat   │  inventory + heartbeat  │
 │ Controller (lab workstation, native)   │◀─────────────│  (no remote execution)  │
 │  FastAPI  ── routers ── services       │  enroll      └─────────────────────────┘
 │    │                                   │                         ▲
 │    ├─ PostgreSQL (compose, loopback)   │   condor_submit (Nextflow condor executor)
 │    ├─ run monitor thread               │─────────────────────────┘ shared filesystem
 │    └─ spawns ─▶ wrapper.py (detached)  │
 │                   └─▶ nextflow run …   │  or  bcflow.py (native engine)
 └────────────────────────────────────────┘
```

## Backend layers

| Layer | Contents |
|---|---|
| `models.py` | Users, AuditEvent, Pipeline / PipelineVersion / ParameterPreset, Experiment / Sample, Dataset, StudioWorkflow, Run / RunEvent, Node / NodeAllocation / NodeMetric, EnrollmentToken |
| `schemas.py` | Typed API contract (Pydantic v2); OpenAPI exported to `docs/openapi.json` |
| `routers/` | `auth`, `pipelines` (+ `pipeline-versions`, `pipeline-schemas`), `experiments` (+ `samples`), `data` (`/api/datasets`), `runs` (+ `jobs`, `results`), `cluster` (`nodes`, `discovery`, `allocations`, `agent`), `studio`, `system` (dashboard, settings, events) |
| `services/` | `fs` (virtual paths), `nfschema` (schema parsing and validation), `samplesheet` (pairing, validation, sheet generation), `pipelines` (import), `runner` (lifecycle), `cluster` (discovery, presets, placement, HTCondor policy), `hostinfo` (shared with the agent), `studio` + `studio_modules` (compiler), `events` (SSE pub/sub), `tools` (software detection) |
| `engines/` | `wrapper.py` (supervisor), `adapters.py` (Nextflow / bcflow command builders and progress parser), `bcflow.py` (native engine) |

## Three kinds of metadata, kept separate (requirement §8)

* **Pipeline parameters** come from `PipelineVersion.schema_json`, the pipeline's own `nextflow_schema.json`.
  They are validated with `jsonschema`. BioCompute never assumes a parameter exists in every pipeline.
  The only ones it fills in itself are `input` (the generated samplesheet) and `outdir`, and only when the schema declares them.
* **Experimental design** lives in `Experiment` and `Sample`. A sample holds its files as virtual paths,
  either `files.fastq_1/2` or `files.runs[]` for multi-lane samples, plus free-form `attributes`.
  The samplesheet is generated per pipeline from the pipeline's `assets/schema_input.json` columns.
  Proteomics uses `files.raw`, with fraction, label and acquisition-batch attributes,
  and produces an OpenMS/quantms experimental-design TSV.
* **Scheduler resources** are kept in `Run.resources`, the per-run limits, and `NodeAllocation`, the per-node policy.

## Execution

1. **Prepare.** `runner.prepare` builds the effective parameters: schema defaults, then user values on top.
   Virtual paths are resolved to absolute ones. It writes `params.json`, generates the samplesheet,
   validates the experiment against `schema_input.json`, and records provenance.
2. **Preflight.** The adapter checks, for example, that the Nextflow binary, Java, the profile runtime
   (docker/apptainer/conda) and the HTCondor tools exist. For bcflow it checks the required tools.
   Results are stored as a run event.
3. **Launch.** `wrapper.py` is spawned with `start_new_session=True` and starts the engine argv.
   It writes `wrapper.pid`, `child.pid`, and finally `exit_code` (atomically).
   Because the run is detached from the API process, it survives controller restarts.
   The systemd unit uses `KillMode=process` for the same reason.
4. **Monitor.** One thread polls active runs every 2 s.
   * It parses `trace.txt`, which both engines write in Nextflow's trace format,
     plus the `Submitted process >` log lines. From these it builds per-process counts.
   * When `exit_code` appears, it records the final state.
   * If the supervisor has disappeared without an exit code, the run is marked `lost`.
   * Queued runs start when a slot frees up (`BIOCOMPUTE_MAX_CONCURRENT_RUNS`).
5. **Restart.** `runner.reconcile()` re-attaches to runs whose supervisor is still alive.
   It checks the PID together with the process start time, to avoid matching a reused PID.
6. **Cancel.** SIGTERM goes to the supervisor, which forwards it to the engine for a graceful shutdown.
   If the run is still going after 60 s, the process group is killed.
7. **Resume.** Nextflow is re-run with `-resume <previous session name>`.
   bcflow skips tasks whose hash and outputs are unchanged.

### Nextflow on the host, not in a container

Nextflow is a JVM process that drives containers, schedulers and the filesystem. Putting it in a
generic container would need a Docker socket mount, host data mounts and scheduler credentials,
which together amount to root on the host. So the controller runs natively as an unprivileged user,
and only PostgreSQL and nginx are containerized. Nextflow's `-profile docker|apptainer|conda` then
works exactly as it would from a terminal.

### Native engine (`bcflow`)

`bcflow` is a deliberately small DAG executor. It runs `per_sample` and `aggregate` steps, with
argv templates and no shell, and outputs that can be glob patterns. It merges lanes using nf-core
`CAT_FASTQ` semantics, supports resume, and writes a Nextflow-format trace. It lets BioCompute run
real local analyses where Nextflow is missing, and it runs Studio graphs. It is **not** a Nextflow
replacement: it has no containers, no remote executors and no retries.

## Distributed execution and data locality

* `cluster.placement()` scores eligible nodes on several factors:
  * allocation priority and cores;
  * a bonus for the controller;
  * a penalty for estimated transfer time (about 100 Mbit/s between sites).

  It also rules nodes out entirely:
  * if inputs come from a *restricted* data root, nodes outside the controller's site;
  * nodes whose `data_policy` is `local-only`;
  * architecture or GPU mismatches;
  * node eligibility failures: disabled, draining, outside allowed hours, on battery, in use (idle-only nodes), or a stale heartbeat.
* Runs default to data-local execution on the controller, with Nextflow's local executor capped to the controller's allocation.
* Selecting extra nodes switches the run to Nextflow's `condor` executor, with a `requirements` expression that pins the chosen machines.
  This **requires a filesystem shared by those nodes** (Nextflow's work directory model).
  BioCompute does not pretend that Nextflow can scatter tasks to arbitrary machines without one.
* Per-node HTCondor configuration (`/api/nodes/{id}/condor-config`) turns the allocation into `NUM_CPUS`, `MEMORY`, a partitionable slot, `START`/`SUSPEND` rules (idle and hours) and site attributes.
  * On Linux, cgroups give OS-level enforcement.
  * On macOS, limits are scheduler-level only.
  * BioCompute never pushes this configuration to a machine; its owner installs it.

## Security boundaries

* **Authentication:** JWT, HS256. The signing key comes from the environment or is generated once into `state_dir/secret.key` (0600).
  Login has rate limiting, and the initial admin password is written to a 0600 file.
* **Authorization:** viewer < scientist < admin. Node, user and discovery operations are admin-only.
  Launching, imports and editing need the scientist role.
* **Filesystem:** only configured roots are reachable, through `fs.resolve`.
  It rejects `..` and absolute paths, and resolves symlinks before checking containment.
  Read-only roots reject writes. Results serving is limited to the run's own output directory.
* **Subprocesses:** always an argv list. `git clone -- <url>` guards against option injection.
  Profile names and HTCondor hostnames are allow-listed by regex.
  The example pipeline's schema forbids quote characters in free-text values that reach a shell script.
* **Arbitrary code:** pipelines and Studio custom modules are code. They run with the controller
  service account's permissions and nothing more. The systemd unit sets `NoNewPrivileges` and
  `ProtectSystem`, and limits writable paths. Admins can disable custom code modules.
* **SSH enrollment:** this is the only case where BioCompute changes another machine, and it is deliberately narrow.
  * An admin starts it and confirms, for one tailnet member at a time.
  * The target must be that machine's own tailnet address.
  * The commands are fixed and quoted, and the token goes over stdin.
  * It runs in BatchMode with `StrictHostKeyChecking=accept-new` and a known-hosts file in the state directory.
  * It is audit-logged, and it can be disabled with `BIOCOMPUTE_ALLOW_SSH_ENROLLMENT=false`.
* **Agent listener (optional):** a second listener, on the tailnet IP for example, serves only the
  token-protected agent endpoints and `/api/health`. The UI and the main API never leave 127.0.0.1.
* **Agents:** they have no inbound port and no command channel. Their identity is bound to a token,
  so a self-reported machine ID cannot override it. Discovery reports need a token flagged for them.
* **HTML reports** are served with `Content-Security-Policy: sandbox`.
