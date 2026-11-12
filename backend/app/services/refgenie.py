"""Reference genomes from refgenie (https://refgenie.databio.org), read-only.

Uses an existing refgenie setup as it is: the config is found (Settings, BIOCOMPUTE_REFGENIE_CONFIG, $REFGENIE,
common locations) and only *read* with refgenie's own library; nothing is pulled, built or written here.

References are written `refgenie://<genome>/<asset>[.<seek_key>][:<tag>]` (refgenie's registry path format) in
pipeline parameters, presets and Studio nodes. They are resolved to paths when a run is prepared, and the genome
and asset digests go into the run's provenance, so a result names the exact reference it was made with.
"""
from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal
from ..models import AppSetting
from . import fs

URI = re.compile(r"^refgenie://(?P<genome>[^/\s:]+)/(?P<asset>[A-Za-z0-9_\-]+)(?:\.(?P<seek>[A-Za-z0-9_\-]+))?(?::(?P<tag>[A-Za-z0-9_.\-]+))?$")
ROOT_NAME = "refgenie"
COMMON = ("~/.refgenie/genome_config.yaml", "~/refgenie/genome_config.yaml", "~/refgenomes/genome_config.yaml",
          "/data/refgenie/genome_config.yaml", "/opt/refgenie/genome_config.yaml")

# pipeline parameter name -> (asset, seek key) it usually means; the first asset present on the controller wins
PARAM_ASSETS: dict[str, list[tuple[str, str | None]]] = {
    "fasta": [("fasta", "fasta")], "genome_fasta": [("fasta", "fasta")], "reference": [("fasta", "fasta")],
    "ref_fasta": [("fasta", "fasta")], "fai": [("fasta", "fai")], "fasta_fai": [("fasta", "fai")],
    "chrom_sizes": [("fasta", "chrom_sizes")], "chromsizes": [("fasta", "chrom_sizes")], "genome_sizes": [("fasta", "chrom_sizes")],
    "bowtie2_index": [("bowtie2_index", None)], "bowtie2": [("bowtie2_index", None)],
    "bwa_index": [("bwa_index", None)], "bwa": [("bwa_index", None)],
    "bwamem2_index": [("bwa_mem2_index", None)], "bwa_mem2_index": [("bwa_mem2_index", None)],
    "star_index": [("star_index", None)], "star": [("star_index", None)],
    "hisat2_index": [("hisat2_index", None)], "hisat2": [("hisat2_index", None)],
    "salmon_index": [("salmon_partial_sa_index", None), ("salmon_sa_index", None), ("salmon_index", None)],
    "kallisto_index": [("kallisto_index", None)],
    "bismark_index": [("bismark_bt2_index", None), ("bismark_bt1_index", None)],
    "gtf": [("gencode_gtf", None), ("ensembl_gtf", None), ("refgene_anno", "refgene_anno")],
    "gff": [("ensembl_gff", None)], "gff3": [("ensembl_gff", None)],
    "blacklist": [("blacklist", None)], "tss": [("refgene_anno", "refgene_tss")],
}
INDEX_ASSETS = {"bowtie2_index", "bwa_index", "bwa_mem2_index", "star_index", "hisat2_index", "salmon_index",
                "salmon_sa_index", "salmon_partial_sa_index", "kallisto_index", "bismark_bt2_index", "bismark_bt1_index"}

_lock = threading.Lock()
_cache: dict[str, Any] = {"key": None, "rgc": None, "error": None}


# --------------------------------------------------------------------------- finding and reading the config
def _db_setting() -> str | None:
    db = SessionLocal()
    try:
        row = db.get(AppSetting, "refgenie")
        return (row.value or {}).get("config") if row else None
    finally:
        db.close()


def locate() -> tuple[Path | None, str | None]:
    """Where the refgenie config is, and how it was found."""
    candidates: list[tuple[str | None, str]] = [
        (_db_setting(), "Settings"),
        (get_settings().refgenie_config, "BIOCOMPUTE_REFGENIE_CONFIG"),
        (os.environ.get("REFGENIE"), "$REFGENIE"),
    ] + [(c, "found automatically") for c in COMMON]
    for raw, how in candidates:
        if raw:
            p = Path(os.path.expanduser(raw))
            if p.is_dir():
                p = p / "genome_config.yaml"
            if p.is_file():
                return p.resolve(), how
            if how != "found automatically":
                return p, how  # explicitly configured but missing: report it rather than silently guessing
    return None, None


