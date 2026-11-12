#!/usr/bin/env python3
"""Set up the separate unix account that runs BioCompute pipelines (run as root, e.g. with sudo).

Pipeline code then runs as that account instead of the controller's: it cannot read BioCompute's database, signing
key or configuration, and each run is a systemd unit whose CPU and memory limits the kernel enforces.

  sudo python3 scripts/run-account.py setup --owner YOU --config backend/.env [--tool /path/to/nextflow ...]
  sudo python3 scripts/run-account.py grant [--write] FOLDER...     let the run account read (or write) a data folder
  sudo python3 scripts/run-account.py status
  sudo python3 scripts/run-account.py remove [--delete-account]

What setup does, and nothing else:
  * creates the system account (default biocompute-run, no login shell, home /var/lib/biocompute-run);
  * adds the controller's account to that account's group, so the controller can read and clean up run files;
  * grants the run account access with ACLs: read on the pipeline store, BioCompute's engine code, the tools and the
    read-only data folders; read and write on the writable data folders; pass-through (x) on the folders above them;
  * installs the helper /usr/local/libexec/biocompute-runas (root-owned) and /etc/biocompute/runas.json, and a sudoers
    rule that lets the controller's account run that helper, and nothing else, without a password;
  * sets BIOCOMPUTE_RUN_AS in BioCompute's configuration (restart the service to use it).
"""
from __future__ import annotations

import argparse
import grp
import json
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER_SRC = ROOT / "deploy" / "biocompute-runas"
HELPER = Path("/usr/local/libexec/biocompute-runas")
CONFIG = Path(os.environ.get("BIOCOMPUTE_RUNAS_CONFIG") or "/etc/biocompute/runas.json")
SUDOERS = Path("/etc/sudoers.d/biocompute-runas")
REFUSE = {"/", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/root", "/proc", "/sys", "/dev", "/run",
          "/var", "/var/lib", "/home", "/tmp", "/opt", "/srv", "/mnt", "/media"}
PRIVILEGED_GROUPS = {"root", "sudo", "wheel", "admin", "docker", "lxd", "libvirt", "disk", "shadow", "systemd-journal"}


def say(msg: str) -> None:
    print(f"\033[1;36m==>\033[0m {msg}")


def warn(msg: str) -> None:
    print(f"\033[1;33m!!\033[0m  {msg}", file=sys.stderr)


def die(msg: str) -> None:
    print(f"\033[1;31mxx\033[0m  {msg}", file=sys.stderr)
    sys.exit(1)


def sh(*cmd: str, check: bool = True, quiet: bool = False) -> subprocess.CompletedProcess:
    p = subprocess.run(list(cmd), capture_output=True, text=True)
    if check and p.returncode != 0:
        die(f"{' '.join(cmd)} failed: {(p.stderr or p.stdout).strip()}")
    if not quiet and p.returncode != 0:
        warn((p.stderr or p.stdout).strip())
    return p


def load_runas() -> dict:
    try:
        return json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        return {}


def save_runas(cfg: dict) -> None:
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, CONFIG)


def need_root() -> None:
    if os.geteuid() != 0:
        die("Run this as root: sudo python3 scripts/run-account.py ...")


def check_account(name: str) -> pwd.struct_passwd:
    try:
        pw = pwd.getpwnam(name)
    except KeyError:
        die(f"the account {name} does not exist (run setup first)")
    groups = {g.gr_name for g in grp.getgrall() if name in g.gr_mem} | {grp.getgrgid(pw.pw_gid).gr_name}
    if pw.pw_uid == 0 or groups & PRIVILEGED_GROUPS:
        die(f"{name} is privileged (uid 0 or in {', '.join(sorted(groups & PRIVILEGED_GROUPS))}); choose another account")
    return pw


# --------------------------------------------------------------------------- ACL grants
def _ancestors(p: Path) -> list[Path]:
    return [a for a in p.parents if str(a) != "/"]


