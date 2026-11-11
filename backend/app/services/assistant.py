"""Pipeline assistant: build pipelines from a description, review their logic, draft modules.

Providers (admin-selectable):
  * "anthropic"  - Claude API via the official `anthropic` SDK (API key or the SDK's normal credential chain)
  * "openai"     - ChatGPT models via the official `openai` SDK
  * "claude-cli" - the Claude Code CLI on the controller (`claude -p`, no tools, structured output)

Safety model: the assistant only *proposes*. Every answer is a typed JSON object validated with
Pydantic; generated pipelines are checked by BioCompute's own graph validator (with up to two
repair rounds) and loaded into the editor for the user to review. Nothing is saved, published
or executed by the assistant. Only pipeline structure, module definitions and tool help text are
sent to the provider - never data files, sample names or paths.
"""
from __future__ import annotations

import json
import re
import os
import shutil
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import AppSetting
from . import studio
from .studio_modules import PORT_TYPES

PROVIDERS = {
    "anthropic": {"label": "Claude (Anthropic API)", "default_model": "claude-opus-5-5"},
    "openai": {"label": "ChatGPT (OpenAI API)", "default_model": "gpt-5"},
    "claude-cli": {"label": "Claude Code on the controller", "default_model": ""},
}
# Claude models that accept the server-side refusal fallback ("default" routing)
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2"}
EFFORT_MODELS = ("claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-haiku-5", "claude-opus-4-8", "claude-opus-4-7")


class AssistantError(Exception):
    pass


# --------------------------------------------------------------------------- configuration / secrets
def _secrets_path() -> Path:
    return Path(get_settings().state_dir).resolve() / "ai_secrets.json"


def _secrets() -> dict[str, str]:
    try:
        return json.loads(_secrets_path().read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def set_secret(name: str, value: str | None) -> None:
    data = _secrets()
    if value:
        data[name] = value
    else:
        data.pop(name, None)
    p = _secrets_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh)


def config(db: Session) -> dict[str, Any]:
    row = db.get(AppSetting, "ai")
    stored = row.value if row else {}
    provider = stored.get("provider") or os.environ.get("BIOCOMPUTE_AI_PROVIDER", "off")
    model = stored.get("model") or os.environ.get("BIOCOMPUTE_AI_MODEL") or PROVIDERS.get(provider, {}).get("default_model", "")
    return {"provider": provider, "model": model, "effort": stored.get("effort", "high")}


def save_config(db: Session, provider: str, model: str | None, effort: str | None, api_key: str | None, clear_key: bool) -> None:
    if provider not in PROVIDERS and provider != "off":
        raise HTTPException(400, f"Unknown provider '{provider}'")
    row = db.get(AppSetting, "ai") or AppSetting(key="ai", value={})
    row.value = {"provider": provider, "model": (model or "").strip(), "effort": effort or "high"}
    db.merge(row)
    key_name = {"anthropic": "anthropic_api_key", "openai": "openai_api_key"}.get(provider)
    if key_name and (api_key or clear_key):
        set_secret(key_name, None if clear_key else api_key.strip())


def status(db: Session) -> dict[str, Any]:
    c = config(db)
    sec = _secrets()

    def key_state(name: str, env: str) -> dict[str, Any]:
        if sec.get(name):
            return {"configured": True, "source": "saved in BioCompute", "hint": "…" + sec[name][-4:]}
        if os.environ.get(env):
            return {"configured": True, "source": f"environment ({env})", "hint": None}
        return {"configured": False, "source": None, "hint": None}

    providers = {
        "anthropic": {**PROVIDERS["anthropic"], **key_state("anthropic_api_key", "ANTHROPIC_API_KEY")},
        "openai": {**PROVIDERS["openai"], **key_state("openai_api_key", "OPENAI_API_KEY")},
        "claude-cli": {**PROVIDERS["claude-cli"], "configured": bool(shutil.which("claude")),
                       "source": shutil.which("claude"), "hint": None,
                       **({"auth": claude_cli_auth()} if c["provider"] == "claude-cli" and shutil.which("claude") else {})},
    }
    if c["provider"] == "anthropic" and not providers["anthropic"]["configured"]:
        providers["anthropic"]["note"] = "No key saved: the SDK will try ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile"
    active = providers.get(c["provider"])
    return {**c, "enabled": c["provider"] != "off", "ready": bool(active and (active["configured"] or c["provider"] == "anthropic")),
            "providers": providers,
            "privacy": "Only pipeline structure, module definitions and tool help text are sent - never data, sample names or paths."}