def load():
    """RefGenConf for the current config (cached until the file changes); raises HTTPException with a clear reason."""
    path, _ = locate()
    if path is None:
        raise HTTPException(404, "No refgenie configuration found. Set it in Settings, Reference genomes.")
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        raise HTTPException(404, f"The refgenie configuration {path} does not exist") from None
    key = (str(path), mtime)
    with _lock:
        if _cache["key"] == key:
            if _cache["error"]:
                raise HTTPException(409, _cache["error"])
            return _cache["rgc"]
        try:
            from refgenconf import RefGenConf
            from refgenconf.exceptions import ConfigNotCompliantError
        except ImportError:
            raise HTTPException(503, "The refgenconf package is missing; run ./install.sh again.") from None
        try:
            rgc = RefGenConf.from_yaml_file(str(path))
            _cache.update(key=key, rgc=rgc, error=None)
        except ConfigNotCompliantError as exc:
            msg = ("This refgenie configuration uses an older format. Upgrade it with refgenie itself "
                   f"(refgenie upgrade --target-version 0.4 -c {path}); BioCompute does not change it for you. ({exc})")
            _cache.update(key=key, rgc=None, error=msg)
            raise HTTPException(409, msg) from None
        except Exception as exc:  # noqa: BLE001 - malformed YAML and friends
            _cache.update(key=key, rgc=None, error=f"Could not read {path}: {exc}")
            raise HTTPException(409, _cache["error"]) from None
        return rgc


def reload() -> None:
    """Register the refgenie genome folder as a read-only data folder (for browsing and the genome browser)."""
    with _lock:
        _cache.update(key=None, rgc=None, error=None)
    roots: list[fs.Root] = []
    try:
        rgc = load()
        folder = Path(rgc["genome_folder"]).expanduser().resolve()
        from . import data_roots
        # the same rules as for folders an admin adds: no system, home, hidden or state folders
        if data_roots.check_path(str(folder)).get("errors"):
            folder = Path("/nonexistent")
        if folder.is_dir() and ROOT_NAME not in {n for n in fs.roots() if fs.roots()[n].source != "refgenie"}:
            roots.append(fs.Root(name=ROOT_NAME, path=folder, restricted=False, writable=False,
                                 description="Reference genomes (refgenie)", source="refgenie"))
    except HTTPException:
        pass
    fs.set_extra_roots("refgenie", roots)


def set_config(db: Session, path: str | None) -> None:
    row = db.get(AppSetting, "refgenie") or AppSetting(key="refgenie", value={})
    row.value = {"config": (path or "").strip() or None}
    db.merge(row)


def _exists(path: str | None) -> bool:
    """Files, folders, and index prefixes such as bowtie2's .../hg38 (hg38.1.bt2, ...)."""
    if not path:
        return False
    if os.path.exists(path):
        return True
    parent, base = os.path.split(path)
    try:
        return any(n.startswith(base + ".") for n in os.listdir(parent))
    except OSError:
        return False


# --------------------------------------------------------------------------- catalog
def _genomes(rgc) -> dict[str, Any]:
    g = rgc["genomes"]
    return g.to_dict() if hasattr(g, "to_dict") else dict(g)


def status() -> dict[str, Any]:
    path, how = locate()
    out: dict[str, Any] = {"config": str(path) if path else None, "found_by": how, "ok": False, "error": None,
                           "env_refgenie": os.environ.get("REFGENIE")}
    if path is None:
        out["error"] = "No refgenie configuration found"
        return out
    try:
        rgc = load()
    except HTTPException as exc:
        out["error"] = exc.detail
        return out
    genomes = _genomes(rgc)
    out.update(ok=True, version=str(rgc.get("config_version")), genome_folder=str(rgc["genome_folder"]),
               servers=list(rgc.get("genome_servers") or []), genomes=len(genomes),
               assets=sum(len((g or {}).get("assets") or {}) for g in genomes.values()),
               data_folder=ROOT_NAME if ROOT_NAME in fs.roots() and fs.roots()[ROOT_NAME].source == "refgenie" else None)
    return out


