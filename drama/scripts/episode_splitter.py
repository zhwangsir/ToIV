"""长小说自动分集（M6）：把长篇文本拆分为多集，逐集调用 M5 编排管线。

拆分策略:
1. 优先按章节标记拆分（第X章/第X回/Chapter N 等），按目标字数聚合成集；
2. 无章节标记时按段落（空行）边界聚合到目标字数；
3. 每集独立调用 orchestrator.py 跑 M5 管线（串行，避免 GPU 过载）。

用法:
    # 仅拆分，生成 episodes.json 清单 + episode_XX.txt
    python episode_splitter.py novel_long.txt --split-only --target-chars 8000

    # 拆分并逐集生成（全自动）
    python episode_splitter.py novel_long.txt --output-root drama/output/series/demo \
        --auto --4k

    # 从已有清单断点续跑某几集
    python episode_splitter.py novel_long.txt --output-root ... --continue --episodes 1,3
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

SCRIPT_DIR = Path(__file__).resolve().parent
ORCHESTRATOR = SCRIPT_DIR / "orchestrator.py"

logger = logging.getLogger(__name__)

DEFAULT_TARGET_CHARS = 8000  # 每集目标字数（≈5 分钟成片，~50 镜 × 6s）

# 章节标记：第X章/第X回/第X节/Chapter N/CHAPTER N
_CHAPTER_RE = re.compile(
    r"^\s*(第[0-9一二三四五六七八九十百千零]+[章回节卷部]|Chapter\s+\d+|CHAPTER\s+\d+).*$",
    re.MULTILINE,
)

MANIFEST_FILE = "episodes.json"


# ---------------------------------------------------------------------------
# 拆分
# ---------------------------------------------------------------------------
def _split_into_units(text: str) -> list[dict[str, Any]]:
    """把全文拆成最小聚合单元（章节或段落组）。返回 [{title, text}]。"""
    matches = list(_CHAPTER_RE.finditer(text))
    if len(matches) >= 2:
        units: list[dict[str, Any]] = []
        # 第一章之前的内容（序言等）并入第一章
        for i, m in enumerate(matches):
            start = m.start()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            body = text[start:end].strip()
            if body:
                units.append({"title": m.group(1), "text": body})
        if matches[0].start() > 0:
            preamble = text[: matches[0].start()].strip()
            if preamble and units:
                units[0]["text"] = preamble + "\n\n" + units[0]["text"]
            elif preamble:
                units.insert(0, {"title": "序言", "text": preamble})
        return units

    # 无章节：按空行分段落，聚合成 ~2000 字的单元
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    units = []
    buf: list[str] = []
    buf_len = 0
    for p in paragraphs:
        buf.append(p)
        buf_len += len(p)
        if buf_len >= 2000:
            units.append({"title": "", "text": "\n\n".join(buf)})
            buf, buf_len = [], 0
    if buf:
        units.append({"title": "", "text": "\n\n".join(buf)})
    return units


def split_novel(text: str, target_chars: int = DEFAULT_TARGET_CHARS) -> list[dict[str, Any]]:
    """把长小说拆分为多集。

    Returns:
        [{"index": 1, "title": "第1集", "text": "...", "chars": int}, ...]
    """
    text = text.strip()
    if not text:
        return []
    if len(text) <= target_chars:
        return [{"index": 1, "title": "第1集", "text": text, "chars": len(text)}]

    units = _split_into_units(text)
    episodes: list[dict[str, Any]] = []
    buf: list[str] = []
    titles: list[str] = []
    buf_len = 0

    def _flush() -> None:
        nonlocal buf, titles, buf_len
        if not buf:
            return
        idx = len(episodes) + 1
        body = "\n\n".join(buf)
        # 集标题取首末单元标题，便于检索
        ep_title = titles[0] if len(titles) == 1 else (
            f"{titles[0]}–{titles[-1]}" if titles and titles[-1] else (titles[0] if titles else "")
        )
        episodes.append({
            "index": idx,
            "title": f"第{idx}集" + (f"（{ep_title}）" if ep_title else ""),
            "text": body,
            "chars": len(body),
        })
        buf, titles, buf_len = [], [], 0

    for unit in units:
        # 单个单元就超标：长章节按段落强制二次拆分
        if len(unit["text"]) > target_chars * 1.5 and not titles and not buf:
            sub_units = [
                {"title": unit["title"], "text": s}
                for s in _hard_split(unit["text"], target_chars)
            ]
        else:
            sub_units = [unit]
        for su in sub_units:
            if buf_len + len(su["text"]) > target_chars and buf:
                _flush()
            buf.append(su["text"])
            if su["title"]:
                titles.append(su["title"])
            buf_len += len(su["text"])
    _flush()
    return episodes


def _hard_split(text: str, target_chars: int) -> list[str]:
    """超长章节按段落边界强制拆分。"""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    parts: list[str] = []
    buf: list[str] = []
    buf_len = 0
    for p in paragraphs:
        if buf_len + len(p) > target_chars and buf:
            parts.append("\n\n".join(buf))
            buf, buf_len = [], 0
        buf.append(p)
        buf_len += len(p)
    if buf:
        parts.append("\n\n".join(buf))
    return parts


def split_novel_file(
    novel_path: Path,
    out_dir: Path,
    target_chars: int = DEFAULT_TARGET_CHARS,
) -> Path:
    """拆分小说文件，写 episode_XX.txt + episodes.json 清单。返回清单路径。"""
    text = novel_path.read_text(encoding="utf-8")
    episodes = split_novel(text, target_chars=target_chars)

    out_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, Any]] = []
    for ep in episodes:
        fname = f"episode_{ep['index']:02d}.txt"
        (out_dir / fname).write_text(ep["text"], encoding="utf-8")
        manifest.append({
            "index": ep["index"],
            "title": ep["title"],
            "chars": ep["chars"],
            "file": fname,
            "status": "pending",
        })
    manifest_path = out_dir / MANIFEST_FILE
    manifest_path.write_text(
        json.dumps({
            "source": str(novel_path),
            "target_chars": target_chars,
            "num_episodes": len(manifest),
            "episodes": manifest,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logger.info("拆分完成: %d 集 -> %s", len(manifest), manifest_path)
    return manifest_path


def load_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def save_manifest(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# 逐集执行 M5 管线
# ---------------------------------------------------------------------------
def run_episodes(
    manifest_path: Path,
    output_root: Path,
    *,
    orchestrator_args: Optional[list[str]] = None,
    only: Optional[list[int]] = None,
    resume: bool = False,
) -> dict[str, Any]:
    """按清单逐集调用 orchestrator.py（串行）。返回各集结果。"""
    data = load_manifest(manifest_path)
    episodes_dir = manifest_path.parent
    results: dict[str, Any] = {}

    for ep in data["episodes"]:
        idx = ep["index"]
        if only and idx not in only:
            continue
        if ep.get("status") == "done" and resume:
            logger.info("[episode %d] 已完成，跳过", idx)
            results[str(idx)] = {"status": "done", "skipped": True}
            continue

        ep_novel = episodes_dir / ep["file"]
        ep_out = output_root / f"ep{idx:02d}"
        cmd = [sys.executable, str(ORCHESTRATOR), str(ep_novel), str(ep_out)]
        cmd += orchestrator_args or ["--auto"]
        if resume:
            cmd.append("--continue")

        logger.info("=" * 60)
        logger.info("[episode %d/%d] %s (%d 字)", idx, data["num_episodes"], ep["title"], ep["chars"])
        logger.info("=" * 60)
        proc = subprocess.run(cmd, capture_output=False)
        if proc.returncode == 0:
            ep["status"] = "done"
            results[str(idx)] = {"status": "done", "output_dir": str(ep_out)}
        else:
            ep["status"] = "failed"
            results[str(idx)] = {"status": "failed", "output_dir": str(ep_out),
                                 "returncode": proc.returncode}
            save_manifest(manifest_path, data)
            logger.error("[episode %d] 生成失败(rc=%d)，中止后续集", idx, proc.returncode)
            break
        save_manifest(manifest_path, data)

    return {"manifest": str(manifest_path), "results": results}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="长小说自动分集 + 逐集 M5 管线（M6）")
    ap.add_argument("novel", type=Path, help="长篇小说文本文件")
    ap.add_argument("--target-chars", type=int, default=DEFAULT_TARGET_CHARS,
                    help=f"每集目标字数（默认 {DEFAULT_TARGET_CHARS}，≈5 分钟成片）")
    ap.add_argument("--episodes-dir", type=Path, default=None,
                    help="分集文本与清单输出目录（默认 <output_root>/episodes 或 ./episodes）")
    ap.add_argument("--output-root", type=Path, default=None, help="各集成片输出根目录")
    ap.add_argument("--split-only", action="store_true", help="仅拆分，不执行生成")
    ap.add_argument("--continue", dest="resume", action="store_true",
                    help="断点续跑：已完成集跳过，失败集重跑")
    ap.add_argument("--episodes", default=None, help="只跑指定集，如 1,3,5")
    ap.add_argument("--auto", action="store_true", help="传递给 orchestrator：全自动")
    ap.add_argument("--review-after-stage", action="store_true",
                    help="传递给 orchestrator：每阶段暂停待审")
    ap.add_argument("--4k", dest="target_4k", action="store_true",
                    help="传递给 orchestrator：4K 成片")
    ap.add_argument("--max-shots", type=int, default=None,
                    help="传递给 orchestrator：每集最大镜头数")
    args = ap.parse_args()

    if not args.novel.exists():
        print(f"错误：小说文件不存在 {args.novel}", file=sys.stderr)
        return 1

    episodes_dir = args.episodes_dir
    if episodes_dir is None:
        episodes_dir = (args.output_root or Path("series_output")) / "episodes"

    # 拆分（续跑时清单已存在则复用）
    manifest_path = episodes_dir / MANIFEST_FILE
    if args.resume and manifest_path.exists():
        logger.info("复用已有清单: %s", manifest_path)
    else:
        manifest_path = split_novel_file(args.novel, episodes_dir, args.target_chars)
        data = load_manifest(manifest_path)
        print(json.dumps({
            "manifest": str(manifest_path),
            "num_episodes": data["num_episodes"],
            "episodes": [
                {"index": e["index"], "title": e["title"], "chars": e["chars"]}
                for e in data["episodes"]
            ],
        }, ensure_ascii=False, indent=2))

    if args.split_only:
        return 0

    output_root = args.output_root or episodes_dir.parent
    orch_args = ["--review-after-stage"] if args.review_after_stage else ["--auto"]
    if args.target_4k:
        orch_args.append("--4k")
    if args.max_shots:
        orch_args += ["--max-shots", str(args.max_shots)]

    only = None
    if args.episodes:
        only = [int(x) for x in args.episodes.split(",") if x.strip()]

    result = run_episodes(
        manifest_path, output_root,
        orchestrator_args=orch_args, only=only, resume=args.resume,
    )
    failed = [k for k, v in result["results"].items() if v["status"] == "failed"]
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
