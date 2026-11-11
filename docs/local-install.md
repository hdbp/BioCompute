# Local installation

There are three ways to run BioCompute on your own machine:

| Option | Use it when | Database | Ports |
|---|---|---|---|
| **A. Demo** (`scripts/dev.sh`) | You want to try it in 5 minutes on synthetic data | SQLite | UI 5173, API 8000 |
| **B. Local install** (single process) | You want to use it on one machine with your own data | SQLite or PostgreSQL | 8000 |
| **C. Lab server** | You're setting up the shared lab workstation with systemd, nginx and TLS | PostgreSQL | 8080 |

Option C is covered in [`deployment.md`](deployment.md). This page covers A and B.

---

## 1. Prerequisites

| Software | Version | Needed for |
|---|---|---|
| Python | 3.11 or newer, with `venv` | API and run supervisor |
| Node.js + npm | 20 or newer | building the web interface |
| git | any | importing pipelines from GitHub |
| Java | 17 or newer | Nextflow (optional at first) |
| Nextflow | 23.04 or newer | running Nextflow / nf-core pipelines (optional at first) |
| Apptainer, Docker or conda | any | software for nf-core pipelines (optional) |

Without Nextflow, BioCompute still runs, but only pipelines that include a `bcflow.json`
(such as the bundled FASTQ QC example) can be executed.

**Ubuntu / Debian**

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip git curl openjdk-17-jre-headless
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -   # Node 22 LTS
sudo apt install -y nodejs
```

**Fedora / RHEL / Rocky**

```bash
sudo dnf install -y python3 python3-pip git curl java-17-openjdk-headless nodejs npm
```

**macOS** (Homebrew)

```bash
brew install python@3.12 node git openjdk@17
```

**Nextflow** (any OS, installs into `~/.local/bin` or wherever you move it)

```bash
cd /tmp && curl -s https://get.nextflow.io | bash
mkdir -p ~/.local/bin && mv nextflow ~/.local/bin/ && chmod +x ~/.local/bin/nextflow
nextflow -version          # must print a version; make sure ~/.local/bin is on your PATH
```

Alternatively: `conda install -c bioconda nextflow`.

Check everything:

```bash
python3 --version && node --version && git --version && java -version && nextflow -version
```

## 2. Get the code

```bash
git clone https://github.com/hdbp/BioCompute.git
cd BioCompute
```

---

## Option A: demo in one command

```bash
scripts/dev.sh
```

The first run takes a few minutes:
1. It creates `backend/.venv` and installs the Python packages.
2. It installs the web dependencies with `npm ci`.
3. It generates a small **synthetic** FASTQ dataset in `var/demo/raw`. These are random reads, not biological data.

Once it is running:

* Open **http://127.0.0.1:5173** and log in as `admin` with password `biocompute-dev`.
* API documentation is at http://127.0.0.1:8000/docs.
* Press `Ctrl+C` to stop.

All state lives in `var/`. Delete that folder to start over.

To try the main flow:

1. **Experiments**: *New experiment*, then *Add files*, then *Scan a folder*, choosing `raw:synthetic_chip_run`.
   The R1/R2 pairs and the two-lane sample are detected. Set the conditions, then *Save*.
2. *Run analysis*, pick **BioCompute FASTQ QC**, then *Validate* and *Launch*.
3. Watch the live log, then open **Results** and select `report/qc_report.html`.

---

## Option B: local install with your own data

This runs one process. The API also serves the built web interface on port 8000.

### B1. Install

```bash
cd BioCompute

# Python environment
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt

# Web interface (built once; served by the API)
cd frontend && npm ci && npm run build && cd ..
```

### B2. Configure

Create `backend/.env`; the API reads it from the `backend/` folder:

```bash
cp .env.example backend/.env
nano backend/.env
```

The settings that matter for a local install:

```ini
BIOCOMPUTE_ENVIRONMENT=production

# SQLite is fine for a single user (PostgreSQL: see B6)
BIOCOMPUTE_DATABASE_URL=sqlite:////home/YOU/biocompute/biocompute.db

# BioCompute's own state: pipeline store, run folders, secret key
BIOCOMPUTE_STATE_DIR=/home/YOU/biocompute/state

# Your admin password (leave empty to have one generated into STATE_DIR/initial_admin_password.txt)
BIOCOMPUTE_ADMIN_PASSWORD=choose-a-long-password

# The ONLY folders BioCompute may browse. One line of JSON.
#   restricted=true : data never leaves this machine's site (raw data)
#   writable=true   : results can be written there
BIOCOMPUTE_DATA_ROOTS=[{"name":"raw","path":"/data/sequencing","restricted":true,"writable":false},{"name":"analyses","path":"/home/YOU/analyses","restricted":false,"writable":true}]

BIOCOMPUTE_SITE_NAME=lab
BIOCOMPUTE_MAX_CONCURRENT_RUNS=4
# Only if Nextflow is not on PATH:
# BIOCOMPUTE_NEXTFLOW_BIN=/home/YOU/.local/bin/nextflow
```

You can also skip `BIOCOMPUTE_DATA_ROOTS` and add folders after the first login, in
**Settings → Controller → Data folders → Add folder**. Folders added there are stored in the database. They take effect
at once, and they can be made restricted or writable, or removed (only the folder's registration is removed;
the files stay on disk). BioCompute refuses system folders, a whole home folder, hidden folders such as `~/.ssh`,
and its own state folder.

The folders must be on the computer running BioCompute (the controller). If your data sits on another machine,
mount it on the controller first (NFS/SMB share, external drive) and add the mount point.

Before starting, make sure:

* every `path` in `BIOCOMPUTE_DATA_ROOTS` exists;
* your user can read the raw data and write to the writable roots;
* the database and state folders exist:

```bash
mkdir -p ~/biocompute/state ~/analyses
```

Delete any lines from `.env.example` that you don't need. In particular, delete the
`postgresql+psycopg://…` URL if you use SQLite.

