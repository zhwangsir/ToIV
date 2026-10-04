#!/usr/bin/env python3
"""c_hybrid vs splice2 rain-sample comparison driver (prepared only; needs user sign-off before running).

What it does:
  1. Clone the rain project 16e33f8b93dd45d9abca779816ede9b5 into a new copy project
     (project, characters, first N shots; shot status reset to draft, media / candidates cleared).
     The source project is never written.
  2. Render N shots in one chain in idx order with pipeline=c_hybrid, 2 candidates each,
     worker pinned to http://100.68.100.90:8195:
       shot 0 first frame = full-body makeup image; later shots first frame = last frame of the
       previous shot's picked candidate; MotionContext chaining.
  3. Every queue_prompt is logged to progress.json (prompt_id / worker / shot / seed / context prefix).
     If render_shot fails or times out, results are recovered from Comfy history by prompt_id
     (_wait_video_url saves to the Studio directory). Candidates are rebuilt, the best one is picked
     by face score, and the chain continues.
  4. Resumable: --resume <copy_project_id> skips shots that are already rendered.

Run (background, after sign-off):
  bash apps/api/scripts/run_chybrid_rain_cmp.sh
Code is imported from the worktree (CODE_ROOT); env / DB / NAS come from deploy/.env.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import traceback
from pathlib import Path

DEPLOY_ROOT = Path(os.environ.get("TOIV_DEPLOY_ROOT", "/home/merlin/toiv"))
CODE_ROOT = Path(os.environ.get("CODE_ROOT", str(Path(__file__).resolve().parents[1])))
SRC_PROJECT = "16e33f8b93dd45d9abca779816ede9b5"
ALLOWED_WORKERS = ("http://100.68.100.90:8195", "http://100.68.100.90:8264")


def _load_env() -> None:
    for line in (DEPLOY_ROOT / "deploy/.env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    sys.path.insert(0, str(CODE_ROOT))


class Progress:
    def __init__(self, path: Path):
        self.path = path
        self.data: dict = {}
        if path.is_file():
            self.data = json.loads(path.read_text(encoding="utf-8"))
        self.data.setdefault("prompts", [])
        self.data.setdefault("shots", {})
        self.data.setdefault("events", [])

    def save(self) -> None:
        self.data["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S %z")
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def event(self, msg: str, **kw) -> None:
        e = {"t": time.strftime("%H:%M:%S"), "msg": msg, **kw}
        self.data["events"].append(e)
        print(json.dumps(e, ensure_ascii=False), flush=True)
        self.save()


def _ctx_prefix(graph: dict) -> str:
    for node in graph.values():
        inp = (node or {}).get("inputs") or {}
        fp = inp.get("filename_prefix")
        if isinstance(fp, str) and "context" in fp:
            return fp
    return ""


def _install_prompt_logger(prog: Progress, current: dict) -> None:
    from app.comfy.client import ComfyUIClient

    orig = ComfyUIClient.queue_prompt

    async def logged(self, graph, client_id):
        pid = await orig(self, graph, client_id)
        t8 = (graph.get("9") or {}).get("inputs") or {}
        seed = None
        for node in graph.values():
            inp = (node or {}).get("inputs") or {}
            if "noise_seed" in inp or "seed" in inp:
                seed = inp.get("noise_seed", inp.get("seed"))
                break
        clip_idx = None
        for node in graph.values():
            inp = (node or {}).get("inputs") or {}
            if "clip_index" in inp and isinstance(inp.get("filename_prefix"), str):
                clip_idx = inp.get("clip_index")
        prog.data["prompts"].append(
            {
                "prompt_id": pid,
                "worker": self.base_url,
                "shot_id": current.get("shot_id"),
                "idx": current.get("idx"),
                "seed": seed,
                "task_type": t8.get("task_type"),
                "first_frame_image": (graph.get("7") or {}).get("inputs", {}).get("image"),
                "ctx_prefix": _ctx_prefix(graph),
                "clip_index": clip_idx,
                "queued_at": time.strftime("%H:%M:%S"),
            }
        )
        prog.save()
        return pid

    ComfyUIClient.queue_prompt = logged


def clone_project(session, src_id: str, n_shots: int):
    from app.models import StudioCharacter, StudioProject, StudioShot
    from sqlmodel import select

    src = session.get(StudioProject, src_id)
    assert src is not None, f"source project not found: {src_id}"
    skip = {"id", "created_at", "updated_at"}
    pdata = {k: v for k, v in src.model_dump().items() if k not in skip}
    pdata.update(
        title=f"{src.title} [c_hybrid 对比 {time.strftime('%m%d-%H%M')}]",
        status="storyboard",
        final_url="",
        error="",
    )
    dst = StudioProject(**pdata)
    session.add(dst)
    session.commit()
    session.refresh(dst)
    for ch in session.exec(select(StudioCharacter).where(StudioCharacter.project_id == src_id)).all():
        d = {k: v for k, v in ch.model_dump().items() if k not in skip}
        d["project_id"] = dst.id
        session.add(StudioCharacter(**d))
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == src_id).order_by(StudioShot.idx)
    ).all()[:n_shots]
    for i, sh in enumerate(shots):
        d = {k: v for k, v in sh.model_dump().items() if k not in skip}
        d.update(
            project_id=dst.id,
            idx=i,
            status="draft",
            image_url="",
            video_url="",
            voice_url="",
            final_clip_url="",
            error="",
            candidates_json="[]",
            render_mode="video",
        )
        session.add(StudioShot(**d))
    session.commit()
    return dst


async def recover_shot(session, shot, prog: Progress, worker: str) -> bool:
    """Recover this shot's candidates from Comfy history by the logged prompt_ids, pick the best, write back to DB."""
    from app.services.studio.candidate_pick import score_video_face
    from app.services.studio.renderers.video import _wait_video_url
    from app.services.studio.orchestrator import _studio_local_path

    entries = [p for p in prog.data["prompts"] if p.get("shot_id") == shot.id]
    if not entries:
        return False
    ref_env = os.environ.get("CHY_FACE_REF", "/mnt/toiv-nas/toiv/outputs/drama/final/studio/sample_linxia_front.png")
    ref = Path(ref_env)
    cands = []
    for i, p in enumerate(entries):
        try:
            url = await _wait_video_url(p["worker"] or worker, p["prompt_id"])
        except Exception as e:  # noqa: BLE001
            prog.event("recover_fail", idx=shot.idx, prompt_id=p["prompt_id"], err=str(e)[:200])
            continue
        ctx = ""
        if p.get("ctx_prefix") and p.get("clip_index") is not None:
            ctx = f"{p['ctx_prefix']}_{int(p['clip_index']):05d}.safetensors"
        face = None
        local = _studio_local_path(url)
        if local is not None and ref.is_file():
            try:
                face = (score_video_face(local, ref) or {}).get("face_mean")
            except Exception:  # noqa: BLE001
                face = None
        cands.append(
            {
                "id": f"rec{i}",
                "url": url,
                "seed": p.get("seed"),
                "status": "done",
                "is_picked": False,
                "error": "",
                "context_latent": ctx,
                "pipeline": "c_hybrid",
                "first_frame": p.get("first_frame_image") or "",
                "worker": p.get("worker"),
                "job_id": p["prompt_id"],
                "face_mean": face,
                "recovered": True,
            }
        )
    if not cands:
        return False
    best = max(cands, key=lambda c: (c["face_mean"] is not None, c["face_mean"] or 0.0))
    best["is_picked"] = True
    shot.candidates_json = json.dumps(cands, ensure_ascii=False)
    shot.video_url = best["url"]
    shot.status = "rendered"
    shot.error = ""
    session.add(shot)
    session.commit()
    prog.event("recovered", idx=shot.idx, picked=best["url"], n=len(cands))
    return True


