"""A read-only map of a Nextflow DSL2 pipeline, read statically from its code (nothing is executed).

The map shows the steps (processes and subworkflows) one workflow calls and how channels flow between them:
an edge A -> B means B is called with something derived from A's output. It is an approximation of what
`nextflow` itself would build: dynamic channel logic (closures choosing between outputs, `.branch` used
much later, etc.) can hide or add an edge, so the UI labels it as read from the code.
"""
from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path
from typing import Any

MAX_FILES = 3000
MAX_BYTES = 2_000_000
IDENT = r"[A-Za-z_][A-Za-z0-9_]*"


def _regex_start(src: str, i: int) -> bool:
    """A `/` opens a regex literal when an expression is expected there (after `(`, `,`, `=`, `~`, ...)."""
    if i + 1 >= len(src) or src[i + 1] in "/* \n=":
        return False
    k = i - 1
    while k >= 0 and src[k] in " \t":
        k -= 1
    return k < 0 or src[k] in "(,=~[!&|?:{;\n"


def _blank(src: str) -> str:
    """Comments removed and string contents replaced by spaces; same length, so offsets stay valid."""
    out = list(src)
    i, n = 0, len(src)

    def blank(a: int, b: int) -> None:
        for k in range(a, min(b, n)):
            if out[k] != "\n":
                out[k] = " "

    while i < n:
        c = src[i]
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            blank(i, j)
            i = j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            blank(i, j)
            i = j
        elif src.startswith('"""', i) or src.startswith("'''", i):
            q = src[i:i + 3]
            j = src.find(q, i + 3)
            j = n if j < 0 else j
            blank(i + 3, j)
            i = j + 3
        elif c in "\"'":
            j = i + 1
            while j < n and src[j] != c and src[j] != "\n":
                if src[j] == "\\":
                    j += 2
                elif c == '"' and src.startswith("${", j):
                    # "${cond ? "a {" : "b"}": the interpolation may hold quotes and braces of its own
                    depth, j = 1, j + 2
                    while j < n and depth and src[j] != "\n":
                        depth += (src[j] == "{") - (src[j] == "}")
                        j += 1
                else:
                    j += 1
            blank(i + 1, j)
            i = j + 1
        elif c == "/" and _regex_start(src, i):
            # a slashy string / regex literal such as replaceAll(/'/, ''): its quotes are not string starts
            j = i + 1
            while j < n and src[j] != "/" and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            if j < n and src[j] == "/":
                blank(i + 1, j)
                i = j + 1
            else:
                i += 1
        else:
            i += 1
    return "".join(out)


def _block(text: str, open_at: int) -> tuple[int, int]:
    """(start, end) of the body of the {...} block whose '{' is at open_at."""
    depth = 0
    for k in range(open_at, len(text)):
        if text[k] == "{":
            depth += 1
        elif text[k] == "}":
            depth -= 1
            if depth == 0:
                return open_at + 1, k
    return open_at + 1, len(text)


class _File:
    def __init__(self, path: Path, rel: str):
        self.path, self.rel = path, rel
        self.raw = path.read_text(errors="replace")
        self.text = _blank(self.raw)
        self.processes: dict[str, dict[str, Any]] = {}
        self.workflows: dict[str, tuple[int, int]] = {}  # "" = the entry workflow
        self.includes: dict[str, tuple[str, str]] = {}  # local name -> (original name, resolved rel path)
        for m in re.finditer(rf"(?m)^\s*process\s+({IDENT})\s*\{{", self.text):
            a, b = _block(self.text, m.end() - 1)
            self.processes[m.group(1)] = _process_info(self.raw[a:b], self.text[a:b])
        for m in re.finditer(rf"(?m)^\s*workflow(?:\s+({IDENT}))?\s*\{{", self.text):
            self.workflows[m.group(1) or ""] = _block(self.text, m.end() - 1)
        for m in re.finditer(r"include\s*\{([^}]*)\}\s*from\s*(['\"])(.*?)\2", self.raw):
            if self.text[m.start():m.start() + 7] != "include":  # inside a comment or string
                continue
            target = m.group(3)
            for part in re.split(r"[;\n]", m.group(1)):
                mm = re.match(rf"\s*({IDENT})(?:\s+as\s+({IDENT}))?\s*$", part)
                if mm:
                    self.includes[mm.group(2) or mm.group(1)] = (mm.group(1), target)


