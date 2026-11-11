"""User-defined Studio modules and the pipeline assistant (with a stub provider: no network, no cost)."""
import json

from conftest import wait_for_run

from app.services import assistant as ai
from app.services import custom_modules as cm
from test_end_to_end import _make_experiment
from test_studio import edge, node

COUNTER = {
    "id": "u_read_counter", "name": "Read counter", "category": "My modules", "description": "Counts reads per sample",
    "scope": "per_sample", "language": "bash",
    "inputs": [{"name": "reads", "type": "fastq", "multiple": False}],
    "outputs": [{"name": "counts", "type": "table", "pattern": "{prefix}.counts.tsv"}],
    "params": [{"name": "label", "type": "string", "default": "reads", "description": "Column label"}],
    "tools": ["awk"], "cpus": 1, "memory_gb": 1,
    "script": 'set -euo pipefail\nn=0\nfor f in $BC_IN_READS; do\n  c=$(gzip -cdf "$f" | awk \'END{print NR/4}\')\n'
              '  n=$((n + c))\ndone\nprintf "sample\\t%s\\n%s\\t%s\\n" "$BC_PARAM_LABEL" "$BC_PREFIX" "$n" > "$BC_PREFIX.counts.tsv"\n',
}


def test_check_module_reports_problems(client, auth):
    bad = {**COUNTER, "id": "fastqc", "script": "if then fi"}
    r = client.post("/api/studio/modules/check", headers=auth, json=bad).json()
    assert not r["valid"]
    msgs = " ".join(i["message"] for i in r["issues"])
    assert "built-in" in msgs and "syntax" in msgs.lower()
    r = client.post("/api/studio/modules/check", headers=auth, json={**COUNTER, "tools": ["definitely-not-installed-xyz"]}).json()
    assert r["valid"] and any("not found" in i["message"].lower() for i in r["issues"])  # a warning, not an error
    r = client.post("/api/studio/modules/check", headers=auth,
                    json={**COUNTER, "outputs": [{"name": "counts", "type": "table", "pattern": "../x.tsv"}]}).json()
    assert not r["valid"]


def test_templates_and_scan(client, auth):
    scan = client.get("/api/studio/tools/scan", headers=auth).json()
    assert "genrich" in scan["templates"] and all("exe" in t for t in scan["tools"])
    for key in cm.TEMPLATES:  # every shipped template must pass its own validation (tools may be missing)
        t = client.get(f"/api/studio/module-templates/{key}", headers=auth).json()
        res = cm.check_module(t)
        assert res["valid"], (key, res["issues"])
    sk = client.get("/api/studio/module-skeleton", params={"exe": "my-caller"}, headers=auth).json()
    assert sk["id"].startswith("u_") and cm.check_module(sk)["valid"]


