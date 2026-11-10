#!/usr/bin/env bash
# Install the native BioCompute controller on a Linux workstation (run with sudo).
# Creates a 'biocompute' service user, a virtualenv, the systemd unit, and builds the UI.
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)"
prefix=/opt/biocompute
id biocompute >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/biocompute --shell /usr/sbin/nologin biocompute
install -d -o biocompute -g biocompute -m 0750 /var/lib/biocompute
install -d -m 0750 /etc/biocompute
rsync -a --delete --exclude .venv --exclude node_modules --exclude var "$src/" "$prefix/"
python3 -m venv "$prefix/backend/.venv"
"$prefix/backend/.venv/bin/pip" install -q -r "$prefix/backend/requirements.txt"
if [ ! -f /etc/biocompute/biocompute.env ]; then
  cp "$src/.env.example" /etc/biocompute/biocompute.env
  chmod 0640 /etc/biocompute/biocompute.env; chgrp biocompute /etc/biocompute/biocompute.env
  echo "Edit /etc/biocompute/biocompute.env (data roots, database password) before starting."
fi
if command -v npm >/dev/null; then (cd "$prefix/frontend" && npm ci --silent && npm run build --silent); fi
install -m 0644 "$src/deploy/biocompute.service" /etc/systemd/system/biocompute.service
systemctl daemon-reload
echo "Next: docker compose up -d db web   (from $prefix)"
echo "      systemctl enable --now biocompute"
echo "      cat /var/lib/biocompute/initial_admin_password.txt"