def _process_info(raw: str, clean: str) -> dict[str, Any]:
    info: dict[str, Any] = {"outputs": [], "container": None, "label": None,
                            # nf-core modules honour these, so a config can switch the step off or change its arguments
                            "supports_when": "task.ext.when" in raw, "supports_args": "task.ext.args" in raw}
    m = re.search(r"(?m)^\s*output:\s*$", clean)
    if m:
        end = re.search(r"(?m)^\s*(when|script|shell|exec|stub|input):\s*$", clean[m.end():])
        sect = raw[m.end(): m.end() + end.start() if end else len(raw)]
        info["outputs"] = list(dict.fromkeys(re.findall(rf"emit:\s*({IDENT})", sect)))
        # per output: "tuple" ([meta, files], per sample) or "path"/"val" (no sample information)
        info["output_shapes"] = {e: ("tuple" if ln.strip().startswith("tuple") else ln.strip().split("(")[0].split()[0])
                                 for ln in sect.splitlines() for e in re.findall(rf"emit:\s*({IDENT})", ln)}
    m = re.search(r"(?m)^\s*container\s+(.+)$", raw)
    if m:
        names = re.findall(r"(?:biocontainers/|depot\.galaxyproject\.org/singularity/|/)([a-z0-9][a-z0-9_.-]*?)[:@]", m.group(1))
        info["container"] = names[0] if names else None
    m = re.search(r"(?m)^\s*label\s+['\"]([^'\"]+)['\"]", raw)
    info["label"] = m.group(1) if m else None
    return info


def _resolve(base: Path, root: Path, target: str) -> str | None:
    if target.startswith("plugin/"):
        return None
    p = (base.parent / target)
    for cand in (p, p if p.name.endswith(".nf") else p.with_name(p.name + ".nf"), p / "main.nf"):
        try:
            if cand.is_file():
                return str(cand.resolve().relative_to(root.resolve()))
        except ValueError:
            return None
    return None


def _if_header(s: str) -> tuple[str, str] | None:
    """For a line starting with `if (` whose parentheses close on it: (condition, text after the `)`)."""
    m = re.match(r"^\}?\s*(?:else\s+)?if\s*\(", s)
    if not m:
        return None
    depth = 0
    for k in range(m.end() - 1, len(s)):
        if s[k] == "(":
            depth += 1
        elif s[k] == ")":
            depth -= 1
            if depth == 0:
                return s[m.end():k], s[k + 1:].strip()
    return None


def _statements(body: str):
    """(statement text, condition stack) for each top-level statement of a workflow body.

    The `if` header may span several lines, and its `{` may be on the next line.
    """
    lines = body.split("\n")
    conds: list[str] = []
    buf: list[str] = []
    depth = 0
    hdr: list[str] = []   # lines of an `if (` header that is not closed yet
    hdr_depth = 0
    allman: str | None = None  # condition of an `if (...)` whose `{` is expected on the next line

    def open_if(first: str, cond: str) -> None:
        if first.lstrip().startswith("}") and conds:
            conds.pop()
        conds.append(cond.strip())

    for line in lines:
        s = line.strip()
        if hdr:
            hdr.append(s)
            hdr_depth += s.count("(") - s.count(")")
            if hdr_depth <= 0:
                text = " ".join(hdr)
                m = re.match(r"^\}?\s*(?:else\s+)?if\s*\((.*)\)\s*(\{)?\s*$", text)
                cond = m.group(1) if m else text
                if m and m.group(2):
                    open_if(hdr[0], cond)
                else:
                    allman = cond
                    if hdr[0].lstrip().startswith("}") and conds:
                        conds.pop()
                hdr, hdr_depth = [], 0
            continue
        if not buf:
            if not s:
                continue
            if allman is not None:
                cond, allman = allman, None
                if s == "{":
                    conds.append(cond.strip())
                    continue
            m = re.match(r"^\}?\s*(else\s+)?if\s*\((.*)\)\s*\{$", s)
            if m:
                open_if(s, m.group(2))
                continue
            if re.match(r"^\}?\s*else\s*\{$", s):
                prev = conds.pop() if conds else ""
                conds.append(f"not ({prev})" if prev else "else")
                continue
            if s == "}":
                if conds:
                    conds.pop()
                continue
            mh = re.match(r"^\}?\s*(else\s+)?if\s*\(", s)
            if mh:
                d = s.count("(") - s.count(")")
                if d > 0:
                    hdr, hdr_depth = [s], d
                    continue
                cond, rest = _if_header(s) or ("", "")
                if not rest:
                    allman = cond
                    if s.startswith("}") and conds:
                        conds.pop()
                    continue
                # `if (x) CALL(...)` on one line: the call is conditional
                yield "\x00" + rest, [*conds, cond.strip()]
                continue
            if re.match(r"^(take|main|emit|publish):$", s):
                yield s, list(conds)
                continue
        buf.append(s)
        depth += sum(s.count(c) for c in "([{") - sum(s.count(c) for c in ")]}")
        if depth <= 0:
            depth = 0
            # a following line starting with "." continues this statement (merged in _merge_chains)
            yield "\x00" + " ".join(buf), list(conds)
            buf = []
    if buf:
        yield "\x00" + " ".join(buf), list(conds)


