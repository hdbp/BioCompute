# BioCompute

BioCompute is a self-hosted platform for running bioinformatics pipelines on a small lab cluster.
You use it from a browser to:

- manage Nextflow and nf-core pipelines, with parameter forms generated from each pipeline's schema;
- describe experiments (samples, conditions, replicates, controls and files) and generate samplesheets;
- launch, monitor, cancel and resume runs, then browse their outputs and provenance;
- discover, enroll and allocate the computers that do the work;
- build simple workflows visually and export them as Nextflow DSL2.

It is built for one primary Linux workstation that holds the raw data and acts as controller.
Other Linux and macOS machines can take part as workers under explicit, per-node policies.

> **Status:** Milestone 1 works end to end. The cluster, Studio and scheduling work from
> milestones 2–4 is partly done. [`docs/STATUS.md`](docs/STATUS.md) separates what is
> implemented, what has been demonstrated, and what is planned, including what has not been tested.

## Repository layout

```
backend/            FastAPI controller (Python 3.12)
  app/models.py       SQLAlchemy models        app/schemas.py   API contract (Pydantic)
  app/routers/        REST + SSE endpoints     app/services/    domain logic
  app/engines/        wrapper.py (detached run supervisor), adapters.py (Nextflow), bcflow.py (native engine)
  alembic/            database migrations      tests/           pytest suite (+ real nf-core schema fixtures)
frontend/           React 18 + TypeScript + Vite + Tailwind + Radix (shadcn-style) + React Flow + Recharts
agent/              worker agent (stdlib Python) + systemd / launchd service templates
deploy/             systemd unit for the controller, nginx template, installer
examples/           bundled pipeline (examples/pipelines/fastq-qc) and synthetic-data generator
docs/               architecture, deployment, agent, Studio, troubleshooting, API (openapi.json)
docker-compose.yml  PostgreSQL + nginx (the controller itself runs natively; see below)
```

## Quick start (development, one machine)

Requirements: Python 3.11+, Node 20+, git. Nextflow and Java 17+ are optional; without them, only
pipelines that ship a `bcflow.json` can run, using the native engine.

```bash
scripts/dev.sh
# API  http://127.0.0.1:8000  (OpenAPI docs at /docs)
# UI   http://127.0.0.1:5173  user: admin  password: biocompute-dev
```

`dev.sh` generates a **synthetic** FASTQ dataset under `var/demo/raw` (random reads, labelled as
not biological) and configures three data roots: `raw`, which is restricted and read-only;
`analyses`, which is writable; and `pipelines`. It uses SQLite unless `BIOCOMPUTE_DATABASE_URL` is set.

A first walkthrough:

1. **Pipelines**: open *BioCompute FASTQ QC*. Its parameter form is generated from `nextflow_schema.json`.
2. **Experiments**: create one, then *Add files*. Pick `raw:synthetic_chip_run` and BioCompute pairs
   R1/R2 files and merges lanes. Set conditions and controls, then *Save*.
3. **Run analysis**: validate, then launch. The run page streams the log and shows per-process progress.
4. **Results**: browse `qc_report.html` and `qc_summary.tsv`. Provenance is written next to the outputs.

## Production deployment (lab workstation)

The controller runs **natively** under systemd because Nextflow needs the host's Java, container
runtime, scheduler client and data directories. PostgreSQL and the nginx front end run in Docker Compose.

```bash
sudo deploy/install-controller.sh          # service user, venv, systemd unit, UI build
sudoedit /etc/biocompute/biocompute.env    # data roots, DB password, site name (see .env.example)
docker compose up -d db web                # PostgreSQL on 127.0.0.1:5432, UI on :8080
sudo systemctl enable --now biocompute     # API on 127.0.0.1:8000 (migrations run automatically)
sudo cat /var/lib/biocompute/initial_admin_password.txt
```

See [`docs/deployment.md`](docs/deployment.md) for TLS, Nextflow, Apptainer and HTCondor setup,
backups and upgrades. To add workers, see [`docs/worker-agent.md`](docs/worker-agent.md).

## Tests

```bash
cd backend && .venv/bin/python -m pytest -q        # 32 API/service tests, incl. real execution
cd frontend && npx vitest run && npx tsc -b        # unit tests + type check
node frontend/e2e/launch-flow.cjs <experiment-id>  # browser walkthrough (needs running stack + Playwright)
```

## Security model, in short

- Every endpoint requires a login (scrypt-hashed passwords, JWT). There are three roles:
  viewer, scientist and admin. Important actions go to an audit log.
- Users can only browse configured data roots. Paths are virtual (`root:relative/path`).
  Traversal and symlink escapes are rejected.
- Every subprocess gets an argv list; nothing goes through a shell. Pipeline code runs as
  the controller's unprivileged service user.
- Discovery never grants permission to run work. An admin must authorize a device, its owner
  installs the agent with a single-use token, and participation is switched on separately.
  Active probing only happens inside authorized CIDRs. Nothing is ever installed remotely.
- Data in *restricted* roots is never placed on nodes outside the controller's site.

More detail: [`docs/architecture.md`](docs/architecture.md).
