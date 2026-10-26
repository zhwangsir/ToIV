# ToIV 预览监视器 / 时间线 · 第8轮调研简报

- **日期**：2026-10-26（Asia/Shanghai）
- **执行**：模型调研帮手（Preview / Timeline R8）
- **状态**：已落地 tip（`--toiv-timeline-*` + 全宽坞 + mock API）/ 禁 push
- **校准基 tip**：`e8391a95`
- **文件名**：`VISUAL_PREVIEW_TIMELINE_R8_20261026.md`（不用 VIDEO_TIMELINE 旧名）
- **承接**：R1 DNA、R2 双闸、R3 `--toiv-create-*`（左280/右320/详情420/PiP）、R4–R6、R7 `--toiv-job-*` 细轨 3px
- **已钉死**：accent `#5ba0ff`；成人 glow/字 `#4f8cff`；文案「普通｜成人」；成人不改几何；普通灰化+锁+标签
- **方法**：
  - **A 优先实读**：BeefTV（`editor-timeline-panel` / `canvas-timeline-*` / `timeline-view` / `video-player.css` / `director-sequencer`）、dramaclaw（`VideoComposeModal` + `watch-player` CSS）、ArcReel（`EditTimelineTracks`）、Toonflow（`videoPlayer.vue`）
  - **LumenX**：本机 absorb 仅 playground 切片，无完整 timeline 源码 → 进度气质跟 R7/Toonflow 细轨融合
  - **B 浅扫**：CineGen（阶段导出，无专业多轨像素）、Runway（无开源，仅模式）

---

## ⚡ TL / 跨端立刻可用 · 推荐默认 + 硬尺寸表

### 推荐默认（一句话）

**时间线坞默认高 260；视频轨高 56（音频 40 / 字幕 32）；标尺 32；播放头线宽 2 + 顶帽 10；片段圆角 6、上下 inset 6、左右 pad 8、trim 柄 8；缩放基线 96px/s（0.25–4× / step 1.25）；filmstrip 拇指 72×轨内高；scrub/音量细轨 3px 对齐 R7；进出场 220ms；右栏 320 / 详情 420 叠在画布侧，时间线全宽贴底不改几何；成人闸零几何差。**

