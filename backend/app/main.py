"""BioCompute controller - FastAPI application."""
from __future__ import annotations

import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import get_settings
from .db import Base, SessionLocal, get_engine
from .models import Node, Pipeline, User
from .routers import assistant, auth, cluster, data, experiments, explore, pipelines, runs, studio, system
from .security import hash_secret
from .services import cluster as cluster_svc
from .services import data_roots
from .services import setup as setup_svc
from .services import hostinfo
from .services import pipelines as pipeline_svc
from .services import runner
from . import agent_listener

ROOT = Path(__file__).resolve().parents[2]


def migrate() -> None:
    """Bring the schema up to date. Alembic for real deployments, create_all for tests."""
    s = get_settings()
    if s.environment == "test":
        Base.metadata.create_all(get_engine())
        return
    from alembic import command
    from alembic.config import Config

    from sqlalchemy import inspect

    cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    cfg.set_main_option("sqlalchemy.url", s.database_url)
    tables = set(inspect(get_engine()).get_table_names())
    if "users" in tables and "alembic_version" not in tables:
        # schema created without Alembic (older tooling): record it as the initial revision
        command.stamp(cfg, "0001")
    command.upgrade(cfg, "head")


def bootstrap() -> None:
    """First-run initialization: admin user, catalog templates, controller node, example pipeline."""
    s = get_settings()
    db = SessionLocal()
    try:
        if not db.query(User).first() and s.admin_password:
            # unattended installs: the administrator comes from the environment
            db.add(User(username=s.admin_username, password_hash=hash_secret(s.admin_password), role="admin"))
            setup_svc.mark_completed(db, "environment")
        if setup_svc.needed(db):  # otherwise the first visitor creates the administrator in the browser
            setup_svc.announce(setup_svc.ensure_code())
        pipeline_svc.seed_catalog(db)
        example = ROOT / "examples" / "pipelines" / "fastq-qc"
        if os.environ.get("BIOCOMPUTE_REGISTER_EXAMPLES", "true").lower() == "true" and example.is_dir():
            if not db.query(Pipeline).filter(Pipeline.slug == "biocompute-fastq-qc").first():
                p = pipeline_svc.register_from_dir(db, example, source_type="local", name="BioCompute FASTQ QC",
                                                   category="Quality control", source_url="bundled example")
                p.slug = "biocompute-fastq-qc"
                p.tags = ["example", "portable"]
        try:
            cluster_svc.register_controller(db)
        except Exception as exc:  # inventory problems must never block start-up
            print(f"[biocompute] controller inventory failed: {exc}", file=sys.stderr)
        db.commit()
    finally:
        db.close()


def _controller_sampler(interval: float = 30.0) -> None:
    while True:
        try:
            db = SessionLocal()
            n = db.query(Node).filter(Node.is_controller.is_(True)).first()
            if n:
                inv = hostinfo.collect(full=False)
                n.utilization = inv["utilization"]
                n.mem_available = inv["memory"].get("available")
                n.last_seen = cluster_svc.now()
                cluster_svc.record_metrics(db, n)
                db.commit()
            db.close()
        except Exception as exc:  # pragma: no cover
            print(f"[biocompute] sampler error: {exc}", file=sys.stderr)
        time.sleep(interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    migrate()
    bootstrap()
    data_roots.reload()
    if s.environment != "test":
        stats = runner.reconcile()
        print(f"[biocompute] run reconciliation: {stats}", file=sys.stderr)
        runner.start_monitor()
        threading.Thread(target=_controller_sampler, daemon=True, name="sampler").start()
        agent_listener.start()
    yield
    agent_listener.stop()


app = FastAPI(
    title="BioCompute API", version=__version__, lifespan=lifespan,
    description="Distributed bioinformatics computing platform: pipelines, experiments, execution and cluster management.",
)
app.add_middleware(CORSMiddleware, allow_origins=get_settings().cors_origins, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if not request.url.path.startswith("/api/results/"):
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    return resp


for r in (auth.router, pipelines.router, pipelines.versions_router, pipelines.schemas_router, experiments.router,
          experiments.samples_router, data.router, runs.router, runs.jobs_router, runs.results_router,
          cluster.nodes_router, cluster.discovery_router, cluster.alloc_router, cluster.agent_router,
          studio.router, assistant.router, explore.router, system.router):
    app.include_router(r)


@app.exception_handler(Exception)
async def unexpected_error(request: Request, exc: Exception):
    """Log the traceback and give the UI a message it can show (instead of a bare 500)."""
    import logging
    import traceback

    logging.getLogger("biocompute").error("Unhandled error on %s %s\n%s", request.method, request.url.path,
                                           "".join(traceback.format_exception(exc)))
    return JSONResponse(status_code=500, content={
        "detail": f"Internal error in {request.url.path}: {type(exc).__name__}: {str(exc)[:300]}. "
                  "The full traceback is in the controller log."})


@app.exception_handler(PermissionError)
async def perm_error(_: Request, exc: PermissionError):
    return JSONResponse(status_code=403, content={"detail": f"Filesystem permission denied: {exc.filename or ''}"})


# Optional: serve the built frontend from the same process (host-native deployment)
_dist = Path(os.environ.get("BIOCOMPUTE_FRONTEND_DIST", ROOT / "frontend" / "dist"))
if _dist.is_dir():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        f = (_dist / full_path).resolve()
        if full_path and f.is_file() and f.is_relative_to(_dist.resolve()):
            return FileResponse(f)
        return FileResponse(_dist / "index.html")