def traverse(account: str, path: Path) -> None:
    """Pass-through (x) for the account on the folders above `path` that do not already allow everyone through."""
    for a in reversed(_ancestors(path)):
        try:
            if a.stat().st_mode & 0o001:
                continue
        except OSError:
            return
        sh("setfacl", "-m", f"u:{account}:x", str(a))


def grant(account: str, path: Path, mode: str, deny: list[str]) -> None:
    """mode: read (rX), write (rwX; files the account creates stay manageable by the controller through the group),
    traverse (x on the folder itself)."""
    p = path.resolve()
    if str(p) in REFUSE:
        die(f"refusing to grant access to {p} as a whole: name a folder inside it")
    if not p.exists():
        die(f"{p} does not exist")
    for d in deny:
        dp = Path(d)
        if mode != "traverse" and (dp == p or p in dp.parents):
            die(f"{p} contains {dp}, which the run account must not read; grant the folders inside it instead")
    traverse(account, p)
    if mode == "traverse":
        sh("setfacl", "-m", f"u:{account}:x", str(p))
        return
    perm = "rwX" if mode == "write" else "rX"
    entries = [f"u:{account}:{perm}"] + ([f"g:{account}:rwX"] if mode == "write" else [])
    sh("setfacl", "-R", "-m", ",".join(entries), str(p))
    if p.is_dir():
        sh("setfacl", "-R", "-d", "-m", ",".join(entries), str(p))


def record(cfg: dict, path: Path, mode: str) -> None:
    g = [x for x in cfg.get("granted", []) if x.get("path") != str(path.resolve())]
    g.append({"path": str(path.resolve()), "mode": mode})
    cfg["granted"] = g


def verify(account: str, cfg: dict) -> list[str]:
    """As the run account: can it read (write) what it was given, and is it kept out of the denied files?"""
    pw = pwd.getpwnam(account)
    q = {"read": [g["path"] for g in cfg.get("granted", []) if g["mode"] == "read"] + cfg.get("deny", []),
         "write": [g["path"] for g in cfg.get("granted", []) if g["mode"] == "write"]}
    code = ("import json,os,sys;q=json.load(sys.stdin);print(json.dumps({'read':{p:os.access(p,os.R_OK) for p in q['read']},"
            "'write':{p:os.access(p,os.W_OK|os.X_OK) for p in q['write']}}))")
    p = subprocess.run(["setpriv", f"--reuid={pw.pw_uid}", f"--regid={pw.pw_gid}", "--init-groups", "--",
                        "/usr/bin/python3", "-I", "-c", code], input=json.dumps(q), capture_output=True, text=True, cwd="/")
    if p.returncode != 0:
        return [f"could not check access as {account}: {p.stderr.strip()}"]
    res = json.loads(p.stdout)
    deny = set(cfg.get("deny", []))
    problems = [f"{account} cannot read {k} (a folder above it may have been made private: grant it again)"
                for k, ok in res["read"].items() if not ok and k not in deny]
    problems += [f"{account} CAN read {k}, which must stay private to the controller" for k, ok in res["read"].items()
                 if ok and k in deny and Path(k).exists()]
    problems += [f"{account} cannot write {k} (grant it again with --write)" for k, ok in res["write"].items() if not ok]
    return problems


# --------------------------------------------------------------------------- configuration of the controller
def read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for ln in path.read_text().splitlines():
        if "=" in ln and not ln.lstrip().startswith("#"):
            k, _, v = ln.partition("=")
            out[k.strip()] = v.strip().strip("'\"")
    return out


def set_env(path: Path, key: str, value: str) -> None:
    lines = path.read_text().splitlines()
    out, done = [], False
    for ln in lines:
        if ln.split("=", 1)[0].strip() == key:
            out.append(f"{key}={value}")
            done = True
        else:
            out.append(ln)
    if not done:
        out.append(f"{key}={value}")
    with open(path, "r+") as fh:  # in place: keeps the file's owner and mode
        fh.seek(0)
        fh.write("\n".join(out) + "\n")
        fh.truncate()


