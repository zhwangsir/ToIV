# Light Curtain · Topbar R2 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
调研：`docs/ops/VISUAL_MODE_SWITCH_R2_20261026.md`  
**TL 形态锁定**：顶栏右 2 段 quiet segmented pill「普通｜成人」+ 滑动 thumb；轨高 28；普通无 glow；成人 soft fill + `#4f8cff` glow（字色跟光幕蓝，不跟创作 `#5ba0ff`）。  
合规：B 美学自写；禁 iOS 大开关 / 整页 View Transition / 设置页主入口。

---

## A. 调研融合点

| 源 | 闸 | 取 | 舍 |
|----|----|----|----|
| BeefTV Segmented sm | B | 轨高 28、pad 2、thumb 200ms | 直角 md→改 pill；默认无 glow 需融成人态 |
| DramaClaw quiet chip | B | pill、150ms 变色、active ring+24px glow | 不抄组件 |
| BeefTV `#4f8cff` | B | **仅** NSFW glow / 字色辅通道 | 不作创作主 accent |
| R1 `--toiv-*` | repo | 地板色板不变 | Toonflow 中灰不当地板 |

---

## B. 1:1 复刻点（可抄表）

| Token | 值 |
|-------|-----|
| `--toiv-switch-h` | **28px** |
| `--toiv-switch-min-w` | **108px** |
| `--toiv-switch-pad` | **2px** |
| `--toiv-switch-item-px` | **10px** |
| `--toiv-switch-radius` | **9999px** |
| `--toiv-switch-fs` / `fw` | **12px** / **500** |
| `--toiv-switch-glow-nsfw` | `0 0 24px rgb(79 140 255 / 0.28)`（blur24 spread0） |
| `--toiv-switch-ring-nsfw` | `0 0 0 1px rgb(79 140 255 / 0.45)` |
| `--toiv-switch-fg-active-nsfw` | `#4f8cff` |
| `--toiv-switch-dur-color` / `thumb` | **150ms** / **200ms** |
| `--toiv-switch-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` |
| `--toiv-switch-disabled-opacity` | **0.4** |
| 文案 | **普通｜成人**（禁 SFW/NSFW 英文上顶栏） |

创作台分段：`--toiv-create-mode-*`（本轮未建），**不共用** `--toiv-switch-glow-nsfw`。

---

## C. 落地蓝图

| 项 | 落点 |
|----|------|
| Token | `toiv-freezone-tokens.css`（web↔canvas 同步）`--toiv-switch-*`；旧 `--toiv-light-curtain-*` 别名指向 switch |
| 样式 | `content-mode-prototypes.css` 消费 switch token；SFW thumb 中性抬升无 glow；成人 thumb soft fill + ring+glow |
| 挂载 | `workspace-top-bar.tsx` → `.app-workspace-topbar-actions`；`app-top-nav.tsx` 接线 `WorkspaceTopBar` |
| 画布 | `canvas-project-top-bar.tsx` 右簇（lg 全尺寸 / &lt;lg compact） |
| 侧栏脚 | **已拆除**主切换（仅账户/更新/主题） |
| 设置 | 仅说明 + `?focus=r18`；**无**主开关入口 |

---

## D. 双闸连贯性

- 一等公民：顶栏右工具带；侧栏脚非主入口  
- 只改光幕态 + 列表过滤；底色/路由/`/create` 不变  
- 普通：无 glow；成人：点亮仪式（`#4f8cff`）  
- 色盲双通道：文案「普通/成人」+ 盾/锁 + 色相  
- `prefers-reduced-motion`：关 thumb/色过渡  

