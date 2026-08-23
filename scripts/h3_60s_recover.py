#!/usr/bin/env python3
"""H3 60s 时长链手工恢复(2026-08-20)。

背景:五路 60s 批量中 H3×2 的 extend 时长链因单段等待超时(_POST_WAIT_TIMEOUT=3600s,
两条链共用 H3 单实例排队,单段实测 >80min)失败,Job 只回落到首段 15s 产物(已被超分)。
分段本身全部成功落盘——本脚本离线重建:

  1. 水母链缺第 4 段(链超时死掉前未提交):末帧 i2v 补提交(seed=seed0+3, 362帧);
  2. 两作业 4 段拼接 + 精确裁 60s → 回传 H3 input → rewrite_job_result;
  3. 清理旧 15s 超分工作目录/产物 → 重挂融合超分链(1080p) → 终产物原子回写。

在 core 上以 app venv 运行:cd /home/merlin/toiv/api && .venv/bin/python /tmp/h3_60s_recover.py
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

sys.path.insert(0, "/home/merlin/toiv/api")


def _load_env() -> None:
    """deploy/.env → os.environ(须在 import app.* 之前;不覆盖已有值)。"""
    for line in Path("/home/merlin/toiv/deploy/.env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.removeprefix("export ").strip()
        v = v.strip().strip('"').strip("'")
        if k:
            os.environ.setdefault(k, v)


_load_env()

from pydantic import BaseModel  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from app.comfy.tracker import image_url  # noqa: E402
from app.db import engine as db_engine  # noqa: E402
from app.models import Job, User  # noqa: E402
from app.services import h3 as h3_service  # noqa: E402
from app.services import video_generators as vgen  # noqa: E402
from app.services import video_upscale as vup  # noqa: E402
from app.workflows.h3_video import H3I2VParams, build_h3_i2v_graph  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("h3_recover")

TRIM_SEC = 60.0
TARGET = "1080p"

CYBER = {
    "root": "0b045e20-f3f8-4575-b6d9-17ef6a04b77e",
    "positive": (
        "霓虹赛博朋克城市夜景,雨后湿滑街道反射绚丽霓虹灯光,镜头沿街道平稳向前推进,"
        "行人撑全息伞走过,巨型广告牌与全息投影闪烁变换,蒸汽从井盖缓缓升起,"
        "电影级布光,高对比冷暖色调,细节丰富,运镜连贯流畅"
    ),
    # 段序 = seed0+idx:t2v_00061(idx0) / extend_00001(idx1) / extend_00003(idx2) / extend_00005(idx3)
    "segs": ["t2v_00061_.mp4", "extend_00001_.mp4", "extend_00003_.mp4", "extend_00005_.mp4"],
}
JELLY = {
    "root": "a9fb4564-8fad-467a-91c5-a2089fc58933",
    "positive": (
        "深海纪录片风格,一群半透明发光水母在幽蓝深海中缓慢漂浮,生物发光的触手随水流"
        "轻柔摆动,镜头缓慢环绕下潜,悬浮微粒在光束中闪烁,神秘宁静氛围,"
        "自然纪录片摄影质感,细节锐利,运镜平稳连贯"
    ),
    "seed0": 8475387887466176112,
    # t2v_00062(idx0) / extend_00002(idx1) / extend_00004(idx2) / 第4段补提交(idx3)
    "segs": ["t2v_00062_.mp4", "extend_00002_.mp4", "extend_00004_.mp4"],
}


class _SnapReq(BaseModel):
    """params_snapshot 兼容体(与 H3I2VRequest 字段口径一致)。"""

    positive: str
    negative: str = ""
    width: int
    height: int
    duration_sec: float | None = None
    length: int | None
    steps: int
    seed: int | None
    resolution_target: str | None = None
    loras: list = []
    image: str = ""
    worker: str = ""


def _job(session, pid: str) -> Job:
    j = session.exec(select(Job).where(Job.prompt_id == pid)).first()
    if j is None:
        raise RuntimeError(f"Job 不存在: {pid}")
    return j


async def submit_jelly_seg4(client) -> str:
    """补提交水母第 4 段(末帧 i2v)。返回新段 prompt_id(tracker 在本进程内更新)。"""
    data, _ = await client.get_image_bytes("extend_00004_.mp4", "ToIV_h3", "output")
    log.info("extend_00004 下载 %d bytes", len(data))
    with tempfile.TemporaryDirectory(prefix="toiv-rec-") as tmp:
        seg = Path(tmp) / "seg.mp4"
        seg.write_bytes(data)
        frame = Path(tmp) / "frame.jpg"
        await vgen._run_ffmpeg([
            "ffmpeg", "-y", "-sseof", "-0.1", "-i", str(seg),
            "-frames:v", "1", "-q:v", "2", str(frame),
        ])
        frame_bytes = frame.read_bytes()
        if not frame_bytes:
            raise RuntimeError("末帧抽取失败")
        image_name = await client.upload_image(frame_bytes, f"h3_ext_{uuid.uuid4().hex}.jpg")

    params = H3I2VParams(
        positive=JELLY["positive"],
        negative="",
        image=image_name,
        width=1344,
        height=768,
        length=362,
        steps=20,
        seed=JELLY["seed0"] + 3,
        filename_prefix="ToIV_h3/extend",
    )
    graph = build_h3_i2v_graph(params)
    with Session(db_engine) as s:
        owner = s.get(User, _job(s, JELLY["root"]).user_id)
        res = await h3_service.submit_h3_job(
            graph, kind="h3_extend_i2v",
            positive=params.positive, seed=params.seed,
            req=_SnapReq(
                positive=params.positive, width=1344, height=768, length=362,
                steps=20, seed=params.seed, image=image_name, worker=client.base_url,
            ),
            user=owner, session=s, nsfw=False,
        )
    log.info("水母第 4 段已提交: %s (seed=%d)", res["prompt_id"], params.seed)
    return res["prompt_id"]


async def wait_job_terminal(pid: str, timeout: float = 9000.0) -> str:
    """轮询 DB Job 终态(done/error);本脚本进程内 tracker 负责更新。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with Session(db_engine) as s:
            j = s.exec(select(Job).where(Job.prompt_id == pid)).first()
            st = j.status if j else "missing"
        if st in ("done", "error", "missing"):
            return st
        await asyncio.sleep(30)
    return "timeout"


