"""Start the BioCompute controller as a service: load the config file, then run the API (which also serves the UI).

    python -m app.serve [--config FILE] [--port N]

The config file uses the same KEY=value format as .env (parsed by python-dotenv, so JSON values such as
BIOCOMPUTE_DATA_ROOTS need no extra quoting). Values already in the environment win. The server listens on
127.0.0.1 only; other computers reach it through `tailscale serve`, an SSH tunnel or a reverse proxy.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m app.serve")
    ap.add_argument("--config", default=os.environ.get("BIOCOMPUTE_CONFIG", ".env"))
    ap.add_argument("--port", type=int, default=None)
    a = ap.parse_args()
    cfg = Path(a.config).expanduser()
    if cfg.is_file():
        from dotenv import load_dotenv

        load_dotenv(cfg, override=False)
    port = a.port or int(os.environ.get("BIOCOMPUTE_PORT", "8045"))
    host = os.environ.get("BIOCOMPUTE_BIND", "127.0.0.1")

    import uvicorn

    # proxy headers: requests arriving through tailscale serve / nginx keep the real client address,
    # which the first-run setup uses to tell "this computer" from "another computer"
    uvicorn.run("app.main:app", host=host, port=port, proxy_headers=True, forwarded_allow_ips="127.0.0.1",
                log_level=os.environ.get("BIOCOMPUTE_LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