def test_create_compile_run_and_delete_custom_module(client, auth):
    r = client.post("/api/studio/modules", headers=auth, json=COUNTER)
    assert r.status_code == 200, r.text
    mods = client.get("/api/studio/modules", headers=auth).json()["modules"]
    assert any(m["id"] == "u_read_counter" and m.get("user") for m in mods)
    assert client.post("/api/studio/modules", headers=auth, json=COUNTER).status_code == 422  # duplicate id
    # id is immutable
    assert client.put("/api/studio/modules/u_read_counter", headers=auth, json={**COUNTER, "id": "u_other"}).status_code == 400
    upd = client.put("/api/studio/modules/u_read_counter", headers=auth, json={**COUNTER, "description": "v2"})
    assert upd.status_code == 200
    exported = client.get("/api/studio/modules/u_read_counter/export", headers=auth).json()
    assert exported["biocompute_module"] == 1 and exported["description"] == "v2"

    graph = {"nodes": [node("in", "input_samplesheet"), node("cnt", "u_read_counter", params={"label": "n_reads"}),
                       node("out", "output_results")],
             "edges": [edge("in", "reads", "cnt", "reads"), edge("cnt", "counts", "out", "results")]}
    comp = client.post("/api/studio/compile", headers=auth, json={"name": "count", "graph": graph}).json()
    assert comp["valid"], comp["issues"]
    assert "BC_PARAM_LABEL" in comp["files"]["main.nf"]

    w = client.post("/api/studio/workflows", headers=auth, json={"name": "Counter", "graph": graph}).json()
    pub = client.post(f"/api/studio/workflows/{w['id']}/publish", headers=auth)
    assert pub.status_code == 200, pub.text
    exp = next((e for e in client.get("/api/experiments", headers=auth).json() if e["sample_count"] == 5), None) \
        or _make_experiment(client, auth, name="Custom module test")
    run = client.post("/api/runs", headers=auth, json={"pipeline_id": pub.json()["pipeline_id"], "engine": "bcflow",
                                                      "experiment_id": exp["id"], "output_dir": "results:counter1",
                                                      "params": {}}).json()
    done = wait_for_run(client, auth, run["id"])
    assert done["status"] == "completed", client.get(f"/api/runs/{run['id']}/log", headers=auth).json()["content"][-2000:]
    listing = client.get(f"/api/results/{run['id']}", params={"path": "read_counter"}, headers=auth).json()
    tsvs = [e["name"] for e in listing["entries"] if e["name"].endswith(".counts.tsv")]
    assert len(tsvs) == 5
    body = client.get(f"/api/results/{run['id']}/file", params={"path": f"read_counter/{tsvs[0]}"}, headers=auth).json()["content"]
    header, row = body.strip().splitlines()
    assert header == "sample\tn_reads" and int(row.split("\t")[1]) > 0

    # still used by a workflow -> refuse, then allow after removing the workflow
    assert client.delete("/api/studio/modules/u_read_counter", headers=auth).status_code == 409
    client.delete(f"/api/studio/workflows/{w['id']}", headers=auth)
    assert client.delete("/api/studio/modules/u_read_counter", headers=auth).status_code == 200


# --------------------------------------------------------------------------- assistant (stub provider)
def test_strict_schema_closed_everywhere():
    def walk(n):
        if isinstance(n, dict):
            if n.get("type") == "object" and "properties" in n:
                assert n["additionalProperties"] is False and set(n["required"]) == set(n["properties"])
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)
    for model in (ai.PipelineDraft, ai.Review, ai.ModuleDraft, ai.Answer):
        walk(ai.strict_schema(model))


def test_assistant_off_by_default(client, auth):
    st = client.get("/api/assistant/status", headers=auth).json()
    assert st["provider"] == "off" and not st["enabled"]
    r = client.post("/api/assistant/ask", headers=auth, json={"question": "hello?"})
    assert r.status_code == 502 and "off" in r.json()["detail"]


def test_assistant_build_repairs_invalid_draft(client, auth, monkeypatch):
    client.put("/api/assistant/config", headers=auth, json={"provider": "openai", "model": "gpt-test", "api_key": "sk-test-1234"})
    st = client.get("/api/assistant/status", headers=auth).json()
    assert st["providers"]["openai"]["configured"] and st["providers"]["openai"]["hint"] == "…1234"
    assert "sk-test" not in json.dumps(st)

    bad = {"name": "ChIP", "description": "d", "explanation": "e", "assumptions": ["paired-end"], "missing_modules": [],
           "nodes": [{"id": "in", "module": "input_samplesheet", "label": "Samples", "params": []},
                     {"id": "aln", "module": "bowtie2", "label": "Align", "params": []}],
           "edges": [{"source": "in", "source_port": "reads", "target": "aln", "target_port": "reads"}]}
    good = json.loads(json.dumps(bad))
    good["nodes"].append({"id": "idx", "module": "input_file", "label": "Index",
                          "params": [{"name": "param_name", "value": "bowtie2_index"}, {"name": "file_type", "value": "index"},
                                     {"name": "format", "value": "directory-path"}]})
    good["edges"].append({"source": "idx", "source_port": "file", "target": "aln", "target_port": "index"})
    calls = []

    def fake_openai(model, system, prompt, schema, name, key):
        calls.append(prompt)
        assert key == "sk-test-1234" and model == "gpt-test" and schema["additionalProperties"] is False
        return (bad if len(calls) == 1 else good), {"provider": "openai", "model": model}

    monkeypatch.setattr(ai, "_run_openai", fake_openai)
    r = client.post("/api/assistant/build", headers=auth, json={"description": "ChIP-seq alignment"})
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["valid"] and res["attempts"] == 2 and len(calls) == 2
    assert "rejected" in calls[1] and "index" in calls[1]  # validator errors are fed back
    assert {n["data"]["module"] for n in res["graph"]["nodes"]} == {"input_samplesheet", "bowtie2", "input_file"}
    assert all(e["sourceHandle"].startswith("out:") for e in res["graph"]["edges"])
    # the paid-for answer is kept and can be reloaded later, but nothing was saved as a workflow or run
    hist = client.get("/api/assistant/history", params={"task": "build"}, headers=auth).json()
    assert hist[0]["id"] == res["result_id"] and hist[0]["name"] == "ChIP" and hist[0]["valid"]
    item = client.get(f"/api/assistant/history/{res['result_id']}", headers=auth).json()
    assert item["graph"] == res["graph"] and item["request"] == "ChIP-seq alignment"
    w = client.post("/api/studio/workflows", headers=auth, json={"name": "From AI", "graph": item["graph"]}).json()
    assert client.post(f"/api/assistant/history/{res['result_id']}/saved", headers=auth, json={"workflow_id": w["id"]}).status_code == 200
    assert client.get("/api/assistant/history", headers=auth).json()[0]["workflow_id"] == w["id"]
    client.delete(f"/api/studio/workflows/{w['id']}", headers=auth)
    assert not any(w["name"] == "ChIP" for w in client.get("/api/studio/workflows", headers=auth).json())
    ev = client.get("/api/auth/audit", headers=auth).json()
    hit = next(e for e in ev if e["action"] == "assistant.build")
    assert hit["detail"]["ok"] and hit["detail"]["provider"] == "openai"


