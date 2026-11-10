"""Cluster management: discovery providers, node lifecycle, allocation presets,
HTCondor configuration and data-locality-aware placement.

Trust model
-----------
* *Discovery* only records that a device exists (state ``discovered``). It never
  grants permission to execute anything and never installs software.
* An administrator *authorizes* a device (``candidate``) and issues a one-time
  enrollment token. The worker owner installs the agent manually with that token
  (``enrolled``). Only enrolled + enabled nodes reporting heartbeats are ``active``.
* Active probing (TCP connects) is limited to explicitly authorized CIDRs.
"""
from __future__ import annotations

import ipaddress
import json
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import EnrollmentToken, Node, NodeAllocation, NodeMetric
from ..security import hash_secret, token_digest
from . import hostinfo

HEARTBEAT_STALE = timedelta(minutes=3)
STATES = ("discovered", "candidate", "enrolled", "active", "draining", "disabled", "offline")


def now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


# --------------------------------------------------------------------------- presets
PRESETS: dict[str, dict[str, Any]] = {
    "eco": {
        "label": "Eco", "description": "Minimal footprint: controller keeps half its cores; opportunistic "
        "machines only when idle, at night and on AC power.",
        "controller": {"cpu_fraction": 0.5, "mem_fraction": 0.5, "idle_only": False, "priority": 60},
        "worker": {"cpu_fraction": 0.5, "mem_fraction": 0.5, "idle_only": False, "priority": 40},
        "opportunistic": {"cpu_fraction": 0.25, "mem_fraction": 0.25, "idle_only": True, "priority": 10,
                          "allowed_hours": "22:00-07:00", "require_ac_power": True},
    },
    "balanced": {
        "label": "Balanced", "description": "Primary Linux nodes contribute most resources; Macs contribute "
        "when idle, laptops only on AC power.",
        "controller": {"cpu_fraction": 0.85, "mem_fraction": 0.8, "idle_only": False, "priority": 80},
        "worker": {"cpu_fraction": 0.85, "mem_fraction": 0.8, "idle_only": False, "priority": 60},
        "opportunistic": {"cpu_fraction": 0.5, "mem_fraction": 0.5, "idle_only": True, "priority": 20,
                          "allowed_hours": None, "require_ac_power": True},
    },
    "max": {
        "label": "Maximum Performance", "description": "All enrolled nodes contribute nearly all resources; "
        "controller reserves one core for the web service.",
        "controller": {"cpu_fraction": 1.0, "mem_fraction": 0.9, "idle_only": False, "priority": 90, "reserve_cpus": 1},
        "worker": {"cpu_fraction": 1.0, "mem_fraction": 0.9, "idle_only": False, "priority": 70},
        "opportunistic": {"cpu_fraction": 0.85, "mem_fraction": 0.75, "idle_only": False, "priority": 30,
                          "allowed_hours": None, "require_ac_power": True},
    },
}


def node_class(node: Node) -> str:
    if node.is_controller:
        return "controller"
    if node.os == "macOS" or ((node.utilization or {}).get("power") or {}).get("has_battery"):
        return "opportunistic"
    return "worker"


