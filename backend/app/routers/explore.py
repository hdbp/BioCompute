"""Data Explorer: file info, byte-range file serving (for igv.js), tables and public track hubs."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from ..models import User
from ..security import require_media_viewer, require_viewer
from ..services import explore, fs

router = APIRouter(prefix="/api/explore", tags=["explore"])


@router.get("/info")
def info(path: str, _: User = Depends(require_viewer)):
    return explore.info(path)


@router.get("/raw", operation_id="explore_raw")
@router.head("/raw", operation_id="explore_raw_head")
def raw(path: str, request: Request, _: User = Depends(require_media_viewer)):
    """Serve a file inline with HTTP Range support (genome browser tracks read only the bytes they need)."""
    _, p = fs.resolve(path)
    if not p.is_file():
        raise HTTPException(400, "Not a file")
    suffix = p.suffix.lower()
    media = explore.MEDIA.get(suffix, "application/octet-stream")
    headers = {"Cache-Control": "private, max-age=60"}
    if media == "text/html":  # reports run with scripts but in an opaque origin: no access to the app or its token
        headers["Content-Security-Policy"] = "sandbox allow-scripts allow-popups"
    elif suffix == ".svg":  # an SVG can carry scripts: opened directly it must not run them with the app's origin
        headers["Content-Security-Policy"] = "sandbox"
    return FileResponse(p, media_type=media, headers=headers, content_disposition_type="inline", filename=p.name)


@router.get("/table")
def table(path: str, offset: int = 0, limit: int = 100, sort: str | None = None, desc: bool = False, q: str | None = None,
          _: User = Depends(require_viewer)):
    return explore.table_page(path, offset, limit, sort, desc, q)


@router.get("/columns")
def columns(path: str, cols: str, max_points: int = 200_000, _: User = Depends(require_viewer)):
    names = [c for c in cols.split(",") if c][:3]
    if not names:
        raise HTTPException(400, "Choose at least one column")
    return explore.column_values(path, names, min(max_points, 500_000))


@router.get("/hubs")
def hubs(refresh: bool = False, _: User = Depends(require_viewer)):
    return explore.public_hubs(refresh)


# --------------------------------------------------------------------------- differential expression
from fastapi.responses import Response  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from ..db import get_db  # noqa: E402
from ..models import Project  # noqa: E402
from ..security import audit, require_scientist  # noqa: E402
from ..services import access, de  # noqa: E402


def _overrides(lfc: str | None, padj: str | None, p: str | None, mean: str | None, id: str | None, label: str | None):
    return {"lfc": lfc, "padj": padj, "p": p, "mean": mean, "id": id, "label": label}


@router.get("/de")
def de_data(path: str, lfc: str | None = None, padj: str | None = None, p: str | None = None, mean: str | None = None,
            id: str | None = None, label: str | None = None, _: User = Depends(require_viewer)):
    """Per-row fold change, p-values, mean and gene ids of a differential-expression table, for interactive plots."""
    return de.data(path, _overrides(lfc, padj, p, mean, id, label))


@router.get("/de/export")
def de_export(path: str, use: str = "padj", p_cut: float = 0.05, lfc_cut: float = 1.0, mean_cut: float | None = None,
              direction: str = "both", fmt: str = "csv", lfc: str | None = None, padj: str | None = None, p: str | None = None,
              mean: str | None = None, id: str | None = None, label: str | None = None, _: User = Depends(require_media_viewer)):
    """Rows passing the cut-offs, as a CSV/TSV download (all original columns plus 'regulation')."""
    if fmt not in ("csv", "tsv"):
        raise HTTPException(400, "fmt must be csv or tsv")
    header, rows, _counts, params = de.filtered(path, _overrides(lfc, padj, p, mean, id, label), use=use, p_cut=p_cut,
                                                lfc_cut=lfc_cut, mean_cut=mean_cut, direction=direction)
    name = path.rsplit("/", 1)[-1].split(":", 1)[-1].rsplit(".", 1)[0]
    return Response(de.to_text(header, rows, fmt), media_type="text/csv" if fmt == "csv" else "text/tab-separated-values",
                    headers={"Content-Disposition": f'attachment; filename="{name}_{direction}.{fmt}"'})


class DESave(BaseModel):
    path: str
    use: str = "padj"
    p_cut: float = 0.05
    lfc_cut: float = 1.0
    mean_cut: float | None = None
    direction: str = "both"
    fmt: str = "tsv"
    mapping: dict[str, str | None] = {}
    project_id: str | None = None  # saved into the project's analyses/ folder and listed in the project
    folder: str | None = None      # or any writable data folder


@router.post("/de/save")
def de_save(body: DESave, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    if body.fmt not in ("csv", "tsv"):
        raise HTTPException(400, "fmt must be csv or tsv")
    proj = None
    folder = body.folder
    if body.project_id:
        proj = db.get(Project, body.project_id)
        if not proj:
            raise HTTPException(404, "Project not found")
        access.check_view(user, proj.owner, proj.visibility, "Project")
        access.check_edit(user, proj.owner, f"The project “{proj.name}”")
        if not proj.home:
            raise HTTPException(400, "This project has no folder of its own; choose a folder to save into")
        folder = f"{proj.home.rstrip('/')}/analyses"
    if not folder:
        raise HTTPException(400, "Choose a project or a folder")
    header, rows, counts, params = de.filtered(body.path, {k: body.mapping.get(k) for k in ("lfc", "padj", "p", "mean", "id", "label")},
                                               use=body.use, p_cut=body.p_cut, lfc_cut=body.lfc_cut, mean_cut=body.mean_cut,
                                               direction=body.direction)
    params["saved_by"] = user.username
    base = body.path.rsplit("/", 1)[-1].split(":", 1)[-1].rsplit(".", 1)[0]
    out = de.save(folder, base, de.to_text(header, rows, body.fmt), body.fmt, params)
    if proj is not None:
        from .projects import add_item
        add_item(db, proj, user, out["path"], "file", f"{base}: {body.direction} ({len(rows)} genes)")
    audit(db, user.username, "explore.de_save", out["path"], rows=len(rows), **{k: params[k] for k in ("p_cutoff", "abs_log2fc_cutoff")})
    db.commit()
    return {**out, "rows": len(rows), "counts": counts}
