"""凭据卫生回归:跟踪文档不得再出现已知弱默认口令字面量。

故意检查字面量 admin123(历史弱默认);不把其他真实密钥写入本测试。
"""
from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

# 禁止再出现的弱默认(产品历史口令字面量)
FORBIDDEN_LITERALS = (
    "admin123",
)

# 扫描范围:文档与 example;不含 third_party / 构建产物 / 真实 .env
SCAN_GLOBS = [
    "AGENTS.md",
    "README.md",
    "skills/**/*.md",
    "docs/**/*.md",
    "apps/api/.env.example",
    "deploy/.env.example",
]

SKIP_PARTS = {"third_party", "node_modules", "dist", ".git", ".next", "__pycache__", ".archive"}


def _iter_files():
    seen: set[Path] = set()
    for pattern in SCAN_GLOBS:
        for p in ROOT.glob(pattern):
            if not p.is_file():
                continue
            if any(part in SKIP_PARTS for part in p.parts):
                continue
            rp = p.resolve()
            if rp in seen:
                continue
            seen.add(rp)
            yield p


@pytest.mark.parametrize("literal", FORBIDDEN_LITERALS)
def test_tracked_docs_forbid_weak_admin_literal(literal: str):
    hits: list[str] = []
    for path in _iter_files():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if literal in text:
            # 行号便于修,不打印整行(可能含其他敏感上下文)
            for i, line in enumerate(text.splitlines(), 1):
                if literal in line:
                    hits.append(f"{path.relative_to(ROOT)}:{i}")
    assert not hits, (
        f"禁止字面量 {literal!r} 仍出现在跟踪文档(凭据卫生 #12)。"
        f" 改为占位或 env 键名。命中: {hits[:20]}"
    )


def test_agents_section_points_to_env_not_password_table():
    text = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    assert "TOIV_ADMIN_PASSWORD" in text
    assert "## 二、凭据与秘密" in text or "凭据与秘密" in text
    assert "禁止写入仓库" in text or "不得出现在 AGENTS" in text


def test_credentials_md_has_no_password_column_values():
    """credentials.md 应为指针文档,不应再出现「弱默认」字面量(由上一测覆盖)并声明废止明文入库。"""
    text = (ROOT / "skills/toiv-cluster/credentials.md").read_text(encoding="utf-8")
    assert "废止" in text or "不写口令" in text
    assert "deploy/.env" in text
