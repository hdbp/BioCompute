"""Intermediate files are deleted when no longer needed; runs, work folders and unused versions can be removed."""
import os
from pathlib import Path

from conftest import _TMP, wait_for_run
from test_ownership import _login
from test_studio import QC_GRAPH, edge, node


def _pipeline(client, auth, name, graph=QC_GRAPH):
    w = client.post("/api/studio/workflows", headers=auth, json={"name": name, "graph": graph}).json()
    return client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth).json()["pipeline_id"]


def _run(client, auth, pid, out, **res):
    r = client.post("/api/runs", headers=auth, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": out,
                                                    "params": {"input": "raw:run1"}, "resources": res})
    assert r.status_code == 200, r.text
    return wait_for_run(client, auth, r.json()["id"])


def test_intermediate_files_are_removed_and_results_kept(client, auth):
    pid = _pipeline(client, auth, "Cleanup QC")
    done = _run(client, auth, pid, "results:clean_default")
    assert done["status"] == "completed"
    work = Path(done["work_dir"])
    assert not work.exists() or not any(p.is_file() for p in work.rglob("*") if p.name != ".bcflow.done")
    log = client.get(f"/api/runs/{done['id']}/log", headers=auth).json()["content"]
    assert "intermediate files removed as soon as they were no longer needed" in log
    assert (_TMP / "results" / "clean_default").exists()   # results stay
    assert any(e["kind"] == "cleanup" for e in done["events"]) or not work.exists()
    # a run can keep them (debugging)
    kept = _run(client, auth, pid, "results:clean_keep", keep_work=True)
    assert kept["status"] == "completed" and any(Path(kept["work_dir"]).rglob("*.tsv"))
    # ... and its owner can delete them later
    r = client.post(f"/api/runs/{kept['id']}/clean-work", headers=auth).json()
    assert r["freed"] > 0 and not Path(kept["work_dir"]).exists()


def test_a_step_folder_goes_as_soon_as_its_readers_finish(client, auth):
    # subsample -> stats -> report: subsample's folder may go once stats ran for that sample
    graph = {"nodes": [node("in", "input_samplesheet"), node("sub", "subsample", params={"reads": 20}),
                       node("st", "fastq_stats"), node("rep", "summary_report"), node("out", "output_results")],
             "edges": [edge("in", "reads", "sub", "reads"), edge("sub", "reads", "st", "reads"),
                       edge("st", "stats", "rep", "tables"), edge("rep", "html", "out", "results")]}
    pid = _pipeline(client, auth, "Eager cleanup", graph)
    done = _run(client, auth, pid, "results:clean_eager")
    assert done["status"] == "completed"
    trace = (Path(done["run_dir"]) / "trace.txt").read_text().splitlines()
    dirs = [line.split("\t")[-1] for line in trace[1:]]
    assert dirs and all(not Path(d).exists() for d in dirs)


def test_delete_run_and_results(client, auth):
    pid = _pipeline(client, auth, "Delete QC")
    ana = _login(client, auth, "ana_del")
    done = _run(client, auth, pid, "results:del_me")
    out = Path(done["output_dir"])
    assert out.exists()
    assert client.delete(f"/api/runs/{done['id']}", headers=ana).status_code in (403, 404)  # not hers
    r = client.delete(f"/api/runs/{done['id']}", headers=auth, params={"results": "true"}).json()
    assert r["results_deleted"] and not out.exists() and not Path(done["run_dir"]).exists()
    assert client.get(f"/api/runs/{done['id']}", headers=auth).status_code == 404
    # results in a folder that existed before the run are never deleted
    pre = _TMP / "results" / "preexisting"
    pre.mkdir(exist_ok=True)
    (pre / "keep.txt").write_text("mine")
    d2 = _run(client, auth, pid, "results:preexisting")
    assert client.delete(f"/api/runs/{d2['id']}", headers=auth, params={"results": "true"}).status_code == 409
    assert client.delete(f"/api/runs/{d2['id']}", headers=auth).json()["results_deleted"] is False
    assert (pre / "keep.txt").read_text() == "mine"


def test_storage_overview_and_clean_up(client, auth):
    pid = _pipeline(client, auth, "Storage QC")
    _run(client, auth, pid, "results:st_keep", keep_work=True)
    st = client.get("/api/storage", headers=auth).json()
    assert st["work_bytes"] > 0 and st["folders"] and st["cleanup_intermediates"] is True
    r = client.post("/api/storage/clean-work", headers=auth, json={"older_than_days": 0}).json()
    assert r["runs"] >= 1 and r["freed"] > 0
    assert client.get("/api/storage", headers=auth).json()["work_bytes"] == 0
    sci = _login(client, auth, "sci_storage")
    assert client.get("/api/storage", headers=sci).status_code == 403


def test_versions_share_unchanged_files_and_unused_ones_can_be_deleted(client, auth):
    import shutil
    from conftest import RAW
    shutil.copytree(Path(__file__).parent / "fixtures" / "nfcore_like", RAW / "nfcore_links", dirs_exist_ok=True)
    orig = client.post("/api/pipelines/import/local", headers=auth, json={"path": "raw:nfcore_links", "name": "Links demo"}).json()
    cid = client.post(f"/api/pipelines/{orig['id']}/fork", headers=auth, json={"name": "Links demo (mine)"}).json()["pipeline_id"]
    v1 = client.get(f"/api/pipelines/{cid}", headers=auth).json()["versions"][0]
    s = client.post(f"/api/pipelines/{cid}/files", headers=auth, json={"base_version_id": v1["id"], "changes": {"main.nf": "// changed\\n"}}).json()
    vs = {v["version"]: Path(v["path"]) for v in client.get(f"/api/pipelines/{cid}", headers=auth).json()["versions"]}
    a, b = vs["v1"] / "workflows" / "demo.nf", vs["v2"] / "workflows" / "demo.nf"
    assert os.stat(a).st_ino == os.stat(b).st_ino            # unchanged file: shared, no extra space
    assert os.stat(vs["v1"] / "main.nf").st_ino != os.stat(vs["v2"] / "main.nf").st_ino
    assert "changed" not in (vs["v1"] / "main.nf").read_text()  # the edit did not reach v1
    assert "changed" not in (RAW / "nfcore_links" / "main.nf").read_text()
    # the copy does not share files with the original folder outside the store (it could be edited in place there)
    assert os.stat(RAW / "nfcore_links" / "workflows" / "demo.nf").st_ino != os.stat(a).st_ino
    # an unused, non-default version can be deleted; its files go (they are in the store)
    d = client.delete(f"/api/pipelines/{cid}/versions/{v1['id']}", headers=auth)
    assert d.status_code == 200 and d.json()["files_removed"] and not vs["v1"].exists()
    assert (vs["v2"] / "workflows" / "demo.nf").exists()     # the shared file lives on in v2
    only = client.get(f"/api/pipelines/{cid}", headers=auth).json()["versions"][0]["id"]
    assert client.delete(f"/api/pipelines/{cid}/versions/{only}", headers=auth).status_code == 409
