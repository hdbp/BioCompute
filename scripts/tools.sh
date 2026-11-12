#!/usr/bin/env bash
# Check for the tools BioCompute works with and offer to install the ones this computer does not have yet:
# Nextflow (and its Java), refgenie, and the programs the built-in pipeline modules run (FastQC, Bowtie2, ...).
#
#   scripts/tools.sh              report, and ask before installing anything
#   scripts/tools.sh --yes        install what is missing without asking
#   scripts/tools.sh --check      only report
#
# Called by ./install.sh; run it again any time. Nothing is installed without your yes.
#   Nextflow  -> ~/.local/bin/nextflow (official installer, get.nextflow.io); needs Java 17 or newer
#   Java      -> your distribution's OpenJDK package (asks for sudo)
#   refgenie  -> BioCompute's own Python environment, linked as ~/.local/bin/refgenie
#   module tools (only the missing ones) -> a private bioconda environment, ~/.local/share/biocompute/tools,
#                used by BioCompute after your own PATH; micromamba is offered if you have no conda
# What it finds or installs is written to the BioCompute configuration, so the service uses it.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
venv="${BIOCOMPUTE_VENV:-$root/backend/.venv}"
config="${BIOCOMPUTE_CONFIG:-$root/backend/.env}"
bindir="${BIOCOMPUTE_BIN_DIR:-$HOME/.local/bin}"
nxf_url="${NXF_INSTALL_URL:-https://get.nextflow.io}"
genome_dir="${BIOCOMPUTE_REFGENIE_DIR:-$HOME/refgenie}"
assume=ask

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) assume=yes; shift ;;
    --check) assume=no; shift ;;
    --config) config="${2:?--config needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option $1 (see scripts/tools.sh --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[1;32mok\033[0m  %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
note() { printf '        %s\n' "$*"; }

# yes/no question; without a terminal (or with --check) the answer is no, and --yes answers yes
ask() {
  [ "$assume" = yes ] && return 0
  [ "$assume" = no ] && return 1
  [ -r /dev/tty ] && [ -w /dev/tty ] || return 1
  local a
  printf '\033[1;36m ?\033[0m  %s [Y/n] ' "$1" > /dev/tty
  IFS= read -r a < /dev/tty || return 1
  case "$a" in ""|y|Y|yes|Yes) return 0 ;; *) return 1 ;; esac
}

