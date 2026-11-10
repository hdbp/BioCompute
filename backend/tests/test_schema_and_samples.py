import json
from pathlib import Path

from app.services import nfschema, samplesheet

FIX = Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIX / name).read_text())


def test_normalize_nfcore_chipseq_draft07():
    form = nfschema.normalize(load("nfcore_chipseq_schema.json"))
    assert form["has_schema"]
    ids = [g["id"] for g in form["groups"]]
    assert ids[0] == "input_output_options"
    fields = {f["name"]: f for g in form["groups"] for f in g["fields"]}
    assert fields["input"]["widget"] == "file" and fields["input"]["required"]
    assert fields["outdir"]["widget"] == "directory"
    assert any(f["widget"] == "toggle" for f in fields.values())
    assert any(f["widget"] == "select" for f in fields.values())
    assert any(f["hidden"] for f in fields.values())


def test_normalize_nfcore_rnaseq():
    schema = load("nfcore_rnaseq_schema.json")
    form = nfschema.normalize(schema)
    fields = {f["name"]: f for g in form["groups"] for f in g["fields"]}
    assert "aligner" in fields and fields["aligner"]["enum"]
    issues = nfschema.validate_params(schema, {"input": "/x.csv", "outdir": "/o", "aligner": "not-an-aligner"})
    assert any(i["field"] == "aligner" and i["level"] == "error" for i in issues)
    ok = nfschema.validate_params(schema, {"input": "/x.csv", "outdir": "/o", "aligner": fields["aligner"]["enum"][0]})
    assert not [i for i in ok if i["level"] == "error"]


def test_required_and_unknown_params():
    schema = load("nfcore_chipseq_schema.json")
    issues = nfschema.validate_params(schema, {"made_up_param": 1})
    assert any(i["field"] == "outdir" for i in issues)
    assert any(i["field"] == "made_up_param" and i["level"] == "warning" for i in issues)


def test_input_columns_and_rows():
    sch = load("nfcore_chipseq_schema_input.json")
    cols = {c["name"]: c for c in nfschema.input_columns(sch)}
    assert {"sample", "fastq_1", "fastq_2", "replicate", "antibody", "control"} <= set(cols)
    rows = [{"sample": "A", "fastq_1": "/a_R1.fastq.gz", "fastq_2": "", "replicate": 1, "antibody": "H3K4me3", "control": ""},
            {"sample": "B C", "fastq_1": "/b.txt", "replicate": 1}]
    issues = nfschema.validate_rows(sch, rows)
    assert any(i["row"] == 0 and i["field"] == "control" for i in issues)  # dependentRequired
    assert any(i["row"] == 1 and i["field"] == "sample" for i in issues)
    assert any(i["row"] == 1 and i["field"] == "fastq_1" for i in issues)


def test_detect_pairs():
    paths = [
        "raw:run/A_S1_L001_R1_001.fastq.gz", "raw:run/A_S1_L001_R2_001.fastq.gz",
        "raw:run/A_S1_L002_R1_001.fastq.gz", "raw:run/A_S1_L002_R2_001.fastq.gz",
        "raw:run/B_1.fq.gz", "raw:run/B_2.fq.gz",
        "raw:run/C.fastq.gz",
        "raw:run/D_R2.fastq.gz",
        "raw:run/notes.txt",
    ]
    res = samplesheet.detect_pairs(paths)
    by = {s["sample_id"]: s for s in res["samples"]}
    assert len(by["A"]["runs"]) == 2 and by["A"]["paired"]
    assert by["B"]["runs"][0]["fastq_2"].endswith("B_2.fq.gz")
    assert by["C"]["paired"] is False
    assert "raw:run/notes.txt" in res["unmatched"]
    assert any("R2 without matching R1" in w for w in res["warnings"])


def test_parse_table_detects_delimiter():
    cols, rows = samplesheet.parse_table("a\tb\n1\t2\n")
    assert cols == ["a", "b"] and rows == [{"a": "1", "b": "2"}]


def test_manifest_parsing_handles_nfcore_quotes():
    from app.services.pipelines import parse_nextflow_config

    cfg = (
        "manifest {\n"
        "    name            = 'nf-core/chipseq'\n"
        '    description     = """ChIP-seq peak-calling and differential analysis pipeline."""\n'
        "    version         = '2.1.0'\n"
        "}\n"
        "profiles {\n"
        "    docker {\n        docker.enabled = true\n    }\n"
        "    test { includeConfig 'conf/test.config' }\n"
        "}\n"
    )
    m = parse_nextflow_config(cfg)
    assert m["name"] == "nf-core/chipseq" and m["version"] == "2.1.0"
    assert m["description"] == "ChIP-seq peak-calling and differential analysis pipeline."
    assert {"docker", "test"} <= set(m["profiles"])
