"""Data Explorer: file info, byte-range file serving (for igv.js), tables and public track hubs."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from ..models import User
from ..security import require_viewer
from ..services import explore, fs

router = APIRouter(prefix="/api/explore", tags=["explore"])


@router.get("/info")
def info(path: str, _: User = Depends(require_viewer)):
    return explore.info(path)


@router.get("/raw", operation_id="explore_raw")
@router.head("/raw", operation_id="explore_raw_head")
def raw(path: str, request: Request, _: User = Depends(require_viewer)):
    """Serve a file inline with HTTP Range support (genome browser tracks read only the bytes they need)."""
    _, p = fs.resolve(path)
    if not p.is_file():
        raise HTTPException(400, "Not a file")
    suffix = p.suffix.lower()
    media = explore.MEDIA.get(suffix, "application/octet-stream")
    headers = {"Cache-Control": "private, max-age=60"}
    if media == "text/html":  # reports run with scripts but in an opaque origin: no access to the app or its token
        headers["Content-Security-Policy"] = "sandbox allow-scripts allow-popups"
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