def catalog() -> list[dict[str, Any]]:
    rgc = load()
    out = []
    for digest, g in sorted(_genomes(rgc).items(), key=lambda kv: ((kv[1] or {}).get("aliases") or [kv[0]])[0].lower()):
        aliases = list((g or {}).get("aliases") or [])
        name = aliases[0] if aliases else digest
        assets = []
        for aname, a in sorted(((g or {}).get("assets") or {}).items()):
            tags = []
            for tname, t in ((a or {}).get("tags") or {}).items():
                seek = {}
                for k in sorted(((t or {}).get("seek_keys") or {}).keys()):
                    try:
                        seek[k] = rgc.seek(name, aname, tag_name=tname, seek_key=k)
                    except Exception:  # noqa: BLE001
                        continue
                try:
                    default_path = rgc.seek(name, aname, tag_name=tname)
                except Exception:  # noqa: BLE001
                    default_path = None
                tags.append({"tag": tname, "digest": (t or {}).get("asset_digest"), "size": (t or {}).get("asset_size"),
                             "path": default_path, "exists": _exists(default_path),
                             "seek_keys": seek, "parents": (t or {}).get("asset_parents") or []})
            assets.append({"name": aname, "description": (a or {}).get("asset_description") or "",
                           "default_tag": (a or {}).get("default_tag"), "tags": tags})
        out.append({"name": name, "aliases": aliases, "digest": digest, "assets": assets})
    return out


# --------------------------------------------------------------------------- refgenie:// references
def parse(uri: str) -> dict[str, str | None] | None:
    m = URI.match((uri or "").strip())
    return m.groupdict() if m else None


def resolve(uri: str) -> dict[str, Any]:
    """refgenie://genome/asset[.seek_key][:tag] -> path plus digests (for provenance)."""
    ref = parse(uri)
    if not ref:
        raise HTTPException(400, f"Not a refgenie reference: {uri} (expected refgenie://genome/asset[.seek_key][:tag])")
    rgc = load()
    genome, asset, seek, tag = ref["genome"], ref["asset"], ref["seek"], ref["tag"]
    try:
        tag = tag or rgc.get_default_tag(genome, asset)
        path = rgc.seek(genome, asset, tag_name=tag, seek_key=seek)
        gdig = rgc.get_genome_alias_digest(genome, fallback=True)
        tagdata = _genomes(rgc)[gdig]["assets"][asset]["tags"][tag]
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - MissingGenomeError / MissingAssetError / MissingTagError / seek key
        raise HTTPException(400, f"{uri}: {exc}") from None
    if not _exists(path):
        raise HTTPException(400, f"{uri} points to {path}, which does not exist on the controller")
    return {"uri": uri, "path": path, "genome": genome, "genome_digest": gdig, "asset": asset, "tag": tag, "seek_key": seek,
            "asset_digest": tagdata.get("asset_digest")}


def resolve_params(params: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Replace refgenie:// values in run parameters; returns (params, references for provenance, issues)."""
    refs: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    out = dict(params)
    for k, v in params.items():
        if isinstance(v, str) and v.startswith("refgenie://"):
            try:
                r = resolve(v)
                out[k] = r["path"]
                refs.append({"param": k, **r})
            except HTTPException as exc:
                issues.append({"level": "error", "field": k, "message": str(exc.detail)})
    return out, refs, issues


def suggest(param: str, genome: str, directory: bool) -> str | None:
    """The reference a pipeline parameter most likely wants for this genome, if the controller has it."""
    try:
        rgc = load()
        gdig = rgc.get_genome_alias_digest(genome, fallback=True)
    except Exception:  # noqa: BLE001
        return None
    assets = (_genomes(rgc).get(gdig) or {}).get("assets") or {}
    for asset, seek in PARAM_ASSETS.get(param.lower(), []):
        if asset in assets:
            if directory and asset in INDEX_ASSETS:
                seek = "dir"  # nf-core and most tools take index *folders*
            return f"refgenie://{genome}/{asset}" + (f".{seek}" if seek and seek != asset else "")
    return None


def suggestions(fields: list[dict[str, Any]], genome: str) -> dict[str, str]:
    out = {}
    for f in fields:
        if f.get("widget") in ("file", "directory"):
            s = suggest(f["name"], genome, f.get("widget") == "directory")
            if s:
                out[f["name"]] = s
    return out
