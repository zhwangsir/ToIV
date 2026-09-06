"""应用封面批量生成(应用市场 RunningHub 化,2026-09-06)。

- plan_cover_targets(session):幂等产出待生成清单——cover_url 为空的 is_builtin
  应用逐个一卡;rh-* 社区卡按 base_id 家族去重,同族共享一张家族封面
  (1166 张卡只出 ~16 张家族封面,不烧 GPU 在重复图上)。提示词从
  name+description 派生,强制 SFW 插画风格(NSFW 卡用抽象氛围图,不描述成人内容)。
- generate_covers(pool, targets):自包含执行——txt2img 提交(复用生产
  nextgen/classic 分流构造器 + pool.pick)→ 轮询 worker history → 下载产物
  → 落 content_subdir("app-covers")→ 回写 App.cover_url + Job(kind=app_cover) 建档。
  分批限速(batch_size 并发 + 批间 sleep),不与生产任务抢显存。

不在 api 启动时自动生成(避免拖慢启动);由 admin 端点
POST /api/apps/covers/generate 显式触发(异步任务式,execute=false 可干跑只看清单)。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass

from sqlmodel import Session, select

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.db import engine
from app.models import App, Job
from app.workflows.model_profiles import (
    fit_resolution,
    is_nextgen,
    nextgen_recipe,
    profile_for,
)
from app.workflows.nextgen import NextgenParams, build_nextgen_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

logger = logging.getLogger(__name__)

# 卡片封面横版(前端市场卡比例约 16:9);snap8 对齐
_COVER_W, _COVER_H = 768, 448
_COVER_PREFIX = "appcover"
_DEFAULT_BATCH_SIZE = 2  # 批内并发(封面是小图,2 路够了;不与生产抢显存)
_DEFAULT_BATCH_DELAY_S = 5.0  # 批间隔速
_DEFAULT_PER_TIMEOUT_S = 300.0  # 单图超时(首次载 ckpt 可能 ~2.5min,同 gpu_smoke)
_POLL_S = 3.0


@dataclass
class CoverTarget:
    """一个封面生成目标:单个内置应用,或一个 rh-* 家族(app_ids 全族共享封面)。"""

    key: str  # 去重键:单卡=app id;家族=base_id
    app_ids: list[str]
    name: str
    prompt: str
    is_nsfw: bool = False

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "app_ids": list(self.app_ids),
            "name": self.name,
            "prompt": self.prompt,
            "is_nsfw": self.is_nsfw,
        }


def _clip_text(s: str, n: int) -> str:
    s = " ".join((s or "").split())
    return s[:n]


def _cover_prompt(name: str, description: str, category: str, is_nsfw: bool) -> str:
    """从 name+description 派生 SFW 安全提示词;NSFW 卡强制抽象氛围(不带人/成人语义)。"""
    if is_nsfw:
        return (
            f"abstract moody neon gradient artwork, deep purple and red tones, "
            f"cinematic lighting, flat minimal composition, theme: {_clip_text(name, 60)}, "
            f"no people, no text, no watermark, safe for work"
        )
    theme = _clip_text(f"{name} — {description}", 140)
    return (
        f"minimalist app cover artwork, theme: {theme}, category {category}, "
        f"clean flat vector illustration, soft gradient background, vibrant colors, "
        f"high quality, no text, no watermark, safe for work"
    )


def plan_cover_targets(session: Session) -> list[CoverTarget]:
    """幂等待生成清单:cover_url 非空的一律跳过(重跑只补缺口)。

    rh-* 家族归属从 presets JSON 目录解析(id→base_id),不重建全部工作流图。
    """
    rows = session.exec(
        select(App).where(App.is_builtin.is_(True), App.cover_url == "")  # type: ignore[attr-defined]
    ).all()
    base_id_by_rh: dict[str, str] = {}
    try:
        from app.services.rh_h3_preset_seed import load_preset_rows

        for r in load_preset_rows():
            pid, bid = str(r.get("id") or ""), str(r.get("base_id") or "")
            if pid and bid:
                base_id_by_rh[pid] = bid
    except (FileNotFoundError, ValueError) as e:
        logger.warning("rh presets 目录不可读,rh-* 卡按单卡处理: %s", e)

    by_id = {a.id: a for a in rows}
    targets: list[CoverTarget] = []
    families: dict[str, list[App]] = {}
    for a in rows:
        if a.id.startswith("rh-") and a.id in base_id_by_rh:
            families.setdefault(base_id_by_rh[a.id], []).append(a)
        else:
            targets.append(CoverTarget(
                key=a.id,
                app_ids=[a.id],
                name=a.name,
                prompt=_cover_prompt(a.name, a.description, a.category, a.is_nsfw),
                is_nsfw=a.is_nsfw,
            ))
    for base_id, members in sorted(families.items()):
        # 家族代表:基座卡本身在库就用基座名/简介,否则取排序最前的成员
        rep = by_id.get(base_id) or min(members, key=lambda m: (m.sort, m.name))
        targets.append(CoverTarget(
            key=base_id,
            app_ids=[m.id for m in members],
            name=rep.name,
            prompt=_cover_prompt(rep.name, rep.description, rep.category, rep.is_nsfw),
            is_nsfw=rep.is_nsfw,
        ))
    return targets


def _build_cover_graph(prompt: str) -> tuple[dict, set[str]]:
    """封面 txt2img 图 + pool.pick 所需模型集(复用生产 nextgen/classic 分流)。"""
    ckpt = get_settings().default_ckpt
    if is_nextgen(ckpt):
        prof = profile_for(ckpt)
        recipe = nextgen_recipe(ckpt)
        w, h = fit_resolution(ckpt, _COVER_W, _COVER_H)
        graph = build_nextgen_graph(NextgenParams(
            model_name=ckpt,
            positive=prompt,
            negative="text, watermark, low quality" if prof.neg_prompt else "",
            width=w,
            height=h,
            steps=prof.steps,
            cfg=prof.cfg,
            sampler=prof.sampler,
            scheduler=prof.scheduler,
            batch_size=1,
            filename_prefix="ToIV_appcover",
        ))
        required = {ckpt, recipe.clip_name, recipe.vae_name} if recipe else {ckpt}
        return graph, {r for r in required if r}
    graph = build_txt2img_graph(Txt2ImgParams(
        positive=prompt,
        negative="text, watermark, low quality",
        ckpt_name=ckpt,
        width=_COVER_W,
        height=_COVER_H,
        steps=20,
        filename_prefix="ToIV_appcover",
    ))
    return graph, {ckpt}


async def _wait_files(client: ComfyUIClient, prompt_id: str, timeout_s: float) -> list[dict]:
    """轮询 history 直到产物就绪(同 gpu_smoke 口径);超时抛 TimeoutError。"""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        files = await client.get_result_files(prompt_id)
        if files:
            return files
        await asyncio.sleep(_POLL_S)
    raise TimeoutError(f"超时 {timeout_s:.0f}s 无产物")


def _sniff_ext(content: bytes) -> str:
    """产物扩展名按魔数定(不信任 SaveImage 一定出 png)。"""
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if content.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "webp"
    return "png"


async def _gen_one(
    pool: WorkerPool,
    target: CoverTarget,
    *,
    per_timeout_s: float,
) -> dict:
    """单目标全链:提交 → 轮询 → 下载 → 落盘 → 回写 cover_url。失败收敛为 error 字段。"""
    from app.storage import content_subdir

    out = {"key": target.key, "app_ids": list(target.app_ids), "ok": False}
    client: ComfyUIClient | None = None
    prompt_id = ""
    try:
        graph, required = _build_cover_graph(target.prompt)
        client = await pool.pick(required=required)
        prompt_id = await client.queue_prompt(graph, client_id=f"appcover-{uuid.uuid4().hex[:8]}")
        out["prompt_id"] = prompt_id
    except (ComfyUIError, TimeoutError) as e:
        out["error"] = f"提交失败: {e}"
        return out

    files: list[dict] = []
    try:
        files = await _wait_files(client, prompt_id, per_timeout_s)
        first = files[0]
        content, _ = await client.get_image_bytes(
            first["filename"], first.get("subfolder", ""), first.get("type", "output")
        )
        if not content:
            raise RuntimeError("产物字节为空(0 字节假成功)")
        name = f"{_COVER_PREFIX}-{uuid.uuid4().hex}.{_sniff_ext(content)}"
        dest = content_subdir("app-covers") / name
        dest.write_bytes(content)
        url = f"/api/apps/covers/file/{name}"
    except (ComfyUIError, TimeoutError, RuntimeError, OSError) as e:
        out["error"] = str(e)[:300]
        return out

    # 回写 cover_url(家族目标批量共享同一 URL)+ Job 建档;独立 session
    # (后台任务不借用请求会话,同 tracker 纪律)
    try:
        with Session(engine) as s:
            now_ids = []
            for aid in target.app_ids:
                a = s.get(App, aid)
                if a is not None and not a.cover_url:  # 仍空才写(已被人工上传的不覆盖)
                    a.cover_url = url
                    s.add(a)
                    now_ids.append(aid)
            job = Job(
                tenant_id="",
                user_id="",  # 系统维护作业,无属主(不出现在任何用户任务列表)
                prompt_id=prompt_id,
                worker=client.base_url,
                kind="app_cover",
                status="done",
                prompt=target.prompt[:500],
                seed=0,
                result=json.dumps([url], ensure_ascii=False),
                params=json.dumps(
                    {"cover_key": target.key, "app_ids": target.app_ids}, ensure_ascii=False
                ),
            )
            s.add(job)
            s.commit()
        out["ok"] = True
        out["url"] = url
        out["written"] = now_ids
    except Exception as e:  # noqa: BLE001 — 产物已落盘,建档失败不炸批次
        logger.warning("封面回写失败(图已落盘 %s): %s", name, e, exc_info=True)
        out["error"] = f"回写失败: {e}"
    return out


async def generate_covers(
    pool: WorkerPool,
    targets: list[CoverTarget],
    *,
    batch_size: int = _DEFAULT_BATCH_SIZE,
    batch_delay_s: float = _DEFAULT_BATCH_DELAY_S,
    per_timeout_s: float = _DEFAULT_PER_TIMEOUT_S,
) -> dict:
    """分批限速执行封面生成;返回汇总 dict。任何单点失败不中断批次。"""
    started = time.monotonic()
    results: list[dict] = []
    for i in range(0, len(targets), batch_size):
        batch = targets[i : i + batch_size]
        results.extend(await asyncio.gather(*(
            _gen_one(pool, t, per_timeout_s=per_timeout_s) for t in batch
        )))
        if i + batch_size < len(targets):
            await asyncio.sleep(batch_delay_s)
    ok = [r for r in results if r.get("ok")]
    failed = [r for r in results if not r.get("ok")]
    summary = {
        "total": len(results),
        "generated": len(ok),
        "failed": len(failed),
        "duration_ms": int((time.monotonic() - started) * 1000),
        "errors": [{"key": r["key"], "error": r.get("error", "")} for r in failed],
        "items": results,
    }
    logger.info(
        "应用封面批次完成: %d/%d 成功 (%dms)", len(ok), len(results), summary["duration_ms"]
    )
    return summary


# ---------------------------------------------------------------------------
# 任务式触发(单飞:重复触发 409,防批量烧 GPU)
# ---------------------------------------------------------------------------
_gen_task: asyncio.Task | None = None


def generation_running() -> bool:
    return _gen_task is not None and not _gen_task.done()


def spawn_generation(
    pool: WorkerPool,
    targets: list[CoverTarget],
    *,
    batch_size: int = _DEFAULT_BATCH_SIZE,
) -> asyncio.Task | None:
    """fire-and-forget 启动生成批次(保留强引用);已在运行返回 None。"""
    global _gen_task
    if generation_running():
        return None
    _gen_task = asyncio.create_task(
        generate_covers(pool, targets, batch_size=batch_size)
    )
    return _gen_task


def last_generation_summary() -> dict | None:
    """最近一次批次结果(无则 None);运行中返回进行态占位。"""
    if _gen_task is None:
        return None
    if not _gen_task.done():
        return {"running": True}
    if _gen_task.cancelled():
        return {"running": False, "cancelled": True}
    exc = _gen_task.exception()
    if exc is not None:
        return {"running": False, "error": str(exc)[:300]}
    out = {"running": False}
    out.update(_gen_task.result())
    return out
