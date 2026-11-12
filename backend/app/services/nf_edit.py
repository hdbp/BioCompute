"""Add and remove steps of a Nextflow DSL2 pipeline by editing its code (for your own copies, from Pipeline Studio).

Both operations work on the workflow the map shows (nf_map.build_map) and return the changed files; the caller
writes them into a NEW version folder. They are deliberately conservative: anything they cannot rewrite safely is
refused with the reason (and the code editor remains available).

Remove: deletes the step's call. Statements that only collect its outputs (`ch_x = ch_x.mix(STEP.out...)`) lose
that part; a channel re-assigned from its output keeps its earlier value; an `emit:` of its output becomes
`Channel.empty()`. If another step is called with its output, the caller must allow "connect to its input"
(the output is replaced by what the removed step was called with), else the removal is refused.

Add: a module from BioCompute's library (the same process Pipeline Studio would generate) becomes
modules/local/biocompute/<name>/main.nf with its script in bin/, is included in the workflow file and called right
after the chosen step with one of that step's outputs. Its parameters and any extra file inputs become pipeline
parameters (nextflow.config and nextflow_schema.json).
"""
from __future__ import annotations

import difflib
import json
import re
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import nf_map
from .studio import LANG_EXT, LANG_RUN, _groovy, _nf_pattern

IDENT = r"[A-Za-z_][A-Za-z0-9_]*"


# --------------------------------------------------------------------------- locating code
def _workflow(root: Path) -> tuple[dict[str, Any], str, str, str, tuple[int, int]]:
    """(map, workflow file rel path, raw text, clean text, body span) of the workflow the map shows."""
    m = nf_map.build_map(root)
    if not m.get("ok"):
        raise HTTPException(409, m.get("reason") or "No workflow found")
    rel = m["file"]
    f = nf_map._File(root / rel, rel)
    name = "" if m["workflow"] == "(entry workflow)" else m["workflow"]
    return m, rel, f.raw, f.text, f.workflows[name]


def _statements(clean: str, a: int, b: int) -> list[dict[str, Any]]:
    """Top-level statements of a workflow body with absolute [start, end) offsets (whole lines) and section."""
    out: list[dict[str, Any]] = []
    section = "main"
    cur: dict[str, Any] | None = None
    depth = 0
    pos = a
    for line in clean[a:b].split("\n"):
        start, end = pos, pos + len(line)
        pos = end + 1
        s = line.strip()
        if cur is None:
            if not s:
                continue
            if re.match(r"^\}?\s*(else\s+)?if\s*\(.*\)\s*\{$", s) or re.match(r"^\}?\s*else\s*\{$", s) or s == "}":
                continue
            if re.fullmatch(r"(take|main|emit|publish):", s):
                section = s[:-1]
                continue
            if s.startswith(".") and out and out[-1]["section"] == section:
                cur = out.pop()  # a method chain continues the previous statement
            else:
                cur = {"start": start, "section": section}
                depth = 0
        depth += sum(s.count(c) for c in "([{") - sum(s.count(c) for c in ")]}")
        cur["end"] = min(end + 1, b)
        if depth <= 0:
            cur["text"] = clean[cur["start"]:cur["end"]]
            out.append(cur)
            cur = None
            depth = 0
    if cur is not None:
        cur["text"] = clean[cur["start"]:cur["end"]]
        out.append(cur)
    return out


def _match_paren(clean: str, open_at: int) -> int:
    depth = 0
    for k in range(open_at, len(clean)):
        if clean[k] in "([{":
            depth += 1
        elif clean[k] in ")]}":
            depth -= 1
            if depth == 0:
                return k
    return len(clean) - 1


def _split_args(s: str) -> list[str]:
    parts, depth, cur = [], 0, ""
    for ch in s:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return [p.strip() for p in parts]


def _call(stmts: list[dict[str, Any]], clean: str, step: str) -> tuple[dict[str, Any], int, int] | None:
    """The statement calling `step`, and the offsets of its '(' and ')'."""
    rx = re.compile(rf"(?<![.\w]){re.escape(step)}\s*\(")
    for st in stmts:
        if st["section"] != "main":
            continue
        m = rx.search(clean, st["start"], st["end"])
        if m:
            o = m.end() - 1
            return st, o, _match_paren(clean, o)
    return None


