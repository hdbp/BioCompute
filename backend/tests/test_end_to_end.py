"""Milestone-1 end-to-end: library -> schema form -> experiment -> validate -> launch -> logs -> results.

Runs the bundled example pipeline with the BioCompute native engine (bcflow) because
Nextflow may not be installed in CI. The Nextflow path is covered by the adapter tests
and, where Nextflow exists, by tests/test_nextflow_live.py.
"""
import json
import os
import signal
from pathlib import Path

from conftest import wait_for_run

PID = "biocompute-fastq-qc"


def test_library_lists_installed_and_templates(client, auth):
    items = client.get("/api/pipelines", headers=auth).json()
    ex = next(p for p in items if p["slug"] == PID)
    assert ex["kind"] == "installed" and ex["has_schema"]
    assert set(ex["latest_version"]["engines"]) == {"nextflow", "bcflow"}
    tmpl = [p for p in items if p["kind"] == "template"]
    assert tmpl and all(p["latest_version"] is None for p in tmpl)  # templates are not installed
    r = client.post("/api/runs", headers=auth, json={"pipeline_id": tmpl[0]["id"], "output_dir": "results:t"})
    assert r.status_code == 400


def test_schema_form(client, auth):
    r = client.get(f"/api/pipeline-schemas/{PID}", headers=auth).json()
    groups = {g["id"]: g for g in r["form"]["groups"]}
    assert "qc_options" in groups and groups["advanced_options"]["advanced"] is True
    assert r["defaults"]["min_read_length"] == 50
    v = client.post(f"/api/pipeline-schemas/{PID}/validate", headers=auth, json={"params": {"min_mean_quality": 99}}).json()
    assert not v["valid"]


def _make_experiment(client, auth, name="E2E ChIP test"):
    e = client.post("/api/experiments", headers=auth, json={"name": name, "assay": "chipseq",
                                                            "conditions": [{"name": "control"}, {"name": "treated"}],
                                                            "contrasts": [{"name": "treated_vs_control", "treatment": "treated", "reference": "control"}]}).json()
    pairs = client.post("/api/experiments/detect-pairs", headers=auth, json={"directory": "raw:run1"}).json()
    assert {s["sample_id"] for s in pairs["samples"]} == {"CTRL_rep1", "CTRL_rep2", "TREAT_rep1", "TREAT_rep2", "INPUT"}
    samples = []
    for s in pairs["samples"]:
        cond = "control" if s["sample_id"].startswith("CTRL") else "treated" if s["sample_id"].startswith("TREAT") else None
        files = {"runs": s["runs"]} if len(s["runs"]) > 1 else {k: v for k, v in s["runs"][0].items() if k != "lane"}
        samples.append({"sample_id": s["sample_id"], "condition": cond, "replicate": int(s["sample_id"][-1]) if cond else 1,
                        "is_control": s["sample_id"] == "INPUT", "files": files})
    r = client.put(f"/api/experiments/{e['id']}/samples", headers=auth, json={"samples": samples})
    assert r.status_code == 200, r.text
    return r.json()


def test_experiment_import_and_validation(client, auth, tmp_root):
    exp = _make_experiment(client, auth, "validation test")
    meta = (tmp_root / "raw" / "run1" / "sample_metadata.tsv").read_text()
    r = client.post(f"/api/experiments/{exp['id']}/import-samplesheet", headers=auth, json={"content": meta, "mode": "merge"})
    assert r.status_code == 200
    s = {x["sample_id"]: x for x in r.json()["samples"]}
    assert s["CTRL_rep1"]["batch"] == "batch1" and s["TREAT_rep1"]["attributes"]["antibody"] == "H3K27ac"
    v = client.post(f"/api/experiments/{exp['id']}/validate", headers=auth, json={"pipeline_id": PID}).json()
    assert v["valid"], v["issues"]
    # introduce problems: duplicate id, missing file, unknown control
    bad = r.json()["samples"]
    bad[1]["sample_id"] = bad[0]["sample_id"]
    bad[2]["files"] = {"fastq_1": "raw:run1/missing_R1.fastq.gz"}
    bad[3]["control_id"] = "nope"
    client.put(f"/api/experiments/{exp['id']}/samples", headers=auth, json={"samples": bad})
    v = client.post(f"/api/experiments/{exp['id']}/validate", headers=auth, json={"pipeline_id": PID}).json()
    msgs = " | ".join(i["message"] for i in v["issues"])
    assert not v["valid"] and "Duplicate sample ID" in msgs and "not found" in msgs.lower() and "Control 'nope'" in msgs