async def main_async(args) -> int:
    _load_env()
    from sqlmodel import Session, select

    from app.db import engine
    from app.deps import get_pool
    from app.models import StudioShot
    from app.services.studio import orchestrator

    worker = args.worker.rstrip("/")
    assert worker in ALLOWED_WORKERS, worker
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    prog = Progress(out / "progress.json")
    current: dict = {}
    _install_prompt_logger(prog, current)

    with Session(engine) as session:
        if args.resume:
            pid = args.resume
        else:
            dst = clone_project(session, args.src, args.shots)
            pid = dst.id
            prog.event("cloned", src=args.src, copy_project=pid)
        prog.data.update(copy_project=pid, src_project=args.src, worker=worker,
                         pipeline="c_hybrid", num_candidates=args.cands)
        prog.save()
        pool = get_pool()
        shots = session.exec(
            select(StudioShot).where(StudioShot.project_id == pid).order_by(StudioShot.idx)
        ).all()
        note = (args.shot_note or "").strip()
        neg_add = [t.strip() for t in (args.shot_negative or "").split(",") if t.strip()]
        if neg_add:
            # StudioShot 无 negative 列、H3 无独立负向口：包装 merge_negative，把附加负向词并进 Avoid 段
            from app.services.studio import prompt_c as _pc

            _orig_merge = _pc.merge_negative

            def _merge_with_extra(existing: str = "", _o=_orig_merge, _add=tuple(neg_add)) -> str:
                base = _o(existing)
                items = {x.strip().lower() for x in base.split(",")}
                miss = [t for t in _add if t.lower() not in items]
                return base + ", " + ", ".join(miss) if miss else base

            _pc.merge_negative = _merge_with_extra
            prog.event("shot_negative_applied", added=neg_add)
        ref_overrides: dict[str, str] = {}
        for item in args.ref_override or []:
            k, sep, v = item.partition("=")
            if not sep or not k.strip() or not v.strip():
                raise SystemExit(f"--ref-override 需 ORIG=NEW: {item!r}")
            ref_overrides[k.strip()] = v.strip()
        outfit_desc = (args.outfit_desc or "").strip()
        if ref_overrides or outfit_desc:
            prog.event("scene_overrides", ref_overrides=ref_overrides, outfit_desc=outfit_desc)
        strip_notes = [t.strip() for t in (args.strip_note or []) if t.strip()]
        for shot in shots[: args.shots]:
            if shot.status in ("rendered", "voiced", "lipsynced", "done") and shot.video_url:
                prog.event("skip_rendered", idx=shot.idx)
                continue
            for sn in strip_notes:
                if sn in (shot.prompt or ""):
                    assert shot.project_id != args.src
                    shot.prompt = (shot.prompt or "").replace(f"，{sn}", "").replace(sn, "").rstrip("，, ")
                    session.add(shot)
                    session.commit()
                    prog.event("shot_note_stripped", idx=shot.idx, note=sn)
            if note and note not in (shot.prompt or ""):
                # 只改对比副本项目的镜头（源项目只读）
                assert shot.project_id != args.src
                shot.prompt = f"{(shot.prompt or '').rstrip('，, ')}，{note}"
                session.add(shot)
                session.commit()
                prog.event("shot_note_applied", idx=shot.idx, note=note)
            current.update(shot_id=shot.id, idx=shot.idx)
            t0 = time.time()
            prog.event("render_start", idx=shot.idx, shot_id=shot.id)
            ok = False
            try:
                await orchestrator.render_shot(
                    session, shot, pool,
                    pipeline="c_hybrid",
                    num_candidates=args.cands,
                    worker_url=worker,
                    auto_pick=True,
                    ref_overrides=ref_overrides or None,
                    outfit_desc=outfit_desc or None,
                )
                session.refresh(shot)
                ok = bool(shot.video_url) and shot.status != "error"
                if not ok:
                    prog.event("render_no_video", idx=shot.idx, status=shot.status, err=shot.error[:300])
            except Exception as e:  # noqa: BLE001
                prog.event("render_exc", idx=shot.idx, err=f"{type(e).__name__}: {e}"[:400],
                           tb=traceback.format_exc()[-800:])
                session.rollback()
                session.refresh(shot)
            if not ok:
                ok = await recover_shot(session, shot, prog, worker)
            session.refresh(shot)
            prog.data["shots"][str(shot.idx)] = {
                "shot_id": shot.id,
                "ok": ok,
                "status": shot.status,
                "video_url": shot.video_url,
                "candidates": json.loads(shot.candidates_json or "[]"),
                "elapsed_s": round(time.time() - t0, 1),
            }
            prog.event("render_end", idx=shot.idx, ok=ok, video=shot.video_url)
            if not ok:
                prog.event("chain_abort", idx=shot.idx)
                return 2
    prog.event("done", copy_project=pid)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=SRC_PROJECT)
    ap.add_argument("--shots", type=int, default=4)
    ap.add_argument("--cands", type=int, default=2)
    ap.add_argument("--worker", default="http://100.68.100.90:8195")
    ap.add_argument("--out", default=str(DEPLOY_ROOT / "tmp/chybrid_rain_cmp"))
    ap.add_argument("--resume", default="", help="copy_project_id; continue an interrupted chain")
    ap.add_argument("--shot-note", default="",
                    help="text appended once to every not-yet-rendered shot prompt of the copy project, "
                         "e.g. '外套无 logo、全程戴帽'")
    ap.add_argument("--shot-negative", default="",
                    help="comma list appended to the Avoid section (H3 has no separate negative input), "
                         "e.g. logo, text, letters, brand")
    ap.add_argument("--ref-override", action="append", default=[],
                    help="scene-level ref override ORIG=NEW (orig URL or file name -> replacement URL); "
                         "keeps @图片 labels/order, character originals untouched. Repeatable.")
    ap.add_argument("--outfit-desc", default="",
                    help="single outfit description replacing jacket/raincoat wording, "
                         "e.g. '纯黑无 logo 无字的连帽风衣'")
    ap.add_argument("--strip-note", action="append", default=[],
                    help="remove a previously appended note from not-yet-rendered copy-project shot prompts")
    ap.add_argument("--recover-only", action="store_true",
                    help="no new submissions: only recover not-yet-written-back shots from progress.json prompt_ids")
    args = ap.parse_args()
    if args.recover_only:
        return asyncio.run(_recover_only(args))
    return asyncio.run(main_async(args))


async def _recover_only(args) -> int:
    _load_env()
    from sqlmodel import Session

    from app.db import engine
    from app.models import StudioShot

    prog = Progress(Path(args.out) / "progress.json")
    with Session(engine) as session:
        done = 0
        for sid in sorted({p["shot_id"] for p in prog.data["prompts"] if p.get("shot_id")}):
            shot = session.get(StudioShot, sid)
            if shot is None or (shot.video_url and shot.status != "error"):
                continue
            done += int(await recover_shot(session, shot, prog, args.worker.rstrip("/")))
    prog.event("recover_only_done", recovered=done)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
