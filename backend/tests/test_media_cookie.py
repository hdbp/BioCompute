"""No login token in URLs: files and streams open with an HttpOnly cookie that cannot be used for anything else."""
from fastapi.testclient import TestClient

from app.main import app
from app.security import MEDIA_COOKIE
from test_ownership import _login


def test_files_use_a_cookie_not_a_url_token(client, auth):
    token = auth["Authorization"].split()[1]
    path = "raw:run1"
    fq = next(e["path"] for e in client.get("/api/datasets/browse", params={"path": path}, headers=auth).json()["entries"] if e["type"] == "file")
    with TestClient(app) as c:
        # the old ?access_token= form no longer works anywhere
        assert c.get("/api/explore/raw", params={"path": fq, "access_token": token}).status_code == 401
        assert c.get("/api/runs", params={"access_token": token}).status_code == 401
        # the cookie is set by the API (bearer) and is HttpOnly + SameSite=Strict, limited to /api
        r = c.post("/api/auth/media-cookie", headers=auth)
        sc = r.headers["set-cookie"].lower()
        assert MEDIA_COOKIE in sc and "httponly" in sc and "samesite=strict" in sc and "path=/api" in sc
        # it opens files and downloads ...
        assert c.get("/api/explore/raw", params={"path": fq}).status_code == 200
        assert c.get("/api/datasets/download", params={"path": fq}).status_code == 200
        # ... but is not a login: no API calls, no writes
        assert c.get("/api/runs").status_code == 401
        assert c.post("/api/experiments", json={"name": "via cookie"}).status_code == 401
        cookie = c.cookies.get(MEDIA_COOKIE)
        assert c.get("/api/runs", headers={"Authorization": f"Bearer {cookie}"}).status_code == 401
        # signing out removes it
        c.delete("/api/auth/media-cookie")
        assert c.get("/api/explore/raw", params={"path": fq}).status_code == 401


def test_password_reset_ends_existing_sessions(client, auth):
    who = _login(client, auth, "reset_me")
    assert client.get("/api/auth/me", headers=who).status_code == 200
    uid = next(u["id"] for u in client.get("/api/auth/users", headers=auth).json() if u["username"] == "reset_me")
    import time
    time.sleep(1.1)  # tokens carry whole seconds
    r = client.post(f"/api/auth/users/{uid}/reset-password", headers=auth, json={})
    assert r.status_code == 200, r.text
    assert client.get("/api/auth/me", headers=who).status_code == 401
