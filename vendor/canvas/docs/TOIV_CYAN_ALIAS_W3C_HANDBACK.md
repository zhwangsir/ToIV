# ToIV · P1-4 cyan 旧名清扫 Handback（W3-C）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit**）
- **范围**：机会性；不动 DesktopShell / 后端

---

## 扫描结论

运行期 **无** `var(--toiv-accent-cyan)` / `var(--product-accent-cyan)` 业务消费者（仅定义与 Tailwind 桥）。
节点图等已用 `--toiv-accent-interactive`（W2 残留）。

## 做了什么

1. **alias 指向 interactive**（留一代 deprecated）
   - `apps/canvas/web/src/styles/toiv-freezone-tokens.css`
   - `apps/web/app/styles/toiv-freezone-tokens.css`（twin）
   - `--toiv-accent-cyan*` → `var(--toiv-accent-interactive*)`
2. **Tailwind 桥** `globals.css`：`--color-toiv-accent-cyan` → `var(--toiv-accent-interactive, var(--toiv-accent))`
3. **`--product-accent-cyan`** → `var(--toiv-accent-interactive…)`（light/dark）

## 未删

- `--toiv-accent-cyan*` 定义本身（一代 alias）
- `--color-toiv-accent-cyan` 键名（防外部 class 骤断）

## 残点

- 下一代可删 cyan 键与 `--product-accent-cyan`（确认无类名 `*-accent-cyan` 后）
