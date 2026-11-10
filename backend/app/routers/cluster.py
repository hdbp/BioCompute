"""Nodes, discovery, allocations, enrollment and the worker-agent API."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import EnrollmentToken, Node, NodeAllocation, NodeMetric, User
from ..schemas import (AgentEnroll, AgentHeartbeat, AllocationIn, DiscoveryReport, ManualNodeIn, NodeOut, NodeTransition,
                       NodeUpdate, PlacementIn, TokenCreate)
from ..security import audit, require_admin, require_viewer, token_digest
from ..services import cluster, events, fs

nodes_router = APIRouter(prefix="/api/nodes", tags=["cluster"])
discovery_router = APIRouter(prefix="/api/discovery", tags=["cluster"])
alloc_router = APIRouter(prefix="/api/allocations", tags=["cluster"])
agent_router = APIRouter(prefix="/api/agent", tags=["agent"])


def node_out(n: Node) -> NodeOut:
    o = NodeOut.model_validate(n)
    o.eligibility = cluster.eligibility(n)
    return o


def get_node(db: Session, nid: str) -> Node:
    n = db.get(Node, nid)
    if not n:
        raise HTTPException(404, "Node not found")
    return n


@nodes_router.get("", response_model=list[NodeOut])
def list_nodes(state: str | None = None, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    cluster.refresh_states(db)
    db.commit()
    q = db.query(Node)
    if state:
        q = q.filter(Node.state.in_(state.split(",")))
    return [node_out(n) for n in q.order_by(Node.is_controller.desc(), Node.hostname).all()]


@nodes_router.get("/{nid}", response_model=NodeOut)
def node_detail(nid: str, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return node_out(get_node(db, nid))


@nodes_router.get("/{nid}/metrics")
def node_metrics(nid: str, minutes: int = 120, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    since = datetime.now(timezone.utc) - timedelta(minutes=min(minutes, 60 * 24 * 7))
    rows = db.query(NodeMetric).filter(NodeMetric.node_id == nid, NodeMetric.ts >= since).order_by(NodeMetric.ts).all()
    return [{"ts": r.ts, "cpu": r.cpu_percent, "mem": r.mem_percent, "load1": r.load1} for r in rows]


@nodes_router.patch("/{nid}", response_model=NodeOut)
def update_node(nid: str, body: NodeUpdate, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    n = get_node(db, nid)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(n, k, v)
    audit(db, admin.username, "node.update", n.hostname, **body.model_dump(exclude_unset=True))
    db.commit()
    return node_out(n)


@nodes_router.post("/{nid}/transition", response_model=NodeOut)
def transition(nid: str, body: NodeTransition, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Explicit lifecycle changes. Discovery never implies permission; an admin authorizes."""
    n = get_node(db, nid)
    a = body.action
    if n.is_controller and a in ("revoke", "remove", "disable"):
        raise HTTPException(400, "The controller node cannot be revoked or removed")
    if a == "authorize":
        if n.state != "discovered":
            raise HTTPException(409, f"Only discovered devices can be authorized (node is {n.state})")
        n.state = "candidate"
    elif a == "revoke":
        n.state = "discovered"
        n.agent_token_hash = None
        if n.allocation:
            n.allocation.enabled = False
    elif a == "enable":
        if n.state not in ("active", "enrolled", "offline", "draining", "disabled") and not n.is_controller:
            raise HTTPException(409, "Node must be enrolled (agent installed) before it can participate")
        if n.state == "disabled":
            n.state = "enrolled"
        if n.allocation is None:
            cluster.apply_preset(n, "balanced")
        n.allocation.enabled = True
        n.allocation.draining = False
    elif a == "disable":
        if n.allocation:
            n.allocation.enabled = False
        n.state = "disabled"
    elif a in ("drain", "undrain"):
        if not n.allocation:
            raise HTTPException(409, "Node has no allocation")
        n.allocation.draining = a == "drain"
        n.state = "draining" if a == "drain" else ("active" if n.agent_installed else "enrolled")
    elif a == "remove":
        audit(db, admin.username, "node.remove", n.hostname)
        db.delete(n)
        db.commit()
        events.publish("nodes", {"kind": "removed", "node_id": nid})
        return NodeOut.model_validate({**{c: getattr(n, c) for c in NodeOut.model_fields if hasattr(n, c)}, "allocation": None})
    audit(db, admin.username, f"node.{a}", n.hostname)
    db.commit()
    events.publish("nodes", {"kind": a, "node_id": n.id})
    return node_out(n)


