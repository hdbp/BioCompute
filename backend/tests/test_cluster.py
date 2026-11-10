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


def test_discovery_handles_real_world_provider_output(client, auth, monkeypatch):
    """Regression: the neighbour table lists one device per address (IPv4 + IPv6, same MAC);
    tailscale/condor return realistic shapes; a malformed entry must not fail the scan."""
    from app.services import cluster

    neigh = {"available": True, "devices": [
        {"hostname": "fritz-box", "addresses": ["192.168.178.1"], "fingerprint": "mac:aa:bb:cc:dd:ee:01"},
        {"hostname": "fritz-box", "addresses": ["2a02:810d::1"], "fingerprint": "mac:aa:bb:cc:dd:ee:01"},
        {"hostname": "192.168.178.30", "addresses": ["192.168.178.30"], "fingerprint": "host:192.168.178.30"},
        {"hostname": "192.168.178.30", "addresses": ["192.168.178.30"], "fingerprint": "host:192.168.178.30"},
        {"hostname": None, "addresses": None, "fingerprint": None, "cpu": "not-a-dict"},  # malformed
    ]}
    ts = {"available": True, "devices": [
        {"hostname": "imac", "os": "macOS", "addresses": ["100.101.1.2", "fd7a:115c::2"], "online": True, "fingerprint": "host:imac"},
        {"hostname": "imac", "os": "macOS", "addresses": ["100.101.1.2"], "online": True, "fingerprint": "host:imac"},
    ]}
    condor = {"available": True, "devices": [
        {"hostname": "condorbox", "fingerprint": "host:condorbox", "os": "Linux", "arch": "x86_64", "slots": 2,
         "cpu": {"logical": 12}, "memory": {"total": 64 * 2**30}, "htcondor": {"installed": True, "slots": 2}},
    ]}
    monkeypatch.setattr(cluster, "discover_neighbors", lambda: neigh)
    monkeypatch.setattr(cluster, "discover_tailscale", lambda: ts)
    monkeypatch.setattr(cluster, "discover_htcondor", lambda: condor)
    r = client.post("/api/discovery/scan", headers=auth, params={"methods": "controller,neighbors,tailscale,htcondor"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["neighbors"]["found"] == 5 and len(s["neighbors"]["errors"]) == 1
    nodes = client.get("/api/nodes", headers=auth).json()
    router = [n for n in nodes if "mac:aa:bb:cc:dd:ee:01" in n["id"] or n["hostname"] == "fritz-box"]
    assert len(router) == 1 and set(router[0]["addresses"]) == {"192.168.178.1", "2a02:810d::1"}
    assert sum(n["hostname"] == "imac" for n in nodes) == 1
    assert sum(n["hostname"] == "192.168.178.30" for n in nodes) == 1
    hs = next(n for n in nodes if n["hostname"] == "condorbox")
    assert hs["state"] == "discovered" and hs["cpu_logical"] == 12
    # scanning again is idempotent
    assert client.post("/api/discovery/scan", headers=auth, params={"methods": "neighbors,tailscale,htcondor"}).status_code == 200
    assert len(client.get("/api/nodes", headers=auth).json()) == len(nodes)


def test_neighbor_table_parsing(monkeypatch):
    import json as _json
    from app.services import cluster

    sample = [
        {"dst": "192.168.178.1", "dev": "enp5s0", "lladdr": "3c:a6:2f:00:00:01", "router": None, "state": ["REACHABLE"]},
        {"dst": "2a02:810d:1:2::1", "dev": "enp5s0", "lladdr": "3c:a6:2f:00:00:01", "router": None, "state": ["STALE"]},
        {"dst": "fe80::3ea6:2fff:fe00:1", "dev": "enp5s0", "lladdr": "3c:a6:2f:00:00:01", "state": ["STALE"]},
        {"dst": "192.168.178.77", "dev": "enp5s0", "state": ["FAILED"]},
        {"dst": "172.17.0.2", "dev": "docker0", "lladdr": "02:42:ac:11:00:02", "state": ["STALE"]},
    ]
    monkeypatch.setattr(cluster.shutil, "which", lambda name: "/usr/sbin/ip" if name == "ip" else None)
    monkeypatch.setattr(cluster, "_cmd", lambda argv, timeout=15: _json.dumps(sample))
    monkeypatch.setattr(cluster, "_rdns", lambda ip: "fritz-box" if ip == "192.168.178.1" else None)
    res = cluster.discover_neighbors()
    fps = [d["fingerprint"] for d in res["devices"]]
    assert res["available"] and len(res["devices"]) == 3  # link-local and FAILED skipped
    assert fps.count("mac:3c:a6:2f:00:00:01") == 2      # same router twice -> merged at upsert
    assert res["devices"][0]["hostname"] == "fritz-box" and res["devices"][1]["hostname"] == "2a02:810d:1:2::1"


def test_tailnet_membership_and_filters(client, auth, monkeypatch):
    from app.services import cluster

    ts = {"available": True, "devices": [
        {"hostname": "mbp-m3", "os": "macOS", "addresses": ["100.80.1.5", "fd7a:115c:a1e0::5"], "fingerprint": "host:mbp-m3",
         "tailscale": {"online": False, "dns_name": "mbp-m3.tail1234.ts.net", "ips": ["100.80.1.5"], "os": "macOS"}},
    ]}
    neigh = {"available": True, "devices": [{"hostname": "printer", "addresses": ["192.168.1.40"], "fingerprint": "mac:11:22:33:44:55:66"}]}
    monkeypatch.setattr(cluster, "discover_tailscale", lambda: ts)
    monkeypatch.setattr(cluster, "discover_neighbors", lambda: neigh)
    assert client.post("/api/discovery/scan", headers=auth, params={"methods": "tailscale,neighbors"}).status_code == 200
    # an enrolled machine whose own agent reports a tailnet address (no tailscale CLI on the controller)
    tok = client.post("/api/discovery/tokens", headers=auth, json={"label": "ts-agent", "site": "home"}).json()["token"]
    inv = {"fingerprint": "mid:tsagent", "hostname": "ts-worker", "os": "Linux", "arch": "x86_64", "cpu": {"logical": 8},
           "memory": {"total": 32 * 2**30}, "addresses": ["192.168.1.9", "100.99.2.3"], "utilization": {}}
    assert client.post("/api/agent/enroll", json={"token": tok, "inventory": inv}).status_code == 200

    nodes = {n["hostname"]: n for n in client.get("/api/nodes", headers=auth).json()}
    mbp = nodes["mbp-m3"]
    assert mbp["tailnet"]["member"] and mbp["tailnet"]["via"] == "tailscale status"
    assert mbp["tailnet"]["online"] is False and mbp["tailnet"]["dns_name"] == "mbp-m3.tail1234.ts.net"
    assert nodes["ts-worker"]["tailnet"] == {"member": True, "via": "tailnet address", "online": None, "dns_name": None, "ips": ["100.99.2.3"]}
    assert nodes["printer"]["tailnet"]["member"] is False

    inside = {n["hostname"] for n in client.get("/api/nodes", headers=auth, params={"tailnet": "true"}).json()}
    outside = {n["hostname"] for n in client.get("/api/nodes", headers=auth, params={"tailnet": "false"}).json()}
    assert {"mbp-m3", "ts-worker"} <= inside and "printer" in outside and not inside & outside
    by_src = {n["hostname"] for n in client.get("/api/nodes", headers=auth, params={"source": "neighbors"}).json()}
    assert "printer" in by_src and "mbp-m3" not in by_src
    reported = client.get("/api/nodes", headers=auth, params={"source": "agent-report"}).json()
    assert all(any(s.startswith("agent-report:") for s in n["discovery_sources"]) for n in reported)
