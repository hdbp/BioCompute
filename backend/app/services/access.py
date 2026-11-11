"""Who may see and change pipelines, Studio workflows and custom modules.

* private: only the owner (and administrators)
* lab:     everyone with an account can see, use and copy it; only the owner (and administrators) can change it
Items without an owner (catalog, bundled examples, items created before ownership existed) are shared with the lab
and editable by scientists, as before.
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import or_

from ..models import User

VISIBILITIES = ("private", "lab")


def can_view(user: User, owner: str | None, visibility: str | None) -> bool:
    return user.role == "admin" or owner is None or owner == user.username or (visibility or "lab") == "lab"


def can_edit(user: User, owner: str | None) -> bool:
    if user.role == "admin":
        return True
    if user.role == "viewer":
        return False
    return owner is None or owner == user.username


def check_view(user: User, owner: str | None, visibility: str | None, what: str = "Item") -> None:
    if not can_view(user, owner, visibility):
        raise HTTPException(404, f"{what} not found")  # private items of others are not revealed


def check_edit(user: User, owner: str | None, what: str = "This item") -> None:
    if not can_edit(user, owner):
        raise HTTPException(403, f"{what} belongs to {owner}. You can use it, or make your own copy to change it.")


def visible_filter(user: User, owner_col, visibility_col):
    """SQLAlchemy filter for the rows a user may see (None = no filter, for administrators)."""
    if user.role == "admin":
        return None
    return or_(owner_col.is_(None), owner_col == user.username, visibility_col == "lab")


def check_visibility_value(v: str) -> str:
    if v not in VISIBILITIES:
        raise HTTPException(400, "visibility must be 'private' or 'lab'")
    return v