def _diff(files_before: dict[str, str], files_after: dict[str, str]) -> str:
    chunks = []
    for path in sorted(files_after):
        a = files_before.get(path, "").splitlines(keepends=True)
        b = files_after[path].splitlines(keepends=True)
        chunks.append("".join(difflib.unified_diff(a, b, f"a/{path}" if path in files_before else "/dev/null", f"b/{path}", n=2)))
    return "\n".join(c for c in chunks if c)


def _apply(raw: str, edits: list[tuple[int, int, str]]) -> str:
    for s, e, rep in sorted(edits, key=lambda x: x[0], reverse=True):
        raw = raw[:s] + rep + raw[e:]
    return raw


def _line_span(raw: str, s: int, e: int) -> tuple[int, int]:
    """Extend [s, e) to whole lines when nothing else is on them."""
    ls = raw.rfind("\n", 0, s) + 1
    le = raw.find("\n", e)
    le = len(raw) if le < 0 else le + 1
    if raw[ls:s].strip() == "" and raw[e:le].strip() == "":
        return ls, le
    return s, e


# --------------------------------------------------------------------------- remove
def plan_remove(root: Path, step: str, connect: bool = False) -> dict[str, Any]:
    m, rel, raw, clean, (a, b) = _workflow(root)
    node = next((n for n in m["nodes"] if n["id"] == step and n["kind"] in ("process", "subworkflow")), None)
    if not node:
        raise HTTPException(400, f"{step} is not a step of the workflow shown on the map")
    stmts = _statements(clean, a, b)
    found = _call(stmts, clean, step)
    if not found:
        raise HTTPException(409, f"Could not find where {step} is called; remove it in the code instead")
    call_st, o, c = found
    if re.match(rf"^\s*{IDENT}\s*=", call_st["text"]):
        raise HTTPException(409, f"{step}'s result is assigned to a variable; remove it in the code instead")
    args = _split_args(clean[o + 1:c])
    raw_args = []
    pos = o + 1
    for arg in args:  # map clean args back to raw text by offsets
        k = clean.index(arg, pos)
        raw_args.append(raw[k:k + len(arg)])
        pos = k + len(arg)
    first_input = raw_args[0] if raw_args else None

    edits: list[tuple[int, int, str]] = [(call_st["start"], call_st["end"], "")]
    notes = [f"The call of {step} is removed."]
    consumers: list[str] = []
    ref = re.compile(rf"(?<![.\w]){re.escape(step)}\.out\b(\.{IDENT})?")
    for st in stmts:
        if st is call_st or not ref.search(st["text"]):
            continue
        text = st["text"]
        lhs = re.match(rf"^\s*({IDENT})\s*=(?!=)\s*", text)
        if st["section"] == "emit" and lhs:
            edits.append((st["start"] + lhs.end(), st["end"] - (1 if clean[st["end"] - 1] == "\n" else 0), "Channel.empty()"))
            notes.append(f"Output “{lhs.group(1)}” of the workflow becomes empty.")
            continue
        if st["section"] != "main":
            raise HTTPException(409, f"{step}'s output is used in a way BioCompute cannot rewrite; edit the code instead")
        # ch_x = ch_x.mix(A.out...).mix(STEP.out...): drop the parts that read STEP
        mixes = []
        for mm in re.finditer(r"\.mix\s*\(", clean[st["start"]:st["end"]]):
            mo = st["start"] + mm.end() - 1
            mc = _match_paren(clean, mo)
            if ref.search(clean[mo:mc]):
                mixes.append((st["start"] + mm.start(), mc + 1))
        rest = text
        for s0, e0 in mixes:
            rest = rest.replace(clean[s0:e0], "")
        if mixes and not ref.search(rest):
            if lhs and re.fullmatch(rf"\s*{lhs.group(1)}\s*=\s*{lhs.group(1)}\s*", rest):
                edits.append((st["start"], st["end"], ""))
            else:
                for s0, e0 in mixes:
                    edits.append(_line_span(raw, s0, e0))
            notes.append(f"{step} no longer adds to “{lhs.group(1) if lhs else 'a channel'}”.")
            continue
        # ch_x = STEP.out.y (a re-assignment): keep the earlier value
        if lhs and re.match(rf"^\s*{IDENT}\s*=\s*{re.escape(step)}\.out\b", text):
            var = lhs.group(1)
            earlier = any(re.match(rf"^\s*(def\s+)?{var}\s*=(?!=)", s2["text"]) or re.search(rf"\.set\s*\{{\s*{var}\s*\}}", s2["text"])
                          for s2 in stmts if s2["start"] < st["start"] and s2 is not st)
            if earlier:
                edits.append((st["start"], st["end"], ""))
                notes.append(f"“{var}” keeps its earlier value (no longer {step}'s output).")
            else:
                edits.append((st["start"] + lhs.end(), st["end"] - (1 if clean[st["end"] - 1] == "\n" else 0), "Channel.empty()"))
                notes.append(f"“{var}” becomes empty.")
            continue
        # another step is called with STEP's output
        callee = next((x for x in re.findall(rf"(?<![.\w])({IDENT})\s*\(", text) if x != step and x in {n["id"] for n in m["nodes"]}), None)
        if callee:
            consumers.append(callee)
            if connect and first_input:
                for r in ref.finditer(clean, st["start"], st["end"]):
                    end = r.end()
                    edits.append((r.start(), end, first_input))
                notes.append(f"{callee} now reads {first_input} (what {step} was given) instead of {step}'s output.")
                continue
            continue
        raise HTTPException(409, f"{step}'s output is used in a way BioCompute cannot rewrite; edit the code instead")
    if consumers and not (connect and first_input):
        return {"ok": False, "step": step, "consumers": sorted(set(consumers)), "input": first_input,
                "message": f"{', '.join(sorted(set(consumers)))} read{'s' if len(set(consumers)) == 1 else ''} {step}'s output."}
    new = _apply(raw, edits)
    # drop the include of the step when nothing else uses that name
    if not re.search(rf"(?<![.\w]){re.escape(step)}(?![\w])", re.sub(r"(?m)^\s*include\s*\{.*$", "", nf_map._blank(new))):
        new = re.sub(rf"(?m)^[ \t]*include\s*\{{\s*(?:{IDENT}\s+as\s+)?{re.escape(step)}\s*\}}\s*from\s*['\"][^'\"]*['\"][ \t]*\n", "", new)
    return {"ok": True, "step": step, "files": {rel: new}, "before": {rel: raw}, "notes": notes, "consumers": sorted(set(consumers))}


