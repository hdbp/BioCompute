"""Reference genomes from an existing refgenie setup (fixture built with the real refgenie 0.13 CLI)."""
import shutil
from pathlib import Path

import pytest

from conftest import _TMP, wait_for_run
from test_studio import edge, node

FIXTURE = Path(__file__).parent / "fixtures" / "refgenie"


@pytest.fixture(scope="module")
def refgenie_config(client, auth):
    root = _TMP / "refgenie"
    if root.exists():
        shutil.rmtree(root)
    shutil.copytree(FIXTURE, root, symlinks=True)
    cfg = root / "genomes" / "genome_config.yaml"
    cfg.write_text(cfg.read_text().replace("@ROOT@", str(root)))
    st = client.put("/api/references/config", headers=auth, json={"config": str(cfg)}).json()
    assert st["ok"], st
    yield cfg
    client.put("/api/references/config", headers=auth, json={"config": None})


def test_existing_setup_is_read_as_is(client, auth, refgenie_config):
    before = refgenie_config.read_text()
    st = client.get("/api/references/status", headers=auth).json()
    assert st["genomes"] == 1 and st["assets"] == 3 and st["found_by"] == "Settings" and st["data_folder"] == "refgenie"
    g = client.get("/api/references/genomes", headers=auth).json()
    toy = next(x for x in g if x["name"] == "toy")
    assets = {a["name"]: a for a in toy["assets"]}
    assert set(assets) == {"fasta", "gencode_gtf", "bowtie2_index"}
    assert all(t["exists"] for a in assets.values() for t in a["tags"])  # including the bowtie2 prefix
    assert set(assets["fasta"]["tags"][0]["seek_keys"]) >= {"fasta", "fai", "chrom_sizes"}
    assert assets["bowtie2_index"]["default_tag"] == "v2.5"
    # the genome folder is browsable as a read-only data folder
    roots = {r["name"]: r for r in client.get("/api/datasets/roots", headers=auth).json()}
    assert roots["refgenie"]["writable"] is False
    assert client.get("/api/datasets/browse", params={"path": "refgenie:"}, headers=auth).status_code == 200
    assert refgenie_config.read_text() == before  # nothing written


def test_references_resolve_with_digests(client, auth, refgenie_config):
    r = client.get("/api/references/resolve", params={"uri": "refgenie://toy/fasta.fai"}, headers=auth).json()
    assert r["path"].endswith("toy.fa.fai") and r["tag"] == "default" and len(r["genome_digest"]) == 48 and r["asset_digest"]
    b = client.get("/api/references/resolve", params={"uri": "refgenie://toy/bowtie2_index"}, headers=auth).json()
    assert b["tag"] == "v2.5" and b["path"].endswith("/toy")  # index prefix, as aligners expect
    d = client.get("/api/references/resolve", params={"uri": "refgenie://toy/bowtie2_index.dir:v2.5"}, headers=auth).json()
    assert Path(d["path"]).is_dir()
    for bad in ("refgenie://nope/fasta", "refgenie://toy/star_index", "refgenie://toy/fasta:v9", "hg38/fasta"):
        assert client.get("/api/references/resolve", params={"uri": bad}, headers=auth).status_code == 400, bad
    s = client.post("/api/references/suggest", headers=auth, json={"genome": "toy", "fields": [
        {"name": "fasta", "widget": "file"}, {"name": "bowtie2_index", "widget": "directory"},
        {"name": "gtf", "widget": "file"}, {"name": "star_index", "widget": "directory"}, {"name": "outdir", "widget": "directory"}]}).json()
    assert s == {"fasta": "refgenie://toy/fasta", "bowtie2_index": "refgenie://toy/bowtie2_index.dir", "gtf": "refgenie://toy/gencode_gtf"}
    bg = client.get("/api/references/browser-genome", params={"genome": "toy"}, headers=auth).json()
    assert bg["fasta"].startswith("refgenie:") and bg["fai"].endswith(".fai") and bg["annotation"]


def test_run_resolves_reference_and_records_digest(client, auth, refgenie_config):
    mod = {"id": "u_ref_head", "name": "Reference head", "scope": "aggregate", "language": "bash",
           "inputs": [{"name": "ref", "type": "fasta"}], "outputs": [{"name": "head", "type": "table", "pattern": "ref_head.txt"}],
           "script": 'set -euo pipefail\nhead -c 5 "$BC_IN_REF" > ref_head.txt\n'}
    assert client.post("/api/studio/modules", headers=auth, json=mod).status_code == 200
    graph = {"nodes": [node("in", "input_samplesheet", params={"fastq_folder": "raw:run1"}),
                       node("ref", "input_file", params={"param_name": "genome_fasta", "file_type": "fasta",
                                                         "default_path": "refgenie://toy/fasta"}),
                       node("h", "u_ref_head"), node("st", "fastq_stats"), node("out", "output_results")],
             "edges": [edge("ref", "file", "h", "ref"), edge("in", "reads", "st", "reads"), edge("h", "head", "out", "results")]}
    w = client.post("/api/studio/workflows", headers=auth, json={"name": "Ref head", "graph": graph}).json()
    pub = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth)
    assert pub.status_code == 200, pub.text
    run = client.post("/api/runs", headers=auth, json={"pipeline_id": pub.json()["pipeline_id"], "engine": "bcflow",
                                                      "output_dir": "results:refrun", "params": {}}).json()
    assert "id" in run, run
    done = wait_for_run(client, auth, run["id"])
    assert done["status"] == "completed", client.get(f"/api/runs/{run['id']}/log", headers=auth).json()["content"][-1500:]
    head = client.get(f"/api/results/{run['id']}/file", params={"path": "reference_head/ref_head.txt"}, headers=auth).json()["content"]
    assert head.startswith(">chr1")
    refs = done["provenance"]["references"]
    assert refs[0]["param"] == "genome_fasta" and refs[0]["uri"] == "refgenie://toy/fasta" and refs[0]["asset_digest"]
    # a reference that does not exist is a clear launch error, not a failed run
    bad = client.post("/api/runs", headers=auth, json={"pipeline_id": pub.json()["pipeline_id"], "engine": "bcflow",
                                                      "output_dir": "results:refrun2", "params": {"genome_fasta": "refgenie://toy/star_index"}})
    assert bad.status_code == 422 and "star_index" in bad.text


def test_experiments_record_their_genome(client, auth):
    e = client.post("/api/experiments", headers=auth, json={"name": "Genome exp", "assay": "chipseq", "genome": "toy"}).json()
    assert e["genome"] == "toy"


def test_experiment_update_keeps_genome_when_not_sent(client, auth):
    e = client.post("/api/experiments", headers=auth, json={"name": "Genome exp 2", "genome": "toy"}).json()
    u = client.put(f"/api/experiments/{e['id']}", headers=auth, json={"name": "Genome exp 2b"}).json()
    assert u["genome"] == "toy" and u["name"] == "Genome exp 2b"


def test_assistant_catalog_lists_references(refgenie_config):
    import json

    from app.services import assistant

    cat = json.loads(assistant.catalog({}))
    toy = next(g for g in cat["reference_genomes"] if g["genome"] == "toy")
    assert "fai" in toy["assets"]["fasta"] and "bowtie2_index" in toy["assets"]