def test_samplesheet_generation_expands_lanes(client, auth):
    exp = _make_experiment(client, auth, "sheet test")
    sheet = client.post(f"/api/experiments/{exp['id']}/samplesheet", headers=auth, json={"pipeline_id": PID}).json()
    assert sheet["columns"] == ["sample", "fastq_1", "fastq_2", "condition", "replicate"]
    treat1 = [r for r in sheet["rows"] if r["sample"] == "TREAT_rep1"]
    assert len(treat1) == 2  # two lanes -> two rows of one sample
    assert all(os.path.isabs(r["fastq_1"]) for r in sheet["rows"])


def test_launch_monitor_results_and_resume(client, auth, tmp_root):
    exp = _make_experiment(client, auth, "launch test")
    body = {"pipeline_id": PID, "engine": "bcflow", "experiment_id": exp["id"], "output_dir": "results:e2e/run1",
            "params": {"min_read_length": 60, "min_mean_quality": 25, "report_title": "E2E QC"},
            # keep_work: this run is resumed after it completed, so its finished steps must still be there
            "resources": {"max_cpus": 2, "max_memory_gb": 2, "keep_work": True}}
    # validation failure surfaces as 422 with issues
    bad = dict(body, params={"min_mean_quality": 500})
    r = client.post("/api/runs", headers=auth, json=bad)
    assert r.status_code == 422 and r.json()["detail"]["issues"]
    # dry run does not execute
    dry = client.post("/api/runs", headers=auth, json=dict(body, dry_run=True))
    assert dry.status_code == 200 and dry.json()["status"] == "pending"
    r = client.post("/api/runs", headers=auth, json=body)
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["status"] in ("running", "completed")
    assert run["provenance"]["pipeline"]["slug"] == PID and len(run["provenance"]["inputs"]) >= 10
    done = wait_for_run(client, auth, run["id"])
    assert done["status"] == "completed", done.get("error")
    assert done["progress"]["total"] == 6 and done["progress"]["done"] == 6
    assert done["progress"]["processes"]["FASTQ_STATS"]["completed"] == 5
    log = client.get(f"/api/runs/{run['id']}/log", headers=auth).json()["content"]
    assert "Submitted process > QC_REPORT" in log and "workflow completed successfully" in log
    out = tmp_root / "results" / "e2e" / "run1"
    summary = (out / "report" / "qc_summary.tsv").read_text().splitlines()
    assert len(summary) == 6 and "E2E QC" in (out / "report" / "qc_report.html").read_text()
    assert json.loads((out / "biocompute_provenance.json").read_text())["status"] == "completed"
    # results API
    res = client.get(f"/api/results/{run['id']}", headers=auth).json()
    assert {e["name"] for e in res["entries"]} >= {"report", "fastq_stats"}
    f = client.get(f"/api/results/{run['id']}/file", params={"path": "report/qc_summary.tsv"}, headers=auth).json()
    assert f["content"].startswith("sample\tcondition")
    assert client.get(f"/api/results/{run['id']}/file", params={"path": "../../etc/passwd"}, headers=auth).status_code == 404
    # resume reuses cached tasks
    r = client.post(f"/api/runs/{run['id']}/resume", headers=auth)
    assert r.status_code == 200
    done = wait_for_run(client, auth, run["id"])
    assert done["status"] == "completed" and done["attempt"] == 2
    assert done["progress"]["processes"]["FASTQ_STATS"]["cached"] == 5
    hist = client.get(f"/api/pipelines/{PID}/history", headers=auth).json()
    assert any(h["id"] == run["id"] for h in hist)