# --------------------------------------------------------------------------- add
def _taken_names(root: Path) -> set[str]:
    names = set()
    for p in root.rglob("*.nf"):
        try:
            t = p.read_text(errors="replace")
        except OSError:
            continue
        names.update(re.findall(rf"(?m)^\s*(?:process|workflow)\s+({IDENT})", t))
        names.update(re.findall(rf"\bas\s+({IDENT})", t))
    return names


def default_name(root: Path, module_id: str) -> str:
    base = re.sub(r"[^A-Z0-9_]", "_", module_id.upper())
    taken = _taken_names(root)
    if base not in taken:
        return base
    i = 2
    while f"{base}_{i}" in taken:
        i += 1
    return f"{base}_{i}"


def plan_add(root: Path, module: dict[str, Any], after: str, output: str, name: str | None = None,
             extra_params: dict[str, str] | None = None) -> dict[str, Any]:
    if module.get("kind") != "module":
        raise HTTPException(400, "Only processing modules can be added as steps")
    m, rel, raw, clean, (a, b) = _workflow(root)
    node = next((n for n in m["nodes"] if n["id"] == after and n["kind"] in ("process", "subworkflow")), None)
    if not node:
        raise HTTPException(400, f"{after} is not a step of the workflow shown on the map")
    shape = (node.get("output_shapes") or {}).get(output)
    if output not in (node.get("outputs") or []):
        raise HTTPException(400, f"{after} has no output “{output}”")
    proc = (name or default_name(root, module["id"])).strip()
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", proc):
        raise HTTPException(400, "Step names are upper case letters, digits and _ (e.g. MACS3_PEAKS)")
    if proc in _taken_names(root):
        raise HTTPException(409, f"{proc} already exists in this pipeline; choose another name")
    per_sample = module.get("scope", "per_sample") == "per_sample"
    warnings: list[str] = []
    if shape in ("path", "val") and per_sample:
        raise HTTPException(400, f"{after}'s “{output}” has no per-sample information, and {module['name']} runs per sample: choose another output")
    if shape == "unknown":
        warnings.append(f"BioCompute could not tell the shape of {after}'s “{output}”; it assumes [sample, files].")
        shape = "tuple"
    inputs = module.get("inputs") or []
    if not inputs:
        raise HTTPException(400, f"{module['name']} takes no input")
    lower = proc.lower()
    extra_params = extra_params or {}
    params_new: dict[str, Any] = {}
    schema_props: dict[str, Any] = {}

    # ---- the process (same contract as Pipeline Studio's generated processes)
    primary = inputs[0]["name"]
    if per_sample:
        in_decl = [f"tuple val(meta), path({primary}, stageAs: 'in_{primary}/*')"]
        expr = f"{after}.out.{output}.map {{ [ it[0], it[1] ] }}"
    else:
        in_decl = [f"path({primary}, stageAs: 'in_{primary}/*')"]
        expr = (f"{after}.out.{output}.map {{ it[1] }}.flatten().collect()" if shape == "tuple"
                else f"{after}.out.{output}.flatten().collect()")
    call_args = [expr]
    for port in inputs[1:]:
        pname = (extra_params.get(port["name"]) or f"{lower}_{port['name']}").strip()
        if not re.fullmatch(r"[a-z][a-z0-9_]*", pname):
            raise HTTPException(400, f"Parameter names are lower case letters, digits and _ ({pname})")
        in_decl.append(f"path({port['name']}, stageAs: 'in_{port['name']}/*')")
        call_args.append(f"Channel.value(file(params.{pname}, checkIfExists: true))")
        params_new[pname] = None
        schema_props[pname] = {"type": "string", "format": "path",
                               "description": f"{module['name']} ({proc}): {port['name']} ({port.get('type', 'file')})"}
        warnings.append(f"Input “{port['name']}” of {proc} comes from the new parameter --{pname} (set it at launch).")
    env = [f"    export BC_IN_{p['name'].upper()}='${{{p['name']} instanceof List ? {p['name']}.join(' ') : {p['name']}}}'" for p in inputs]
    for p in module.get("params") or []:
        key = f"{lower}_{p['name']}"
        params_new[key] = p.get("default")
        prop = {k: p[k] for k in ("type", "description", "enum", "minimum", "maximum") if p.get(k) is not None}
        prop["default"] = p.get("default")
        schema_props[key] = prop
        env.append(f"    export BC_PARAM_{p['name'].upper()}='${{params.{key}}}'")
    out_decl = [("tuple val(meta), " if per_sample else "") + f'path("{_nf_pattern(o["pattern"], per_sample, lower)}"), emit: {o["name"]}'
                for o in module.get("outputs") or []]
    lang = module.get("language", "bash")
    script_name = f"bc_{lower}.{LANG_EXT[lang]}"
    directives = [f'    tag "{"${meta.id}" if per_sample else lower}"', f"    cpus {module.get('cpus', 1)}",
                  f"    memory '{float(module.get('memory_gb', 2)):g} GB'", f"    publishDir \"${{params.outdir}}/{lower}\", mode: 'copy'"]
    if module.get("conda"):
        directives.append(f"    conda '{module['conda']}'")
    if module.get("container"):
        directives.append(f"    container '{module['container']}'")
    prefix = "    export BC_PREFIX='${meta.id}'" if per_sample else f"    export BC_PREFIX='{lower}'"
    process = (f"// Added with BioCompute Pipeline Studio: module “{module['name']}” ({module['id']}).\n"
               f"process {proc} {{\n" + "\n".join(directives)
               + "\n\n    input:\n" + "\n".join(f"    {d}" for d in in_decl)
               + "\n\n    output:\n" + "\n".join(f"    {d}" for d in out_decl)
               + "\n\n    when:\n    task.ext.when == null || task.ext.when"
               + '\n\n    script:\n    """\n' + prefix + "\n    export BC_CPUS='${task.cpus}'\n" + "\n".join(env)
               + f"\n    {LANG_RUN[lang]} ${{projectDir}}/bin/{script_name}\n" + '    """\n}\n')
    mod_rel = f"modules/local/biocompute/{lower}/main.nf"

    # ---- include + call in the workflow file
    stmts = _statements(clean, a, b)
    found = _call(stmts, clean, after)
    if not found:
        raise HTTPException(409, f"Could not find where {after} is called; add the step in the code instead")
    call_st = found[0]
    indent = re.match(r"[ \t]*", raw[call_st["start"]:]).group(0)
    call = f"{indent}{proc} ( {', '.join(call_args)} )  // added in Pipeline Studio\n"
    depth = len(Path(rel).parent.parts)
    inc_path = ("/".join([".."] * depth + [mod_rel]) if depth else f"./{mod_rel}").removesuffix(".nf")
    include = f"include {{ {proc} }} from '{inc_path}'\n"
    last_inc = None
    for mm in re.finditer(r"(?m)^[ \t]*include\s*\{[^}]*\}\s*from\s*['\"][^'\"]*['\"].*$", raw):
        if clean[mm.start():mm.start() + 20].lstrip().startswith("include"):
            last_inc = mm
    edits = [(call_st["end"], call_st["end"], call)]
    if last_inc:
        edits.append((last_inc.end() + 1, last_inc.end() + 1, include))
    else:
        first_wf = re.search(r"(?m)^\s*workflow\b", clean)
        at = first_wf.start() if first_wf else 0
        edits.append((at, at, include + "\n"))
    new_wf = _apply(raw, edits)

    files = {rel: new_wf, mod_rel: process, f"bin/{script_name}": module.get("script", "") if str(module.get("script", "")).endswith("\n") else str(module.get("script", "")) + "\n"}
    before = {rel: raw}

    # ---- parameters
    if params_new:
        nfc = root / "nextflow.config"
        base = nfc.read_text() if nfc.is_file() else ""
        block = "\n// parameters of steps added in BioCompute Pipeline Studio\nparams {\n" + "".join(f"    {k} = {_groovy(v)}\n" for k, v in params_new.items()) + "}\n"
        inc = "includeConfig 'conf/biocompute_steps.config'"
        if inc in base:  # keep the step settings include last
            i = base.index(inc)
            new_cfg = base[:i].rstrip("\n") + "\n" + block + "\n" + base[i:]
        else:
            new_cfg = base.rstrip("\n") + "\n" + block
        files["nextflow.config"] = new_cfg
        before["nextflow.config"] = base
        sch = root / "nextflow_schema.json"
        if sch.is_file():
            try:
                data = json.loads(sch.read_text())
            except ValueError:
                data = None
            if isinstance(data, dict):
                key = "$defs" if "$defs" in data or "definitions" not in data else "definitions"
                defs = data.setdefault(key, {})
                grp = defs.setdefault("biocompute_added_steps", {"title": "Steps added in Pipeline Studio", "type": "object",
                                                                 "fa_icon": "fas fa-plus", "properties": {}})
                grp["properties"].update(schema_props)
                ref = f"#/{key}/biocompute_added_steps"
                all_of = data.setdefault("allOf", [])
                if not any(x.get("$ref") == ref for x in all_of if isinstance(x, dict)):
                    all_of.append({"$ref": ref})
                before["nextflow_schema.json"] = sch.read_text()
                files["nextflow_schema.json"] = json.dumps(data, indent=4) + "\n"
    notes = [f"{proc} runs {module['name']} on {after}'s “{output}”{' (per sample)' if per_sample else ' (all samples together)'}; results go to <outdir>/{lower}."]
    return {"ok": True, "step": proc, "files": files, "before": before, "notes": notes, "warnings": warnings}


def preview(plan: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in plan.items() if k not in ("files", "before")}
    if plan.get("ok"):
        out["diff"] = _diff(plan["before"], plan["files"])
        out["changed_files"] = sorted(plan["files"])
    return out
