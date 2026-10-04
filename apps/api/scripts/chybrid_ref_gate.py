#!/usr/bin/env python3
"""镜头级参考图验收（c_hybrid 雨夜对比等）：VLM 四问（Comfy Qwen3-VL，仅 :8262/:8264 排队）+ InsightFace 脸分 ≥0.75。

用法：
  CODE_ROOT=... python scripts/chybrid_ref_gate.py OUT.json NAME=IMAGE@ORIGINAL[@URL] ...
OUT.json 追加写，供驱动 --ref-gate-json 核对；IMAGE 为候选图本地路径，ORIGINAL 为同角度原参考图（算脸分）。
CLIP 不参与验收（仅 hood_state_log 告警）。
:8262 排队规则：逐图提交（每批 4 问 ≤8），提交前等我方上一批排空、无角色卡在队，再隔 15s。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.environ.get("CODE_ROOT", str(Path(__file__).resolve().parents[1])))

from app.services.studio import outfit_state as ost  # noqa: E402


async def _main(argv: list[str]) -> int:
    out = Path(argv[0])
    res = json.loads(out.read_text()) if out.exists() else {}

    async def one(spec: str) -> None:
        name, rest = spec.split("=", 1)
        parts = rest.split("@")
        img, orig = parts[0], parts[1]
        url = parts[2] if len(parts) > 2 else ""
        try:
            v = await ost.scene_ref_gate(Path(img).read_bytes(), Path(orig).read_bytes())
        except Exception as e:  # noqa: BLE001
            print(name, "ERROR", type(e).__name__, str(e)[:300], flush=True)
            return
        v.update(image=img, original=orig, url=url)
        res[name] = v
        print(name, "PASS" if v["pass"] else "FAIL", v["failed"], "face",
              None if v["face_sim"] is None else round(v["face_sim"], 4),
              {c["key"]: c["parsed"] for c in v["checks"]}, flush=True)
        out.write_text(json.dumps(res, ensure_ascii=False, indent=1))

    for s in argv[1:]:  # 逐图串行：每图一批 4 问（≤8），批间等排空+角色卡优先
        await one(s)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main(sys.argv[1:])))