def tool_root(p: Path) -> Path:
    """The installation folder of a tool: .../bin/x -> ..."""
    real = p.resolve()
    return real.parent.parent if real.parent.name in ("bin", "condabin") else real.parent


# --------------------------------------------------------------------------- commands
def cmd_setup(a: argparse.Namespace) -> None:
    need_root()
    for tool in ("setfacl", "systemd-run", "setpriv", "useradd", "visudo"):
        if not shutil.which(tool):
            die(f"{tool} is missing" + (" (sudo apt install acl)" if tool == "setfacl" else ""))
    if not Path("/usr/bin/python3").exists():
        die("/usr/bin/python3 is needed for the helper")
    try:
        owner = pwd.getpwnam(a.owner)
    except KeyError:
        die(f"no account {a.owner}")
    if owner.pw_uid == 0:
        die("the controller must not run as root")
    envfile = Path(a.config).resolve()
    env = read_env(envfile)
    backend = Path(a.backend).resolve() if a.backend else ROOT / "backend"

    def path_of(key: str, default: str | None = None) -> Path | None:
        v = env.get(key) or default
        if not v:
            return None
        p = Path(os.path.expanduser(v))
        return p if p.is_absolute() else (backend / p).resolve()

    state = path_of("BIOCOMPUTE_STATE_DIR", "./var")
    pipelines = path_of("BIOCOMPUTE_PIPELINES_DIR") or state / "pipelines"
    runs = path_of("BIOCOMPUTE_RUNS_DIR") or state / "runs"
    db = env.get("BIOCOMPUTE_DATABASE_URL", "sqlite:///./var/biocompute.db")
    deny = [str(state / "secret.key"), str(envfile), str(backend / ".env")]
    if db.startswith("sqlite:///"):
        dbp = Path(db[len("sqlite:///"):])
        dbp = dbp if dbp.is_absolute() else (backend / dbp).resolve()
        deny += [str(dbp), f"{dbp}-wal", f"{dbp}-shm", f"{dbp}-journal"]
    acct = a.account
    try:
        pwd.getpwnam(acct)
        say(f"Using the existing account {acct}")
    except KeyError:
        say(f"Creating the system account {acct} (no login, home /var/lib/{acct})")
        sh("useradd", "--system", "--user-group", "--create-home", "--home-dir", f"/var/lib/{acct}",
           "--shell", "/usr/sbin/nologin", "--comment", "BioCompute pipeline runs", acct)
    pw = check_account(acct)
    if os.path.isdir(pw.pw_dir):
        os.chmod(pw.pw_dir, 0o750)
    say(f"Adding {a.owner} to the group {acct} (the controller reads and cleans up run files through it)")
    sh("usermod", "-aG", acct, a.owner)

    for d in (state, pipelines, runs):
        d.mkdir(parents=True, exist_ok=True)
        os.chown(d, owner.pw_uid, owner.pw_gid)
    cfg = load_runas()
    cfg.update({"account": acct, "owner": a.owner, "owner_uid": owner.pw_uid, "deny": deny})
    plan: list[tuple[Path, str]] = [(state, "traverse"), (runs, "traverse"), (pipelines, "read"),
                                    (backend / "app", "read"), (backend / ".venv", "read")]
    for key in ("BIOCOMPUTE_TOOLS_PATH",):
        p = path_of(key)
        if p and p.exists():
            plan.append((tool_root(p / "x") if p.name == "bin" else p, "read"))
    rg = path_of("BIOCOMPUTE_REFGENIE_CONFIG")
    if rg and rg.exists():
        plan.append((rg.parent, "read"))
    for t in a.tool or []:
        tp = Path(t)
        if tp.exists():
            root = tool_root(tp)
            # e.g. ~/.local/bin/nextflow: ~/.local also holds BioCompute's state, so only the program itself
            inside = any(Path(d) == root or root in Path(d).parents for d in deny)
            plan.append((tp.resolve() if inside else root, "read"))
    try:
        roots = json.loads(env.get("BIOCOMPUTE_DATA_ROOTS") or "[]")
    except ValueError:
        roots = []
    for r in roots:
        rp = Path(os.path.expanduser(r.get("path", "")))
        if rp.is_absolute() and rp.exists():
            plan.append((rp, "write" if r.get("writable") else "read"))
        elif r.get("path"):
            warn(f"data folder {r.get('name')} ({r.get('path')}) does not exist; grant it later with: grant {r.get('path')}")
    for p, mode in plan:
        if not p.exists():
            continue
        if any(Path(d) == p.resolve() or p.resolve() in Path(d).parents for d in deny) and mode != "traverse":
            warn(f"skipping {p}: it contains BioCompute's database or keys. Keep data folders outside the state folder.")
            continue
        say(f"  {mode:8} {p}")
        grant(acct, p, mode, deny)
        record(cfg, p, mode)
    save_runas(cfg)
    os.chmod(CONFIG.parent, 0o755)
    for msg in verify(acct, cfg):
        warn(msg)

    say(f"Installing the helper {HELPER}")
    HELPER.parent.mkdir(parents=True, exist_ok=True)
    tmp = HELPER.with_suffix(".tmp")
    shutil.copyfile(HELPER_SRC, tmp)
    os.chown(tmp, 0, 0)
    os.chmod(tmp, 0o755)
    os.replace(tmp, HELPER)

    say(f"Allowing {a.owner} to run the helper, and nothing else, with sudo ({SUDOERS})")
    rule = (f"# Written by BioCompute scripts/run-account.py: the controller ({a.owner}) may start pipeline runs as {acct}\n"
            f"# through this helper only. Remove with: sudo python3 scripts/run-account.py remove\n"
            f"Defaults!{HELPER} !requiretty\n"
            f"{a.owner} ALL=(root) NOPASSWD: {HELPER}\n")
    with tempfile.NamedTemporaryFile("w", delete=False, dir="/etc/sudoers.d", prefix=".biocompute-") as fh:
        fh.write(rule)
    os.chmod(fh.name, 0o440)
    chk = sh("visudo", "-cf", fh.name, check=False)
    if chk.returncode != 0:
        os.unlink(fh.name)
        die(f"the sudoers rule did not validate: {chk.stderr.strip()}")
    os.replace(fh.name, SUDOERS)

    nf = next((t for t in a.tool or [] if Path(t).name == "nextflow"), None)
    if nf:
        say(f"Preparing Nextflow for {acct} (downloads its framework into /var/lib/{acct}/.nextflow once)")
        p = subprocess.run(["runuser", "-u", acct, "--", "env", f"HOME={pw.pw_dir}", f"PATH={os.environ.get('PATH', '/usr/bin:/bin')}",
                            nf, "-version"], capture_output=True, text=True, timeout=600, cwd=pw.pw_dir)
        if p.returncode != 0:
            warn(f"nextflow -version as {acct} failed (the first run will try again): {(p.stderr or p.stdout).strip()[-400:]}")

    set_env(envfile, "BIOCOMPUTE_RUN_AS", acct)
    say(f"Done. Runs will run as {acct} after the service restarts (sudo systemctl restart biocompute).")
    print(f"    Another data folder later: sudo python3 {Path(__file__).relative_to(ROOT) if Path(__file__).is_relative_to(ROOT) else __file__} grant [--write] FOLDER")


