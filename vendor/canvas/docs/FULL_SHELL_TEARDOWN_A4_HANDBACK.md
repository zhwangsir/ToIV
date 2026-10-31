# FULL SHELL TEARDOWN · A4 Handback（创作台 quieter + distill）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **状态**：**仅工作树**（未 commit / 未 push / 未 deploy）
- **截图性质**：**FIXTURE · 非现网硬刷**
- **对照**：A2 create 残点（营销腔 / soft-glow / 玻璃模糊 / 套卡）；原则 Operate≠Persuade · quieter · distill · motion ~220

---

## 做了什么

### 1) 砍无状态 glow / glass
- `toiv-empty-loading.css`：**退休 soft-glow**（`::before { content:none; display:none }`）
- `creation-studio-queue-dock.css`：去掉 `backdrop-filter: blur`；实色 surface；阴影降为 `0 8px 24px`；入场 **220ms**；running 点改为透明度脉冲（无彩晕环）
- 队列行：去「卡套卡」感 → 透明底 + 底部分隔线
- `creation-product.css`：图片 upscale 钮 `backdrop-filter: none`；精选卡去 hero 抢戏 / overlay 玻璃
- `creation-studio-three-pane.css`：壳内 soft-glow 强制关；inspector 无 blur

### 2) 营销腔 / 调试露出
- 去掉「一句话生成…」「一站式生成…」「从概念到成片一体化…」→ 工具短句
- 「用 AI 优化提示词」→「优化提示词」；「和 AI 讨论…」→「剧情、角色与对白」
- 「AI 配景」→「配景」；「使用这个创意」→「使用」
- Inspector：`属性 Inspector` aria →「属性」；参数区教学 `<em>` 砍掉 → 短「区段」列表
- 「模式说明」链：**仅 `?debug=1` 显示**

### 3) 少套卡 · list-row
- 媒体池 rail：`.toiv-asset-pool-grid` 改纵向 **list-row**（48px 缩略 + 标题行，无抬升/霓虹选中环；选中 = inset accent 条）
- 筛选 chip：方角安静，非大 pill 轨道

### 4) Accent / 动效
- CTA / 选中条 / playhead / focus 保留 `#5ba0ff`
- 队列动效对齐 **~220ms ease-out**；无新增 bounce/elastic
- `aceternityMotion.tween.panel`（0.22）主路径保持

### 5) A3v2 门厅
- **未改** `landing.css` / `LandingPage` / `public/site`（本刀零触及）

---

## 改动文件（本刀）

- `apps/canvas/web/src/components/toiv/toiv-empty-loading.css`
- `apps/canvas/web/src/components/create/creation-studio-queue-dock.css`
- `apps/canvas/web/src/components/create/creation-studio-media-pool.css`
- `apps/canvas/web/src/components/create/creation-studio-three-pane.css`
- `apps/canvas/web/src/components/create/creation-studio-three-pane.tsx`
- `apps/canvas/web/src/components/create/creation-studio-inspector.tsx`
- `apps/canvas/web/src/components/create/creation-studio-storyboard-flow.tsx`
- `apps/canvas/web/src/pages/create/creation-workspace.tsx`
- `apps/canvas/web/src/pages/create/creation-product.css`
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A4_HANDBACK.md`
- `apps/canvas/docs/shots/a4-create.png` / `a4-timeline.png`
- `apps/canvas/docs/shots/fixture-a4-create.html` / `fixture-a4-timeline.html`

## 截图绝对路径（FIXTURE · 非现网硬刷 · 1280）

- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a4-create.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a4-timeline.png`

Fixture 静态：play = `rgb(91,160,255)` · shadow `none`；选中 = inset accent 条。

---

## 未做

| 项 | 说明 |
|---|---|
| 现网硬刷 `/studio/create` | 无本地会话；仅 FIXTURE |
| 砍全局 `--toiv-node-*-glow` token 硬表 | 属 canvas 节点 DNA 通道；本刀在 create 壳侧禁 idle bloom，未改 token 表值 |
| 精选灵感整区拆除 / 信息架构重排 | 只 distill 文案与视觉权重，未删功能面 |
| Skill 英文 tab 名「Skill」 | 产品名词保留 |
| commit / push / deploy | 禁 |
| A3v2 landing/site | 刻意不动 |

## 阻塞
- 无登录会话 → 无法现网硬刷创作台
- canvas 节点选中 glow token 仍在全局表（非 create idle 路径）

---

## 自检：AI 感还剩哪（诚实）

1. **精选灵感 / Skill 网格**仍在空态入口 — 已压文案与 hero，但仍是「模板墙」，squint 时若停在空态会抢戏  
2. **suggest 卡 + Sparkles 图标**仍暗示「智能推荐」  
3. **全局 node/edge glow token**未从表删除 — 画布节点选中仍会发光（有状态，可接受；但通道还在）  
4. **光幕 NSFW glow**（DNA 保留）— 成人态仍有 `#4f8cff` 辅通道  
5. **Fixture 非源码直渲** — 真壳密度/真实时间线像素未硬刷验证  
6. **progress indeterminate 滑动条**仍有轻微动效（运行态，非 idle）

**结论：创作台 chrome 已 quieter；营销「一句话」与 idle soft-glow/玻璃已砍。AI 感未归零，主残在空态灵感墙与画布节点 glow 通道。**
