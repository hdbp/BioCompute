#!/usr/bin/env bash
# Local development / demonstration launcher.
#  - creates a demo data area with SYNTHETIC FASTQ files (clearly labelled as such)
#  - runs the API on 127.0.0.1:$BIOCOMPUTE_API_PORT (default 8044) and the web UI on :$BIOCOMPUTE_UI_PORT (default 5173)
# Uses BIOCOMPUTE_DATABASE_URL if set, otherwise SQLite under var/.
# Your own defaults go in ~/.config/biocompute/dev.env (created on first run; never touched by git pull).
# A port taken by another program is skipped automatically (the next free one is used and printed).
#
#   scripts/dev.sh                          start the demo
#   scripts/dev.sh admin info               show the demo's database, state folder and users
#   scripts/dev.sh admin reset-password <name>   reset a password (add --create --role admin for a new admin)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

# ---- personal defaults (environment variables given on the command line still win)
devcfg="${XDG_CONFIG_HOME:-$HOME/.config}/biocompute/dev.env"
if [ ! -f "$devcfg" ]; then
  mkdir -p "$(dirname "$devcfg")"
  cat > "$devcfg" <<'CFG'
# Defaults for BioCompute's scripts/dev.sh (KEY=value, read on every start).
# A port that is taken by another program is skipped: the next free port is used and printed.
BIOCOMPUTE_API_PORT=8044
BIOCOMPUTE_UI_PORT=5173
# BIOCOMPUTE_AGENT_LISTEN=off          # off: other computers cannot enroll in the demo
# BIOCOMPUTE_DATABASE_URL=sqlite:////path/to/demo.db
CFG
  echo "Created $devcfg (edit it to change the demo's ports)"
fi
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
  key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
  val="${val%%[[:space:]]#*}"; val="${val%"${val##*[![:space:]]}"}"; val="${val#[\"\']}"; val="${val%[\"\']}"
  [ -n "${!key+x}" ] || export "$key=$val"   # already set in the environment: keep it
done < "$devcfg"
demo="$root/var/demo"
mkdir -p "$demo/raw" "$demo/analyses"
[ -d "$demo/raw/synthetic_chip_run" ] || python3 "$root/examples/data/generate_test_data.py" "$demo/raw/synthetic_chip_run" --reads 4000
export BIOCOMPUTE_STATE_DIR="${BIOCOMPUTE_STATE_DIR:-$root/var/state}"
export BIOCOMPUTE_DATABASE_URL="${BIOCOMPUTE_DATABASE_URL:-sqlite:///$root/var/biocompute.db}"
# No default password: on a new database the browser asks you to create the administrator account.
# (Set BIOCOMPUTE_ADMIN_PASSWORD to create an "admin" account without that step.)
if [ -z "${BIOCOMPUTE_DATA_ROOTS:-}" ]; then
  # (built separately: a "}" inside ${VAR:-default} would end the expansion early)
  BIOCOMPUTE_DATA_ROOTS=$(printf '[{"name":"raw","path":"%s","restricted":true,"writable":false,"description":"Demo raw data (synthetic)"},{"name":"analyses","path":"%s","restricted":false,"writable":true,"description":"Demo outputs"},{"name":"pipelines","path":"%s","restricted":false,"writable":false,"description":"Bundled example pipelines"}]' "$demo/raw" "$demo/analyses" "$root/examples/pipelines")
fi
export BIOCOMPUTE_DATA_ROOTS
port="${BIOCOMPUTE_API_PORT:-8044}"
ui_port="${BIOCOMPUTE_UI_PORT:-5173}"
# Workers on other machines enroll and report through a small agent-only listener on the tailnet address
# (UI and API stay on 127.0.0.1). Enabled automatically when Tailscale is up; BIOCOMPUTE_AGENT_LISTEN=off disables it.
if [ -z "${BIOCOMPUTE_AGENT_LISTEN:-}" ] && command -v tailscale >/dev/null 2>&1 && tailscale ip -4 >/dev/null 2>&1; then
  export BIOCOMPUTE_AGENT_LISTEN=tailscale
fi
cd "$root/backend"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements-dev.txt; }
if [ "${1:-}" = "admin" ]; then
  shift
  exec .venv/bin/python -m app.cli "$@"
fi
# First port from $1 that can be bound on 127.0.0.1 (a program on 0.0.0.0, e.g. a Docker container, also blocks it)
free_port() {
  .venv/bin/python - "$1" <<'PY'
import socket, sys
start = int(sys.argv[1])
reserved = {8045, 8765}  # the installed service (install.sh) and the worker-agent listener
for p in range(start, start + 100):
    if p in reserved and p != start:
        continue
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p))
    except OSError:
        continue
    finally:
        s.close()
    print(p)
    break
else:
    sys.exit(1)
PY
}
want=$port
port="$(free_port "$want")" || { echo "No free port from $want to $((want + 99))." >&2; exit 1; }
# A BioCompute already answering on a port we skipped (an earlier scripts/dev.sh): do not start a second one.
for p in $(seq "$want" $((port - 1))); do
  { [ "$p" = 8045 ] || [ "$p" = 8765 ]; } && [ "$p" != "$want" ] && continue  # the installed service may run beside the demo
  if curl -fs --max-time 2 "http://127.0.0.1:$p/api/health" 2>/dev/null | grep -Eq '"status":"ok","(service":"biocompute|time)"'; then
    echo "BioCompute is already running on port $p (an earlier scripts/dev.sh?). Use it, or stop it first (Ctrl+C in its terminal)." >&2
    exit 1
  fi
done
[ "$port" = "$want" ] || echo "Port $want is taken by another program; the API uses port $port instead (default set in $devcfg)."
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$port" &
api=$!
trap 'kill $api 2>/dev/null' EXIT
for _ in $(seq 1 60); do
  kill -0 $api 2>/dev/null || { echo "The API failed to start; see the messages above." >&2; exit 1; }
  curl -fs "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
echo "API ready on http://127.0.0.1:$port"
want_ui=$ui_port
ui_port="$(free_port "$want_ui")" || { echo "No free port from $want_ui." >&2; exit 1; }
[ "$ui_port" = "$want_ui" ] || echo "Port $want_ui is taken; the web UI uses port $ui_port instead."
echo "Open http://127.0.0.1:$ui_port - on first start it asks you to create the administrator account."
if [ "${BIOCOMPUTE_AGENT_LISTEN:-off}" != "off" ]; then
  echo "Workers enroll via the agent listener on ${BIOCOMPUTE_AGENT_LISTEN} (port ${BIOCOMPUTE_AGENT_PORT:-8765}); see the API log line above for the address"
else
  echo "Agent listener off: other machines cannot enroll (start Tailscale, or set BIOCOMPUTE_AGENT_LISTEN=<ip>:8765)"
fi
cd "$root/frontend"
[ -d node_modules ] || npm ci
BIOCOMPUTE_API="http://127.0.0.1:$port" npm run dev -- --host 127.0.0.1 --port "$ui_port" --strictPort
