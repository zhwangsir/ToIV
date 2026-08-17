"""episode_splitter.py（M6 分集）与 video_4k_upscale_parallel.py（M6 并行超分）单元测试。"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest import mock

import pytest

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_SCRIPTS = SCRIPT_DIR.parents[1] / "scripts"
for _p in (SCRIPT_DIR, ROOT_SCRIPTS):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import episode_splitter as es
import video_4k_upscale_parallel as par


# ---------------------------------------------------------------------------
# split_novel 纯逻辑
# ---------------------------------------------------------------------------
def test_short_text_single_episode():
    eps = es.split_novel("一段很短的小说。", target_chars=8000)
    assert len(eps) == 1
    assert eps[0]["index"] == 1
    assert eps[0]["text"] == "一段很短的小说。"


def test_empty_text():
    assert es.split_novel("", target_chars=100) == []
    assert es.split_novel("   \n\n  ", target_chars=100) == []


def test_chapter_based_split():
    chapters = []
    for i in range(1, 7):
        chapters.append(f"第{i}章 标题{i}\n\n" + "正文内容。" * 100)  # 每章 ~500 字
    text = "\n\n".join(chapters)
    eps = es.split_novel(text, target_chars=1000)

    assert len(eps) >= 2
    # 全文内容不丢失
    total_chars = sum(e["chars"] for e in eps)
    assert total_chars >= len(text) * 0.9
    # 每集不超标太多（允许单章略超）
    for e in eps[:-1]:
        assert e["chars"] <= 1000 * 1.5
    # 集标题含章节信息
    assert "第1章" in eps[0]["title"]


def test_paragraph_fallback_split():
    # 无章节标记的长文 → 按段落聚合
    paras = [f"段落{i}。" + "内容" * 50 for i in range(40)]  # 每段 ~100+ 字
    text = "\n\n".join(paras)
    eps = es.split_novel(text, target_chars=1000)

    assert len(eps) >= 2
    joined = "\n\n".join(e["text"] for e in eps)
    for p in paras:
        assert p in joined


def test_oversized_chapter_hard_split():
    # 单章就远超目标字数 → 强制二次拆分
    big_chapter = "第一章 巨长\n\n" + "\n\n".join(
        "长段落。" + "字" * 300 for _ in range(20)
    )
    eps = es.split_novel(big_chapter, target_chars=1000)
    assert len(eps) >= 2


def test_preamble_merged_into_first_chapter():
    text = "序言内容。\n\n第一章 开始\n\n" + "正文。" * 100 + "\n\n第二章 继续\n\n" + "正文。" * 100
    eps = es.split_novel(text, target_chars=8000)
    assert len(eps) >= 1
    assert "序言内容" in eps[0]["text"]


# ---------------------------------------------------------------------------
# split_novel_file + manifest
# ---------------------------------------------------------------------------
def test_split_novel_file_writes_manifest(tmp_path: Path):
    novel = tmp_path / "long.txt"
    novel.write_text("第一章 A\n\n" + "内容。" * 300 + "\n\n第二章 B\n\n" + "内容。" * 300,
                     encoding="utf-8")
    out_dir = tmp_path / "episodes"
    manifest_path = es.split_novel_file(novel, out_dir, target_chars=500)

    data = es.load_manifest(manifest_path)
    assert data["num_episodes"] >= 2
    for ep in data["episodes"]:
        assert (out_dir / ep["file"]).exists()
        assert ep["status"] == "pending"


# ---------------------------------------------------------------------------
# run_episodes 调度
# ---------------------------------------------------------------------------
def test_run_episodes_invokes_orchestrator_per_episode(tmp_path: Path):
    novel = tmp_path / "long.txt"
    novel.write_text("第一章 A\n\n" + "内容。" * 200 + "\n\n第二章 B\n\n" + "内容。" * 200,
                     encoding="utf-8")
    out_dir = tmp_path / "episodes"
    manifest = es.split_novel_file(novel, out_dir, target_chars=400)
    n_eps = es.load_manifest(manifest)["num_episodes"]

    with mock.patch("episode_splitter.subprocess.run") as mrun:
        mrun.return_value = mock.Mock(returncode=0)
        result = es.run_episodes(manifest, tmp_path / "out", orchestrator_args=["--auto"])

    assert mrun.call_count == n_eps
    # 每集调用 orchestrator.py，输出目录 epXX
    first_cmd = mrun.call_args_list[0][0][0]
    assert "orchestrator.py" in first_cmd[1]
    assert "ep01" in first_cmd[3]
    assert all(v["status"] == "done" for v in result["results"].values())
    # 清单状态已更新
    data = es.load_manifest(manifest)
    assert all(e["status"] == "done" for e in data["episodes"])


def test_run_episodes_stops_on_failure(tmp_path: Path):
    novel = tmp_path / "long.txt"
    novel.write_text("第一章 A\n\n" + "内容。" * 200 + "\n\n第二章 B\n\n" + "内容。" * 200,
                     encoding="utf-8")
    out_dir = tmp_path / "episodes"
    manifest = es.split_novel_file(novel, out_dir, target_chars=400)

    with mock.patch("episode_splitter.subprocess.run") as mrun:
        mrun.return_value = mock.Mock(returncode=2)
        result = es.run_episodes(manifest, tmp_path / "out")

    # 第一集失败即中止
    assert mrun.call_count == 1
    assert result["results"]["1"]["status"] == "failed"


def test_run_episodes_resume_skips_done(tmp_path: Path):
    novel = tmp_path / "long.txt"
    novel.write_text("第一章 A\n\n" + "内容。" * 200 + "\n\n第二章 B\n\n" + "内容。" * 200,
                     encoding="utf-8")
    out_dir = tmp_path / "episodes"
    manifest = es.split_novel_file(novel, out_dir, target_chars=400)
    data = es.load_manifest(manifest)
    data["episodes"][0]["status"] = "done"
    es.save_manifest(manifest, data)

    with mock.patch("episode_splitter.subprocess.run") as mrun:
        mrun.return_value = mock.Mock(returncode=0)
        result = es.run_episodes(manifest, tmp_path / "out", resume=True)

    assert result["results"]["1"]["skipped"] is True
    # 续跑命令带 --continue
    cmd = mrun.call_args_list[0][0][0]
    assert "--continue" in cmd


# ---------------------------------------------------------------------------
# 并行超分：分片与 worker 循环
# ---------------------------------------------------------------------------
def test_shard_round_robin():
    items = [(i, f"f{i}") for i in range(10)]
    shards = par._shard(items, 3)
    assert len(shards) == 3
    assert sorted(i for s in shards for i, _ in s) == list(range(10))
    # round-robin: shard0 = 0,3,6,9
    assert [i for i, _ in shards[0]] == [0, 3, 6, 9]


def test_shard_more_workers_than_items():
    shards = par._shard([(0, "a"), (1, "b")], 5)
    assert len(shards) == 2


def test_worker_loop_writes_frames(tmp_path: Path):
    frames = [(1, tmp_path / "f1.png"), (2, tmp_path / "f2.png")]
    for _, f in frames:
        f.write_bytes(b"png")
    merged = tmp_path / "merged"
    merged.mkdir()
    stats = {"frame_times": []}
    import threading

    with mock.patch.object(par, "upscale_frame_remote", return_value=b"upscaled_png"):
        errors = par._worker_loop(
            "http://w1:8189", frames, merged, "m.pth", 3840, 2160,
            resume=False, stats=stats, stats_lock=threading.Lock(),
        )
    assert errors == []
    assert (merged / "upscaled_000001.png").read_bytes() == b"upscaled_png"
    assert (merged / "upscaled_000002.png").exists()
    assert len(stats["frame_times"]) == 2


def test_worker_loop_resume_skips_existing(tmp_path: Path):
    f = tmp_path / "f1.png"
    f.write_bytes(b"png")
    merged = tmp_path / "merged"
    merged.mkdir()
    (merged / "upscaled_000001.png").write_bytes(b"old")
    import threading

    with mock.patch.object(par, "upscale_frame_remote") as mup:
        errors = par._worker_loop(
            "http://w1:8189", [(1, f)], merged, "m.pth", 3840, 2160,
            resume=True, stats={"frame_times": []}, stats_lock=threading.Lock(),
        )
    assert errors == []
    mup.assert_not_called()
    assert (merged / "upscaled_000001.png").read_bytes() == b"old"


def test_worker_loop_collects_errors(tmp_path: Path):
    f = tmp_path / "f1.png"
    f.write_bytes(b"png")
    merged = tmp_path / "merged"
    merged.mkdir()
    import threading

    with mock.patch.object(par, "upscale_frame_remote", side_effect=TimeoutError("timeout")):
        errors = par._worker_loop(
            "http://w1:8189", [(1, f)], merged, "m.pth", 3840, 2160,
            resume=False, stats={"frame_times": []}, stats_lock=threading.Lock(),
        )
    assert len(errors) == 1
    assert "timeout" in errors[0]
