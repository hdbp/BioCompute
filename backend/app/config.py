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
    admin_password: str | None = None  # if unset on first run, the administrator is created in the browser (first-run setup)
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
    # Data Explorer: where the list of public UCSC track hubs comes from (empty = no outbound request)
    explorer_public_hubs_url: str = "https://api.genome.ucsc.edu/list/publicHubs"
    # refgenie genome_config.yaml to read reference genomes from (also: Settings, $REFGENIE, common locations)
    refgenie_config: str | None = None
    # delete intermediate files of a run once they are no longer needed (a run can keep them: Advanced, "Keep")
    cleanup_intermediates: bool = True
    # node monitoring samples older than this are pruned
    metrics_retention_days: int = 7
    # extra folders searched for tools AFTER the service's own PATH (scripts/tools.sh sets it to its bioconda env)
    tools_path: str | None = None
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
    # Scheduling estimates (shown to users with every placement)
    sched_mb_per_core_second: float = 25.0   # assumed input processed per core per second
    sched_default_lan_mbps: float = 1000.0   # link speed assumed for unmeasured nodes on the controller's site
    sched_default_wan_mbps: float = 100.0    # ... and for unmeasured nodes elsewhere
    sched_scratch_factor: float = 3.0        # scratch space needed ~ input size x factor (+ 5 GB)
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
