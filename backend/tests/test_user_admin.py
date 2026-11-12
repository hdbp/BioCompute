"""Administration of existing accounts: change role, deactivate and reactivate, reset a password."""
import pytest
from fastapi import HTTPException


def _make(client, auth, name, role="scientist"):
    r = client.post("/api/auth/users", headers=auth, json={"username": name, "password": f"{name}-password-1", "role": role})
    assert r.status_code == 200, r.text
    return r.json()


def _login(client, name, password=None):
    return client.post("/api/auth/login", json={"username": name, "password": password or f"{name}-password-1"})


def _headers(client, name, password=None):
    r = _login(client, name, password)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _me(client, auth):
    return client.get("/api/auth/me", headers=auth).json()


def _audit(client, auth, action, target):
    return [a for a in client.get("/api/auth/audit?limit=200", headers=auth).json() if a["action"] == action and a["target"] == target]


def test_change_role(client, auth):
    u = _make(client, auth, "ua-role", "viewer")
    r = client.patch(f"/api/auth/users/{u['id']}", headers=auth, json={"role": "scientist"})
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "scientist"
    assert next(x for x in client.get("/api/auth/users", headers=auth).json() if x["id"] == u["id"])["role"] == "scientist"
    ev = _audit(client, auth, "user.role_changed", "ua-role")
    assert ev and ev[0]["actor"] == "admin" and ev[0]["detail"] == {"role": "scientist", "previous": "viewer"}
    # the new role applies to the user's existing session at once
    h = _headers(client, "ua-role")
    assert client.get("/api/auth/users", headers=h).status_code == 403
    assert client.patch(f"/api/auth/users/{u['id']}", headers=auth, json={"role": "admin"}).json()["role"] == "admin"
    assert client.get("/api/auth/users", headers=h).status_code == 200
    # bad input
    assert client.patch(f"/api/auth/users/{u['id']}", headers=auth, json={"role": "root"}).status_code == 422
    assert client.patch(f"/api/auth/users/{u['id']}", headers=auth, json={}).status_code == 400
    assert client.patch("/api/auth/users/nope", headers=auth, json={"role": "viewer"}).status_code == 404
    client.patch(f"/api/auth/users/{u['id']}", headers=auth, json={"role": "viewer", "is_active": False})


def test_user_admin_requires_admin(client, auth):
    u = _make(client, auth, "ua-plain", "scientist")
    h = _headers(client, "ua-plain")
    assert client.patch(f"/api/auth/users/{u['id']}", headers=h, json={"role": "admin"}).status_code == 403
    assert client.post(f"/api/auth/users/{u['id']}/reset-password", headers=h, json={}).status_code == 403
    assert client.delete(f"/api/auth/users/{u['id']}", headers=h).status_code == 403
    assert client.patch(f"/api/auth/users/{u['id']}", json={"role": "admin"}).status_code == 401
    assert _me(client, h)["role"] == "scientist"


def test_cannot_change_own_role_or_deactivate_self(client, auth):
    me = _me(client, auth)
    r = client.patch(f"/api/auth/users/{me['id']}", headers=auth, json={"role": "viewer"})
    assert r.status_code == 400 and "own role" in r.json()["detail"]
    assert client.patch(f"/api/auth/users/{me['id']}", headers=auth, json={"is_active": False}).status_code == 400
    assert client.delete(f"/api/auth/users/{me['id']}", headers=auth).status_code == 400
    r = client.post(f"/api/auth/users/{me['id']}/reset-password", headers=auth, json={})
    assert r.status_code == 400
    me = _me(client, auth)
    assert me["role"] == "admin" and me["is_active"]
    # the same rules hold for any other administrator acting on themselves
    other = _make(client, auth, "ua-admin2", "admin")
    h = _headers(client, "ua-admin2")
    assert client.patch(f"/api/auth/users/{other['id']}", headers=h, json={"role": "scientist"}).status_code == 400
    # ... but one administrator may demote another while more than one is left
    assert client.patch(f"/api/auth/users/{other['id']}", headers=auth, json={"role": "scientist"}).status_code == 200
    assert client.get("/api/auth/users", headers=h).status_code == 403


