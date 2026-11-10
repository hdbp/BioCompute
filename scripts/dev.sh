#!/usr/bin/env bash
# Local development / demonstration launcher.
#  - creates a demo data area with SYNTHETIC FASTQ files (clearly labelled as such)
#  - runs the API on 127.0.0.1:$BIOCOMPUTE_API_PORT (default 8000) and the Vite dev server on :5173
# Uses BIOCOMPUTE_DATABASE_URL if set, otherwise SQLite under var/.
#
#   scripts/dev.sh                          start the demo
#   scripts/dev.sh admin info               show the demo's database, state folder and users
#   scripts/dev.sh admin reset-password     reset the demo admin password
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
demo="$root/var/demo"
mkdir -p "$demo/raw" "$demo/analyses"
[ -d "$demo/raw/synthetic_chip_run" ] || python3 "$root/examples/data/generate_test_data.py" "$demo/raw/synthetic_chip_run" --reads 4000
export BIOCOMPUTE_STATE_DIR="${BIOCOMPUTE_STATE_DIR:-$root/var/state}"
export BIOCOMPUTE_DATABASE_URL="${BIOCOMPUTE_DATABASE_URL:-sqlite:///$root/var/biocompute.db}"
export BIOCOMPUTE_ADMIN_PASSWORD="${BIOCOMPUTE_ADMIN_PASSWORD:-biocompute-dev}"
if [ -z "${BIOCOMPUTE_DATA_ROOTS:-}" ]; then
  # (built separately: a "}" inside ${VAR:-default} would end the expansion early)
  BIOCOMPUTE_DATA_ROOTS=$(printf '[{"name":"raw","path":"%s","restricted":true,"writable":false,"description":"Demo raw data (synthetic)"},{"name":"analyses","path":"%s","restricted":false,"writable":true,"description":"Demo outputs"},{"name":"pipelines","path":"%s","restricted":false,"writable":false,"description":"Bundled example pipelines"}]' "$demo/raw" "$demo/analyses" "$root/examples/pipelines")
fi
export BIOCOMPUTE_DATA_ROOTS
port="${BIOCOMPUTE_API_PORT:-8000}"
cd "$root/backend"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements-dev.txt; }
if [ "${1:-}" = "admin" ]; then
  shift
  exec .venv/bin/python -m app.cli "$@"
fi
# Refuse to start if the API port is taken: the UI would otherwise talk to that other server.
if .venv/bin/python -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1', $port)) == 0 else 1)"; then
  echo "Port $port is already in use (another BioCompute or other program)." >&2
  echo "Stop it (see: ss -ltnp 'sport = :$port') or run: BIOCOMPUTE_API_PORT=8010 scripts/dev.sh" >&2
  exit 1
fi
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$port" &
api=$!
trap 'kill $api 2>/dev/null' EXIT
for _ in $(seq 1 60); do
  kill -0 $api 2>/dev/null || { echo "The API failed to start; see the messages above." >&2; exit 1; }
  curl -fs "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
echo "API ready on http://127.0.0.1:$port  -  log in as admin / ${BIOCOMPUTE_ADMIN_PASSWORD} (set only when the demo database is first created)"
cd "$root/frontend"
[ -d node_modules ] || npm ci
BIOCOMPUTE_API="http://127.0.0.1:$port" npm run dev -- --host 127.0.0.1
