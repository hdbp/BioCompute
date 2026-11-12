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


def test_edit_as_new_pipeline_never_touches_the_original(client, auth):
    # Studio pipeline: the copy is a new workflow; publishing it makes a separate pipeline
    w = client.post("/api/studio/workflows", headers=auth, json={"name": "Fork QC", "graph": QC_GRAPH}).json()
    pid = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth).json()["pipeline_id"]
    f = client.post(f"/api/pipelines/{pid}/fork", headers=auth, json={"name": "Fork QC (mine)"}).json()
    assert f["kind"] == "studio" and f["workflow_id"] != w["id"]
    new = client.post(f"/api/studio/workflows/{f['workflow_id']}/publish", headers=auth).json()
    assert new["pipeline_id"] != pid and new["version"] == "v1"
    assert len(client.get(f"/api/pipelines/{pid}", headers=auth).json()["versions"]) == 1  # original unchanged

    # Nextflow pipeline: files copied into a new pipeline; edits are new versions of the copy
    shutil.copytree(FIXTURE, RAW / "nfcore_fork", dirs_exist_ok=True)
    orig = client.post("/api/pipelines/import/local", headers=auth, json={"path": "raw:nfcore_fork", "name": "Fork demo"}).json()
    orig_dir = Path(client.get(f"/api/pipelines/{orig['id']}", headers=auth).json()["versions"][0]["path"])
    before = (orig_dir / "workflows/demo.nf").read_text()
    # the original cannot be edited, even by its owner
    assert not client.get(f"/api/pipelines/{orig['id']}/files", headers=auth).json()["editable"]
    v0 = client.get(f"/api/pipelines/{orig['id']}", headers=auth).json()["versions"][0]["id"]
    r = client.post(f"/api/pipelines/{orig['id']}/files", headers=auth, json={"base_version_id": v0, "changes": {"main.nf": "x"}})
    assert r.status_code == 403

    c = client.post(f"/api/pipelines/{orig['id']}/fork", headers=auth, json={"name": "Fork demo (no trimming)"}).json()
    assert c["kind"] == "nextflow"
    cid = c["pipeline_id"]
    files = client.get(f"/api/pipelines/{cid}/files", headers=auth).json()
    assert files["editable"] and any(x["path"] == "workflows/demo.nf" and x["text"] for x in files["files"])
    src = client.get(f"/api/pipelines/{cid}/files/content", params={"path": "workflows/demo.nf"}, headers=auth).text
    assert src == before
    edited = src.replace("if (!params.skip_trimming) {", "if (false) {")
    s = client.post(f"/api/pipelines/{cid}/files", headers=auth, json={
        "base_version_id": files["version_id"], "changes": {"workflows/demo.nf": edited, "bin/helper.sh": "#!/bin/sh\necho hi\n"}}).json()
    assert s["version"] == "v2"
    d = client.get(f"/api/pipelines/{cid}", headers=auth).json()
    paths = {v["version"]: Path(v["path"]) for v in d["versions"]}
    assert (paths["v2"] / "workflows/demo.nf").read_text() == edited
    assert (paths["v1"] / "workflows/demo.nf").read_text() == before  # earlier version of the copy kept
    assert (paths["v2"] / "bin/helper.sh").stat().st_mode & 0o111
    assert (orig_dir / "workflows/demo.nf").read_text() == before  # original untouched
    m = client.get(f"/api/pipelines/{cid}/map", headers=auth).json()
    assert m["can_edit_code"] and m["copy_of"].startswith("fork-demo")
    assert next(n for n in m["nextflow"]["nodes"] if n["id"] == "TRIMGALORE")["condition"] == "false"

    # paths outside the pipeline are refused
    for bad in ("../escape.nf", "/etc/passwd", "work/x", "a/../../b"):
        r = client.post(f"/api/pipelines/{cid}/files", headers=auth, json={"base_version_id": s["version_id"], "changes": {bad: "x"}})
        assert r.status_code == 400, bad
    assert client.get(f"/api/pipelines/{cid}/files/content", params={"path": "../../../etc/passwd"}, headers=auth).status_code == 400
    # a link pointing out of the pipeline is not written through
    v2 = paths["v2"]
    (v2 / "outlink").symlink_to(RAW)
    r = client.post(f"/api/pipelines/{cid}/files", headers=auth, json={"base_version_id": s["version_id"], "changes": {"outlink/evil.txt": "x"}})
    assert r.status_code == 400 and not (RAW / "evil.txt").exists()


