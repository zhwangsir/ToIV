# ToIV 开发指南

> **版本**: 2026-08-26
> **适用读者**: 开发人员 / 运维人员
> **核心文档**: [AGENTS.md](AGENTS.md) / [STATE.json](STATE.json) / [TEST_LOG.md](TEST_LOG.md) / [README.md](README.md)

**2026-09-03 H3 GPU 钉卡（设备管家 SSH 核实；ToIV 开发做钉卡，设备管家未改文档）**：toiv-comfyui-h3 drop-in `/etc/systemd/system/toiv-comfyui-h3.service.d/gpu-pin.conf`，`CUDA_DEVICE_ORDER=PCI_BUS_ID` + `CUDA_VISIBLE_DEVICES=GPU-0e6e9149-a5af-1474-c18b-2d6d2cf7a401`（PCI C1:00.0，物理 GPU2，非数字 CVD=2）。现 PID 在 GPU2，Comfy vram_free ≈58GiB（门槛 36GiB 可通过）。根因：GPU0 “requires reset” 打乱 CUDA 序号，原先 CVD=2 落到 GPU3。未动 GPU0 reset，未杀 FlashTalk/fish-speech。⚠️ **GPU0 复位仍是独立未修事项，不要写成已修**。集群 SoT `AGENTS.md`。

**2026-09-03 `133f15a`（已双推，已上线 core）**：`133f15a` `fix(apps): 海螺市场应用走 H3 专用实例而不是通用池` 已双推 Gitee+GitHub 并上线 core。海螺市场应用跑 H3 图走专用 `:8195`，不再 `pool.pick`。LongCat 走 apps 仍走通用池。含此前 docs `3fc9d45`。toiv-api/toiv-web 健康 200。改 `apps.py` + `test_apps_run.py`。AGENTS.md 本地脏文件仍未提交未推。

**2026-09-03 `8f6665f`（已双推，已上线 core）**：docs `8f6665f` 已双推 Gitee `Winery_z/ToIV` + GitHub `zhwangsir/ToIV`（含产品 `262bb5a`）。core 此前已上该产品。AGENTS.md 本地脏文件未提交未推。现已叠 `133f15a`。

**2026-09-03 `262bb5a`（当时远程未推；现已双推）**：产品 SHA `262bb5a` 已上线 core（**远程未推**）。toiv-api/toiv-web 健康 200；前端 BUILD_ID `20260903-020621-262bb5a-dirty`；启动日志「内置应用播种完成:新增 1206 个」（核心内置 + 1166 `rh-*`）。覆盖此前未提交的应用市场/H3 预制/1166 搜索卡栈。AGENTS.md 未动。

**2026-09-03 `262bb5a`（当时未上 core；现已上线 core，远程仍未推）**：产品 SHA `262bb5a` `feat(apps): RunningHub H3 应用市场与 1166 社区预制`（**本地已提交，远程未推，未上 core**）。覆盖此前未提交的应用市场/H3 预制/1166 `rh-*` 播种栈。生产库仍要 API 重启 `seed_builtin_apps` 才写得进 rh-*。上线口径等 core 健康检查。AGENTS.md 未动。

**2026-09-03 RunningHub H3 搜索卡预制播种（当时未提交；现已由 `262bb5a` 提交，仍未上 core）**：RunningHub H3 搜索卡已作为内置应用预制播种进本地树（**未提交、未上 core**，无产品 SHA）。去重 1166 个 `rh-*` id，挂在已有 family 图上（不是 1166 张独立 Comfy JSON）。分类大约：场景 246、全能参考 r2v 268、首尾帧 139、图生 125、图生加速 100、口播 98、文生 73、洗视频/v2v 48、换人 wan-animate-2 13、时间静止 2（i2v 提示词前缀）。NSFW 约 110。假 20s/一分钟卡映射到 15s 加速并在简介写明单段上限 15s。原生分辨率仍是约 1344×768，不是 928P。落地：`apps/api/app/data/rh_h3_presets.json`、`services/rh_h3_preset_seed.py`、`_build_specs` 末尾 extend。FEATURED 视频应用未加入 `rh-*`。生产库要 API 重启跑 `seed_builtin_apps` 才看得见。不要写成已上线。AGENTS.md 未动。

**2026-09-03 H3 应用/预制收口（当时未提交，现已由 `262bb5a` 提交，仍未上 core / 上线口径未写）**：收口完成（**仍未提交、未部署**，无产品 SHA）。视频 featured 已含 `15s-fast` / `r2v-voice` 及 nsfw 孪生。H3 worker `object_info` 确认有 `MiniMaxH3ReferenceToVideo`。API 聚焦测 219 过，web `npm test` 910 过。小程序仍引擎优先（无 apps API 客户端，未新开架构）。1262 社区 JSON 未导入、无场景卡、无假 20s。STATE 仍不加厚，等 commit SHA 或部署。AGENTS.md 未动。

