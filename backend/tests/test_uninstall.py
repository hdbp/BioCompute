"""Uninstalling pipelines: deleted when never run; otherwise hidden, keeping only the versions runs used; restorable."""
from pathlib import Path

from test_ownership import _login
from test_storage_cleanup import _pipeline, _run


def _ids(client, auth, **params):
    return {p["id"] for p in client.get("/api/pipelines", headers=auth, params=params).json()}


def test_uninstall_a_pipeline_that_never_ran(client, auth):
    pid = _pipeline(client, auth, "Uninstall never ran")
    path = Path(client.get(f"/api/pipelines/{pid}", headers=auth).json()["latest_version"]["path"])
    assert path.exists()
    r = client.delete(f"/api/pipelines/{pid}", headers=auth).json()
    assert r["result"] == "deleted" and not path.exists()
    assert client.get(f"/api/pipelines/{pid}", headers=auth).status_code == 404


def test_uninstall_keeps_what_runs_used_and_restores(client, auth):
    pid = _pipeline(client, auth, "Uninstall with runs")
    done = _run(client, auth, pid, "results:uninstall_run")
    used = client.get(f"/api/pipelines/{pid}", headers=auth).json()["latest_version"]
    # a second, unused version (published again from Studio)
    wf = client.get(f"/api/pipelines/{pid}", headers=auth).json()["studio_workflow_id"]
    client.post(f"/api/studio/workflows/{wf}/publish", headers=auth)
    det = client.get(f"/api/pipelines/{pid}", headers=auth).json()
    unused = next(v for v in det["versions"] if v["id"] != used["id"])
    # someone else cannot uninstall it
    ana = _login(client, auth, "ana_uninstall")
    assert client.delete(f"/api/pipelines/{pid}", headers=ana).status_code in (403, 404)
    r = client.delete(f"/api/pipelines/{pid}", headers=auth).json()
    assert r["result"] == "archived" and r["kept_versions"] == 1 and r["removed_versions"] == 1
    assert not Path(unused["path"]).exists() and Path(used["path"]).exists()
    assert pid not in _ids(client, auth) and pid in _ids(client, auth, archived="true")
    # the run keeps its pipeline and version; launching is refused until it is restored
    assert client.get(f"/api/runs/{done['id']}", headers=auth).status_code == 200
    r = client.post("/api/runs", headers=auth, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": "results:uninstall_again",
                                                     "params": {"input": "raw:run1"}})
    assert r.status_code == 409 and "uninstalled" in r.text
    assert client.post(f"/api/pipelines/{pid}/restore", headers=auth).json()["archived"] is False
    assert pid in _ids(client, auth)
    assert [v["id"] for v in client.get(f"/api/pipelines/{pid}", headers=auth).json()["versions"]] == [used["id"]]


def test_catalog_entries_are_not_uninstalled(client, auth):
    tpl = next(p for p in client.get("/api/pipelines", headers=auth).json() if p["kind"] == "template")
    assert client.delete(f"/api/pipelines/{tpl['id']}", headers=auth).status_code == 409


def test_rename_and_describe(client, auth):
    pid = _pipeline(client, auth, "Rename me")
    r = client.patch(f"/api/pipelines/{pid}", headers=auth, json={"name": "  Renamed QC ", "description": "d", "category": "QC"})
    assert r.status_code == 200 and r.json()["name"] == "Renamed QC" and r.json()["category"] == "QC"
    assert client.patch(f"/api/pipelines/{pid}", headers=auth, json={"name": "   "}).status_code == 422
    assert client.patch(f"/api/pipelines/{pid}", headers=auth, json={"name": "x" * 201}).status_code == 422
    ana = _login(client, auth, "ana_rename")
    assert client.patch(f"/api/pipelines/{pid}", headers=ana, json={"name": "mine now"}).status_code in (403, 404)
