"""Launch: where a run executes is decided by the server, and every input counts for the restricted-data rule."""
from conftest import _TMP
from test_studio import QC_GRAPH


def _pipeline(client, auth, name):
    w = client.post("/api/studio/workflows", headers=auth, json={"name": name, "graph": QC_GRAPH}).json()
    return client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth).json()["pipeline_id"]


def test_client_cannot_choose_executor_nodes_or_work_dir(client, auth):
    pid = _pipeline(client, auth, "Hardening QC")
    r = client.post("/api/runs", headers=auth, json={
        "pipeline_id": pid, "engine": "bcflow", "output_dir": "results:hard1", "params": {"input": "raw:run1"}, "dry_run": True,
        "resources": {"executor": "condor", "nodes": ["any-host"], "work_dir": "/tmp/anywhere", "max_cpus": 2, "limits_source": "me"}})
    assert r.status_code == 200, r.text
    d = r.json()
    assert "executor" not in d["resources"] and "nodes" not in d["resources"] and d["resources"].get("work_dir") is None
    assert d["placement"]["executor"] == "local" and d["placement"]["selected"] != ["any-host"]
    assert "/tmp/anywhere" not in (d.get("work_dir") or "")
    assert d["resources"]["limits_source"] != "me"
    for bad in ({"max_cpus": "lots"}, {"max_cpus": 0}, {"profile": "a b; rm"}):
        assert client.post("/api/runs", headers=auth, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": "results:hard2",
                                                           "params": {"input": "raw:run1"}, "dry_run": True, "resources": bad}).status_code == 422


def test_restricted_inputs_are_detected_for_folders_samplesheets_and_file_params(client, auth):
    pid = _pipeline(client, auth, "Hardening QC 2")

    def placement(params):
        r = client.post("/api/runs", headers=auth, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": "results:hard3",
                                                        "params": params, "dry_run": True})
        assert r.status_code == 200, r.text
        return r.json()["placement"]

    folder = placement({"input": "raw:run1"})           # a FASTQ folder in the restricted "raw" data folder
    assert folder["restricted_inputs"] is True and folder["input_bytes"] > 0
    # a samplesheet outside the restricted folder that lists files inside it
    sheet = _TMP / "results" / "sheet_hard.csv"
    fq = next((_TMP / "raw" / "run1").glob("*.fastq.gz"))
    sheet.write_text(f"sample,fastq_1,fastq_2\nS1,{fq},\n")
    listed = placement({"input": "results:sheet_hard.csv"})
    assert listed["restricted_inputs"] is True
    # an absolute path into the restricted folder given as another parameter
    assert placement({"input": "results:sheet_hard.csv", "extra_file": str(fq)})["restricted_inputs"] is True


def test_inputs_outside_the_data_folders_are_refused(client, auth):
    pid = _pipeline(client, auth, "Hardening QC 3")
    r = client.post("/api/runs", headers=auth, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": "results:hard4", "dry_run": True,
                                                    "params": {"input": "raw:run1", "extra_file": str(_TMP / "outside" / "secret.txt")}})
    assert r.status_code == 422 and "not inside a data folder" in r.text
