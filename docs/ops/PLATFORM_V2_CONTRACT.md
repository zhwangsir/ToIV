> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行主机 / 端口 / 权重 / DOWN 口 → [`docs/ops/CLUSTER_TRUTH.md`](CLUSTER_TRUTH.md)。正文仅作考古，禁止盲抄配置。

# ToIV v2 平台契约（S1/W0.3 冻结稿 · 2026-10-11）

> **定位**：`UNIFIED_PLATFORM_PLAN_20261010.md` §3/§4.1 的落地契约。S2 起各批次只准**加字段不准改语义**；改语义须回本文件升版并记变更。
> **原则**：贴着现有实体做增量，不另起炉灶。核心发现——`DramaProject` 家族已实现 v2 设想的大半（角色三视图 M1、衔接策略 seam_to_next、多候选 DramaShotCandidate、宫格分镜 grid_image、跨项目资产库 DramaAsset），v2 = 正式化命名 + 补四处缺口。

---

## 1. 项目域实体（复用映射 + 增量）

### 1.1 复用（现名即 v2 名，语义不变）

| v2 概念 | 现实体（apps/api/app/models.py） | 备注 |
|---|---|---|
| 项目 | `DramaProject` | status: draft\|storyboard\|generating\|ready；含 script/style/fps |
| 角色（项目内） | `DramaCharacter` | 已含三视图 reference_front/side/back + reference_status 异步状态机 |
| 镜头 | `DramaShot` | 已含 mood/beat/seam 策略层/color-mark 校验/多状态机 |
| 候选 | `DramaShotCandidate` | is_picked 挑选语义保留 |
| 资产（跨项目库） | `DramaAsset` | kind: character\|scene\|prop\|style |
| 生成任务 | `Job`（+管线 C 顶层 DB id 契约） | 取消走 `/api/jobs/{id}/cancel`，嵌套 job_id 可能是 Comfy prompt_id |
| 对话会话 | `DramaSession`/`DramaEvent`、`AgentRun` | Agent 侧不动 |

### 1.2 增量（v2 新实体/新字段，S2+ 各批实现）

| 实体/字段 | 内容 | 落批 |
|---|---|---|
| `DramaShot.workflow_template` (str) | 引用工作流模板 id（§3）；空=项目默认 | S7 |
| `DramaShot.qc` (str/JSON) | 质检门禁结果：{face, outfit, scene, halluc_face, verdict, checked_at, candidates:[{url,score,rejected_reason}]} | S8 |
| `DramaShot.last_frame_url` (str) | 尾帧缓存 URL（机位树 lite / seam=continue 的输入） | S7 |
| `DramaProject.storyboard_meta` (str/JSON) | 分镜自动化回执：{model, prompt_hash, attempts, accepted_at, edited_by_human:bool} | S5 |
| `RenderVersion`（新表） | 成片版本：{id, project_id, kind: draft\|final, playlist(JSON §4), video_url, duration_sec, created_from(job_id)} | S9 |
| `AssetThreeView`（并入 DramaAsset） | DramaAsset 增加 reference_front/side/back + status（对齐 DramaCharacter 既有字段名） | S6 |

**工件文件规范（Toonflow 式）**：所有生成工件落 `assets/<project_id>/<entity>/<entity_id>/<purpose>__<fingerprint8>.<ext>`；`purpose ∈ {ref, grid, frame_first, frame_last, video, voice, lipsync}`；`fingerprint8` = 内容 sha256 前 8 位（指纹缓存/断点续跑的判据）。DB 只存 URL 与指纹，文件即缓存。

## 2. API 面（v2 收敛方向）

- **壳层唯一数据面**：canvas 壳经 `/api/*`（FastAPI）取项目域；`/studio/api/*`（Go）仅画布文档/文件/插件。跨域只读，禁止双写。
- **分页契约（W0.2a 已落地，本条为通用规范）**：列表端点支持 `limit`（1–1000）+ `offset`；总数走 `X-Total-Count` 响应头（CORS 已暴露）；**未知 query 参数一律 422**（防静默失效）；响应体保持裸数组形态。
- **认证契约（W0.1 已落地）**：`POST /api/auth/login` 对 admin（或 `STUDIO_MULTITENANT=1`）直发 `toiv_session` HttpOnly cookie（Path=/studio, SameSite=Strict, Max-Age=token exp）；`/studio/auth/exchange` 保留为兼容读路径（P4 移除）；HMAC `X-ToIV-User` 链标记 deprecated（30 天兼容期后随 P4 移除）。
- **镜头生命周期 API**（S5+ 冻结形状）：
  - `POST /api/drama/projects/{id}/storyboard/auto` —— 剧本→分镜（§4 JSON 契约），写 storyboard_meta；
  - `POST /api/drama/shots/{id}/regenerate` —— 单镜重生成（target: video|voice|lipsync, keep_seed: bool）；
  - `GET /api/drama/projects/{id}/resume` —— 对账续跑（按工件指纹+Job 状态，E-7 双保险）。
