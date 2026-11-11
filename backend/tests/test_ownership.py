"""Each user has their own pipelines, Studio workflows and modules; sharing makes them usable by the lab."""
import pytest

from test_studio import QC_GRAPH


def _login(client, auth, name):
    client.post("/api/auth/users", headers=auth, json={"username": name, "password": f"{name}-password-1", "role": "scientist"})
    tok = client.post("/api/auth/login", json={"username": name, "password": f"{name}-password-1"}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture(scope="module")
def alice(client, auth):
    return _login(client, auth, "alice")


@pytest.fixture(scope="module")
def bob(client, auth):
    return _login(client, auth, "bob")


MODULE = {"id": "u_alice_count", "name": "Alice's counter", "scope": "per_sample", "language": "bash",
          "inputs": [{"name": "reads", "type": "fastq"}], "outputs": [{"name": "n", "type": "table", "pattern": "{prefix}.n.tsv"}],
          "script": 'set -euo pipefail\necho "$BC_IN_READS" > "$BC_PREFIX.n.tsv"\n'}


def test_private_by_default_then_shared(client, auth, alice, bob):
    # Alice's module and workflow start private
    assert client.post("/api/studio/modules", headers=alice, json=MODULE).status_code == 200
    graph = {"nodes": QC_GRAPH["nodes"] + [{"id": "ac", "type": "module", "position": {"x": 0, "y": 0}, "data": {"module": "u_alice_count"}}],
             "edges": QC_GRAPH["edges"] + [{"id": "e9", "source": "in", "sourceHandle": "out:reads", "target": "ac", "targetHandle": "in:reads"}]}
    w = client.post("/api/studio/workflows", headers=alice, json={"name": "Alice QC", "graph": graph}).json()
    assert w["visibility"] == "private" and w["created_by"] == "alice" and w["can_edit"]
    pub = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=alice).json()
    pid = pub["pipeline_id"]

    def bob_sees():
        return {
            "workflow": any(x["id"] == w["id"] for x in client.get("/api/studio/workflows", headers=bob).json()),
            "pipeline": any(p["id"] == pid for p in client.get("/api/pipelines", headers=bob).json()),
            "module": any(m["id"] == "u_alice_count" for m in client.get("/api/studio/modules", headers=bob).json()["modules"]),
        }

    assert bob_sees() == {"workflow": False, "pipeline": False, "module": False}
    assert client.get(f"/api/pipelines/{pid}", headers=bob).status_code == 404  # not even revealed
    assert client.get(f"/api/studio/workflows/{w['id']}", headers=bob).status_code == 404
    assert client.post("/api/runs", headers=bob, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": "results:x"}).status_code == 404
    # the admin can see everything
    assert any(p["id"] == pid for p in client.get("/api/pipelines", headers=auth).json())
    mine = client.get("/api/pipelines", params={"owner": "me"}, headers=alice).json()
    assert [p["id"] for p in mine] == [pid] and mine[0]["owner"] == "alice" and mine[0]["visibility"] == "private"

    # sharing the workflow shares its pipeline and the private module it needs
    r = client.put(f"/api/studio/workflows/{w['id']}/visibility", headers=alice, json={"visibility": "lab"}).json()
    assert r["shared_modules"] == ["u_alice_count"] and r["pipeline_id"] == pid
    assert bob_sees() == {"workflow": True, "pipeline": True, "module": True}

    # Bob can use and copy, not change
    wb = client.get(f"/api/studio/workflows/{w['id']}", headers=bob).json()
    assert not wb["can_edit"]
    assert client.put(f"/api/studio/workflows/{w['id']}", headers=bob, json={"name": "hijack", "graph": graph}).status_code == 403
    assert client.delete(f"/api/studio/workflows/{w['id']}", headers=bob).status_code == 403
    assert client.post(f"/api/studio/workflows/{w['id']}/publish", headers=bob).status_code == 403
    assert client.patch(f"/api/pipelines/{pid}", headers=bob, json={"description": "x"}).status_code == 403
    assert client.delete(f"/api/pipelines/{pid}", headers=bob).status_code == 403
    assert client.put("/api/studio/modules/u_alice_count", headers=bob, json=MODULE).status_code == 403
    assert client.post(f"/api/studio/compile", headers=bob, json={"name": "b", "graph": graph}).json()["valid"]
    copy = client.post(f"/api/pipelines/{pid}/duplicate", headers=bob, json={"name": "Bob QC"}).json()
    assert copy["owner"] == "bob" and copy["visibility"] == "private" and copy["can_edit"]
    assert not any(p["id"] == copy["id"] for p in client.get("/api/pipelines", headers=alice).json())

    # favorites are per user
    client.patch(f"/api/pipelines/{pid}", headers=bob, json={"favorite": True})
    assert next(p for p in client.get("/api/pipelines", headers=bob).json() if p["id"] == pid)["favorite"] is True
    assert next(p for p in client.get("/api/pipelines", headers=alice).json() if p["id"] == pid)["favorite"] is False

    # making it private again hides it from Bob (his own copy stays his)
    client.put(f"/api/studio/workflows/{w['id']}/visibility", headers=alice, json={"visibility": "private"})
    assert not any(p["id"] == pid for p in client.get("/api/pipelines", headers=bob).json())
    assert any(p["id"] == copy["id"] for p in client.get("/api/pipelines", headers=bob).json())


def test_catalog_and_older_items_stay_shared(client, alice, bob):
    for who in (alice, bob):
        names = {p["slug"] for p in client.get("/api/pipelines", headers=who).json()}
        assert "biocompute-fastq-qc" in names and any(s.startswith("nf-core") for s in names)


def test_viewers_cannot_change_shared_items(client, auth):
    client.post("/api/auth/users", headers=auth, json={"username": "vera", "password": "vera-password-1", "role": "viewer"})
    tok = client.post("/api/auth/login", json={"username": "vera", "password": "vera-password-1"}).json()["access_token"]
    v = {"Authorization": f"Bearer {tok}"}
    pid = next(p["id"] for p in client.get("/api/pipelines", headers=v).json() if p["slug"] == "biocompute-fastq-qc")
    assert client.patch(f"/api/pipelines/{pid}", headers=v, json={"description": "x"}).status_code == 403
    assert client.patch(f"/api/pipelines/{pid}", headers=v, json={"favorite": True}).status_code == 200  # starring is personal
