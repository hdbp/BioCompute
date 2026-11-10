import json
import socket
import time
import urllib.error
import urllib.request

import pytest
from fastapi.testclient import TestClient

from app import agent_listener
from app.config import get_settings


def test_only_agent_endpoints_are_exposed(client):  # client: initialises the database
    c = TestClient(agent_listener.agent_app)
    assert c.get("/api/health").json()["listener"] == "agent"
    assert c.post("/api/agent/heartbeat", json={"inventory": {}}).status_code == 401  # needs an agent token
    assert c.post("/api/agent/enroll", json={"token": "nope", "inventory": {}}).status_code == 401
    for path in ("/api/nodes", "/api/auth/login", "/api/runs", "/api/settings", "/docs", "/openapi.json", "/"):
        assert c.get(path).status_code == 404, path


def test_resolve(monkeypatch):
    assert agent_listener.resolve(None) is None and agent_listener.resolve("off") is None
    assert agent_listener.resolve("100.64.1.2:9000") == ("100.64.1.2", 9000)
    assert agent_listener.resolve("100.64.1.2") == ("100.64.1.2", get_settings().agent_port)
    assert agent_listener.resolve("[fd7a:115c:a1e0::1]:8766") == ("fd7a:115c:a1e0::1", 8766)
    monkeypatch.setattr(get_settings(), "tailscale_bin", "definitely-not-installed")
    with pytest.raises(RuntimeError, match="tailscale CLI"):
        agent_listener.resolve("tailscale")


def test_listener_serves_on_its_own_address(monkeypatch):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    monkeypatch.setattr(get_settings(), "agent_listen", f"127.0.0.1:{port}")
    url = agent_listener.start()
    try:
        assert url == f"http://127.0.0.1:{port}"
        for _ in range(100):
            try:
                body = json.loads(urllib.request.urlopen(url + "/api/health", timeout=2).read())
                break
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.05)
        assert body["status"] == "ok"
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(url + "/api/nodes", timeout=2)
        assert e.value.code == 404
    finally:
        agent_listener.stop()
        agent_listener._state.update(url=None, server=None)
