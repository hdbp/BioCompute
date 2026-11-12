"""How new people get an account, besides an administrator creating it:

* Account requests: anyone who can reach the sign-in page asks for an account (username + password they
  choose). The account exists but cannot sign in until an administrator approves it with a role.
  Administrators can turn requests off.
* Invite links: an administrator creates a single-use link with a role and an expiry; whoever opens it picks
  their username and password and is signed in at once. Only a hash of the link's token is stored.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import AppSetting, User
from ..security import hash_secret

USERNAME = re.compile(r"^[A-Za-z0-9_.-]{2,80}$")
ROLES = ("viewer", "scientist", "admin")
_requests_by_ip: dict[str, list[float]] = defaultdict(list)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- settings
def settings(db: Session) -> dict[str, Any]:
    row = db.get(AppSetting, "accounts")
    return {"requests": True, **((row.value or {}) if row else {})}


def set_settings(db: Session, requests: bool) -> dict[str, Any]:
    row = db.get(AppSetting, "accounts") or AppSetting(key="accounts", value={})
    row.value = {**(row.value or {}), "requests": bool(requests)}
    db.merge(row)
    return settings(db)


def _check_new(db: Session, username: str, password: str) -> str:
    username = (username or "").strip()
    if not USERNAME.fullmatch(username):
        raise HTTPException(400, "Username: 2 to 80 letters, digits, '.', '_' or '-'")
    if len(password or "") < 10:
        raise HTTPException(400, "Password: at least 10 characters")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(409, "That username is taken; choose another")
    return username


# --------------------------------------------------------------------------- requests
def is_pending(u: User) -> bool:
    return bool((u.prefs or {}).get("pending"))


def request_account(db: Session, ip: str, username: str, password: str, note: str) -> User:
    if not settings(db)["requests"]:
        raise HTTPException(403, "Account requests are turned off here. Ask an administrator for an account or an invite link.")
    window = [t for t in _requests_by_ip[ip] if time.time() - t < 3600]
    if len(window) >= 5:
        raise HTTPException(429, "Too many requests from this computer; try again later")
    _requests_by_ip[ip] = window + [time.time()]
    username = _check_new(db, username, password)
    u = User(username=username, password_hash=hash_secret(password), role="viewer", is_active=False,
             prefs={"pending": {"requested_at": _now().isoformat(), "note": (note or "").strip()[:500], "ip": ip}})
    db.add(u)
    db.flush()
    return u


def pending(db: Session) -> list[User]:
    return [u for u in db.query(User).order_by(User.created_at).all() if is_pending(u)]


def approve(db: Session, user_id: str, role: str) -> User:
    u = db.get(User, user_id)
    if not u or not is_pending(u):
        raise HTTPException(404, "No such request")
    if role not in ROLES:
        raise HTTPException(400, "Unknown role")
    prefs = dict(u.prefs or {})
    prefs.pop("pending", None)
    u.prefs, u.role, u.is_active = prefs, role, True
    return u


def decline(db: Session, user_id: str) -> str:
    u = db.get(User, user_id)
    if not u or not is_pending(u):
        raise HTTPException(404, "No such request")
    name = u.username
    db.delete(u)
    return name


# --------------------------------------------------------------------------- invites
def _invites(db: Session) -> list[dict[str, Any]]:
    row = db.get(AppSetting, "invites")
    return list((row.value or {}).get("items", [])) if row else []


def _save_invites(db: Session, items: list[dict[str, Any]]) -> None:
    row = db.get(AppSetting, "invites") or AppSetting(key="invites", value={})
    row.value = {"items": items}
    db.merge(row)


def _h(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_invite(db: Session, admin: str, role: str, days: int, note: str) -> tuple[str, dict[str, Any]]:
    if role not in ROLES:
        raise HTTPException(400, "Unknown role")
    days = max(1, min(int(days), 30))
    token = secrets.token_urlsafe(24)
    inv = {"id": secrets.token_hex(4), "hash": _h(token), "role": role, "note": (note or "").strip()[:200],
           "created_by": admin, "created_at": _now().isoformat(), "expires_at": (_now() + timedelta(days=days)).isoformat(),
           "used_by": None, "used_at": None}
    items = [i for i in _invites(db) if not _expired(i) or i.get("used_by")][-200:]  # keep history of used ones, drop dead ones
    _save_invites(db, items + [inv])
    return token, public(inv)


def _expired(inv: dict[str, Any]) -> bool:
    return datetime.fromisoformat(inv["expires_at"]) < _now()


def public(inv: dict[str, Any]) -> dict[str, Any]:
    status = "used" if inv.get("used_by") else "expired" if _expired(inv) else "open"
    return {k: v for k, v in inv.items() if k != "hash"} | {"status": status}


def list_invites(db: Session) -> list[dict[str, Any]]:
    return [public(i) for i in reversed(_invites(db))]


def revoke_invite(db: Session, inv_id: str) -> None:
    items = _invites(db)
    left = [i for i in items if i["id"] != inv_id]
    if len(left) == len(items):
        raise HTTPException(404, "No such invite")
    _save_invites(db, left)


def _find(db: Session, token: str) -> dict[str, Any]:
    h = _h(token or "")
    inv = next((i for i in _invites(db) if secrets.compare_digest(i["hash"], h)), None)
    if not inv:
        raise HTTPException(404, "This invite link is not valid (it may have been revoked). Ask for a new one.")
    if inv.get("used_by"):
        raise HTTPException(410, "This invite link has already been used. Sign in, or ask for a new one.")
    if _expired(inv):
        raise HTTPException(410, "This invite link has expired. Ask for a new one.")
    return inv


def check_invite(db: Session, token: str) -> dict[str, Any]:
    inv = _find(db, token)
    return {"valid": True, "role": inv["role"], "expires_at": inv["expires_at"], "invited_by": inv["created_by"]}


def accept_invite(db: Session, token: str, username: str, password: str) -> User:
    inv = _find(db, token)
    username = _check_new(db, username, password)
    u = User(username=username, password_hash=hash_secret(password), role=inv["role"], is_active=True, prefs={})
    db.add(u)
    items = _invites(db)
    for i in items:
        if i["id"] == inv["id"]:
            i["used_by"], i["used_at"] = username, _now().isoformat()
    _save_invites(db, items)
    db.flush()
    return u


# --------------------------------------------------------------------------- administration of existing accounts
def _account(db: Session, user_id: str) -> User:
    u = db.get(User, user_id)
    if not u or is_pending(u):  # a pending request is approved or declined, not edited
        raise HTTPException(404, "No such user")
    return u


def active_admins(db: Session) -> int:
    return sum(1 for u in db.query(User).filter(User.role == "admin", User.is_active.is_(True)).all() if not is_pending(u))


def _keep_one_admin(db: Session, u: User, what: str) -> None:
    """BioCompute must always keep one administrator who can sign in."""
    if u.role == "admin" and u.is_active and active_admins(db) <= 1:
        raise HTTPException(409, f"{u.username} is the last active administrator and cannot be {what}. Make someone else an administrator first.")


def set_role(db: Session, actor: User, user_id: str, role: str) -> tuple[User, str]:
    """Change a user's role; returns the user and the previous role."""
    u = _account(db, user_id)
    if role not in ROLES:
        raise HTTPException(400, "Unknown role")
    if u.id == actor.id:
        raise HTTPException(400, "You cannot change your own role. Ask another administrator.")
    old = u.role
    if role != "admin":
        _keep_one_admin(db, u, "demoted")
    u.role = role
    db.flush()
    return u, old


def set_active(db: Session, actor: User, user_id: str, active: bool) -> User:
    """Deactivate (the account stays, sign-in is refused) or reactivate a user."""
    u = _account(db, user_id)
    if not active:
        if u.id == actor.id:
            raise HTTPException(400, "You cannot deactivate yourself")
        _keep_one_admin(db, u, "deactivated")
    u.is_active = bool(active)
    db.flush()
    return u


def reset_password(db: Session, actor: User, user_id: str, password: str | None) -> tuple[User, str | None]:
    """Set a temporary password, or generate one. Returns the user and the generated password (None when one was given)."""
    u = _account(db, user_id)
    if u.id == actor.id:
        raise HTTPException(400, "To change your own password use Settings, Preferences: it asks for the current one.")
    generated = None
    if password is None:
        generated = password = secrets.token_urlsafe(12)
    elif len(password) < 10:
        raise HTTPException(400, "Password: at least 10 characters")
    u.password_hash = hash_secret(password)
    db.flush()
    return u, generated
