"""Data Explorer: viewer detection, table parsing, byte ranges for igv.js, public hub list."""
import gzip
import io
import json

import pytest

from conftest import RESULTS

from app.services import explore

D = RESULTS / "explore"


@pytest.fixture(scope="module", autouse=True)
def files():
    D.mkdir(parents=True, exist_ok=True)
    (D / "peaks.narrowPeak").write_text("chr1\t100\t200\tp1\t50\t.\t5.5\t10.2\t8.1\t40\n"
                                        "chr1\t500\t800\tp2\t90\t.\t12.0\t30.5\t25.0\t120\n"
                                        "chr2\t10\t60\tp3\t10\t.\t2.1\t3.3\t1.2\t20\n")
    (D / "de.tsv").write_text("gene\tbaseMean\tlog2FoldChange\tpadj\nA\t100.5\t1.2\t0.01\nB\t20\t-0.5\tNA\nC\t3000\t2.5\t1e-10\n")
    (D / "counts.csv").write_text("sample,reads\nS1,1000\nS2,2500\n")
    with gzip.open(D / "big.tsv.gz", "wt") as fh:
        fh.write("x\ty\n" + "".join(f"{i}\t{i * 2}\n" for i in range(5000)))
    (D / "featurecounts.txt").write_text("# Program:featureCounts v2.0.6\nGeneid\tChr\tLength\tS1.bam\nG1\tchr1\t500\t10\nG2\tchr2\t900\t0\n")
    (D / "sample.bam").write_bytes(b"BAM\x01" + bytes(range(256)) * 4)
    (D / "sample.bam.bai").write_bytes(b"BAI\x01")
    (D / "noindex.bam").write_bytes(b"BAM\x01\x00")
    (D / "signal.bw").write_bytes(b"\x26\xfc\x8f\x88" + b"\x00" * 64)
    (D / "report.pdf").write_bytes(b"%PDF-1.4\n%fake\n")
    (D / "multiqc.html").write_text("<html><script>1</script></html>")
    (D / "notes.md").write_text("# notes\n")
    (D / "genome.fa").write_text(">chr1\nACGT\n")
    (D / "genome.fa.fai").write_text("chr1\t4\t6\t4\t5\n")
    yield


def test_viewer_detection(client, auth):
    def kind(name):
        r = client.get("/api/explore/info", params={"path": f"results:explore/{name}"}, headers=auth)
        assert r.status_code == 200, r.text
        return r.json()

    assert kind("peaks.narrowPeak")["viewer"] == "table" and kind("peaks.narrowPeak")["track"]["format"] == "narrowpeak"
    bam = kind("sample.bam")
    assert bam["viewer"] == "track" and bam["track"]["indexed"] and bam["track"]["index"] == "results:explore/sample.bam.bai"
    nob = kind("noindex.bam")["track"]
    assert not nob["indexed"] and nob["needs_index"]
    assert kind("signal.bw")["track"]["format"] == "bigwig"
    assert kind("report.pdf")["viewer"] == "pdf"
    assert kind("multiqc.html")["viewer"] == "html"
    assert kind("notes.md")["viewer"] == "text"
    fa = kind("genome.fa")["track"]
    assert fa["type"] == "reference" and fa["indexed"]


def test_tables(client, auth):
    t = client.get("/api/explore/table", params={"path": "results:explore/peaks.narrowPeak"}, headers=auth).json()
    names = [c["name"] for c in t["columns"]]
    assert names[:3] == ["chrom", "start", "end"] and "q_value" in names and t["total"] == 3
    t = client.get("/api/explore/table", params={"path": "results:explore/de.tsv", "sort": "baseMean", "desc": True}, headers=auth).json()
    assert [r[0] for r in t["rows"]] == ["C", "A", "B"]
    padj = next(c for c in t["columns"] if c["name"] == "padj")
    assert padj["type"] == "number" and padj["missing"] == 1  # "NA" is a missing number, not text
    t = client.get("/api/explore/table", params={"path": "results:explore/de.tsv", "q": "b"}, headers=auth).json()
    assert t["total"] == 1
    t = client.get("/api/explore/table", params={"path": "results:explore/counts.csv"}, headers=auth).json()
    assert [c["name"] for c in t["columns"]] == ["sample", "reads"] and t["rows"][1] == ["S2", "2500"]
    t = client.get("/api/explore/table", params={"path": "results:explore/featurecounts.txt"}, headers=auth).json()
    assert [c["name"] for c in t["columns"]] == ["Geneid", "Chr", "Length", "S1.bam"]  # comment line skipped
    t = client.get("/api/explore/table", params={"path": "results:explore/big.tsv.gz", "offset": 4990, "limit": 50}, headers=auth).json()
    assert t["total"] == 5000 and len(t["rows"]) == 10


