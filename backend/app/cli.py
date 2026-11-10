"""Administrative command line for the BioCompute controller.

Run from the backend/ folder so the same configuration (backend/.env and environment
variables) as the API is used:

    .venv/bin/python -m app.cli info
    .venv/bin/python -m app.cli reset-password            # admin, prompts for a new password
    .venv/bin/python -m app.cli reset-password alice --role admin
"""
from __future__ import annotations

import argparse
import getpass
import os
import re
import sys
from pathlib import Path

from .config import get_settings


def _mask(url: str) -> str:
    return re.sub(r"://([^:/@]+):[^@]*@", r"://\1:****@", url)


def _sqlite_file() -> Path | None:
    url = get_settings().database_url
    if url.startswith("sqlite:///"):
        return Path(url.removeprefix("sqlite:///")).resolve()
    return None


def _check_config() -> bool:
    """Warn when this command is probably not looking at the server's configuration."""
    ok = True
    s = get_settings()
    explicit = os.environ.get("BIOCOMPUTE_DATABASE_URL") or Path(".env").is_file()
    if not explicit:
        print("warning: no backend/.env and no BIOCOMPUTE_DATABASE_URL - using built-in defaults, which is\n"
              "         probably not the configuration your server uses. For the demo run this from the\n"
              "         repository folder instead:  scripts/dev.sh admin info", file=sys.stderr)
        ok = False
    f = _sqlite_file()
    if f is not None and not f.exists():
        print(f"database {f} does not exist yet (no server has used this configuration); nothing to do.",
              file=sys.stderr)
        return False
    if not s.data_roots:
        print("note: no data roots configured in this configuration", file=sys.stderr)
    return ok


def _db():
    from .db import SessionLocal
    from .main import migrate

    migrate()  # same schema management as the API (Alembic; create_all only in tests)
    return SessionLocal()


def cmd_info(_a) -> int:
    s = get_settings()
    from .models import User

    f = _sqlite_file()
    if f is not None and not f.exists():
        print(f"database       {_mask(s.database_url)}  (does not exist yet)")
        print(f"state dir      {s.state_dir.resolve()}")
        _check_config()
        return 1

    print(f"database       {_mask(s.database_url)}")
    print(f"state dir      {s.state_dir.resolve()}")
    print(f"data roots     {', '.join(r['name'] + '=' + str(r['path']) for r in s.data_roots) or '(none)'}")
    print(f"admin password from env: {'yes' if s.admin_password else 'no (generated on first start)'}")
    with _db() as db:
        users = db.query(User).order_by(User.username).all()
        if not users:
            _check_config()
        print(f"users          {', '.join(f'{u.username} ({u.role}{'' if u.is_active else ', inactive'})' for u in users) or '(none yet - start the API once)'}")
    return 0


def cmd_reset(a) -> int:
    from .models import User
    from .security import hash_secret

    f = _sqlite_file()
    if f is not None and not f.exists() and not a.create:
        _check_config()
        return 1

    pw = a.password
    if not pw:
        pw = getpass.getpass(f"New password for {a.username}: ")
        if pw != getpass.getpass("Repeat: "):
            print("Passwords do not match", file=sys.stderr)
            return 1
    if len(pw) < 10:
        print("Password must be at least 10 characters", file=sys.stderr)
        return 1
    with _db() as db:
        u = db.query(User).filter(User.username == a.username).one_or_none()
        if u is None:
            if not a.create:
                print(f"No user '{a.username}' in {_mask(get_settings().database_url)} (use --create)", file=sys.stderr)
                return 1
            u = User(username=a.username, role=a.role or "admin", password_hash="")
            db.add(u)
        u.password_hash = hash_secret(pw)
        u.is_active = True
        if a.role:
            u.role = a.role
        from .security import audit

        audit(db, "cli", "user.password_reset", a.username)
        db.commit()
    print(f"Password for '{a.username}' updated in {_mask(get_settings().database_url)}.")
    print("If logins were blocked after repeated failures, restart the API (or wait 5 minutes).")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.cli", description="BioCompute administration")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info", help="show which database/state folder this configuration uses, and its users")
    r = sub.add_parser("reset-password", help="set a user's password (default user: admin)")
    r.add_argument("username", nargs="?", default="admin")
    r.add_argument("--password", help="new password (prompted if omitted; avoid shell history)")
    r.add_argument("--role", choices=["admin", "scientist", "viewer"])
    r.add_argument("--create", action="store_true", help="create the user if it does not exist")
    a = ap.parse_args(argv)
    return {"info": cmd_info, "reset-password": cmd_reset}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