**2026-09-03 H3 应用/预制三块已落本机（当时未提交，现已由 `262bb5a` 提交，仍未上 core / 上线口径未写）**：三块已落本机（**仍未提交、未部署**，无 SHA）。1) 图片/视频 `KindCreateView` 应用优先，高级引擎保留 `GenerateView`；H3 卡排前。2) 预制 `h3-t2v-15s-fast` / `h3-i2v-15s-fast` / `h3-r2v-voice` 及 nsfw 孪生；不做假 20s。3) 助手工具 `list_apps`、`get_app`、`run_app`；`submit_generation` 改为应用优先；`h3-fl2v`/`h3-r2v` 进 `_DISPATCH`；技能 `h3-app-catalog`。测试：预制 24、应用视图 54、助手相关 63。STATE 仍不加厚，等 commit SHA 或部署。AGENTS.md 未动。

**2026-09-03 产品意图：RunningHub H3 工作流→应用/预制（当时尚未落地，三块已落本机但仍未提交）**：用户要的不是引擎再包一层，而是 RunningHub H3 工作流变成 ToIV 应用/预制；生成页改成选应用；助手能 `list_apps`/`run_app`。1262 张社区卡不 1:1 搬图，按能力族（文生/图生/首尾帧/全能参考/加速/声音参考）做应用+预制。正在改：视频入口应用优先（高级引擎仍保留）、助手 list_apps/run_app、H3 预制播种。细节等代码落地再写 STATE。AGENTS.md 未动。

**2026-09-03 市场 UI 多图上传（未提交未部署）**：文档更正（**仍未提交、未部署**）：应用市场 UI 多图上传已接上。根因是 `lib/apps.ts` 把 images/video/audio 强制收成 text。现 `AppParam` 保留上传类型，`ParamField` 复用 Generate 的 `RefImages`/`Image`/`Video`/`AudioUpload`，`buildRunValues` 提交 `string[]`。fl2v `last_frame` 钉到首帧 worker。web `npm test` 901 过。生成页 `max=9` 与 list binding 扇出不变。AGENTS.md / 设备清单未动。

**2026-09-03 `:8195` ComfyUI 0.34.0（设备管家）**：设备管家回写：workstation `:8195` ComfyUI **0.30.0 → 0.34.0**（git `a87667f`，含 #15439 `MiniMaxH3AddGuide`）。原生 `MiniMaxH3AddGuide` 已出现；`ImageToVideo` / `ReferenceToVideo` 仍在。INT8/Turbo 未重下。未拉 spark02。集群账以 `AGENTS.md` 为准。

**2026-09-03 app-run list binding（未提交未部署）**：文档更正（**仍未提交、未部署**）：app-run 已改成 list binding 扇出。`h3-r2v`/`h3-nsfw-r2v` 的 images→LoadImage 110–118，video→120/122/124，audio→130–132；多余槽位从图里摘掉。`h3-fl2v` 仍是 images+last_frame→100/101。pytest `test_app_seed`/`test_apps_run`/`test_apps` 75 过。应用市场 UI 当时没有多图上传（已接上），生成页 `images.max=9` 不受影响。改动：`apps.py`、`app_seed.py`、`apps/web/lib/apps.ts` 及测试。AGENTS.md / 设备清单未动。

**2026-09-03 Phase 2 H3 fl2v/r2v（未提交未部署）**：Phase 2 H3 图已落本机（**未提交、未部署**）。新引擎 `h3-fl2v` / `h3-nsfw-fl2v` → POST `/api/h3/fl2v`（首尾帧，LoadImage 100/101 → 节点 104 `first_frame`/`last_frame`）；`h3-r2v` / `h3-nsfw-r2v` → POST `/api/h3/r2v`（`MiniMaxH3ReferenceToVideo`，最多 9 图 3 视频 3 音频）。SFW Ref2VA UNET：`minimax_h3_ref2va_pruned_int8_convrot.safetensors`。pytest `test_h3_studio` + `test_app_seed` + `test_engine_registry` 共 136 过。应用市场 r2v 当时只绑 `image1`（已由 list binding 覆盖），生成页 `images.max=9`。H3 worker 若无 `ReferenceToVideo` 节点会 503。改动：`h3_video.py`、`h3_studio.py`、`h3.py`、`engine_registry.py`、`app_seed.py`、`engines.ts` 及对应测试。AGENTS.md / 设备清单未动。

**2026-09-03 应用市场播种 7→36（未提交未部署）**：应用市场内置播种从 7 扩到 36（**未提交、未部署**）。改动在 `apps/api/app/services/app_seed.py` + `tests/test_app_seed.py`，pytest 65 过。原 7 张保留并修洞：`h3-t2v`、`h3-i2v`（补 LoadImage 节点 100 / `inputs.image`，以及 length/steps）、`txt2img-basic`、`img2img-basic`、`ltx-txt2video`、`ltx-img2video`（补图）、`ltx-lipsync`（补图+音频）。新 29：`h3-multishot`、`h3-nsfw-t2v`、`h3-nsfw-i2v`、`nsfw-txt2img`、`nsfw-img2img`、`qwen-image-edit`、`flux1-nunchaku`、`ltx25-multishot`、`wan-nsfw-i2v`、`wan-animate`、`wan-animate-2`、`wan-vace`、`longcat-t2v`、`longcat-i2v`、`avatar-talk`、`ovi-t2v`、`ovi-i2v`、`phantom-s2v`、`ace-music`、`ace-music-legacy`、`inpaint`、`upscale`、`removebg`、`controlnet`、`ipadapter`、`pulid`、`facedetailer`、`hunyuan-i2v`、`latentsync`。引擎别名：`txt2img`/`img2img` → `*-basic`；`ltx-nsfw-*` → 已有 `ltx-*` 三张。未上架（无诚实单表单图）：H3 Ref2VA 9 参考、H3 首尾帧、H3 声音克隆、`longcat-continue`、`wan-transition`、`keyframe-chain`、`vace-edit`。`hunyuan3d` 因 `output_kind` 无 glb 也未进。生产 `toiv.db` 需重启 API 才会 `seed_builtin_apps` 写入新卡。AGENTS.md / 设备清单未动。

