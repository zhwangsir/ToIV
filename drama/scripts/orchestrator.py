"""短剧生成编排器（M5）：分阶段运行 + 自动质量门 + 人工审核暂停 + 断点续跑。

阶段流水线:
    storyboard → characters → shots → upscale(可选, 4K) → audio → final

每个阶段产物落盘后自动执行质量门检查（quality_gates）；
--review-after-stage 模式下每阶段通过后暂停等待人工审核，
人工确认后以 --continue --approve <stage> 继续。

状态持久化在 <output_dir>/orchestrator_state.json，
中断后随时可用 --continue 从断点恢复（已完成的阶段自动跳过，
单镜产物复用 generate_v2 的文件级断点续跑能力）。

用法:
    # 全自动
    python orchestrator.py novel.txt output/projects/demo --auto

    # 每阶段暂停待审
    python orchestrator.py novel.txt output/projects/demo --review-after-stage

    # 审核通过后继续
    python orchestrator.py novel.txt output/projects/demo --continue --approve storyboard

    # 4K 成片 + 多 worker 并行超分
    TOIV_4K_WORKERS=http://192.168.71.127:8189,http://192.168.71.115:8188 \
        python orchestrator.py novel.txt out --auto --4k

环境变量:
    TOIV_GENERATE_V2_MOCK=1   mock 产物，跳过真实 GPU 调用（继承 generate_v2）
    TOIV_4K_WORKERS           逗号分隔的 ComfyUI worker 列表，启用并行超分
    TOIV_VLM_URL              角色一致性 VLM 端点（默认 studio04 :9303）
    TOIV_GATE_STRICT_VLM=1    VLM 不可达时判定阶段失败（默认软通过）
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parents[1]
for _p in (SCRIPT_DIR, ROOT_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import generate_v2 as g2
import quality_gates as qg

logger = logging.getLogger(__name__)

# 阶段顺序（upscale 仅在 --4k 时启用，见 run_pipeline）
STAGES = ["storyboard", "characters", "shots", "upscale", "audio", "final"]

STATE_FILE = "orchestrator_state.json"
STORYBOARD_FILE = "storyboard/storyboard_latest.json"

FORCE_MOCK = os.environ.get("TOIV_GENERATE_V2_MOCK", "0") == "1"
STRICT_VLM = os.environ.get("TOIV_GATE_STRICT_VLM", "0") == "1"
VLM_URL = os.environ.get("TOIV_VLM_URL") or qg.DEFAULT_VLM_URL


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


# ---------------------------------------------------------------------------
# 状态持久化
# ---------------------------------------------------------------------------
class PipelineState:
    """编排状态：阶段进度、审核记录、错误信息。JSON 持久化。"""

    def __init__(self, output_dir: Path):
        self.output_dir = output_dir
        self.path = output_dir / STATE_FILE
        self.data: dict[str, Any] = {
            "version": 1,
            "options": {},
            "stages": {
                s: {"status": "pending", "error": None, "gate_errors": [],
                    "started_at": None, "finished_at": None}
                for s in STAGES
            },
            "approvals": [],
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }

    @classmethod
    def load(cls, output_dir: Path) -> "PipelineState":
        st = cls(output_dir)
        if st.path.exists():
            try:
                saved = json.loads(st.path.read_text(encoding="utf-8"))
                # 合并：保留已保存的阶段状态，新字段用默认值补齐
                st.data.update({k: v for k, v in saved.items() if k != "stages"})
                for name, info in saved.get("stages", {}).items():
                    if name in st.data["stages"]:
                        st.data["stages"][name].update(info)
            except Exception as e:
                logger.warning("状态文件损坏，从头开始: %s", e)
        return st

    def save(self) -> None:
        self.data["updated_at"] = _now_iso()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def status(self, stage: str) -> str:
        return self.data["stages"][stage]["status"]

    def mark(self, stage: str, status: str, error: Optional[str] = None,
             gate_errors: Optional[list[str]] = None) -> None:
        info = self.data["stages"][stage]
        info["status"] = status
        if status == "running":
            info["started_at"] = _now_iso()
        if status in ("done", "failed", "awaiting_review"):
            info["finished_at"] = _now_iso()
        if error is not None:
            info["error"] = error
        if gate_errors is not None:
            info["gate_errors"] = gate_errors
        self.save()

    def approve(self, stage: str) -> None:
        if stage not in self.data["approvals"]:
            self.data["approvals"].append(stage)
        self.save()

    def approved(self, stage: str) -> bool:
        return stage in self.data["approvals"]


# ---------------------------------------------------------------------------
# 分镜持久化（阶段间传递 shots 的 video_file/video_file_4k 变更）
# ---------------------------------------------------------------------------
def _storyboard_path(dirs: dict[str, Path]) -> Path:
    return dirs["root"] / STORYBOARD_FILE


def _load_storyboard(dirs: dict[str, Path]) -> dict:
    path = _storyboard_path(dirs)
    if not path.exists():
        raise FileNotFoundError(f"分镜不存在: {path}（需先完成 storyboard 阶段）")
    return json.loads(path.read_text(encoding="utf-8"))


def _save_storyboard(dirs: dict[str, Path], storyboard: dict) -> None:
    path = _storyboard_path(dirs)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(storyboard, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# 各阶段执行 + 质量门
# ---------------------------------------------------------------------------
async def _stage_storyboard(ctx: dict[str, Any]) -> list[str]:
    """读取小说并生成分镜。返回质量门错误列表。"""
    dirs = ctx["dirs"]
    novel_text = g2._read_novel(ctx["novel_path"])
    logger.info("[stage/storyboard] 小说 %d 字符", len(novel_text))
    storyboard = await g2.novel_to_storyboard(
        novel_text,
        max_shots=ctx["max_shots"],
        save=True,
        output_dir=dirs["storyboard"],
    )
    # novel_to_storyboard 内部已写 storyboard_latest.json；重新规范落盘一次防软链接差异
    _save_storyboard(dirs, storyboard)
    errs = qg.check_storyboard(storyboard)
    logger.info("[stage/storyboard] %d 镜, 质量门错误 %d 条",
                len(storyboard.get("shots", [])), len(errs))
    return errs


async def _stage_characters(ctx: dict[str, Any]) -> list[str]:
    """角色定妆关键帧 + 逐张质量门（存在性/尺寸/非全黑/模糊）。"""
    dirs = ctx["dirs"]
    storyboard = _load_storyboard(dirs)
    character_frames = await g2._generate_character_keyframes(storyboard, dirs["root"])
    ctx["character_frames"] = character_frames

    errs: list[str] = []
    for name, path in character_frames.items():
        p = Path(path)
        for check in (
            qg.check_keyframe(p),
            qg.check_blur(p),
        ):
            if check:
                errs.append(f"角色[{name}] {check}")
    logger.info("[stage/characters] %d 个角色关键帧, 质量门错误 %d 条",
                len(character_frames), len(errs))
    return errs


async def _stage_shots(ctx: dict[str, Any]) -> list[str]:
    """逐镜关键帧 + 视频生成；关键帧做模糊/尺寸/角色一致性检查，视频做可播放检查。"""
    dirs = ctx["dirs"]
    storyboard = _load_storyboard(dirs)
    characters = storyboard.get("characters", [])
    character_frames = ctx.get("character_frames") or {}

    # 断点续跑时 characters 阶段已 done，需从磁盘重建 character_frames
    if not character_frames:
        try:
            import character_keyframes as ck
            for c in characters:
                name = c.get("name", "").strip()
                if not name:
                    continue
                try:
                    p = ck.get_character_keyframe_path(
                        name, dirs["root"], description=c.get("description", "")
                    )
                    if p.exists():
                        character_frames[name] = p
                except Exception:
                    continue
        except Exception:
            pass
        ctx["character_frames"] = character_frames

    keyframes_dir = dirs["shots"] / "keyframes"
    keyframes_dir.mkdir(parents=True, exist_ok=True)

    errs: list[str] = []
    shots = storyboard.get("shots", [])
    for shot in shots:
        sid = shot["id"]
        prompt = g2.build_shot_keyframe_prompt(shot, character_frames)
        keyframe = g2._generate_keyframe(shot, prompt, keyframes_dir, character_frames)

        # 关键帧质量门
        if keyframe is None:
            errs.append(f"镜头[{sid}] 关键帧生成失败")
        else:
            kf_err = qg.check_keyframe(keyframe)
            if kf_err:
                errs.append(f"镜头[{sid}] {kf_err}")
            # mock 占位图为纯色图，模糊/一致性检查仅在真实生成时启用
            if not FORCE_MOCK:
                blur_err = qg.check_blur(keyframe)
                if blur_err:
                    errs.append(f"镜头[{sid}] {blur_err}")
                # 角色一致性（VLM）
                for cname in shot.get("characters", []):
                    ref = character_frames.get(cname)
                    if ref and Path(ref).exists():
                        cons_err = qg.check_character_consistency(
                            keyframe, Path(ref), vlm_url=VLM_URL, strict=STRICT_VLM
                        )
                        if cons_err:
                            errs.append(f"镜头[{sid}] {cons_err}")

        clip = await g2._generate_video_for_shot(shot, keyframe or Path(""), dirs["shots"], characters)
        if clip is None:
            errs.append(f"镜头[{sid}] 视频生成失败")
        else:
            v_err = qg.check_video(clip)
            if v_err:
                errs.append(f"镜头[{sid}] {v_err}")

    _save_storyboard(dirs, storyboard)
    logger.info("[stage/shots] %d 镜完成, 质量门错误 %d 条", len(shots), len(errs))
    return errs


def _upscale_clip(src: Path, output: Path) -> Path:
    """4K 超分：TOIV_4K_WORKERS 设置时走多 worker 并行脚本，否则单 worker。"""
    workers_env = os.environ.get("TOIV_4K_WORKERS", "").strip()
    if workers_env:
        script = ROOT_DIR / "scripts" / "video_4k_upscale_parallel.py"
        if script.exists():
            import subprocess

            cmd = [
                sys.executable, str(script), str(src),
                "--output", str(output),
                "--workers", workers_env,
                "--resume",
            ]
            logger.info("[4k] 并行超分(workers=%s): %s", workers_env, src.name)
            subprocess.run(cmd, check=True)
            return output
        logger.warning("[4k] 并行超分脚本不存在 %s，回退单 worker", script)
    return g2._upscale_4k(src, output)


async def _stage_upscale(ctx: dict[str, Any]) -> list[str]:
    """4K 超分阶段：逐镜 clip → clip_4k.mp4，重写 storyboard video_file。"""
    dirs = ctx["dirs"]
    storyboard = _load_storyboard(dirs)
    errs: list[str] = []

    for shot in storyboard.get("shots", []):
        sid = shot["id"]
        if shot.get("video_file_4k"):
            continue  # 断点续跑：已超分
        video_file = shot.get("video_file")
        if not video_file or not Path(video_file).exists():
            errs.append(f"镜头[{sid}] 无视频片段，无法超分")
            continue
        upscaled = dirs["shots"] / sid / "clip_4k.mp4"
        try:
            await asyncio.to_thread(_upscale_clip, Path(video_file), upscaled)
            u_err = qg.check_resolution(upscaled, 3840, 2160)
            if u_err:
                errs.append(f"镜头[{sid}] {u_err}")
            else:
                shot["video_file_4k"] = str(upscaled)
                # 拼接改用 4K 片段
                shot["video_file"] = str(upscaled)
        except Exception as e:
            errs.append(f"镜头[{sid}] 4K 超分失败: {e}")

    _save_storyboard(dirs, storyboard)
    logger.info("[stage/upscale] 质量门错误 %d 条", len(errs))
    return errs


async def _stage_audio(ctx: dict[str, Any]) -> list[str]:
    """配音阶段：字幕 ASS + TTS，逐条 WAV 质量门。"""
    dirs = ctx["dirs"]
    storyboard = _load_storyboard(dirs)
    narration = storyboard.get("narration", [])

    errs: list[str] = []
    if not narration:
        logger.warning("[stage/audio] 分镜无 narration，跳过配音")
        return errs

    subtitle_path = dirs["final"] / "subtitle.ass"
    g2._build_subtitle_ass(narration, subtitle_path)
    audio_results = await asyncio.to_thread(g2._generate_audio, narration, dirs["audio"])
    for r in audio_results:
        p = Path(r.get("path", ""))
        a_err = qg.check_audio(p)
        if a_err:
            errs.append(a_err)
    logger.info("[stage/audio] %d 条配音, 质量门错误 %d 条", len(audio_results), len(errs))
    return errs


async def _stage_final(ctx: dict[str, Any]) -> list[str]:
    """剪辑成片 + 成片质量门（4K 时校验 3840×2160）。"""
    dirs = ctx["dirs"]
    storyboard = _load_storyboard(dirs)
    shots = storyboard.get("shots", [])
    narration = storyboard.get("narration", [])

    final_video = await asyncio.to_thread(
        g2._concat_and_mux, shots, narration, dirs["audio"], dirs["final"],
        ctx["target_4k"],
    )
    ctx["artifacts"]["final_video"] = str(final_video)

    errs: list[str] = []
    expected = (3840, 2160) if ctx["target_4k"] else None
    f_err = qg.check_final(final_video, expected_resolution=expected)
    if f_err:
        errs.append(f_err)
    logger.info("[stage/final] 成片 %s, 质量门错误 %d 条", final_video, len(errs))
    return errs


STAGE_FUNCS = {
    "storyboard": _stage_storyboard,
    "characters": _stage_characters,
    "shots": _stage_shots,
    "upscale": _stage_upscale,
    "audio": _stage_audio,
    "final": _stage_final,
}


# ---------------------------------------------------------------------------
# 主编排
# ---------------------------------------------------------------------------
async def run_pipeline(
    novel_path: Path,
    output_dir: Path,
    *,
    target_4k: bool = False,
    max_shots: int = 20,
    review_after_stage: bool = False,
    resume: bool = False,
    approve: Optional[str] = None,
) -> dict[str, Any]:
    """执行编排管线。

    Returns:
        {"status": "done"|"failed"|"awaiting_review", "stage": str|None,
         "state": dict, "artifacts": dict}
    """
    dirs = g2._ensure_dirs(output_dir)
    state = PipelineState.load(output_dir) if resume else PipelineState(output_dir)

    state.data["options"] = {
        "novel_path": str(novel_path),
        "output_dir": str(output_dir),
        "target_4k": target_4k,
        "max_shots": max_shots,
        "mode": "review-after-stage" if review_after_stage else "auto",
    }
    state.save()

    # 人工审核确认：把 awaiting_review 的阶段推进为 done
    if approve:
        if state.status(approve) != "awaiting_review":
            return {
                "status": "failed",
                "stage": approve,
                "state": state.data,
                "artifacts": {},
                "error": f"阶段 {approve} 当前状态为 {state.status(approve)}，无需审核确认",
            }
        state.approve(approve)
        state.mark(approve, "done")
        logger.info("[review] 阶段 %s 人工审核通过", approve)

    active_stages = [s for s in STAGES if s != "upscale" or target_4k]

    ctx: dict[str, Any] = {
        "dirs": dirs,
        "novel_path": novel_path,
        "target_4k": target_4k,
        "max_shots": max_shots,
        "artifacts": {},
        "character_frames": {},
    }

    for stage in active_stages:
        status = state.status(stage)
        if status == "done":
            logger.info("[orchestrator] 阶段 %s 已完成，跳过", stage)
            continue
        if status == "awaiting_review":
            logger.info(
                "[orchestrator] 阶段 %s 等待人工审核: python %s %s %s --continue --approve %s",
                stage, __file__, novel_path, output_dir, stage,
            )
            return {"status": "awaiting_review", "stage": stage,
                    "state": state.data, "artifacts": ctx["artifacts"]}

        # 执行阶段
        state.mark(stage, "running")
        logger.info("=" * 60)
        logger.info("[orchestrator] 阶段 %s 开始", stage)
        logger.info("=" * 60)
        try:
            gate_errors = await STAGE_FUNCS[stage](ctx)
        except Exception as e:
            logger.exception("[orchestrator] 阶段 %s 执行异常", stage)
            state.mark(stage, "failed", error=str(e))
            return {"status": "failed", "stage": stage, "state": state.data,
                    "artifacts": ctx["artifacts"], "error": str(e)}

        if gate_errors:
            for e in gate_errors:
                logger.error("[gate/%s] %s", stage, e)
            state.mark(stage, "failed", error="质量门未通过", gate_errors=gate_errors)
            return {"status": "failed", "stage": stage, "state": state.data,
                    "artifacts": ctx["artifacts"],
                    "error": f"质量门未通过: {len(gate_errors)} 条", "gate_errors": gate_errors}

        # 阶段通过
        if review_after_stage:
            state.mark(stage, "awaiting_review")
            logger.info("[orchestrator] 阶段 %s 质量门通过，暂停等待人工审核", stage)
            return {"status": "awaiting_review", "stage": stage,
                    "state": state.data, "artifacts": ctx["artifacts"]}
        state.mark(stage, "done")

    # 全部完成：写项目元数据
    storyboard = _load_storyboard(dirs)
    timings = {}
    artifacts = dict(ctx["artifacts"])
    artifacts["storyboard"] = str(_storyboard_path(dirs))
    meta = g2._save_project_meta(dirs, storyboard, timings, artifacts)
    artifacts["project_json"] = str(meta)

    logger.info("[orchestrator] 全部阶段完成: %s", output_dir)
    return {"status": "done", "stage": None, "state": state.data, "artifacts": artifacts}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="短剧生成编排器（M5）")
    ap.add_argument("novel", type=Path, help="小说文本文件")
    ap.add_argument("output_dir", type=Path, help="项目输出目录")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--auto", action="store_true", help="全自动，不停顿")
    mode.add_argument("--review-after-stage", action="store_true",
                      help="每阶段质量门通过后暂停，等待人工审核")
    ap.add_argument("--continue", dest="resume", action="store_true",
                    help="断点续跑：从 orchestrator_state.json 恢复")
    ap.add_argument("--approve", metavar="STAGE",
                    help=f"人工审核通过指定阶段（{'/'.join(STAGES)}）")
    ap.add_argument("--4k", dest="target_4k", action="store_true", help="4K 超分成片")
    ap.add_argument("--max-shots", type=int, default=20, help="最大镜头数")
    return ap


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _build_parser().parse_args()

    if not args.novel.exists():
        print(f"错误：小说文件不存在 {args.novel}", file=sys.stderr)
        return 1
    if args.approve and args.approve not in STAGES:
        print(f"错误：--approve 必须是 {STAGES} 之一", file=sys.stderr)
        return 1
    if not args.auto and not args.review_after_stage:
        # 默认全自动
        args.auto = True

    result = asyncio.run(run_pipeline(
        args.novel,
        args.output_dir,
        target_4k=args.target_4k,
        max_shots=args.max_shots,
        review_after_stage=args.review_after_stage,
        resume=args.resume,
        approve=args.approve,
    ))

    status = result["status"]
    if status == "done":
        print(json.dumps({"status": "done", "artifacts": result["artifacts"]},
                         ensure_ascii=False, indent=2))
        return 0
    if status == "awaiting_review":
        print(json.dumps({
            "status": "awaiting_review",
            "stage": result["stage"],
            "hint": f"人工审核后运行: python {Path(__file__).name} {args.novel} {args.output_dir} "
                    f"--continue --approve {result['stage']}",
        }, ensure_ascii=False, indent=2))
        return 0
    print(json.dumps({
        "status": "failed",
        "stage": result.get("stage"),
        "error": result.get("error"),
        "gate_errors": result.get("gate_errors", []),
    }, ensure_ascii=False, indent=2), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
