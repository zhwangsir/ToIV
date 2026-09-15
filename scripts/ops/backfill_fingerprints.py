#!/usr/bin/env python3
"""回填存量应用的功能指纹(app.fingerprint,2026-09-15)。

用法(core):cd /home/merlin/toiv/api && .venv/bin/python scripts/ops/backfill_fingerprints.py
幂等:已有指纹的跳过;图变更后指纹由 PUT 重算。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "api"))

from sqlmodel import Session, select  # noqa: E402

from app.db import engine  # noqa: E402
from app.models import App  # noqa: E402
from app.services.app_fingerprint import fingerprint  # noqa: E402


def main() -> None:
    done = 0
    with Session(engine) as session:
        rows = session.exec(select(App)).all()
        for a in rows:
            if a.fingerprint:
                continue
            a.fingerprint = fingerprint(a.workflow_json)
            session.add(a)
            done += 1
        session.commit()
    print(f"backfilled fingerprints: {done} apps")


if __name__ == "__main__":
    main()
