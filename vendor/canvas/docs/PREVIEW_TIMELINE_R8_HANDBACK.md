# Preview Timeline · R8 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`e8391a95`（R7 `--toiv-job-*` 校准）  
硬表：`docs/ops/VISUAL_PREVIEW_TIMELINE_R8_20261026.md` · TL 钉死  
合规闸：`docs/ops/WAVE2_LICENSE_GATE_R8_TIMELINE_20261026.md`  
不动：光幕顶栏位置、三栏骨架（左280/右320|420）、队列挂载语义。

---

## A. 调研融合点（来源档）

| 源 | 闸 | 取 | 舍 |
|----|----|----|----|
| **Toonflow-app** `videoActions` / `audioClipEditor` | **A·MIT** 可抄像素 | 帧轨 64 富档、标尺/playhead 帽形、片段 pad 节奏；优先抄源尺寸 | 未并 Vue 源码进仓；本 tip **尺寸入 token**，NOTICE 见 §E |
| **LumenX** `Timeline.tsx` | **A·MIT** | 坞工具条 h-12 气质、轨层叠、transport 32 圆钮 | 未并码；通义托管审核不抄 |
| **BeefTV** sequencer / editor timeline | **B·SAL** 只重写 | 96px/s 缩放、标尺 32、clip inset 6 / trim 8、seek 3px 气质 | **禁抄 Part A 源码/像素文件** |
| dramaclaw / CineGen | **B** 只重写 | 坞高 260、filmstrip 72、进出 220ms | 禁并码 |
| ArcReel / AIMovieStudio Timeline / BigBanana | **禁并码** | 仅知悉轨高阶梯 56/40/32（已写入自拟硬表，**未贴源**） | 零源码进仓 |

**结论**：`CreationStudioPreviewTimeline` **全宽贴底**挂 `/create` 工作台；Inspector 320/420 只挤中列。

---

## B. 1:1 / 钉死点

| 项 | 值 |
|----|-----|
| 坞 | `dock-h: 260`（min 180 / max 360·45vh）；全宽贴底 |
| 轨高 | video **56** / film **64** / audio **40** / sub **32** |
| 标尺 | **32**；tick major 10 / min 间距 64px |
| 播放头 | 线 **2** + 帽 **10**；色 **`#5ba0ff`**（**禁 danger 红**） |
| 片段 | radius 6 / inset-y 6 / pad-x 8 / trim 8 / filmstrip 72 |
| 缩放 | 基线 **96px/s** · **0.25–4×** · 齿轮 **×1.25**（不跟源码 0.02） |
| seek | **3px** / `#5ba0ff`（=R7 job progress） |
| 进出 | **220ms** / 统一 ease |
| 成人 | `geometry unchanged`；普通 NSFW：**灰化 + 锁 + 标签**（仍占几何） |
| API | `GET /api/studio/projects/{pid}/timeline-preview`（后端 tip `45ebdab4`）；ordinary **响应不含 NSFW**；UI **禁先拉全量再藏**；有 pid 接真口，失败/无 pid → mock fallback |

---

## C. 落地蓝图

| 层 | 路径 |
|----|------|
| Token | `toiv-freezone-tokens.css` `--toiv-timeline-*` + `--toiv-player-*`（canvas↔web 双端） |
| 坞 | `components/create/creation-studio-preview-timeline.tsx` + `.css` |
| 挂载 | `pages/create/creation-workbench.tsx`（三栏**之下**全宽兄弟，非中列内嵌） |
| 契约/mock | `services/toiv/timeline-preview.ts` |
| 调研 | `docs/ops/VISUAL_PREVIEW_TIMELINE_R8_20261026.md` |
| 闸 | `docs/ops/WAVE2_LICENSE_GATE_R8_TIMELINE_20261026.md` |

---

## D. 双闸连贯性

| 项 | 规格 |
|----|------|
| 光幕 | 位置未改；成人 `#4f8cff` **不**用于播放头/seek |
| NSFW | mock/服务端 ordinary 已滤；成人可见 `nsfw:true` 条；普通灰锁标签 |
| 文案 | 普通/成人 |
| 三栏 | 未改列宽 token；坞不随 320↔420 改高/改几何 |
| 队列 R7 | 挂载语义未动 |

---

## E. NOTICE / 风险 / 未完成

- **NOTICE（A）**：本 tip **未复制** Toonflow-app / LumenX 源文件；仅将公开 MIT 仓实读尺寸写入 `--toiv-timeline-*`。若后续并入源片段，须补 `NOTICE-ABSORPTION` 版权头。
- 风险：无 pid / API 不可达时走 mock；无真实 filmstrip 解码；trim 柄 UI 仅预留 token；媒体 URL 只信响应字段，勿另开直链。
- 未完成：拖拽改片长；字幕轨行；预览监视器独立 PlayerChrome；可拖坞高。
- **未 push**。