async def rebuild(name: str, root_pid: str, seg_files: list[str], client) -> None:
    """拼接 4 段 → 裁 60s → 回传 H3 input → rewrite_job_result → 挂超分链。"""
    with tempfile.TemporaryDirectory(prefix="toiv-rebuild-") as tmp:
        tmp_dir = Path(tmp)
        seg_paths = []
        for i, fn in enumerate(seg_files):
            data, _ = await client.get_image_bytes(fn, "ToIV_h3", "output")
            p = tmp_dir / f"seg-{i:03d}.mp4"
            p.write_bytes(data)
            seg_paths.append(p)
            log.info("[%s] 段 %d 下载: %s (%d bytes)", name, i, fn, len(data))

        final = tmp_dir / "final.mp4"
        await vgen._concat_trim(seg_paths, final, TRIM_SEC, ffmpeg=vgen._run_ffmpeg)
        final_bytes = final.read_bytes()
        if not final_bytes:
            raise RuntimeError("裁剪合成失败")

    up_name = await client.upload_image(final_bytes, f"toiv_dur_{uuid.uuid4().hex}.mp4")
    url = image_url(client.base_url, {"filename": up_name, "type": "input"})
    vgen.rewrite_job_result(root_pid, [url])
    log.info("[%s] 60s 成片已回写 Job.result: %s", name, url[:110])

    # 清理旧 15s 超分工作目录与产物(同 job_id 会因 source.mp4 已存在而复用旧源!)
    with Session(db_engine) as s:
        jid = str(_job(s, root_pid).id)
    work_dir = vup.product_root() / "frames" / jid
    if work_dir.is_dir():
        shutil.rmtree(work_dir, ignore_errors=True)
        log.info("[%s] 已清旧超分工作目录 %s", name, work_dir)
    old_out = vup.product_root() / f"upscale-{jid}.mp4"
    if old_out.is_file():
        old_out.unlink()
        log.info("[%s] 已删旧超分产物 %s", name, old_out.name)

    if _FLEET:
        armed = vup.maybe_chain_upscale(root_pid, TARGET)
        log.info("[%s] 融合超分链挂载: %s", name, armed)
    else:
        log.warning("[%s] 超分 fleet 离线,终产物保持原生 1344×768 60s", name)


async def wait_upscale(root_pid: str, timeout: float = 5400.0) -> str:
    """等 Job.result 变为超分产物;链放弃(processing→空但仍是原生)或超时则返回当前值。"""
    deadline = time.monotonic() + timeout
    saw_processing = False
    while time.monotonic() < deadline:
        with Session(db_engine) as s:
            j = _job(s, root_pid)
            res = j.result or ""
            post = j.post_status or ""
        if "/api/video/upscale/output/" in res:
            return res
        if post == "processing":
            saw_processing = True
        elif saw_processing and post == "" and "/api/images" in res:
            return res  # 链失败放弃,回落原生
        await asyncio.sleep(20)
    return res


_FLEET: list[str] = []


async def main() -> None:
    global _FLEET
    client = h3_service.get_h3_client()
    log.info("H3 client: %s", client.base_url)
    _FLEET = await vup.healthy_upscale_workers()
    log.info("超分 fleet 在线: %s", _FLEET or "无!")

    # 1. 水母第 4 段提交(H3 实例即刻开跑) + 赛博朋克重建(并行)
    seg4_pid = await submit_jelly_seg4(client)
    await rebuild("cyberpunk", CYBER["root"], CYBER["segs"], client)

    # 2. 等水母第 4 段终态
    st = await wait_job_terminal(seg4_pid)
    log.info("水母第 4 段终态: %s", st)
    if st != "done":
        raise RuntimeError(f"水母第 4 段失败: {st}")

    # 3. 第 4 段产物文件名(history 提取)
    files = await vgen._wait_files(client, seg4_pid, timeout=120)
    seg4_file = files[0]["filename"]
    log.info("水母第 4 段产物: %s", seg4_file)

    # 4. 水母重建 + 挂超分
    await rebuild("jellyfish", JELLY["root"], JELLY["segs"] + [seg4_file], client)

    # 5. 等两条超分链终态
    if _FLEET:
        cyber_url = await wait_upscale(CYBER["root"])
        jelly_url = await wait_upscale(JELLY["root"])
        log.info("=== cyberpunk 终产物: %s", cyber_url)
        log.info("=== jellyfish 终产物: %s", jelly_url)
    else:
        with Session(db_engine) as s:
            log.info("=== cyberpunk 终产物: %s", _job(s, CYBER["root"]).result)
            log.info("=== jellyfish 终产物: %s", _job(s, JELLY["root"]).result)
    print("RECOVER DONE")


if __name__ == "__main__":
    asyncio.run(main())
