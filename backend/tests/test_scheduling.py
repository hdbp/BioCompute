"""Spec-aware placement and link-speed measurement."""
import importlib.util
import socket
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest
import uvicorn

from app.db import SessionLocal
from app.main import app
from app.models import Node
from app.services import cluster

GB = 2**30
ROOT = Path(__file__).resolve().parents[2]


def _worker(db, name, *, cpus, mem_gb, free_gb, mbps=None, site="lab", gpus=0, cpu_pct=5.0, disk_free_gb=500):
    n = cluster.upsert_node(db, {"fingerprint": f"mid:{name}", "hostname": name, "os": "Linux", "arch": "x86_64",
                                 "cpu": {"logical": cpus}, "memory": {"total": mem_gb * GB, "available": free_gb * GB},
                                 "gpus": [{"vendor": "nvidia", "name": "RTX A4000"}] * gpus,
                                 "scratch": {"path": "/scratch", "total": 2000 * GB, "free": disk_free_gb * GB},
                                 "utilization": {"cpu_percent": cpu_pct, "mem_percent": 10, "power": {"has_battery": False, "on_ac": True}},
                                 **({"link": {"down_mbps": mbps, "up_mbps": mbps, "rtt_ms": 3}} if mbps else {})}, "agent", site=site)
    n.state, n.agent_installed, n.site = "active", True, site
    n.last_seen = datetime.now(timezone.utc)
    cluster.apply_preset(n, "max")
    n.allocation.enabled = True
    n.allocation.data_policy = "approved-staging"
    n.allocation.gpus_allowed = gpus
    n.allocation.scratch_limit_gb = 1000
    db.flush()
    return n


@pytest.fixture
def nodes(client):
    with SessionLocal() as db:
        made = [_worker(db, "sched-lab-fast", cpus=32, mem_gb=128, free_gb=100, mbps=940),
                _worker(db, "sched-home-slow", cpus=12, mem_gb=64, free_gb=40, mbps=40, site="home"),
                _worker(db, "sched-gpu", cpus=8, mem_gb=32, free_gb=20, mbps=900, gpus=1, disk_free_gb=30)]
        db.commit()
        ids = [n.id for n in made]
    yield ids
    with SessionLocal() as db:
        for i in ids:
            db.delete(db.get(Node, i))
        db.commit()


def _plan(**kw):
    with SessionLocal() as db:
        args = dict(input_bytes=0, restricted=False, requested_cpus=0, requested_mem_gb=0, requested_nodes=None)
        args.update(kw)
        return cluster.placement(db, **args)


def test_big_input_prefers_fast_worker_but_default_stays_data_local(nodes):
    p = _plan(input_bytes=200 * GB)
    by = {c["hostname"]: c for c in p["candidates"]}
    fast, slow, ctl = by["sched-lab-fast"], by["sched-home-slow"], next(c for c in p["candidates"] if c["is_controller"])
    assert fast["eligible"] and fast["transfer_seconds"] > 0 and ctl["transfer_seconds"] == 0
    # a 32-core node on a 940 Mbit/s link beats the small controller even after copying 200 GB...
    assert fast["estimated_seconds"] < ctl["estimated_seconds"]
    # ...while 200 GB over a 40 Mbit/s home link takes longer than anything else
    assert slow["estimated_seconds"] > max(fast["estimated_seconds"], ctl["estimated_seconds"])
    assert p["fastest"]["hostname"] == "sched-lab-fast" and p["recommended"]["is_controller"]
    assert any("Mbit/s link (measured)" in f for f in fast["facts"])


def test_requirements_exclude_with_reasons(nodes):
    by = {c["hostname"]: c for c in _plan(input_bytes=GB, restricted=True)["candidates"]}
    assert not by["sched-home-slow"]["eligible"] and any("restricted" in r for r in by["sched-home-slow"]["reasons"])
    by = {c["hostname"]: c for c in _plan(input_bytes=GB, requested_mem_gb=64)["candidates"]}
    assert by["sched-lab-fast"]["eligible"] and not by["sched-gpu"]["eligible"]
    assert any("GB RAM free" in r for r in by["sched-gpu"]["reasons"])
    by = {c["hostname"]: c for c in _plan(input_bytes=GB, requires_gpu=True)["candidates"]}
    assert by["sched-gpu"]["eligible"] and not by["sched-lab-fast"]["eligible"]
    # a stated disk requirement excludes; an estimate only warns
    by = {c["hostname"]: c for c in _plan(input_bytes=GB, requested_disk_gb=100)["candidates"]}
    assert not by["sched-gpu"]["eligible"] and any("scratch free" in r for r in by["sched-gpu"]["reasons"])
    by = {c["hostname"]: c for c in _plan(input_bytes=20 * GB)["candidates"]}
    assert by["sched-gpu"]["eligible"] and any("estimated need" in w for w in by["sched-gpu"]["warnings"])


def test_busy_node_offers_fewer_cores(nodes):
    with SessionLocal() as db:
        n = db.get(Node, nodes[0])
        before = cluster.capacity(n)["cpus_free"]
        n.utilization = {**n.utilization, "cpu_percent": 75.0}
        db.commit()
        assert cluster.capacity(db.get(Node, nodes[0]))["cpus_free"] == pytest.approx(min(before, 32 * 0.25), abs=0.2)


def test_node_api_exposes_capacity(client, auth, nodes):
    n = client.get(f"/api/nodes/{nodes[1]}", headers=auth).json()
    cap = n["capacity"]
    assert cap["mem_free_gb"] > 0 and cap["disk_free_gb"] == 500 and cap["link"]["down_mbps"] == 40
    assert cap["link"]["basis"] == "measured"


@pytest.fixture(scope="module")
def live_url():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, lifespan="off", log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True


def test_agent_measures_link_and_controller_uses_it(client, auth, live_url):
    spec = importlib.util.spec_from_file_location("bc_agent", ROOT / "agent" / "biocompute_agent.py")
    agent = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(agent)
    tok = client.post("/api/discovery/tokens", headers=auth, json={"label": "speed", "site": "lab"}).json()["token"]
    inv = {"fingerprint": "mid:speedy", "hostname": "speedy", "os": "Linux", "arch": "x86_64", "cpu": {"logical": 4},
           "memory": {"total": 8 * GB, "available": 6 * GB}, "addresses": [], "utilization": {}}
    r = client.post("/api/agent/enroll", json={"token": tok, "inventory": inv}).json()
    cfg = {"controller": live_url, "agent_token": r["agent_token"]}
    assert client.get("/api/agent/speedtest", params={"size": 1000}).status_code == 401  # needs an agent token
    link = agent.measure_link(cfg)
    assert link and link["down_mbps"] > 0 and link["up_mbps"] > 0 and link["rtt_ms"] >= 0
    hb = client.post("/api/agent/heartbeat", headers={"Authorization": f"Bearer {r['agent_token']}"},
                     json={"inventory": {**inv, "link": link}})
    assert hb.status_code == 200
    cap = client.get(f"/api/nodes/{r['node_id']}", headers=auth).json()["capacity"]
    assert cap["link"]["basis"] == "measured" and cap["link"]["down_mbps"] == link["down_mbps"]
