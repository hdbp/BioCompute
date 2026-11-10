"""nf-core / Nextflow ``nextflow_schema.json`` parsing and parameter validation.

Supports both the classic draft-07 layout (``definitions`` + ``allOf``) and the
newer draft 2020-12 layout (``$defs``). The parser produces a *normalized form
description* that the frontend renders generically; it never assumes that any
parameter is universal across pipelines.
"""
from __future__ import annotations

import copy
import re
from typing import Any

import jsonschema

FILE_FORMATS = {"file-path", "directory-path", "path", "file-path-pattern"}


def _group_defs(schema: dict[str, Any]) -> dict[str, Any]:
    return schema.get("$defs") or schema.get("definitions") or {}


def _widget_for(name: str, prop: dict[str, Any]) -> str:
    t = prop.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), t[0] if t else "string")
    fmt = prop.get("format")
    if prop.get("enum"):
        return "select"
    if t == "boolean":
        return "toggle"
    if t in ("integer", "number"):
        return "number"
    if fmt == "directory-path":
        return "directory"
    if fmt in ("file-path", "path", "file-path-pattern"):
        return "file"
    if t == "string" and (prop.get("maxLength") or 0) > 200:
        return "textarea"
    return "text"


def _field(name: str, prop: dict[str, Any], required: bool) -> dict[str, Any]:
    t = prop.get("type", "string")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), "string")
    return {
        "name": name,
        "type": t,
        "widget": _widget_for(name, prop),
        "format": prop.get("format"),
        "description": prop.get("description", ""),
        "help": prop.get("help_text", ""),
        "default": prop.get("default"),
        "enum": prop.get("enum"),
        "minimum": prop.get("minimum"),
        "maximum": prop.get("maximum"),
        "pattern": prop.get("pattern"),
        "mimetype": prop.get("mimetype"),
        "schema": prop.get("schema"),  # e.g. assets/schema_input.json for --input
        "required": required,
        "hidden": bool(prop.get("hidden", False)),
        "icon": prop.get("fa_icon"),
    }


def normalize(schema: dict[str, Any] | None) -> dict[str, Any]:
    """Convert a nextflow_schema.json into ordered field groups for form rendering."""
    if not schema:
        return {"title": None, "description": None, "groups": [], "has_schema": False}
    groups: list[dict[str, Any]] = []
    defs = _group_defs(schema)
    order: list[str] = []
    for ref in schema.get("allOf", []):
        m = re.match(r"#/(\$defs|definitions)/(.+)$", ref.get("$ref", ""))
        if m:
            order.append(m.group(2))
    for k in defs:
        if k not in order:
            order.append(k)
    for key in order:
        g = defs.get(key)
        if not g:
            continue
        req = set(g.get("required", []))
        fields = [_field(n, p, n in req) for n, p in (g.get("properties") or {}).items()]
        groups.append(
            {
                "id": key,
                "title": g.get("title", key.replace("_", " ").title()),
                "description": g.get("description", ""),
                "icon": g.get("fa_icon"),
                "fields": fields,
                "advanced": all(f["hidden"] for f in fields) if fields else False,
            }
        )
    top_props = schema.get("properties") or {}
    if top_props:
        req = set(schema.get("required", []))
        groups.append(
            {
                "id": "_ungrouped",
                "title": "Other parameters",
                "description": "",
                "icon": None,
                "fields": [_field(n, p, n in req) for n, p in top_props.items()],
                "advanced": False,
            }
        )
    return {
        "title": schema.get("title"),
        "description": schema.get("description"),
        "groups": groups,
        "has_schema": True,
    }


