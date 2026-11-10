def test_requires_auth(client):
    assert client.get("/api/pipelines").status_code == 401
    assert client.get("/api/nodes").status_code == 401


def test_bad_login(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401


def test_health_and_openapi(client):
    assert client.get("/api/health").json()["status"] == "ok"
    spec = client.get("/openapi.json").json()
    for prefix in ("/api/nodes", "/api/discovery/scan", "/api/allocations/presets", "/api/pipelines", "/api/pipeline-versions/{version_id}/pin",
                   "/api/pipeline-schemas/{pid}", "/api/experiments", "/api/samples/{sid}", "/api/datasets", "/api/runs", "/api/jobs",
                   "/api/results", "/api/settings"):
        assert any(p.startswith(prefix) for p in spec["paths"]), prefix


def test_viewer_cannot_launch(client, auth):
    r = client.post("/api/auth/users", headers=auth, json={"username": "viewer1", "password": "viewer-pass-123", "role": "viewer"})
    assert r.status_code == 200
    tok = client.post("/api/auth/login", json={"username": "viewer1", "password": "viewer-pass-123"}).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert client.get("/api/pipelines", headers=h).status_code == 200
    r = client.post("/api/runs", headers=h, json={"pipeline_id": "biocompute-fastq-qc", "output_dir": "results:x"})
    assert r.status_code == 403
    assert client.post("/api/discovery/scan", headers=h).status_code == 403


def test_path_traversal_blocked(client, auth):
    for bad in ("raw:../outside", "raw:run1/../../outside", "raw:/etc", "nope:x", "/etc/passwd"):
        r = client.get("/api/datasets/browse", params={"path": bad}, headers=auth)
        assert r.status_code in (400, 403, 404), (bad, r.status_code)
    # symlink pointing outside the root is neither listed nor resolvable
    listing = client.get("/api/datasets/browse", params={"path": "raw:"}, headers=auth).json()
    assert "escape" not in [e["name"] for e in listing["entries"]]
    assert client.get("/api/datasets/preview", params={"path": "raw:escape/secret.txt"}, headers=auth).status_code == 403


def test_readonly_root(client, auth):
    assert client.post("/api/datasets/mkdir", json={"path": "raw:newdir"}, headers=auth).status_code == 403
    assert client.post("/api/datasets/mkdir", json={"path": "results:newdir"}, headers=auth).status_code == 200


def test_audit_log(client, auth):
    rows = client.get("/api/auth/audit", headers=auth).json()
    assert any(r["action"] == "auth.login" for r in rows)


def test_cli_reset_password(client, auth, capsys):
    from app import cli

    assert cli.main(["reset-password", "viewer2", "--password", "short"]) == 1
    assert cli.main(["reset-password", "viewer2", "--password", "new-password-123", "--create", "--role", "viewer"]) == 0
    r = client.post("/api/auth/login", json={"username": "viewer2", "password": "new-password-123"})
    assert r.status_code == 200 and r.json()["user"]["role"] == "viewer"
    assert cli.main(["info"]) == 0
    assert "viewer2 (viewer)" in capsys.readouterr().out