def _slow_pipeline(tmp_root):
    d = tmp_root / "raw" / "slowpipe"
    d.mkdir(parents=True, exist_ok=True)
    (d / "bcflow.json").write_text(json.dumps({"engine": "bcflow", "name": "slow", "requires": ["sleep"],
                                               "steps": [{"id": "SLEEP", "scope": "aggregate", "command": ["sleep", "{params.seconds}"],
                                                          "outputs": {}}]}))
    return d


def test_failure_cancel_and_lost(client, auth, tmp_root):
    _slow_pipeline(tmp_root)
    p = client.post("/api/pipelines/import/local", headers=auth, json={"path": "raw:slowpipe", "name": "Slow test"})
    assert p.status_code == 200, p.text
    pid = p.json()["id"]
    r = client.post("/api/runs", headers=auth, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": "results:slow1",
                                                    "params": {"seconds": "30"}}).json()
    assert r["status"] == "running"
    c = client.post(f"/api/runs/{r['id']}/cancel", headers=auth)
    assert c.json()["status"] == "cancelling"
    done = wait_for_run(client, auth, r["id"], timeout=30)
    assert done["status"] == "cancelled"
    # failure: invalid argument to sleep
    r = client.post("/api/runs", headers=auth, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": "results:slow2",
                                                    "params": {"seconds": "notanumber"}}).json()
    done = wait_for_run(client, auth, r["id"], timeout=30)
    assert done["status"] == "failed" and done["exit_code"] != 0 and done["error"]
    # lost: supervisor killed with SIGKILL (simulates a host crash) -> reconciled as lost
    r = client.post("/api/runs", headers=auth, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": "results:slow3",
                                                    "params": {"seconds": "30"}}).json()
    from app.db import SessionLocal
    from app.models import Run

    with SessionLocal() as db:
        run = db.get(Run, r["id"])
        os.killpg(os.getpgid(run.pid), signal.SIGKILL)
    import time

    time.sleep(0.5)
    done = wait_for_run(client, auth, r["id"], timeout=15)
    assert done["status"] == "lost"


def test_presets_and_export(client, auth):
    r = client.post(f"/api/pipelines/{PID}/presets", headers=auth, json={"name": "strict", "params": {"min_mean_quality": 30}})
    assert r.status_code == 200
    assert any(p["name"] == "strict" for p in client.get(f"/api/pipelines/{PID}/presets", headers=auth).json())
    txt = client.post(f"/api/pipeline-schemas/{PID}/export", headers=auth, params={"fmt": "yaml"},
                      json={"params": {"min_mean_quality": 30, "report_title": "x"}}).text
    assert "min_mean_quality: 30" in txt


def test_duplicate_and_schema_wizard(client, auth):
    r = client.post(f"/api/pipelines/{PID}/duplicate", headers=auth, json={"name": "My QC copy"})
    assert r.status_code == 200
    new = r.json()
    r = client.post(f"/api/pipeline-schemas/{new['id']}/author", headers=auth,
                    json={"fields": [{"name": "threshold", "type": "integer", "default": 3, "group": "custom"}], "write_to_pipeline": True})
    assert r.status_code == 200
    form = client.get(f"/api/pipeline-schemas/{new['id']}", headers=auth).json()["form"]
    assert form["groups"][0]["fields"][0]["name"] == "threshold"
    assert Path(client.get(f"/api/pipelines/{new['id']}", headers=auth).json()["versions"][0]["path"], "nextflow_schema.json").exists()
