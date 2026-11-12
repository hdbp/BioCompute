"""Experiments and runs belong to who made them: others may look (when shared) but not change them."""
from conftest import wait_for_run
from test_ownership import _login
from test_studio import QC_GRAPH


def test_experiment_ownership(client, auth):
    ana, ben = _login(client, auth, "ana_exp"), _login(client, auth, "ben_exp")
    e = client.post("/api/experiments", headers=ana, json={"name": "Ana's ChIP", "assay": "chipseq"}).json()
    assert e["visibility"] == "lab" and e["can_edit"] and e["created_by"] == "ana_exp"
    # shared with the lab: Ben sees it but cannot change it
    got = client.get(f"/api/experiments/{e['id']}", headers=ben).json()
    assert got["can_edit"] is False
    for method, url, body in (("put", f"/api/experiments/{e['id']}", {"name": "renamed"}),
                              ("put", f"/api/experiments/{e['id']}/samples", {"samples": []}),
                              ("post", f"/api/experiments/{e['id']}/samples", {"sample_id": "X"}),
                              ("delete", f"/api/experiments/{e['id']}", None),
                              ("put", f"/api/experiments/{e['id']}/visibility", {"visibility": "private"})):
        r = getattr(client, method)(url, headers=ben, **({"json": body} if body is not None else {}))
        assert r.status_code == 403, (method, url, r.status_code)
    # Ben can make his own copy
    cp = client.post(f"/api/experiments/{e['id']}/duplicate", headers=ben).json()
    assert cp["created_by"] == "ben_exp" and cp["can_edit"]
    # private: hidden from Ben, still there for Ana and admins
    assert client.put(f"/api/experiments/{e['id']}/visibility", headers=ana, json={"visibility": "private"}).status_code == 200
    assert client.get(f"/api/experiments/{e['id']}", headers=ben).status_code == 404
    assert e["id"] not in {x["id"] for x in client.get("/api/experiments", headers=ben).json()}
    assert client.get(f"/api/experiments/{e['id']}", headers=auth).status_code == 200
    # a sample of Ana's experiment cannot be changed through the samples endpoint either
    s = client.post(f"/api/experiments/{e['id']}/samples", headers=ana, json={"sample_id": "S1"}).json()
    assert client.patch(f"/api/samples/{s['id']}", headers=ben, json={"sample_id": "hacked"}).status_code == 404
    assert client.delete(f"/api/samples/{s['id']}", headers=ben).status_code == 404


def test_import_refuses_paths_outside_data_folders(client, auth):
    e = client.post("/api/experiments", headers=auth, json={"name": "Import paths"}).json()
    r = client.post(f"/api/experiments/{e['id']}/import-samplesheet", headers=auth,
                    json={"content": "sample,fastq_1\nS1,/etc/passwd\n", "mode": "replace"})
    assert r.status_code == 400 and "not inside a data folder" in r.text


def test_run_ownership(client, auth):
    ana, ben = _login(client, auth, "ana_run"), _login(client, auth, "ben_run")
    w = client.post("/api/studio/workflows", headers=ana, json={"name": "Ana QC", "graph": QC_GRAPH}).json()
    client.put(f"/api/studio/workflows/{w['id']}/visibility", headers=ana, json={"visibility": "lab"})
    pid = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=ana).json()["pipeline_id"]
    run = client.post("/api/runs", headers=ana, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": "results:own_run",
                                                     "params": {"input": "raw:run1"}}).json()
    done = wait_for_run(client, auth, run["id"])
    assert done["status"] == "completed"
    seen = client.get(f"/api/runs/{run['id']}", headers=ben).json()
    assert seen["can_edit"] is False
    assert client.get(f"/api/runs/{run['id']}", headers=ana).json()["can_edit"] is True
    assert client.post(f"/api/runs/{run['id']}/resume", headers=ben).status_code == 403
    assert client.post(f"/api/runs/{run['id']}/cancel", headers=ben).status_code == 403
    mine = client.get("/api/runs", headers=ben, params={"mine": "true"}).json()
    assert run["id"] not in {r["id"] for r in mine}
    # a run of a private pipeline is not shown to others
    client.put(f"/api/studio/workflows/{w['id']}/visibility", headers=ana, json={"visibility": "private"})
    assert client.get(f"/api/runs/{run['id']}", headers=ben).status_code == 404
    assert run["id"] not in {r["id"] for r in client.get("/api/runs", headers=ben).json()}
    assert run["id"] not in {r["id"] for r in client.get("/api/results", headers=ben).json()}
    assert client.get(f"/api/results/{run['id']}", headers=ben).status_code == 404