def cmd_grant(a: argparse.Namespace) -> None:
    need_root()
    cfg = load_runas()
    acct = a.account or cfg.get("account")
    if not acct:
        die("no run account configured (run setup first, or give --account)")
    check_account(acct)
    if not shutil.which("setfacl"):
        die("setfacl is missing (sudo apt install acl)")
    for f in a.paths:
        p = Path(f)
        mode = "write" if a.write else "read"
        grant(acct, p, mode, cfg.get("deny", []))
        record(cfg, p, mode)
        say(f"{acct} may now {'read and write' if a.write else 'read'} {p.resolve()}")
    if CONFIG.parent.exists() or cfg:
        save_runas(cfg)


def cmd_status(a: argparse.Namespace) -> None:
    cfg = load_runas()
    acct = a.account or cfg.get("account")
    print(f"configuration   {CONFIG} {'(present)' if cfg else '(missing)'}")
    print(f"run account     {acct or '-'}")
    if acct:
        try:
            pw = pwd.getpwnam(acct)
            members = grp.getgrgid(pw.pw_gid).gr_mem
            print(f"  uid/gid       {pw.pw_uid}/{pw.pw_gid}, home {pw.pw_dir}; group members: {', '.join(members) or '-'}")
        except KeyError:
            print("  (account does not exist)")
    print(f"helper          {HELPER} {'(installed)' if HELPER.exists() else '(missing)'}")
    print(f"sudoers rule    {SUDOERS} {'(present)' if SUDOERS.exists() else '(missing)'}")
    for g in cfg.get("granted", []):
        print(f"  {g['mode']:8} {g['path']}")
    if acct and cfg and os.geteuid() == 0:
        problems = verify(acct, cfg)
        print("access check    " + ("ok" if not problems else f"{len(problems)} problem(s)"))
        for msg in problems:
            print(f"  - {msg}")