**2026-08-30 `f480ead`（远程未推，已在 core，不必重部署）**：补 SHA `f480ead`（远程未推，**已在 core**，不必重部署）：`fix(generate): fill UploadedRef previewUrl/name on entity-cover submit`。编生产包时漏的两行类型，当时未提交跟着 rsync 上去了。只动 `GenerateView.tsx`。

**2026-08-30 `eb51c86`（远程未推，已上线 core）**：本地 `eb51c86`（远程未推，已上线 core）：停止会 `cancelJob`/中止请求；主体封面走 i2v/img2img；时长 4–15s 加分段续写开关；作品库含 `h3_extend_i2v` 和 `cad_`/`drama_char_reference_` 前缀。远程仍未推。已部署 core（toiv-api/toiv-web active；公网 `/api/health` 与 LAN `:8090`/`:3100` 200；前端 BUILD_ID `20260829-213739-72a9c0f-dirty`，UX 代码 `eb51c86`）。

**2026-08-30 `fb78872`（远程未推，已上线 core）**：本地 `fb78872`（远程未推，已上线 core）：`X-NSFW` 只作成人页查看/创建门禁，不再给每条作品盖 18+。`Job.nsfw` / H3 换 10Eros 仅当请求体显式 `nsfw:true`（`h3-nsfw-*` / `wan-nsfw-*`）或钉了 R18 LoRA。`is_nsfw(ckpt)` 收成明确成人词；pony/wai/illustrious 等两用底模不再整锅 18+。网页 `engines.ts` 已带 `nsfw:true`。生产库 3 条误标已改回 `nsfw=false`（4K 超分 `d79ca9cf…`、试穿 `t2v_00183_`/`t2v_00184_` = `e07b0cb4`/`71cf52cc`）。远程仍未推。已部署 core（toiv-api/toiv-web active；公网 `/api/health` 与 LAN `:8090`/`:3100` 200；前端 BUILD_ID `20260829-185858-fb78872-dirty`）。

**2026-08-28 20:46 `TOIV_WEB_SEARCH_PROXY`**：core env 已改为 `http://192.168.71.9:7897`（MateBook Clash LAN），`toiv-api` 已重启。旧 `.123` 从 core 连不上。TS `100.74.15.34:7897` 能通但未写入 env。

**2026-08-28 `58cf643`（本地未推）**：本地 `58cf643`（未推）：助手「答复时显示超时、刷新才有内容」——前端把还在跑的 SSE 掐了，后端已把 `AgentMessage` 落库。小程序 SSE 超时 180s→10min；Web/小程序超时后 GET 会话，若已有助手回复就展示，不再弹「回复失败:连接中断或超时」/「请求超时」。4xx/5xx、空会话、用户停止仍走旧错误。生产还没有这版。

**2026-08-28 `e833f33`（本地未推）**：本地 `e833f33`（未推）：助手上下文溢出（用户贴的 NSFW LLM 主备均不可用 / 32768 token / 0 output tokens）。工作副本 tool 正文上限 1800 字；`chat()` 不再每轮塞 17 个 `mcp__` schema；超长 400 再压一半预算重试一次，仍失败中文提示「这一条太长，请缩短本轮输入」（`a5e04ea` 起不再要求新开会话）NSFW 与主模型同一端点时不再双打。落库 `AgentMessage` 仍全量。生产还没有这版。

**2026-08-28 引擎文案 `0f6e723`（本地未推）**：ToIV 开发 `0f6e723`（本地，没换模、没推）：`engine_registry` H3 source 名/url→`MiniMaxAI/MiniMax-H3`；LTX-2.3 注释标明仅 R18；VACE 注释标明编辑/转场专用；`apps/api` 与 `deploy` 的 `.env.example` 已对齐。**H3=海螺 3.0，不是 Hailuo 2.3。**叠上 `f2885ee`：Wan2.2 / LTX-2.3 按 R18 写，SFW 主路只标 H3。脏 Ovi/MCP 工作区没带上。推会带上 Phase 4 整叠，故不推。

**2026-08-28 `859b60f`（本地未推）**：本地 `859b60f`（未推）：`LtxT2VRequest.height` 上限 1080→1920，对齐 `_LTX_NSFW_RESOLUTIONS` 竖版 720×1280；之前预设会 Pydantic 422。回归 `test_ltx_t2v_accepts_vertical_720p_preset`。只动 `video.py` + `test_video.py`。生产仍是旧 `le=1080`。空 `positive` 也会 422；缺 `X-NSFW` 是 403 不是 422。Ovi/MCP 未带上。