cfg_get() { [ -f "$config" ] || return 0; python3 - "$config" "$1" <<'PY'
import sys
from pathlib import Path
for ln in Path(sys.argv[1]).read_text().splitlines():
    k, _, v = ln.partition("=")
    if k.strip() == sys.argv[2]:
        print(v.strip().strip("'\""))
PY
}
cfg_set() { [ -f "$config" ] || return 0; python3 - "$config" "$1" "$2" <<'PY'
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

find_tool() {  # on PATH, or where this script installs it
  command -v "$1" 2>/dev/null && return 0
  [ -x "$bindir/$1" ] && { echo "$bindir/$1"; return 0; }
  return 1
}

java_major() {
  command -v java >/dev/null 2>&1 || return 1
  java -version 2>&1 | sed -n 's/.*version "\([0-9]*\)\.\{0,1\}\([0-9]*\).*/\1 \2/p' | head -1 | awk '{ print ($1 == 1 ? $2 : $1) }'
}

install_java() {
  local SUDO=""
  [ "$(id -u)" -eq 0 ] || SUDO=sudo
  if [ -n "$SUDO" ] && ! command -v sudo >/dev/null 2>&1; then return 1; fi
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -qq && { $SUDO apt-get install -y openjdk-21-jre-headless || $SUDO apt-get install -y openjdk-17-jre-headless; }
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y java-21-openjdk-headless || $SUDO dnf install -y java-17-openjdk-headless
  elif command -v yum >/dev/null 2>&1; then
    $SUDO yum install -y java-17-openjdk-headless
  elif command -v zypper >/dev/null 2>&1; then
    $SUDO zypper --non-interactive install java-21-openjdk-headless || $SUDO zypper --non-interactive install java-17-openjdk-headless
  elif command -v pacman >/dev/null 2>&1; then
    $SUDO pacman -S --noconfirm jre-openjdk-headless
  else
    return 1
  fi
}

# ----------------------------------------------------------------------------- Nextflow
say "Nextflow (runs nf-core and other Nextflow pipelines)"
nf="$(find_tool nextflow || true)"
if [ -n "$nf" ]; then
  ok "found: $nf"
else
  jm="$(java_major || true)"
  if [ -z "$jm" ] || [ "$jm" -lt 17 ]; then
    warn "Nextflow needs Java 17 or newer (${jm:+found Java $jm}${jm:-no Java found})."
    if ask "Install OpenJDK with your system's package manager (uses sudo)?"; then
      install_java || warn "Could not install Java automatically. Install OpenJDK 17+ (or use https://sdkman.io: sdk install java 21-tem) and run scripts/tools.sh again."
      jm="$(java_major || true)"
    fi
  fi
  if [ -n "$jm" ] && [ "$jm" -ge 17 ]; then
    if ask "Nextflow is not installed. Install it into $bindir (downloads the official installer from ${nxf_url#https://})?"; then
      command -v curl >/dev/null 2>&1 || { warn "curl is needed to download Nextflow"; }
      tmp="$(mktemp -d)"
      if curl -fsSL --retry 3 "$nxf_url" -o "$tmp/install.sh" && (cd "$tmp" && bash install.sh >"$tmp/log" 2>&1) && [ -f "$tmp/nextflow" ]; then
        mkdir -p "$bindir"
        install -m 0755 "$tmp/nextflow" "$bindir/nextflow"
        nf="$bindir/nextflow"
        if "$nf" -version >"$tmp/version" 2>&1; then
          ok "installed: $nf ($(grep -i -m1 'version' "$tmp/version" | sed 's/^ *//'))"
        else
          warn "Installed $nf, but 'nextflow -version' failed:"; tail -n 5 "$tmp/version" >&2 || true
        fi
      else
        warn "Installing Nextflow failed$( [ -s "$tmp/log" ] && echo ':' )"; [ -s "$tmp/log" ] && tail -n 5 "$tmp/log" >&2
        note "By hand: curl -s https://get.nextflow.io | bash && mv nextflow $bindir/"
      fi
      rm -rf "$tmp"
    else
      note "Not installed. Later: scripts/tools.sh   (or: curl -s https://get.nextflow.io | bash && mv nextflow $bindir/)"
    fi
  else
    note "Nextflow not installed (no suitable Java). The built-in engine still runs Studio pipelines."
  fi
fi
if [ -n "$nf" ]; then
  [ "$(cfg_get BIOCOMPUTE_NEXTFLOW_BIN)" = "$nf" ] || cfg_set BIOCOMPUTE_NEXTFLOW_BIN "$nf"
  if ! command -v docker >/dev/null 2>&1 && ! command -v apptainer >/dev/null 2>&1 && ! command -v singularity >/dev/null 2>&1 \
     && ! command -v conda >/dev/null 2>&1 && ! command -v mamba >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
    note "No Docker, Apptainer/Singularity, Podman or conda found: nf-core pipelines need one of them to provide their tools."
  fi
fi

# ----------------------------------------------------------------------------- refgenie
say "refgenie (reference genomes: FASTA, aligner indexes, annotations)"
rg="$(find_tool refgenie || true)"
[ -n "$rg" ] || { [ -x "$venv/bin/refgenie" ] && rg="$venv/bin/refgenie"; }
if [ -n "$rg" ]; then
  ok "found: $rg"
elif [ ! -x "$venv/bin/pip" ]; then
  note "refgenie not found, and BioCompute's Python environment is not there yet ($venv). Run ./install.sh first."
elif ask "refgenie is not installed. Install it into BioCompute's Python environment and link it as $bindir/refgenie?"; then
  if "$venv/bin/pip" install -q refgenie; then
    mkdir -p "$bindir"
    ln -sf "$venv/bin/refgenie" "$bindir/refgenie"
    rg="$bindir/refgenie"
    ok "installed: $rg ($("$rg" --version 2>&1 | head -1))"
  else
    warn "Installing refgenie failed (pip). BioCompute still reads an existing refgenie genome folder without it."
  fi
else
  note "Not installed. Later: scripts/tools.sh   (BioCompute can read an existing genome folder without the refgenie command)"
fi

# a genome configuration: yours ($REFGENIE, Settings, common places) or a new one
rg_cfg="$(cfg_get BIOCOMPUTE_REFGENIE_CONFIG)"
if [ -z "$rg_cfg" ]; then
  for c in "${REFGENIE:-}" "$HOME/.refgenie/genome_config.yaml" "$HOME/refgenie/genome_config.yaml" "$HOME/refgenomes/genome_config.yaml" \
           /data/refgenie/genome_config.yaml /opt/refgenie/genome_config.yaml; do
    [ -n "$c" ] && [ -e "$c" ] && { rg_cfg="$c"; break; }
  done
  [ -n "$rg_cfg" ] && cfg_set BIOCOMPUTE_REFGENIE_CONFIG "$rg_cfg"
fi
if [ -n "$rg_cfg" ]; then
  ok "genome configuration: $rg_cfg (read-only for BioCompute)"
elif [ -n "$rg" ]; then
  if ask "No refgenie genome folder found. Create an empty one in $genome_dir?"; then
    mkdir -p "$genome_dir"
    if "$rg" init -c "$genome_dir/genome_config.yaml" >/dev/null 2>&1 && [ -f "$genome_dir/genome_config.yaml" ]; then
      rg_cfg="$genome_dir/genome_config.yaml"
      cfg_set BIOCOMPUTE_REFGENIE_CONFIG "$rg_cfg"
      ok "created: $rg_cfg"
      note "Add genomes with refgenie, e.g.:  refgenie pull hg38/fasta hg38/bowtie2_index -c $rg_cfg"
      note "For your shell:  export REFGENIE=$rg_cfg   (add it to ~/.bashrc or ~/.zshrc)"
    else
      warn "refgenie init failed. By hand: refgenie init -c $genome_dir/genome_config.yaml, then set it in Settings."
    fi
  else
    note "No genome folder. Later: refgenie init -c /path/genome_config.yaml, then set it in Settings, Controller, Reference genomes."
  fi
fi

# ----------------------------------------------------------------------------- tools of the built-in modules
say "Tools used by BioCompute's built-in pipeline modules"
datadir="${XDG_DATA_HOME:-$HOME/.local/share}/biocompute"
tools_env="${BIOCOMPUTE_TOOLS_ENV:-$datadir/tools}"
if [ ! -x "$venv/bin/python" ]; then
  note "BioCompute's Python environment is not there yet ($venv). Run ./install.sh first."
else
  # exe <TAB> conda package <TAB> modules using it; only for modules that name a package
  needed="$(cd "$root/backend" && "$venv/bin/python" - <<'PY'
from app.services.studio_modules import MODULES
rows = {}
for m in MODULES:
    specs = (m.get("conda") or "").split()
    for exe in m.get("tools") or []:
        spec = next((s for s in specs if exe.lower() in s.lower()), specs[0] if len(specs) == 1 else None)
        if spec:
            rows.setdefault(exe, [spec, []])[1].append(m["name"])
for exe, (spec, mods) in rows.items():
    print(f"{exe}\t{spec}\t{', '.join(mods)}")
PY
)"
  missing_exes=(); missing_specs=()
  while IFS=$'\t' read -r exe spec mods; do
    [ -n "$exe" ] || continue
    if command -v "$exe" >/dev/null 2>&1 || [ -x "$tools_env/bin/$exe" ]; then continue; fi  # already on this system: not offered
    missing_exes+=("$exe")
    case " ${missing_specs[*]:-} " in *" $spec "*) ;; *) missing_specs+=("$spec") ;; esac
    note "missing: $exe  (used by: $mods)"
  done <<< "$needed"
  if [ ${#missing_exes[@]} -eq 0 ]; then
    ok "all present"
  else
    conda="${BIOCOMPUTE_CONDA:-}"
    [ -n "$conda" ] || conda="$(command -v micromamba || command -v mamba || command -v conda || true)"
    [ -n "$conda" ] || { [ -x "$bindir/micromamba" ] && conda="$bindir/micromamba"; }
    if [ -z "$conda" ]; then
      case "$(uname -m)" in x86_64) plat=linux-64 ;; aarch64|arm64) plat=linux-aarch64 ;; *) plat="" ;; esac
      mm_url="${MICROMAMBA_URL:-https://micro.mamba.pm/api/micromamba/$plat/latest}"
      if [ -n "$plat" ] && ask "These come from bioconda, and no conda, mamba or micromamba was found. Install micromamba (one small program) into $bindir?"; then
        tmp="$(mktemp -d)"
        if curl -fsSL --retry 3 "$mm_url" -o "$tmp/mm.tar.bz2" && tar -xjf "$tmp/mm.tar.bz2" -C "$tmp" bin/micromamba; then
          mkdir -p "$bindir"; install -m 0755 "$tmp/bin/micromamba" "$bindir/micromamba"; conda="$bindir/micromamba"
          ok "installed: $conda"
        else
          warn "Downloading micromamba failed (see https://mamba.readthedocs.io/en/latest/installation/micromamba-installation.html)."
        fi
        rm -rf "$tmp"
      fi
    fi
    if [ -z "$conda" ]; then
      note "Not installed. With conda available: scripts/tools.sh   Missing: ${missing_exes[*]}"
    elif ask "Install the ${#missing_exes[@]} missing tool(s) (${missing_exes[*]}) from bioconda into $tools_env? (downloads up to a few GB, takes several minutes)"; then
      mkdir -p "$datadir"
      verb=create; [ -d "$tools_env/conda-meta" ] && verb=install
      if MAMBA_ROOT_PREFIX="${MAMBA_ROOT_PREFIX:-$datadir/micromamba}" "$conda" "$verb" -y -p "$tools_env" -c conda-forge -c bioconda "${missing_specs[@]}"; then
        cfg_set BIOCOMPUTE_TOOLS_PATH "$tools_env/bin"
        still=()
        for exe in "${missing_exes[@]}"; do [ -x "$tools_env/bin/$exe" ] || still+=("$exe"); done
        if [ ${#still[@]} -eq 0 ]; then ok "installed into $tools_env (BioCompute uses it for tools your system does not have)"
        else warn "Installed, but still missing: ${still[*]}"; fi
      else
        warn "Installing the tools failed (see the messages above). Run scripts/tools.sh again to retry."
      fi
    else
      note "Not installed. Modules needing them show as unavailable in Pipeline Studio. Later: scripts/tools.sh"
    fi
  fi
  [ -d "$tools_env/bin" ] && [ -z "$(cfg_get BIOCOMPUTE_TOOLS_PATH)" ] && cfg_set BIOCOMPUTE_TOOLS_PATH "$tools_env/bin"
fi

case ":$PATH:" in *":$bindir:"*) ;; *) [ -n "$nf$rg" ] && [ -d "$bindir" ] && note "$bindir is not on your PATH: add it to use these commands in a terminal (export PATH=\"$bindir:\$PATH\")." ;; esac
exit 0
