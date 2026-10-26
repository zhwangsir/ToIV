# Script Parse + Storyboard Cards · R4 Handback（含 R3补几何校正）

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`73358b6c`（R3 three-pane）  
合规：B 仓（BigBanana / CineGen / DramaClaw）只学卡片 IA + PiP 模式重写；**无**源码拷贝。顶栏光幕**未**迁回侧栏脚。成人几何**未**改。

调研：`docs/ops/VISUAL_CREATE_SHELL_R3_20261026.md` + `docs/ops/VISUAL_STORYBOARD_CARDS_R4_20261026.md`

---

## TL 仲裁钉（R3补 + R4）

| 项 | 钉死值 |
|----|--------|
| 左默认 / 折叠 | **280** / **56** |
| 右常驻 | **320**（校正旧 R3 handback 的 240/280） |
| 分隔 | 可视 **1** / 命中 **8** |
| 选中分镜 | 右栏扩 **420**（上限 **480**）；取消 → **320** |
| 详情形态 | **不另开**挡中栏浮层 / drawer |
| 双轨 | 默认 **PiP**（草图 2:3 叠成片 16:9），**不用 tab** |
| 主卡 | 16:9 + shot# + 2 行摘要；gap **16**；圆角 **12** |
| 栅格 | 默认 **4** 列（3–5）；选中压 **2**；宽屏未选中可达 **5** |
| 九宫格 | gap **8** |
| 成人 | 几何 unchanged |

---

## A. 挂载路径

| 层 | 路径 |
|----|------|
| 工作台 | `pages/create/creation-workbench.tsx`（SlotsProvider + `shotSelected` → ThreePane） |
| 三栏壳 | `components/create/creation-studio-three-pane.tsx` + `.css` |
| Slots | `creation-studio-slots.tsx`（inspector 注入 + `shotSelected`） |
| 剧本中台 | `creation-studio-script-stage.tsx` ← `ScriptSectionR4` |
| 分镜中台 | `creation-studio-storyboard-flow.tsx` ← `StoryboardSectionR4` |
| 表单迁移 | 剧本参数 / SVML / 分镜详情 → Inspector slot（`creation-studio-inspector.tsx` 挂载） |
| Token | `apps/canvas/web/src/styles/toiv-freezone-tokens.css` ↔ `apps/web/app/styles/toiv-freezone-tokens.css` |

---

## B. 表单迁移一览

| 原中栏墙 | 现位置 |
|----------|--------|
| 目标镜数 · AI 拆解 · SVML 导入 | 右栏 `script-inspector-form` |
| 分镜属性 / 选中摘要 | 右栏 `storyboard-inspector-form`（选中扩宽） |
| AI 配景 / 九宫格候选 | **仍在卡片上**（stopPropagation，不挡选中） |
| 驱动模式 / 视频管线 | 「生成镜头」段保留（未堆回分镜中栏） |

---

## C. 双轨 PiP

- 成片主窗：`final_clip_url || video_url` → `<video>` 16:9；否则 `image_url` 作主图。
- 草图 PiP：成片存在且有 `image_url` 时，右下 **2:3** 叠层（`--toiv-shot-pip-w: 32%`）。
- **无 tab** 切换轨。

---

## D. 双闸连贯

- 光幕仍顶栏右；Inspector 仅只读状态 + 设置说明链。
- `--toiv-create-*` / `--toiv-shot-*` 成人几何标记 `unchanged`；create-mode **无** NSFW glow。

---

## E. 风险 / 已知

- 预存 tsc 噪声（非 R4 路径）未清；本轮未引入新 R4 过滤命中预期。
- 选中态经 Context 上抛；离开 storyboard section 会 `setShotSelected(false)`。
- 旧 R3 handback 仍写 240/280——以本文件 + token 文件为准（R3补已校正）。
- **未 push**（硬约束）。

---

## F. 验收清单

- [x] 左 280 / 右 320 / splitter 1·8
- [x] 选中 → `data-shot-selected=1` + 右栏 420（max 480）
- [x] 取消选中 → 320；无浮层
- [x] PiP 2:3-on-16:9
- [x] 卡 gap 16 / radius 12 / cols 4
- [x] 剧本表单进右栏
- [x] web↔canvas token 同步
