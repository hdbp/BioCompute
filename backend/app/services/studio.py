"""Pipeline Studio: graph validation and code generation.

Supported graph subset (documented in docs/pipeline-studio.md):

* Sources: one *samplesheet* node (per-sample FASTQ reads) and any number of
  *parameter file* nodes (reference genome, index, GTF...).
* Modules are ``per_sample`` (one task per sample) or ``aggregate`` (one task over all
  samples). A per-sample module's per-sample inputs are joined by sample id; inputs from
  aggregate modules or parameter files are broadcast as value channels.
* Aggregate modules collect (flatten + collect) their inputs; ports marked ``multiple``
  accept several incoming edges which are mixed.
* Fan-out (branches) is unrestricted; the graph must be acyclic.

Not supported (rejected by validation): cycles, aggregate inputs feeding per-sample
ports *as joined data*, multiple samplesheets, unconnected required inputs. Arbitrary
Nextflow scripts cannot be imported back into a graph.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict, deque
from typing import Any

from ..config import get_settings
from .studio_modules import MODULE_INDEX, PORT_TYPES

LANG_EXT = {"bash": "sh", "python": "py", "r": "R"}
LANG_RUN = {"bash": "bash", "python": "python3", "r": "Rscript"}


class Graph:
    def __init__(self, graph: dict[str, Any]):
        self.nodes: dict[str, dict[str, Any]] = {n["id"]: n for n in graph.get("nodes", [])}
        self.edges: list[dict[str, Any]] = graph.get("edges", [])
        self.specs: dict[str, dict[str, Any]] = {}
        self.issues: list[dict[str, Any]] = []
        for nid, n in self.nodes.items():
            spec = self._spec(n)
            if spec:
                self.specs[nid] = spec

    def issue(self, level: str, message: str, node: str | None = None, edge: str | None = None):
        self.issues.append({"level": level, "message": message, "node": node, "edge": edge})

    def _spec(self, n: dict[str, Any]) -> dict[str, Any] | None:
        d = n.get("data") or {}
        base = MODULE_INDEX.get(d.get("module", ""))
        if not base:
            self.issue("error", f"Unknown module '{d.get('module')}'", n["id"])
            return None
        spec = json.loads(json.dumps(base))
        custom = d.get("custom") or {}
        for key in ("script", "language", "scope", "inputs", "outputs", "tools", "conda", "container"):
            if key in custom and custom[key] not in (None, ""):
                spec[key] = custom[key]
        if d.get("script"):
            spec["script"] = d["script"]
        spec["label"] = d.get("label") or spec["name"]
        spec["param_values"] = {p["name"]: (d.get("params") or {}).get(p["name"], p.get("default")) for p in spec.get("params", [])}
        spec["cpus"] = int(d.get("cpus") or spec.get("cpus") or 1)
        spec["memory_gb"] = float(d.get("memory_gb") or spec.get("memory_gb") or 1)
        spec["publish"] = d.get("publish", True)
        spec["env"] = d.get("env") or ("container" if spec.get("container") else "conda" if spec.get("conda") else "system")
        if base["id"] == "input_file":
            ft = spec["param_values"].get("file_type") or "any"
            spec["outputs"] = [{"name": "file", "type": ft}]
        return spec

    # ------------------------------------------------------------------ helpers
    def out_port(self, nid: str, handle: str | None) -> dict[str, Any] | None:
        name = (handle or "").removeprefix("out:")
        return next((p for p in self.specs.get(nid, {}).get("outputs", []) if p["name"] == name), None)

    def in_port(self, nid: str, handle: str | None) -> dict[str, Any] | None:
        name = (handle or "").removeprefix("in:")
        return next((p for p in self.specs.get(nid, {}).get("inputs", []) if p["name"] == name), None)

    def kind(self, nid: str) -> str:
        return self.specs[nid]["kind"]

    def scope(self, nid: str) -> str:
        s = self.specs[nid]
        if s["kind"] == "source":
            return "per_sample" if s["id"] == "input_samplesheet" else "value"
        return s.get("scope", "per_sample")

    def topo(self) -> list[str]:
        indeg = {n: 0 for n in self.specs}
        adj = defaultdict(list)
        for e in self.edges:
            if e["source"] in indeg and e["target"] in indeg:
                adj[e["source"]].append(e["target"])
                indeg[e["target"]] += 1
        q = deque(sorted(n for n, d in indeg.items() if d == 0))
        order = []
        while q:
            n = q.popleft()
            order.append(n)
            for m in adj[n]:
                indeg[m] -= 1
                if indeg[m] == 0:
                    q.append(m)
        if len(order) != len(indeg):
            self.issue("error", "The workflow contains a cycle - loops are not supported")
        return order

    def incoming(self, nid: str) -> dict[str, list[dict[str, Any]]]:
        res: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for e in self.edges:
            if e["target"] == nid:
                res[(e.get("targetHandle") or "").removeprefix("in:")].append(e)
        return res


def proc_names(g: Graph, order: list[str]) -> dict[str, str]:
    names: dict[str, str] = {}
    used: set[str] = set()
    for nid in order:
        base = re.sub(r"[^A-Z0-9]+", "_", g.specs[nid]["label"].upper()).strip("_") or "STEP"
        if base[0].isdigit():
            base = "P_" + base
        name, i = base, 2
        while name in used:
            name = f"{base}_{i}"
            i += 1
        used.add(name)
        names[nid] = name
    return names


def validate(graph: dict[str, Any]) -> dict[str, Any]:
    g = Graph(graph)
    order = g.topo()
    samplesheets = [n for n, s in g.specs.items() if s["id"] == "input_samplesheet"]
    if len(samplesheets) > 1:
        g.issue("error", "Only one samplesheet input is supported")
    modules = [n for n, s in g.specs.items() if s["kind"] == "module"]
    if not modules:
        g.issue("error", "Add at least one processing module")
    for e in g.edges:
        if e["source"] not in g.specs or e["target"] not in g.specs:
            g.issue("error", "Edge references a missing node", edge=e.get("id"))
            continue
        op, ip = g.out_port(e["source"], e.get("sourceHandle")), g.in_port(e["target"], e.get("targetHandle"))
        if not op or not ip:
            g.issue("error", "Edge connects unknown ports", edge=e.get("id"))
            continue
        if not (op["type"] == ip["type"] or ip["type"] == "any" or op["type"] == "any"):
            g.issue("error", f"Type mismatch: {op['type']} → {ip['type']} ({g.specs[e['source']]['label']} → {g.specs[e['target']]['label']})", edge=e.get("id"))
        if g.scope(e["target"]) == "per_sample" and g.specs[e["target"]]["kind"] == "module" and g.scope(e["source"]) == "aggregate":
            g.issue("info", f"{g.specs[e['source']]['label']} output is broadcast to every sample of {g.specs[e['target']]['label']}", edge=e.get("id"))
    if not get_settings().allow_custom_code_modules:
        for n, s in g.specs.items():
            if s.get("custom"):
                g.issue("error", "Custom code modules are disabled by the administrator", n)
    for nid in modules:
        s = g.specs[nid]
        inc = g.incoming(nid)
        for port in s.get("inputs", []):
            edges = inc.get(port["name"], [])
            if not edges:
                g.issue("error", f"Input '{port['name']}' of {s['label']} is not connected", nid)
            elif len(edges) > 1 and not port.get("multiple"):
                g.issue("error", f"Input '{port['name']}' of {s['label']} accepts a single connection", nid)
        if s.get("scope") == "per_sample":
            joined = [e for p in s.get("inputs", []) for e in inc.get(p["name"], []) if g.scope(e["source"]) == "per_sample"]
            if not joined:
                g.issue("error", f"{s['label']} is per-sample but receives no per-sample data", nid)
            for p in s.get("inputs", []):
                srcs = {g.scope(e["source"]) for e in inc.get(p["name"], [])}
                if len(srcs) > 1:
                    g.issue("error", f"Input '{p['name']}' of {s['label']} mixes per-sample and broadcast data", nid)
                if p.get("multiple") and "per_sample" in srcs and len(inc.get(p["name"], [])) > 1:
                    g.issue("error", f"Per-sample input '{p['name']}' of {s['label']} cannot merge several branches; use an aggregate module", nid)
        for o in s.get("outputs", []):
            if not o.get("pattern"):
                g.issue("error", f"Output '{o['name']}' of {s['label']} has no file pattern", nid)
            elif "/" in o["pattern"] or ".." in o["pattern"]:
                g.issue("error", f"Output pattern of {s['label']} must be a file name pattern", nid)
        if s.get("language") not in LANG_EXT:
            g.issue("error", f"Unsupported script language '{s.get('language')}'", nid)
    connected = {e["source"] for e in g.edges} | {e["target"] for e in g.edges}
    for nid, s in g.specs.items():
        if nid not in connected and len(g.specs) > 1:
            g.issue("warning", f"{s['label']} is not connected", nid)
    for nid, s in g.specs.items():
        if s["id"] == "input_file":
            pn = s["param_values"].get("param_name") or ""
            if not re.fullmatch(r"[a-z][a-z0-9_]*", pn):
                g.issue("error", "Parameter names must be lowercase snake_case", nid)
    errors = sum(1 for i in g.issues if i["level"] == "error")
    return {"valid": errors == 0, "issues": g.issues, "order": order}


# --------------------------------------------------------------------------- codegen
def _param_key(proc: str, p: str) -> str:
    return f"{proc.lower()}_{p}"


def _nf_pattern(pattern: str, per_sample: bool, prefix_lit: str) -> str:
    return pattern.replace("{prefix}", "${meta.id}" if per_sample else prefix_lit)


def compile_graph(graph: dict[str, Any], name: str, description: str = "") -> dict[str, Any]:
    v = validate(graph)
    if not v["valid"]:
        return {"files": {}, **v}
    g = Graph(graph)
    order = g.topo()
    names = proc_names(g, order)
    files: dict[str, str] = {}
    params: dict[str, Any] = {"input": None, "outdir": "results"}
    schema_groups: dict[str, Any] = {
        "input_output_options": {
            "title": "Input/output options", "type": "object", "fa_icon": "fas fa-terminal",
            "required": ["outdir"], "properties": {
                "input": {"type": "string", "format": "file-path", "mimetype": "text/csv", "schema": "assets/schema_input.json",
                          "pattern": "^\\S+\\.(csv|tsv)$", "description": "Samplesheet (sample, fastq_1, fastq_2, condition, replicate)", "fa_icon": "fas fa-file-csv"},
                "outdir": {"type": "string", "format": "directory-path", "description": "Output directory", "fa_icon": "fas fa-folder-open"},
            }}}
    has_sheet = any(g.specs[n]["id"] == "input_samplesheet" for n in order)
    if has_sheet:
        schema_groups["input_output_options"]["required"].insert(0, "input")
    requires: set[str] = set()
    procs_nf: list[str] = []
    wf: list[str] = []
    steps: list[dict[str, Any]] = []
    emit_ref: dict[tuple[str, str], str] = {}  # (node, port) -> channel expression
    bc_ref: dict[tuple[str, str], str] = {}  # (node, port) -> bcflow token

    for nid in order:
        s = g.specs[nid]
        proc = names[nid]
        if s["id"] == "input_samplesheet":
            wf.append(
                "    ch_rows = Channel.fromPath(params.input, checkIfExists: true)\n"
                "        .splitCsv(header: true, sep: params.input.endsWith('.tsv') ? '\\t' : ',')\n"
                "        .map { row ->\n"
                "            def meta = [id: row.sample, condition: row.condition ?: '', replicate: row.replicate ?: '']\n"
                "            def reads = row.fastq_2 ? [file(row.fastq_1, checkIfExists: true), file(row.fastq_2, checkIfExists: true)]\n"
                "                                    : [file(row.fastq_1, checkIfExists: true)]\n"
                "            [ meta, reads ]\n"
                "        }\n"
                "        .groupTuple()\n"
                "        .branch { meta, reads -> single: reads.size() == 1; multiple: true }\n"
                "    BC_MERGE_LANES( ch_rows.multiple )\n"
                "    ch_reads = ch_rows.single.map { meta, reads -> [ meta, reads.flatten() ] }.mix( BC_MERGE_LANES.out.reads )")
            procs_nf.append(MERGE_LANES_NF)
            emit_ref[(nid, "reads")] = "ch_reads"
            bc_ref[(nid, "reads")] = "{sample.reads}"
            continue
        if s["id"] == "input_file":
            pn = s["param_values"]["param_name"]
            fmt = s["param_values"].get("format") or "file-path"
            params[pn] = None
            schema_groups.setdefault("reference_options", {"title": "Reference files", "type": "object",
                                                           "fa_icon": "fas fa-dna", "required": [], "properties": {}})
            schema_groups["reference_options"]["properties"][pn] = {"type": "string", "format": fmt,
                                                                    "description": f"{s['label']} ({PORT_TYPES.get(s['outputs'][0]['type'], {}).get('label', 'file')})"}
            schema_groups["reference_options"]["required"].append(pn)
            wf.append(f"    ch_{pn} = Channel.value(file(params.{pn}, checkIfExists: true))")
            emit_ref[(nid, "file")] = f"ch_{pn}"
            bc_ref[(nid, "file")] = "{params." + pn + "}"
            continue
        if s["kind"] == "sink":
            continue
        # ----------------------------------------------------------- module
        per_sample = s.get("scope", "per_sample") == "per_sample"
        lang = s.get("language", "bash")
        script_name = f"bc_{proc.lower()}.{LANG_EXT[lang]}"
        files[f"bin/{script_name}"] = s["script"] if s["script"].endswith("\n") else s["script"] + "\n"
        requires.update(s.get("tools", []))
        requires.add(LANG_RUN[lang])
        inc = g.incoming(nid)
        publish = s["publish"] or any(g.specs[e["target"]]["kind"] == "sink" for e in g.edges if e["source"] == nid)
        pdir = proc.lower()
        # module parameters
        group = {"title": s["label"], "type": "object", "fa_icon": "fas fa-cog", "properties": {}}
        env_lines = []
        bc_env: dict[str, str] = {}
        for p in s.get("params", []):
            key = _param_key(proc, p["name"])
            params[key] = s["param_values"].get(p["name"])
            prop = {k: p[k] for k in ("type", "description", "enum", "minimum", "maximum") if k in p}
            prop["default"] = params[key]
            group["properties"][key] = prop
            env_lines.append(f"    export BC_PARAM_{p['name'].upper()}='${{params.{key}}}'")
            bc_env[f"BC_PARAM_{p['name'].upper()}"] = "{params." + key + "}"
        if group["properties"]:
            schema_groups[f"{proc.lower()}_options"] = group
        # inputs
        joined: list[tuple[str, list[dict]]] = []
        values: list[tuple[str, list[dict]]] = []
        for port in s.get("inputs", []):
            es = inc.get(port["name"], [])
            if per_sample and es and g.scope(es[0]["source"]) == "per_sample":
                joined.append((port["name"], es))
            else:
                values.append((port["name"], es))
        in_decl, call_args = [], []
        if per_sample:
            in_decl.append("tuple val(meta), " + ", ".join(f"path({n}, stageAs: 'in_{n}/*')" for n, _ in joined))
            first, *rest = joined
            expr = emit_ref[(first[1][0]["source"], first[1][0]["sourceHandle"].removeprefix("out:"))]
            for n, es in rest:
                expr += f".join({emit_ref[(es[0]['source'], es[0]['sourceHandle'].removeprefix('out:'))]})"
            call_args.append(expr)
        for n, es in values:
            in_decl.append(f"path({n}, stageAs: 'in_{n}/*')")
            parts = []
            for e in es:
                src = e["source"]
                ref = emit_ref[(src, e["sourceHandle"].removeprefix("out:"))]
                parts.append(f"{ref}.map {{ it[1] }}" if g.scope(src) == "per_sample" else ref)
            expr = parts[0] + "".join(f".mix({p})" for p in parts[1:])
            if per_sample:
                expr = f"{expr}.collect()" if all(g.scope(e["source"]) != "value" for e in es) else expr
            else:
                expr = f"{expr}.flatten().collect()" if any(g.scope(e["source"]) != "value" for e in es) else expr
            call_args.append(expr)
        for n, es in joined + values:
            env_lines.append(f"    export BC_IN_{n.upper()}='${{{n} instanceof List ? {n}.join(' ') : {n}}}'")
            tokens = []
            for e in es:
                src, port = e["source"], e["sourceHandle"].removeprefix("out:")
                if g.specs[src]["kind"] == "module":
                    tokens.append(("{steps.%s.%s}" if per_sample else "{each:%s.%s}") % (names[src], port))
                elif g.specs[src]["id"] == "input_samplesheet" and not per_sample:
                    tokens.append("{each:samples.reads}")
                else:
                    tokens.append(bc_ref[(src, port)])
            bc_env[f"BC_IN_{n.upper()}"] = " ".join(tokens)
        # outputs
        out_decl = []
        bc_outputs = {}
        for o in s.get("outputs", []):
            pat = _nf_pattern(o["pattern"], per_sample, pdir)
            out_decl.append(("tuple val(meta), " if per_sample else "") + f'path("{pat}"), emit: {o["name"]}')
            emit_ref[(nid, o["name"])] = f"{proc}.out.{o['name']}"
            bc_outputs[o["name"]] = o["pattern"].replace("{prefix}", "{sample.id}" if per_sample else pdir)
        directives = [f'    tag "{"${meta.id}" if per_sample else proc.lower()}"', f"    cpus {s['cpus']}", f"    memory '{s['memory_gb']:g} GB'"]
        if publish:
            directives.append(f"    publishDir \"${{params.outdir}}/{pdir}\", mode: 'copy'")
        if s.get("conda"):
            directives.append(f"    conda '{s['conda']}'")
        if s.get("container"):
            directives.append(f"    container '{s['container']}'")
        prefix_line = "    export BC_PREFIX='${meta.id}'" if per_sample else f"    export BC_PREFIX='{pdir}'"
        procs_nf.append(
            f"process {proc} {{\n" + "\n".join(directives) + "\n\n    input:\n" + "\n".join(f"    {d}" for d in in_decl)
            + "\n\n    output:\n" + "\n".join(f"    {d}" for d in out_decl)
            + '\n\n    script:\n    """\n' + prefix_line + "\n    export BC_CPUS='${task.cpus}'\n" + "\n".join(env_lines)
            + f"\n    {LANG_RUN[lang]} ${{projectDir}}/bin/{script_name}\n" + '    """\n}\n')
        wf.append(f"    {proc}( {', '.join(call_args)} )")
        after = sorted({names[e["source"]] for es in inc.values() for e in es if e["source"] in names and g.specs[e["source"]]["kind"] == "module"},
                       key=lambda x: list(names.values()).index(x))
        steps.append({"id": proc, "scope": "per_sample" if per_sample else "aggregate", "after": after, "cpus": s["cpus"],
                      "command": [LANG_RUN[lang], "{bin}/" + script_name],
                      "env": {"BC_PREFIX": "{sample.id}" if per_sample else pdir, "BC_CPUS": "{task.cpus}", **bc_env},
                      "outputs": bc_outputs, "publish": pdir if publish else None, "label": s["label"]})

    header = (f"#!/usr/bin/env nextflow\n/*\n * {name}\n * Generated by BioCompute Pipeline Studio. {description}\n"
              " * Edit the graph in Pipeline Studio and re-export rather than editing this file by hand.\n */\n"
              "nextflow.enable.dsl = 2\n\n")
    files["main.nf"] = header + "\n".join(procs_nf) + "\nworkflow {\n" + "\n".join(wf) + "\n}\n"
    cfg_params = "\n".join(f"    {k} = {_groovy(v)}" for k, v in params.items())
    files["nextflow.config"] = (
        f"manifest {{\n    name = '{_esc(name)}'\n    description = '{_esc(description)}'\n    version = '1.0.0'\n"
        "    nextflowVersion = '>=23.04.0'\n    mainScript = 'main.nf'\n}\n\n"
        f"params {{\n{cfg_params}\n}}\n\n"
        "profiles {\n    docker { docker.enabled = true }\n    apptainer { apptainer.enabled = true; apptainer.autoMounts = true }\n"
        "    singularity { singularity.enabled = true; singularity.autoMounts = true }\n    conda { conda.enabled = true }\n}\n")
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema", "title": f"{name} pipeline parameters",
        "description": description or "Generated by BioCompute Pipeline Studio", "type": "object",
        "$defs": schema_groups, "allOf": [{"$ref": f"#/$defs/{k}"} for k in schema_groups]}
    files["nextflow_schema.json"] = json.dumps(schema, indent=2) + "\n"
    files["assets/schema_input.json"] = json.dumps(SAMPLESHEET_SCHEMA, indent=2) + "\n"
    files["bcflow.json"] = json.dumps({"engine": "bcflow", "name": name, "version": "1.0.0",
                                       "requires": sorted(requires), "steps": [{k: v for k, v in st.items() if v is not None} for st in steps],
                                       "outputs": [{"name": st["label"], "path": st["publish"]} for st in steps if st.get("publish")]}, indent=2) + "\n"
    return {"files": files, **v}