def cmd_remove(a: argparse.Namespace) -> None:
    need_root()
    cfg = load_runas()
    acct = a.account or cfg.get("account")
    for p in (SUDOERS, HELPER):
        if p.exists():
            p.unlink()
            say(f"removed {p}")
    if acct and shutil.which("setfacl"):
        for g in cfg.get("granted", []):
            p = g["path"]
            if Path(p).exists():
                spec = f"u:{acct}" + (f",g:{acct}" if g["mode"] == "write" else "")
                flags = ["-R"] if g["mode"] != "traverse" else []
                sh("setfacl", *flags, "-x", spec, p, check=False, quiet=True)
                if g["mode"] != "traverse":
                    sh("setfacl", "-R", "-d", "-x", spec, p, check=False, quiet=True)
        say("removed the run account's ACL entries on the folders it was given (pass-through entries above them stay)")
    if cfg.get("owner") and acct:
        sh("gpasswd", "-d", cfg["owner"], acct, check=False, quiet=True)
    if CONFIG.exists():
        CONFIG.unlink()
    if a.delete_account and acct:
        sh("userdel", "--remove", acct, check=False)
        say(f"deleted the account {acct}")
    say("Done. Remove BIOCOMPUTE_RUN_AS from BioCompute's configuration and restart the service.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("setup", help="create the account, grant access, install the helper and the sudo rule")
    s.add_argument("--owner", required=True, help="the account the BioCompute service runs as")
    s.add_argument("--config", required=True, help="BioCompute's configuration file (backend/.env)")
    s.add_argument("--backend", help="the backend folder (relative paths in the configuration are relative to it)")
    s.add_argument("--account", default="biocompute-run")
    s.add_argument("--tool", action="append", help="a tool the runs use (nextflow, java, conda...); its installation folder becomes readable")
    g = sub.add_parser("grant", help="let the run account read (or write) more folders")
    g.add_argument("--write", action="store_true")
    g.add_argument("--account")
    g.add_argument("paths", nargs="+")
    st = sub.add_parser("status")
    st.add_argument("--account")
    r = sub.add_parser("remove", help="remove the helper, the sudo rule and the ACL entries")
    r.add_argument("--account")
    r.add_argument("--delete-account", action="store_true")
    a = ap.parse_args()
    {"setup": cmd_setup, "grant": cmd_grant, "status": cmd_status, "remove": cmd_remove}[a.cmd](a)


if __name__ == "__main__":
    main()
