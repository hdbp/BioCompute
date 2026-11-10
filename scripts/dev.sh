#!/usr/bin/env bash
# Local development / demonstration launcher.
#  - creates a demo data area with SYNTHETIC FASTQ files (clearly labelled as such)
#  - runs the API on 127.0.0.1:8000 and the Vite dev server on :5173
# Uses BIOCOMPUTE_DATABASE_URL if set, otherwise SQLite under var/.
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
cd "$root/backend"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements-dev.txt; }
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 &
api=$!
trap 'kill $api 2>/dev/null' EXIT
cd "$root/frontend"
[ -d node_modules ] || npm ci
npm run dev -- --host 127.0.0.1