### B3. Start

```bash
cd backend
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open **http://127.0.0.1:8000** and log in as `admin`. On first start:

* the database tables are created automatically, using Alembic migrations;
* the nf-core catalog and the bundled example pipeline are registered;
* this computer is registered as the controller node, with its CPUs, RAM and GPUs detected.

To reach it from other computers, keep `--host 127.0.0.1` and put a TLS proxy in front
(see deployment.md, section 3), or use an SSH tunnel: `ssh -L 8000:127.0.0.1:8000 you@workstation`.
Do not expose port 8000 directly to a network.

### B4. Keep it running (Linux, systemd user service)

Create `~/.config/systemd/user/biocompute.service`:

```ini
[Unit]
Description=BioCompute (local)

[Service]
WorkingDirectory=%h/BioCompute/backend
ExecStart=%h/BioCompute/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
# Pipelines keep running if the API restarts:
KillMode=process
Restart=on-failure
# Make Nextflow and Java visible to the service:
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Then enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now biocompute
loginctl enable-linger $USER          # keep running after you log out
journalctl --user -u biocompute -f    # logs
```

### B5. Check the execution environment

In the web interface, open **Settings** and then **Execution environment**. It should list Nextflow,
Java and your container tool. If you installed something after starting the service, click
**Re-detect**. The sidebar warning "Nextflow not found on controller" disappears once Nextflow is found.

To run a real nf-core pipeline:

1. **Pipelines**, then the *Catalog* tab, then *Install* (this needs access to GitHub). Pin a release version.
2. Create an experiment with your FASTQ files.
3. *Configure and run*, choose the `apptainer`, `docker` or `conda` profile, and launch.

### B6. Optional: PostgreSQL instead of SQLite

SQLite is fine for one user. For a shared, long-lived installation, use PostgreSQL:

```bash
# with Docker (bound to localhost only)
echo "POSTGRES_PASSWORD=change-me" > .env
docker compose up -d db
```

Then in `backend/.env`:

```ini
BIOCOMPUTE_DATABASE_URL=postgresql+psycopg://biocompute:change-me@127.0.0.1:5432/biocompute
```

Or use an existing PostgreSQL server:

```sql
CREATE USER biocompute PASSWORD '…';
CREATE DATABASE biocompute OWNER biocompute;
```

---

## 3. Verify the installation (optional)

```bash
backend/.venv/bin/pip install -r backend/requirements-dev.txt
cd backend && .venv/bin/python -m pytest -q          # expect: 32 passed
cd ../frontend && npx vitest run && npx tsc -b         # expect: 5 passed, no type errors
```

The backend tests use their own temporary database and folders. They don't touch your configuration.

## 4. Update

```bash
cd BioCompute && git pull
backend/.venv/bin/pip install -r backend/requirements.txt
cd frontend && npm ci && npm run build && cd ..
systemctl --user restart biocompute      # or stop and start uvicorn
```

Database migrations run automatically at start-up. Running pipelines are not interrupted.

## 5. Uninstall

```bash
systemctl --user disable --now biocompute 2>/dev/null
rm -rf BioCompute ~/biocompute ~/.config/systemd/user/biocompute.service
```

This leaves your data roots and analysis outputs untouched.

## Common problems

| Problem | Fix |
|---|---|
| `python3 -m venv` fails with "ensurepip is not available" | `sudo apt install python3-venv` |
| `Settings` validation error about `BIOCOMPUTE_DATA_ROOTS` at start-up | The value must be one line of valid JSON with double quotes. Check it with `python3 -c 'import json,sys; json.loads(sys.argv[1])' '<value>'` |
| Login fails with 401 | The admin password is only set when the database is first created; changing `.env` later has no effect. If it was generated, read `STATE_DIR/initial_admin_password.txt`. Check which database you are using with `cd backend && .venv/bin/python -m app.cli info`, and reset with `.venv/bin/python -m app.cli reset-password` (demo: `scripts/dev.sh admin reset-password`). Also make sure no *other* BioCompute is answering on the same port. |
| "Data root ... is read-only" when launching | Choose an output folder in a root with `"writable": true` |
| Nextflow found in a terminal but not by BioCompute | The service has a different PATH. Set `BIOCOMPUTE_NEXTFLOW_BIN` to the full path, or extend `Environment=PATH=` in the unit |
| Port 8000 already in use | Find the owner with `sudo ss -ltnp 'sport = :8000'`. If it's an earlier BioCompute (dev.sh, manual uvicorn or the systemd service) stop it or use it. Otherwise start with `--port 8010` (demo: `BIOCOMPUTE_API_PORT=8010 scripts/dev.sh`). |

More: [`troubleshooting.md`](troubleshooting.md). To add other computers as workers, see [`worker-agent.md`](worker-agent.md).