def defaults(schema: dict[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for g in normalize(schema)["groups"]:
        for f in g["fields"]:
            if f["default"] is not None:
                out[f["name"]] = f["default"]
    return out


def flatten(schema: dict[str, Any]) -> dict[str, Any]:
    """A single flat object schema (all groups merged) usable with jsonschema."""
    props: dict[str, Any] = {}
    required: list[str] = []
    for g in _group_defs(schema).values():
        for n, p in (g.get("properties") or {}).items():
            props[n] = _strip_custom(p)
        required.extend(g.get("required", []))
    for n, p in (schema.get("properties") or {}).items():
        props[n] = _strip_custom(p)
    required.extend(schema.get("required", []))
    return {"type": "object", "properties": props, "required": sorted(set(required))}


_CUSTOM_KEYS = {"exists", "mimetype", "schema", "fa_icon", "help_text", "hidden", "errorMessage", "meta"}


def _strip_custom(p: dict[str, Any]) -> dict[str, Any]:
    q = {k: v for k, v in p.items() if k not in _CUSTOM_KEYS}
    # nf-schema uses non-standard format names; jsonschema ignores unknown formats anyway.
    return q


def validate_params(schema: dict[str, Any] | None, params: dict[str, Any]) -> list[dict[str, str]]:
    """Validate user params against the pipeline schema. Returns a list of issues."""
    if not schema:
        return []
    flat = flatten(schema)
    # ignore empty strings for optional params (form fields left blank)
    clean = {k: v for k, v in params.items() if not (v == "" or v is None)}
    issues: list[dict[str, str]] = []
    validator = jsonschema.Draft7Validator(flat)
    for err in sorted(validator.iter_errors(clean), key=lambda e: list(e.path)):
        field = ".".join(str(x) for x in err.path) or (
            err.message.split("'")[1] if err.validator == "required" else ""
        )
        issues.append({"field": field, "message": err.message, "level": "error"})
    known = set(flat["properties"])
    for k in clean:
        if k not in known:
            issues.append({"field": k, "message": f"'{k}' is not defined in the pipeline schema", "level": "warning"})
    return issues


# --------------------------------------------------------------------------- samplesheet schema
def input_columns(input_schema: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Describe samplesheet columns from an nf-core ``assets/schema_input.json``."""
    if not input_schema:
        return []
    items = input_schema.get("items") or {}
    req = set(items.get("required", []))
    cols = []
    for name, p in (items.get("properties") or {}).items():
        types = {p.get("type")} | {a.get("type") for a in p.get("anyOf", [])}
        types.discard(None)
        fmt = p.get("format") or next((a.get("format") for a in p.get("anyOf", []) if a.get("format")), None)
        cols.append(
            {
                "name": name,
                "required": name in req,
                "types": sorted(types) or ["string"],
                "format": fmt,
                "pattern": p.get("pattern"),
                "enum": p.get("enum"),
                "is_file": fmt in FILE_FORMATS or bool(re.search(r"fast|fq|bam|raw|file", name, re.I) and "string" in types and p.get("pattern", "").find("\\.") >= 0),
                "description": p.get("errorMessage", ""),
                "meta": p.get("meta"),
                "dependent_required": p.get("dependentRequired"),
            }
        )
    return cols


def validate_rows(input_schema: dict[str, Any] | None, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not input_schema:
        return []
    schema = copy.deepcopy(input_schema)
    items = schema.get("items") or {}
    for name, p in list((items.get("properties") or {}).items()):
        items["properties"][name] = _strip_custom(p)
        for a in items["properties"][name].get("anyOf", []):
            for k in list(a):
                if k in _CUSTOM_KEYS:
                    a.pop(k)
    # nf-schema treats empty cells as absent
    cleaned = [{k: v for k, v in r.items() if v not in ("", None)} for r in rows]
    issues: list[dict[str, Any]] = []
    v = jsonschema.Draft7Validator(items)
    for i, row in enumerate(cleaned):
        for err in v.iter_errors(row):
            field = ".".join(str(x) for x in err.path)
            if err.validator == "required":
                field = err.message.split("'")[1]
            msg = err.message
            orig = (input_schema.get("items") or {}).get("properties", {}).get(field, {})
            if orig.get("errorMessage") and err.validator != "required":
                msg = orig["errorMessage"]
            issues.append({"row": i, "field": field, "message": msg, "level": "error"})
        # dependentRequired (draft 2019+) handled manually for draft-07 validators
        for name, p in (items.get("properties") or {}).items():
            for dep in (input_schema["items"]["properties"][name].get("dependentRequired") or []):
                if row.get(name) and not row.get(dep):
                    issues.append({"row": i, "field": dep, "message": f"'{dep}' is required when '{name}' is set", "level": "error"})
    return issues