### 硬尺寸表（跨端可抄 → `--toiv-timeline-*`）

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-timeline-dock-h` | **260px** | 默认坞高（dramaclaw `h-[260px]`）；可拖 180–360 |
| `--toiv-timeline-dock-h-min` | **180px** | 折叠下限（BeefTV sequencer min≈130–150 预览档） |
| `--toiv-timeline-dock-h-max` | **360px** / `45vh` | 展开上限 |
| `--toiv-timeline-toolbar-h` | **40px** | 工具条 `h-10`（BeefTV editor） |
| `--toiv-timeline-ruler-h` | **32px** | 标尺（BeefTV `CanvasTimelineRuler`）；备档 **28**（dramaclaw `h-7`） |
| `--toiv-timeline-ruler-tick-major` | **10px** | 主刻度高 |
| `--toiv-timeline-ruler-tick-minor` | **5px** | 次刻度高 |
| `--toiv-timeline-ruler-label-fs` | **10px** / opacity 0.6 | 刻度字 |
| `--toiv-timeline-ruler-min-tick-px` | **64px** | 刻度最小像素间距（BeefTV `getRulerTickStep`） |
| `--toiv-timeline-track-h` | **56px** | **视频主轨**（ArcReel `h-14`；介于 dialog 52 与 editor `h-16`=64） |
| `--toiv-timeline-track-h-film` | **64px** | 带 filmstrip 富轨（BeefTV editor / dramaclaw clip `h-16`） |
| `--toiv-timeline-track-h-audio` | **40px** | 音频（ArcReel narration `h-10`） |
| `--toiv-timeline-track-h-sub` | **32px** | 字幕/BGM（ArcReel `h-8`） |
| `--toiv-timeline-track-label-w` | **160–192px** | 左标签列（BeefTV `LABEL_COLUMN_PX=192`；可压到 160） |
| `--toiv-timeline-playhead-w` | **2px** | 播放头竖线（BeefTV / ArcReel 用 1–2；钉 **2**） |
| `--toiv-timeline-playhead-cap` | **10px** | 顶菱形/圆帽（`size-2.5` / dramaclaw `h-3 w-3`） |
| `--toiv-timeline-playhead-color` | **`#5ba0ff`** | 禁止抄 danger 红作默认播放头；危险色仅 razor/overlap |
| `--toiv-timeline-clip-radius` | **6px** | `rounded-md`（BeefTV/dramaclaw） |
| `--toiv-timeline-clip-inset-y` | **6px** | 上下 inset（`top-1.5 bottom-1.5` / dialog `top-1`+`100%-8`） |
| `--toiv-timeline-clip-pad-x` | **8px** | 片段内文 pad |
| `--toiv-timeline-clip-trim-w` | **8px** | trim 柄（BeefTV `TRIM_HANDLE_PX`；dialog `w-2`） |
| `--toiv-timeline-clip-fs` | **12px** / **10px** meta | 片内标题 / 时长 |
| `--toiv-timeline-zoom-base-pps` | **96** | px/秒基线（BeefTV `BASE_TIMELINE_PX_PER_SECOND`） |
| `--toiv-timeline-zoom-min` | **0.25** | 实用下限（源码 min 0.02 过稀，产品钉 0.25） |
| `--toiv-timeline-zoom-max` | **4** | 与 BeefTV `MAX_TIMELINE_ZOOM` 同 |
| `--toiv-timeline-zoom-step` | **1.25** | 齿轮步进（dramaclaw 1.5 备档） |
| `--toiv-timeline-zoom-fit-min-vw` | **320px** | fit 计算视口下限（对齐 R3 右栏宽感） |
| `--toiv-timeline-filmstrip-thumb-w` | **72px** | filmstrip 格宽（dramaclaw `FILMSTRIP_THUMB_W`） |
| `--toiv-timeline-filmstrip-thumb-h` | **= track inner** | 等高铺满片段内高 |
| `--toiv-timeline-snap-px` | **8px** | 吸附阈值（BeefTV/dialog/dramaclaw） |
| `--toiv-timeline-min-clip-ms` | **100–200** | 最小片长（BeefTV 100 / dramaclaw 200） |
| `--toiv-timeline-tool-hit` | **28×28** | 工具钮 `size-7`；备档 **24**（`size-6`） |
| `--toiv-timeline-frame-step-hit` | **20–24px** | 帧步进（sequencer `size-5` / compose 24） |
| `--toiv-timeline-timecode-fs` | **12px** / **600** | 工具条时间码；`tabular-nums` + mono 优先 |
| `--toiv-timeline-timecode-fs-sm` | **10–11px** | 标尺旁/片内 |
| `--toiv-timeline-timecode-min-w` | **64–96px** | 当前时间码槽（dramaclaw watch `min-w:92`） |
| `--toiv-player-control-size` | **36px** | BeefTV canvas player 主控 |
| `--toiv-player-control-size-sm` | **28–32px** | Toonflow 28 / compose 32 |
| `--toiv-player-control-gap` | **6px**（compact **4**） | |
| `--toiv-player-seek-h` | **3px** | **对齐 R7 进度气质**（源码 2–4；钉 3） |
| `--toiv-player-seek-thumb` | **12–13px** | dramaclaw watch thumb 13 |
| `--toiv-player-volume-rail-h` | **60–64px** | 竖向音量（Toonflow 60 / BeefTV compact 64） |
| `--toiv-player-volume-panel-w` | **40–42px** | |
| `--toiv-timeline-enter-ms` | **220ms** | 坞/控件显隐（dramaclaw controls 220） |
| `--toiv-timeline-exit-ms` | **220ms** | 同进同出；备档 180 |
| `--toiv-timeline-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | 与 R1/R2/R7 统一 |
| `--toiv-timeline-inspector-gap` | **0** 几何耦合 | 右栏 **320** / 详情 **420** 改变的是**画布列宽**，不改上表任何 timeline 几何 |
| `--toiv-timeline-adult-geometry` | **unchanged** | 成人闸禁止改上表任何几何 |

**与 R3 右栏 320 / 详情 420 的关系（硬口径）**

1. 时间线坞 = 创作台**底栏全宽**（左资产+中画布+右 Inspector 三列之下），`dock-h` 不随 Inspector 开合变宽/变高。
2. Inspector **320**（常驻）/ **420**（详情）只挤压**中画布列**；时间线内容区用 `zoom-fit-min-vw≥320` 保证 fit 缩放仍可读。
3. 预览监视器默认吃中列；PiP 跟 R3，不进时间线轨高。
4. 任务进度细轨（R7 3px `#5ba0ff`）与 `--toiv-player-seek-h: 3px` 同气质，禁止成人模式加粗。

