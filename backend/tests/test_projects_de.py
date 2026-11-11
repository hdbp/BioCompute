"""Projects (Data Explorer) and differential-expression cut-offs/export."""
import json

from conftest import RESULTS

DE = RESULTS / "de_test"


def _write_de():
    DE.mkdir(exist_ok=True)
    rows = [("", "baseMean", "log2FoldChange", "lfcSE", "pvalue", "padj"),  # R write.csv rownames: empty first header
            ("GeneA", "500", "2.5", "0.2", "1e-12", "1e-10"),
            ("GeneB", "300", "-1.8", "0.3", "1e-6", "1e-4"),
            ("GeneC", "50", "0.4", "0.3", "0.2", "0.5"),
            ("GeneD", "2", "3.0", "1.5", "0.01", "0.04"),
            ("GeneE", "0", "NA", "NA", "NA", "NA")]
    (DE / "deseq2.csv").write_text("\n".join(",".join(r) for r in rows) + "\n")
    (DE / "edger.tsv").write_text("gene\tlogFC\tlogCPM\tPValue\tFDR\nX\t-2\t5\t0.001\t0.01\nY\t0.1\t3\t0.9\t0.95\n")


def test_detection_and_cutoffs(client, auth):
    _write_de()
    d = client.get("/api/explore/de", params={"path": "results:de_test/deseq2.csv"}, headers=auth).json()
    assert d["mapping"]["lfc"] == "log2FoldChange" and d["mapping"]["padj"] == "padj" and d["mapping"]["mean"] == "baseMean"
    assert d["id"][:2] == ["GeneA", "GeneB"] and d["lfc"][4] is None and d["mean_is_log"] is False
    e = client.get("/api/explore/de", params={"path": "results:de_test/edger.tsv"}, headers=auth).json()
    assert e["mapping"] == {"lfc": "logFC", "padj": "FDR", "p": "PValue", "mean": "logCPM", "id": "gene", "label": None} and e["mean_is_log"]

    def export(**kw):
        r = client.get("/api/explore/de/export", params={"path": "results:de_test/deseq2.csv", **kw}, headers=auth)
        assert r.status_code == 200, r.text
        lines = r.text.strip().splitlines()
        return lines[0].split(","), [l.split(",") for l in lines[1:]]

    head, rows = export(p_cut=0.05, lfc_cut=1, direction="both")
    assert head[-1] == "regulation" and [r[0] for r in rows] == ["GeneA", "GeneB", "GeneD"]  # sorted by p
    assert [r[-1] for r in rows] == ["up", "down", "up"]
    _, rows = export(p_cut=0.05, lfc_cut=1, mean_cut=10, direction="up")
    assert [r[0] for r in rows] == ["GeneA"]  # GeneD is below the mean cut-off
    _, rows = export(p_cut=0.05, lfc_cut=2, direction="both")
    assert [r[0] for r in rows] == ["GeneA", "GeneD"]  # GeneB (-1.8) drops out
    _, rows = export(direction="all")
    assert len(rows) == 5 and rows[-1][-1] == "na"
    tsv = client.get("/api/explore/de/export", params={"path": "results:de_test/deseq2.csv", "fmt": "tsv"}, headers=auth)
    assert "\t" in tsv.text and "attachment" in tsv.headers["content-disposition"]
    assert client.get("/api/explore/de", params={"path": "results:de_test/edger.tsv", "lfc": "nope"}, headers=auth).status_code == 400


def test_projects_folders_items_and_saved_analyses(client, auth):
    _write_de()
    p = client.post("/api/projects", headers=auth, json={"name": "H3K27ac 2026", "home_root": "results"}).json()
    assert p["home"] == "results:projects/h3k27ac-2026" and p["visibility"] == "private"
    assert (RESULTS / "projects" / "h3k27ac-2026" / "analyses").is_dir()
    assert p["folders"]["results"] == "results:projects/h3k27ac-2026/results"
    # a second project with the same name gets its own folder
    p2 = client.post("/api/projects", headers=auth, json={"name": "H3K27ac 2026", "home_root": "results"}).json()
    assert p2["home"] == "results:projects/h3k27ac-2026-2"
    it = client.post(f"/api/projects/{p['id']}/items", headers=auth, json={"ref": "raw:run1"}).json()
    assert it["kind"] == "folder"
    assert client.post(f"/api/projects/{p['id']}/items", headers=auth, json={"ref": "raw:run1"}).status_code == 409
    assert client.post(f"/api/projects/{p['id']}/items", headers=auth, json={"ref": "raw:../outside"}).status_code in (400, 403)

    s = client.post("/api/explore/de/save", headers=auth, json={"path": "results:de_test/deseq2.csv", "p_cut": 0.05, "lfc_cut": 1,
                                                                "direction": "up", "project_id": p["id"]}).json()
    assert s["rows"] == 2 and s["path"].startswith("results:projects/h3k27ac-2026/analyses/deseq2_up_")
    params = json.loads((RESULTS / s["params"].split(":", 1)[1]).read_text())
    assert params["p_cutoff"] == 0.05 and params["counts"]["up"] == 2
    d = client.get(f"/api/projects/{p['id']}", headers=auth).json()
    assert [i["kind"] for i in d["items"]] == ["folder", "file"] and all(i["exists"] for i in d["items"])
    # removing an item or the project never touches files
    client.delete(f"/api/projects/{p['id']}/items/{d['items'][1]['id']}", headers=auth)
    assert (RESULTS / s["path"].split(":", 1)[1]).is_file()
    assert client.delete(f"/api/projects/{p2['id']}", headers=auth).json()["ok"]
    assert (RESULTS / "projects" / "h3k27ac-2026-2").is_dir()


def test_projects_are_private_by_default(client, auth):
    client.post("/api/auth/users", headers=auth, json={"username": "pat", "password": "pat-password-1", "role": "scientist"})
    tok = client.post("/api/auth/login", json={"username": "pat", "password": "pat-password-1"}).json()["access_token"]
    pat = {"Authorization": f"Bearer {tok}"}
    mine = client.post("/api/projects", headers=pat, json={"name": "Pat's"}).json()
    assert mine["owner"] == "pat" and mine["can_edit"]
    others = client.post("/api/projects", headers=auth, json={"name": "Admin private"}).json()
    assert client.get(f"/api/projects/{others['id']}", headers=pat).status_code == 404
    client.patch(f"/api/projects/{others['id']}", headers=auth, json={"visibility": "lab"})
    assert client.get(f"/api/projects/{others['id']}", headers=pat).status_code == 200
    assert client.post(f"/api/projects/{others['id']}/items", headers=pat, json={"ref": "raw:run1"}).status_code == 403
