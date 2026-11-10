"""Host inventory collection (stdlib only; uses psutil when available).

This module is shared verbatim by the controller and by the standalone worker agent
(``agent/biocompute_agent.py``), so it must not import anything from the app package.
Everything is *detected*, nothing about a machine is assumed.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import uuid
from typing import Any

try:  # optional
    import psutil  # type: ignore
except Exception:  # pragma: no cover
    psutil = None  # type: ignore

SOFTWARE = {
    "nextflow": (["nextflow", "-version"], r"version\s+(\d+\.\d+\.\d+)"),
    "java": (["java", "-version"], r'version "?(\d+[\.\d]*)'),
    "docker": (["docker", "--version"], r"(\d+\.\d+\.\d+)"),
    "podman": (["podman", "--version"], r"(\d+\.\d+\.\d+)"),
    "apptainer": (["apptainer", "--version"], r"(\d+\.\d+\.\d+)"),
    "singularity": (["singularity", "--version"], r"(\d+\.\d+\.\d+)"),
    "conda": (["conda", "--version"], r"(\d+\.\d+\.\d+)"),
    "mamba": (["mamba", "--version"], r"(\d+\.\d+\.\d+)"),
    "R": (["R", "--version"], r"R version (\d+\.\d+\.\d+)"),
    "python3": (["python3", "--version"], r"(\d+\.\d+\.\d+)"),
    "htcondor": (["condor_version"], r"\$CondorVersion: (\d+\.\d+\.\d+)"),
}


def _run(argv: list[str], timeout: float = 10) -> str | None:
    exe = shutil.which(argv[0])
    if not exe:
        return None
    try:
        p = subprocess.run([exe, *argv[1:]], capture_output=True, text=True, timeout=timeout)
        return (p.stdout or "") + (p.stderr or "")
    except (OSError, subprocess.TimeoutExpired):
        return None


def machine_id() -> str:
    """Stable per-machine identifier used for de-duplication across interfaces.

    BIOCOMPUTE_MACHINE_ID overrides it (cloned VMs/containers can share /etc/machine-id).
    """
    if os.environ.get("BIOCOMPUTE_MACHINE_ID"):
        return "mid:" + os.environ["BIOCOMPUTE_MACHINE_ID"].strip()
    for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            with open(path) as fh:
                v = fh.read().strip()
                if v:
                    return "mid:" + v
        except OSError:
            pass
    if platform.system() == "Darwin":
        out = _run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
        m = re.search(r'"IOPlatformUUID" = "([^"]+)"', out or "")
        if m:
            return "mid:" + m.group(1).lower()
    return "mac:" + hashlib.sha1(str(uuid.getnode()).encode()).hexdigest()[:16]


def cpu_info() -> dict[str, Any]:
    logical = os.cpu_count()
    physical = psutil.cpu_count(logical=False) if psutil else None
    model = None
    system = platform.system()
    if system == "Linux":
        try:
            with open("/proc/cpuinfo") as fh:
                txt = fh.read()
            m = re.search(r"model name\s*:\s*(.+)", txt)
            model = m.group(1).strip() if m else None
            if physical is None:
                cores = {(a, b) for a, b in re.findall(r"physical id\s*:\s*(\d+).*?core id\s*:\s*(\d+)", txt, re.S)}
                physical = len(cores) or None
        except OSError:
            pass
    elif system == "Darwin":
        model = (_run(["sysctl", "-n", "machdep.cpu.brand_string"]) or "").strip() or None
        if physical is None:
            v = (_run(["sysctl", "-n", "hw.physicalcpu"]) or "").strip()
            physical = int(v) if v.isdigit() else None
        perf = (_run(["sysctl", "-n", "hw.perflevel0.physicalcpu"]) or "").strip()
        eff = (_run(["sysctl", "-n", "hw.perflevel1.physicalcpu"]) or "").strip()
        if perf.isdigit():
            return {"model": model, "physical": physical, "logical": logical,
                    "performance_cores": int(perf), "efficiency_cores": int(eff) if eff.isdigit() else 0}
    return {"model": model, "physical": physical, "logical": logical}


def memory_info() -> dict[str, int | None]:
    if psutil:
        vm = psutil.virtual_memory()
        return {"total": vm.total, "available": vm.available}
    try:
        with open("/proc/meminfo") as fh:
            d = dict(re.findall(r"(\w+):\s+(\d+) kB", fh.read()))
        return {"total": int(d["MemTotal"]) * 1024, "available": int(d.get("MemAvailable", 0)) * 1024}
    except (OSError, KeyError):
        pass
    if platform.system() == "Darwin":
        v = (_run(["sysctl", "-n", "hw.memsize"]) or "").strip()
        return {"total": int(v) if v.isdigit() else None, "available": None}
    return {"total": None, "available": None}


def gpu_info() -> list[dict[str, Any]]:
    gpus: list[dict[str, Any]] = []
    out = _run(["nvidia-smi", "--query-gpu=name,memory.total,utilization.gpu", "--format=csv,noheader,nounits"])
    if out:
        for line in out.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 2 and parts[1].isdigit():
                gpus.append({"vendor": "nvidia", "name": parts[0], "memory_mb": int(parts[1]),
                             "utilization": float(parts[2]) if len(parts) > 2 and parts[2].replace(".", "").isdigit() else None})
    if platform.system() == "Darwin":
        out = _run(["system_profiler", "SPDisplaysDataType", "-json"], timeout=20)
        try:
            for d in json.loads(out or "{}").get("SPDisplaysDataType", []):
                gpus.append({"vendor": d.get("spdisplays_vendor", "apple"), "name": d.get("sppci_model"),
                             "cores": d.get("sppci_cores"), "metal": d.get("spdisplays_mtlgpufamilysupport")})
        except json.JSONDecodeError:
            pass
    if not gpus and platform.system() == "Linux" and shutil.which("rocm-smi"):
        gpus.append({"vendor": "amd", "name": "ROCm device"})
    return gpus


def disk_info(paths: list[str] | None = None) -> list[dict[str, Any]]:
    out = []
    seen = set()
    for p in paths or ["/", os.path.expanduser("~"), os.environ.get("TMPDIR", "/tmp")]:
        try:
            u = shutil.disk_usage(p)
        except OSError:
            continue
        key = (u.total, u.free // (1 << 30))
        if key in seen:
            continue
        seen.add(key)
        out.append({"path": p, "total": u.total, "free": u.free})
    return out


def addresses() -> list[str]:
    addrs: set[str] = set()
    if psutil:
        for ifname, lst in psutil.net_if_addrs().items():
            for a in lst:
                if a.family in (socket.AF_INET, socket.AF_INET6) and not a.address.startswith(("127.", "::1", "fe80")):
                    addrs.add(a.address.split("%")[0])
    else:
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None):
                ip = info[4][0]
                if not ip.startswith(("127.", "::1")):
                    addrs.add(ip)
        except socket.gaierror:
            pass
    return sorted(addrs)


def power_info() -> dict[str, Any] | None:
    if psutil and hasattr(psutil, "sensors_battery"):
        try:
            b = psutil.sensors_battery()
        except Exception:
            b = None
        if b is not None:
            return {"has_battery": True, "percent": b.percent, "on_ac": bool(b.power_plugged)}
    if platform.system() == "Darwin":
        out = _run(["pmset", "-g", "batt"]) or ""
        if "InternalBattery" in out:
            m = re.search(r"(\d+)%", out)
            return {"has_battery": True, "percent": int(m.group(1)) if m else None, "on_ac": "AC Power" in out}
    return {"has_battery": False, "on_ac": True}


def utilization() -> dict[str, Any]:
    u: dict[str, Any] = {}
    if psutil:
        u["cpu_percent"] = psutil.cpu_percent(interval=0.3)
        u["mem_percent"] = psutil.virtual_memory().percent
    try:
        u["load"] = list(os.getloadavg())
    except OSError:
        pass
    u["power"] = power_info()
    idle = _idle_seconds()
    if idle is not None:
        u["user_idle_seconds"] = idle
    return u


def _idle_seconds() -> float | None:
    """Seconds since last keyboard/mouse input (macOS HID idle), if determinable."""
    if platform.system() == "Darwin":
        out = _run(["ioreg", "-c", "IOHIDSystem"]) or ""
        m = re.search(r'"HIDIdleTime" = (\d+)', out)
        if m:
            return int(m.group(1)) / 1e9
    return None


def software() -> dict[str, str]:
    found = {}
    for name, (argv, pat) in SOFTWARE.items():
        out = _run(argv)
        if out is not None:
            m = re.search(pat, out)
            found[name] = m.group(1) if m else "installed"
    return found


def os_info() -> dict[str, str]:
    system = platform.system()
    ver = platform.release()
    if system == "Darwin":
        ver = platform.mac_ver()[0] or ver
        name = "macOS"
    elif system == "Linux":
        name = "Linux"
        try:
            with open("/etc/os-release") as fh:
                d = dict(re.findall(r'^(\w+)="?([^"\n]*)"?$', fh.read(), re.M))
            ver = d.get("PRETTY_NAME", ver)
        except OSError:
            pass
    else:
        name = system
    return {"os": name, "os_version": ver, "arch": platform.machine().replace("aarch64", "arm64").replace("AMD64", "x86_64")}


def collect(full: bool = True, disk_paths: list[str] | None = None) -> dict[str, Any]:
    inv: dict[str, Any] = {
        "fingerprint": machine_id(),
        "hostname": socket.gethostname().split(".")[0],
        **os_info(),
        "cpu": cpu_info(),
        "memory": memory_info(),
        "addresses": addresses(),
        "utilization": utilization(),
    }
    if full:
        inv["gpus"] = gpu_info()
        inv["disks"] = disk_info(disk_paths)
        inv["software"] = software()
    return inv
