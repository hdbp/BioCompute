"""The Nextflow code editor refuses what it cannot rewrite safely, and the map parser survives awkward syntax.

Cases from an independent review: each used to delete or change unrelated code, or mis-read the workflow.
"""
import pytest
from fastapi import HTTPException

from app.services import nf_edit, nf_map

MODS = "".join(f'process {n} {{ input: val x\n output: val x, emit: o\n script: "true" }}\n' for n in "ABCD")


def pipeline(tmp_path, workflow: str):
    (tmp_path / "main.nf").write_text(MODS + "\n" + workflow)
    return tmp_path


def body(tmp_path, text: str):
    return pipeline(tmp_path, "workflow {\n    ch = Channel.of(1)\n    " + text + "\n}\n")


@pytest.mark.parametrize("text, step", [
    ("B(ch); C(B.out.o)", "B"),                   # two statements on one line
    ("def r = A(ch)\n    B(r.out1)", "A"),         # result assigned to a variable
    ("if (params.x) A(ch)\n    B(ch)", "A"),       # one-line if
    ("A(ch)\n    C(A.out[0].collect())", "A"),     # indexed output
])
def test_unsafe_removals_are_refused(tmp_path, text, step):
    d = body(tmp_path, text)
    before = (d / "main.nf").read_text()
    for connect in (False, True):
        with pytest.raises(HTTPException) as e:
            nf_edit.plan_remove(d, step, connect=connect)
        assert e.value.status_code == 409
    assert (d / "main.nf").read_text() == before


def test_connect_is_refused_when_several_outputs_are_read(tmp_path):
    d = body(tmp_path, "A(ch)\n    C(A.out.o, A.out.log)")
    assert nf_edit.plan_remove(d, "A")["ok"] is False
    with pytest.raises(HTTPException):
        nf_edit.plan_remove(d, "A", connect=True)


@pytest.mark.parametrize("text", [
    "if (params.a &&\n        params.b) {\n        A(ch)\n        B(ch)\n    }",   # header over two lines
    "if (params.x)\n    {\n        A(ch)\n        B(ch)\n    }\n    C(ch)",         # brace on its own line
])
def test_removal_inside_an_if_block_keeps_the_rest(tmp_path, text):
    d = body(tmp_path, text)
    m = nf_map.build_map(d)
    assert next(n for n in m["nodes"] if n["id"] == "A")["condition"]  # the map shows the condition
    new = nf_edit.plan_remove(d, "A")["files"]["main.nf"]
    assert "A(ch)" not in new and "B(ch)" in new and new.count("{") == new.count("}")
    assert ("C(ch)" in new) == ("C(ch)" in text)


def test_adding_after_a_one_line_if_is_refused(tmp_path):
    from app.services.studio_modules import MODULES
    d = pipeline(tmp_path, 'process P { input: tuple val(meta), path(x)\n output: tuple val(meta), path("*.bam"), emit: bam\n script: "true" }\n'
                           "workflow {\n    ch = Channel.of(1)\n    if (params.x) P(ch)\n}\n")
    with pytest.raises(HTTPException):
        nf_edit.plan_add(d, next(m for m in MODULES if m["id"] == "macs3"), "P", "bam")


def test_map_parser_on_awkward_syntax(tmp_path):
    def ids(wf):
        m = nf_map.build_map(pipeline(tmp_path, wf))
        return m["workflow"], [n["id"] for n in m["nodes"]], {e["id"] for e in m["edges"]}

    # pipe syntax
    assert ids("workflow {\n    Channel.fromPath(params.input) | A | map { it } | B\n}\n") == ("(entry workflow)", ["params:input", "A", "B"], {"params:input->A", "A->B"})
    # a quote inside a regex literal must not swallow the rest of the file
    wf, nodes, edges = ids("workflow {\n    ch = Channel.of(1).map { f -> f.name.replaceAll(/'/, '') }\n    A(ch)\n    B(A.out.o)\n}\nworkflow OTHER {\n    C(1)\n}\n")
    assert (wf, nodes, edges) == ("(entry workflow)", ["A", "B"], {"A->B"})
    # quotes and braces inside ${...}
    wf, nodes, edges = ids('workflow {\n    x = "${params.a ? "on {" : "off"}"\n    A(Channel.of(x))\n    B(A.out.o)\n}\nworkflow OTHER {\n    C(1)\n}\n')
    assert (wf, nodes, edges) == ("(entry workflow)", ["A", "B"], {"A->B"})
    # an include path with dots keeps its name
    (tmp_path / "tool_2.7.10a.nf").write_text(MODS)
    (tmp_path / "main.nf").write_text("include { A } from './tool_2.7.10a'\nworkflow {\n    A(Channel.of(1))\n}\n")
    assert nf_map.build_map(tmp_path)["nodes"][0]["file"] == "tool_2.7.10a.nf"
