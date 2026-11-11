from __future__ import annotations

import time
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditEvent, User
from ..schemas import LoginIn, PasswordChange, TokenOut, UserCreate, UserOut
from ..security import audit, create_access_token, get_current_user, hash_secret, require_admin, verify_secret
from ..services import accounts
from ..services import setup as setup_svc
from pydantic import BaseModel

router = APIRouter(prefix="/api/auth", tags=["auth"])
_failures: dict[str, list[float]] = defaultdict(list)


class SetupIn(BaseModel):
    username: str
    password: str
    code: str | None = None


@router.get("/setup")
def setup_status(request: Request, db: Session = Depends(get_db)):
    """Whether the first administrator account still has to be created (no authentication needed)."""
    return setup_svc.status(db, request)


@router.post("/setup", response_model=TokenOut)
def setup(body: SetupIn, request: Request, db: Session = Depends(get_db)):
    user = setup_svc.complete(db, request, body.username, body.password, body.code)
    audit(db, user.username, "auth.setup", from_this_computer=setup_svc.is_local(request),
          ip=request.client.host if request.client else None)
    db.commit()
    return TokenOut(access_token=create_access_token(user), user=UserOut.model_validate(user))


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    key = f"{request.client.host if request.client else '?'}:{body.username}"
    window = [t for t in _failures[key] if time.time() - t < 300]
    _failures[key] = window
    if len(window) >= 8:
        raise HTTPException(429, "Too many failed attempts; try again in a few minutes")
    user = db.query(User).filter(User.username == body.username).one_or_none()
    if not user and not db.query(User).first():
        raise HTTPException(409, "No account exists yet. Create the administrator account first.")
    if user and accounts.is_pending(user) and verify_secret(body.password, user.password_hash):
        raise HTTPException(403, "Your account request is waiting for an administrator to approve it.")
    if not user or not user.is_active or not verify_secret(body.password, user.password_hash):
        _failures[key].append(time.time())
        audit(db, body.username, "auth.login_failed", detail_ip=request.client.host if request.client else None)
        db.commit()
        raise HTTPException(401, "Invalid username or password")
    audit(db, user.username, "auth.login")
    if setup_svc.needed(db):  # an older install's generated password was found and used: setup is done
        setup_svc.mark_completed(db, "login")
    db.commit()
    return TokenOut(access_token=create_access_token(user), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.post("/password")
def change_password(body: PasswordChange, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not verify_secret(body.current_password, user.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    user.password_hash = hash_secret(body.new_password)
    audit(db, user.username, "auth.password_changed")
    db.commit()
    return {"ok": True}


@router.get("/users", response_model=list[UserOut])
def list_users(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    return [u for u in db.query(User).order_by(User.username).all() if not accounts.is_pending(u)]


@router.post("/users", response_model=UserOut)
def create_user(body: UserCreate, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if db.query(User).filter(User.username == body.username).first():
        raise HTTPException(409, "Username already exists")
    u = User(username=body.username, password_hash=hash_secret(body.password), role=body.role)
    db.add(u)
    audit(db, admin.username, "user.create", body.username, role=body.role)
    db.commit()
    return u


@router.delete("/users/{user_id}")
def deactivate_user(user_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404)
    if u.id == admin.id:
        raise HTTPException(400, "You cannot deactivate yourself")
    u.is_active = False
    audit(db, admin.username, "user.deactivate", u.username)
    db.commit()
    return {"ok": True}


@router.get("/audit")
def audit_log(limit: int = 200, _: User = Depends(require_admin), db: Session = Depends(get_db)):
    rows = db.query(AuditEvent).order_by(AuditEvent.id.desc()).limit(min(limit, 2000)).all()
    return [{"id": r.id, "ts": r.ts, "actor": r.actor, "action": r.action, "target": r.target, "detail": r.detail} for r in rows]



# --------------------------------------------------------------------------- self-service accounts
class AccountRequestIn(BaseModel):
    username: str
    password: str
    note: str = ""


class ApproveIn(BaseModel):
    role: str = "scientist"


class AccountSettingsIn(BaseModel):
    requests: bool


class InviteIn(BaseModel):
    role: str = "scientist"
    days: int = 7
    note: str = ""


class InviteAcceptIn(BaseModel):
    token: str
    username: str
    password: str


@router.get("/signup")
def signup_options(db: Session = Depends(get_db)):
    """What the sign-in page may offer (no authentication)."""
    return {"requests": accounts.settings(db)["requests"]}


@router.post("/request-account")
def request_account(body: AccountRequestIn, request: Request, db: Session = Depends(get_db)):
    ip = request.client.host if request.client else "?"
    u = accounts.request_account(db, ip, body.username, body.password, body.note)
    audit(db, u.username, "auth.account_requested", u.username, ip=ip)
    db.commit()
    return {"ok": True, "message": "Request sent. An administrator has to approve it before you can sign in."}


@router.get("/requests")
def account_requests(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    return [{"id": u.id, "username": u.username, "requested_at": (u.prefs or {}).get("pending", {}).get("requested_at"),
             "note": (u.prefs or {}).get("pending", {}).get("note", "")} for u in accounts.pending(db)]


@router.post("/requests/{user_id}/approve", response_model=UserOut)
def approve_request(user_id: str, body: ApproveIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    u = accounts.approve(db, user_id, body.role)
    audit(db, admin.username, "user.request_approved", u.username, role=u.role)
    db.commit()
    return u


@router.delete("/requests/{user_id}")
def decline_request(user_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    name = accounts.decline(db, user_id)
    audit(db, admin.username, "user.request_declined", name)
    db.commit()
    return {"ok": True}


@router.get("/account-settings")
def get_account_settings(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    return accounts.settings(db)


@router.put("/account-settings")
def put_account_settings(body: AccountSettingsIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    out = accounts.set_settings(db, body.requests)
    audit(db, admin.username, "settings.account_requests", None, enabled=body.requests)
    db.commit()
    return out


@router.get("/invites")
def list_invites(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    return accounts.list_invites(db)


@router.post("/invites")
def create_invite(body: InviteIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    token, inv = accounts.create_invite(db, admin.username, body.role, body.days, body.note)
    audit(db, admin.username, "user.invite_created", None, role=body.role, days=body.days, invite=inv["id"])
    db.commit()
    from ..config import get_settings
    base = (get_settings().public_url or "").rstrip("/") or None
    return {**inv, "token": token, "base_url": base}  # the token is shown once; only its hash is stored


@router.delete("/invites/{invite_id}")
def revoke_invite(invite_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    accounts.revoke_invite(db, invite_id)
    audit(db, admin.username, "user.invite_revoked", None, invite=invite_id)
    db.commit()
    return {"ok": True}


@router.get("/invites/check")
def check_invite(token: str, db: Session = Depends(get_db)):
    return accounts.check_invite(db, token)


@router.post("/invites/accept", response_model=TokenOut)
def accept_invite(body: InviteAcceptIn, db: Session = Depends(get_db)):
    u = accounts.accept_invite(db, body.token, body.username, body.password)
    audit(db, u.username, "auth.invite_accepted", u.username, role=u.role)
    db.commit()
    return TokenOut(access_token=create_access_token(u), user=UserOut.model_validate(u))
