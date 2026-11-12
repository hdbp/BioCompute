"""One run the monitor cannot read must not stop other runs from being updated."""
from conftest import wait_for_run
from test_studio import QC_GRAPH

from app.db import SessionLocal
from app.models import Run
from app.services import runner


def test_a_broken_run_does_not_block_the_others(client, auth, monkeypatch):
    w = client.post("/api/studio/workflows", headers=auth, json={"name": "Monitor QC", "graph": QC_GRAPH}).json()
    pid = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth).json()["pipeline_id"]
    ids = []
    for n in ("a", "b"):
        r = client.post("/api/runs", headers=auth, json={"pipeline_id": pid, "engine": "bcflow", "output_dir": f"results:mon_{n}",
                                                        "params": {"input": "raw:run1"}})
        assert r.status_code == 200, r.text
        ids.append(r.json()["id"])
    for rid in ids:
        assert wait_for_run(client, auth, rid)["status"] == "completed"
    good, bad = ids
    with SessionLocal() as db:   # pretend both are still running; their exit_code files are on disk
        for rid in ids:
            db.get(Run, rid).status = "running"
        db.commit()
    real = runner._poll_run

    def flaky(db, run):
        if run.id == bad:
            raise OSError("simulated unreadable run folder")
        return real(db, run)

    monkeypatch.setattr(runner, "_poll_run", flaky)
    runner._poll_once()
    with SessionLocal() as db:
        assert db.get(Run, good).status == "completed"   # updated although the other run raised
        assert db.get(Run, bad).status == "running"      # not given up on after one failure
    for _ in range(runner.MAX_POLL_FAILURES):
        runner._poll_once()
    with SessionLocal() as db:
        lost = db.get(Run, bad)
        assert lost.status == "lost" and "could not read" in lost.error