def test_step_settings_on_the_map_are_a_config_on_a_new_version(client, auth):
    shutil.copytree(FIXTURE, RAW / "nfcore_steps", dirs_exist_ok=True)
    orig = client.post("/api/pipelines/import/local", headers=auth, json={"path": "raw:nfcore_steps", "name": "Steps demo"}).json()
    o = client.get(f"/api/pipelines/{orig['id']}/steps", headers=auth).json()
    assert not o["editable"]
    # what the pipeline already sets, per step (including steps inside subworkflows)
    cur = o["current"]
    assert cur["FASTQC"][0]["selector"] == ".*:FASTQC" and cur["FASTQC"][0]["settings"]["ext.args"] == "'--quiet'"
    assert cur["FASTQC_TRIMMED"][0]["selector"] == ".*:FASTQC_TRIMMED"  # one alternative of 'A|B', not both
    assert "SAMTOOLS_SORT" in cur and cur["SAMTOOLS_SORT"] == []
    r = client.post(f"/api/pipelines/{orig['id']}/steps", headers=auth, json={"base_version_id": o["version_id"], "overrides": {"FASTQC": {"enabled": False}}})
    assert r.status_code == 403

    cid = client.post(f"/api/pipelines/{orig['id']}/fork", headers=auth, json={"name": "Steps demo (mine)"}).json()["pipeline_id"]
    c = client.get(f"/api/pipelines/{cid}/steps", headers=auth).json()
    assert c["editable"] and c["overrides"] == {}
    bad = client.post(f"/api/pipelines/{cid}/steps", headers=auth, json={"base_version_id": c["version_id"], "overrides": {"NOPE": {"enabled": False}}})
    assert bad.status_code == 400
    for wrong in ({"memory": "lots"}, {"cpus": "x"}, {"container": "a b"}, {"args": "a\nb"}):
        assert client.post(f"/api/pipelines/{cid}/steps", headers=auth, json={"base_version_id": c["version_id"], "overrides": {"FASTQC": wrong}}).status_code == 400
    s = client.post(f"/api/pipelines/{cid}/steps", headers=auth, json={"base_version_id": c["version_id"], "overrides": {
        "TRIMGALORE": {"enabled": False},
        "FASTQC": {"args": "--nogroup --kmers 7 'quoted'", "cpus": 4, "memory": "8 GB", "time": "2h", "container": "quay.io/biocontainers/fastqc:0.12.1--hdfd78af_0"},
        "SAMTOOLS_SORT": {"memory": "16 GB"}}}).json()
    assert s["version"] == "v2"
    paths = {v["version"]: Path(v["path"]) for v in client.get(f"/api/pipelines/{cid}", headers=auth).json()["versions"]}
    conf = (paths["v2"] / "conf/biocompute_steps.config").read_text()
    assert "withName: '.*:FASTQC' {  // FASTQC" in conf and "ext.args = '--nogroup --kmers 7 \\'quoted\\''" in conf
    assert "withName: 'NFCORE_DEMO:DEMO:TRIMGALORE' {  // TRIMGALORE" in conf and "ext.when = false" in conf
    assert "withName: '(.*:)?SAMTOOLS_SORT' {" in conf and "memory = '16 GB'" in conf
    assert "cpus = 4" in conf and "container = 'quay.io/biocontainers/fastqc:0.12.1--hdfd78af_0'" in conf
    nfc = (paths["v2"] / "nextflow.config").read_text()
    assert nfc.rstrip().endswith("includeConfig 'conf/biocompute_steps.config'") and nfc.count("biocompute_steps.config") == 1
    assert not (paths["v1"] / "conf/biocompute_steps.config").exists()  # earlier version untouched
    assert not (RAW / "nfcore_steps/conf/biocompute_steps.config").exists()  # original untouched
    again = client.get(f"/api/pipelines/{cid}/steps", headers=auth).json()
    assert again["overrides"]["TRIMGALORE"] == {"enabled": False} and again["overrides"]["FASTQC"]["cpus"] == 4
    # saving again on v2 keeps a single include line
    s3 = client.post(f"/api/pipelines/{cid}/steps", headers=auth, json={"base_version_id": s["version_id"], "overrides": {}}).json()
    p3 = {v["version"]: Path(v["path"]) for v in client.get(f"/api/pipelines/{cid}", headers=auth).json()["versions"]}[s3["version"]]
    assert (p3 / "nextflow.config").read_text().count("biocompute_steps.config") == 1