def test_columns_for_plots(client, auth):
    r = client.get("/api/explore/columns", params={"path": "results:explore/de.tsv", "cols": "baseMean,padj"}, headers=auth).json()
    assert r["n"] == 2 and r["values"]["baseMean"] == [100.5, 3000.0]  # row with padj NA dropped
    r = client.get("/api/explore/columns", params={"path": "results:explore/big.tsv.gz", "cols": "x,y", "max_points": 1000}, headers=auth).json()
    assert r["n"] == 5000 and r["returned"] == 1000 and r["sampled"]
    assert client.get("/api/explore/columns", params={"path": "results:explore/de.tsv", "cols": "gene"}, headers=auth).status_code == 400


def test_raw_supports_ranges_and_stays_in_roots(client, auth):
    r = client.get("/api/explore/raw", params={"path": "results:explore/sample.bam"}, headers={**auth, "Range": "bytes=4-11"})
    assert r.status_code == 206 and r.content == bytes(range(8)) and r.headers["content-range"].startswith("bytes 4-11/")
    h = client.head("/api/explore/raw", params={"path": "results:explore/sample.bam"}, headers=auth)
    assert h.status_code == 200 and int(h.headers["content-length"]) == 4 + 1024
    html = client.get("/api/explore/raw", params={"path": "results:explore/multiqc.html"}, headers=auth)
    assert "sandbox" in html.headers["content-security-policy"]
    assert client.get("/api/explore/raw", params={"path": "results:explore/report.pdf"}, headers=auth).headers["content-type"] == "application/pdf"
    for bad in ("results:../outside/secret.txt", "raw:escape/secret.txt", "nosuchroot:x"):
        assert client.get("/api/explore/raw", params={"path": bad}, headers=auth).status_code in (400, 403, 404)
    assert client.get("/api/explore/raw", params={"path": "results:explore/sample.bam"}).status_code == 401


def test_public_hubs(client, auth, monkeypatch, tmp_root):
    payload = {"publicHubs": [
        {"hubUrl": "https://example.org/hub.txt", "shortLabel": "Example", "longLabel": "An example hub", "dbList": "hg38,mm10,"},
        {"hubUrl": "ftp://bad", "shortLabel": "bad"}]}

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    calls = []

    def fake_urlopen(req, timeout=0):
        calls.append(req.full_url)
        return Resp(json.dumps(payload).encode())

    monkeypatch.setattr(explore.urllib.request, "urlopen", fake_urlopen)
    r = client.get("/api/explore/hubs", params={"refresh": True}, headers=auth).json()
    assert calls == [explore.UCSC_HUBS] and r["hubs"] == [
        {"url": "https://example.org/hub.txt", "short_label": "Example", "long_label": "An example hub",
         "genomes": ["hg38", "mm10"], "description_url": None}]
    assert client.get("/api/explore/hubs", headers=auth).json()["cached"]  # served from the cache, no new request
    assert len(calls) == 1

    def down(req, timeout=0):
        raise OSError("network unreachable")

    monkeypatch.setattr(explore.urllib.request, "urlopen", down)
    stale = client.get("/api/explore/hubs", params={"refresh": True}, headers=auth).json()
    assert stale["stale"] and stale["hubs"]  # falls back to the last good list
