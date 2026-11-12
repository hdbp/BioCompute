"""Pydantic request/response models (the public API contract)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- auth
class LoginIn(BaseModel):
    username: str
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class UserOut(ORM):
    id: str
    username: str
    role: str
    is_active: bool


class UserCreate(BaseModel):
    username: str = Field(pattern=r"^[A-Za-z0-9_.-]{2,80}$")
    password: str = Field(min_length=10)
    role: Literal["admin", "scientist", "viewer"] = "scientist"


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=10)


# --------------------------------------------------------------------------- pipelines
class PipelineVersionOut(ORM):
    id: str
    version: str
    git_commit: str | None
    git_ref: str | None
    path: str | None
    pinned: bool
    engines: list[str]
    software: list[str]
    outputs: list[dict[str, Any]]
    created_at: datetime


class PipelineOut(ORM):
    id: str
    slug: str
    name: str
    description: str
    category: str
    kind: str
    source_type: str
    source_url: str | None
    engine: str
    favorite: bool
    tags: list[str]
    studio_workflow_id: str | None
    owner: str | None = None
    visibility: str = "lab"
    archived: bool = False
    created_at: datetime
    updated_at: datetime


class PipelineSummary(PipelineOut):
    can_edit: bool = False
    latest_version: PipelineVersionOut | None = None
    has_schema: bool = False
    run_count: int = 0
    last_run_status: str | None = None
    preset_count: int = 0


class PipelineDetail(PipelineSummary):
    versions: list[PipelineVersionOut]
    readme: str | None = None
    manifest: dict[str, Any] = {}
    input_columns: list[dict[str, Any]] = []
    runnable: list[dict[str, Any]] = []


class PipelineUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = Field(None, max_length=4000)
    category: str | None = Field(None, min_length=1, max_length=80)
    favorite: bool | None = None  # per user
    tags: list[str] | None = None
    visibility: str | None = None  # private | lab (owner or admin)


class ImportLocal(BaseModel):
    path: str  # virtual path <root>:<rel>
    name: str | None = None
    category: str | None = None
    copy_files: bool = False
    visibility: str = "private"


class ImportGit(BaseModel):
    url: str
    ref: str | None = None
    name: str | None = None
    category: str | None = None
    visibility: str = "private"


class DuplicateIn(BaseModel):
    name: str
    visibility: str = "private"


class PresetIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    params: dict[str, Any]


class PresetOut(ORM):
    id: str
    pipeline_id: str
    name: str
    description: str
    params: dict[str, Any]
    created_by: str | None
    created_at: datetime


class ParamValidateIn(BaseModel):
    params: dict[str, Any]
    version_id: str | None = None


class SchemaAuthorIn(BaseModel):
    """Generic schema wizard: list of parameters for pipelines lacking nextflow_schema.json."""
    version_id: str | None = None
    fields: list[dict[str, Any]]
    write_to_pipeline: bool = False


# --------------------------------------------------------------------------- experiments
class SampleIn(BaseModel):
    id: str | None = None
    sample_id: str
    condition: str | None = None
    replicate: int | None = None
    technical_replicate: int | None = None
    batch: str | None = None
    is_control: bool = False
    control_id: str | None = None
    files: dict[str, Any] = {}
    attributes: dict[str, Any] = {}


class SampleOut(ORM, SampleIn):
    id: str
    position: int


class ExperimentIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    assay: Literal["genomics", "rnaseq", "chipseq", "atacseq", "cutandrun", "methylation", "proteomics", "generic"] = "genomics"
    genome: str | None = Field(default=None, max_length=120)
    visibility: Literal["private", "lab"] = "lab"
    custom_columns: list[str] = []
    conditions: list[dict[str, Any]] = []
    contrasts: list[dict[str, Any]] = []


class ExperimentOut(ORM):
    id: str
    name: str
    description: str
    assay: str
    genome: str | None = None
    custom_columns: list[str]
    conditions: list[dict[str, Any]]
    contrasts: list[dict[str, Any]]
    created_by: str | None
    visibility: str = "lab"
    can_edit: bool = False
    created_at: datetime
    updated_at: datetime
    sample_count: int = 0


class ExperimentDetail(ExperimentOut):
    samples: list[SampleOut]


class SamplesReplace(BaseModel):
    samples: list[SampleIn]


class PairDetectIn(BaseModel):
    paths: list[str] = []
    directory: str | None = None
    recursive: bool = True


class SamplesheetImportIn(BaseModel):
    content: str
    mode: Literal["replace", "append", "merge"] = "append"


class ExperimentValidateIn(BaseModel):
    pipeline_id: str | None = None
    version_id: str | None = None
    column_map: dict[str, str] | None = None


# --------------------------------------------------------------------------- runs
class RunCreate(BaseModel):
    pipeline_id: str
    version_id: str | None = None
    engine: Literal["nextflow", "bcflow"] | None = None
    name: str | None = Field(default=None, max_length=200)
    params: dict[str, Any] = {}
    output_dir: str  # virtual path
    experiment_id: str | None = None
    column_map: dict[str, str] | None = None
    resources: dict[str, Any] = {}  # max_cpus, max_memory_gb, profile, executor, nodes
    node_ids: list[str] = []
    dry_run: bool = False
    project_id: str | None = None  # list the run in this project (Data Explorer)


class RunOut(ORM):
    id: str
    name: str
    pipeline_id: str
    pipeline_version_id: str
    experiment_id: str | None
    engine: str
    status: str
    params: dict[str, Any]
    resources: dict[str, Any]
    placement: dict[str, Any]
    output_dir: str
    run_dir: str
    work_dir: str | None
    exit_code: int | None
    error: str | None
    progress: dict[str, Any]
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime
    attempt: int
    created_by: str | None
    pipeline_name: str | None = None
    pipeline_version: str | None = None
    experiment_name: str | None = None
    output_vpath: str | None = None
    can_edit: bool = False  # cancel, resume, delete: who started it, or an administrator


class RunDetail(RunOut):
    provenance: dict[str, Any]
    events: list[dict[str, Any]]
    work_bytes: int = 0             # intermediate files still on disk
    results_deletable: bool = False  # deleting the run may also delete its results folder (it created it)


# --------------------------------------------------------------------------- cluster
class AllocationIn(BaseModel):
    enabled: bool | None = None
    max_cpus: int | None = Field(default=None, ge=1)
    max_memory_gb: float | None = Field(default=None, gt=0)
    gpus_allowed: int | None = Field(default=None, ge=0)
    scratch_limit_gb: float | None = Field(default=None, ge=0)
    max_concurrent_jobs: int | None = Field(default=None, ge=1)
    priority: int | None = Field(default=None, ge=0, le=100)
    idle_only: bool | None = None
    allowed_hours: str | None = Field(default=None, pattern=r"^(\d{1,2}:\d{2}-\d{1,2}:\d{2})?$")
    require_ac_power: bool | None = None
    data_policy: Literal["local-only", "approved-staging", "any"] | None = None
    preferred_workloads: list[str] | None = None
    draining: bool | None = None


class AllocationOut(ORM):
    enabled: bool
    max_cpus: int
    max_memory_gb: float
    gpus_allowed: int
    scratch_limit_gb: float
    max_concurrent_jobs: int
    priority: int
    idle_only: bool
    allowed_hours: str | None
    require_ac_power: bool
    data_policy: str
    preferred_workloads: list[str]
    draining: bool
    preset: str


class NodeOut(ORM):
    id: str
    hostname: str
    display_name: str | None
    state: str
    is_controller: bool
    site: str | None
    os: str | None
    os_version: str | None
    arch: str | None
    cpu_model: str | None
    cpu_physical: int | None
    cpu_logical: int | None
    mem_total: int | None
    mem_available: int | None
    gpus: list[dict[str, Any]]
    disks: list[dict[str, Any]]
    addresses: list[str]
    discovery_sources: list[str]
    software: dict[str, Any]
    htcondor: dict[str, Any]
    agent_installed: bool
    agent_version: str | None
    utilization: dict[str, Any]
    last_seen: datetime | None
    notes: str
    allocation: AllocationOut | None
    network: dict[str, Any] = {}
    eligibility: dict[str, Any] = {}
    tailnet: dict[str, Any] = {}
    capacity: dict[str, Any] = {}
    created_at: datetime


class NodeUpdate(BaseModel):
    display_name: str | None = None
    site: str | None = Field(default=None, pattern=r"^[\w.-]{1,80}$")
    notes: str | None = None


class NodeTransition(BaseModel):
    action: Literal["authorize", "revoke", "enable", "disable", "drain", "undrain", "remove"]


class ManualNodeIn(BaseModel):
    hostname: str = Field(pattern=r"^[A-Za-z0-9.-]{1,255}$")
    addresses: list[str] = []
    site: str | None = None
    ssh_port: int | None = None
    os: str | None = None
    probe: bool = False


class TokenCreate(BaseModel):
    label: str = ""
    site: str | None = Field(default=None, pattern=r"^[\w.-]{1,80}$")
    ttl_hours: int = Field(default=24, ge=1, le=24 * 30)
    allow_discovery_reports: bool = False
    node_id: str | None = None  # bind the token to one discovered machine


class SshEnrollIn(BaseModel):
    ssh_user: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9._-]{0,63}$")
    host: str
    ssh_port: int = Field(default=22, ge=1, le=65535)
    controller_url: str | None = None  # default: the agent listener on the tailnet
    password: str | None = Field(default=None, max_length=1024, repr=False)  # used once to install BioCompute's key
    enable_participation: bool = False
    site: str | None = None
    install_service: bool = True
    allow_discovery_reports: bool = False


class AgentEnroll(BaseModel):
    token: str
    inventory: dict[str, Any]


class AgentHeartbeat(BaseModel):
    inventory: dict[str, Any]


class DiscoveryReport(BaseModel):
    """A discovery agent on another network segment reporting nearby devices."""
    devices: list[dict[str, Any]]
    network: str | None = None


class PlacementIn(BaseModel):
    experiment_id: str | None = None
    input_paths: list[str] = []
    requested_cpus: int = 0
    requested_mem_gb: float = 0          # hard requirement (0 = none)
    requested_disk_gb: float | None = None  # hard requirement; None = estimate from input size (warning only)
    node_ids: list[str] = []
    requires_gpu: bool = False


# --------------------------------------------------------------------------- studio
class StudioIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    graph: dict[str, Any]
    visibility: str | None = None  # private | lab; new workflows are private unless set


class StudioOut(ORM):
    id: str
    name: str
    description: str
    graph: dict[str, Any]
    created_by: str | None
    visibility: str = "private"
    can_edit: bool = False
    created_at: datetime
    updated_at: datetime


class StudioCompileIn(BaseModel):
    name: str = "studio-pipeline"
    description: str = ""
    graph: dict[str, Any]


TokenOut.model_rebuild()


# --------------------------------------------------------------------------- user administration
class UserUpdate(BaseModel):
    """What an administrator may change on an existing account; fields left out stay as they are."""
    role: Literal["admin", "scientist", "viewer"] | None = None
    is_active: bool | None = None


class PasswordReset(BaseModel):
    """A temporary password chosen by the administrator; leave it out to have one generated."""
    password: str | None = Field(default=None, min_length=10, max_length=200)


class PasswordResetOut(BaseModel):
    ok: bool = True
    username: str
    generated: bool
    password: str | None = None  # only a generated password is returned, once; it is never stored in clear or logged
