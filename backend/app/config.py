"""BioCompute controller configuration.

All paths are configurable through environment variables (prefix ``BIOCOMPUTE_``)
or a ``.env`` file. Nothing about a particular laboratory layout is hard-coded.
"""
from __future__ import annotations

import json
import secrets
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict



class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BIOCOMPUTE_", env_file=".env", extra="ignore")

    # --- core -----------------------------------------------------------
    environment: str = "development"
    database_url: str = "sqlite:///./var/biocompute.db"
    secret_key: str = Field(default_factory=lambda: secrets.token_urlsafe(48))
    token_ttl_minutes: int = 60 * 12
    admin_username: str = "admin"
    admin_password: str | None = None  # if unset on first run, a random one is generated & printed
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # --- storage ----------------------------------------------------------
    state_dir: Path = Path("./var")
    pipelines_dir: Path | None = None  # imported / generated pipelines
    runs_dir: Path | None = None  # per-run launch dirs (params, logs, provenance)
    default_output_root: str = "results"  # name of the data root used for outputs by default

    # JSON list: [{"name": "lab-raw", "path": "/data/raw", "restricted": true, "writable": false}, ...]
    data_roots: Annotated[list[dict[str, Any]], NoDecode] = []

    # --- execution --------------------------------------------------------
    nextflow_bin: str = "nextflow"
    java_bin: str = "java"
    nextflow_home: Path | None = None
    max_concurrent_runs: int = 4
    allow_custom_code_modules: bool = True  # Python/R code blocks in Pipeline Studio
    enable_demo_engine: bool = True  # BioCompute native engine for bcflow manifests

    # --- cluster / discovery ---------------------------------------------
    site_name: str = "lab"  # trusted site of this controller (data-locality domain)
    discovery_enable_mdns: bool = True
    discovery_enable_tailscale: bool = True
    discovery_enable_htcondor: bool = True
    discovery_enable_neighbors: bool = True
    # CIDRs within which active probing (TCP connect to agent/SSH port) is permitted.
    discovery_authorized_cidrs: Annotated[list[str], NoDecode] = []
    agent_port: int = 8765
    # Serve the worker-agent endpoints (only) on another address, e.g. "tailscale" or "100.64.1.2:8765"
    agent_listen: str | None = None
    # One-click enrollment of tailnet machines over SSH (admin-initiated, tailnet members only)
    allow_ssh_enrollment: bool = True
    ssh_bin: str = "ssh"
    # Address agents should use to reach this controller, e.g. https://lab-ws.tail1234.ts.net
    public_url: str | None = None
    condor_status_bin: str = "condor_status"
    tailscale_bin: str = "tailscale"

    @field_validator("data_roots", "cors_origins", "discovery_authorized_cidrs", mode="before")
    @classmethod
    def _parse_json_list(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip()
            if not v:
                return []
            if v.startswith("["):
                return json.loads(v)
            return [s.strip() for s in v.split(",") if s.strip()]
        return v

    # derived paths --------------------------------------------------------
    @property
    def pipelines_path(self) -> Path:
        return (self.pipelines_dir or self.state_dir / "pipelines").resolve()

    @property
    def runs_path(self) -> Path:
        return (self.runs_dir or self.state_dir / "runs").resolve()

    def ensure_dirs(self) -> None:
        for p in (self.state_dir, self.pipelines_path, self.runs_path):
            Path(p).mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.ensure_dirs()
    return s