# --------------------------------------------------------------------------- structured output schemas
class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KV(_Strict):
    name: str
    value: str


class DraftNode(_Strict):
    id: str
    module: str
    label: str
    params: list[KV]


class DraftEdge(_Strict):
    source: str
    source_port: str
    target: str
    target_port: str


class MissingModule(_Strict):
    tool: str
    reason: str


class PipelineDraft(_Strict):
    name: str
    description: str
    explanation: str
    assumptions: list[str]
    nodes: list[DraftNode]
    edges: list[DraftEdge]
    missing_modules: list[MissingModule]


class Finding(_Strict):
    severity: Literal["error", "warning", "suggestion"]
    node_id: str
    title: str
    detail: str


class Review(_Strict):
    verdict: Literal["sound", "needs_changes", "invalid"]
    summary: str
    findings: list[Finding]
    recommendations: list[str]


class AIInPort(_Strict):
    name: str
    type: Literal[tuple(PORT_TYPES)]  # type: ignore[valid-type]
    multiple: bool


class AIOutPort(_Strict):
    name: str
    type: Literal[tuple(PORT_TYPES)]  # type: ignore[valid-type]
    pattern: str


class AIParam(_Strict):
    name: str
    type: Literal["string", "integer", "number", "boolean"]
    default: str
    choices: list[str]
    description: str


class ModuleDraft(_Strict):
    id: str
    name: str
    category: str
    description: str
    scope: Literal["per_sample", "aggregate"]
    language: Literal["bash", "python", "r"]
    inputs: list[AIInPort]
    outputs: list[AIOutPort]
    params: list[AIParam]
    tools: list[str]
    conda: str
    container: str
    cpus: int
    memory_gb: float
    script: str
    notes: str


class Answer(_Strict):
    answer: str
    suggestions: list[str]


class Ping(_Strict):
    ok: bool
    model: str


def strict_schema(model: type[BaseModel]) -> dict[str, Any]:
    """JSON schema accepted by Claude and OpenAI structured outputs: every object closed, every property required."""
    schema = model.model_json_schema()

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            if isinstance(node.get("title"), str):  # annotation, not a property called "title"
                node.pop("title")
            node.pop("default", None)
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"])
                for v in node["properties"].values():
                    walk(v)
            for k, v in node.items():
                if k not in ("properties",):
                    walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
        return node

    return walk(schema)