**2026-08-28 `93c275e`（本地未推）**：本地 `93c275e`（未推）：海螺/LTX/Wan 提交时 AI 从策划卡选 LoRA，禁止 NAS 自由混。协议：`loras` 省略/null = auto；显式 `[]` = off；非空 = pin（必须是策划卡文件名，否则 422）。前端空控件省略字段，故空白=auto。目录规模：Wan 6（全 NSFW，保留 HIGH/LOW）；H3 13（R18 + 部分 SFW；turbo 加速不自动选）；LTX 2（motion + dolly）。R18 空提示会插入引擎通用概念卡（H3 `HMNSFW_AIO_V2`，Wan `NSFW-22-H-e8`）。Wan auto 会按原 `pick_trigger_words` 前置触发词。LTX 无通用概念卡时可能 0 条（10Eros UNET 已承担 NSFW）。生产仍无此能力。Ovi/MCP 未带上。

**2026-08-28 `e1f856e`（本地未推）**：本地 `e1f856e`（未推）：`lora_picker` 在引擎没有 concept 卡时（LTX），R18 auto 回退第一张 motion 卡。提示词 `a` 会挂 `ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors`（0.8，`r18-default-motion`）。H3/Wan 仍优先概念卡。生产仍无此能力。Ovi/MCP 未带上。

---

## 目录

