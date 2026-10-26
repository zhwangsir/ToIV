# Node Graph Visual · R5 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`8cfbcab7`（R4 script+storyboard）  
合规：CineGen=B（ACL）只学模式重写；Toonflow-app=A（MIT）本轮**未并码**，仅对照无限画布气质后重写 Freezone 玻璃/边光；成人 `#4f8cff` **不**用于节点选中（留给光幕/导演）。  
不动：顶栏光幕、三栏几何（左280/右320选中420）。

调研对齐：R1 `--toiv-*`；可增 `--toiv-node-*`（单文件策略）。

---

## A. 调研融合点

| 源 | 闸 | 取 | 舍 |
|----|----|----|----|
| Freezone / R1 DNA | repo | `#0a0c12` / `#15161d` / accent `#5ba0ff` / cyan `#00bdcf` | 廉价灰块 `#262626` 选中白边 |
| Toonflow-app 无限画布 | A | 清晰端口、内容优先卡面、连线可读 | 未复制源文件；无 NOTICE 增量（无源码进仓） |
| CineGen 节点/连线 | B | 选中强调、类型色语义 | 禁 ACL 并码；不用 indigo 原色 |
| 既有 LibTV 端口轨 / 贝塞尔 | repo | ConnectionSideRail + cubic path + flow/comet | 灰 idle 线过淡 → 提到 edge tint |

**结论**：在既有 infinite-canvas / workflow-graph 上做视觉层，不新开第二壳。

---

## B. 1:1 复刻 / 钉死点

| 项 | 值 |
|----|-----|
| 选中描边 / accent | `#5ba0ff`（`--toiv-accent` / `--toiv-node-stroke-active`） |
| 成人色 | `#4f8cff` **禁止**用于节点选中/端口/连线强调 |
| 节点面 | Freezone glass fill + inset edge-light |
| 类型色条 | 左 3px bar（`--toiv-node-type-*`） |
| 端口 | accent 环 + 实心点；hover glow |
| 连线 | 贝塞尔保持；idle 用 `node.edge`；hover/选中加粗+微光+comet |
| 参数面板 | `.toiv-node-param-section` 对齐 Inspector 分区密度 |
| 成人几何 | `--toiv-node-adult-geometry: unchanged` |

---

## C. 落地蓝图（挂载路径）

| 层 | 路径 |
|----|------|
| Token | `apps/canvas/web/src/styles/toiv-freezone-tokens.css` ↔ `apps/web/app/styles/toiv-freezone-tokens.css`（`--toiv-node-*`） |
| TS 主题 | `apps/canvas/web/src/lib/canvas-theme.ts`（dark/light accent + glass shadow） |
| 视觉 CSS | `apps/canvas/web/src/components/canvas/canvas-node-graph-visual.css`（`application.tsx` import） |
| 节点壳/端口 | `components/canvas/canvas-node.tsx`（ConnectionSideRail SVG） |
| 连线 | `components/canvas/canvas-connections.tsx` |
| 选区描边 | `components/canvas/canvas-leafer-graphics-layer.tsx` |
| 分镜行端口 | `components/canvas/canvas-script-node.tsx`（RowHandle idle→edge） |
| 右参数面板 | `components/canvas/canvas-config-node-panel.tsx`（分区 section） |
| 工作流拓扑 | `workflow-graph-editor` 样式覆写（同 CSS） |

---

## D. 双闸连贯性

| 项 | 规格 |
|----|------|
| 光幕 | 仍顶栏右「普通｜成人」；本轮未改 paddle / `--toiv-switch-*` |
| 节点选中 | 只用 `#5ba0ff`；不借用 `--toiv-switch-glow-nsfw` / `#4f8cff` |
| 列表过滤 | 仍绑 redline；节点主题不改路由树 |
| 三栏 | 左280/右320/选中420 未改 |

---

## E. Token 增量摘要（`--toiv-node-*`）

- 面：`fill` / `fill-solid` / `panel` / `stroke` / `stroke-hover` / `stroke-active`
- 玻璃：`edge-light` / `glass-blur` / `radius` / `shadow` / `shadow-hover` / `shadow-selected`
- 端口：`port-size` / `port-ring` / `port-fill` / `port-glow`
- 类型：`type-dot` / `type-bar-w` / `type-image|video|text|audio|config|script|drawing|frame|skill|default`
- 连线：`edge-idle` / `edge-idle-w` / `edge-active-w` / `edge-glow-w` / `edge-glow`
- 参数：`param-section-gap` / `param-section-pad` / `param-radius`
- 闸：`adult-geometry: unchanged`

---

## F. 风险 / 未完成

- 媒体节点（image/video）壳仍 `transparent` 背景（避免盖住预览）；类型色条与选中 glow 仍生效。
- `globals.css` 内旧 workflow-graph 规则仍在；R5 以更高优先级 `!important` 覆写，后续可删冗余。
- 预存 tsc 噪声未清；本轮未对无限画布做像素截图验收（无浏览器门禁）。
- **未 push**。
