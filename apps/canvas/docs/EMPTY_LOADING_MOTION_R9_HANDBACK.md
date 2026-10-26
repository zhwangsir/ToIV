# Empty / Loading / Motion · R9 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`d021f98b`（R8 preview timeline）  
不动：光幕、三栏几何、时间线坞骨架。  
合规：B 仓只重写；A 可标源（本 tip **未并码**，Freezone 自写）。

---

## A. 调研融合点

| 源 | 闸 | 取 | 舍 |
|----|----|----|----|
| 既有 `EmptyState` / Assets empty | repo | 图标+标题+说明+CTA 结构 | AntD Skeleton 满页感 |
| Aceternity Spotlight | repo 已有 | 指针高光思路 → **克制** SoftGlow（半径 140、accent 淡） | 高频大半径炫光；**禁**成人 `#4f8cff` 作全局光晕 |
| Toonflow / LumenX 空态节奏 | A（若有） | 中性文案、局部占位 | 未并源码 |
| 满屏 spinner | — | — | **拒绝**占满屏廉价 spinner |

**结论**：共享 `ToivEmptyState` / `ToivSkeleton*` / `ToivSoftGlow` + `--toiv-empty-*` / `--toiv-skeleton-*` / `--toiv-motion-*`；接到 create / 资产 / 队列。

---

## B. 1:1 / 钉死点

| 项 | 值 |
|----|-----|
| 动效 | enter **220ms** / exit **200ms** / spring **260ms**；ease `0.22,1,0.36,1` + spring `0.34,1.2,0.64,1` |
| 空态 | icon 环 48（compact 36）；title 14/560；desc 12 / max 36ch；CTA h 32 pill |
| 骨架 | radius 10；shine 1.4s；卡片高 96；**局部** grid/list/pane |
| 光晕 | accent mix 18%；半径 **140**；opacity 0.55；`prefers-reduced-motion` 关闭 |
| 文案 | 中性、不恐吓；普通/成人只出现在模式提示句 |
| 成人 | `geometry unchanged`；光晕主色仍 `#5ba0ff` |

---

## C. 落地蓝图

| 层 | 路径 |
|----|------|
| Token | `toiv-freezone-tokens.css`（canvas↔web） |
| 共享 | `components/toiv/toiv-empty-state.tsx` · `toiv-skeleton.tsx` · `toiv-soft-glow.tsx` · `toiv-empty-loading.css` |
| Create | media-pool 空态+未 hydrate 骨架+SoftGlow；storyboard 空态；timeline 空态；workbench Suspense → `ToivSkeletonPane` |
| 资产 | `AssetsEmptyState` → `ToivEmptyState` + CTA |
| 队列 | boot `ToivSkeletonList`；空/错 `ToivEmptyState` |

---

## D. 双闸连贯性

| 项 | 规格 |
|----|------|
| 光幕 | 未改；成人色不进 SoftGlow |
| NSFW 空态 | 媒体池普通态提示「部分条目已按模式隐藏」——中性 |
| 三栏 / 时间线坞 | 骨架与空态不改几何 token |

---

## E. 风险

- 调研硬表若后到，可补钉同 tip 或 R9 补钉。
- SoftGlow 在低端机仍应受 `prefers-reduced-motion` 约束。
- 资产页仍保留部分旧 `assets-empty-*` 布局 class 兼容。
- **未 push**。