@nodes_router.post("/manual", response_model=NodeOut)
def add_manual(body: ManualNodeIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    reachable = None
    if body.probe and body.ssh_port:
        reachable = cluster.probe_endpoint(body.hostname, body.ssh_port)
    n = cluster.upsert_node(db, {"hostname": body.hostname, "addresses": body.addresses, "os": body.os,
                                 "fingerprint": f"host:{cluster.short_hostname(body.hostname)}"}, "manual", site=body.site)
    if body.ssh_port:
        n.notes = (n.notes + f"\nSSH endpoint port {body.ssh_port}" + (f" (reachable: {reachable})" if reachable is not None else "")).strip()
    audit(db, admin.username, "node.manual_add", body.hostname)
    db.commit()
    return node_out(n)


@nodes_router.get("/{nid}/condor-config", response_class=PlainTextResponse)
def condor_config(nid: str, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return cluster.condor_config(get_node(db, nid))


# --------------------------------------------------------------------------- allocations
@alloc_router.get("/presets")
def presets(_: User = Depends(require_viewer)):
    return cluster.PRESETS


@alloc_router.put("/{nid}", response_model=NodeOut)
def update_allocation(nid: str, body: AllocationIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    n = get_node(db, nid)
    a = n.allocation or NodeAllocation(node_id=n.id)
    n.allocation = a
    data = body.model_dump(exclude_unset=True)
    if "max_cpus" in data and n.cpu_logical and data["max_cpus"] > n.cpu_logical:
        raise HTTPException(400, f"max_cpus exceeds the node's {n.cpu_logical} logical CPUs")
    if "max_memory_gb" in data and n.mem_total and data["max_memory_gb"] > n.mem_total / 2**30:
        raise HTTPException(400, f"max_memory_gb exceeds the node's {n.mem_total / 2**30:.1f} GB RAM")
    if "gpus_allowed" in data and data["gpus_allowed"] > len(n.gpus or []):
        raise HTTPException(400, "More GPUs allocated than detected on the node")
    if data.get("data_policy") == "any" and not n.is_controller and n.site != get_settings().site_name:
        raise HTTPException(400, "Only nodes within the controller's site may accept unrestricted data")
    for k, v in data.items():
        setattr(a, k, v)
    if data.get("allowed_hours") == "":
        a.allowed_hours = None
    a.preset = "custom"
    audit(db, admin.username, "allocation.update", n.hostname, **data)
    db.commit()
    return node_out(n)


@alloc_router.post("/apply-preset")
def apply_preset_all(preset: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    count = 0
    for n in db.query(Node).filter(Node.state.notin_(("discovered", "candidate"))).all():
        enabled = n.allocation.enabled if n.allocation else n.is_controller
        cluster.apply_preset(n, preset)
        n.allocation.enabled = enabled
        count += 1
    audit(db, admin.username, "allocation.apply_preset", preset, nodes=count)
    db.commit()
    return {"ok": True, "nodes": count}


@alloc_router.post("/placement")
def placement(body: PlacementIn, _: User = Depends(require_viewer), db: Session = Depends(get_db)):
    restricted, size = False, 0
    paths = list(body.input_paths)
    if body.experiment_id:
        from ..models import Experiment

        e = db.get(Experiment, body.experiment_id)
        if e:
            for s in e.samples:
                paths += [v for v in (s.files or {}).values() if isinstance(v, str) and v]
    for vp in paths:
        try:
            root, p = fs.resolve(vp)
            restricted |= root.restricted
            size += p.stat().st_size if p.is_file() else 0
        except HTTPException:
            continue
    return cluster.placement(db, input_bytes=size, restricted=restricted, requested_cpus=body.requested_cpus,
                             requested_mem_gb=body.requested_mem_gb, requested_nodes=body.node_ids or None,
                             requires_gpu=body.requires_gpu) | {"input_bytes": size, "restricted": restricted}


# --------------------------------------------------------------------------- discovery
@discovery_router.post("/scan")
def scan(methods: str | None = None, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    summary = cluster.run_discovery(db, methods.split(",") if methods else None)
    audit(db, admin.username, "discovery.scan", None, **{k: v.get("found") for k, v in summary.items()})
    db.commit()
    events.publish("nodes", {"kind": "scan"})
    return summary


@discovery_router.get("/config")
def discovery_config(_: User = Depends(require_viewer)):
    s = get_settings()
    return {"mdns": s.discovery_enable_mdns, "tailscale": s.discovery_enable_tailscale, "htcondor": s.discovery_enable_htcondor,
            "neighbors": s.discovery_enable_neighbors, "authorized_cidrs": s.discovery_authorized_cidrs,
            "site": s.site_name, "agent_port": s.agent_port,
            "notes": ["Active probing is limited to authorized CIDRs.", "Neighbor discovery is passive (reads the ARP/NDP cache).",
                      "Discovery never grants execution permission."]}


@discovery_router.post("/tokens")
def create_token(body: TokenCreate, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    tok = cluster.issue_token(db, body.label, body.site, body.ttl_hours, admin.username, body.allow_discovery_reports)
    audit(db, admin.username, "enrollment.token_issued", body.label, site=body.site, ttl_hours=body.ttl_hours)
    db.commit()
    return {"token": tok, "expires_in_hours": body.ttl_hours,
            "note": "Shown once. Give it to the machine owner to run the agent installer; it can be used for one enrollment."}


@discovery_router.get("/tokens")
def list_tokens(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    return [{"id": t.id, "label": t.label, "site": t.site, "expires_at": t.expires_at, "used_by_node": t.used_by_node,
             "allow_discovery_reports": t.allow_discovery_reports, "created_by": t.created_by, "created_at": t.created_at}
            for t in db.query(EnrollmentToken).order_by(EnrollmentToken.created_at.desc()).all()]


@discovery_router.delete("/tokens/{tid}")
def revoke_token(tid: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    t = db.get(EnrollmentToken, tid)
    if not t:
        raise HTTPException(404)
    db.delete(t)
    audit(db, admin.username, "enrollment.token_revoked", t.label)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- agent API (token auth)
def _agent(db: Session, authorization: str | None) -> Node:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Agent token required")
    return cluster.node_by_agent_token(db, authorization.removeprefix("Bearer "))


@agent_router.post("/enroll")
def agent_enroll(body: AgentEnroll, db: Session = Depends(get_db)):
    node, agent_token = cluster.enroll(db, body.token, body.inventory)
    audit(db, f"agent:{node.hostname}", "node.enrolled", node.hostname, site=node.site)
    db.commit()
    events.publish("nodes", {"kind": "enrolled", "node_id": node.id})
    return {"node_id": node.id, "agent_token": agent_token, "heartbeat_seconds": 30,
            "message": "Participation is enabled." if node.allocation and node.allocation.enabled
            else "Participation is disabled until an administrator enables this node."}


@agent_router.post("/heartbeat")
def agent_heartbeat(body: AgentHeartbeat, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    node = _agent(db, authorization)
    inv = dict(body.inventory)
    inv.pop("fingerprint", None)  # identity is bound to the token, not to self-reported ids
    cluster.upsert_node(db, {**inv, "fingerprint": node.fingerprint}, "agent")
    node.last_seen = datetime.now(timezone.utc)
    if node.state in ("enrolled", "offline"):
        node.state = "active"
    cluster.record_metrics(db, node)
    db.commit()
    events.publish("nodes", {"kind": "heartbeat", "node_id": node.id})
    a = node.allocation
    return {"ok": True, "state": node.state, "eligibility": cluster.eligibility(node),
            "allocation": {"enabled": a.enabled, "max_cpus": a.max_cpus, "max_memory_gb": a.max_memory_gb,
                           "draining": a.draining} if a else None}


@agent_router.post("/discovery-report")
def agent_discovery_report(body: DiscoveryReport, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    """Discovery agents on other network segments report candidate devices (not enrollment)."""
    node = _agent(db, authorization)
    tok = db.query(EnrollmentToken).filter(EnrollmentToken.used_by_node == node.id,
                                         EnrollmentToken.allow_discovery_reports.is_(True)).first()
    if not tok or not tok.allow_discovery_reports:
        raise HTTPException(403, "This agent is not authorized to report discovered devices")
    for dev in body.devices[:500]:
        cluster.upsert_node(db, {k: dev.get(k) for k in ("hostname", "addresses", "os", "fingerprint")}, f"agent-report:{node.hostname}",
                            site=node.site)
    audit(db, f"agent:{node.hostname}", "discovery.report", body.network, devices=len(body.devices))
    db.commit()
    return {"ok": True, "accepted": min(len(body.devices), 500)}
