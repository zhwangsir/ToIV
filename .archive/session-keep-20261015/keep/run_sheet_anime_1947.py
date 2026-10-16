#!/usr/bin/env python3
"""19:47：硬裁脸格 + 全Qwen表情(不锁) + 服饰主立绘五局部。不入库。"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, "/home/merlin/toiv/api")

OUT = Path("/home/merlin/toiv/tmp/toiv_report_sheet_anime_1947")
SRC = Path("/home/merlin/toiv/tmp/toiv_report_sheet_anime_1703")
PREV = Path("/home/merlin/toiv/tmp/toiv_report_sheet_anime_1823")
OVERRIDE = SRC / "override"
OUT_DIR = OUT / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)
LOG = OUT / "run_1947.log"
WORKER = "http://100.68.100.90:8262"
TEST_CID = "test1947_anime_nointake"
SEED = 10031947
os.environ["TOIV_SHEET_REJECT_DIR"] = str(OUT_DIR / "rejects")
Path(os.environ["TOIV_SHEET_REJECT_DIR"]).mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    line = "[" + time.strftime("%Y-%m-%d %H:%M:%S") + "] " + msg
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


async def main() -> None:
    from app.comfy.pool import WorkerPool
    from app.services.studio.character_sheet import (
        CharacterSheetError,
        SheetMeta,
        generate_character_sheet,
        panel_vertical_span,
        assert_panel_coverage,
        measure_face_height_frac,
        build_faces_tri_from_masters,
        build_costume_collage_from_portrait,
    )

    approved_path = SRC / "out" / "approved_portrait_10031947.png"
    if not approved_path.is_file():
        approved_path = PREV / "approved_portrait_10031947.png"
    approved = approved_path.read_bytes()
    v = panel_vertical_span(approved)
    assert_panel_coverage(approved)
    log("approved portrait bytes=%d vspan=%.3f" % (len(approved), v))

    panels = {
        "portrait": approved,
        "front": (OVERRIDE / "front.png").read_bytes(),
        "side": (OVERRIDE / "side.png").read_bytes(),
        "back": (OVERRIDE / "back.png").read_bytes(),
    }
    # 19:47：取消表情锁定，6 张全部 Qwen 从主立绘上半身编辑

    tri = build_faces_tri_from_masters(
        portrait=panels["portrait"],
        front=panels["front"],
        side=panels["side"],
        back=panels["back"],
        size=768,
    )
    for fk, b in tri.items():
        (OUT_DIR / ("pre_%s.png" % fk)).write_bytes(b)
        log("pre %s face_height_frac=%s bytes=%d" % (fk, measure_face_height_frac(b), len(b)))

    costume = build_costume_collage_from_portrait(panels["portrait"], style="anime")
    (OUT_DIR / "pre_costume.png").write_bytes(costume)
    panels["costume"] = costume
    log("pre costume bytes=%d" % len(costume))

    for k, b in list(panels.items()):
        (OUT_DIR / ("inj_%s.png" % k)).write_bytes(b)

    meta = SheetMeta(
        name="林夏",
        style="anime",
        height_cm=168,
        role="便利店员",
        personality="克制、冷静",
        design_notes=(
            "板岩灰连帽雨衣：长款过膝、长袖、胸前素面无标。\n"
            "黑裤袜与黑色短靴，全身站姿，人物占满画高。\n"
            "三视图沿用 10/02 过审原文件；主立绘 10031947；19:47 硬裁脸格+全Qwen表情+服饰五局部。"
        ),
        colors=["#E8C4A8", "#5A6A7A", "#D4D3D8", "#C98A7A", "#2C2C34", "#1A1A1E"],
        visual_prompt=(
            "young East Asian woman Lin Xia, jet black hair wet on forehead, "
            "slate gray #5A6A7A long knee-length hooded raincoat with long sleeves, "
            "black pantyhose, black ankle boots, fully clothed legs and feet, "
            "plain flat chest unbranded no logo no badge no emblem no star patch, "
            "hood down, face fully visible, full body standing pose filling frame height, "
            "rainy night convenience store clerk vibe"
        ),
        description="林夏 二次元 板岩灰连帽雨衣",
    )

    pool = WorkerPool.from_urls([WORKER], timeout=120.0)
    log("start seed=%s worker=%s cid=%s route=1947_hardcrop+qwen6+costume5" % (SEED, WORKER, TEST_CID))
    t0 = time.time()
    try:
        url, png, panel_urls = await generate_character_sheet(
            character_id=TEST_CID,
            meta=meta,
            pool=pool,
            worker=WORKER,
            seed=SEED,
            panels_override=panels,
            allow_reuse_refs=False,
        )
    except CharacterSheetError as e:
        elapsed = round(time.time() - t0, 1)
        payload = {
            "ok": False,
            "elapsed": elapsed,
            "error": str(e),
            "status": getattr(e, "status_code", None),
        }
        (OUT / "resp_1947.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        log("FAIL %.1fs %s" % (elapsed, e))
        return
    except Exception as e:
        elapsed = round(time.time() - t0, 1)
        (OUT / "resp_1947.json").write_text(
            json.dumps(
                {"ok": False, "elapsed": elapsed, "error": repr(e)},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        log("EXC %.1fs %r" % (elapsed, e))
        raise

    elapsed = round(time.time() - t0, 1)
    (OUT_DIR / "sheet_1947.png").write_bytes(png)
    meta_out = {
        "ok": True,
        "elapsed": elapsed,
        "sheet_url": url,
        "panel_urls": panel_urls,
        "seed": SEED,
        "final_review": False,
        "apply_to_video_refs": False,
        "approved_portrait": "approved_portrait_10031947.png",
        "locked_expr": [],
        "route": "1947_hardcrop+qwen6+costume5",
    }
    (OUT / "resp_1947.json").write_text(
        json.dumps(meta_out, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log("OK %.1fs sheet_bytes=%d url=%s" % (elapsed, len(png), url))


if __name__ == "__main__":
    asyncio.run(main())