- **既有端点不破坏**：/api/apps、/api/jobs、管线 C c-chains、audio_orchestrate 契约原样。

## 3. 工作流模板 schema（node_mapping 声明式，NovelFlow 式）

```jsonc
// 存放：DB 表 workflow_template（或 apps/api/app/data/workflows/*.json 起步）
{
  "id": "h3_ref2va_first_last",          // <engine>_<mode>_<keyframes>
  "engine": "h3",                         // h3 | comfy(lb) | longcat | wan_animate | tts | whisper
  "mode": "first_last",                   // single | first_last | kf2 | kf3 | kf4
  "comfy_workflow": "first_last_video_minimax_h3_ref2va.json",  // ComfyUI API 格式图
  "node_mapping": {                       // 声明式注入点（prompt/图/参数→节点 id）
    "prompt": "186", "negative": "187",
    "first_image": "52", "last_image": "53",
    "keyframe_1": "54", "keyframe_2": "55", "keyframe_3": "56",
    "audio": "61", "megapixels": "78", "duration": "79", "seed": "80"
  },
  "extension": { "max_clip_duration": 15, "frame_count": 2, "supports_audio": true },
  "ref_slots": {                          // 多参考槽位（海螺 9-3-3 分层命名）
    "character": { "max": 4, "required": 1 },
    "scene":     { "max": 2, "required": 0 },
    "motion":    { "max": 1, "required": 0 }
  },
  "acceleration": { "lora": "lightx2v_turbo_8step", "default_steps": 8 },
  "is_active": true
}
```
约束：同一 (engine, mode) 只一个 active；切换模板零代码（只换 node_mapping）；`ref_slots` 驱动 UI 参数收敛（Toonflow 能力矩阵思路）。

## 4. 分镜 JSON 契约（LLM 输出，程序校验 + 带前败重试）

```jsonc
{
  "shots": [{
    "idx": 0,
    "scene": "雨夜天台，霓虹反光",          // 中文场景
    "shot_size": "medium",                 // wide|medium|closeup|extreme_closeup
    "camera": "low_angle_dolly_in",        // 自由文本运镜
    "duration_sec": 6,                     // 2-15,受 extension.max_clip_duration 校验
    "characters": ["林夏"],                 // 必须是项目资产库中存在的角色名(校验)
    "props": ["伞"],
    "dialogue": "你来得比雨还准时。",
    "speaker": "林夏",                      // 或 narrator
    "mood": "克制张力",
    "beat": "铺垫",
    "seam_to_next": "continue",            // continue|overlap|matchcut|hardcut
    "seam_anchor": ""
  }]
}
```
校验规则：characters/props 引用存在性；duration 区间；枚举字段合法；镜数 ≥1。校验失败把错误清单 + previous_failed_attempts 回喂 LLM 重试（≤3 次）。

## 5. Shot 状态机（现状正式化）

```
图: pending→generating→done|error   （N 候选并行,DramaShotCandidate 各自状态）
配音: pending→generating→done|error  （IndexTTS;voice_url）
口型: ""→generating→done|error       （lipsync,可选）
续写: ""→continuing→done|error       （seam=continue 时）
QC:  候选齐→qc_checking→qc_pass|qc_fail→(fail 触发补候选,≤2 轮)
```
`qc` 为 S8 新增层，不改变既有四状态机语义。

## 6. 变更记录

- 2026-10-11 v1（S1/W0.3）：初版冻结。依据：models.py 现状（DramaProject 家族含三视图/seam/候选/资产库）+ W0.1/W0.2a 已落地行为 + NovelFlow node_mapping/ViMax 参考槽位设计。
