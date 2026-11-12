"""Persistent data model.

Separation of concerns (requirement §8):
* pipeline parameter metadata  -> PipelineVersion.schema_json / ParameterPreset
* experimental design metadata -> Experiment / Sample
* scheduler resource requests  -> Run.resources / NodeAllocation
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, BigInteger, Boolean, false, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


# --------------------------------------------------------------------------- users / audit
class User(TimestampMixin, Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="scientist")  # admin | scientist | viewer
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    prefs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # per-user settings, e.g. favorite pipelines


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(80))
    action: Mapped[str] = mapped_column(String(80), index=True)
    target: Mapped[str | None] = mapped_column(String(255), nullable=True)
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class AppSetting(Base):
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)


# --------------------------------------------------------------------------- pipelines
class Pipeline(TimestampMixin, Base):
    __tablename__ = "pipelines"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(80), default="general")
    # installed | template | studio
    kind: Mapped[str] = mapped_column(String(20), default="installed")
    # nf-core | git | local | studio | template
    source_type: Mapped[str] = mapped_column(String(20), default="local")
    source_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    engine: Mapped[str] = mapped_column(String(20), default="nextflow")  # nextflow | bcflow | snakemake(planned)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    studio_workflow_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # who added it (None: catalog, bundled examples, items from before ownership) and who may see it
    owner: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    visibility: Mapped[str] = mapped_column(String(10), default="lab")  # private | lab
    # uninstalled while runs still refer to it: hidden from the lists and from launching; the versions runs used stay
    archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())

    versions: Mapped[list[PipelineVersion]] = relationship(
        back_populates="pipeline", cascade="all, delete-orphan", order_by="PipelineVersion.created_at"
    )
    presets: Mapped[list[ParameterPreset]] = relationship(back_populates="pipeline", cascade="all, delete-orphan")


class PipelineVersion(TimestampMixin, Base):
    __tablename__ = "pipeline_versions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    pipeline_id: Mapped[str] = mapped_column(ForeignKey("pipelines.id", ondelete="CASCADE"), index=True)
    version: Mapped[str] = mapped_column(String(80))
    git_commit: Mapped[str | None] = mapped_column(String(64), nullable=True)
    git_ref: Mapped[str | None] = mapped_column(String(120), nullable=True)
    path: Mapped[str | None] = mapped_column(String(1000), nullable=True)  # local checkout
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    schema_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)  # nextflow_schema.json
    input_schema_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)  # assets/schema_input.json
    manifest: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # parsed nextflow.config manifest etc.
    engines: Mapped[list[str]] = mapped_column(JSON, default=list)  # engines able to run this version
    outputs: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    software: Mapped[list[str]] = mapped_column(JSON, default=list)  # docker/singularity/conda/...

    pipeline: Mapped[Pipeline] = relationship(back_populates="versions")


class ParameterPreset(TimestampMixin, Base):
    __tablename__ = "parameter_presets"
    __table_args__ = (UniqueConstraint("pipeline_id", "name"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    pipeline_id: Mapped[str] = mapped_column(ForeignKey("pipelines.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[str | None] = mapped_column(String(80), nullable=True)

    pipeline: Mapped[Pipeline] = relationship(back_populates="presets")


# --------------------------------------------------------------------------- experiments
class Experiment(TimestampMixin, Base):
    __tablename__ = "experiments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    # genomics | rnaseq | chipseq | atacseq | proteomics | generic
    assay: Mapped[str] = mapped_column(String(40), default="genomics")
    genome: Mapped[str | None] = mapped_column(String(120), nullable=True)  # e.g. hg38 (a refgenie genome name)
    custom_columns: Mapped[list[str]] = mapped_column(JSON, default=list)
    conditions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)  # [{name,color,description}]
    contrasts: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)  # [{id,name,treatment,reference}]
    created_by: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)  # the owner
    visibility: Mapped[str] = mapped_column(String(10), default="lab", server_default="lab")  # private | lab

    samples: Mapped[list[Sample]] = relationship(
        back_populates="experiment", cascade="all, delete-orphan", order_by="Sample.position"
    )


class Sample(TimestampMixin, Base):
    __tablename__ = "samples"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    experiment_id: Mapped[str] = mapped_column(ForeignKey("experiments.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    sample_id: Mapped[str] = mapped_column(String(200))
    condition: Mapped[str | None] = mapped_column(String(120), nullable=True)
    replicate: Mapped[int | None] = mapped_column(Integer, nullable=True)  # biological replicate
    technical_replicate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    batch: Mapped[str | None] = mapped_column(String(120), nullable=True)
    is_control: Mapped[bool] = mapped_column(Boolean, default=False)
    control_id: Mapped[str | None] = mapped_column(String(200), nullable=True)  # matched input/control sample_id
    files: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # role -> path, e.g. fastq_1, fastq_2, raw
    attributes: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # custom metadata + assay-specific

    experiment: Mapped[Experiment] = relationship(back_populates="samples")


class Dataset(TimestampMixin, Base):
    """A registered data location (e.g. a sequencing run folder) with access policy."""

    __tablename__ = "datasets"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    root: Mapped[str] = mapped_column(String(120))
    rel_path: Mapped[str] = mapped_column(String(1000), default="")
    restricted: Mapped[bool] = mapped_column(Boolean, default=True)
    description: Mapped[str] = mapped_column(Text, default="")
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


# --------------------------------------------------------------------------- studio
class StudioWorkflow(TimestampMixin, Base):
    __tablename__ = "studio_workflows"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    graph: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # {nodes:[], edges:[]}
    created_by: Mapped[str | None] = mapped_column(String(80), nullable=True)  # the owner
    visibility: Mapped[str] = mapped_column(String(10), default="private")  # private | lab


class Project(TimestampMixin, Base):
    """A named collection of folders, files and runs (Data Explorer), optionally with its own folder on disk."""
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    owner: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    visibility: Mapped[str] = mapped_column(String(10), default="private")  # private | lab
    home: Mapped[str | None] = mapped_column(String(500), nullable=True)  # data-root path of the project folder
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)  # [{id, kind, ref, label, added_by, added_at}]


class DataRoot(TimestampMixin, Base):
    """A data folder on the controller added by an administrator in Settings (in addition to BIOCOMPUTE_DATA_ROOTS)."""
    __tablename__ = "data_roots"
    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    path: Mapped[str] = mapped_column(Text)
    restricted: Mapped[bool] = mapped_column(Boolean, default=True)
    writable: Mapped[bool] = mapped_column(Boolean, default=False)
    description: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str | None] = mapped_column(String(80), nullable=True)


class AssistantResult(TimestampMixin, Base):
    """Every assistant answer, so a pipeline that was paid for is never lost (only proposals; nothing here runs)."""
    __tablename__ = "assistant_results"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    task: Mapped[str] = mapped_column(String(32), index=True)  # build | review | ask | draft_module
    request: Mapped[str] = mapped_column(Text, default="")
    result: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(80), index=True)
    workflow_id: Mapped[str | None] = mapped_column(String(32), nullable=True)  # set once saved into a workflow


class CustomModule(TimestampMixin, Base):
    """A Pipeline Studio module defined by a user (e.g. wrapping newly installed software)."""

    __tablename__ = "custom_modules"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # module id used in graphs
    definition: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[str | None] = mapped_column(String(80), nullable=True)  # the owner
    visibility: Mapped[str] = mapped_column(String(10), default="private")  # private | lab


# --------------------------------------------------------------------------- runs
class Run(TimestampMixin, Base):
    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    pipeline_id: Mapped[str] = mapped_column(ForeignKey("pipelines.id"), index=True)
    pipeline_version_id: Mapped[str] = mapped_column(ForeignKey("pipeline_versions.id"))
    experiment_id: Mapped[str | None] = mapped_column(ForeignKey("experiments.id"), nullable=True)
    engine: Mapped[str] = mapped_column(String(20))
    # pending | preflight | queued | running | completed | failed | cancelling | cancelled | lost
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    resources: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # scheduler request & limits
    placement: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # chosen nodes + rationale
    output_dir: Mapped[str] = mapped_column(String(1000))
    run_dir: Mapped[str] = mapped_column(String(1000))
    work_dir: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    pid: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pid_start_time: Mapped[float | None] = mapped_column(Float, nullable=True)
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # per-process counts
    provenance: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    resumed_from: Mapped[str | None] = mapped_column(String(32), nullable=True)
    nf_session_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(80), nullable=True)

    events: Mapped[list[RunEvent]] = relationship(back_populates="run", cascade="all, delete-orphan")


class RunEvent(Base):
    __tablename__ = "run_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    kind: Mapped[str] = mapped_column(String(40))  # status | task | preflight | error | info
    message: Mapped[str] = mapped_column(Text)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    run: Mapped[Run] = relationship(back_populates="events")


# --------------------------------------------------------------------------- cluster
class Node(TimestampMixin, Base):
    """A machine known to BioCompute.

    Lifecycle (§5): discovered -> candidate (authorized) -> enrolled -> active
    plus: draining, disabled, removed. Discovery never implies execution permission.
    """

    __tablename__ = "nodes"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    fingerprint: Mapped[str] = mapped_column(String(128), unique=True, index=True)  # dedupe key
    hostname: Mapped[str] = mapped_column(String(255), index=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    state: Mapped[str] = mapped_column(String(20), default="discovered", index=True)
    is_controller: Mapped[bool] = mapped_column(Boolean, default=False)
    site: Mapped[str | None] = mapped_column(String(80), nullable=True)  # data-locality domain (lab/home)
    os: Mapped[str | None] = mapped_column(String(80), nullable=True)
    os_version: Mapped[str | None] = mapped_column(String(120), nullable=True)
    arch: Mapped[str | None] = mapped_column(String(40), nullable=True)
    cpu_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    cpu_physical: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cpu_logical: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mem_total: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # bytes
    mem_available: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    gpus: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    disks: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    addresses: Mapped[list[str]] = mapped_column(JSON, default=list)
    discovery_sources: Mapped[list[str]] = mapped_column(JSON, default=list)
    software: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # nextflow/java/docker/apptainer/condor/R/python
    htcondor: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # network facts from discovery, e.g. {"tailscale": {"online": true, "dns_name": "...", "ips": [...]}}
    network: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}")
    agent_installed: Mapped[bool] = mapped_column(Boolean, default=False)
    agent_version: Mapped[str | None] = mapped_column(String(40), nullable=True)
    agent_token_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    utilization: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # cpu%, mem%, load, battery
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")

    allocation: Mapped[NodeAllocation | None] = relationship(
        back_populates="node", cascade="all, delete-orphan", uselist=False
    )
    metrics: Mapped[list[NodeMetric]] = relationship(back_populates="node", cascade="all, delete-orphan")


class NodeAllocation(TimestampMixin, Base):
    __tablename__ = "node_allocations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    node_id: Mapped[str] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), unique=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    max_cpus: Mapped[int] = mapped_column(Integer, default=1)
    max_memory_gb: Mapped[float] = mapped_column(Float, default=1.0)
    gpus_allowed: Mapped[int] = mapped_column(Integer, default=0)
    scratch_limit_gb: Mapped[float] = mapped_column(Float, default=50.0)
    max_concurrent_jobs: Mapped[int] = mapped_column(Integer, default=1)
    priority: Mapped[int] = mapped_column(Integer, default=50)  # 0..100
    idle_only: Mapped[bool] = mapped_column(Boolean, default=False)
    allowed_hours: Mapped[str | None] = mapped_column(String(40), nullable=True)  # "19:00-07:00"
    require_ac_power: Mapped[bool] = mapped_column(Boolean, default=False)
    data_policy: Mapped[str] = mapped_column(String(30), default="local-only")  # local-only | approved-staging | any
    preferred_workloads: Mapped[list[str]] = mapped_column(JSON, default=list)
    draining: Mapped[bool] = mapped_column(Boolean, default=False)
    preset: Mapped[str] = mapped_column(String(20), default="balanced")

    node: Mapped[Node] = relationship(back_populates="allocation")


class NodeMetric(Base):
    __tablename__ = "node_metrics"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    node_id: Mapped[str] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    cpu_percent: Mapped[float] = mapped_column(Float)
    mem_percent: Mapped[float] = mapped_column(Float)
    load1: Mapped[float | None] = mapped_column(Float, nullable=True)

    node: Mapped[Node] = relationship(back_populates="metrics")


class EnrollmentToken(TimestampMixin, Base):
    """One-time token an administrator issues to authorize an agent enrollment."""

    __tablename__ = "enrollment_tokens"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    token_hash: Mapped[str] = mapped_column(String(255), unique=True)
    label: Mapped[str] = mapped_column(String(200), default="")
    site: Mapped[str | None] = mapped_column(String(80), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_by_node: Mapped[str | None] = mapped_column(String(32), nullable=True)
    allow_discovery_reports: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # when issued for a specific discovered machine, enrollment updates exactly that node
    for_node: Mapped[str | None] = mapped_column(String(32), nullable=True)