def _merge_chains(stmts):
    out: list[tuple[str, list[str]]] = []
    for text, conds in stmts:
        if text.startswith("\x00"):
            text = text[1:]
            if text.startswith(".") and out and not out[-1][0].endswith(":"):
                out[-1] = (out[-1][0] + " " + text, out[-1][1])
                continue
        out.append((text, conds))
    return out


def _split_pipes(text: str) -> list[str]:
    """Top-level `|` separators of a statement (not `||`, not inside brackets or closures)."""
    parts, depth, cur = [], 0, ""
    k = 0
    while k < len(text):
        ch = text[k]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "|" and depth == 0:
            if text[k:k + 2] == "||":
                cur += "||"
                k += 2
                continue
            parts.append(cur)
            cur = ""
        else:
            cur += ch
        k += 1
    parts.append(cur)
    return parts


def build_map(pipeline_dir: str | Path) -> dict[str, Any]:
    root = Path(pipeline_dir)
    main = root / "main.nf"
    if not main.is_file():
        return {"ok": False, "reason": "No main.nf in this pipeline"}
    files: dict[str, _File] = {}
    total = 0
    for p in sorted(root.rglob("*.nf")):
        rel = str(p.relative_to(root))
        if any(part in ("work", "tests", "test") or part.startswith(".") for part in p.relative_to(root).parts[:-1]):
            continue
        if len(files) >= MAX_FILES or total > MAX_BYTES * 20:
            break
        try:
            if p.stat().st_size > MAX_BYTES:
                continue
            files[rel] = _File(p, rel)
            total += p.stat().st_size
        except OSError:
            continue

    def kind_of(rel: str | None, name: str) -> str | None:
        f = files.get(rel or "")
        if not f:
            return None
        if name in f.processes:
            return "process"
        if name in f.workflows:
            return "workflow"
        return None

    def scope(f: _File) -> dict[str, dict[str, Any]]:
        """Components callable from file f: local name -> {kind, name, file}."""
        comps = {n: {"kind": "process", "name": n, "file": f.rel, **f.processes[n]} for n in f.processes}
        comps.update({n: {"kind": "workflow", "name": n, "file": f.rel} for n in f.workflows if n})
        for local, (orig, target) in f.includes.items():
            rel = _resolve(f.path, root, target)
            k = kind_of(rel, orig)
            if k == "process":
                comps[local] = {"kind": "process", "name": orig, "file": rel, **files[rel].processes[orig]}
            elif k == "workflow":
                comps[local] = {"kind": "workflow", "name": orig, "file": rel}
            elif rel is None and not target.startswith("plugin/"):
                comps[local] = {"kind": "process", "name": orig, "file": None, "outputs": []}
        return comps

    # the workflow to show: the one in main.nf or workflows/ that calls the most steps
    cands = []
    for rel, f in files.items():
        if rel == "main.nf" or rel.startswith("workflows/"):
            comps = scope(f)
            for wname, (a, b) in f.workflows.items():
                n = len({c for c in re.findall(rf"(?<![.\w])({IDENT})\s*\(", f.text[a:b]) if c in comps})
                cands.append((n, rel == "main.nf" and wname == "", rel, wname))
    if not cands:
        return {"ok": False, "reason": "No workflow block found in main.nf"}
    cands.sort(key=lambda c: (c[0], c[1]), reverse=True)
    _, _, rel, wname = cands[0]
    f = files[rel]
    comps = scope(f)
    a, b = f.workflows[wname]
    stmts = _merge_chains(_statements(f.text[a:b]))

    nodes: dict[str, dict[str, Any]] = {}
    edges: set[tuple[str, str]] = set()
    var_src: dict[str, set[str]] = defaultdict(set)
    section = "main"

    def input_node(nid: str, label: str, detail: str) -> str:
        nodes.setdefault(nid, {"id": nid, "kind": "input", "label": label, "detail": detail})
        return nid

    for text, conds in stmts:
        if re.fullmatch(r"(take|main|emit|publish):", text):
            section = text[:-1]
            continue
        if section == "take":
            for v in re.findall(rf"^\s*({IDENT})\s*$", text):
                var_src[v].add(input_node(f"take:{v}", v, f"input of workflow {wname}"))
            continue
        if section in ("emit", "publish"):
            continue
        def refs_of(t: str) -> set[str]:
            found: set[str] = set()
            for c in re.findall(rf"(?<![.\w])({IDENT})\.out\b", t):
                if c in comps:
                    found.add(c)
            for v in re.findall(rf"(?<![.\w])({IDENT})\b", t):
                if v in var_src:
                    found |= var_src[v]
            for pm in re.findall(rf"(?:fromPath|fromFilePairs|fromSamplesheet|file|files|samplesheetToList)\s*\(\s*params\.({IDENT})", t):
                found.add(input_node(f"params:{pm}", f"params.{pm}", "file or folder given at launch"))
            return found

        # pipe syntax: Channel.of(..) | A | map { .. } | B   (each step reads the one before it)
        segs = _split_pipes(text)
        if len(segs) > 1:
            head = re.match(rf"^(?:def\s+)?({IDENT})\s*=(?!=)\s*", segs[0])
            carry = refs_of(segs[0][head.end():] if head else segs[0])
            first = re.match(rf"^\s*({IDENT})\s*(?:\(.*\))?\s*$", segs[0][head.end():] if head else segs[0], re.S)
            chain = [first.group(1)] if first and first.group(1) in comps else []
            if chain:
                carry = set(carry) - {chain[0]}
            for seg in ([None] if chain else []) + segs[1:]:
                name = chain[0] if seg is None else (re.match(rf"^\s*({IDENT})\s*(?:\(.*\))?\s*$", seg, re.S) or [None, None])[1]
                if name in comps:
                    info = comps[name]
                    if info["kind"] == "workflow" and "steps" not in info:
                        info.update(_sub_info(files.get(info.get("file") or ""), info["name"], scope))
                    nodes.setdefault(name, {
                        "id": name, "kind": "subworkflow" if info["kind"] == "workflow" else "process", "label": name,
                        "name": info["name"], "file": info.get("file"), "outputs": info.get("outputs", []),
                        "container": info.get("container"), "resource_label": info.get("label"), "steps": info.get("steps"),
                        "step_info": info.get("step_info"), "supports_when": bool(info.get("supports_when")),
                        "output_shapes": info.get("output_shapes") or {}, "supports_args": bool(info.get("supports_args")),
                        "condition": " and ".join(conds) if conds else None,
                    })
                    for r in carry:
                        if r != name:
                            edges.add((r, name))
                    carry = {name}
                elif seg is not None:
                    carry |= refs_of(seg)
            if head:
                var_src[head.group(1)] |= carry
            continue
        refs = refs_of(text)
        calls = [c for c in re.findall(rf"(?<![.\w])({IDENT})\s*\(", text) if c in comps]
        target = re.match(rf"^(?:def\s+)?({IDENT})\s*=(?!=)", text)
        sets = re.findall(rf"\.set\s*\{{\s*({IDENT})\s*\}}", text)
        for c in dict.fromkeys(calls):
            info = comps[c]
            if info["kind"] == "workflow" and "steps" not in info:
                info.update(_sub_info(files.get(info.get("file") or ""), info["name"], scope))
            node = nodes.setdefault(c, {
                "id": c, "kind": "subworkflow" if info["kind"] == "workflow" else "process", "label": c,
                "name": info["name"], "file": info.get("file"), "outputs": info.get("outputs", []),
                "container": info.get("container"), "resource_label": info.get("label"), "steps": info.get("steps"),
                "step_info": info.get("step_info"), "supports_when": bool(info.get("supports_when")),
                "output_shapes": info.get("output_shapes") or {},
                "supports_args": bool(info.get("supports_args")),
                "condition": " and ".join(conds) if conds else None,
            })
            if conds and node.get("condition") is None:
                node["condition"] = " and ".join(conds)
            for r in refs:
                if r != c:
                    edges.add((r, c))
            refs_after = {c}
            for v in ([target.group(1)] if target else []) + sets:
                var_src[v] |= refs_after
        if not calls:
            for v in ([target.group(1)] if target else []) + sets:
                var_src[v] |= refs  # ch_x = ch_x.mix(...) keeps the earlier sources too

    # ignore input nodes nothing reads
    used = {s for s, _ in edges} | {t for _, t in edges}
    nodes = {k: v for k, v in nodes.items() if v["kind"] != "input" or k in used}
    edges = {(s, t) for s, t in edges if s in nodes and t in nodes}
    _layout(nodes, edges)
    return {
        "ok": True, "workflow": wname or "(entry workflow)", "file": rel,
        "nodes": list(nodes.values()),
        "edges": [{"id": f"{s}->{t}", "source": s, "target": t} for s, t in sorted(edges)],
        "files_read": len(files),
    }


