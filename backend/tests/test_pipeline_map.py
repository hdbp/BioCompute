"""Pipeline maps: the Studio graph of each published version, and maps read from Nextflow code."""
import shutil
from pathlib import Path

from conftest import RAW
from test_ownership import _login as login_as
from test_studio import QC_GRAPH, edge

FIXTURE = Path(__file__).parent / "fixtures" / "nfcore_like"


def test_studio_versions_keep_their_graph(client, auth):
    w = client.post("/api/studio/workflows", headers=auth, json={"name": "Map QC", "graph": QC_GRAPH}).json()
    v1 = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth).json()
    pid = v1["pipeline_id"]
    m1 = client.get(f"/api/pipelines/{pid}/map", headers=auth).json()
    assert m1["kind"] == "studio" and m1["studio"]["exact"] and m1["studio"]["can_edit"]
    assert m1["studio"]["next_version"] == "v2" and m1["studio"]["workflow_id"] == w["id"]
    assert {n["id"] for n in m1["studio"]["graph"]["nodes"]} == {"in", "sub", "st", "rep", "out"}

    # change the workflow (drop subsampling) and publish again: v2 has the new graph, v1 keeps the old one
    g2 = {"nodes": [n for n in QC_GRAPH["nodes"] if n["id"] != "sub"],
          "edges": [e for e in QC_GRAPH["edges"] if "sub" not in (e["source"], e["target"])] + [edge("in", "reads", "st", "reads")]}
    assert client.put(f"/api/studio/workflows/{w['id']}", headers=auth, json={"name": "Map QC", "graph": g2}).status_code == 200
    v2 = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth).json()
    assert v2["pipeline_id"] == pid and v2["version"] == "v2"
    d = client.get(f"/api/pipelines/{pid}", headers=auth).json()
    ids = {v["version"]: v["id"] for v in d["versions"]}
    old = client.get(f"/api/pipelines/{pid}/map", params={"version_id": ids["v1"]}, headers=auth).json()
    new = client.get(f"/api/pipelines/{pid}/map", params={"version_id": ids["v2"]}, headers=auth).json()
    assert "sub" in {n["id"] for n in old["studio"]["graph"]["nodes"]}
    assert "sub" not in {n["id"] for n in new["studio"]["graph"]["nodes"]}
    assert new["studio"]["next_version"] == "v3"


def test_copy_of_someone_elses_studio_pipeline_is_editable(client, auth):
    w = client.post("/api/studio/workflows", headers=auth, json={"name": "Shared QC map", "graph": QC_GRAPH}).json()
    client.put(f"/api/studio/workflows/{w['id']}/visibility", headers=auth, json={"visibility": "lab"})
    pid = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth).json()["pipeline_id"]
    other = login_as(client, auth, "mapper")
    m = client.get(f"/api/pipelines/{pid}/map", headers=other).json()
    assert m["kind"] == "studio" and not m["studio"]["can_edit"] and m["studio"]["can_view_workflow"]
    cp = client.post(f"/api/pipelines/{pid}/duplicate", headers=other, json={"name": "My QC map", "visibility": "private"})
    assert cp.status_code == 200, cp.text
    cm = client.get(f"/api/pipelines/{cp.json()['id']}/map", headers=other).json()
    assert cm["kind"] == "studio" and cm["studio"]["can_edit"] and cm["studio"]["workflow_id"] != w["id"]
    # the copy's workflow publishes as v2 of the copy
    r = client.post(f"/api/studio/workflows/{cm['studio']['workflow_id']}/publish", headers=other).json()
    assert r["pipeline_id"] == cp.json()["id"] and r["version"] == "v2"


def test_nextflow_map_read_from_code(client, auth):
    shutil.copytree(FIXTURE, RAW / "nfcore_like", dirs_exist_ok=True)
    p = client.post("/api/pipelines/import/local", headers=auth, json={"path": "raw:nfcore_like", "name": "Demo map"})
    assert p.status_code == 200, p.text
    m = client.get(f"/api/pipelines/{p.json()['id']}/map", headers=auth).json()
    assert m["kind"] == "nextflow"
    nf = m["nextflow"]
    assert nf["workflow"] == "DEMO" and nf["file"] == "workflows/demo.nf"
    nodes = {n["id"]: n for n in nf["nodes"]}
    assert set(nodes) == {"take:ch_samplesheet", "FASTQC", "TRIMGALORE", "FASTQC_TRIMMED", "BOWTIE2_ALIGN", "BAM_SORT_STATS", "MULTIQC"}
    assert nodes["FASTQC_TRIMMED"]["name"] == "FASTQC" and nodes["TRIMGALORE"]["condition"] == "!params.skip_trimming"
    assert nodes["BAM_SORT_STATS"]["kind"] == "subworkflow" and nodes["BAM_SORT_STATS"]["steps"] == ["SAMTOOLS_SORT", "SAMTOOLS_STATS"]
    assert nodes["FASTQC"]["container"] == "fastqc" and "zip" in nodes["FASTQC"]["outputs"]
    edges = {(e["source"], e["target"]) for e in nf["edges"]}
    assert {("TRIMGALORE", "BOWTIE2_ALIGN"), ("take:ch_samplesheet", "BOWTIE2_ALIGN"), ("BOWTIE2_ALIGN", "BAM_SORT_STATS"),
            ("BAM_SORT_STATS", "MULTIQC"), ("FASTQC", "MULTIQC"), ("FASTQC_TRIMMED", "MULTIQC")} <= edges
    assert not any(t == "FASTQC" and s == "MULTIQC" for s, t in edges)
    assert all("position" in n for n in nf["nodes"])


def test_bundled_example_map(client, auth):
    pl = client.get("/api/pipelines", headers=auth).json()
    qc = next(x for x in pl if x["slug"] == "biocompute-fastq-qc")
    m = client.get(f"/api/pipelines/{qc['id']}/map", headers=auth).json()
    assert m["kind"] == "nextflow"
    assert {(e["source"], e["target"]) for e in m["nextflow"]["edges"]} >= {("params:input", "FASTQ_STATS"), ("FASTQ_STATS", "QC_REPORT")}
