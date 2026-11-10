# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Sidebar says "Nextflow not found on controller" | The service user's PATH has no `nextflow`. Install it, or set `BIOCOMPUTE_NEXTFLOW_BIN=/full/path/nextflow`, then click *Settings, Execution environment, Re-detect*. |
| Run fails in preflight: "Profile 'docker' runtime" | That runtime is not installed or not reachable for the service user (e.g. not in the `docker` group). Choose another profile or install it. |
| Run is marked **lost** | The supervisor process died without writing `exit_code`, for example after a host reboot or `kill -9`. Click *Resume*: Nextflow reuses its cache through `-resume`. |
| Runs stopped when the API was restarted | The systemd unit must have `KillMode=process` (it does in `deploy/biocompute.service`). |
| "Path escapes its data root" / "Path traversal is not permitted" | Paths must be `root:relative/path` inside a configured root. A symlink that points outside its root is refused by design. |
| Output folder is read-only | Output roots need `"writable": true` and must be in the systemd unit's `ReadWritePaths=`. |
| Experiment validation: "File assigned more than once" | The same FASTQ is used by two samples. Remove the duplicate, or make the second one a technical replicate with its own files. |
| A node shows "Not eligible: no recent agent heartbeat" | The agent is stopped or can't reach the controller. Check `journalctl --user -u biocompute-agent` (Linux) or `~/Library/Logs/biocompute-agent.log` (macOS). |
| A laptop never receives work | Expected while it is idle-only and in use, on battery with "Only on AC power" set, or outside its allowed hours. The node panel lists the reasons. |
| Discovery finds nothing via Tailscale or HTCondor | Their CLIs are not installed on the controller. Each provider reports "not available" in the scan dialog. |
| Two machines merged into one node | De-duplication uses the machine ID, then hostname, then address within the same site. Give the machines distinct hostnames or sites, or remove the node and re-enroll. |
| Lost the admin password, or login fails | From `backend/`: `.venv/bin/python -m app.cli info` shows which database and users this configuration uses; `.venv/bin/python -m app.cli reset-password` sets a new admin password. For the demo use `scripts/dev.sh admin info` / `scripts/dev.sh admin reset-password`. For the systemd install (reads the environment file exactly like the service): `sudo systemd-run --pty --uid=biocompute -p EnvironmentFile=/etc/biocompute/biocompute.env -p WorkingDirectory=/opt/biocompute/backend /opt/biocompute/backend/.venv/bin/python -m app.cli reset-password`. |
| Vite dev server returns 500 on `index.css` | Keep `tailwindcss` and `@tailwindcss/vite` at the same version (both 4.3.x in `package.json`). |
| UI loads but rejects the demo password `biocompute-dev` | Another server is answering on port 8000 (e.g. an Option B install), or the demo database was created earlier with a different password (the admin password is only set when the database is first created). `scripts/dev.sh` now refuses to start when port 8000 is taken; use `scripts/dev.sh admin reset-password` to reset it. |
| "Too many failed attempts" | 8 failed logins within 5 minutes lock that username from that address. Wait 5 minutes or restart the API. |
