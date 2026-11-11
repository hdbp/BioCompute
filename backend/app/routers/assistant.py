from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..security import audit, require_admin, require_scientist, require_viewer
from ..services import assistant as ai
from ..services import custom_modules as cm

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class ConfigIn(BaseModel):
    provider: str
    model: str | None = None
    effort: str | None = "high"
    api_key: str | None = None
    clear_key: bool = False


class BuildIn(BaseModel):
    description: str = Field(min_length=3, max_length=8000)
    graph: dict[str, Any] | None = None  # current editor graph when the user asks for a change


class ReviewIn(BaseModel):
    graph: dict[str, Any]
    goal: str = Field(default="", max_length=4000)


class DraftModuleIn(BaseModel):
    description: str = Field(min_length=3, max_length=8000)
    tool: str | None = None


class AskIn(BaseModel):
    question: str = Field(min_length=2, max_length=8000)
    graph: dict[str, Any] | None = None


def _run(db: Session, user: User, task: str, fn, **audit_detail):
    try:
        res = fn()
    except ai.AssistantError as exc:
        audit(db, user.username, f"assistant.{task}", None, ok=False, error=str(exc)[:300], **audit_detail)
        db.commit()
        raise HTTPException(502, str(exc)) from exc
    meta = res.get("meta", {})
    audit(db, user.username, f"assistant.{task}", None, ok=True, provider=meta.get("provider"), model=meta.get("model"),
          cost_usd=meta.get("cost_usd"), **audit_detail)
    db.commit()
    return res


@router.get("/status")
def status(_: User = Depends(require_viewer), db: Session = Depends(get_db)):
    return ai.status(db)


@router.put("/config")
def put_config(body: ConfigIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    ai.save_config(db, body.provider, body.model, body.effort, body.api_key, body.clear_key)
    audit(db, admin.username, "assistant.config", None, provider=body.provider, model=body.model,
          key_changed=bool(body.api_key or body.clear_key))
    db.commit()
    return ai.status(db)


@router.post("/test")
def test(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return _run(db, admin, "test", lambda: ai.ping(db))


@router.post("/build")
def build(body: BuildIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    return _run(db, user, "build", lambda: ai.build(db, cm.index(db), body.description, body.graph),
                request=body.description[:200])


@router.post("/review")
def review(body: ReviewIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    return _run(db, user, "review", lambda: ai.review(db, cm.index(db), body.graph, body.goal),
                nodes=len(body.graph.get("nodes", [])))


@router.post("/draft-module")
def draft_module(body: DraftModuleIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    help_text = None
    tool = (body.tool or "").strip() or None
    if tool:
        info = cm.check_tool(tool)
        if info.get("found"):
            help_text = cm.tool_help(tool)

    def go():
        res = ai.draft_module(db, cm.index(db), body.description, tool, help_text)
        res["check"] = cm.check_module(res["module"], db=db)
        res["grounded_on_help"] = bool(help_text)
        return res

    return _run(db, user, "draft_module", go, tool=tool, request=body.description[:200])


@router.post("/ask")
def ask(body: AskIn, user: User = Depends(require_scientist), db: Session = Depends(get_db)):
    return _run(db, user, "ask", lambda: ai.ask(db, cm.index(db), body.question, body.graph), request=body.question[:200])
