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
   * Runs on the controller also reserve their CPU cores and memory ceilings (the limits their engine is
     given) against the controller's allocation. A run that does not fit waits in the queue with the reason
     shown, and queued runs start first come, first served. Runs sent to HTCondor reserve nothing on the
     controller. These are scheduling limits, not OS-enforced ones; the systemd unit has `OOMPolicy=continue`
     so a step killed for memory does not stop the service.
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

### What the scheduler knows about each node

The agent reports its capacity in every heartbeat, and its link speed at enrollment and every 6 hours.
`GET /api/nodes` returns it as `capacity`:

| Fact | Source |
|---|---|
| Free cores | allocation `max_cpus`, reduced by the cores busy right now (`cpu_percent` × logical cores) |
| Free RAM | `min(allocation, MemAvailable)` |
| Scratch space | free bytes at `BIOCOMPUTE_SCRATCH`, or the home folder on workers / the run directory on the controller, capped by the allocation's scratch limit |
| GPUs | allocated / detected (`nvidia-smi`, macOS system profiler) |
| Link speed | **measured** by the agent: round-trip time to `/api/health`, plus download and upload throughput via the token-protected `/api/agent/speedtest` (4 MB, or 32 MB if that was quick). Unmeasured nodes use an assumed 1 Gbit/s on the controller's site and 100 Mbit/s elsewhere, labelled as such |

### Placement

`cluster.placement()` (and `POST /api/allocations/placement`) first **excludes** a node, with the reason shown,
when any of these holds:
* it is not eligible (disabled, draining, outside its hours, on battery, in interactive use, stale heartbeat);
* the inputs are restricted and the node is outside the site, or its data policy forbids receiving inputs;
* the architecture doesn't match;
* the job needs a GPU and none is allocated;
* the user stated a RAM or scratch requirement the node can't meet.

An *estimated* scratch need (input × 3 + 5 GB) only produces a warning. The remaining nodes are **ranked by
estimated time to finish**:

    transfer = input bytes / link speed        (0 on the controller, where the data lives)
    compute  = input bytes / (25 MB/s × usable cores)       (BIOCOMPUTE_SCHED_MB_PER_CORE_SECOND)

Every candidate is listed with these facts, so the estimate can be checked. Runs stay **on the controller by
default**, next to the data. The fastest node is offered as a one-click alternative. Choosing any other node
uses Nextflow's HTCondor executor, which needs a shared filesystem.

* `cluster.placement()` estimates, per eligible node, how long the run would take there (cores, memory, and the
  time to move the inputs over the measured or assumed link) and ranks them.

  It also rules nodes out entirely:
  * if any input is in a *restricted* data folder, nodes outside the controller's site. Every input counts:
    experiment files, a samplesheet or FASTQ folder given as `input`, the files a samplesheet lists, and any
    parameter holding a path. Existing local paths outside all data folders are refused at launch;
  * nodes whose `data_policy` is `local-only`;
  * architecture or GPU mismatches;
  * node eligibility failures: disabled, draining, outside allowed hours, on battery, in use (idle-only nodes), or a stale heartbeat.
