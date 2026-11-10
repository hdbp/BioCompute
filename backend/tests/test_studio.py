from conftest import wait_for_run

from app.services import studio


def node(id, module, **data):
    return {"id": id, "type": "module", "position": {"x": 0, "y": 0}, "data": {"module": module, **data}}


def edge(src, sh, tgt, th, id=None):
    return {"id": id or f"{src}-{tgt}-{th}", "source": src, "sourceHandle": f"out:{sh}", "target": tgt, "targetHandle": f"in:{th}"}


QC_GRAPH = {
    "nodes": [node("in", "input_samplesheet"), node("sub", "subsample", params={"reads": 50}),
              node("st", "fastq_stats", label="Read stats"), node("rep", "summary_report", params={"title": "Studio QC"}),
              node("out", "output_results")],
    "edges": [edge("in", "reads", "sub", "reads"), edge("sub", "reads", "st", "reads"), edge("st", "stats", "rep", "tables"),
              edge("rep", "html", "out", "results")],
}

CHIP_GRAPH = {
    "nodes": [node("in", "input_samplesheet"), node("idx", "input_file", params={"param_name": "bowtie2_index", "file_type": "index", "format": "directory-path"}),
              node("qc", "fastqc"), node("trim", "fastp"), node("aln", "bowtie2"), node("flt", "bam_filter"), node("peaks", "macs3"),
              node("mqc", "multiqc")],
    "edges": [edge("in", "reads", "qc", "reads"), edge("in", "reads", "trim", "reads"), edge("trim", "reads", "aln", "reads"),
              edge("idx", "file", "aln", "index"), edge("aln", "bam", "flt", "bam"), edge("flt", "bam", "peaks", "bam"),
              edge("qc", "zip", "mqc", "reports"), edge("trim", "json", "mqc", "reports"), edge("aln", "log", "mqc", "reports"),
              edge("peaks", "xls", "mqc", "reports")],
}


def test_validation_catches_errors():
    g = {"nodes": [node("in", "input_samplesheet"), node("a", "bowtie2")], "edges": [edge("in", "reads", "a", "reads")]}
    v = studio.validate(g)
    assert not v["valid"] and any("index" in i["message"] for i in v["issues"])
    g = {"nodes": [node("in", "input_samplesheet"), node("m", "macs3")], "edges": [edge("in", "reads", "m", "bam")]}
    assert any("Type mismatch" in i["message"] for i in studio.validate(g)["issues"])
    g = {"nodes": [node("a", "merge_tables"), node("b", "merge_tables")],
         "edges": [edge("a", "merged", "b", "tables"), edge("b", "merged", "a", "tables")]}
    assert any("cycle" in i["message"] for i in studio.validate(g)["issues"])


def test_chipseq_graph_compiles_to_dsl2():
    res = studio.compile_graph(CHIP_GRAPH, "chip test")
    assert res["valid"], res["issues"]
    nf = res["files"]["main.nf"]
    for proc in ("FASTQC", "FASTP_TRIMMING", "BOWTIE2_ALIGNMENT", "FILTER_ALIGNMENTS", "MACS3_PEAK_CALLING", "MULTIQC"):
        assert f"process {proc} {{" in nf
    assert "BOWTIE2_ALIGNMENT( FASTP_TRIMMING.out.reads, ch_bowtie2_index )" in nf
    assert ".mix(" in nf and ".flatten().collect()" in nf
    assert "container 'quay.io/biocontainers/macs3" in nf
    import json

    schema = json.loads(res["files"]["nextflow_schema.json"])
    assert "bowtie2_index" in schema["$defs"]["reference_options"]["properties"]
    assert "macs3_peak_calling_qvalue" in schema["$defs"]["macs3_peak_calling_options"]["properties"]
    man = json.loads(res["files"]["bcflow.json"])
    assert [s["id"] for s in man["steps"]][-1] == "MULTIQC"


def test_publish_and_run_studio_pipeline(client, auth):
    w = client.post("/api/studio/workflows", headers=auth, json={"name": "Studio QC", "graph": QC_GRAPH}).json()
    r = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth)
    assert r.status_code == 200, r.text
    pid = r.json()["pipeline_id"]
    form = client.get(f"/api/pipeline-schemas/{pid}", headers=auth).json()
    names = {f["name"] for g in form["form"]["groups"] for f in g["fields"]}
    assert {"input", "outdir", "subsample_reads_reads", "summary_report_title"} <= names
    exps = client.get("/api/experiments", headers=auth).json()
    exp = next(e for e in exps if e["sample_count"] == 5)
    run = client.post("/api/runs", headers=auth, json={"pipeline_id": pid, "engine": "bcflow", "experiment_id": exp["id"],
                                                      "output_dir": "results:studio1", "params": {}}).json()
    assert "id" in run, run
    done = wait_for_run(client, auth, run["id"])
    assert done["status"] == "completed", client.get(f"/api/runs/{run['id']}/log", headers=auth).json()["content"][-2000:]
    files = client.get(f"/api/results/{run['id']}", params={"path": "summary_report"}, headers=auth).json()
    assert {e["name"] for e in files["entries"]} == {"summary.html", "summary.tsv"}
    tsv = client.get(f"/api/results/{run['id']}/file", params={"path": "summary_report/summary.tsv"}, headers=auth).json()["content"]
    # subsample to 50 reads per file: each data row reports 50 reads
    assert all(line.split("\t")[2] == "50" for line in tsv.strip().splitlines()[1:])
    # republish -> new version of the same pipeline
    r2 = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth).json()
    assert r2["pipeline_id"] == pid and r2["version"] == "v2"


def test_export_zip(client, auth):
    r = client.post("/api/studio/export", headers=auth, json={"name": "chip", "graph": CHIP_GRAPH})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
