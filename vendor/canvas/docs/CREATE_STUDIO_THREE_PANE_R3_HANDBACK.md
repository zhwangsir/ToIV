# Create Studio Three-Pane · R3 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`eac519c9`（R2 光幕顶栏）  
合规：B 仓（Figma/Runway/Beef/DC）只学三栏模式重写；A 仓本轮未并新码。顶栏光幕**未**迁回侧栏脚。

---

## A. 调研融合点

| 源 | 闸 | 取 | 舍 |
|----|----|----|----|
| Figma / Runway 公开工作台 | B 模式 | 左资产 · 中画布/预览 · 右属性 | 不抄未授权实现 |
| BeefTV 创作台 IA | B | 内容优先、字段进侧栏分区 | 44px 大轨不进顶栏光幕 |
| DramaClaw Freezone | B | 暗 surface / panel 边 | 不抄 ELv2 |
| 既有同屏坞 `WsCreationDock` | repo | 保留在短剧主舞台内 | 不拆第二壳；强化外框三栏 |

**结论**：`/create` 与 `/toiv/ws`（已重定向 `?project=`）共用 `CreationWorkbenchPage` 唯一台 + `CreationStudioThreePane`。

---

## B. 1:1 复刻点

| 项 | 值 | 标注 |
|----|-----|------|
| 左栏宽 | `--toiv-create-rail-w: 240px` | 融合 Figma/Runway 资产栏量级 |
| 右栏宽 | `--toiv-create-inspector-w: 280px`（min 240） | 融合 Inspector 密度 |
| panel radius / border | `--toiv-radius-panel` / `--toiv-border` | R1 Freezone |
| 内边距 | `--toiv-create-pad: 12px` | R1 space-3 |
| create-mode 高 | `--toiv-create-mode-h: 36px` | 融合（低于 Beef 44；**无** NSFW glow） |
| 光幕 | 仍顶栏 `--toiv-switch-*` | R2；与 create-mode **隔离** |

---

## C. 落地蓝图

### 挂载

| 层 | 路径 |
|----|------|
| 页 | `pages/create/creation-workbench.tsx` |
| 壳 | `components/create/creation-studio-three-pane.tsx` |
| 左 | `creation-studio-asset-rail.tsx`（项目切换 + 资产入口） |
| 右 | `creation-studio-inspector.tsx`（阶段 / 内容模式只读 / 参数分区） |
| 中 | `CreatePage` 或 `DramaWorkspacePage`（原同屏内容） |
| 样式 | `creation-studio-three-pane.css` + R1 `toiv-freezone-tokens.css` |
| Token 入口 | 与 R1 同文件 `toiv-freezone-tokens.css`（web↔canvas 同步） |

### 数值

- 栅格：`240 | 1fr | 280`；≤1100 左收 56；≤860 纵向堆叠  
- Inspector section：pad 10 · radius panel · inner-glow  
- 拒绝主舞台后台表单墙：短剧表单仍在中栏但去 `max-w-7xl` 收紧；字段分区指引在右栏  

---

## D. 双闸连贯性

| 项 | 规格 |
|----|------|
| 光幕 | 顶栏右「普通｜成人」；侧栏脚不挂主切换 |
| Inspector | 仅状态 + 设置说明链；**无**主开关 |
| 列表过滤 | 仍绑 redline / me/mode；三栏不改路由树 |
| Token 隔离 | `--toiv-create-mode-*` 无 glow；禁用 `--toiv-switch-glow-nsfw` |