def test_assistant_review_and_draft_module(client, auth, monkeypatch):
    client.put("/api/assistant/config", headers=auth, json={"provider": "anthropic", "api_key": "sk-ant-test-9999"})

    def fake_anthropic(model, effort, system, prompt, schema, key):
        assert model == "claude-opus-5-5" and effort == "high" and key == "sk-ant-test-9999"
        assert "/home" not in prompt and "samplesheet.csv" not in prompt  # no data paths leak into prompts
        if "Review this pipeline" in prompt:
            return {"verdict": "needs_changes", "summary": "s", "recommendations": ["Add duplicate removal"],
                    "findings": [{"severity": "warning", "node_id": "peaks", "title": "No control", "detail": "d"}]}, {"provider": "anthropic", "model": model}
        return {"id": "u_genrich2", "name": "Genrich", "category": "Peak calling", "description": "x", "scope": "per_sample",
                "language": "bash", "inputs": [{"name": "bam", "type": "bam", "multiple": False}],
                "outputs": [{"name": "peaks", "type": "peaks", "pattern": "{prefix}.narrowPeak"}],
                "params": [{"name": "qvalue", "type": "number", "default": "0.05", "choices": [], "description": "q"}],
                "tools": ["Genrich"], "conda": "", "container": "", "cpus": 2, "memory_gb": 4,
                "script": 'set -euo pipefail\nGenrich -t $BC_IN_BAM -o "$BC_PREFIX.narrowPeak" -q $BC_PARAM_QVALUE\n',
                "notes": "Genrich needs name-sorted BAM"}, {"provider": "anthropic", "model": model}

    monkeypatch.setattr(ai, "_run_anthropic", fake_anthropic)
    from test_studio import CHIP_GRAPH
    r = client.post("/api/assistant/review", headers=auth, json={"graph": CHIP_GRAPH, "goal": "TF ChIP"}).json()
    assert r["verdict"] == "needs_changes" and r["validator"]["valid"] and r["findings"][0]["node_id"] == "peaks"
    d = client.post("/api/assistant/draft-module", headers=auth, json={"description": "Genrich peaks", "tool": "Genrich"}).json()
    assert d["module"]["params"][0]["default"] == 0.05 and d["module"]["params"][0]["enum"] is None
    assert d["check"]["valid"], d["check"]["issues"]
    client.put("/api/assistant/config", headers=auth, json={"provider": "off", "clear_key": True})


def test_assistant_config_requires_admin(client):
    r = client.put("/api/assistant/config", json={"provider": "openai"})
    assert r.status_code in (401, 403)
