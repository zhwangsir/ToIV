# NSFW 专区 LTX2.3 视频工作流接入计划

> 日期:2026-07-13
> 来源:[Civitai LTX2.3 All in one](https://civitai.red/models/2553704)
> 目标:NSFW 专区按 LTX2.3 全功能工作流配置,默认使用 10Eros 模型

## 一、背景

当前 NSFW 专区(`/nsfw`)仅复用 CreateView 的图像生成能力(txt2img/img2img)。用户要求按 Civitai 的 LTX2.3 All in one 工作流配置 NSFW 专区,引入视频生成能力,默认模型使用工作流推荐的:
- **10Eros v1.2** — NSFW 内容专用底模
- **LTX-2.3 distilled** — SFW 视频生成

## 二、后端架构现状(可复用)

| 能力 | 现状 | 复用方式 |
|---|---|---|
| ComfyUI 客户端 | `comfy/client.py` queue_prompt + WS | 直接复用 |
| Worker 池调度 | `comfy/pool.py` pick(required_nodes=) | 新增 LTX 节点集 |
| 后台作业追踪 | `comfy/tracker.py` spawn() | 直接复用 |
| SSE 进度回传 | `routes/jobs.py` job_events | 直接复用 |
| 工作流构造模式 | `workflows/*.py` 纯函数编译 | 新建 `ltx_video.py` |
| 节点能力清单 | `capabilities.py` required_nodes() | 新增 `ltx_video` kind |
| 视频生成路由 | `routes/video.py` generate_video | 新增 LTX 端点 |
| 图片/视频代理 | `routes/images.py` 支持 Range | 直接复用 |
| 模型族识别 | `model_profiles.py` detect_family | 新增 `ltx` 族 |

**后端无 LTX 代码,需新建。**

## 三、架构设计

### 3.1 后端新增

#### A. 工作流构造器 `apps/api/app/workflows/ltx_video.py`

按 ToIV 惯例(纯函数编译参数 → ComfyUI API dict),参考 `wan_i2v.py` 模式实现:

```python
def build_ltx_t2v_graph(params: LtxT2VParams) -> dict:
    """LTX2.3 文生视频。
    节点链:UNETLoader → CLIPLoader(T5) + VAELoader → LTXConditioning → KSampler → VAEDecode → VHS_VideoCombine
    """

def build_ltx_i2v_graph(params: LtxI2VParams) -> dict:
    """LTX2.3 图生视频。同上 + LoadImage → LTXImgToLatent
    """

def build_ltx_lipsync_graph(params: LtxLipsyncParams) -> dict:
    """LTX2.3 口型同步。同 i2v + 音频输入 + ID LoRA
    """
```

**关键参数**:
- 默认分辨率 720p(1280×720),v4.0 推荐
- 默认 2 阶段采样(半分辨率 + 2× 上采样)
- CFG=1(distilled 模型)+ NAG 负向提示词(v4.0 新增)
- 帧数 97(6 秒 @16fps)

#### B. 节点能力清单 `apps/api/app/capabilities.py`

新增 `ltx_video` kind:

```python
def required_nodes(kind: str) -> set[str]:
    if kind == "ltx_video":
        return {
            "UNETLoader", "CLIPLoader", "VAELoader",
            "LTXConditioning", "LTXImgToLatent", "LTXLatentToRGB",
            "VAEDecode", "VHS_VideoCombine",
            "RIFE VFI",                      # 插帧
            "Nvidia Video Super Resolution", # v4.0 超分(可选)
        }
```

#### C. 模型族识别 `apps/api/app/workflows/model_profiles.py`

新增 LTX 族:

```python
# detect_model_family() 新增分支
if "ltx" in name.lower() or "10eros" in name.lower():
    return "ltx"

# _PROFILES 新增
"ltx": GenProfile(
    cfg=1.0,           # distilled 模型 CFG=1
    sampler="euler",
    scheduler="normal",
    steps=20,         # 2 阶段采样时主 pass
    neg_prompt=False, # NAG 单独处理
),
"10eros": GenProfile(
    cfg=1.0,
    sampler="euler",
    scheduler="normal",
    steps=20,
    neg_prompt=False,
),
```

#### D. NSFW 默认模型配置 `apps/api/app/config.py`

```python
# 新增配置项
nsfw_default_video_ckpt: str = "10eros_v12.safetensors"  # NSFW 视频默认底模
nsfw_default_t5: str = "t5xxl_fp8_e4m3fn.safetensors"     # LTX 文本编码器
nsfw_default_vae: str = "ltx_vae.safetensors"             # LTX VAE
```

#### E. API 端点 `apps/api/app/routes/video.py`

新增 3 个端点:

| 端点 | 功能 | 鉴权 |
|---|---|---|
| `POST /api/generate/ltx-t2v` | LTX 文生视频 | JWT + NSFW 门槛 |
| `POST /api/generate/ltx-i2v` | LTX 图生视频 | JWT + NSFW 门槛 |
| `POST /api/generate/ltx-lipsync` | LTX 口型同步 | JWT + NSFW 门槛 |

**NSFW 门槛**:复用现有 `_gate_nsfw_ckpt()`(只在 X-NSFW 头存在时放行 10Eros)。

### 3.2 前端改造

#### A. NsfwView 扩展为双 tab

当前 NsfwView 仅复用 CreateView(图像)。改为:

```
┌─────────────────────────────────────────────────┐
│ [图像] [视频]  ← tab 切换                          │
├─────────────────────────────────────────────────┤
│ tab=image: <CreateView nsfw />  (现有,保留)       │
│ tab=video: <NsfwVideoView />   (新建)             │
├─────────────────────────────────────────────────┤
│ NSFW 推荐模型清单(现有,保留)                       │
└─────────────────────────────────────────────────┘
```

#### B. 新建 `NsfwVideoView` 组件

简化版 LTX 工作流 UI(不还原 LTX Director 时间线,用预设场景):

**3 种预设场景**(对应 Civitai 工作流的 Common Setups):
1. **文生视频** — 提示词 + 分辨率 + 时长
2. **图生视频** — 上传图 + 提示词 + 时长
3. **口型同步** — 上传图 + 上传音频 + 提示词

**参数面板**:
- 分辨率预设:480p / 720p(默认) / 1080p
- 帧数:97(6s) / 161(10s) / 241(15s)
- 2 阶段采样开关(默认开,480p 以下自动关)
- Detailer 开关(默认开)
- RIFE 插帧开关(默认开)
- 种子锁定(同 CreateView)

**进度展示**:
- 复用现有 SSE 机制
- 视频结果用 `<video>` 播放(支持 Range 请求)

#### C. API 客户端 `lib/api.ts`

新增 3 个函数:

```typescript
export function generateLtxT2V(params: LtxT2VParams): Promise<GenerateResponse>
export function generateLtxI2V(params: LtxI2VParams): Promise<GenerateResponse>
export function generateLtxLipsync(params: LtxLipsyncParams): Promise<GenerateResponse>
```

### 3.3 ComfyUI 侧依赖(部署侧,非代码)

#### 必装自定义节点(13 个)

```
ComfyUI-LTXVideo              # LTX 官方节点
comfyui_controlnet_aux         # ControlNet 辅助
ComfyUI-Impact-Pack            # Detailer
Rgthree-comfy                  # 工具集
ComfyUI-KJNodes                # KJ 节点
ComfyUI-Easy-Use               # 易用增强
ComfyUI-VideoHelperSuite       # VHS 视频合成
ComfyUI-Frame-Interpolation    # RIFE 插帧
Nvidia_RTX_Nodes_ComfyUI       # RTX 超分
WhatDreamsCost-ComfyUI         # LTX Director
TTS-Audio-Suite                # 音频套件
CRT-Nodes                      # CRT 节点
cg-use-everywhere              # 广播节点
```

#### 必装模型

```
checkpoints/ltx-2.3/distilled/ltx-2.3-distilled.safetensors     # 标准底模
checkpoints/10eros/10eros_v12.safetensors                       # NSFW 底模
text_encoders/t5xxl_fp8_e4m3fn.safetensors                      # T5 文本编码器
vae/ltx_vae.safetensors                                          # LTX VAE
upscale_models/nvidia_video_super_resolution.safetensors       # 超分(v4.0)
```

## 四、实施阶段

### Phase A:后端 LTX 工作流(核心)

1. `workflows/ltx_video.py` — 3 个图构造器
2. `capabilities.py` — 新增 `ltx_video` 节点集
3. `model_profiles.py` — 新增 LTX / 10Eros 族
4. `config.py` — 新增 NSFW 视频默认模型配置
5. `routes/video.py` — 新增 3 个 API 端点
6. 单元测试:图构造器参数验证

### Phase B:前端 NSFW 视频专区

1. `lib/types.ts` — LtxT2VParams / LtxI2VParams / LtxLipsyncParams 类型
2. `lib/api.ts` — 3 个 API 客户端函数
3. `components/nsfw/NsfwVideoView.tsx` — 视频生成组件
4. `components/nsfw/NsfwView.tsx` — 加 tab 切换(图像/视频)
5. E2E 测试:NSFW 视频专区渲染验证

### Phase C:ComfyUI 侧准备(部署侧,非代码)

1. 在 ComfyUI 安装 13 个自定义节点
2. 下载 LTX-2.3 + 10Eros + T5 + VAE 模型到 NAS
3. 验证 ComfyUI `/object_info` 返回所有必需节点
4. 跑一次裸 ComfyUI 工作流验证

### Phase D:联调与测试

1. 端到端联调:前端 → API → ComfyUI → SSE → 视频回放
2. E2E 测试:3 种预设场景
3. 性能验证:720p × 6s 视频生成耗时

## 五、关键决策点(需用户确认)

### 决策 1:NSFW 图像生成是否保留?

- **方案 A**:保留图像 tab + 新增视频 tab(双 tab,图像能力不丢)
- **方案 B**:完全替换为视频(NSFW 专区只做视频)

**建议**:方案 A(保留图像,新增视频),不破坏现有功能。

### 决策 2:前端是否还原 LTX Director 时间线?

LTX Director 支持分段编辑(首帧→中间→尾帧),功能强大但前端工作量大。

- **方案 A**:简化为 3 种预设场景(文生视频/图生视频/口型同步),不还原时间线
- **方案 B**:还原 LTX Director 时间线(增加 2-3 天前端工作量)

**建议**:方案 A(预设场景),覆盖 80% 用例,复杂时间线让用户直接用 ComfyUI CanvasView。

### 决策 3:10Eros 是否仅 NSFW 可用?

- **方案 A**:10Eros 仅在 NSFW 专区可选(X-NSFW 头放行)
- **方案 B**:10Eros 全局可用(主创作区也能选)

**建议**:方案 A(仅 NSFW),符合"NSFW 专区模型自行搭配"的定位。

### 决策 4:ComfyUI 自定义节点由谁安装?

13 个自定义节点需要手动安装到 ComfyUI。

- **方案 A**:用户自行安装(提供清单文档)
- **方案 B**:写自动化脚本(`deploy/install-ltx-nodes.sh`)

**建议**:方案 A + 文档清单,节点安装是一次性工作。

## 六、风险与依赖

| 风险 | 影响 | 缓解 |
|---|---|---|
| ComfyUI 未装 LTX 节点 | API 返回 503 | `required_nodes` 自动过滤,pool.pick 失败时给清晰提示 |
| 10Eros 模型未下载 | NSFW 视频无法生成 | 启动时检查模型存在性,缺失时引导用户下载 |
| VRAM 不足(<12G) | 720p 视频生成失败 | 参数钳位 + 降级提示(480p 单 pass) |
| 自定义节点版本冲突 | 工作流执行失败 | ComfyUI 安全等级临时降到 weak 安装 |
| LTX Director v2 兼容性 | 2026-06-22 热修复未完全测试 | 优先用 Legacy 工作流(LTX23Legacy.json) |

## 七、验收标准

1. `GET /api/models` 在 NSFW 模式下返回 10Eros 底模
2. `POST /api/generate/ltx-t2v` 返回 prompt_id + SSE 进度
3. 前端 `/nsfw` 可切换图像/视频 tab
4. 视频生成完成后 `<video>` 可播放
5. `npx tsc --noEmit` 0 错误
6. `npx playwright test` 全部通过
7. ComfyUI `/object_info` 返回所有 LTX 必需节点

## 八、工作量预估

| 阶段 | 内容 | 文件数 |
|---|---|---|
| Phase A | 后端 LTX 工作流 + API | 5 个文件 |
| Phase B | 前端 NSFW 视频专区 | 4 个文件 |
| Phase C | ComfyUI 节点安装(非代码) | 1 份文档 |
| Phase D | 联调测试 | 复用现有测试框架 |