def test_last_active_admin_is_protected(client, auth):
    """Whoever asks, the only administrator who can still sign in is neither demoted nor deactivated."""
    from app.db import get_db
    from app.models import User
    from app.services import accounts

    gen = get_db()
    db = next(gen)
    try:
        admins = [u for u in db.query(User).filter(User.role == "admin", User.is_active.is_(True)).all()]
        last, others = admins[0], admins[1:]
        for o in others:  # not committed: rolled back below
            o.is_active = False
        db.flush()
        assert accounts.active_admins(db) == 1
        actor = User(id="someone-else", username="someone-else", role="admin", is_active=True)  # never added to the session
        with pytest.raises(HTTPException) as e:
            accounts.set_role(db, actor, last.id, "scientist")
        assert e.value.status_code == 409 and "last active administrator" in e.value.detail
        with pytest.raises(HTTPException) as e:
            accounts.set_active(db, actor, last.id, False)
        assert e.value.status_code == 409
        assert last.role == "admin" and last.is_active
        accounts.set_role(db, actor, last.id, "admin")  # keeping the role is not a demotion
    finally:
        db.rollback()
        gen.close()
    assert _me(client, auth)["role"] == "admin"


def test_deactivate_and_reactivate(client, auth):
    u = _make(client, auth, "ua-leaver")
    h = _headers(client, "ua-leaver")
    assert client.delete(f"/api/auth/users/{u['id']}", headers=auth).status_code == 200
    assert _login(client, "ua-leaver").status_code == 401
    assert client.get("/api/auth/me", headers=h).status_code == 401  # the open session ends too
    listed = next(x for x in client.get("/api/auth/users", headers=auth).json() if x["id"] == u["id"])
    assert listed["is_active"] is False
    r = client.patch(f"/api/auth/users/{u['id']}", headers=auth, json={"is_active": True})
    assert r.status_code == 200 and r.json()["is_active"] is True
    assert _login(client, "ua-leaver").status_code == 200
    assert _audit(client, auth, "user.reactivate", "ua-leaver")
    assert _audit(client, auth, "user.deactivate", "ua-leaver")
    assert client.patch(f"/api/auth/users/{u['id']}", headers=auth, json={"is_active": False}).json()["is_active"] is False


def test_reset_password(client, auth):
    u = _make(client, auth, "ua-forgot")
    # a generated password is returned once
    r = client.post(f"/api/auth/users/{u['id']}/reset-password", headers=auth, json={})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["generated"] is True and out["username"] == "ua-forgot" and len(out["password"]) >= 12
    assert _login(client, "ua-forgot").status_code == 401            # the old one no longer works
    assert _login(client, "ua-forgot", out["password"]).status_code == 200
    # one chosen by the administrator is not echoed back
    r = client.post(f"/api/auth/users/{u['id']}/reset-password", headers=auth, json={"password": "temporary-pass-9"})
    assert r.status_code == 200 and r.json() == {"ok": True, "username": "ua-forgot", "generated": False, "password": None}
    assert _login(client, "ua-forgot", out["password"]).status_code == 401
    h = _headers(client, "ua-forgot", "temporary-pass-9")
    # the user then picks their own
    assert client.post("/api/auth/password", headers=h, json={"current_password": "temporary-pass-9", "new_password": "my-own-password-1"}).status_code == 200
    assert _login(client, "ua-forgot", "my-own-password-1").status_code == 200
    # too short, unknown user
    assert client.post(f"/api/auth/users/{u['id']}/reset-password", headers=auth, json={"password": "short"}).status_code == 422
    assert client.post("/api/auth/users/nope/reset-password", headers=auth, json={}).status_code == 404
    # audited, without the password
    ev = _audit(client, auth, "user.password_reset", "ua-forgot")
    assert len(ev) == 2 and {e["detail"]["generated"] for e in ev} == {True, False}
    assert out["password"] not in str(ev) and "temporary-pass-9" not in str(ev)
    client.delete(f"/api/auth/users/{u['id']}", headers=auth)


def test_pending_requests_are_not_edited_here(client, auth):
    r = client.post("/api/auth/request-account", json={"username": "ua-pending", "password": "pending-password-1", "note": ""})
    if r.status_code != 200:  # requests switched off or rate-limited by an earlier test in this session
        pytest.skip(r.text)
    req = next(x for x in client.get("/api/auth/requests", headers=auth).json() if x["username"] == "ua-pending")
    assert client.patch(f"/api/auth/users/{req['id']}", headers=auth, json={"is_active": True}).status_code == 404
    assert client.post(f"/api/auth/users/{req['id']}/reset-password", headers=auth, json={}).status_code == 404
    assert _login(client, "ua-pending", "pending-password-1").status_code == 403
    assert client.delete(f"/api/auth/requests/{req['id']}", headers=auth).status_code == 200