1. [快速开始](#1-快速开始)
2. [架构设计](#2-架构设计)
3. [核心功能模块](#3-核心功能模块)
4. [接口定义](#4-接口定义)
5. [部署说明](#5-部署说明)
6. [测试指南](#6-测试指南)
7. [常见问题排查](#7-常见问题排查)
8. [代码托管](#8-代码托管)
9. [仓库结构与命名规范](#9-仓库结构与命名规范)

---

## 1. 快速开始

### 1.1 后端

```bash
cd apps/api
cp .env.example .env          # 按需修改 ComfyUI 地址
uv sync --extra dev
uv run uvicorn app.main:app --reload --port 8080
uv run pytest                 # 跑测试
```

### 1.2 前端

```bash
cd apps/web
cp .env.local.example .env.local
npm install
npm run dev                   # http://localhost:3100
```

浏览器打开 http://localhost:3100,输入提示词点击「生成」。

---

## 2. 架构设计

### 2.1 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        ToIV Core (FastAPI)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  多镜头单次   │  │  关键帧链式   │  │  视频到视频   │          │
│  │  生成        │  │  转场        │  │  编辑        │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                   │
│         └─────────────────┼─────────────────┘                   │
│                           │                                     │
│                  ┌────────▼────────┐                            │
│                  │  Motion Brush   │                            │
│                  └────────┬────────┘                            │
│                           │                                     │
└───────────────────────────┼─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼───────┐   ┌───────▼───────┐   ┌───────▼───────┐
│  H3 引擎      │   │  Wan VACE     │   │  Worker Pool  │
│  :8195        │   │  :8197        │   │  (ComfyUI)    │
│  (GPU2)       │   │  (GPU0)       │   │               │
└───────────────┘   └───────────────┘   └───────────────┘
```

### 2.2 核心技术栈

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| **后端框架** | FastAPI | 0.115+ | 异步 API 框架 |
| **数据库** | PostgreSQL | 18 | 生产环境主库 |
| **ORM** | SQLModel | 0.0.22+ | 类型安全 ORM |
| **视频引擎** | MiniMax H3 | :8195 | 文生视频/图生视频(GPU2) |
| **视频编辑引擎** | Wan2.1-VACE 14B | :8197 | 视频编辑/转场(GPU0) |
| **工作流编排** | ComfyUI | 0.30.0+ | 节点式工作流 |
| **前端框架** | Next.js | 15.3+ | React 全栈框架 |
| **前端语言** | TypeScript | 5.6+ | 类型安全 |
| **UI 组件** | React | 19 | 组件库 |
| **测试框架** | pytest / vitest | - | 后端/前端测试 |

---

## 3. 核心功能模块

### 3.1 多镜头单次生成

**功能**: H3「镜头一…镜头二…」协议，单 prompt 多镜头连贯生成（对标 Vidu Q3 16s 声画同出）

**端点**: `POST /api/h3/multishot`

**请求体**:

```typescript
{
  "shots": [
    {
      "prompt": "深夜便利店,中年女人整理货架",
      "duration_sec": 5,
      "camera_hint": "固定",        // 可选: 推/拉/摇/移/跟/固定
      "transition_hint": "匹配切口"  // 可选: 硬切/淡入淡出/匹配切口
    },
    // ... 2-4 个镜头
  ],
  "width": 832,
  "height": 480,
  "steps": 20,
  "seed": 42
}
```

**生成的 prompt 协议**:

```
生成一段10秒、16:9、原生立体声视频,全片共两个镜头,按镜头顺序连续呈现;镜头之间主体、服装、场景与叙事保持连贯,每个镜头完整进入成片。
镜头一(约5秒):深夜便利店,中年女人整理货架,固定机位。
镜头切换:匹配切口。
镜头二(约5秒):门口风铃响,女人抬头看去。
```

### 3.2 关键帧链式转场

**功能**: 2-5 张关键帧 → N-1 段首尾帧转场 → 拼接至 ≤25s（对标 Pika 2.5 Pikaframes)

**端点**: `POST /api/generate/keyframe-chain`

**请求体**:

```typescript
{
  "keyframes": ["kf1.png", "kf2.png", "kf3.png"],
  "prompts": "镜头平滑过渡",  // 单 string 全段共用 或 list 逐段
  "worker": "http://192.168.71.127:8189",
  "durations": [3.0, 3.0],   // 可选,缺省 5s 均分
  "motion_mask": "motion-brush-xxx.png"  // 可选
}
```

**平滑过渡算法**: N 帧 → N-1 段，段 i 尾帧=段 i+1 首帧（用户关键帧，天然零跳变）

### 3.3 视频到视频编辑

**功能**: Aleph 式 in-context 编辑（改一帧→全片传播）（对标 Runway Aleph 2.0)

**端点**: `POST /api/generate/video-edit`

**请求体**:

```typescript
{
  "source_video": "multishot-output.mp4",
  "edit_prompt": "turn the footage into watercolor anime style",
  "edit_mode": "style_transfer",  // object_replace/object_remove/style_transfer/relight/camera_change
  "worker": "http://192.168.71.127:8189",
  "keyframe_indices": [0, 10, 20],  // 可选,≤5
  "preserve_mask": "motion-brush-xxx.png"  // 可选,白色保留/黑色重生成
}
```

**⚠️ 重要约束**: 视频编辑不支持 `motion_mask`（节点冲突），编辑区域控制唯一通道是 `preserve_mask`

### 3.4 Motion Brush 局部动效

**功能**: 涂抹标记视频区域+方向矢量，分区控制运动（对标 Runway Motion Brush 3.0)

**端点**: `POST /api/motion-brush/mask`

**请求体**:

```typescript
{
  "source_image": "kf1.png",
  "worker": "http://192.168.71.127:8189",
  "width": 512,
  "height": 512,
  "strokes": [
    {
      "center_x": 256,
      "center_y": 256,
      "radius": 50,
      "direction_x": 1,
      "direction_y": 0,
      "strength": 1.0
    }
  ]
}
```

**Mask 编码格式**: RGBA PNG，R=G=B=运动强度（0=静止，255=全强度）,A=方向角量化

---

## 4. 接口定义

### 4.1 错误码定义

| 状态码 | 说明 | 示例 |
|--------|------|------|
| 422 | 参数校验失败 | 镜头数 <2 或 >4 / 总时长 >15s / 关键帧 <2 或 >5 |
| 422 | 误传 motion_mask | 视频编辑不支持 motion_mask（节点冲突），应用 preserve_mask |
| 404 | 资源不存在 | 源视频/图片在 worker input 目录不存在 |
| 503 | 引擎不可达 | H3/VACE 服务未启动或网络故障 |
| 503 | 显存/RAM 不足 | 资源预检失败（可转 hold 排队） |

### 4.2 集成场景

| 场景 | 数据流 | 结果 |
|------|--------|------|
| **多镜头 → 视频编辑** | 多镜头产物文件名直作 `source_video` | ✅ 可组合 |
| **Motion Brush → 视频编辑** | `preserve_mask` 与 `edit_prompt` 同参共存 | ✅ 可组合 |
| **关键帧链 → 视频编辑** | 合并产物直作 `source_video` | ✅ 可组合 |
| **Motion Brush → 转场链** | `motion_mask` 段级透传（各段统一应用） | ✅ 可组合 |

---

## 5. 部署说明

### 5.1 环境要求

**硬件要求**:

| 组件 | 最低配置 | 推荐配置 |
|------|----------|----------|
| **core 服务器** | 4C8G, 50G SSD | 8C16G, 100G SSD |
| **H3 引擎** | GPU 40G 显存， RAM 30G | GPU 60G 显存， RAM 50G |
| **VACE 引擎** | GPU 25G 显存， RAM 15G | GPU 40G 显存， RAM 25G |

**软件要求**:
- OS: Ubuntu 22.04 LTS
- Python: 3.13+
- Node.js: 20+
- PostgreSQL: 18
- Redis: 7+
- ComfyUI: 0.30.0+
- CUDA: 12.8+ (sm_120 Blackwell 必需）

### 5.2 部署步骤

#### 1. 代码部署

```bash
# 本地开发环境
cd /Users/wangzhenyu/Desktop/ALLProject/ToIV

# 前端构建(必须干净重建,防 P-2 陈旧构建)
cd apps/web
rm -rf .next
npm run build
cat .next/BUILD_ID  # 确认 BUILD_ID 是当次代码的新构建

# 部署到 core
cd /Users/wangzhenyu/Desktop/ALLProject/ToIV
bash deploy/deploy.sh
```

#### 2. 服务验证

```bash
# 检查 API 健康
curl -s http://192.168.71.47:8090/api/health

# 检查引擎上架
TOKEN=$(curl -s -X POST http://192.168.71.47:8090/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin","password":"admin123"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -s http://192.168.71.47:8090/api/models/engines \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print([e["id"] for e in d["engines"] if "multishot" in e["id"] or "keyframe" in e["id"] or "vace-edit" in e["id"]])'
```

### 5.3 配置说明

**环境变量**（core `/home/merlin/toiv/deploy/.env`):

```bash
# H3 引擎
TOIV_H3_BASE_URL=http://192.168.71.127:8195
TOIV_H3_NSFW_UNET=10Eros_Max_h3_TURBO_ref2va_beta2_int8_convrot.safetensors

# VACE 引擎(LongCat 实例)
TOIV_LONGCAT_BASE_URL=http://192.168.71.127:8197

# Worker Pool
TOIV_COMFY_WORKERS=http://192.168.71.127:8189,http://192.168.71.116:8188,http://192.168.71.114:8193

# 资源预算预检
TOIV_H3_MIN_FREE_VRAM_GB=25
TOIV_H3_MIN_FREE_RAM_GB=15
TOIV_WAN_MIN_FREE_VRAM_GB=15
TOIV_WAN_MIN_FREE_RAM_GB=10

# Hold 排队
TOIV_HOLD_QUEUE_ENABLED=true
TOIV_HOLD_CHECK_INTERVAL_SEC=30
TOIV_HOLD_RELEASE_MAX_PER_ROUND=2
TOIV_HOLD_TIMEOUT_SEC=3600
```

**systemd 服务**（core):

```bash
# 查看服务状态
systemctl status toiv-api
systemctl status toiv-web

# 重启服务(注意:必须用 sudo -n,SSH merlin 无免密 sudo)
sudo -n systemctl restart toiv-api
sudo -n systemctl restart toiv-web

# 查看日志
journalctl -u toiv-api --since '10 minutes ago' --no-pager
```

---

## 6. 测试指南

### 6.1 测试环境

| 环境 | 配置 |
|------|------|
| **生产服务器** | core (192.168.71.47) - Ubuntu 22.04, PostgreSQL 18, Redis |
| **H3 引擎** | workstation (192.168.71.127:8195) - GPU2, MiniMax H3 原生音画直出 |
| **VACE 引擎** | workstation (192.168.71.127:8197) - GPU0, Wan2.1-VACE 14B |
| **Worker Pool** | workstation:8189 + pc01:8188 + pc02:8193 (ComfyUI 集群） |
| **测试工具** | pytest 8.3+ (后端）, vitest 3.0+ （前端）, curl （生产 e2e) |

### 6.2 测试用例与结果

**后端测试（2248 passed)**:

| 模块 | 测试文件 | 用例数 | 覆盖点 |
|------|----------|--------|--------|
| 多镜头协议 | `test_multishot_protocol.py` | 29 | 协议组装（2/3/4 镜头）/校验（镜头数/时长越界）/时长分配（均分/自定义）/端点（mock 提交/参数校验）/R18 打标 |
| 视频编辑 | `test_video_edit.py` | 31 | 工作流构造（源视频帧序列/input_frames 连线/masks 生成）/五模式枚举/关键帧 ≤5/越界/时长 ≤10s/路径穿越/转运/503/NSFW 打标 |
| Motion Brush | `test_motion_brush.py` | 39 | 笔画校验（坐标/半径/强度/方向归一化）/mask 生成（单笔画/多笔画/方向编码）/端点（缺图 422/mock 保存）/与 VACE 集成（motion_mask 连线断言） |
| 关键帧链 | `test_keyframe_chain.py` | 35 | 校验（2 帧通过/1 帧 422/6 帧 422/段时长越界/总时长越界）/计划拆分（2 帧→1 段/3 帧→2 段/5 帧→4 段）/时长分配（均分/自定义/网格吸附）/端点（缺图 422/串行提交 mock/产物合并 Job)/R18 打标 |
| 集成测试 | `test_integration_video_pipeline.py` | 18 | 场景 A/B/C/D 全覆盖/模块边界/数据流契约/兼容性矩阵 |

**前端测试（641 passed)**:

| 模块 | 测试文件 | 用例数 | 覆盖点 |
|------|----------|--------|--------|
| 多镜头编辑器 | `multishot.test.ts` | 9 | 纯函数（总时长/拖拽排序/提交门控）/组件渲染/镜头卡增删/集成断言 |
| 视频编辑视图 | `videoEdit.test.ts` | 20 | 纯函数（模式枚举/帧索引换算/锚点切换/提交门控/提交链路/进度解析）/fetch 桩契约/组件与集成源码断言 |
| Motion Brush 编辑器 | `motionBrush.test.ts` | 15 | 纯函数（归一化/拖拽定向/撤销按手势/门控）+ submitMotionBrushMask/组件渲染/涂抹交互/笔画记录/撤销/预览/提交门控 |
| 关键帧链编辑器 | `keyframeChain.test.ts` | 13 | 总时长/拖拽/提示词组装/门控/载荷契约/段进度/源码断言 |

**TypeScript 编译**:0 错误

### 6.3 性能指标

| 指标 | 数值 | 说明 |
|------|------|------|
| **后端测试执行时间** | 77.46s | 2248 例全量回归 |
| **前端测试执行时间** | 2.0s | 641 例全量回归 |
| **生产部署时间** | ~30s | deploy.sh 全量（rsync + 重启） |
| **多镜头生成时长** | ~2-5min | H3 单段 10s 视频（2 镜头） |
| **关键帧链式转场时长** | ~3-8min | 3 帧→2 段，总 6s 视频 |
| **视频编辑时长** | ~2-6min | VACE 5s 编辑（五模式平均） |
| **Motion Brush mask 生成** | <1s | 单笔画 512×512 mask |

---

## 7. 常见问题排查

### 7.1 多镜头生成失败

**问题**: 提交返回 422 "镜头数必须 2-4 个"

**排查**:
1. 检查 `shots` 数组长度是否在 2-4 之间
2. 检查每个镜头的 `duration_sec` 是否在 2-8s 之间
3. 检查总时长是否 ≤15s

**解决**: 调整镜头数或时长

### 7.2 关键帧链提交失败

**问题**: 提交返回 422 "关键帧文件名不允许路径穿越"

**排查**:
1. 检查 `keyframes` 文件名是否包含 `..` 或以 `/` 开头
2. 检查文件名是否在 worker input 目录存在

**解决**: 修正文件名，确保在 worker input 目录存在

### 7.3 视频编辑误传 motion_mask

**问题**: 提交返回 422 "视频编辑不支持 motion_mask（节点冲突）；编辑区域控制请用 preserve_mask"

**排查**: 这是**预期行为**:`WanVaceEditParams` 继承的 `motion_mask` 字段在编辑图中不生效（节点 50 已被源视频占用），误传会被 `__post_init__` 显式拒绝

**解决**: 改用 `preserve_mask` 参数控制编辑区域

### 7.4 Motion Brush mask 不生效

**问题**: 提交后 mask 未应用到视频

**排查**:
1. 检查 mask 文件名是否正确（`motion-brush-*.png`)
2. 检查 mask 是否已转运到目标 worker input 目录
3. 检查 VACE 图节点 50-52 是否有 `ImageToMask(channel=red)` 节点

**解决**:
- 确认 mask 文件名正确
- 查看 worker input 目录是否有 mask 文件
- 查看 VACE history 确认节点连线

### 7.5 段 Job params 的 motion_mask 为空

**问题**: 查询段 Job 时 `params.motion_mask` 为空

**排查**: **这是设计如此**:API `/api/jobs` 列表不返回 params 内容，只有 `has_params: bool` 标记

**验证**:
```bash
# 直接查数据库
sudo -n -u postgres psql toiv -c \
  "SELECT id, kind, params::text FROM job WHERE kind='transition' ORDER BY created_at DESC LIMIT 3;"
```

**解决**: 这是正常行为，数据库中 params 完全正确

### 7.6 生产 API 进程不生效

**问题**: 代码已部署但 API 行为未变更

**排查**:
1. 检查代码 mtime:`ls -la /home/merlin/toiv/api/app/routes/wan_studio.py`
2. 检查 API 进程启动时间：`systemctl show toiv-api -p ActiveEnterTimestamp`
3. 检查 Python 模块缓存：`find /home/merlin/toiv/api/app -name '__pycache__' -type d`

**解决**:
```bash
# 清除 Python 字节码缓存
find /home/merlin/toiv/api/app -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null

# 强制重启(杀掉旧进程)
sudo -n systemctl stop toiv-api
sudo -n pkill -9 -f 'uvicorn app.main:app'
sleep 3
sudo -n systemctl start toiv-api
```

### 7.7 H3/VACE 实例不可达

**问题**: 提交返回 503 "H3 实例不可达" 或 "VACE 实例不可达"

**排查**:
```bash
# 检查 H3 实例
curl -s http://192.168.71.127:8195/system_stats

# 检查 VACE 实例
curl -s http://192.168.71.127:8197/system_stats
```

**解决**:
- 如果实例未启动，联系运维启动服务
- 如果显存不足，等待资源释放或转 hold 排队

---

## 8. 代码托管

### 8.1 Gitee 上传方法（全项目统一）

**背景**: GitHub 国内网络差，代码托管已统一切换至 **Gitee**(GitHub 仓库保留作历史备份，不再更新）

**账号与仓库**:
- Gitee 账号：**Winery_z**（所有项目仓库建在此账号下，**一律私有**)
- 仓库命名：与项目英文名一致（如 `AICG-DownLoader`、`ToIV`)
- 仓库地址格式：`https://gitee.com/Winery_z/<仓库名>.git`
- 私人令牌：**找用户/设备管家获取**（🔒 令牌禁止写入任何文件、文档、仓库）

**远程配置**:

```bash
cd <项目目录>

# 1. 原 GitHub 远程改名为备份(没有 GitHub 远程则跳过)
git remote rename origin github

# 2. Gitee 设为默认 origin
git remote add origin https://gitee.com/Winery_z/<仓库名>.git
```

**推送（令牌不落盘的标准方式）**:

```bash
git -c credential.helper='!f(){ echo username=Winery_z; echo password=<令牌>; };f' \
  push -u origin main
```

- 令牌只存在于该次命令中，**不会写入 .git/config**
- 推送后 `main` 自动跟踪 `origin/main`，之后日常 `git push` 若提示认证，重复上面的命令即可

**推送前自查清单（🔒 强制）**:

```bash
# 1. 敏感文件不得入库(.env 必须被忽略,以下命令应无输出)
git status --porcelain | grep -iE '\.env|credential|secret|\.pem|id_rsa'

# 2. 密钥不得出现在已跟踪内容(应无输出)
git grep -iE 'password=|secret=|sk-|token=' --cached -l

# 3. 大文件检查(Gitee 免费版单文件 >100MB 拒收、>50MB 警告)
git ls-files | xargs ls -l 2>/dev/null | awk '$5>50*1024*1024{print $5, $9}'
```

- 模型、视频产物、数据集：**不入库**，放 NAS(`\\192.168.71.7\NAS`)，仓库只留路径引用
- `works/`、`node_modules/`、`dist/`、`target/` 等产物目录确认在 `.gitignore`

**常见问题**:

| 问题 | 处理 |
|------|------|
| push 报 401/403 | 令牌错误或过期，找设备管家核实 |
| push 报文件过大 | 见自查清单第 3 条，大文件移出仓库改用 NAS |
| 网络超时 | Gitee 国内直连即可；⚠️ 关闭本机 mihomo 代理或加 `--noproxy` 思维排查 |

---

## 9. 仓库结构与命名规范

> 2026-08-27 系统性重组定版。新增文件/目录必须按下表归位，禁止在根目录与 `apps/web` 根新增松散脚本。

### 9.1 顶层布局

```
ToIV/
├── apps/
│   ├── api/            # FastAPI 后端(app/ 源码、tests/ pytest、migrations/)
│   └── web/            # Next.js 前端(app/ 路由、components/、lib/、tests/ 单测、e2e/ Playwright)
├── MiniProgram/        # 唯一移动端(uni-app 微信;必要时再出 App;自带五件套)
├── .archive/           # 已归档代码(含 mobile-expo-20260827, 原 Expo Mobile)
├── deploy/             # 生产部署与运维(见 9.2)
├── scripts/            # 仓库级脚本,按职能四分(见 9.3)
├── drama/              # 短剧运行时数据(assets/ 素材、output/ 产物,被代码+生产挂载引用,勿移动)
├── .github/workflows/  # CI(按 apps/api/** / apps/web/** 路径分发)
├── AGENTS.md           # 集群操作记忆与决策记录
├── STATE.json          # 项目状态快照
├── TEST_LOG.md         # 测试日志(时间倒序)
├── DEVELOPMENT.md      # 本文档
└── README.md           # 项目入口
```

**边界规则**:
- `opentalking` 等第三方独立项目**禁止 vendor 进仓**,以兄弟目录常驻(`../opentalking`),代码仅经 URL 引用(`.gitignore` 有防回潮守卫)。
- 运行时产物(`*.db`、`drama/output/`、`.coverage`、`test-results*/`)一律不入仓。
- `apps/web` 包管理器唯一 **npm**(package-lock.json);pnpm 文件已清除,禁止重新引入。

### 9.2 deploy/ 内部约定(生产路径引用,移动前必须查引用)

| 子项 | 职能 |
|------|------|
| `deploy.sh` | core/workstation 一键部署(rsync+重启+健康等待+回滚) |
| `bare-metal/` | core 裸机 systemd 安装(install.sh 被 deploy.sh --install 远端调用) |
| `mac-services/` | Mac 端 launchd 服务(demucs-mlx/vlm-72b/whisper-cpp) |
| `*-service/` | 独立微服务源码(tts/hy3dtex/scope/sysmetrics/3dops) |
| `docker-compose.yml` / `openresty-toiv.conf` / `toiv_model_paths.yaml` | 容器编排/反代/模型路径 |
| `download_models.sh` / `download-model.py` / `start-toiv-*.py` / `toiv-trainer.py` | 远端模型下载与进程拉起 |

### 9.3 scripts/ 四分组

| 分组 | 职能 | 示例 |
|------|------|------|
| `scripts/e2e/` | 端到端冒烟/链路验证(含生产 e2e 检查) | `e2e_prod_check.py`、`h3_core_e2e.py`、`longcat_smoke.py` |
| `scripts/eval/` | 质量评估/评分 harness | `r2v_eval*.py`、`qwen_edit_eval.py` |
| `scripts/h3/` | H3 LoRA 训练/恢复 | `h3_lora_dataset.py`、`h3_lora_smoke.sh` |
| `scripts/ops/` | 设备运维/探测/工具 | `device_connectivity_check.py`、`video_4k_upscale_parallel.py`、`ui_lint.mjs` |

### 9.4 命名规范

- 目录全小写,多词用连字符(`motion-brush`)或下划线(服务源码沿用 `snake_case`,新目录优先连字符)。
- 脚本名带职能前缀:e2e 检查 `e2e_*_check.py`,评估 `*_eval.py`,一次性调试脚本**不入仓**(本地用完即删)。
- 子项目 MiniProgram 自治:自维护文档与测试,顶层文档不重复其内容。Expo Mobile 已归档,禁止再加第二套移动端。

---

**文档维护**: 本文档随代码变更同步更新，最后更新 2026-08-27。如有疑问请联系开发团队。
