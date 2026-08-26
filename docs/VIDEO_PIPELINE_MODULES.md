# ToIV 视频创作四模块技术文档

> **版本**: 2026-08-26 (commit c9e5cf9)
> **状态**: 已部署生产环境并全面验证
> **适用读者**: 开发人员 / 运维人员 / 技术决策者

---

## 目录

1. [系统概述](#1-系统概述)
2. [架构设计](#2-架构设计)
   - 2.1 [模块间关系](#21-模块间关系)
   - 2.2 [数据流图](#22-数据流图)
   - 2.3 [核心技术栈](#23-核心技术栈)
3. [接口定义](#3-接口定义)
   - 3.1 [多镜头单次生成](#31-多镜头单次生成)
   - 3.2 [关键帧链式转场](#32-关键帧链式转场)
   - 3.3 [视频到视频编辑](#33-视频到视频编辑)
   - 3.4 [Motion Brush 局部动效](#34-motion-brush-局部动效)
4. [系统测试报告](#4-系统测试报告)
   - 4.1 [测试环境](#41-测试环境)
   - 4.2 [测试用例与结果](#42-测试用例与结果)
   - 4.3 [性能指标](#43-性能指标)
   - 4.4 [集成测试场景](#44-集成测试场景)
5. [部署说明](#5-部署说明)
   - 5.1 [环境要求](#51-环境要求)
   - 5.2 [部署步骤](#52-部署步骤)
   - 5.3 [配置说明](#53-配置说明)
6. [常见问题排查指南](#6-常见问题排查指南)
7. [附录](#7-附录)
   - 7.1 [术语表](#71-术语表)
   - 7.2 [参考文档](#72-参考文档)

---

## 1. 系统概述

ToIV 视频创作四模块是 2026-08-26 落地的完整视频创作管线，包含：

| 模块 | 功能 | 对标竞品 | 状态 |
|------|------|----------|------|
| **多镜头单次生成** | H3「镜头一…镜头二…」协议，单 prompt 多镜头连贯生成 | Vidu Q3 16s 声画同出 | ✅ 已部署 |
| **关键帧链式转场** | 2-5 张关键帧 → N-1 段首尾帧转场 → 拼接至 ≤25s | Pika 2.5 Pikaframes | ✅ 已部署 |
| **视频到视频编辑** | Aleph 式 in-context 编辑（改一帧→全片传播） | Runway Aleph 2.0 | ✅ 已部署 |
| **Motion Brush 局部动效** | 涂抹标记视频区域+方向矢量，分区控制运动 | Runway Motion Brush 3.0 | ✅ 已部署 |

**核心价值**：四模块无缝衔接，形成「多镜头生成 → 关键帧转场 → 视频编辑 → 局部动效」的完整视频创作流程，全部基于自托管开源模型（H3/Wan VACE），零边际成本，支持 R18 无审查内容。

---

## 2. 架构设计

### 2.1 模块间关系

```
┌─────────────────────────────────────────────────────────────────┐
│                        ToIV Core (FastAPI)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  多镜头单次   │  │  关键帧链式   │  │  视频到视频   │          │
│  │  生成        │  │  转场        │  │  编辑        │          │
│  │              │  │              │  │              │          │
│  │ multishot_   │  │ keyframe_    │  │ wan_vace.    │          │
│  │ protocol.py  │  │ chain.py     │  │ py (edit)    │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                   │
│         └─────────────────┼─────────────────┘                   │
│                           │                                     │
│                  ┌────────▼────────┐                            │
│                  │  Motion Brush   │                            │
│                  │  motion_brush.  │                            │
│                  │  py             │                            │
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

**模块依赖关系**：

- **多镜头生成** → 独立模块，产物可作视频编辑源
- **关键帧链式转场** → 复用 `transition` 端点核心逻辑，产物可作视频编辑源
- **视频到视频编辑** → 消费多镜头/关键帧链产物作为 `source_video`
- **Motion Brush** → 生成 mask PNG，供关键帧链/视频编辑/转场消费

### 2.2 数据流图

#### 场景 A：多镜头 → 视频编辑

```
用户上传 2-4 镜头描述
    │
    ▼
POST /api/h3/multishot
    │
    ├─→ multishot_protocol.build_multishot_prompt()
    │   └─→ 「镜头一(约5秒):...镜头切换:匹配切口。镜头二(约5秒):...」
    │
    ▼
H3 :8195 提交 (kind=h3_multishot)
    │
    ▼
产物视频文件 (worker input 目录)
    │
    ▼
POST /api/generate/video-edit
    │
    ├─→ source_video=<多镜头产物文件名>
    ├─→ edit_prompt="turn into watercolor style"
    │
    ▼
Wan VACE :8197 编辑 (kind=video_edit)
    │
    ▼
编辑后视频
```

#### 场景 B：Motion Brush → 关键帧链

```
用户上传源图 + 涂抹标记
    │
    ▼
POST /api/motion-brush/mask
    │
    ├─→ motion_brush.generate_mask()
    │   └─→ RGBA PNG (R=G=B=强度, A=方向角)
    │
    ▼
mask PNG (worker input 目录)
    │
    ▼
POST /api/generate/keyframe-chain
    │
    ├─→ keyframes=[kf1.png, kf2.png, kf3.png]
    ├─→ motion_mask=<mask 文件名>
    │
    ▼
段循环 (N-1 段 transition)
    │
    ├─→ WanVaceParams.motion_mask=mask_name
    ├─→ VACE :8197 提交 (kind=transition)
    │
    ▼
后台合并链
    │
    ├─→ _wait_files 逐段等产物
    ├─→ _concat_trim 精确裁剪
    │
    ▼
合并 Job (kind=keyframe_chain)
```

#### 场景 C：Motion Brush → 视频编辑

```
Motion Brush mask PNG
    │
    ▼
POST /api/generate/video-edit
    │
    ├─→ source_video=<源视频>
    ├─→ preserve_mask=<mask 文件名>
    │
    ▼
WanVaceEditParams
    │
    ├─→ preserve_mask → 编辑图节点 62-66
    │   (LoadImage→ImageToMask(red)→InvertMask)
    │
    ▼
VACE :8197 编辑
    │
    ▼
编辑后视频 (白色区域保留, 黑色区域重生成)
```

### 2.3 核心技术栈

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| **后端框架** | FastAPI | 0.115+ | 异步 API 框架 |
| **数据库** | PostgreSQL | 18 | 生产环境主库 |
| **ORM** | SQLModel | 0.0.22+ | 类型安全 ORM |
| **视频引擎** | MiniMax H3 | 8195 端口 | 文生视频/图生视频（GPU2） |
| **视频编辑引擎** | Wan2.1-VACE 14B | 8197 端口 | 视频编辑/转场（GPU0） |
| **工作流编排** | ComfyUI | 0.30.0+ | 节点式工作流 |
| **前端框架** | Next.js | 15.3+ | React 全栈框架 |
| **前端语言** | TypeScript | 5.6+ | 类型安全 |
| **UI 组件** | React | 19 | 组件库 |
| **测试框架** | pytest / vitest | - | 后端/前端测试 |
| **部署工具** | systemd + Docker | - | 服务管理 |

**关键设计决策**：

1. **VACE 视频编辑原理**：源视频帧序列喂给 `WanVideoVACEEncode.input_frames`，用 `input_masks` 控制哪些帧/区域保留/重生成，prompt 描述编辑指令，VACE 在潜空间做 in-context 编辑
2. **Motion Brush mask 编码**：RGBA PNG，R=G=B=运动强度（0=静止，255=全强度），A=方向角量化（为未来运动矢量引擎预留）
3. **关键帧链平滑过渡**：段 i 尾帧=段 i+1 首帧（用户关键帧，天然零跳变）
4. **多镜头协议**：「镜头一（约5秒）：主体+动作+场景，运镜。镜头切换：匹配切口。镜头二（约5秒）...」中文数字编号，运镜白名单（推/拉/摇/移/跟/固定）

---

## 3. 接口定义

### 3.1 多镜头单次生成

#### POST /api/h3/multishot

**功能**：H3 单段「镜头一…镜头二…」协议，单 prompt 多镜头连贯生成

**请求体**：

```typescript
{
  "shots": [
    {
      "prompt": "深夜便利店,中年女人整理货架",  // 镜头描述(必填)
      "duration_sec": 5,                        // 镜头时长 2-8s(必填)
      "camera_hint": "固定",                    // 运镜提示(可选: 推/拉/摇/移/跟/固定)
      "transition_hint": "匹配切口"             // 转场提示(可选: 硬切/淡入淡出/匹配切口)
    },
    // ... 2-4 个镜头
  ],
  "width": 832,        // 宽度 256-1344(默认 832)
  "height": 480,       // 高度 256-1344(默认 480)
  "steps": 20,         // 采样步数 1-50(默认 20)
  "seed": 42,          // 随机种子(可选)
  "loras": [],         // LoRA 列表(可选)
  "effect_preset": ""  // 特效预设(可选,见特效预设体系)
}
```

**响应**：

```typescript
{
  "prompt_id": "31cb5181-ce09-4719-a6ca-685412610705",
  "client_id": "b5827d8fc9b445c1ba57f634454b9265",
  "worker": "http://192.168.71.127:8195",
  "seed": 42,
  "queued_behind": 0
}
```

**错误码**：

| 状态码 | 说明 | 示例 |
|--------|------|------|
| 422 | 参数校验失败 | 镜头数 <2 或 >4 / 总时长 >15s / 单镜头 <2s |
| 503 | H3 实例不可达 | H3 服务未启动或网络故障 |
| 503 | 显存/RAM 不足 | 资源预检失败（可转 hold 排队） |

**示例**：

```bash
curl -X POST http://192.168.71.47:8090/api/h3/multishot \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "shots": [
      {"prompt": "深夜便利店,中年女人整理货架", "duration_sec": 5, "camera_hint": "固定"},
      {"prompt": "门口风铃响,女人抬头看去", "duration_sec": 5, "transition_hint": "匹配切口"}
    ],
    "seed": 42
  }'
```

**生成的 prompt 协议**：

```
生成一段10秒、16:9、原生立体声视频,全片共两个镜头,按镜头顺序连续呈现;镜头之间主体、服装、场景与叙事保持连贯,每个镜头完整进入成片。
镜头一(约5秒):深夜便利店,中年女人整理货架,固定机位。
镜头切换:匹配切口。
镜头二(约5秒):门口风铃响,女人抬头看去。
```

---

### 3.2 关键帧链式转场

#### POST /api/generate/keyframe-chain

**功能**：2-5 张关键帧 → N-1 段首尾帧转场 → 拼接至 ≤25s（对标 Pika 2.5 Pikaframes）

**请求体**：

```typescript
{
  "keyframes": ["kf1.png", "kf2.png", "kf3.png"],  // 关键帧文件名 list(2-5 张,必填)
  "prompts": "镜头平滑过渡",                       // 提示词(单 string 全段共用 或 list 逐段)
  "worker": "http://192.168.71.127:8189",         // 上传 worker(必填)
  "durations": [3.0, 3.0],                        // 每段时长(可选,缺省 5s 均分)
  "negative": "",                                  // 负向提示词(可选)
  "width": 512,                                    // 宽度 320-1280(默认 832)
  "height": 512,                                   // 高度 320-1280(默认 480)
  "steps": 20,                                     // 采样步数 1-50(默认 20)
  "cfg": 5.0,                                      // CFG 0-20(默认 5.0)
  "shift": 8.0,                                    // Shift 0-20(默认 8.0)
  "fps": 16,                                       // 帧率 8-30(默认 16)
  "seed": 42,                                      // 随机种子(可选)
  "motion_mask": "motion-brush-xxx.png"            // Motion Brush mask(可选)
}
```

**响应**：

```typescript
{
  "prompt_id": "chain-4b39dedd4849440c",  // 合并 Job ID
  "worker": "http://192.168.71.127:8197",
  "seed": 42,
  "segments": [                            // 段 Job ID list
    "e9cdf6b4-d8f4-45db-af6c-d307ec891e8f",
    "5a75b74c-36d9-4233-9cec-e7772e53b200"
  ],
  "total_duration": 6.0
}
```

**错误码**：

| 状态码 | 说明 | 示例 |
|--------|------|------|
| 422 | 参数校验失败 | 关键帧 <2 或 >5 / 总时长 >25s / 段时长越界 |
| 422 | 文件不存在 | 关键帧文件名在 worker input 目录不存在 |
| 503 | VACE 实例不可达 | :8197 服务未启动 |
| 503 | 显存/RAM 不足 | 资源预检失败（转 hold 排队） |

**数据结构**：

```python
@dataclass(frozen=True)
class KeyframeSegment:
    """单段转场:首帧 → 尾帧(段 i 尾帧 = 段 i+1 首帧,链式衔接)。"""
    first_frame: str
    last_frame: str
    prompt: str
    duration_sec: float
    frames: int  # 4k+1 网格吸附后帧数
    steps: int
    cfg: float
    seed: int | None  # 段种子(基础 seed + 段序号)

@dataclass(frozen=True)
class KeyframeChainPlan:
    """完整链式计划:segments 按链序;total_duration 为各段时长之和。"""
    segments: tuple[KeyframeSegment, ...]
    total_duration: float
    fps: int
    width: int
    height: int
    seed: int | None
```

**平滑过渡算法**：

- N 帧 → N-1 段，段 i 尾帧=段 i+1 首帧（用户关键帧，天然零跳变）
- durations 缺省每段 5s 均分
- 帧数按 VACE 4k+1 网格向上吸附（`snap_engine_frames`)
- 整链一次 `_wan_precheck_or_hold` 资源预检

**示例**：

```bash
curl -X POST http://192.168.71.47:8090/api/generate/keyframe-chain \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "keyframes": ["kf1.png", "kf2.png", "kf3.png"],
    "prompts": ["smooth color transition from red to green", "smooth color transition from green to blue"],
    "durations": [3.0, 3.0],
    "worker": "http://192.168.71.127:8189",
    "width": 512,
    "height": 512,
    "seed": 42,
    "motion_mask": "motion-brush-032a9860339e.png"
  }'
```

---

### 3.3 视频到视频编辑

#### POST /api/generate/video-edit

**功能**：Aleph 式 in-context 编辑（改一帧→全片传播；多镜头序列；最多 5 关键帧；对象增删换/重打光/换风格/换机位）

**请求体**：

```typescript
{
  "source_video": "multishot-output.mp4",  // 源视频文件名(必填,:8197 input 目录)
  "edit_prompt": "turn the footage into watercolor anime style",  // 编辑指令(必填)
  "edit_mode": "style_transfer",           // 编辑模式(必填,见下)
  "worker": "http://192.168.71.127:8189",  // 上传 worker(必填)
  "keyframe_indices": [0, 10, 20],        // 关键帧索引(可选,≤5,0 基帧索引)
  "preserve_mask": "motion-brush-xxx.png", // 区域保留 mask(可选,白色保留/黑色重生成)
  "width": 832,                            // 宽度(默认 832)
  "height": 480,                           // 高度(默认 480)
  "duration_sec": 5,                       // 时长(默认 5s,≤10s)
  "steps": 20,                             // 采样步数(默认 20)
  "cfg": 5.0,                              // CFG(默认 5.0)
  "seed": 42                               // 随机种子(可选)
}
```

**编辑模式枚举**：

| 模式 | 说明 | 示例 edit_prompt |
|------|------|------------------|
| `object_replace` | 对象替换 | "replace the red car with a blue truck" |
| `object_remove` | 对象移除 | "remove the person in the background" |
| `style_transfer` | 风格迁移 | "turn into watercolor anime style" |
| `relight` | 重打光 | "change to golden hour lighting" |
| `camera_change` | 相机变换 | "change to top-down aerial view" |

**响应**：

```typescript
{
  "prompt_id": "edit-abc123",
  "worker": "http://192.168.71.127:8197",
  "seed": 42
}
```

**错误码**：

| 状态码 | 说明 | 示例 |
|--------|------|------|
| 422 | 参数校验失败 | 关键帧 >5 / 时长 >10s / edit_mode 非法 |
| 422 | 误传 motion_mask | 视频编辑不支持 motion_mask（节点冲突），应用 preserve_mask |
| 404 | 源视频不存在 | source_video 在 worker input 目录不存在 |
| 503 | VACE 实例不可达 | :8197 服务未启动 |

**⚠️ 重要约束**：

- **motion_mask 字段继承但不消费**：`WanVaceEditParams` 继承自 `WanVaceParams` 的 `motion_mask` 字段在编辑图中不生效（节点 50 已被源视频占用），误传会被 `__post_init__` 显式拒绝（ValueError)。编辑区域控制唯一通道是 `preserve_mask`
- **关键帧锚点**：`keyframe_indices` 指定的帧 mask=0 整帧保留，其余帧重生成（改一帧→全片传播）
- **preserve_mask 语义**：白色区域保留不动，黑色区域重生成（与 Motion Brush 的 motion_mask 语义相反）

**示例**：

```bash
curl -X POST http://192.168.71.47:8090/api/generate/video-edit \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source_video": "multishot-output.mp4",
    "edit_prompt": "turn the footage into watercolor anime style",
    "edit_mode": "style_transfer",
    "worker": "http://192.168.71.127:8189",
    "duration_sec": 5,
    "seed": 42
  }'
```

---

### 3.4 Motion Brush 局部动效

#### POST /api/motion-brush/mask

**功能**：用户在源图（视频首帧/参考图）上涂抹标记区域+方向矢量，生成 RGBA mask PNG

**请求体**：

```typescript
{
  "source_image": "kf1.png",              // 源图文件名(必填,worker input 目录)
  "worker": "http://192.168.71.127:8189", // 上传 worker(必填)
  "width": 512,                           // 画布宽度(必填,与引擎生成分辨率一致)
  "height": 512,                          // 画布高度(必填)
  "strokes": [                            // 笔画 list(必填,≤64)
    {
      "center_x": 256,      // 圆心 x 坐标(画布内)
      "center_y": 256,      // 圆心 y 坐标(画布内)
      "radius": 50,         // 半径 5-100px
      "direction_x": 1,     // 方向矢量 x(归一化)
      "direction_y": 0,     // 方向矢量 y(归一化)
      "strength": 1.0       // 运动强度 0-1
    }
  ]
}
```

**响应**：

```typescript
{
  "mask": "motion-brush-032a9860339e.png"  // 生成的 mask 文件名
}
```

**错误码**：

| 状态码 | 说明 | 示例 |
|--------|------|------|
| 422 | 参数校验失败 | 坐标越界 / 半径越界 / 笔画数 >64 |
| 404 | 源图不存在 | source_image 在 worker input 目录不存在 |
| 502 | worker 故障 | mask 保存失败 |

**Mask 编码格式**：

- **RGBA PNG**:R=G=B=运动强度（0=静止，255=全强度，重叠取 max),A=方向角量化（静止/无方向=0)
- **消费方式**:
  - `wan-vace`/`transition` 的 `motion_mask` 入参 → `ImageToMask(channel=red)` → `VACEEncode.input_masks`
  - `video-edit` 的 `preserve_mask` 入参 → 编辑图节点 62-66（白色保留/黑色重生成）
  - `keyframe-chain` 的 `motion_mask` 入参 → 段级透传（各段统一应用）

**示例**：

```bash
curl -X POST http://192.168.71.47:8090/api/motion-brush/mask \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source_image": "kf1.png",
    "worker": "http://192.168.71.127:8189",
    "width": 512,
    "height": 512,
    "strokes": [
      {"center_x": 256, "center_y": 256, "radius": 50, "direction_x": 1, "direction_y": 0, "strength": 1.0}
    ]
  }'
```

---

## 4. 系统测试报告

### 4.1 测试环境

| 环境 | 配置 |
|------|------|
| **生产服务器** | core (192.168.71.47) - Ubuntu 22.04, PostgreSQL 18, Redis |
| **H3 引擎** | workstation (192.168.71.127:8195) - GPU2, MiniMax H3 原生音画直出 |
| **VACE 引擎** | workstation (192.168.71.127:8197) - GPU0, Wan2.1-VACE 14B |
| **Worker Pool** | workstation:8189 + pc01:8188 + pc02:8193 (ComfyUI 集群） |
| **测试工具** | pytest 8.3+ (后端）, vitest 3.0+ （前端）, curl （生产 e2e) |

### 4.2 测试用例与结果

#### 后端测试（2248 passed)

| 模块 | 测试文件 | 用例数 | 覆盖点 |
|------|----------|--------|--------|
| 多镜头协议 | `test_multishot_protocol.py` | 29 | 协议组装（2/3/4 镜头）/校验（镜头数/时长越界）/时长分配（均分/自定义）/端点（mock 提交/参数校验）/R18 打标 |
| 视频编辑 | `test_video_edit.py` | 31 | 工作流构造（源视频帧序列/input_frames 连线/masks 生成）/五模式枚举/关键帧 ≤5/越界/时长 ≤10s/路径穿越/转运/503/NSFW 打标 |
| Motion Brush | `test_motion_brush.py` | 39 | 笔画校验（坐标/半径/强度/方向归一化）/mask 生成（单笔画/多笔画/方向编码）/端点（缺图 422/mock 保存）/与 VACE 集成（motion_mask 连线断言） |
| 关键帧链 | `test_keyframe_chain.py` | 35 | 校验（2 帧通过/1 帧 422/6 帧 422/段时长越界/总时长越界）/计划拆分（2 帧→1 段/3 帧→2 段/5 帧→4 段）/时长分配（均分/自定义/网格吸附）/端点（缺图 422/串行提交 mock/产物合并 Job)/R18 打标 |
| 集成测试 | `test_integration_video_pipeline.py` | 18 | 场景 A/B/C/D 全覆盖（见 4.4)/模块边界/数据流契约/兼容性矩阵 |

**其他相关测试**：引擎注册（test_engine_plugins.py 17 例）/助手工具（test_agent_gen_tools.py 25 例）/H3 引用（test_h3_refs.py 19 例）

#### 前端测试（641 passed)

| 模块 | 测试文件 | 用例数 | 覆盖点 |
|------|----------|--------|--------|
| 多镜头编辑器 | `multishot.test.ts` | 9 | 纯函数（总时长/拖拽排序/提交门控）/组件渲染/镜头卡增删/集成断言 |
| 视频编辑视图 | `videoEdit.test.ts` | 20 | 纯函数（模式枚举/帧索引换算/锚点切换/提交门控/提交链路/进度解析）/fetch 桩契约/组件与集成源码断言 |
| Motion Brush 编辑器 | `motionBrush.test.ts` | 15 | 纯函数（归一化/拖拽定向/撤销按手势/门控）+ submitMotionBrushMask/组件渲染/涂抹交互/笔画记录/撤销/预览/提交门控 |
| 关键帧链编辑器 | `keyframeChain.test.ts` | 13 | 总时长/拖拽/提示词组装/门控/载荷契约/段进度/源码断言 |

**TypeScript 编译**:0 错误

### 4.3 性能指标

| 指标 | 数值 | 说明 |
|------|------|------|
| **后端测试执行时间** | 77.46s | 2248 例全量回归 |
| **前端测试执行时间** | 2.0s | 641 例全量回归 |
| **生产部署时间** | ~30s | deploy.sh 全量（rsync + 重启） |
| **多镜头生成时长** | ~2-5min | H3 单段 10s 视频（2 镜头） |
| **关键帧链式转场时长** | ~3-8min | 3 帧→2 段，总 6s 视频 |
| **视频编辑时长** | ~2-6min | VACE 5s 编辑（五模式平均） |
| **Motion Brush mask 生成** | <1s | 单笔画 512×512 mask |

**资源占用**：

- H3 引擎：GPU2 显存 ~41G（峰值 ~78G 安全）
- VACE 引擎：GPU0 显存 ~25G（作业完自动驱逐）
- RAM：多引擎并跑前需 `free -h` 查 available(183G 总量）

### 4.4 集成测试场景

#### 场景 A：多镜头 → 视频编辑

**验证点**：多镜头产物文件名直作 `source_video`，编辑图 50 节点 `VHS_LoadVideo` 断言

**数据流**：

```
POST /api/h3/multishot
  → 产物视频文件 (worker input 目录)
  → POST /api/generate/video-edit (source_video=<产物文件名>)
  → VACE 编辑
```

**结果**：✅ 可组合

#### 场景 B：Motion Brush → 视频编辑

**验证点**:`preserve_mask` 与 `edit_prompt` 同参共存；图支路 62-66 + 出口 90

**数据流**：

```
POST /api/motion-brush/mask
  → mask PNG
  → POST /api/generate/video-edit (preserve_mask=<mask 文件名>)
  → VACE 编辑 (白色区域保留, 黑色区域重生成)
```

**结果**：✅ 可组合

#### 场景 C：关键帧链 → 视频编辑

**验证点**:`keyframe_chain` 合并产物直作 `source_video`;`keyframe_indices` 锚点整帧保留向全片传播；三类 Job（段/合并/编辑）共存建档无 kind 冲突

**数据流**：

```
POST /api/generate/keyframe-chain
  → 合并产物视频
  → POST /api/generate/video-edit (source_video=<合并产物>)
  → VACE 编辑
```

**结果**：✅ 可组合

#### 场景 D：Motion Brush → 转场链

**验证点**:`transition.motion_mask` 已接通；与首尾帧 masks 经 `MaskComposite multiply` 交集（两约束同时生效）;`KeyframeChainRequest.motion_mask` 段级透传已接通

**数据流**：

```
POST /api/motion-brush/mask
  → mask PNG
  → POST /api/generate/keyframe-chain (motion_mask=<mask 文件名>)
  → 段循环 WanVaceParams.motion_mask=mask_name
  → VACE 提交
```

**结果**：✅ 可组合（段层 + 链端点双路径）

---

## 5. 部署说明

### 5.1 环境要求

**硬件要求**：

| 组件 | 最低配置 | 推荐配置 |
|------|----------|----------|
| **core 服务器** | 4C8G, 50G SSD | 8C16G, 100G SSD |
| **H3 引擎** | GPU 40G 显存， RAM 30G | GPU 60G 显存， RAM 50G |
| **VACE 引擎** | GPU 25G 显存， RAM 15G | GPU 40G 显存， RAM 25G |
| **Worker Pool** | GPU 20G 显存 × 3 | GPU 40G 显存 × 3 |

**软件要求**：

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

#### 3. 生产 e2e 验证

```bash
# 多镜头提交
curl -X POST http://192.168.71.47:8090/api/h3/multishot \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"shots":[{"prompt":"测试镜头一","duration_sec":5},{"prompt":"测试镜头二","duration_sec":5}],"seed":42}'

# 关键帧链提交
curl -X POST http://192.168.71.47:8090/api/generate/keyframe-chain \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keyframes":["kf1.png","kf2.png"],"prompts":"测试转场","worker":"http://192.168.71.127:8189","seed":42}'

# Motion Brush mask 生成
curl -X POST http://192.168.71.47:8090/api/motion-brush/mask \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source_image":"kf1.png","worker":"http://192.168.71.127:8189","width":512,"height":512,"strokes":[{"center_x":256,"center_y":256,"radius":50,"direction_x":1,"direction_y":0,"strength":1}]}'
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

## 6. 常见问题排查指南

### 6.1 多镜头生成失败

**问题**：提交返回 422 "镜头数必须 2-4 个"

**排查**：
1. 检查 `shots` 数组长度是否在 2-4 之间
2. 检查每个镜头的 `duration_sec` 是否在 2-8s 之间
3. 检查总时长是否 ≤15s

**解决**：调整镜头数或时长

---

### 6.2 关键帧链提交失败

**问题**：提交返回 422 "关键帧文件名不允许路径穿越"

**排查**：
1. 检查 `keyframes` 文件名是否包含 `..` 或以 `/` 开头
2. 检查文件名是否在 worker input 目录存在

**解决**：修正文件名，确保在 worker input 目录存在

---

### 6.3 视频编辑误传 motion_mask

**问题**：提交返回 422 "视频编辑不支持 motion_mask（节点冲突）；编辑区域控制请用 preserve_mask"

**排查**：
- 这是**预期行为**:`WanVaceEditParams` 继承的 `motion_mask` 字段在编辑图中不生效（节点 50 已被源视频占用），误传会被 `__post_init__` 显式拒绝

**解决**：改用 `preserve_mask` 参数控制编辑区域

---

### 6.4 Motion Brush mask 不生效

**问题**：提交后 mask 未应用到视频

**排查**：
1. 检查 mask 文件名是否正确（`motion-brush-*.png`)
2. 检查 mask 是否已转运到目标 worker input 目录
3. 检查 VACE 图节点 50-52 是否有 `ImageToMask(channel=red)` 节点

**解决**：
- 确认 mask 文件名正确
- 查看 worker input 目录是否有 mask 文件
- 查看 VACE history 确认节点连线

---

### 6.5 段 Job params 的 motion_mask 为空

**问题**：查询段 Job 时 `params.motion_mask` 为空

**排查**：
- **这是设计如此**:API `/api/jobs` 列表不返回 params 内容，只有 `has_params: bool` 标记

**验证**：
```bash
# 直接查数据库
sudo -n -u postgres psql toiv -c \
  "SELECT id, kind, params::text FROM job WHERE kind='transition' ORDER BY created_at DESC LIMIT 3;"
```

**解决**：这是正常行为，数据库中 params 完全正确

---

### 6.6 生产 API 进程不生效

**问题**：代码已部署但 API 行为未变更

**排查**：
1. 检查代码 mtime:`ls -la /home/merlin/toiv/api/app/routes/wan_studio.py`
2. 检查 API 进程启动时间：`systemctl show toiv-api -p ActiveEnterTimestamp`
3. 检查 Python 模块缓存：`find /home/merlin/toiv/api/app -name '__pycache__' -type d`

**解决**：
```bash
# 清除 Python 字节码缓存
find /home/merlin/toiv/api/app -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null

# 强制重启(杀掉旧进程)
sudo -n systemctl stop toiv-api
sudo -n pkill -9 -f 'uvicorn app.main:app'
sleep 3
sudo -n systemctl start toiv-api
```

---

### 6.7 H3/VACE 实例不可达

**问题**：提交返回 503 "H3 实例不可达" 或 "VACE 实例不可达"

**排查**：
```bash
# 检查 H3 实例
curl -s http://192.168.71.127:8195/system_stats

# 检查 VACE 实例
curl -s http://192.168.71.127:8197/system_stats
```

**解决**：
- 如果实例未启动，联系运维启动服务
- 如果显存不足，等待资源释放或转 hold 排队

---

## 7. 附录

### 7.1 术语表

| 术语 | 说明 |
|------|------|
| **多镜头单次生成** | H3 单段「镜头一…镜头二…」协议，单 prompt 多镜头连贯生成 |
| **关键帧链式转场** | 2-5 张关键帧 → N-1 段首尾帧转场 → 拼接至 ≤25s |
| **视频到视频编辑** | Aleph 式 in-context 编辑（改一帧→全片传播） |
| **Motion Brush** | 涂抹标记视频区域+方向矢量，分区控制运动 |
| **in-context 编辑** | 在上下文中编辑，只改指定元素，其余原样保留 |
| **关键帧锚点** | 指定的帧 mask=0 整帧保留，其余帧重生成 |
| **preserve_mask** | 区域保留 mask（白色保留/黑色重生成） |
| **motion_mask** | 运动区域 mask(R=G=B 强度，A 方向角） |
| **hold 排队** | 资源不足时作业转 hold 状态，资源释放后 FIFO 放行 |
| **4k+1 网格** | WanVideo 系时序网格（T-1)%4==0 |

### 7.2 参考文档

**内部文档**：

- [AGENTS.md](./AGENTS.md) - 集群操作记忆与决策记录（每次会话必读）
- [STATE.json](./STATE.json) - 项目状态快照（结构化状态）
- [TEST_LOG.md](./TEST_LOG.md) - 测试日志（按时间倒序）
- [README.md](./README.md) - 项目入口文档

**竞品参考**：

- [Vidu Q3](https://www.shengshu.com/zh/vidu-q3/) - 16s 声画同出+自动切镜
- [Pika 2.5](https://pikaslabs.com/pika-2.5/) - Pikaframes 关键帧链
- [Runway Aleph 2.0](https://runway.com/product/aleph-2) - in-context 编辑
- [Runway Motion Brush 3.0](https://runway.com/) - 局部动效标记

**技术参考**：

- [MiniMax H3](https://github.com/MiniMax-AI/MiniMax-H3) - 文生视频引擎
- [Wan2.1-VACE](https://github.com/Wan-Video/Wan2.1) - 视频编辑引擎
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) - 节点式工作流

---

**文档维护**：本文档随代码变更同步更新，最后更新 2026-08-26 (commit c9e5cf9)。如有疑问请联系开发团队。