def apply_preset(node: Node, preset: str) -> NodeAllocation:
    if preset not in PRESETS:
        raise HTTPException(400, f"Unknown preset '{preset}'")
    p = PRESETS[preset][node_class(node)]
    alloc = node.allocation or NodeAllocation(node_id=node.id)
    cpus = node.cpu_logical or 1
    alloc.max_cpus = max(1, int(cpus * p["cpu_fraction"]) - int(p.get("reserve_cpus", 0)))
    mem_gb = (node.mem_total or 0) / 2**30
    alloc.max_memory_gb = round(max(1.0, mem_gb * p["mem_fraction"]), 1)
    alloc.idle_only = p["idle_only"]
    alloc.priority = p["priority"]
    alloc.allowed_hours = p.get("allowed_hours")
    alloc.require_ac_power = bool(p.get("require_ac_power", False)) and bool(
        ((node.utilization or {}).get("power") or {}).get("has_battery"))
    alloc.max_concurrent_jobs = max(1, alloc.max_cpus // 4)
    alloc.gpus_allowed = len(node.gpus or []) if preset != "eco" else 0
    alloc.preset = preset
    if node.is_controller:
        alloc.data_policy = "any"
    elif not alloc.data_policy:
        alloc.data_policy = "local-only"
    node.allocation = alloc
    return alloc


def in_allowed_hours(spec: str | None, t: datetime | None = None) -> bool:
    if not spec:
        return True
    m = re.fullmatch(r"(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})", spec.strip())
    if not m:
        return True
    t = t or datetime.now()
    a = int(m.group(1)) * 60 + int(m.group(2))
    b = int(m.group(3)) * 60 + int(m.group(4))
    cur = t.hour * 60 + t.minute
    return a <= cur < b if a <= b else (cur >= a or cur < b)


def eligibility(node: Node) -> dict[str, Any]:
    """Is this node allowed to accept work *right now*? Returns reasons when not."""
    reasons: list[str] = []
    a = node.allocation
    if node.state not in ("active", "enrolled", "draining") and not node.is_controller:
        reasons.append(f"node is {node.state}")
    if a is None:
        reasons.append("no resource allocation configured")
    else:
        if not a.enabled:
            reasons.append("participation disabled")
        if a.draining:
            reasons.append("draining for maintenance")
        if not in_allowed_hours(a.allowed_hours):
            reasons.append(f"outside allowed hours ({a.allowed_hours})")
        power = (node.utilization or {}).get("power") or {}
        if a.require_ac_power and power.get("has_battery") and not power.get("on_ac"):
            reasons.append("on battery power")
        if a.idle_only:
            idle = (node.utilization or {}).get("user_idle_seconds")
            cpu = (node.utilization or {}).get("cpu_percent")
            if (idle is not None and idle < 600) or (cpu is not None and cpu > 30):
                reasons.append("in interactive use (idle-only node)")
    if not node.is_controller:
        ls = _aware(node.last_seen)
        if ls is None or now() - ls > HEARTBEAT_STALE:
            reasons.append("no recent agent heartbeat")
    return {"eligible": not reasons, "reasons": reasons}


# --------------------------------------------------------------------------- node upsert
def short_hostname(name: str | None) -> str:
    """'lab-ws.example.org' -> 'lab-ws'; IP addresses are kept whole."""
    name = (name or "").strip().lower()
    try:
        ipaddress.ip_address(name)
        return name
    except ValueError:
        return name.split(".")[0]


TAILNET_V4 = ipaddress.ip_network("100.64.0.0/10")        # Tailscale CGNAT range
TAILNET_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")  # Tailscale ULA range


def tailnet_info(node: Node) -> dict[str, Any]:
    """Is this machine part of the user's tailnet, and how do we know?

    * seen by `tailscale status` on the controller (authoritative, includes online state)
    * otherwise an address in Tailscale's ranges (e.g. reported by the machine's own agent)
    """
    ts = (node.network or {}).get("tailscale")
    if ts or "tailscale" in (node.discovery_sources or []):
        ts = ts or {}
        return {"member": True, "via": "tailscale status", "online": ts.get("online"), "dns_name": ts.get("dns_name"),
                "ips": ts.get("ips") or [a for a in node.addresses or [] if _in_tailnet_range(a)]}
    ips = [a for a in node.addresses or [] if _in_tailnet_range(a)]
    if ips:
        return {"member": True, "via": "tailnet address", "online": None, "dns_name": None, "ips": ips}
    return {"member": False, "via": None, "online": None, "dns_name": None, "ips": []}


def _in_tailnet_range(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr.split("%")[0])
    except ValueError:
        return False
    return ip in (TAILNET_V4 if ip.version == 4 else TAILNET_V6)


def upsert_node(db: Session, inv: dict[str, Any], source: str, *, site: str | None = None) -> Node:
    """Insert or merge a discovered device. De-duplicates by fingerprint, then hostname/addresses."""
    fp = inv.get("fingerprint") or f"host:{(inv.get('hostname') or '').lower()}"
    node = db.query(Node).filter(Node.fingerprint == fp).one_or_none()
    hostname = short_hostname(inv.get("hostname"))
    strong = fp.startswith("mid:")

    def compatible(cand: Node) -> bool:
        # two different machine-ids are two machines, whatever their names/addresses
        return not (strong and cand.fingerprint.startswith("mid:") and cand.fingerprint != fp)

    if node is None and hostname:
        node = next((c for c in db.query(Node).filter(Node.hostname == hostname).all() if compatible(c)), None)
    addrs = set(inv.get("addresses") or [])
    # private addresses are reused across networks: only merge on address within the same site
    if node is None and addrs:
        for cand in db.query(Node).all():
            if addrs & set(cand.addresses or []) and compatible(cand) and (site is None or cand.site in (None, site)):
                node = cand
                break
    if node is None:
        node = Node(fingerprint=fp, hostname=hostname or (sorted(addrs)[0] if addrs else "unknown"), state="discovered",
                    site=site, addresses=[], discovery_sources=[], software={}, htcondor={}, utilization={}, gpus=[], disks=[])
        db.add(node)
        db.flush()  # make it visible to the next lookup in this scan (sessions don't autoflush)
    elif fp.startswith("mid:") and not node.fingerprint.startswith("mid:"):
        node.fingerprint = fp  # upgrade weak key to machine id
    node.addresses = sorted(set(node.addresses or []) | addrs)
    node.discovery_sources = sorted(set(node.discovery_sources or []) | {source})
    if site and not node.site:
        node.site = site
    cpu = inv.get("cpu") or {}
    mem = inv.get("memory") or {}
    for attr, val in (("os", inv.get("os")), ("os_version", inv.get("os_version")), ("arch", inv.get("arch")),
                      ("cpu_model", cpu.get("model")), ("cpu_physical", cpu.get("physical")),
                      ("cpu_logical", cpu.get("logical")), ("mem_total", mem.get("total")),
                      ("mem_available", mem.get("available"))):
        if val is not None:
            setattr(node, attr, val)
    if hostname and node.hostname != hostname and not node.hostname.replace(".", "").isdigit():
        pass  # keep the first hostname; aliases are visible in addresses
    elif hostname:
        node.hostname = hostname
    for attr in ("gpus", "disks", "software", "htcondor"):
        if inv.get(attr):
            setattr(node, attr, inv[attr])
    if isinstance(inv.get("tailscale"), dict):
        node.network = {**(node.network or {}), "tailscale": inv["tailscale"]}
    if inv.get("utilization"):
        node.utilization = inv["utilization"]
    return node


def register_controller(db: Session) -> Node:
    inv = hostinfo.collect(full=True, disk_paths=_disk_paths())
    node = upsert_node(db, inv, "controller", site=get_settings().site_name)
    node.is_controller = True
    node.agent_installed = True
    node.agent_version = "controller"
    node.last_seen = now()
    if node.state in ("discovered", "candidate", "enrolled", "offline"):
        node.state = "active"
    if node.allocation is None:
        db.flush()
        apply_preset(node, "balanced")
    return node


def _disk_paths() -> list[str]:
    s = get_settings()
    paths = [str(s.state_dir)] + [str(r["path"]) for r in s.data_roots]
    return paths


def record_metrics(db: Session, node: Node) -> None:
    u = node.utilization or {}
    if "cpu_percent" in u:
        db.add(NodeMetric(node_id=node.id, cpu_percent=u.get("cpu_percent", 0), mem_percent=u.get("mem_percent", 0),
                          load1=(u.get("load") or [None])[0]))


def refresh_states(db: Session) -> None:
    for n in db.query(Node).filter(Node.state.in_(("active", "enrolled", "offline"))).all():
        if n.is_controller:
            continue
        ls = _aware(n.last_seen)
        fresh = ls is not None and now() - ls < HEARTBEAT_STALE
        if n.state == "active" and not fresh:
            n.state = "offline"
        elif n.state in ("offline", "enrolled") and fresh and n.agent_installed:
            n.state = "active"


# --------------------------------------------------------------------------- enrollment
def issue_token(db: Session, label: str, site: str | None, ttl_hours: int, user: str,
                allow_discovery_reports: bool = False) -> str:
    token = "bce_" + secrets.token_urlsafe(32)
    db.add(EnrollmentToken(token_hash=token_digest(token), label=label, site=site,
                           expires_at=now() + timedelta(hours=ttl_hours), created_by=user,
                           allow_discovery_reports=allow_discovery_reports))
    return token


def enroll(db: Session, token: str, inv: dict[str, Any]) -> tuple[Node, str]:
    et = db.query(EnrollmentToken).filter(EnrollmentToken.token_hash == token_digest(token)).one_or_none()
    if et is None or _aware(et.expires_at) < now():
        raise HTTPException(401, "Invalid or expired enrollment token")
    if et.used_by_node:
        raise HTTPException(401, "Enrollment token already used")
    node = upsert_node(db, inv, "agent", site=et.site)
    if node.state in ("disabled",):
        raise HTTPException(403, "This machine has been disabled by an administrator")
    agent_token = "bca_" + secrets.token_urlsafe(32)
    node.agent_token_hash = token_digest(agent_token)
    node.agent_installed = True
    node.agent_version = inv.get("agent_version")
    node.state = "active"
    node.site = et.site or node.site
    node.last_seen = now()
    db.flush()
    et.used_by_node = node.id
    if node.allocation is None:
        alloc = NodeAllocation(node_id=node.id, enabled=False)  # owner must opt in explicitly
        node.allocation = alloc
        apply_preset(node, "balanced")
        node.allocation.enabled = False
    return node, agent_token


def node_by_agent_token(db: Session, token: str) -> Node:
    node = db.query(Node).filter(Node.agent_token_hash == token_digest(token)).one_or_none()
    if node is None:
        raise HTTPException(401, "Unknown agent")
    if node.state == "disabled":
        raise HTTPException(403, "Node disabled")
    return node


# --------------------------------------------------------------------------- discovery providers
def _authorized(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for cidr in get_settings().discovery_authorized_cidrs:
        try:
            if addr in ipaddress.ip_network(cidr, strict=False):
                return True
        except ValueError:
            continue
    return False


def _cmd(argv: list[str], timeout: float = 15) -> str | None:
    exe = shutil.which(argv[0])
    if not exe:
        return None
    try:
        p = subprocess.run([exe, *argv[1:]], capture_output=True, text=True, timeout=timeout)
        return p.stdout if p.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def discover_tailscale() -> dict[str, Any]:
    out = _cmd([get_settings().tailscale_bin, "status", "--json"])
    if out is None:
        return {"available": False, "detail": "tailscale CLI not available", "devices": []}
    data = json.loads(out)
    devs = []
    for peer in list((data.get("Peer") or {}).values()) + ([data["Self"]] if data.get("Self") else []):
        os_name = {"linux": "Linux", "macOS": "macOS", "windows": "Windows"}.get(peer.get("OS"), peer.get("OS"))
        ips = peer.get("TailscaleIPs") or []
        dns = (peer.get("DNSName") or "").rstrip(".")
        host = short_hostname(peer.get("HostName") or dns or (ips[0] if ips else ""))
        devs.append({"hostname": host, "os": os_name, "addresses": ips, "fingerprint": f"host:{host}",
                     "tailscale": {"online": bool(peer.get("Online")) or peer is data.get("Self"), "dns_name": dns or None,
                                   "ips": ips, "os": peer.get("OS"), "self": peer is data.get("Self"),
                                   "seen_at": now().isoformat()}})
    return {"available": True, "devices": devs}


def discover_htcondor() -> dict[str, Any]:
    out = _cmd([get_settings().condor_status_bin, "-json", "-af:j", "Machine", "OpSys", "Arch", "TotalCpus",
                "TotalMemory", "State", "Activity", "CondorVersion"], timeout=20)
    if out is None:
        out = _cmd([get_settings().condor_status_bin, "-json"], timeout=20)
    if out is None:
        return {"available": False, "detail": "condor_status not available", "devices": []}
    try:
        ads = json.loads(out) if out.strip().startswith("[") else [json.loads(x) for x in out.splitlines() if x.strip()]
    except json.JSONDecodeError:
        return {"available": False, "detail": "could not parse condor_status output", "devices": []}
    machines: dict[str, dict[str, Any]] = {}
    for ad in ads:
        m = short_hostname(ad.get("Machine"))
        if not m:
            continue
        d = machines.setdefault(m, {"hostname": m, "fingerprint": f"host:{m}", "slots": 0,
                                    "os": {"LINUX": "Linux", "OSX": "macOS"}.get(ad.get("OpSys"), ad.get("OpSys")),
                                    "arch": (ad.get("Arch") or "").lower().replace("x86_64", "x86_64"),
                                    "cpu": {"logical": ad.get("TotalCpus")},
                                    "memory": {"total": int(ad.get("TotalMemory") or 0) * 2**20 or None}})
        d["slots"] += 1
        d["htcondor"] = {"installed": True, "version": ad.get("CondorVersion"), "slots": d["slots"],
                         "state": ad.get("State"), "activity": ad.get("Activity")}
    return {"available": True, "devices": list(machines.values())}


def discover_neighbors() -> dict[str, Any]:
    """Passive: read the kernel neighbour (ARP/NDP) table. No packets are sent."""
    out = _cmd(["ip", "-j", "neigh"]) if shutil.which("ip") else None
    devs = []
    if out:
        try:
            for n in json.loads(out):
                if n.get("state") and "FAILED" in n["state"]:
                    continue
                ip = n.get("dst")
                if ip and not ip.startswith("fe80"):
                    devs.append({"hostname": _rdns(ip) or ip, "addresses": [ip], "mac": n.get("lladdr"),
                                 "fingerprint": f"mac:{n.get('lladdr')}" if n.get("lladdr") else f"host:{ip}"})
        except json.JSONDecodeError:
            pass
    else:
        out = _cmd(["arp", "-an"])
        for m in re.finditer(r"\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+)", out or ""):
            devs.append({"hostname": _rdns(m.group(1)) or m.group(1), "addresses": [m.group(1)],
                         "fingerprint": f"mac:{m.group(2)}"})
    return {"available": out is not None, "devices": devs,
            "detail": None if out is not None else "neither `ip neigh` nor `arp` is available on the controller"}


def _rdns(ip: str) -> str | None:
    try:
        return socket.gethostbyaddr(ip)[0].split(".")[0].lower()
    except (OSError, UnicodeError):
        return None


def discover_mdns(timeout: float = 3.0) -> dict[str, Any]:
    """Browse for BioCompute agents (_biocompute._tcp) and SSH/workstation services."""
    try:
        from zeroconf import ServiceBrowser, Zeroconf  # type: ignore
    except ImportError:
        return {"available": False, "detail": "python-zeroconf not installed", "devices": []}
    found: dict[str, dict[str, Any]] = {}
    types = ["_biocompute._tcp.local.", "_workstation._tcp.local.", "_ssh._tcp.local."]

    class L:
        def add_service(self, zc, typ, name):
            info = zc.get_service_info(typ, name, timeout=1500)
            if not info:
                return
            host = short_hostname(info.server or name)
            d = found.setdefault(host, {"hostname": host, "addresses": [], "services": [], "fingerprint": f"host:{host}"})
            d["addresses"] = sorted(set(d["addresses"]) | set(info.parsed_addresses()))
            d["services"].append(typ.split(".")[0])
            props = {k.decode(): (v.decode() if isinstance(v, bytes) else v) for k, v in (info.properties or {}).items()}
            if props.get("machine_id"):
                d["fingerprint"] = props["machine_id"]
            if typ.startswith("_biocompute"):
                d["agent"] = props

        def update_service(self, *a):
            pass

        def remove_service(self, *a):
            pass

    try:
        zc = Zeroconf()
    except OSError as exc:
        return {"available": False, "detail": f"mDNS unavailable: {exc}", "devices": []}
    try:
        ServiceBrowser(zc, types, L())
        time.sleep(timeout)
    finally:
        zc.close()
    return {"available": True, "devices": list(found.values())}


def probe_endpoint(host: str, port: int, timeout: float = 1.5) -> bool:
    """TCP reachability check - only for hosts inside authorized CIDRs."""
    try:
        ip = socket.gethostbyname(host)
    except OSError:
        return False
    if not _authorized(ip):
        raise HTTPException(403, f"{ip} is outside the authorized discovery scopes")
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


_scan_lock = threading.Lock()


def run_discovery(db: Session, methods: list[str] | None = None) -> dict[str, Any]:
    s = get_settings()
    methods = methods or ["controller", "tailscale", "htcondor", "mdns", "neighbors"]
    summary: dict[str, Any] = {}
    if not _scan_lock.acquire(blocking=False):
        raise HTTPException(409, "A discovery scan is already running")
    try:
        if "controller" in methods:
            try:
                with db.begin_nested():
                    register_controller(db)
                summary["controller"] = {"available": True, "found": 1}
            except Exception as exc:
                summary["controller"] = {"available": False, "found": 0, "detail": f"inventory failed: {type(exc).__name__}: {exc}"}
        providers = {
            "tailscale": (s.discovery_enable_tailscale, discover_tailscale),
            "htcondor": (s.discovery_enable_htcondor, discover_htcondor),
            "mdns": (s.discovery_enable_mdns, discover_mdns),
            "neighbors": (s.discovery_enable_neighbors, discover_neighbors),
        }
        for name, (enabled, fn) in providers.items():
            if name not in methods:
                continue
            if not enabled:
                summary[name] = {"available": False, "detail": "disabled in settings", "found": 0}
                continue
            try:
                res = fn()
            except Exception as exc:
                summary[name] = {"available": False, "detail": str(exc), "found": 0}
                continue
            errors: list[str] = []
            for dev in res.get("devices", []):
                try:
                    with db.begin_nested():  # one malformed device must not fail the whole scan
                        upsert_node(db, dev, name)
                except Exception as exc:
                    errors.append(f"{dev.get('hostname') or dev.get('addresses')}: {type(exc).__name__}")
            summary[name] = {"available": res["available"], "detail": res.get("detail"), "found": len(res.get("devices", []))}
            if errors:
                summary[name]["errors"] = errors[:20]
                summary[name]["detail"] = f"{len(errors)} device(s) could not be recorded"
        db.flush()
    finally:
        _scan_lock.release()
    return summary


# --------------------------------------------------------------------------- HTCondor config
def condor_config(node: Node) -> str:
    """HTCondor configuration snippet that enforces this node's allocation policy."""
    a = node.allocation
    if a is None:
        return "# no allocation configured\n"
    mem_mb = int(a.max_memory_gb * 1024)
    start = ["TRUE"]
    if not a.enabled or a.draining:
        start = ["FALSE"]
    if a.idle_only:
        start.append("(KeyboardIdle > 600) && (LoadAvg < 0.3)")
    if a.allowed_hours:
        m = re.fullmatch(r"(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})", a.allowed_hours)
        if m:
            a1 = int(m.group(1)) * 60 + int(m.group(2))
            a2 = int(m.group(3)) * 60 + int(m.group(4))
            op = "||" if a1 > a2 else "&&"
            start.append(f"((ClockMin >= {a1}) {op} (ClockMin < {a2}))")
    lines = [
        f"# BioCompute allocation for {node.hostname} (preset: {a.preset}) - generated {now():%Y-%m-%d %H:%M} UTC",
        "# Install as /etc/condor/config.d/90-biocompute.conf on the worker, then: condor_reconfig",
        "# These are scheduler limits. OS-level enforcement requires cgroups (Linux: BASE_CGROUP) -",
        "# macOS has no cgroup enforcement; limits there are advisory to the scheduler only.",
        f"NUM_CPUS = {a.max_cpus}",
        f"MEMORY = {mem_mb}",
        f"SLOT_TYPE_1 = cpus={a.max_cpus}, memory={mem_mb}, disk={int(a.scratch_limit_gb)}G" + (f", gpus={a.gpus_allowed}" if a.gpus_allowed else ""),
        "SLOT_TYPE_1_PARTITIONABLE = TRUE",
        "NUM_SLOTS_TYPE_1 = 1",
        f"START = {' && '.join(start)}",
        "SUSPEND = " + ("(KeyboardIdle < 60)" if a.idle_only else "FALSE"),
        "PREEMPT = " + ("(KeyboardIdle < 60) && (Activity == \"Suspended\")" if a.idle_only else "FALSE"),
        f"RANK = {a.priority}",
        f'BIOCOMPUTE_SITE = "{node.site or "unknown"}"',
        f'BIOCOMPUTE_DATA_POLICY = "{a.data_policy}"',
        "STARTD_ATTRS = $(STARTD_ATTRS) BIOCOMPUTE_SITE BIOCOMPUTE_DATA_POLICY",
    ]
    if a.gpus_allowed:
        lines.insert(5, "use feature : GPUs")
    if node.os == "Linux":
        lines.append("BASE_CGROUP = htcondor\nCGROUP_MEMORY_LIMIT_POLICY = hard")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- placement
def placement(db: Session, *, input_bytes: int, restricted: bool, requested_cpus: int, requested_mem_gb: float,
              requested_nodes: list[str] | None, requires_arch: str | None = None,
              requires_gpu: bool = False) -> dict[str, Any]:
    """Score candidate nodes for a run; data-local execution on the controller is preferred.

    Returns the recommendation, per-node rationale and a speed-up estimate for
    recruiting additional nodes (Amdahl-style with a transfer penalty).
    """
    s = get_settings()
    nodes = db.query(Node).filter(Node.state.notin_(("discovered", "candidate", "disabled"))).all()
    scored = []
    for n in nodes:
        el = eligibility(n)
        a = n.allocation
        reasons = list(el["reasons"])
        if requested_nodes and n.id not in requested_nodes and n.hostname not in requested_nodes:
            reasons.append("not selected for this run")
        if restricted and (n.site != s.site_name) and not n.is_controller:
            reasons.append(f"restricted data may not leave site '{s.site_name}'")
        if a and not n.is_controller and a.data_policy == "local-only" and input_bytes > 0:
            reasons.append("node policy forbids receiving staged data")
        if requires_arch and n.arch and n.arch != requires_arch:
            reasons.append(f"architecture {n.arch} != {requires_arch}")
        if requires_gpu and not (n.gpus and a and a.gpus_allowed):
            reasons.append("no GPU allocated")
        cpus = a.max_cpus if a else 0
        transfer_s = 0 if n.is_controller or n.site == s.site_name else input_bytes / (12.5e6)  # ~100 Mbit/s WAN
        score = (a.priority if a else 0) + min(cpus, 64) + (40 if n.is_controller else 0) - min(transfer_s / 60, 50)
        scored.append({"node_id": n.id, "hostname": n.hostname, "eligible": not reasons, "reasons": reasons,
                       "cpus": cpus, "memory_gb": a.max_memory_gb if a else 0, "transfer_seconds": round(transfer_s),
                       "score": round(score, 1), "is_controller": n.is_controller, "site": n.site})
    scored.sort(key=lambda x: (-x["eligible"], -x["score"]))
    eligible = [x for x in scored if x["eligible"]]
    primary = next((x for x in eligible if x["is_controller"]), eligible[0] if eligible else None)
    # speed-up estimate: parallel fraction p scales with added cores, transfer adds serial time
    est = None
    if primary:
        p = 0.85
        base_cores = max(1, min(primary["cpus"], requested_cpus or primary["cpus"]))
        extra = [x for x in eligible if x is not primary]
        add_cores = sum(x["cpus"] for x in extra)
        transfer = max((x["transfer_seconds"] for x in extra), default=0)
        t1 = 1.0
        t_local = (1 - p) + p / base_cores
        t_dist = (1 - p) + p / (base_cores + add_cores) if add_cores else t_local
        est = {"local_relative_time": round(t_local / t1, 4), "distributed_relative_time": round(t_dist / t1, 4),
               "speedup_if_recruited": round(t_local / t_dist, 2) if add_cores else 1.0,
               "additional_cores": add_cores, "max_transfer_seconds": transfer,
               "worthwhile": bool(add_cores) and t_local / t_dist > 1.3 and transfer < 1800,
               "assumptions": "85% parallelizable workload; ~100 Mbit/s between sites; shared filesystem required for Nextflow condor executor"}
    return {"recommended": primary, "candidates": scored, "estimate": est,
            "executor": "local" if not requested_nodes or (primary and requested_nodes == [primary["node_id"]]) else "condor"}
