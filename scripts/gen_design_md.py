#!/usr/bin/env python3
"""从 vendor/legacy-web/app/globals.css :root 真源重新生成 docs/DESIGN.md 的 token frontmatter。

用法:python3 scripts/gen_design_md.py
真源=globals.css;本脚本只重写 DESIGN.md 的 YAML 头(首个 --- 到第二个 ---),
正文(契约 prose)保持原样。防漂移由 vendor/legacy-web/tests/designTokens.test.ts 校验。
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / "vendor/legacy-web/app/globals.css"
DESIGN = ROOT / "docs/DESIGN.md"


def extract_tokens(css: str) -> list[tuple[str, str]]:
    root = re.search(r":root\s*\{(.*?)\n\}", css, re.S)
    if not root:
        raise SystemExit("globals.css 里找不到 :root 块")
    return re.findall(r"(--[a-z0-9-]+)\s*:\s*([^;]+);", root.group(1))


def build_frontmatter(tokens: list[tuple[str, str]]) -> str:
    groups: dict[str, list[tuple[str, str]]] = {}
    order: list[str] = []
    for k, v in tokens:
        g = k[2:].split("-")[0]
        if g not in groups:
            groups[g] = []
            order.append(g)
        groups[g].append((k, v.strip().replace('"', "'")))
    lines = [
        "---",
        "name: ToIV Web",
        "# 由 scripts/gen_design_md.py 从 vendor/legacy-web/app/globals.css :root 生成;勿手改 token 值",
        "tokens:",
    ]
    for g in order:
        lines.append(f"  {g}:")
        for k, v in groups[g]:
            lines.append(f'    {k}: "{v}"')
    lines.append("---")
    return "\n".join(lines) + "\n"


def main() -> None:
    css = CSS.read_text(encoding="utf-8")
    fm = build_frontmatter(extract_tokens(css))
    old = DESIGN.read_text(encoding="utf-8")
    m = re.match(r"\A---\n.*?\n---\n", old, re.S)
    if not m:
        raise SystemExit("DESIGN.md 缺 frontmatter 头")
    DESIGN.write_text(fm + old[m.end():], encoding="utf-8")
    n = len(re.findall(r"^    --", fm, re.M))
    print(f"DESIGN.md frontmatter regenerated: {n} tokens from globals.css")


if __name__ == "__main__":
    main()