---

## ① 深度调研与像素级拆解

### BeefTV（A · 时间线主模板）

- **双形态**：`canvas-timeline-dialog` 紧凑轨高 **52** + 标尺 **32** + 播放头 **2px**；`editor-timeline-panel` 富编辑轨 **h-16=64**、标签列 **192**、工具条 **40**、clip `top/bottom 1.5` + `rounded-md`、trim **8**。
- **缩放**：基线 **96 px/s**，zoom **0.02–4**（产品实用钉 0.25–4），步进 **1.25**；标尺 tick 保证 ≥**64px** 间距。
- **播放头**：竖线 2px + 顶菱形 `size-2.5`；源码部分用 danger 红——ToIV **改 accent `#5ba0ff`**。
- **预览监视器**：`editor-preview-monitor` 顶栏 `h-9`；transport 宽 <340 进 compact；与 `video-player` 控钮 **36**、seek 组同高。
- **Director sequencer**：预览坞 `min(150px,22vh)` / 编辑可拖高；帧步进 **20**；与专业多轨编辑器互补（关键帧模式，不替代 clip 轨）。

### dramaclaw（A · 合成台 + 观影控件）

- **VideoComposeModal**：底坞 **260**；标尺 **h-7=28**；视频片段块 **h-16**；filmstrip 拇指宽 **72**；缩放 **20–240 px/s** step 1.5 默认 80；播放头圆帽 **12**；控件 **32**；细进度 `h-1`（4px）→ ToIV 收成 **3px**。
- **watch-player**：播放 **40**、图标钮 **34**、时间码 **13px tabular**、seek 轨 **4px**/thumb **13**、idle 隐控 **220ms**、空闲 **2600ms**。

### ArcReel（A · 四轨短剧编辑）

- 视频 **h-14=56** / 旁白 **h-10=40** / 字幕·BGM **h-8=32**；短屏再压一档；播放头 **w-px**；未用单元拇指 **h-4 w-7**；主轨推荐直接取 **56**。

### Toonflow（A · 节点内嵌播放器）

- 控钮 **28**；进度 slider 轨 **2px** / thumb **8**；音量竖轨高 **60**、面板宽 **40**；时间字 **10px**；容器断点 **320**——与 R3 右栏同宽感。

### LumenX / Runway / CineGen（浅）

- LumenX absorb 无完整多轨 UI；进度条气质已在 R7 钉 3px。
- Runway：会话流式预览模式，无源码像素。
- CineGen：阶段/导出，无对标多轨时间线几何。

---

## ② 照抄与融合方案

