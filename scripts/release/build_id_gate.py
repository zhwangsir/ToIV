#!/usr/bin/env python3
"""P-2 BUILD_ID 发版门禁:含 ``-dirty`` 的指纹不得上线。

格式(与 apps/web/next.config.mjs resolveBuildFingerprint 对齐)::

    YYYYMMDD-HHmmss-<git短sha>[-dirty]
    或退化:YYYYMMDD-HHmmss-nogit

用法::

    python3 scripts/release/build_id_gate.py --id '20261020-031200-abc1234'
    python3 scripts/release/build_id_gate.py --file apps/web/.next/BUILD_ID --require-head
    python3 scripts/release/build_id_gate.py --assert-clean-tree

退出码:0 通过;1 拒绝(dirty/sha 不匹配/缺文件);2 用法错误。
无 ALLOW_DIRTY_WEB 旁路——脏树构建一律拒发。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

# stamp-sha[-dirty] | stamp-nogit
_BUILD_ID_RE = re.compile(
    r"^"
    r"(?P<stamp>\d{8}-\d{6})"
    r"-"
    r"(?P<head>nogit|[0-9a-fA-F]+)"
    r"(?P<dirty>-dirty)?"
    r"$"
)


@dataclass(frozen=True)
class ParsedBuildId:
    raw: str
    stamp: str
    head: str  # short sha or "nogit"
    dirty: bool


class BuildIdGateError(ValueError):
    """门禁失败(调用方可转成 exit 1)。"""


def parse_build_id(raw: str) -> ParsedBuildId:
    """解析 BUILD_ID;非法格式抛 BuildIdGateError。"""
    text = (raw or "").strip()
    if not text:
        raise BuildIdGateError("BUILD_ID 为空")
    m = _BUILD_ID_RE.match(text)
    if not m:
        raise BuildIdGateError(
            f"BUILD_ID 格式非法(期望 YYYYMMDD-HHmmss-<sha|nogit>[-dirty]):{text!r}"
        )
    return ParsedBuildId(
        raw=text,
        stamp=m.group("stamp"),
        head=m.group("head"),
        dirty=bool(m.group("dirty")),
    )


def assert_build_id_clean(raw: str) -> ParsedBuildId:
    """含 ``-dirty`` 一律拒绝(P-2:脏工作区构建不能发版)。"""
    parsed = parse_build_id(raw)
    if parsed.dirty:
        raise BuildIdGateError(
            f"BUILD_ID 含 -dirty,拒绝发版(P-2):{parsed.raw}"
            " — 请提交/贮藏本地改动后干净重建:cd apps/web && rm -rf .next && npm run build"
        )
    return parsed


def assert_build_id_matches_head(raw: str, head_sha: str) -> ParsedBuildId:
    """干净 + 短 sha 与当前 HEAD 一致(nogit 视为无法校验 HEAD,仅过 dirty 闸)。"""
    parsed = assert_build_id_clean(raw)
    expected = (head_sha or "").strip().lower()
    if not expected:
        raise BuildIdGateError("期望 HEAD 短 sha 为空")
    if parsed.head == "nogit":
        return parsed
    if parsed.head.lower() != expected.lower():
        raise BuildIdGateError(
            f"BUILD_ID sha 与 HEAD 不一致:build={parsed.head} head={expected}"
            " — 请先 cd apps/web && npm run build"
        )
    return parsed


def read_build_id_file(path: Path) -> str:
    if not path.is_file():
        raise BuildIdGateError(f"BUILD_ID 文件不存在:{path}")
    return path.read_text(encoding="utf-8").strip()


def git_short_head(*, cwd: Path | None = None) -> str:
    out = subprocess.check_output(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=cwd,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return out.strip()


def git_working_tree_dirty(*, cwd: Path | None = None) -> bool:
    out = subprocess.check_output(
        ["git", "status", "--porcelain"],
        cwd=cwd,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return bool(out.strip())


def assert_clean_working_tree(*, cwd: Path | None = None) -> None:
    if git_working_tree_dirty(cwd=cwd):
        raise BuildIdGateError(
            "工作区不干净(git status --porcelain 非空),拒绝发版预检(P-2)。"
            " 请提交或贮藏后再发版。"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="P-2 BUILD_ID 发版门禁")
    g = parser.add_mutually_exclusive_group()
    g.add_argument("--id", help="直接校验一段 BUILD_ID 字符串")
    g.add_argument("--file", type=Path, help="读取 .next/BUILD_ID 文件")
    parser.add_argument(
        "--require-head",
        action="store_true",
        help="要求 BUILD_ID 内短 sha == git rev-parse --short HEAD",
    )
    parser.add_argument(
        "--assert-clean-tree",
        action="store_true",
        help="额外要求工作区干净(发版预检)",
    )
    parser.add_argument(
        "--repo",
        type=Path,
        default=None,
        help="git 仓库根(默认当前目录)",
    )
    args = parser.parse_args(argv)

    try:
        cwd = args.repo
        if args.assert_clean_tree:
            assert_clean_working_tree(cwd=cwd)

        if args.id is None and args.file is None:
            if args.assert_clean_tree:
                print("OK: working tree clean")
                return 0
            parser.error("请提供 --id 或 --file(或仅 --assert-clean-tree)")

        raw = args.id if args.id is not None else read_build_id_file(args.file)
        if args.require_head:
            head = git_short_head(cwd=cwd)
            parsed = assert_build_id_matches_head(raw, head)
            print(f"OK: BUILD_ID={parsed.raw} (clean, head={head})")
        else:
            parsed = assert_build_id_clean(raw)
            print(f"OK: BUILD_ID={parsed.raw} (clean)")
        return 0
    except BuildIdGateError as e:
        print(f"✖ {e}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as e:
        print(f"✖ git 调用失败:{e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
