"""First-run setup: the first visitor creates the administrator account in the browser.

Who may do it:
  * a browser on the controller itself (request from the loopback address, not through a proxy), or
  * anyone who enters the one-time setup code that the server prints at start-up and saves to
    $STATE_DIR/setup_code.txt (readable only by the service account).
That stops another computer on the network from claiming a fresh installation first.

Setup is needed when there is no user yet and BIOCOMPUTE_ADMIN_PASSWORD was not given, or for an older
installation whose only account is the generated "admin" whose random password was never changed or used.
"""
from __future__ import annotations

import os
import re
import secrets
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import AppSetting, User
from ..security import hash_secret, verify_secret

KEY = "setup"
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I
USERNAME = re.compile(r"^[A-Za-z0-9_.-]{2,40}$")
_lock = threading.Lock()
_failures = 0
MAX_FAILURES = 20


def _state() -> Path:
    return Path(get_settings().state_dir).resolve()


def code_file() -> Path:
    return _state() / "setup_code.txt"


def legacy_file() -> Path:
    return _state() / "initial_admin_password.txt"


def completed(db: Session) -> bool:
    row = db.get(AppSetting, KEY)
    return bool(row and (row.value or {}).get("completed"))


def mark_completed(db: Session, how: str) -> None:
    row = db.get(AppSetting, KEY) or AppSetting(key=KEY, value={})
    row.value = {"completed": True, "how": how, "at": datetime.now(timezone.utc).isoformat()}
    db.merge(row)
    for f in (code_file(), legacy_file()):
        try:
            f.unlink()
        except FileNotFoundError:
            pass


def _legacy_admin(db: Session) -> User | None:
    """An older install's generated admin whose random password (in initial_admin_password.txt) is still the password."""
    users = db.query(User).all()
    if len(users) != 1 or not legacy_file().is_file():
        return None
    m = re.search(r"^password:\s*(\S+)", legacy_file().read_text(), re.M)
    u = users[0]
    return u if m and u.role == "admin" and verify_secret(m.group(1), u.password_hash) else None


def needed(db: Session) -> bool:
    if completed(db):
        return False
    if not db.query(User).first():
        return True
    return _legacy_admin(db) is not None


def ensure_code() -> str:
    """The one-time code (created once, kept until setup is done)."""
    f = code_file()
    if f.is_file():
        code = f.read_text().strip()
        if code:
            return code
    code = "-".join("".join(secrets.choice(CODE_ALPHABET) for _ in range(4)) for _ in range(2))
    f.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(code + "\n")
    return code


def announce(code: str) -> None:
    s = get_settings()
    bar = "=" * 72
    print(f"\n{bar}\n BioCompute first-run setup\n"
          f"   Open BioCompute in a browser and create the administrator account.\n"
          f"   From this computer no code is needed. From another computer, enter the setup code:\n\n"
          f"       {code}\n\n"
          f"   (also saved in {code_file()}; it stops working once setup is done)\n"
          f"   Or skip the browser:  python -m app.cli reset-password <name> --create --role admin\n{bar}\n",
          file=sys.stderr, flush=True)
    del s


def is_local(request: Request) -> bool:
    """A browser on the controller itself: loopback peer and no proxy in between."""
    host = request.client.host if request.client else ""
    proxied = any(h in request.headers for h in ("x-forwarded-for", "x-real-ip", "forwarded"))
    return host in ("127.0.0.1", "::1", "localhost") and not proxied


def status(db: Session, request: Request) -> dict[str, Any]:
    need = needed(db)
    out: dict[str, Any] = {"needed": need}
    if need:
        local = is_local(request)
        out.update(code_required=not local, local=local, code_file=str(code_file()),
                   existing_admin=(_legacy_admin(db).username if _legacy_admin(db) else None),
                   suggested_username=(os.environ.get("USER") or "admin") if os.environ.get("USER") not in (None, "root") else "admin")
    return out


def complete(db: Session, request: Request, username: str, password: str, code: str | None) -> User:
    global _failures
    with _lock:
        if not needed(db):
            raise HTTPException(409, "Setup is already done. Sign in, or ask an administrator for an account.")
        if not is_local(request):
            if _failures >= MAX_FAILURES:
                raise HTTPException(429, "Too many wrong setup codes. Restart BioCompute, or create the account with the command line.")
            expected = ensure_code()
            if not code or not secrets.compare_digest(code.strip().upper().replace(" ", ""), expected.replace(" ", "")):
                _failures += 1
                raise HTTPException(403, f"Wrong setup code. It is printed in the BioCompute terminal at start-up and saved in {code_file()}.")
        username = (username or "").strip()
        if not USERNAME.fullmatch(username):
            raise HTTPException(400, "Username: 2 to 40 letters, digits, '.', '_' or '-'")
        if len(password or "") < 10:
            raise HTTPException(400, "Password: at least 10 characters")
        legacy = _legacy_admin(db)
        if legacy:  # take over the generated account (keeps its id, so nothing it owns is orphaned)
            legacy.username, legacy.password_hash, legacy.is_active = username, hash_secret(password), True
            user = legacy
        else:
            user = User(username=username, password_hash=hash_secret(password), role="admin")
            db.add(user)
        mark_completed(db, "browser")
        db.flush()
        _failures = 0
        return user