MERGE_LANES_NF = """process BC_MERGE_LANES {
    // Concatenate lanes / technical runs of one sample (nf-core CAT_FASTQ semantics).
    // Files are referenced in place (val), which requires them to be visible to the executor.
    tag "${meta.id}"
    cpus 1
    memory '1 GB'

    input:
    tuple val(meta), val(reads)

    output:
    tuple val(meta), path("${meta.id}_R*.merged.fastq*"), emit: reads

    script:
    def r1 = reads.collect { it[0] }.join(' ')
    def r2 = reads.every { it.size() > 1 } ? reads.collect { it[1] }.join(' ') : ''
    def ext = reads[0][0].name.endsWith('.gz') ? '.gz' : ''
    \"\"\"
    cat ${r1} > ${meta.id}_R1.merged.fastq${ext}
    ${r2 ? "cat ${r2} > ${meta.id}_R2.merged.fastq${ext}" : ''}
    \"\"\"
}
"""


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("'", "\\'")


def _groovy(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + _esc(str(v)) + "'"


SAMPLESHEET_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Samplesheet", "type": "array",
    "items": {"type": "object", "required": ["sample", "fastq_1"], "properties": {
        "sample": {"type": "string", "pattern": "^\\S+$", "errorMessage": "Sample name must not contain spaces", "meta": ["id"]},
        "fastq_1": {"type": "string", "format": "file-path", "exists": True, "pattern": "^\\S+\\.f(ast)?q(\\.gz)?$",
                    "errorMessage": "FASTQ file for read 1 must end in .fastq(.gz) or .fq(.gz)"},
        "fastq_2": {"type": "string", "format": "file-path", "exists": True, "pattern": "^(\\S+\\.f(ast)?q(\\.gz)?)?$",
                    "errorMessage": "FASTQ file for read 2 must end in .fastq(.gz) or .fq(.gz)"},
        "condition": {"type": "string", "meta": ["condition"]},
        "replicate": {"type": "integer", "minimum": 1, "meta": ["replicate"]}}}}
