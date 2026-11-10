import json
from pathlib import Path

from app.engines.adapters import NextflowAdapter
from app.services import hostinfo


def test_controller_registered(client, auth):
    nodes = client.get("/api/nodes", headers=auth).json()
    ctl = next(n for n in nodes if n["is_controller"])
    assert ctl["state"] == "active" and ctl["cpu_logical"] and ctl["mem_total"]
    assert ctl["allocation"]["enabled"] and ctl["eligibility"]["eligible"]


def test_hostinfo_detects():
    inv = hostinfo.collect(full=True)
    assert inv["fingerprint"] and inv["cpu"]["logical"] and inv["memory"]["total"]
    assert inv["arch"] in ("x86_64", "arm64")


def _inv(host, fp, os_="macOS", arch="arm64", cpus=16, mem=64 * 2**30, battery=True):
    return {"fingerprint": fp, "hostname": host, "os": os_, "arch": arch, "cpu": {"logical": cpus, "physical": cpus},
            "memory": {"total": mem, "available": mem // 2}, "addresses": ["10.99.1.5"],
            "utilization": {"cpu_percent": 5, "mem_percent": 40, "power": {"has_battery": battery, "on_ac": True}}}


def test_enrollment_flow_and_allocations(client, auth):
    tok = client.post("/api/discovery/tokens", headers=auth, json={"label": "macbook", "site": "home", "ttl_hours": 1}).json()["token"]
    r = client.post("/api/agent/enroll", json={"token": "bogus", "inventory": _inv("mbp", "mid:abc")})
    assert r.status_code == 401
    r = client.post("/api/agent/enroll", json={"token": tok, "inventory": _inv("mbp", "mid:abc")})
    assert r.status_code == 200, r.text
    agent = r.json()["agent_token"]
    assert client.post("/api/agent/enroll", json={"token": tok, "inventory": _inv("mbp", "mid:abc")}).status_code == 401  # single use
    h = {"Authorization": f"Bearer {agent}"}
    hb = client.post("/api/agent/heartbeat", headers=h, json={"inventory": _inv("mbp", "mid:spoofed")}).json()
    assert hb["state"] == "active" and hb["allocation"]["enabled"] is False  # opt-in required
    node = next(n for n in client.get("/api/nodes", headers=auth).json() if n["hostname"] == "mbp")
    assert node["allocation"]["require_ac_power"] and node["allocation"]["idle_only"]  # laptop -> opportunistic
    assert not node["eligibility"]["eligible"]
    # allocation validation: cannot exceed hardware, cannot accept unrestricted data off-site
    nid = node["id"]
    assert client.put(f"/api/allocations/{nid}", headers=auth, json={"max_cpus": 999}).status_code == 400
    assert client.put(f"/api/allocations/{nid}", headers=auth, json={"data_policy": "any"}).status_code == 400
    r = client.put(f"/api/allocations/{nid}", headers=auth, json={"max_cpus": 8, "allowed_hours": "22:00-06:00", "idle_only": False})
    assert r.status_code == 200 and r.json()["allocation"]["preset"] == "custom"
    client.post(f"/api/nodes/{nid}/transition", headers=auth, json={"action": "enable"})
    cfg = client.get(f"/api/nodes/{nid}/condor-config", headers=auth).text
    assert "NUM_CPUS = 8" in cfg and "ClockMin >= 1320" in cfg
    # placement: restricted raw data stays on the lab site
    plan = client.post("/api/allocations/placement", headers=auth, json={"input_paths": ["raw:run1/INPUT_S5_L001_R1_001.fastq.gz"]}).json()
    assert plan["restricted"] is True
    mbp = next(c for c in plan["candidates"] if c["hostname"] == "mbp")
    assert not mbp["eligible"] and any("restricted" in x for x in mbp["reasons"])
    assert plan["recommended"]["is_controller"]
    # drain / remove
    assert client.post(f"/api/nodes/{nid}/transition", headers=auth, json={"action": "drain"}).json()["state"] == "draining"
    assert client.post(f"/api/nodes/{nid}/transition", headers=auth, json={"action": "remove"}).status_code == 200
    assert client.post("/api/agent/heartbeat", headers=h, json={"inventory": {}}).status_code == 401


def test_discovery_permissions(client, auth):
    tok = client.post("/api/discovery/tokens", headers=auth, json={"label": "imac", "site": "home"}).json()["token"]
    agent = client.post("/api/agent/enroll", json={"token": tok, "inventory": _inv("imac", "mid:imac", arch="x86_64", battery=False)}).json()["agent_token"]
    r = client.post("/api/agent/discovery-report", headers={"Authorization": f"Bearer {agent}"}, json={"devices": [{"hostname": "printer"}]})
    assert r.status_code == 403  # token did not grant discovery reporting
    tok2 = client.post("/api/discovery/tokens", headers=auth, json={"label": "home-scout", "site": "home", "allow_discovery_reports": True}).json()["token"]
    scout = client.post("/api/agent/enroll", json={"token": tok2, "inventory": _inv("homeserver", "mid:hs", os_="Linux", arch="x86_64", battery=False)}).json()["agent_token"]
    r = client.post("/api/agent/discovery-report", headers={"Authorization": f"Bearer {scout}"},
                    json={"network": "home-lan", "devices": [{"hostname": "nas01", "addresses": ["192.168.1.20"]}]})
    assert r.status_code == 200
    nas = next(n for n in client.get("/api/nodes", headers=auth).json() if n["hostname"] == "nas01")
    assert nas["state"] == "discovered" and nas["site"] == "home"
    # discovered devices must be authorized; enabling straight away is refused
    assert client.post(f"/api/nodes/{nas['id']}/transition", headers=auth, json={"action": "enable"}).status_code == 409
    assert client.post(f"/api/nodes/{nas['id']}/transition", headers=auth, json={"action": "authorize"}).json()["state"] == "candidate"
    # manual entry + probing outside authorized CIDR refused
    r = client.post("/api/nodes/manual", headers=auth, json={"hostname": "127.0.0.1", "ssh_port": 22, "probe": True})
    assert r.status_code == 403
    r = client.post("/api/nodes/manual", headers=auth, json={"hostname": "labbox2", "addresses": ["10.99.3.3"], "site": "lab"})
    assert r.status_code == 200 and "manual" in r.json()["discovery_sources"]
    # dedupe: same machine reported again by another source merges
    client.post("/api/nodes/manual", headers=auth, json={"hostname": "labbox2.lab.example.org", "addresses": ["10.99.3.3"]})
    assert sum(1 for n in client.get("/api/nodes", headers=auth).json() if n["hostname"].startswith("labbox2")) == 1
    scan = client.post("/api/discovery/scan", headers=auth, params={"methods": "controller,tailscale,htcondor,neighbors"}).json()
    assert scan["controller"]["found"] == 1 and "tailscale" in scan


def test_presets_translate_to_policy(client, auth):
    presets = client.get("/api/allocations/presets", headers=auth).json()
    assert set(presets) == {"eco", "balanced", "max"}
    client.post("/api/allocations/apply-preset", headers=auth, params={"preset": "eco"})
    ctl = next(n for n in client.get("/api/nodes", headers=auth).json() if n["is_controller"])
    assert ctl["allocation"]["preset"] == "eco" and ctl["allocation"]["max_cpus"] == max(1, int(ctl["cpu_logical"] * 0.5))
    client.post("/api/allocations/apply-preset", headers=auth, params={"preset": "balanced"})


def test_nextflow_adapter_command(tmp_path):
    a = NextflowAdapter()
    (tmp_path / "params.json").write_text(json.dumps({"outdir": "/o"}))
    spec = a.launch(pipeline_path=Path("/pipe"), run_dir=tmp_path, work_dir=tmp_path / "work", params_file=tmp_path / "params.json",
                    resources={"max_cpus": 12, "max_memory_gb": 48, "profile": "docker,test;rm -rf /"}, session_name="bc_x_1",
                    resume_session="bc_x_0")
    argv = spec.argv
    assert argv[argv.index("run") + 1] == "/pipe" and argv[argv.index("-resume") + 1] == "bc_x_0"
    assert argv[argv.index("-profile") + 1] == "docker"  # unsafe profile token dropped
    cfg = (tmp_path / "biocompute.config").read_text()
    assert "cpus = 12" in cfg and "memory = '48 GB'" in cfg
    condor = a.config({"executor": "condor", "nodes": ["lab-ws", "homeserver", "bad host\""]}, tmp_path)
    assert "executor = 'condor'" in condor and 'Machine == "homeserver"' in condor and "bad host" not in condor
