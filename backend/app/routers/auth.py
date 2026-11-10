from __future__ import annotations

import time
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditEvent, User
from ..schemas import LoginIn, PasswordChange, TokenOut, UserCreate, UserOut
from ..security import audit, create_access_token, get_current_user, hash_secret, require_admin, verify_secret

router = APIRouter(prefix="/api/auth", tags=["auth"])
_failures: dict[str, list[float]] = defaultdict(list)


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    key = f"{request.client.host if request.client else '?'}:{body.username}"
    window = [t for t in _failures[key] if time.time() - t < 300]
    _failures[key] = window
    if len(window) >= 8:
        raise HTTPException(429, "Too many failed attempts; try again in a few minutes")
    user = db.query(User).filter(User.username == body.username).one_or_none()
    if not user or not user.is_active or not verify_secret(body.password, user.password_hash):
        _failures[key].append(time.time())
        audit(db, body.username, "auth.login_failed", detail_ip=request.client.host if request.client else None)
        db.commit()
        raise HTTPException(401, "Invalid username or password")
    audit(db, user.username, "auth.login")
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
    return db.query(User).order_by(User.username).all()


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
