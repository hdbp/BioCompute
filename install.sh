#!/usr/bin/env bash
# BioCompute controller: install (or update) and run as a service, in one step.
#
#   ./install.sh                         install or update, enable and start the service
#   ./install.sh --data /data/raw ...    also register raw-data folders (read-only, restricted); repeatable
#   ./install.sh --port 8045             port on this computer (default 8045, or the one already configured)
#   ./install.sh --no-tailnet            do not publish BioCompute on your Tailscale network
#   ./install.sh --user                  user service (no sudo); starts at boot only if lingering is allowed
#   ./install.sh --no-service            prepare everything but do not install a service (print how to start)
#   ./install.sh --uninstall             stop and remove the service (keeps your data and settings)
#   ./install.sh --yes                   install missing tools (Nextflow, refgenie, module tools) without asking
#   ./install.sh --no-tools              do not check for or offer those tools
#   ./install.sh --no-run-account        run pipelines under your account (default: a separate account, biocompute-run,
#                                        so pipeline code cannot read BioCompute's database or keys; needs sudo once)
#
# Runs as you (not root): the service runs under your account, so it can read your data with your permissions.
# sudo is asked for only to install the system service and to configure `tailscale serve`.
# Re-running updates: new Python packages, a rebuilt UI and a restarted service (database upgrades are automatic).
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
backend="$root/backend"
frontend="$root/frontend"
name=biocompute
port=""
mode=system
tailnet=auto
service=yes
uninstall=no
tools=ask
run_account=yes
data_dirs=()

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port) port="${2:?--port needs a number}"; shift 2 ;;
    --data) data_dirs+=("${2:?--data needs a folder}"); shift 2 ;;
    --user) mode=user; shift ;;
    --no-tailnet) tailnet=no; shift ;;
    --tailnet) tailnet=yes; shift ;;
    --no-service) service=no; shift ;;
    --uninstall) uninstall=yes; shift ;;
    --yes|-y) tools=yes; shift ;;
    --no-tools) tools=no; shift ;;
    --no-run-account) run_account=no; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option $1 (see ./install.sh --help)" ;;
  esac
done

[ "$(uname -s)" = Linux ] || die "The controller service installer supports Linux (systemd). On macOS use scripts/dev.sh."
[ "$(id -u)" -ne 0 ] || die "Run ./install.sh as your normal user, not with sudo: the service runs as the account that owns the data. It asks for sudo when needed."

