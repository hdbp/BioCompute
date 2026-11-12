"""Runs on the controller reserve CPU cores and memory; a run that does not fit waits in the queue."""
from app.db import SessionLocal
from app.models import Run
from app.services import runner
from test_storage_cleanup import _pipeline, _run


def test_runs_reserve_cpu_and_memory(client, auth, monkeypatch):
    pid = _pipeline(client, auth, "Admission QC")
    done = _run(client, auth, pid, "results:admission")
    monkeypatch.setattr(runner, "controller_budget", lambda db: (8, 16.0))
    db = SessionLocal()
    try:
        src = db.get(Run, done["id"])
        cols = [c.key for c in Run.__table__.columns if c.key not in ("id", "created_at", "updated_at")]

        def fake(status, engine="nextflow", **res):
            r = Run(**{k: getattr(src, k) for k in cols})
            r.status, r.engine, r.resources, r.provenance = status, engine, res, {}
            db.add(r)
            db.flush()
            return r

        assert runner.wait_reason(db, fake("queued", max_cpus=8, max_memory_gb=16)) is None  # nothing else runs
        a = fake("running", max_cpus=6, max_memory_gb=4)
        assert "CPU cores" in runner.wait_reason(db, fake("queued", max_cpus=4, max_memory_gb=1))
        assert "memory" in runner.wait_reason(db, fake("queued", max_cpus=1, max_memory_gb=13))
        assert runner.wait_reason(db, fake("queued", max_cpus=2, max_memory_gb=12)) is None       # fits exactly
        assert runner.wait_reason(db, fake("queued", executor="condor", max_cpus=64)) is None     # tasks run elsewhere
        # a run without limits: Nextflow's local executor uses every core, bcflow one
        assert runner.claim(fake("queued")) == (runner.os.cpu_count() or 1, 4)
        assert runner.claim(fake("queued", engine="bcflow")) == (1, 0)
        assert "CPU cores" in runner.wait_reason(db, fake("queued", max_cpus=3))
        # a run larger than the whole budget (allocation lowered later) still starts once it is alone
        a.status = "completed"
        db.flush()
        assert runner.wait_reason(db, fake("queued", max_cpus=32, max_memory_gb=64)) is None
        # the run-count limit still applies
        monkeypatch.setattr(runner.get_settings(), "max_concurrent_runs", 1)
        fake("running", max_cpus=1, max_memory_gb=1)
        assert "execution slot" in runner.wait_reason(db, fake("queued", max_cpus=1, max_memory_gb=1))
    finally:
        db.rollback()
        db.close()


def test_capacity_endpoint(client, auth):
    c = client.get("/api/runs/capacity", headers=auth).json()
    assert c["cpus"] >= 1 and c["memory_gb"] > 0 and c["used_cpus"] >= 0 and "queued" in c