# --------------------------------------------------------------------------- providers
def _run_anthropic(model: str, effort: str, system: str, prompt: str, schema: dict, key: str | None) -> tuple[dict, dict]:
    import anthropic

    client = anthropic.Anthropic(api_key=key, timeout=600.0) if key else anthropic.Anthropic(timeout=600.0)
    kwargs: dict[str, Any] = {
        "model": model, "max_tokens": 16000, "system": system,
        "messages": [{"role": "user", "content": prompt}],
        "output_config": {"format": {"type": "json_schema", "schema": schema},
                          **({"effort": effort} if model.startswith(EFFORT_MODELS) else {})},
    }
    try:
        if model in FALLBACK_MODELS:  # server-side refusal fallback, routed by refusal category
            resp = client.beta.messages.create(**kwargs, betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        else:
            resp = client.messages.create(**kwargs)
    except anthropic.AuthenticationError as exc:
        raise AssistantError("The Anthropic API key was rejected. Check it in Settings, AI assistant.") from exc
    except anthropic.PermissionDeniedError as exc:
        raise AssistantError(f"The API key may not use {model}: {exc.message}") from exc
    except anthropic.NotFoundError as exc:
        raise AssistantError(f"Model '{model}' was not found. Check the model name in Settings.") from exc
    except anthropic.RateLimitError as exc:
        raise AssistantError("Rate limited by the Anthropic API; try again in a minute.") from exc
    except anthropic.APIStatusError as exc:
        raise AssistantError(f"Anthropic API error {exc.status_code}: {exc.message}") from exc
    except anthropic.APIConnectionError as exc:
        raise AssistantError("Could not reach the Anthropic API from the controller (network or proxy).") from exc
    except (TypeError, anthropic.AnthropicError) as exc:  # e.g. no credentials at all
        if "authentication" in str(exc).lower() or "api_key" in str(exc):
            raise AssistantError("No Anthropic API key: enter one in Settings, AI assistant "
                                 "(or set ANTHROPIC_API_KEY for the BioCompute service).") from exc
        raise AssistantError(f"Anthropic SDK error: {exc}") from exc
    if resp.stop_reason == "refusal":
        cat = getattr(getattr(resp, "stop_details", None), "category", None)
        raise AssistantError(f"The model declined this request{f' ({cat})' if cat else ''}.")
    if resp.stop_reason == "max_tokens":
        raise AssistantError("The answer was too long and was cut off; try a narrower request.")
    text = next((b.text for b in resp.content if b.type == "text"), None)
    if not text:
        raise AssistantError("The model returned no answer.")
    meta = {"provider": "anthropic", "model": resp.model, "request_id": getattr(resp, "_request_id", None),
            "input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}
    return json.loads(text), meta


def _run_openai(model: str, system: str, prompt: str, schema: dict, name: str, key: str | None) -> tuple[dict, dict]:
    import openai

    try:
        client = openai.OpenAI(api_key=key, timeout=600.0) if key else openai.OpenAI(timeout=600.0)
    except openai.OpenAIError as exc:  # raised when no key is configured anywhere
        raise AssistantError("No OpenAI API key: enter one in Settings, AI assistant "
                             "(or set OPENAI_API_KEY for the BioCompute service).") from exc
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            response_format={"type": "json_schema", "json_schema": {"name": name, "schema": schema, "strict": True}},
        )
    except openai.AuthenticationError as exc:
        raise AssistantError("The OpenAI API key was rejected. Check it in Settings, AI assistant.") from exc
    except openai.NotFoundError as exc:
        raise AssistantError(f"Model '{model}' is not available to this OpenAI account. Check the model name in Settings.") from exc
    except openai.RateLimitError as exc:
        raise AssistantError("Rate limited (or out of quota) on the OpenAI API.") from exc
    except openai.APIStatusError as exc:
        raise AssistantError(f"OpenAI API error {exc.status_code}: {exc.message}") from exc
    except openai.APIConnectionError as exc:
        raise AssistantError("Could not reach the OpenAI API from the controller (network or proxy).") from exc
    msg = resp.choices[0].message
    if getattr(msg, "refusal", None):
        raise AssistantError(f"The model declined: {msg.refusal}")
    if resp.choices[0].finish_reason == "length":
        raise AssistantError("The answer was too long and was cut off; try a narrower request.")
    meta = {"provider": "openai", "model": resp.model, "request_id": getattr(resp, "id", None),
            "input_tokens": getattr(resp.usage, "prompt_tokens", None), "output_tokens": getattr(resp.usage, "completion_tokens", None)}
    return json.loads(msg.content or "{}"), meta


_auth_cache: dict[str, Any] = {"t": 0.0, "v": None}


def claude_cli_auth(exe: str | None = None, max_age: float = 600) -> dict[str, Any]:
    """How the Claude Code CLI is signed in, from `claude auth status`.

    billing: "subscription" (claude.ai login: usage counts against the plan's limits, no per-request charge),
    "api" (API key: billed per request), "cloud" (Bedrock/Vertex: billed by that provider) or "unknown".
    """
    import time

    exe = exe or shutil.which("claude")
    if not exe:
        return {"logged_in": False, "billing": "unknown", "method": None}
    if _auth_cache["v"] is not None and time.time() - _auth_cache["t"] < max_age:
        return _auth_cache["v"]
    try:
        p = subprocess.run([exe, "auth", "status"], capture_output=True, text=True, timeout=20)
        st = json.loads(p.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
        st = {}
    method = str(st.get("authMethod") or "")
    provider = str(st.get("apiProvider") or "firstParty")
    if provider not in ("firstParty", ""):
        billing = "cloud"
    elif "oauth" in method or method in ("claude.ai", "subscription"):
        billing = "subscription"
    elif "key" in method or "token" in method:
        billing = "api"
    else:
        billing = "unknown"
    v = {"logged_in": bool(st.get("loggedIn")), "billing": billing, "method": method or None, "provider": provider}
    _auth_cache.update(t=time.time(), v=v)
    return v


def _run_claude_cli(model: str, system: str, prompt: str, schema: dict) -> tuple[dict, dict]:
    exe = shutil.which("claude")
    if not exe:
        raise AssistantError("The Claude Code CLI ('claude') is not installed for the account running BioCompute.")
    argv = [exe, "-p", "--output-format", "json", "--tools", "", "--no-session-persistence",
            "--system-prompt", system, "--json-schema", json.dumps(schema)]
    if model:
        argv += ["--model", model]
    with tempfile.TemporaryDirectory(prefix="biocompute-assistant-") as cwd:  # nothing to read, no tools anyway
        try:
            p = subprocess.run(argv, input=prompt, capture_output=True, text=True, timeout=900, cwd=cwd)
        except subprocess.TimeoutExpired as exc:
            raise AssistantError("Claude Code did not answer within 15 minutes.") from exc
    try:
        d = json.loads(p.stdout)
    except json.JSONDecodeError:
        raise AssistantError(f"Claude Code failed: {(p.stderr or p.stdout).strip()[-400:]}") from None
    if d.get("is_error") or d.get("subtype") not in (None, "success"):
        raise AssistantError(f"Claude Code reported an error: {str(d.get('result'))[:400]}")
    obj = d.get("structured_output")
    if obj is None:
        try:
            obj = json.loads(d.get("result") or "")
        except json.JSONDecodeError:
            raise AssistantError("Claude Code did not return structured output.") from None
    used = list((d.get("modelUsage") or {}).keys())
    usage = d.get("usage") or {}
    billing = claude_cli_auth(exe)["billing"]
    cost = d.get("total_cost_usd")
    # Claude Code always reports an API-price figure. With a subscription nothing is charged per request,
    # so it is kept only as an estimate ("api_equivalent_usd"), never shown as a cost.
    meta = {"provider": "claude-cli", "model": used[0] if used else (model or "default"), "billing": billing,
            "cost_usd": cost if billing in ("api", "cloud") else None,
            "api_equivalent_usd": cost if billing not in ("api", "cloud") else None,
            "input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens"),
            "request_id": d.get("session_id")}
    return obj, meta


def call(db: Session, task: str, system: str, prompt: str, out: type[BaseModel]) -> tuple[BaseModel, dict]:
    c = config(db)
    if c["provider"] == "off":
        raise AssistantError("The AI assistant is off. An administrator can enable it in Settings, AI assistant.")
    schema = strict_schema(out)
    sec = _secrets()
    if c["provider"] == "anthropic":
        raw, meta = _run_anthropic(c["model"] or PROVIDERS["anthropic"]["default_model"], c["effort"], system, prompt, schema,
                                   sec.get("anthropic_api_key"))
    elif c["provider"] == "openai":
        raw, meta = _run_openai(c["model"] or PROVIDERS["openai"]["default_model"], system, prompt, schema, out.__name__,
                                sec.get("openai_api_key"))
    else:
        raw, meta = _run_claude_cli(c["model"], system, prompt, schema)
    try:
        return out.model_validate(raw), {**meta, "task": task}
    except ValidationError as exc:
        raise AssistantError(f"The answer did not match the expected format: {exc.errors()[0]['msg']}") from exc


# --------------------------------------------------------------------------- prompts
SYSTEM = """You are the pipeline assistant inside BioCompute, a platform a research lab uses to build and run \
bioinformatics workflows (genomics, epigenomics, transcriptomics, proteomics). Users assemble pipelines from modules \
in a visual editor; BioCompute compiles them to Nextflow DSL2 and to its own engine.

How pipelines are represented:
- A pipeline is a graph of nodes and edges. Each node uses one module from the catalog you are given, by its exact id.
- An edge connects an output port of one node (source_port = output name) to an input port of another node \
(target_port = input name). Port types must match exactly unless either side is "any".
- One "input_samplesheet" node supplies per-sample FASTQ reads. Reference files (aligner index, FASTA, GTF/BED) come \
from "input_file" nodes; give them params param_name (snake_case pipeline parameter, e.g. bowtie2_index), file_type \
(the port type, e.g. index, fasta, annotation) and format (file-path or directory-path).
- "per_sample" modules run once per sample; their per-sample inputs must come from the samplesheet or another \
per_sample module. "aggregate" modules run once over all samples; inputs marked multiple accept several edges \
(for example MultiQC collecting QC files from several steps).
- Every input must be connected; inputs not marked multiple take exactly one edge. No cycles.
- Node params are name/value strings for that module's parameters; leave defaults out.
- Where the data lives is chosen when the pipeline is launched (an experiment, a samplesheet or a FASTQ folder), so never \
invent file paths. Keep the input nodes generic: label the samplesheet node after the reads (e.g. "PRO-seq reads").

Working rules:
- Use only module ids from the catalog. Prefer modules whose tools are installed. If the analysis needs software \
that has no module, list it under missing_modules (tool and why) instead of inventing a module id.
- Follow established practice for the assay and say what you assumed (genome, read layout, controls, strandedness). \
Typical expectations: read QC and trimming before alignment; MAPQ and duplicate filtering before peak calling; \
matched input/IgG controls for ChIP and CUT&RUN when available; BAMPE for paired-end MACS; strandedness for RNA-seq \
counting; a MultiQC report collecting QC outputs.
- Be specific and concise. Plain sentences, no marketing language."""


def catalog(index: dict[str, dict[str, Any]]) -> str:
    rows = []
    for m in index.values():
        tools = m.get("tools") or []
        rows.append({
            "id": m["id"], "name": m["name"], "kind": m.get("kind"), "category": m.get("category"),
            "scope": m.get("scope", "source" if m.get("kind") == "source" else None),
            "description": m.get("description", "")[:200],
            "inputs": [f"{p['name']}:{p['type']}{' (multiple)' if p.get('multiple') else ''}" for p in m.get("inputs", [])],
            "outputs": [f"{p['name']}:{p['type']}" for p in m.get("outputs", [])],
            "params": [f"{p['name']}:{p['type']}={p.get('default')}" + (f" one of {p['enum']}" if p.get("enum") else "")
                       for p in m.get("params", [])],
            "tools": tools, "installed_on_controller": all(shutil.which(t) for t in tools) if tools else True,
            "user_defined": bool(m.get("user")),
        })
    return json.dumps({"port_types": list(PORT_TYPES), "modules": rows}, indent=1)


def _graph_as_draft(graph: dict[str, Any]) -> dict[str, Any]:
    nodes = [{"id": n["id"], "module": (n.get("data") or {}).get("module"), "label": (n.get("data") or {}).get("label"),
              "params": [{"name": k, "value": str(v)} for k, v in ((n.get("data") or {}).get("params") or {}).items()]}
             for n in graph.get("nodes", [])]
    edges = [{"source": e["source"], "source_port": (e.get("sourceHandle") or "").removeprefix("out:"),
              "target": e["target"], "target_port": (e.get("targetHandle") or "").removeprefix("in:")}
             for e in graph.get("edges", [])]
    return {"nodes": nodes, "edges": edges}


def _coerce(value: str, ptype: str) -> Any:
    try:
        if ptype == "integer":
            return int(float(value))
        if ptype == "number":
            return float(value)
        if ptype == "boolean":
            return value.strip().lower() in ("true", "1", "yes")
    except ValueError:
        return value
    return value


def draft_to_graph(d: PipelineDraft, index: dict[str, dict[str, Any]]) -> dict[str, Any]:
    ids = {}
    for i, n in enumerate(d.nodes):
        ids[n.id] = f"ai{i + 1}"
    # layered layout: depth = longest path from a source
    preds: dict[str, list[str]] = defaultdict(list)
    for e in d.edges:
        if e.source in ids and e.target in ids:
            preds[e.target].append(e.source)
    depth: dict[str, int] = {}

    def dep(nid: str, seen: frozenset = frozenset()) -> int:
        if nid in depth:
            return depth[nid]
        if nid in seen:
            return 0
        depth[nid] = 1 + max((dep(p, seen | {nid}) for p in preds[nid]), default=-1)
        return depth[nid]

    rows: dict[int, int] = defaultdict(int)
    nodes = []
    for n in d.nodes:
        lvl = dep(n.id)
        spec = index.get(n.module) or {}
        ptypes = {p["name"]: p["type"] for p in spec.get("params", [])}
        params = {kv.name: _coerce(kv.value, ptypes[kv.name]) for kv in n.params if kv.name in ptypes}
        nodes.append({"id": ids[n.id], "type": "module", "position": {"x": 60 + lvl * 290, "y": 60 + rows[lvl] * 150},
                      "data": {"module": n.module, "label": n.label or spec.get("name", n.module), "params": params}})
        rows[lvl] += 1
    edges = [{"id": f"e{i + 1}", "source": ids[e.source], "sourceHandle": f"out:{e.source_port}",
              "target": ids[e.target], "targetHandle": f"in:{e.target_port}"}
             for i, e in enumerate(d.edges) if e.source in ids and e.target in ids]
    return {"nodes": nodes, "edges": edges}


def _design(db: Session, index: dict[str, dict[str, Any]], ask: str) -> dict[str, Any]:
    """One design: draft, then validate and repair up to twice."""
    base = f"Module catalog:\n{catalog(index)}\n\n"
    draft, meta = call(db, "build", SYSTEM, base + ask, PipelineDraft)
    metas = [meta]
    graph = draft_to_graph(draft, index)
    v = studio.validate(graph, index)
    attempts = 1
    while not v["valid"] and attempts < 3:
        problems = "\n".join(f"- {i['message']}" for i in v["issues"] if i["level"] == "error")
        repair = (base + ask + f"\n\nYour previous answer:\n{draft.model_dump_json(indent=1)}\n\n"
                  f"BioCompute's validator rejected it:\n{problems}\n\nReturn a corrected pipeline.")
        draft, meta = call(db, "build-repair", SYSTEM, repair, PipelineDraft)
        metas.append(meta)
        graph = draft_to_graph(draft, index)
        v = studio.validate(graph, index)
        attempts += 1
    return {"draft": draft, "graph": graph, "validation": v, "attempts": attempts, "metas": metas}


def _merge_meta(metas: list[dict[str, Any]]) -> dict[str, Any]:
    out = dict(metas[-1])
    for key in ("cost_usd", "api_equivalent_usd"):
        vals = [m.get(key) for m in metas if m.get(key) is not None]
        if vals:
            out[key] = round(sum(vals), 4)
    for k in ("input_tokens", "output_tokens"):
        vals = [m.get(k) for m in metas if m.get(k) is not None]
        if vals:
            out[k] = sum(vals)
    out["calls"] = len(metas)
    return out


def _create_missing(db: Session, index: dict[str, dict[str, Any]], missing: list[MissingModule], user: str,
                    metas: list[dict[str, Any]], limit: int = 4) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Draft, check and save a module for each piece of software the design lacked. Nothing is run."""
    from ..models import CustomModule
    from . import custom_modules as cm

    created: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    if not get_settings().allow_custom_code_modules:
        return created, [{"tool": m.tool, "error": "Custom modules are disabled by the administrator"} for m in missing], index
    for m in missing[:limit]:
        exe = re.split(r"[\s(,;/]", m.tool.strip())[0] if m.tool.strip() else ""
        found = bool(exe) and cm.check_tool(exe).get("found")
        help_text = cm.tool_help(exe) if found else None
        try:
            d = draft_module(db, index, f"{m.tool}: {m.reason}", exe or None, help_text)
        except AssistantError as exc:
            failed.append({"tool": m.tool, "error": str(exc)})
            continue
        metas.append(d["meta"])
        mod = d["module"]
        base_id = re.sub(r"[^a-z0-9_]", "_", str(mod.get("id") or "u_module").lower())[:36] or "u_module"
        if not base_id.startswith("u_"):
            base_id = ("u_" + base_id)[:36]
        mod["id"], k = base_id, 2
        while mod["id"] in index or db.get(CustomModule, mod["id"]):
            mod["id"], k = f"{base_id}_{k}", k + 1
        mod["description"] = (str(mod.get("description") or "") + " Drafted by the assistant: review before relying on it.").strip()
        chk = cm.check_module(mod, db=db)
        if not chk["valid"]:
            failed.append({"tool": m.tool, "error": "; ".join(i["message"] for i in chk["issues"] if i["level"] == "error")[:400]})
            continue
        db.add(CustomModule(id=mod["id"], definition=chk["module"], created_by=user))
        db.flush()
        index = {**index, mod["id"]: cm.to_index_entry(cm.ModuleDef.model_validate(chk["module"]))}
        created.append({"id": mod["id"], "name": chk["module"]["name"], "tool": m.tool, "tool_installed": found,
                        "notes": d["notes"], "warnings": [i["message"] for i in chk["issues"] if i["level"] == "warning"]})
    return created, failed, index


def build(db: Session, index: dict[str, dict[str, Any]], description: str, current: dict[str, Any] | None = None,
          create_modules: bool = False, user: str = "assistant") -> dict[str, Any]:
    if current and current.get("nodes"):
        ask = (f"Current pipeline:\n{json.dumps(_graph_as_draft(current), indent=1)}\n\n"
               f"Change the current pipeline as follows (keep what is not affected):\n{description}")
    else:
        ask = f"Design a pipeline for this request:\n{description}"
    res = _design(db, index, ask)
    metas = list(res["metas"])
    created: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    if create_modules and res["draft"].missing_modules:
        created, failed, index = _create_missing(db, index, res["draft"].missing_modules, user, metas)  # index: the user's view + new modules
        if created:
            listing = ", ".join(f"{c['id']} ({c['tool']})" for c in created)
            res = _design(db, index, ask + f"\n\nNew modules were just added to the catalog for software that had none: {listing}. "
                                           "Use them where they fit; list only software that still has no module under missing_modules.")
            metas += res["metas"]
    d, v = res["draft"], res["validation"]
    return {"graph": res["graph"], "name": d.name, "description": d.description, "explanation": d.explanation,
            "assumptions": d.assumptions, "missing_modules": [m.model_dump() for m in d.missing_modules],
            "created_modules": created, "module_failures": failed,
            "valid": v["valid"], "issues": v["issues"], "attempts": res["attempts"], "meta": _merge_meta(metas)}


def review(db: Session, index: dict[str, dict[str, Any]], graph: dict[str, Any], goal: str = "") -> dict[str, Any]:
    v = studio.validate(graph, index)
    used = {(n.get("data") or {}).get("module") for n in graph.get("nodes", [])}
    scripts = {m: index[m].get("script", "")[:1500] for m in used if m in index and index[m].get("kind") == "module"}
    prompt = (f"Module catalog:\n{catalog(index)}\n\nPipeline to review:\n{json.dumps(_graph_as_draft(graph), indent=1)}\n\n"
              f"Scripts of the modules it uses:\n{json.dumps(scripts, indent=1)}\n\n"
              f"BioCompute's structural validator reported:\n{json.dumps(v['issues'], indent=1)}\n\n"
              + (f"The scientist's goal: {goal}\n\n" if goal else "")
              + "Review this pipeline. Check that it will run (ports, scopes, missing inputs) and that it is scientifically "
                "sound for its apparent purpose: missing QC or filtering steps, wrong or risky parameters, missing controls, "
                "resource sizing, reproducibility (conda/container). Use node ids from the pipeline in findings (empty string "
                "for general findings). severity error = will fail or gives wrong results; warning = likely problem; "
                "suggestion = improvement. Give concrete recommendations.")
    r, meta = call(db, "review", SYSTEM, prompt, Review)
    return {**r.model_dump(), "validator": v, "meta": meta}


MODULE_CONTRACT = """A module is a script run once per sample (scope per_sample) or once over all samples (aggregate).
It reads everything from environment variables:
  BC_PREFIX        sample id (aggregate modules: the module name)
  BC_CPUS          CPUs granted to the task
  BC_IN_<INPUT>    space-separated input file paths for input port <INPUT> (upper case)
  BC_PARAM_<NAME>  parameter values (booleans are the strings true/false)
Outputs are files in the working directory matching each output pattern; {prefix} expands to the sample id.
Patterns are plain file names (wildcards allowed, no directories). Bash scripts start with `set -euo pipefail`.
Port types: """ + ", ".join(PORT_TYPES)


def draft_module(db: Session, index: dict[str, dict[str, Any]], description: str, tool: str | None,
                 help_text: str | None) -> dict[str, Any]:
    example = {k: index["macs3"][k] for k in ("id", "name", "scope", "inputs", "outputs", "params", "tools", "script")} \
        if "macs3" in index else {}
    prompt = (f"{MODULE_CONTRACT}\n\nExample module:\n{json.dumps(example, indent=1)}\n\n"
              f"Existing module ids (do not reuse): {sorted(index)}\n\n"
              + (f"The program `{tool}` is installed on the controller. Its help text:\n```\n{help_text}\n```\n"
                 "Use only options that appear in this help text.\n\n" if help_text else
                 (f"The program is `{tool}` (its help text is not available here).\n\n" if tool else ""))
              + f"Write a module for this request:\n{description}\n\n"
                "Rules: id must start with 'u_' followed by lowercase letters, digits or underscores. Choose port types "
                "carefully so the module connects to the rest of the library. Name parameters after the options they "
                "control. Provide the bioconda package in conda (e.g. bioconda::tool=version) and a biocontainers image "
                "in container only if you are confident they exist; otherwise leave them empty. Put caveats in notes.")
    d, meta = call(db, "draft-module", SYSTEM, prompt, ModuleDraft)
    module = d.model_dump(exclude={"notes"})
    for p in module["params"]:
        p["default"] = _coerce(p["default"], p["type"]) if p["default"] != "" else None
        p["enum"] = [_coerce(c, p["type"]) for c in p.pop("choices")] or None
    return {"module": module, "notes": d.notes, "meta": meta}


def ask(db: Session, index: dict[str, dict[str, Any]], question: str, graph: dict[str, Any] | None) -> dict[str, Any]:
    prompt = (f"Module catalog:\n{catalog(index)}\n\n"
              + (f"Current pipeline:\n{json.dumps(_graph_as_draft(graph), indent=1)}\n\n" if graph and graph.get("nodes") else "")
              + f"Question:\n{question}\n\nAnswer in a few short paragraphs (markdown allowed); add concrete suggestions.")
    a, meta = call(db, "ask", SYSTEM, prompt, Answer)
    return {**a.model_dump(), "meta": meta}


def ping(db: Session) -> dict[str, Any]:
    p, meta = call(db, "test", "Reply with ok = true and the name of the model you are.", "Connection test.", Ping)
    return {"ok": p.ok, "meta": meta}