| 项 | 1:1 照抄 | 融合 / 改写 | 不抄 |
|---|---|---|---|
| 轨高阶梯 | ArcReel 56/40/32 | 富 filmstrip 升 64（BeefTV/dramaclaw） | 短屏再压导致不可点 trim |
| 标尺 | BeefTV 32 + tick 10/5 | 密台可用 28 | 浅色大字标尺 |
| 播放头 | 线宽 2 + 帽 10 | **色换 `#5ba0ff`** | BeefTV danger 红默认头 |
| 片段 | rounded-md + inset 6 + trim 8 | 选中 ring 用 accent，不改圆角 | 直角工业块 |
| 缩放 | 96 pps / step 1.25 / max 4 | min 实用钉 0.25 | 0.02 过稀空轨 |
| filmstrip | 72 宽铺满 | 无缩略时纯色块+标题 | 强制每帧解码卡 UI |
| 播放器 | 控钮 36；seek **3px** | Toonflow 28 仅节点卡内 | 粗 6px+ 进度（破坏 R7 气质） |
| 进出场 | 220ms ease | 与 R2/R7 同曲线 | 弹跳/过长 400ms+ |
| 布局 | 底坞全宽 | Inspector 320/420 只挤中列 | 时间线塞进右栏 320 |

**主路径**：专业编辑 = BeefTV editor DNA（64 富轨可选）+ ArcReel 轨高阶梯默认 56；预览控件 = BeefTV 36 + seek 3px；合成捷径 = dramaclaw 260 坞 + filmstrip 72。

---

## ③ 落地蓝图（`--toiv-timeline-*`）

1. **Token 落盘**：全局 CSS 增补上表；播放头/seek fill 绑 `#5ba0ff`；成人态不变几何。
2. **切面组件**：
   - `TimelineDock`（高 260，可拖）
   - `TimelineRuler`（32 / tick / playhead）
   - `TimelineTrackRow`（56/40/32 + label 160–192）
   - `TimelineClip`（radius 6 / inset 6 / trim 8 / 可选 filmstrip 72）
   - `TimelineToolbar`（40 高；zoom %；timecode tabular）
   - `PreviewMonitor` + `PlayerChrome`（36 控；seek 3px；音量竖轨 60–64）
3. **与创作台**：坞贴 `/create` 底；左 280 / 右 320|420 不变；PiP 不改轨高。
4. **动效**：enter/exit **220ms**；`prefers-reduced-motion` → 0ms。
5. **标记 / in-out**：用 2px 竖线 + 10px 旗标，色 warning；不另开轨高。

---

## ④ 双闸与连贯性校验

- **成人不改几何**：所有 `--toiv-timeline-*` / `--toiv-player-*` 尺寸在「普通｜成人」位相等。
- **普通态**：NSFW 片段/预览 → 灰化 + 锁图标 +「成人」标签；仍占原 clip 几何（不塌缩）。
- **色例外**：成人字/glow `#4f8cff`；播放头与 seek 填充保持 `#5ba0ff`（非成人标识）。
- **与前轮**：seek/进度 **3px** ↔ R7；坞全宽 ↔ R3 三栏；详情 420 不改 dock-h。
- **校验**：切双闸前后同轨高/同播放头/同坞高；开闭 Inspector 320↔420 仅中列宽度变，timeline token 快照不变。

---

## Blockers / 未知

1. **Runway / LumenX 完整时间线**：无对等开源像素；已用 BeefTV+dramaclaw+ArcReel 钉死，不阻塞。
2. **播放头默认色**：BeefTV 源码偏 danger——跨端必须换 accent，避免与 razor/失败态撞色。
3. **zoom min**：源码 0.02 过稀；产品是否接受 0.25 需 TL 默许（简报已按 0.25 推荐）。
4. **旧名**：若他处引用 `VISUAL_VIDEO_TIMELINE_R8_*`，以本文件为准。

---

## 落地状态（跨端）

- Token：`--toiv-timeline-*` + `--toiv-player-*`（canvas↔web）
- UI：`CreationStudioPreviewTimeline` 全宽贴底 `/create`
- 契约 mock：`services/toiv/timeline-preview.ts` → `GET /api/studio/projects/{pid}/timeline-preview`
- Handback：`apps/canvas/docs/PREVIEW_TIMELINE_R8_HANDBACK.md`
