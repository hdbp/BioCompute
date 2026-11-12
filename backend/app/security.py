"""Authentication, authorization and audit helpers."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import AuditEvent, User

ROLE_RANK = {"viewer": 0, "scientist": 1, "admin": 2}
_bearer = HTTPBearer(auto_error=False)


# --------------------------------------------------------------------------- secrets
@lru_cache
def signing_key() -> str:
    """Stable JWT signing key: env var if given, else persisted in state_dir (0600)."""
    import os as _os

    if _os.environ.get("BIOCOMPUTE_SECRET_KEY"):
        return _os.environ["BIOCOMPUTE_SECRET_KEY"]
    path = Path(get_settings().state_dir) / "secret.key"
    if path.exists():
        return path.read_text().strip()
    key = secrets.token_urlsafe(48)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(key)
    return key


# --------------------------------------------------------------------------- passwords / tokens
def hash_secret(secret: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.scrypt(secret.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_secret(secret: str, stored: str) -> bool:
    try:
        algo, salt_b64, dk_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
        dk = hashlib.scrypt(secret.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


def token_digest(token: str) -> str:
    """Deterministic digest for high-entropy tokens (agent/enrollment), allowing lookup."""
    return hashlib.sha256(token.encode()).hexdigest()


def create_access_token(user: User) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user.username,
        "role": user.role,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=s.token_ttl_minutes)).timestamp()),
    }
    return jwt.encode(payload, signing_key(), algorithm="HS256")


def _decode(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, signing_key(), algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token") from exc


# Links, downloads, live updates and the genome browser cannot send an Authorization header. Instead of putting the
# login token in their URLs (where it ends up in logs and browser history), the browser holds a second, narrower
# token in an HttpOnly cookie: it only works for GET/HEAD on the endpoints that use require_media_viewer, and it is
# not accepted as a bearer token.
MEDIA_COOKIE = "bc_media"


def create_media_token(user: User) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    payload = {"sub": user.username, "scope": "media", "iat": int(now.timestamp()),
               "exp": int((now + timedelta(minutes=s.token_ttl_minutes)).timestamp())}
    return jwt.encode(payload, signing_key(), algorithm="HS256")


def _user_from(db: Session, payload: dict[str, Any]) -> User:
    user = db.query(User).filter(User.username == payload.get("sub")).one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User inactive or missing")
    # a token issued before the password was changed or the account was reset no longer works
    changed = (user.prefs or {}).get("credentials_changed_at")
    if changed and int(payload.get("iat", 0)) < int(changed):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session ended: sign in again")
    return user


def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """The signed-in user, from the Authorization header only (never from the URL)."""
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    payload = _decode(creds.credentials)
    if payload.get("scope") == "media":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "This token only opens files")
    return _user_from(db, payload)


def end_sessions(user: User) -> None:
    """Sign the user out everywhere: tokens issued before now stop working (after a password reset)."""
    user.prefs = {**(user.prefs or {}), "credentials_changed_at": int(datetime.now(timezone.utc).timestamp())}


def get_media_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """For files, downloads and event streams: the Authorization header, or the media cookie on GET/HEAD."""
    if creds:
        return get_current_user(request, creds, db)
    token = request.cookies.get(MEDIA_COOKIE)
    if not token or request.method not in ("GET", "HEAD"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    payload = _decode(token)
    if payload.get("scope") != "media":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return _user_from(db, payload)


def require_role(role: str):
    def dep(user: User = Depends(get_current_user)) -> User:
        if ROLE_RANK.get(user.role, -1) < ROLE_RANK[role]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires role '{role}'")
        return user

    return dep


require_viewer = require_role("viewer")


def require_media_viewer(user: User = Depends(get_media_user)) -> User:
    if ROLE_RANK.get(user.role, -1) < ROLE_RANK["viewer"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires role 'viewer'")
    return user
require_scientist = require_role("scientist")
require_admin = require_role("admin")


# --------------------------------------------------------------------------- audit
def audit(db: Session, actor: str, action: str, target: str | None = None, **detail: Any) -> None:
    db.add(AuditEvent(actor=actor, action=action, target=target, detail=detail))
