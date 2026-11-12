"""A machine enrolling with a general token cannot take over the controller's record or an enrolled machine's."""


def _token(client, auth):
    r = client.post("/api/discovery/tokens", headers=auth, json={"label": "identity test"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_enrolling_with_the_controllers_hostname_creates_a_separate_node(client, auth):
    nodes = client.get("/api/nodes", headers=auth).json()
    ctl = next(n for n in nodes if n["is_controller"])
    inv = {"hostname": ctl["hostname"], "addresses": ctl.get("addresses") or [], "os": "Linux", "fingerprint": "mid:attacker-machine-id",
           "cpu": {"logical": 4, "physical": 4}, "memory": {"total": 8 * 2**30}, "agent_version": "x",
           "tailscale": {"online": True, "dns_name": "controller.fake.ts.net", "ips": ["100.64.0.9"]}}
    r = client.post("/api/agent/enroll", json={"token": _token(client, auth), "inventory": inv})
    assert r.status_code == 200, r.text
    after = client.get("/api/nodes", headers=auth).json()
    ctl2 = next(n for n in after if n["is_controller"])
    assert ctl2["id"] == ctl["id"] and ctl2["cpu_logical"] == ctl["cpu_logical"]  # controller record untouched (the attacker claimed 4 cores)
    new = next(n for n in after if n["id"] == r.json()["node_id"])
    assert new["id"] != ctl["id"] and not new["is_controller"]
    # its own claim about the tailnet is not taken as the controller's `tailscale status`
    assert new["tailnet"]["via"] != "tailscale status" and new["tailnet"]["dns_name"] is None
