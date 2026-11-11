"""Data folders added in Settings: validation, browsing, and the safety rules."""
import os
from pathlib import Path

from conftest import _TMP

from app.config import get_settings


def test_add_browse_and_remove_a_data_folder(client, auth):
    lab = _TMP / "my-lab-data" / "chipseq"
    lab.mkdir(parents=True)
    (lab / "S1_R1.fastq.gz").write_bytes(b"\x1f\x8b")
    (lab / ".secret").write_text("x")
    c = client.get("/api/datasets/roots/check", params={"path": str(lab)}, headers=auth).json()
    assert c["ok"] and c["entry_count"] == 1 and c["entries"] == ["S1_R1.fastq.gz"] and c["suggested_name"] == "chipseq"

    r = client.post("/api/datasets/roots", headers=auth, json={"name": "chipseq", "path": str(lab), "description": "lab"})
    assert r.status_code == 200, r.text
    assert r.json()["restricted"] is True and r.json()["writable"] is False and r.json()["source"] == "ui"  # safe defaults
    names = [e["name"] for e in client.get("/api/datasets/browse", params={"path": "chipseq:"}, headers=auth).json()["entries"]]
    assert names == ["S1_R1.fastq.gz"]
    assert any(x["name"] == "chipseq" for x in client.get("/api/datasets/roots", headers=auth).json())
    # traversal out of the new root is still refused
    assert client.get("/api/datasets/browse", params={"path": "chipseq:../"}, headers=auth).status_code in (400, 403)
    # the same folder twice, or a clashing name, is refused
    assert client.post("/api/datasets/roots", headers=auth, json={"name": "chipseq2", "path": str(lab)}).status_code == 400
    assert client.post("/api/datasets/roots", headers=auth, json={"name": "raw", "path": str(lab.parent)}).status_code == 409
    # edit, then remove
    assert client.patch("/api/datasets/roots/chipseq", headers=auth, json={"writable": True}).json()["writable"] is True
    assert client.delete("/api/datasets/roots/chipseq", headers=auth).status_code == 200
    assert client.get("/api/datasets/browse", params={"path": "chipseq:"}, headers=auth).status_code == 404
    # folders from BIOCOMPUTE_DATA_ROOTS are not editable here
    assert client.delete("/api/datasets/roots/raw", headers=auth).status_code == 404


def test_dangerous_folders_are_refused(client, auth):
    def errors(path):
        return client.get("/api/datasets/roots/check", params={"path": path}, headers=auth).json()

    for p in ("/", "/etc", "/etc/ssl", "/proc/self", "/usr/share", str(Path.home()), "relative/path", str(_TMP / "does-not-exist")):
        assert not errors(p)["ok"], p
    hidden = _TMP / ".hidden-data"
    hidden.mkdir(exist_ok=True)
    assert not errors(str(hidden))["ok"]
    state = Path(get_settings().state_dir).resolve()
    assert not errors(str(state))["ok"] and not errors(str(state.parent))["ok"]  # would expose keys/secrets
    assert "does not exist" in errors(str(_TMP / "nope"))["errors"][0]


def test_only_admins_manage_data_folders(client, auth):
    client.post("/api/auth/users", headers=auth, json={"username": "sci-roots", "password": "scientist-pass-1", "role": "scientist"})
    tok = client.post("/api/auth/login", json={"username": "sci-roots", "password": "scientist-pass-1"}).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert client.get("/api/datasets/roots/check", params={"path": str(_TMP)}, headers=h).status_code == 403
    assert client.post("/api/datasets/roots", headers=h, json={"name": "x", "path": str(_TMP)}).status_code == 403