* Runs default to data-local execution on the controller, with Nextflow's local executor capped to the controller's allocation.
* Selecting extra nodes switches the run to Nextflow's `condor` executor, with a `requirements` expression that pins the chosen machines.
* The client cannot choose where a run executes: `executor`, `nodes` and the work folder are set by the server
  from these rules; only resource ceilings/requirements and the Nextflow profile are accepted from the request.
  This **requires a filesystem shared by those nodes** (Nextflow's work directory model).
  BioCompute does not pretend that Nextflow can scatter tasks to arbitrary machines without one.
* Per-node HTCondor configuration (`/api/nodes/{id}/condor-config`) turns the allocation into `NUM_CPUS`, `MEMORY`, a partitionable slot, `START`/`SUSPEND` rules (idle and hours) and site attributes.
  * On Linux, cgroups give OS-level enforcement.
  * On macOS, limits are scheduler-level only.
  * BioCompute never pushes this configuration to a machine; its owner installs it.

## Security boundaries

* **Authentication:** JWT, HS256. The signing key comes from the environment or is generated once into `state_dir/secret.key` (0600).
  Login has rate limiting. The first administrator is created in the browser (first-run setup; a one-time
  setup code is needed from another computer).
* **Authorization:** viewer < scientist < admin. Node, user and discovery operations are admin-only.
  Launching, imports and editing need the scientist role.
* **Filesystem:** only configured roots are reachable, through `fs.resolve`.
  It rejects `..` and absolute paths, and resolves symlinks before checking containment.
  Read-only roots reject writes. Results serving is limited to the run's own output directory.
* **Subprocesses:** always an argv list. `git clone -- <url>` guards against option injection.
  Profile names and HTCondor hostnames are allow-listed by regex.
  The example pipeline's schema forbids quote characters in free-text values that reach a shell script.
* **Arbitrary code:** pipelines and Studio custom modules are code. With a run account (the default of
  `install.sh`, set up by `scripts/run-account.py`) they run as a separate system account, `biocompute-run`:
  * each run is a systemd unit (`biocompute-run-<run>-<attempt>`) started through a root-owned helper,
    `/usr/local/libexec/biocompute-runas`. A sudo rule lets the controller's account run that helper and nothing
    else; the helper only ever starts processes as the account named in the root-owned `/etc/biocompute/runas.json`,
    refuses a privileged account (uid 0, sudo, docker, ...), validates every argument and drops the controller's
    identity from the environment;
  * the unit has `CPUQuota` and `MemoryMax` from the run's cores and memory (plus room for Nextflow's own JVM),
    `NoNewPrivileges`, a private `/tmp`, `ProtectSystem=full`, `UMask=0007`, and the database, signing key and
    configuration made inaccessible on top of their 0600 permissions;
  * the account reads only what it was given with ACLs (the pipeline store, the engine code, the tools, the
    read-only data folders) and writes the writable data folders and each run's own folders, which the controller
    shares with the account's group. The controller is a member of that group, so it still reads results and
    deletes intermediate files; files it cannot delete are removed by the helper as the run account;
  * before a run starts, the helper checks as the run account that every input, tool and output folder is
    reachable; a gap stops the run at the preflight with the command that fixes it.

  Without a run account (user service, `--no-run-account`), pipelines run with the controller account's
  permissions, including its access to BioCompute's own state folder; Settings says so. The engine's
  environment has the controller's own settings and keys removed either way (`BIOCOMPUTE_*`, assistant API keys).
  Only give the scientist role to people you would trust to run code on the controller. Admins can disable custom
  code in Studio.
* **SSH enrollment:** this is the only case where BioCompute changes another machine, and it is deliberately narrow.
  * An admin starts it and confirms, for one tailnet member at a time.
  * The target must be that machine's own tailnet address.
  * The commands are fixed and quoted, and the token goes over stdin.
  * It runs in BatchMode (key login) with `StrictHostKeyChecking=accept-new` and a known-hosts file in the state
    directory. If no key is authorized yet, the admin can type that machine's password once: it is used for one
    connection that installs the controller's key, and is not stored.
  * It is audit-logged, and it can be disabled with `BIOCOMPUTE_ALLOW_SSH_ENROLLMENT=false`.
* **Agent listener (optional):** a second listener, on the tailnet IP for example, serves only the
  token-protected agent endpoints and `/api/health`. The UI and the main API never leave 127.0.0.1.
* **Agents:** they have no inbound port and no command channel. Their identity is bound to a token.
  What a machine reports about itself (hostname, addresses) cannot attach it to the controller's record or to an
  already enrolled machine, and its own claim of tailnet membership is kept apart from the controller's
  `tailscale status`. Discovery reports need a token flagged for them.
* **HTML reports** are served with `Content-Security-Policy: sandbox` (SVG files too, without scripts).
* **No token in URLs:** the bearer token lives in the browser's storage and goes in the `Authorization` header.
  Links, downloads, the genome browser and live updates use a separate HttpOnly, SameSite=Strict cookie that only
  works for GET/HEAD on those endpoints, so tokens do not end up in server logs or browser history.