def _sub_info(f: "_File | None", name: str, scope) -> dict[str, Any]:
    """Emitted channels and the steps a subworkflow calls (one level)."""
    if not f or name not in f.workflows:
        return {"outputs": [], "steps": [], "step_info": [], "output_shapes": {}}
    a, b = f.workflows[name]
    body = f.text[a:b]
    emit = re.search(r"(?m)^\s*emit:\s*$", body)
    outputs = re.findall(rf"(?m)^\s*({IDENT})\s*=", body[emit.end():]) if emit else []
    main = body[:emit.start()] if emit else body
    comps = scope(f)
    steps = [c for c in dict.fromkeys(re.findall(rf"(?<![.\w])({IDENT})\s*\(", main)) if c in comps]
    shapes = {}
    for o in outputs:
        m = re.search(rf"(?m)^\s*{o}\s*=\s*({IDENT})\.out\.({IDENT})", body[emit.end():]) if emit else None
        if m and m.group(1) in comps:
            shapes[o] = (comps[m.group(1)].get("output_shapes") or {}).get(m.group(2), "unknown")
        else:
            shapes[o] = "unknown"
    info = [{"id": c, "name": comps[c]["name"], "kind": comps[c]["kind"], "file": comps[c].get("file"),
             "supports_when": bool(comps[c].get("supports_when")), "supports_args": bool(comps[c].get("supports_args")),
             "container": comps[c].get("container"), "resource_label": comps[c].get("label")} for c in steps]
    return {"outputs": outputs, "steps": steps, "step_info": info, "output_shapes": shapes}


def _layout(nodes: dict[str, dict[str, Any]], edges: set[tuple[str, str]]) -> None:
    """Layered left-to-right layout: column = longest path from a node without inputs."""
    preds: dict[str, set[str]] = defaultdict(set)
    for s, t in edges:
        preds[t].add(s)
    depth: dict[str, int] = {}

    def d(n: str, seen: frozenset = frozenset()) -> int:
        if n in depth:
            return depth[n]
        if n in seen:
            return 0
        depth[n] = 1 + max((d(p, seen | {n}) for p in preds[n]), default=-1)
        return depth[n]

    order = list(nodes)  # call order in the code
    cols: dict[int, list[str]] = defaultdict(list)
    for n in order:
        cols[d(n)].append(n)
    for c, ns in cols.items():
        for i, n in enumerate(ns):
            nodes[n]["position"] = {"x": c * 280, "y": i * 110 - (len(ns) - 1) * 55}
