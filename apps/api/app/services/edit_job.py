"""FU2 成片剪辑作业编排：EDL → 词级 ASR → packed md → 渲染 → 自评闭环 → 下钻图。

五件服务(edit_pack/edit_edl/edit_render/edit_view/edit_grade)的接线层；
单飞纪律同 demo_cover（同时只跑一个剪辑作业，避免 CPU 渲染互踩）。
产物落 drama_output_root()/edit/<job_id>/，经 routes/film_edit 的 FileResponse 发放。
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from pathlib import Path

from app.services import edit_grade, edit_pack, edit_render, edit_view
from app.services.edit_edl import Edl, materialize_range, word_spans
from app.storage import drama_output_root

log = logging.getLogger("toiv.edit")

_JOBS: dict[str, dict] = {}
_RUNNING = False
_SAFE_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")


def edit_running() -> bool:
    return _RUNNING


def job_status(job_id: str) -> dict:
    return dict(_JOBS.get(job_id) or {})


def workdir(job_id: str) -> Path:
    d = drama_output_root() / "edit" / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def safe_artifact(job_id: str, name: str) -> Path | None:
    """白名单文件名 → 绝对路径;越界/穿越一律 None(路由层 404)。"""
    if not _SAFE_NAME.match(name or ""):
        return None
    p = (workdir(job_id) / name).resolve()
    base = workdir(job_id).resolve()
    return p if str(p).startswith(str(base) + "/") and p.is_file() else None


async def _local_source(url: str, wd: Path, idx: int) -> Path:
    cand = Path(url)
    if cand.is_file():
        return cand
    if url.startswith(("http://", "https://")):
        from app.services.eval_scorers import default_fetch_bytes

        data = await default_fetch_bytes(url)
        out = wd / f"src_{idx}_{url.rsplit('/', 1)[-1].split('?')[0][:60] or 'clip.mp4'}"
        out.write_bytes(data)
        return out
    raise ValueError(f"无法解析的素材来源: {url[:80]}")


async def _words_for(path: Path) -> list[dict]:
    from app.services.board_film import _probe_duration, _transcribe_words

    dur = await _probe_duration(path) or 0.0
    words, _tag = await _transcribe_words(path, 0.0, dur, "")
    return words or []


def _output_timeline_words(edl: Edl, words_by: dict[str, list[dict]]) -> list[dict]:
    """把各源词表按 materialize 后的取用区间平移到成片时间线(下钻图标签用)。"""
    out: list[dict] = []
    offset = 0.0
    for rng in edl.ranges:
        spans = word_spans(words_by.get(rng.source, []))
        s, e = materialize_range(rng, spans)
        for w in words_by.get(rng.source, []):
            if s <= w.get("start", -1) < e:
                out.append({**w, "start": offset + w["start"] - s,
                            "end": offset + min(w.get("end", w["start"]), e) - s})
        offset += max(0.0, e - s)
    return out


async def run_edit_job(job_id: str, edl: Edl, preview: bool = False) -> None:
    global _RUNNING
    rec = _JOBS.setdefault(job_id, {"status": "queued"})
    rec.update(status="running", error="")
    wd = workdir(job_id)
    try:
        sources: dict[str, Path] = {}
        for i, (name, url) in enumerate(edl.sources.items()):
            sources[name] = await _local_source(url, wd, i)
        by_url = dict(zip(edl.sources.values(), sources.values()))

        def resolve(u: str) -> Path:
            return by_url.get(u) or Path(u)
        words_by = {n: await _words_for(p) for n, p in sources.items()}
        (wd / "takes_packed.md").write_text(
            edit_pack.pack_takes([{"name": n, "words": w} for n, w in words_by.items()]),
            encoding="utf-8")

        gain = {"v": ""}

        def render() -> Path:
            res = edit_render.render_edl(
                edl, words_by, resolve, wd, preview=preview,
                audio_gain=gain["v"])
            if not res["ok"]:
                raise RuntimeError(f"EDL 校验不过: {res['issues'][:3]}")
            return Path(res["out"])

        def fix(out: Path, findings: list[dict], metrics: dict) -> bool:
            loud = [f for f in findings if f["kind"] == "loudness_out_of_band"]
            if not loud or gain["v"]:
                return False  # 只修响度一类,且只修一次;其余上报人工
            target = -16.0
            db = target - float(loud[0]["value"])
            gain["v"] = f"volume={10 ** (db / 20):.3f}"
            return True

        res = edit_grade.self_review_loop(render, edit_grade.qa_render, fix, max_rounds=2)
        out = Path(res["out"])
        view = wd / "timeline_view.png"
        edit_view.build_timeline_view(out, _output_timeline_words(edl, words_by), view)
        last = res["rounds"][-1]
        rec.update(
            status="done" if res["ok"] else "needs_review",
            out=out.name, view=view.name, packed="takes_packed.md",
            rounds=len(res["rounds"]), qa=last["metrics"],
            findings=last["findings"], audio_gain=gain["v"],
        )
    except Exception as e:  # noqa: BLE001
        log.exception("edit job %s 失败", job_id)
        rec.update(status="error", error=f"{type(e).__name__}: {e}"[:300])
    finally:
        global _RUNNING
        _RUNNING = False


def submit(edl: Edl, preview: bool = False) -> str | None:
    """单飞提交;已有作业在跑返回 None(路由层 409)。"""
    global _RUNNING
    if _RUNNING:
        return None
    _RUNNING = True
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {"status": "queued"}
    asyncio.create_task(run_edit_job(job_id, edl, preview))
    return job_id
