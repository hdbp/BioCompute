# Deployment on the lab workstation

## 1. Prerequisites (controller)

| Component | Why | Notes |
|---|---|---|
| Linux, Python 3.11+, git | API, pipeline imports | |
| Docker + Compose plugin | PostgreSQL and nginx | the controller itself is **not** containerized |
| Java 17+ and Nextflow | running Nextflow pipelines | install for the `biocompute` user: `curl -s https://get.nextflow.io \| bash` then move `nextflow` to `/usr/local/bin`, or `conda install -c bioconda nextflow`. Set `BIOCOMPUTE_NEXTFLOW_BIN` if it is elsewhere. |
| Apptainer / Docker / conda | pipeline software environments | used through Nextflow `-profile` |
| HTCondor submit tools (optional) | multi-node runs | the controller must be a submit node of your pool |
| Node 20+ | building the UI | only at build time |

## 2. Install

```bash
git clone <this repo> && cd BioCompute
sudo deploy/install-controller.sh
sudoedit /etc/biocompute/biocompute.env
```

Edit at least these settings:

* `POSTGRES_PASSWORD` and the matching `BIOCOMPUTE_DATABASE_URL`;
* `BIOCOMPUTE_DATA_ROOTS`, a JSON list of roots. Raw data should be `restricted: true, writable: false`. Admins can add more in Settings → Data folders (stored in the database; system, hidden, home and state folders are refused).
  Make the output area writable and add it to `ReadWritePaths=` in `/etc/systemd/system/biocompute.service`;
* `BIOCOMPUTE_SITE_NAME`, the data-locality domain of this controller (e.g. `lab`);
* `BIOCOMPUTE_DISCOVERY_AUTHORIZED_CIDRS`, the networks where active probing is permitted.
* `BIOCOMPUTE_AGENT_LISTEN=tailscale`, so workers can enroll and send heartbeats over the tailnet.
  It serves only the agent endpoints, on the tailnet IP and port 8765.

The `biocompute` user must be able to read raw data (for example via group membership) and write the output roots.

```bash
cd /opt/biocompute
sudo cp /etc/biocompute/biocompute.env .env    # compose reads POSTGRES_PASSWORD from .env
sudo docker compose up -d db web
sudo systemctl enable --now biocompute
journalctl -u biocompute -f                    # first start runs Alembic migrations and seeds the catalog
sudo cat /var/lib/biocompute/setup_code.txt  # one-time setup code (also in the journal)
```

Open `http://<workstation>:8080`. The first visit shows **Welcome to BioCompute**, where you create the
administrator account. A browser on the workstation itself does not need the code. Any other computer, or any
request through nginx, must enter the one-time setup code printed at start-up. This stops another machine on the
network from claiming a fresh installation. The screen disappears once an administrator exists. Without a browser,
use `python -m app.cli reset-password <name> --create --role admin`. Set `BIOCOMPUTE_ADMIN_PASSWORD` for unattended
installs: it creates an `admin` account and skips the screen.

## 2b. Separate account for pipeline runs

`./install.sh` (system service) sets this up by default; `--no-run-account` skips it. Pipeline code then runs as
the system account `biocompute-run` instead of the controller's account, in systemd units with CPU and memory
limits enforced by the kernel, and cannot read BioCompute's database, signing key or configuration. What the setup
changes on the computer, all reversible with `sudo python3 scripts/run-account.py remove [--delete-account]`:

* the account `biocompute-run` (no login shell, home `/var/lib/biocompute-run`, where Nextflow keeps its own files);
* the controller's account joins the `biocompute-run` group (to read and clean up run files);
* ACL entries: read on the pipeline store, the engine code, the tools found on your PATH (Nextflow, Java,
  conda, Apptainer) and the read-only data folders; read and write on the writable data folders; pass-through
  (`x`) on the folders above them. Nothing else in your home folder becomes readable, but a world-readable file
  in a folder above a data folder can be opened by name;
* `/usr/local/libexec/biocompute-runas` (root-owned), `/etc/biocompute/runas.json`, and
  `/etc/sudoers.d/biocompute-runas` allowing your account to run that helper, and nothing else, without a password;
* `BIOCOMPUTE_RUN_AS=biocompute-run` in the configuration. The service unit then has no `NoNewPrivileges=`
  (it would block sudo).

A data folder added later in Settings needs access for the run account too; the first run that uses it stops at
the preflight with the exact command, for example:

```bash
sudo python3 scripts/run-account.py grant /data/new-raw-run          # read-only
sudo python3 scripts/run-account.py grant --write /data/analyses     # results
sudo python3 scripts/run-account.py status                           # what was given, and a check as the account
```

With `deploy/install-controller.sh` (dedicated `biocompute` account), run
`sudo python3 scripts/run-account.py setup --owner biocompute --config /etc/biocompute/biocompute.env --backend /opt/biocompute/backend`
and remove `NoNewPrivileges=yes` from `/etc/systemd/system/biocompute.service`. Needs systemd, sudo and the `acl`
package; Docker pipelines are not offered to the run account (the docker group is root-equivalent): use Apptainer.

## 3. TLS

Choose one of the following:

* Put `fullchain.pem` and `privkey.pem` in `deploy/certs/` and enable the TLS server block in `deploy/nginx.conf.template`.
* Terminate TLS at your institution's reverse proxy.
* For access from your own devices only, run `tailscale serve --https=443 http://127.0.0.1:8080`.
  Tailscale is optional, and BioCompute does not depend on it.

The API itself listens on 127.0.0.1 only.

## 4. Nextflow configuration

* BioCompute layers `runs/<id>/biocompute.config` on top of the pipeline's own config. That file sets the executor limits, `resourceLimits` and trace settings.
* Site-wide settings (for example `singularity.cacheDir`, institutional profiles) belong in `$NXF_HOME/config` of the `biocompute` user, or in `BIOCOMPUTE_NEXTFLOW_HOME`.
* Work directories default to `state_dir/runs/<id>/work`. For HTCondor runs, set `resources.work_dir` to a shared filesystem.

## 5. HTCondor (optional)

1. Make the controller a submit node of the pool.
2. On each worker, install HTCondor yourself. Then copy the generated policy from the node's
   *HTCondor policy* tab to `/etc/condor/config.d/90-biocompute.conf` and run `condor_reconfig`.
3. Provide a filesystem shared by the controller and the workers (NFS, for example) and use it as the work directory.
4. Run *Discover* to import the pool's machines (`condor_status`).

Without a shared filesystem, keep runs on the controller (the default).

## 6. Backups and upgrades

* Back up the PostgreSQL volume (`docker compose exec db pg_dump -U biocompute biocompute`) and `/var/lib/biocompute`.
* To upgrade: `git pull`, re-run `deploy/install-controller.sh`, then `systemctl restart biocompute`.
  Migrations run at start-up, and running pipelines continue (`KillMode=process`).

## Evaluation without the native controller

`docker compose --profile container-backend up` starts the API in a container. Nextflow is not
available there, so this is only for trying the UI and the native engine.
