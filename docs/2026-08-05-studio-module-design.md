# Studio 创作工作室模块设计文档

> 日期：2026-08-05
> 状态：待用户最终审阅
> 目标：以全新模块替代现有短剧工作室（drama_studio）与漫剧（manju），统一为阶段式工作台 + 分镜级混合生成。

---

## 1. 背景与目标

现有「短剧工作室」与「漫剧」为两套独立流水线，前后端代码分离但功能高度相似（剧本 → 分镜 → 生成 → 配音 → 合成）。经用户确认推倒重来，重新设计为新模块 **Studio（创作工作室）**。

**核心决策（用户确认）**

- 全新交互范式，阶段式工作台重新设计，非两模块简单合并
- **分镜级混用**：同一项目内每个分镜独立选择「视频生成」或「图像+运镜」，短剧/漫剧边界消失
- 直接替换：旧模块下架，旧项目数据只读归档
- 架构方案：全新模块 + 策略化渲染层，复用现有 LLM/ComfyUI/TTS/合成服务

---

## 2. 架构总览

### 2.1 后端结构

```
apps/api/app/
├── routes/studio.py              # 薄路由：项目/分镜/角色/生成/合成端点
├── services/studio/
│   ├── orchestrator.py           # 阶段编排 + 分镜状态机
│   ├── storyboard.py             # LLM 剧本拆解（角色+分镜草稿，含建议 render_mode）
│   ├── renderers/
│   │   ├── base.py               # ShotRenderer 接口
│   │   ├── video.py              # 视频链：ComfyUI 视频工作流（LTX/H3/LiveAct）
│   │   └── image_motion.py       # 图像链：PuLID/IPAdapter 出图 + Ken Burns 运镜
│   ├── voice.py                  # TTS 配音 + 参考音管理
│   └── assemble.py               # ffmpeg 拼接/字幕/统一转码 → NAS
```

- 渲染策略按 `Shot.render_mode` 分发；下游配音、对口型、合成两链共享
- LLM 路由（L1-L4）、ComfyUI LB、IndexTTS2、ffmpeg 等现有服务经服务层复用，不重写
- 路由层薄，业务逻辑入 services/，遵循 AGENTS.md 代码规范

### 2.2 渲染策略契约

```python
class ShotRenderer(Protocol):
    async def render(self, shot: Shot, cast: list[Character]) -> RenderResult: ...
```

- `VideoRenderer`：分镜提示词 + 角色 PuLID 参考图 → ComfyUI 视频工作流 → `video_url`；可选 FlashTalk/LiveAct 对口型
- `ImageMotionRenderer`：同一参考图链出图 → `image_url` → Ken Burns 运镜合成动态剪辑
- 两链产出统一规格（分辨率/帧率），保证合成阶段无缝拼接

---

## 3. 数据模型（新表，旧表不动）

| 表 | 关键字段 |
|---|---|
| `studio_project` | id, title, premise, style_preset, status, final_url, created_at |
| `studio_character` | id, project_id, name, visual_prompt, reference_images(JSON), voice_ref_url |
| `studio_shot` | id, project_id, idx, scene, description, camera, dialogue, duration_sec, characters(JSON), **render_mode**(`video`/`image_motion`), status, image_url, video_url, voice_url, final_clip_url, error |

**分镜状态机**：`draft → queued → rendering → rendered → voiced → (lipsynced) → done`，任意步骤失败落 `error`，支持单镜重试。

**数据流**：剧本（premise → LLM 拆角色+分镜草稿，按画面动态程度建议 render_mode）→ 角色资产（参考图+参考音）→ 分镜编排（可改任何镜的 render_mode）→ 生成（按 render_mode 分发 renderer）→ 配音（视频镜可选对口型，图像镜走运镜+音频）→ 合成（ffmpeg 统一规格拼接，产出落 NAS `drama/final/`）。

---

## 4. 阶段式工作台（前端）

4 阶段，顶部步骤条导航：

| 阶段 | 内容 |
|---|---|
| ① 剧本 | 输入剧情 premise → AI 拆解（L3 模型）→ 角色清单 + 分镜表草稿；左右分栏：原文 / AI 产出，可逐条编辑 |
| ② 角色 | 角色卡片：视觉提示词、PuLID 参考图生成/上传、参考音上传试听；角色是跨镜一致性锚点 |
| ③ 分镜（核心） | 分镜卡片网格：场景、台词、运镜、时长、角色标签、**生成方式切换开关（视频/图像运镜）**、媒体预览、状态徽标；拖拽排序、单镜重生成、批量生成、失败重试 |
| ④ 合成 | 时间轴顺序预览、字幕开关、一键合成 → NAS 成片，下载/播放 |

**前端结构**：`components/studio/` 下 `StudioView.tsx` + `stages/` 四阶段组件 + `ShotCard.tsx`；状态管理 `hooks/useStudioProject.ts`；图标统一 lucide-react；TypeScript strict。

---

## 5. API 面（`/api/studio/`）

- 项目：`POST/GET /projects`、`GET/PATCH/DELETE /projects/{pid}`
- 剧本：`POST /projects/{pid}/script/parse`（LLM 拆解 → 角色+分镜草稿）
- 角色：`POST /{pid}/characters`、`POST /characters/{cid}/reference-image`、`POST /characters/{cid}/voice-ref`
- 分镜：`PUT /{pid}/shots`（批量保存）、`POST /shots/{sid}/render`、`POST /{pid}/render`（批量）
- 配音：`POST /shots/{sid}/voice`、`POST /shots/{sid}/lipsync`（仅视频镜）
- 合成：`POST /{pid}/assemble`；状态轮询 `GET /{pid}/status`

---

## 6. 错误处理与降级

- LLM 拆解失败（JSON 解析错/超时）：结构化错误返回，前端保留 premise，允许重试或手动建分镜
- ComfyUI 渲染失败：分镜落 `error` + 错误摘要，单镜重试；批量生成跳过失败镜继续
- TTS 不可达：配音步骤降级提示，不阻塞已渲染媒体
- NAS 不可达：复用 `_drama_root()` 同款降级模式落本地回退路径
- 外部调用经现有服务层超时/重试封装；路由不吞异常
- 文件路径沙箱校验，禁止路径穿越

---

## 7. 测试策略

- 后端 pytest：渲染策略分发（mock ComfyUI）、状态机流转、LLM 解析容错、NAS 降级、路径校验
- 前端 vitest：ShotCard 交互、render_mode 切换、阶段导航
- 回归：全量 pytest 通过后更新 STATE.json + TEST_LOG.md

---

## 8. 旧模块处置（直接替换）

- 前端：导航中短剧/漫剧入口替换为「创作」；旧视图组件删除
- 后端：`drama_studio.py` / `manju.py` 路由保留但标记 deprecated（旧项目数据只读可查），不再新增功能；后续版本随数据归档策略一并清理
- 文档：AGENTS.md 更新核心能力描述

---

## 9. 里程碑

| 里程碑 | 内容 |
|---|---|
| M1 | 数据模型 + 项目/角色/分镜 CRUD + LLM 剧本拆解 |
| M2 | 渲染策略层（VideoRenderer + ImageMotionRenderer）+ 单镜/批量生成 |
| M3 | 配音 + 对口型 + ffmpeg 合成落 NAS |
| M4 | 前端 4 阶段工作台 + 分镜卡片网格 + 入口替换 |
| M5 | 旧模块冻结、文档更新、全量回归 |

每个里程碑交付：实现 + pytest + 回归 + STATE.json/TEST_LOG.md 更新。