SUDO=""
if [ "$mode" = system ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO=sudo; else warn "sudo not found: installing a user service instead"; mode=user; fi
fi
sctl() { if [ "$mode" = system ]; then $SUDO systemctl "$@"; else systemctl --user "$@"; fi; }
unit_path() { if [ "$mode" = system ]; then echo "/etc/systemd/system/$name.service"; else echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$name.service"; fi; }

tailscale_up() { command -v tailscale >/dev/null 2>&1 && tailscale status --json >/dev/null 2>&1 && \
  tailscale status --json | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("BackendState")=="Running" else 1)'; }

# ----------------------------------------------------------------------------- uninstall
if [ "$uninstall" = yes ]; then
  for m in system user; do
    mode=$m
    if [ -f "$(unit_path)" ]; then
      say "Stopping and removing the $m service"
      sctl disable --now "$name" || true
      if [ "$m" = system ]; then $SUDO rm -f "$(unit_path)"; else rm -f "$(unit_path)"; fi
      sctl daemon-reload || true
    fi
  done
  if tailscale_up && tailscale serve status 2>/dev/null | grep -q "127.0.0.1"; then
    say "Removing the tailnet address (tailscale serve)"
    sudo tailscale serve --https=443 off 2>/dev/null || tailscale serve --https=443 off 2>/dev/null || warn "Run: sudo tailscale serve reset"
  fi
  say "Done. Your data, database and settings are untouched (see $backend/.env)."
  exit 0
fi

# ----------------------------------------------------------------------------- prerequisites
say "Checking prerequisites"
command -v python3 >/dev/null || die "python3 is missing. Install Python 3.11 or newer (e.g. sudo apt install python3 python3-venv)."
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || die "Python 3.11 or newer is needed (found $(python3 --version))."
python3 -c 'import venv, ensurepip' 2>/dev/null || die "Python's venv module is missing: sudo apt install python3-venv (or python3.X-venv for your version)."
command -v npm >/dev/null || die "Node.js (18 or newer) and npm are needed to build the web interface: e.g. sudo apt install nodejs npm, or https://nodejs.org"
node -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)' || die "Node.js 18 or newer is needed (found $(node --version))."
command -v systemctl >/dev/null || [ "$service" = no ] || die "systemd is needed for the service (or use --no-service)."

# ----------------------------------------------------------------------------- python + ui
say "Installing the Python environment"
[ -x "$backend/.venv/bin/python" ] || python3 -m venv "$backend/.venv"
"$backend/.venv/bin/pip" install -q --upgrade pip >/dev/null
"$backend/.venv/bin/pip" install -q -r "$backend/requirements.txt"

say "Building the web interface"
# Downloads from the npm registry: prefer IPv4 (a common cause of ETIMEDOUT is IPv6 that is configured but not
# routed), long timeouts and retries for slow links, and three whole attempts.
npm_install() {
  local i
  for i in 1 2 3; do
    if (cd "$frontend" && NODE_OPTIONS="--dns-result-order=ipv4first ${NODE_OPTIONS:-}" \
        npm ci --no-audit --no-fund --loglevel=error --fetch-retries=5 --fetch-retry-mintimeout=20000 \
               --fetch-retry-maxtimeout=120000 --fetch-timeout=600000); then
      return 0
    fi
    [ "$i" -lt 3 ] && { warn "Downloading the web interface's packages failed (attempt $i of 3); trying again"; sleep $((i * 10)); }
  done
  return 1
}
stamp="$frontend/node_modules/.biocompute-lock"
ui_ready=yes
if [ ! -d "$frontend/node_modules" ] || ! cmp -s "$frontend/package-lock.json" "$stamp"; then
  if npm_install; then
    cp "$frontend/package-lock.json" "$stamp"
  else
    ui_ready=no
  fi
fi
if [ "$ui_ready" = yes ]; then
  (cd "$frontend" && npm run --silent build >/dev/null) || die "Building the web interface failed (run: cd frontend && npm run build)"
elif [ -f "$frontend/dist/index.html" ]; then
  warn "Could not download the packages needed to rebuild the web interface; keeping the one built earlier."
  warn "Run ./install.sh again when the network works to get the newest interface."
else
  die "Could not download the web interface's packages from $(npm config get registry 2>/dev/null || echo the npm registry).
    This computer could not reach it in time. Things to check:
      - internet access:  curl -sI https://registry.npmjs.org/ | head -1
      - a proxy, if your network needs one:  npm config set proxy http://PROXY:PORT && npm config set https-proxy http://PROXY:PORT
      - or try again later (the download is about 100 MB the first time)
    Then run ./install.sh again."
fi

# ----------------------------------------------------------------------------- configuration
# One file, used by the service and by `python -m app.cli`: backend/.env (or a symlink to ~/.config/biocompute).
config="$backend/.env"
if [ ! -e "$config" ]; then
  cfgdir="${XDG_CONFIG_HOME:-$HOME/.config}/biocompute"
  datadir="${XDG_DATA_HOME:-$HOME/.local/share}/biocompute"
  mkdir -p "$cfgdir"
  real="$cfgdir/biocompute.env"
  if [ ! -f "$real" ]; then
    say "Writing the configuration ($real)"
    if [ -f "$root/var/biocompute.db" ]; then
      # keep the database, accounts and pipelines of an earlier scripts/dev.sh setup
      db="$root/var/biocompute.db"; state="$root/var/state"
      say "Reusing your existing database $db"
    else
      mkdir -p "$datadir"; db="$datadir/biocompute.db"; state="$datadir/state"
    fi
    results="$HOME/biocompute-results"; mkdir -p "$results"
    BC_DB="$db" BC_STATE="$state" BC_RESULTS="$results" BC_DEMO="$root/var/demo" BC_ROOT="$root" BC_PORT="${port:-8045}" \
    python3 - "$real" <<'PY'
import json, os, socket, sys
roots = [{"name": "results", "path": os.environ["BC_RESULTS"], "restricted": False, "writable": True, "description": "Pipeline results"}]
demo = os.environ["BC_DEMO"]
if os.path.isdir(demo) and os.environ["BC_DB"].startswith(os.environ["BC_ROOT"]):  # the dev.sh demo folders, so old runs still resolve
    roots += [{"name": "raw", "path": f"{demo}/raw", "restricted": True, "writable": False, "description": "Demo raw data (synthetic)"},
              {"name": "analyses", "path": f"{demo}/analyses", "restricted": False, "writable": True, "description": "Demo outputs"}]
lines = [
    "# BioCompute controller configuration, written by install.sh. Edit, then: ./install.sh (or restart the service).",
    "# Data folders can also be added in Settings, Controller, Data folders.",
    f"BIOCOMPUTE_DATABASE_URL=sqlite:///{os.environ['BC_DB']}",
    f"BIOCOMPUTE_STATE_DIR={os.environ['BC_STATE']}",
    f"BIOCOMPUTE_DATA_ROOTS={json.dumps(roots)}",
    f"BIOCOMPUTE_SITE_NAME={socket.gethostname().split('.')[0]}",
    f"BIOCOMPUTE_PORT={os.environ['BC_PORT']}",
]
with open(sys.argv[1], "w") as fh:
    fh.write("\n".join(lines) + "\n")
os.chmod(sys.argv[1], 0o600)
PY
  fi
  ln -s "$real" "$config"
fi

# KEY=value upsert, and data folders from --data (read-only, restricted)
cfg_set() { python3 - "$config" "$1" "$2" <<'PY'
import sys
path, key, val = sys.argv[1:]
lines = open(path).read().splitlines()
out, done = [], False
for ln in lines:
    if ln.split("=", 1)[0].strip() == key:
        out.append(f"{key}={val}"); done = True
    else:
        out.append(ln)
if not done:
    out.append(f"{key}={val}")
open(path, "w").write("\n".join(out) + "\n")
PY
}
cfg_get() { python3 - "$config" "$1" <<'PY'
import sys
from pathlib import Path
for ln in Path(sys.argv[1]).read_text().splitlines():
    k, _, v = ln.partition("=")
    if k.strip() == sys.argv[2]:
        print(v.strip().strip("'\""))
PY
}
if [ ${#data_dirs[@]} -gt 0 ]; then
  for d in "${data_dirs[@]}"; do
    [ -d "$d" ] || die "--data $d: not a folder"
  done
  python3 - "$config" "${data_dirs[@]}" <<'PY'
import json, os, re, sys
path, dirs = sys.argv[1], sys.argv[2:]
lines = open(path).read().splitlines()
idx = next((i for i, l in enumerate(lines) if l.startswith("BIOCOMPUTE_DATA_ROOTS=")), None)
roots = json.loads(lines[idx].split("=", 1)[1].strip().strip("'")) if idx is not None else []
for d in dirs:
    real = os.path.realpath(d)
    if any(os.path.realpath(r["path"]) == real for r in roots):
        continue
    base = re.sub(r"[^A-Za-z0-9_.-]+", "-", os.path.basename(real)).strip("-") or "data"
    name, i = base, 2
    while any(r["name"] == name for r in roots):
        name, i = f"{base}-{i}", i + 1
    roots.append({"name": name, "path": real, "restricted": True, "writable": False, "description": "Raw data"})
    print(f"    data folder {name} -> {real}")
line = f"BIOCOMPUTE_DATA_ROOTS={json.dumps(roots)}"
if idx is None:
    lines.append(line)
else:
    lines[idx] = line
open(path, "w").write("\n".join(lines) + "\n")
PY
fi
[ -n "$port" ] && cfg_set BIOCOMPUTE_PORT "$port"
# refgenie: the service does not see your shell's $REFGENIE, so remember it (read-only use; nothing is written there)
if [ -n "${REFGENIE:-}" ] && [ -e "$REFGENIE" ] && [ -z "$(cfg_get BIOCOMPUTE_REFGENIE_CONFIG)" ]; then
  say "Using your refgenie genomes from $REFGENIE (read-only)"
  cfg_set BIOCOMPUTE_REFGENIE_CONFIG "$REFGENIE"
fi
port="$(cfg_get BIOCOMPUTE_PORT)"; port="${port:-8045}"
state_dir="$(cfg_get BIOCOMPUTE_STATE_DIR)"; state_dir="${state_dir:-$backend/var/state}"
mkdir -p "$state_dir"
if [ "$tailnet" != no ] && tailscale_up && [ -z "$(cfg_get BIOCOMPUTE_AGENT_LISTEN)" ]; then
  cfg_set BIOCOMPUTE_AGENT_LISTEN tailscale   # workers on the tailnet enroll and report through it
fi

# ----------------------------------------------------------------------------- tools (Nextflow, refgenie, module tools)
# Reports what is there and offers to install what is missing; nothing is installed without a yes.
if [ "$tools" != no ]; then
  targs=(--config "$config"); [ "$tools" = yes ] && targs+=(--yes)
  "$root/scripts/tools.sh" "${targs[@]}" || warn "Checking the tools failed; run scripts/tools.sh later."
fi
# commands installed into ~/.local/bin must be visible to the service
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) [ -d "$HOME/.local/bin" ] && PATH="$HOME/.local/bin:$PATH" ;; esac

# ----------------------------------------------------------------------------- run account
# Pipeline code runs as a separate system account (biocompute-run) in systemd units with OS-enforced CPU and memory
# limits; it cannot read BioCompute's database, signing key or configuration. scripts/run-account.py does the setup:
# the account, ACLs on the data folders, a root-owned helper and a sudo rule for that helper only.
if [ "$run_account" = yes ] && [ "$mode" = system ] && [ "$service" = yes ]; then
  if ! command -v setfacl >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    say "Installing the acl package (setfacl), needed to give the run account access to your data folders"
    $SUDO apt-get install -y -q acl >/dev/null || warn "Could not install acl"
  fi
  if command -v setfacl >/dev/null 2>&1; then
    say "Setting up the separate account that runs pipelines (biocompute-run)"
    rtools=()
    for t in nextflow java conda mamba micromamba apptainer singularity; do
      p="$(command -v "$t" 2>/dev/null || true)"; [ -n "$p" ] && [ -x "$p" ] && rtools+=(--tool "$p")
    done
    if $SUDO python3 "$root/scripts/run-account.py" setup --owner "$(id -un)" --config "$(readlink -f "$config")" \
         --backend "$backend" "${rtools[@]}"; then
      :
    else
      warn "Setting up the run account failed; pipelines run under your account. Retry: ./install.sh, or see docs/deployment.md"
      cfg_set BIOCOMPUTE_RUN_AS ""
    fi
  else
    warn "setfacl is missing (package acl): pipelines run under your account. Install acl and run ./install.sh again."
  fi
elif [ "$run_account" = no ] && [ -n "$(cfg_get BIOCOMPUTE_RUN_AS)" ]; then
  say "Pipelines will run under your account again (--no-run-account); remove the helper with: sudo python3 scripts/run-account.py remove"
  cfg_set BIOCOMPUTE_RUN_AS ""
elif [ "$mode" = user ]; then
  warn "User service: pipelines run under your account (a separate run account needs the system service and sudo)."
fi

# ----------------------------------------------------------------------------- service
exec_start="$backend/.venv/bin/python -m app.serve --config $config"
if [ "$service" = no ]; then
  say "Prepared. Start BioCompute with:"
  echo "    cd $backend && $exec_start"
  exit 0
fi

# the port must be free, unless it is our own service already running
if ! sctl is-active --quiet "$name" 2>/dev/null && \
   "$backend/.venv/bin/python" -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1', $port)) == 0 else 1)"; then
  die "Port $port is in use (another BioCompute, e.g. scripts/dev.sh?). Stop it, or choose another: ./install.sh --port 8050"
fi

unit="$(mktemp)"
cat > "$unit" <<EOF
# BioCompute controller (API, web interface and run supervisor). Written by $root/install.sh.
[Unit]
Description=BioCompute controller
Wants=network-online.target
After=network-online.target tailscaled.service

[Service]
Type=simple
$( [ "$mode" = system ] && printf 'User=%s\nGroup=%s\n' "$(id -un)" "$(id -gn)" )
WorkingDirectory=$backend
# your PATH at install time, so Nextflow, Java, conda and other tools resolve as they do for you
Environment=PATH=$PATH
Environment=HOME=$HOME
ExecStart=$exec_start
# analyses run in detached supervisors: restarting or stopping the service does not kill them
KillMode=process
# a pipeline step killed for using too much memory must not stop BioCompute or the other analyses
OOMPolicy=continue
Restart=on-failure
RestartSec=5
$( [ -n "$(cfg_get BIOCOMPUTE_RUN_AS)" ] && echo "# no NoNewPrivileges: runs start through sudo and the root-owned helper /usr/local/libexec/biocompute-runas" || echo "NoNewPrivileges=yes" )

[Install]
WantedBy=$( [ "$mode" = system ] && echo multi-user.target || echo default.target )
EOF
if command -v systemd-analyze >/dev/null 2>&1 && [ "$mode" = system ]; then
  systemd-analyze verify "$unit" 2>&1 | grep -v -e "^$" -e "is not a valid unit name" | grep -i "error" && warn "systemd reported problems with the unit (see above)" || true
fi
say "Installing the $mode service ($(unit_path))"
if [ "$mode" = system ]; then
  $SUDO install -m 0644 "$unit" "$(unit_path)"
else
  mkdir -p "$(dirname "$(unit_path)")"; install -m 0644 "$unit" "$(unit_path)"
  loginctl enable-linger "$(id -un)" 2>/dev/null || warn "Could not enable lingering: the user service starts when you log in, not at boot (sudo loginctl enable-linger $(id -un))"
fi
rm -f "$unit"
sctl daemon-reload
sctl enable "$name" >/dev/null 2>&1
sctl restart "$name"

say "Starting BioCompute"
ok=no
for _ in $(seq 1 60); do
  if curl -fs "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then ok=yes; break; fi
  sleep 1
done
if [ "$ok" != yes ]; then
  warn "BioCompute did not answer on port $port. Recent log:"
  if [ "$mode" = system ]; then $SUDO journalctl -u "$name" -n 40 --no-pager || true; else journalctl --user -u "$name" -n 40 --no-pager || true; fi
  exit 1
fi

# ----------------------------------------------------------------------------- tailnet address
url_tailnet=""
if [ "$tailnet" != no ] && tailscale_up; then
  dns="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"].get("DNSName","").rstrip("."))')"
  say "Publishing BioCompute on your tailnet (tailscale serve)"
  if sudo tailscale serve --bg --https=443 "http://127.0.0.1:$port" >/dev/null 2>&1 \
     || sudo tailscale serve --bg "$port" >/dev/null 2>&1; then
    url_tailnet="https://$dns"
    if [ "$(cfg_get BIOCOMPUTE_PUBLIC_URL)" != "$url_tailnet" ]; then
      cfg_set BIOCOMPUTE_PUBLIC_URL "$url_tailnet"; sctl restart "$name"
      for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && break; sleep 1; done
    fi
  else
    warn "tailscale serve did not work. Usually HTTPS certificates are off for your tailnet: enable MagicDNS and HTTPS"
    warn "in the Tailscale admin console (DNS page), then run ./install.sh again. Meanwhile use an SSH tunnel:"
    warn "    ssh -L $port:localhost:$port $(id -un)@${dns:-this-computer}   then open http://localhost:$port"
  fi
elif [ "$tailnet" = yes ]; then
  warn "Tailscale is not running here, so BioCompute is not published on a tailnet."
fi

# ----------------------------------------------------------------------------- summary
echo
say "BioCompute is running as the $mode service '$name' and starts automatically at boot."
echo "    On this computer:     http://127.0.0.1:$port"
[ -n "$url_tailnet" ] && echo "    From your tailnet:    $url_tailnet"
code_file="$state_dir/setup_code.txt"
if [ -f "$code_file" ]; then
  echo
  echo "    First run: open the address above and create your administrator account."
  echo "    From another computer it asks for this setup code:  $(cat "$code_file")"
fi
echo
echo "    Settings file:   $config"
if [ "$mode" = system ]; then
  echo "    Logs:            journalctl -u $name -f"
  echo "    Stop / start:    sudo systemctl stop $name   /   sudo systemctl start $name"
else
  echo "    Logs:            journalctl --user -u $name -f"
  echo "    Stop / start:    systemctl --user stop $name   /   systemctl --user start $name"
fi
echo "    Update:          git pull && ./install.sh"
echo "    Uninstall:       ./install.sh --uninstall   (keeps data and settings)"
