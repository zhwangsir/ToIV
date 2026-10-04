# 管线 C / c_hybrid 长视频续写 API 契约（PIPELINE_C_API）

> 状态：**契约草案 v0.1（先定契约，实现随 Batch6 落地）**
> 基线代码：`main` = `fb10f4be`（core 部署树 `/home/merlin/toiv` 同版本）
> 读者：BeefTV UI（独立前端产品）、ToIV 后端、部署负责人（ToIV 开发）
> 约定：**【现有】** = fb10f4be 中已存在、可直接引用的代码/字段；**【Batch6】** = 本契约提议、尚未实现。
> 所有路径均挂在 `/api` 前缀下（core：`http://127.0.0.1:8090/api/...`），鉴权沿用 ToIV 登录态（`get_current_user`）。

---

## 0. 现状盘点（以代码为准）

| 能力 | 代码位置 | 现状 |
|---|---|---|
| 单镜渲染入口 | `apps/api/app/routes/studio.py` `POST /studio/shots/{sid}/render`（`RenderShotBody`） | 【现有】**同步**等待出片（HTTP 连接一直挂到渲染结束），无 job_id |
| 项目批量渲染 | `POST /studio/projects/{pid}/render` | 【现有】同步、固定 `pipeline="c"`、`num_candidates=2`，不支持 c_hybrid |
| 编排 | `services/studio/orchestrator.py` `render_shot()` | 【现有】多候选串行、自动续写 latent、c_hybrid 首帧、选优、硬切裁头、落库 `StudioShot.candidates_json` |
| 管线 C 出图 | `services/studio/pipeline_c_render.py` `render_pipeline_c()` + `workflows/h3_pipeline_c.py` | 【现有】T8 Ref2VA / Hybrid、MotionContext 续写、原生音频、文字/颜色/硬切换 seed（最多 3 次提交） |
| worker 覆盖 | `services/h3.py` `H3_WORKER_OVERRIDE_WHITELIST` | 【现有】仅管理员；硬编码白名单 `http://100.68.100.90:8195`、`http://100.68.100.90:8264` |
| H3 调度 | `services/h3.py` `pick_h3_client()` / `h3_instances()` | 【现有】`TOIV_H3_BASE_URLS` 多实例按 `queue_len` 最短优先；core `.env` 当前 = `http://100.68.100.90:8264`（**未 pin 的 C 渲染今天就落在 :8264**） |
| 选优/门禁 | `services/studio/candidate_pick.py` `pick_best_candidate()` | 【现有】人脸分 + 文字门禁 + 硬切门禁 + 连贯分 + 回退罚分；全被拦 → `CandidatePickError` |
| 硬切/裁头 | `services/studio/hard_cut.py` `apply_hard_cut_rule()` | 【现有】首 1 秒/锚定区硬切 → 裁片头（音频同步）；裁后仍有 ≥2 处镜内硬切 → `cut_gate.blocked` |
| 服装状态 | `services/studio/outfit_state.py`、`pipeline_c_render._outfit_ref_check` | 【现有】仅记录（`hood_log` / `outfit_check`），不拦不扣分 |
| 镜头级参考覆盖 | `services/studio/shot_refs.py` `apply_ref_overrides()` | 【现有】仅 `render_shot(ref_overrides=…)` 内部参数；**HTTP 未暴露** |
| 成片拼接 | `POST /studio/projects/{pid}/assemble`、`services/studio/assemble.py` | 【现有】同步 concat；强制每镜有音轨、时长与源片误差 < 0.5s |
| 作业系统 | `models.Job`、`routes/jobs.py`：`GET /jobs/lookup`、`POST /jobs/{job_id}/cancel` | 【现有】C 渲染**不建 Job**；仅剧本拆解（`kind=studio_script_parse`）等走 Job |
| 今日链式驱动 | `apps/api/scripts/chybrid_rain_cmp_driver.py` | 【现有】离线脚本：克隆项目 → 按 idx 逐镜 `render_shot(pipeline="c_hybrid", worker_url=:8195)` → 失败从 Comfy history 按 prompt_id 回收 → 仍失败 `chain_abort` 退出 |

结论：BeefTV 需要的「异步 job + 链式多段 + 续写/追加 + 结构化错误码」今天**不存在 HTTP 形态**，只有同步单镜接口 + 离线驱动脚本。Batch6 的工作是把驱动脚本的链式语义搬进 API 后台任务，并统一挂到 Job 上。

---

## 1. 端点与请求体

### 1.1 端点总览

| 方法 | 路径 | 状态 | 用途 |
|---|---|---|---|
| POST | `/api/studio/c-chains` | 【Batch6】 | 新建一条续写链并开跑；立即返回 `job_id` |
| POST | `/api/studio/c-chains/{chain_id}/segments` | 【Batch6】 | 向已结束（done）的链**追加**段；返回新 `job_id` |
| GET | `/api/studio/c-chains/{chain_id}` | 【Batch6】 | 链详情：全部段、候选、门禁、成片 URL |
| POST | `/api/studio/c-chains/{chain_id}/segments/{seg_index}/pick` | 【Batch6】 | 人工改选某段候选（内部复用 `pick_candidate`）；仅允许链尾段，或带 `rerender_after=true` 重跑其后各段 |
| GET | `/api/jobs/lookup?job_id=…` | 【现有】+【Batch6 增量键】 | 进度/结果轮询（见 §3） |
| POST | `/api/jobs/{job_id}/cancel` | 【现有】+【Batch6 适配】 | 取消（见 §3.4） |
| GET | `/api/studio/files/{name}` | 【现有】 | 下载片段/成片/尾帧（需登录态，见开放问题） |
| POST | `/api/studio/shots/{sid}/render` | 【现有，保留】 | Studio UI 同步单镜接口，不改语义；BeefTV **不要**用它做长链 |

命名约定：`chain_id` = 承载该链的 `StudioProject.id`（链的段 = 该项目下按 `idx` 排序的 `StudioShot`）；每次「新建」或「追加」是一个独立 `Job`（`kind="studio_c_chain"`），同链多个 Job 用 `Job.root_id`（首个 Job）与 `Job.continued_from`（上一个 Job）串起来——这两列【现有】，`continued_from` 已用于 longcat 续写。

> 为什么不复用同一个 job_id 追加：`cancel_job` 与 tracker 把 `done/error/canceled` 视为不可逆终态（终态再取消返回 409），重开终态 Job 会破坏现有语义。

### 1.2 `POST /api/studio/c-chains` 请求体【Batch6】

```jsonc
{
  "pipeline": "c_hybrid",            // 【现有字段语义】c | c_hybrid；默认 c_hybrid（长链推荐）
  "project_id": null,                // 【Batch6】可选：挂到已有 Studio 项目（复用其角色/定妆）；空则后台新建隐藏项目
  "start": {                         // 【Batch6】起点，三选一
    "type": "makeup",                // makeup | video | job
    "video_url": null,               // type=video：仅接受 /api/studio/files/<name> 或本人 Job 产物
    "job_id": null                   // type=job：本人 status=done 的视频 Job，或某条 c-chain 的 Job（真续写）
  },
  "character_ids": ["<StudioCharacter.id>"],   // 【现有模型】出场角色；makeup 起点必填（需已定妆）
  "style": "anime",                  // 【现有】= RenderShotBody.ref_style：anime | ancient_realistic；空则按项目推断
  "aspect_ratio": "9:16",            // 【Batch6】见下方说明；现有代码只能出竖屏
  "resolution": { "width": 768, "height": 1344 },  // 【现有语义】StudioProject.width/height，snap 到 32、256–1344
  "keep_audio": true,                // 【Batch6】默认 true（H3 原生音频）
  "num_candidates": 2,               // 【现有】1–4，每段候选数（串行出）
  "seed": null,                      // 【现有】固定种子；候选 i 用 seed+i
  "ref_images": null,                // 【现有】≤9；显式参考图（角色设定卡 panel URL）；null = 按角色定妆自动收集
  "scene_images": [],                // 【现有】≤4；场景参考；≥2 张时按段 idx 轮换（resolve_scene_images_for_shot）
  "outfit_desc": "",                 // 【现有内部参数，Batch6 暴露】单一服装描述，并进英文视觉提示
  "auto_assemble": true,             // 【Batch6】全部段完成后自动拼接成片
  "worker_pool": null,               // 【Batch6，仅管理员】pool 名（如 "h3_eval"）；替代今天的 worker_url
  "segments": [                      // 【Batch6】1–N 段（单次提交上限建议 8，见 §5 并发）
    {
      "prompt": "Lin Xia pushes the glass door and walks into the store, rain behind her", // 【现有】StudioShot.prompt（英文）
      "duration_sec": 6,             // 【现有】StudioShot.duration_sec（int）；H3 网格 17k+5 帧@24fps，22–362 帧 ≈ 1–15 s
      "dialogue": "",                // 【现有】台词（不进画面文字，进音频语义）
      "speaker": "",                 // 【现有】
      "camera": "",                  // 【现有】运镜
      "scene": "",                   // 【现有】中文场景描述
      "characters": ["林夏"],        // 【现有】本段出场角色名
      "scene_images": null,          // 【Batch6】本段场景参考覆盖（null=继承顶层）
      "ref_overrides": {             // 【现有内部参数，Batch6 暴露】镜头级参考覆盖：{原URL或文件名: 替换URL}
        "char_panel_803fb69b_anime_front_x.png": "/api/studio/files/hood_down_front.png"
      },
      "outfit_desc": null,           // 【Batch6】本段服装描述覆盖
      "num_candidates": null         // 【Batch6】本段候选数覆盖
    }
  ]
}
```

字段要点：

- **start.type=makeup**（无起始视频，从角色定妆出发）【现有逻辑】：c_hybrid 首段首帧 = `_full_body_ref_url()` 选出的全身定妆图（优先文件名含 `full/全身` → 设定卡 `char_panel_{cid8}_{style}_front_*` → 槽标签「全身」）；找不到 → `PC_MAKEUP_MISSING`。`pipeline=c` 首段无首帧，纯 Ref2VA。
- **start.type=video / job**【Batch6】：抽起始视频尾帧（复用 `_extract_last_frame`，`ffmpeg -sseof -1.0 -update 1`）作首段 `first_frame`；**没有** MotionContext latent（latent 只有 C 管线产出才有），所以接缝只有首帧锚定、没有运动连续。若 `job_id` 指向一条 c-chain 的 Job，则等价于 §2.4 的「追加」，带 latent 真续写。
- **aspect_ratio**【Batch6】：`pipeline_c_render` 今天**强制竖屏**（`w > h` 时对调宽高），产出固定 24 fps（`CreateVideo fps=24.0`，与项目 `fps` 无关）。Batch6 首版只接受 `"9:16"`（默认 768×1344）；`"16:9"`/`"1:1"` 需先评测 H3 横屏质量，未放开前返回 `PC_ASPECT_UNSUPPORTED`。
- **keep_audio**【Batch6】：现状是 H3 原生音频（T8 `audio_mode="native"`、`audio_denoise_strength=0.35`，续写段带 24 帧音频上下文），硬切裁头时音频按同一时刻同步裁。`keep_audio=false` 时：段片保留原生音频（供续写与复核），只在拼接成片时剥离音轨；Batch6 需在 assemble 中跳过 `assert_clips_have_audio`（现有该断言会让无音轨成片直接失败）。
- **worker_url**【现有，管理员】→ Batch6 改为 `worker_pool`（见 §5）；`worker_url` 仍兼容一个版本，校验从硬编码白名单改为「在已配置池内」。
- **candidates**：串行出（`orchestrator` 注释：不并行，避免打爆 H3 单实例队列），每段耗时 ≈ 候选数 ×（排队 + 采样 + 门禁换 seed 最多 3 次提交）。

### 1.3 响应【Batch6】

`202 Accepted`

```json
{ "job_id": "j_…", "chain_id": "<StudioProject.id>", "status": "queued",
  "segments": [ { "index": 0, "segment_id": "<StudioShot.id>", "status": "pending" } ] }
```

### 1.4 `POST /api/studio/c-chains/{chain_id}/segments`（追加）【Batch6】

```jsonc
{
  "segments": [ { "prompt": "...", "duration_sec": 8 } ],   // 同 §1.2 segments
  "num_candidates": 2, "keep_audio": true, "auto_assemble": true,
  "from_segment": null      // 可选：从第 k 段之后续写（丢弃 k 之后旧段，需 confirm_discard=true）；默认链尾
}
```

前置条件：链上没有 `queued/held/running` 的 Job（否则 `PC_CHAIN_BUSY` 409）；链尾段有入选候选且其 `context_latent` 所在 worker 仍可用（否则 `PC_CONTEXT_LATENT_MISSING`，见 §2.4）。

---

## 2. 段如何串联

### 2.1 链接三要素【现有】

| 要素 | 来源 | 写在哪 |
|---|---|---|
| **segment_id** | `StudioShot.id`（32 hex），段序 = `StudioShot.idx` | 链详情 `segments[].segment_id` |
| **context latent**（AV latent，MotionContext 续写） | `MotionContextSaveLatent` 产物，约定名 `toiv_drama_c/context/{shot_id[:8]}_{clip_index}_{seed%100000}_{clip_index:05d}.safetensors`，`clip_index = idx + 1` | 入选候选 `candidates[].context_latent`（例：`toiv_drama_c/context/cd023e9b_1_17313_00001.safetensors`）+ `candidates[].worker` |
| **first_frame**（仅 c_hybrid） | 上一段**入选候选**视频的最后一帧（`_picked_video_url` → `_extract_last_frame`），落盘 `chybrid_ff_{shot8}_{rand8}.png`；首段 = 全身定妆图 | 候选 `candidates[].first_frame` |

下一段渲染时（`orchestrator.render_shot`）：

1. `context_latent_path` = 显式传入 > 同项目 `idx` 紧邻的上一段中 `is_picked=true` 候选的 `context_latent`；
2. 图里加 `MiniMaxH3MotionContextLoadLatent(latent_path, clip_index = 本段clip_index − 1)` → `MiniMaxH3MotionContext(context_length=22 帧画面, audio_context_length=24 帧音频)` → 采样 → `MiniMaxH3MotionContextTrim`（去掉上下文帧）；
3. c_hybrid 另把尾帧作为 `first_frame` 上传，T8 `task_type="Hybrid"`，首帧占 `<Picture 1>`，原参考图 `@图片N` 整体 +1（`shift_picture_refs_for_first_frame`）。
4. 选优只看「是否入选」：**链永远沿入选候选延伸**，未入选候选的 latent/尾帧不参与。

注意（来自节点 `/object_info`，`custom_nodes.ComfyUI-H3-Motion-Context`）：
- `latent_path` 是**相对该 worker 的 ComfyUI output 目录**的路径 → latent 只存在于出它的那台 worker 上（**worker 亲和性**，§5 必须遵守）。
- LoadLatent 的 `clip_index=0` **永不读文件**。今天首段 `idx=0 → clip_index=1 → Load 0` 正好不读；Batch6 的「从外部视频起步再追加」若段序从 0 重新编号，会静默丢掉续写——Batch6 必须保证有 latent 的段 `clip_index ≥ 2`（按链内全局序号编号，不按单次提交编号）。

### 2.2 head_trim 对链接点的影响【现有】

- `apply_hard_cut_rule`：硬切落在**锚定区**（c_hybrid 首帧锚定 `ANCHORED_FIRST_FRAME_SKIP_FRAMES=12` 帧）或**首 1 秒**内 → 在切点裁掉片头（视频按帧、音频按同一时刻），写 `head_trim{frames, cut_frame, cut_t, in_anchor_zone, anchor_frames, file}`，`url` 换成 `*_ht{N}.mp4`，原片留在 `url_untrimmed`。
- **只裁片头、片尾不变**（裁后末帧与原片一致，平均差 ≤3 校验）→ 下一段的尾帧首帧与 latent 续写**都仍然有效**；链接点永远是「入选片的末帧 / 入选候选 SaveLatent 的那个 latent」。
- 影响的是**时长与时间轴**：该段实际时长 = `duration_sec − head_trim.frames/24`。BeefTV 计算成片时间轴必须用链详情里的 `actual_duration_sec`（Batch6 用 ffprobe 写入），不要用请求的 `duration_sec`。
- 裁后仍有 ≥2 处镜内硬切（`HARD_CUT_INELIGIBLE_MIN=2`）→ 出片阶段先换 seed（与文字门禁共用 `max_submits=3`），选优阶段 `cut_gate.blocked=true` 不得入选。

### 2.3 链的执行顺序【Batch6，语义沿用驱动脚本】

后台任务按 `idx` 逐段：`render_shot(pipeline, num_candidates, ref_overrides, outfit_desc, worker=链绑定worker)` → 选优 → 写入 → 下一段。任一段最终无入选（全部候选失败或门禁全拦）→ 该段 `status=blocked|error`，**其后各段不再提交**，Job `status=error`、`error_code=PC_CHAIN_ABORTED`、`failed_segment=k`（等价驱动脚本的 `chain_abort` 事件）。已完成的段保留，可在修改提示词后对第 k 段起「追加/重跑」。

Batch6 不搬驱动脚本的「从 Comfy history 按 prompt_id 回收」作为常规路径；只在 API 进程重启导致后台任务中断时，由启动时 reconcile 用 `candidates[].job_id`（= Comfy `prompt_id`）回收已出片的候选。

### 2.4 追加 / 延长已完成的链

1. 读取链尾段入选候选的 `context_latent` + `worker` + 视频 URL；
2. 新段 `idx` 接在链尾之后（`clip_index` 全链递增），首帧 = 链尾入选片末帧（c_hybrid）；
3. **必须提交到 `worker` 同一实例**（或已确认共享 output 目录的实例，见开放问题 1）；该 worker 不在池内/不健康 → 直接 `PC_CONTEXT_LATENT_MISSING`（409），提示「重跑链尾段」或「接受无 latent 降级续写（仅首帧锚定）」——后者需请求显式 `allow_no_latent=true`【Batch6】；
4. 新建 Job：`continued_from=上一 Job.id`，`root_id=链首 Job.id`；
5. `auto_assemble=true` 时重新拼整条链（全部段），生成新的 `final_url`（旧成片保留，不覆盖文件）。

latent 文件在 worker 盘上无清理策略（开放问题 4）——追加窗口取决于 worker 磁盘保留期。

---

## 3. 进度与结果（一律经 job_id）

### 3.1 Job 状态【现有】

`models.Job.status`：`queued` → (`held`) → `running` → `done` | `error` | `canceled`。

- `held`：资源预算排队（`hold_reason` 说明原因），前端按排队态展示；
- `canceled`：`POST /jobs/{id}/cancel` 落库；
- 终态：`done/error/canceled`，不再变化。

c-chain Job 建档方式沿用剧本拆解先例（`parse_script_endpoint`）：`worker=""`、`prompt_id="chain-{job.id}"` 占位（`cancel_job` 对 `chain-` 前缀跳过 worker 清场，tracker 按空 worker 跳过 reconcile），`params=params_snapshot(body)`，后台 `asyncio.create_task` 执行。

### 3.2 `GET /api/jobs/lookup?job_id=…`

【现有】返回 `_job_dict`：`id, prompt_id, kind, status, results[], error, continued_from, root_id, created_at, …`；`done` 时视频带 `duration`。
【Batch6 增量键】`kind="studio_c_chain"` 时：

- `results` = `[final_url]`（成片；未拼接时为空），保持「结果是 URL 列表」的旧语义；
- 新增 `chain`（纯增量键，旧前端忽略）：

```jsonc
"chain": {
  "chain_id": "…", "pipeline": "c_hybrid", "worker": "http://100.68.100.90:8264",
  "progress": { "segments_total": 4, "segments_done": 2, "current_segment": 2,
                "current_candidate": 1, "queue_pos": 0, "eta_sec": 540 },
  "error_code": null, "failed_segment": null,
  "final_url": "/api/studio/files/final-<uuid>.mp4",
  "segments": [ /* 同 §3.3，lookup 中只给精简字段：index, segment_id, status, clip_url, actual_duration_sec, error_code */ ]
}
```

`progress` 写入 `Job.progress` JSON（【现有】列，`/jobs/active` 已消费 `{pct, step, total, queue_pos}`），Batch6 追加 `segments_*` 字段。建议轮询间隔 5 s。

### 3.3 `GET /api/studio/c-chains/{chain_id}`【Batch6】完整结构

```jsonc
{
  "chain_id": "…", "jobs": ["j_1", "j_2"], "active_job_id": null,
  "final_url": "/api/studio/files/final-….mp4", "final_duration_sec": 27.4, "keep_audio": true,
  "segments": [
    {
      "index": 0, "segment_id": "<StudioShot.id>", "job_id": "j_1",
      "status": "done",                // pending | rendering | picking | done | blocked | error | canceled
      "shot_status": "rendered",       // 【现有】StudioShot.status 原值
      "prompt": "…", "duration_sec": 6, "actual_duration_sec": 5.58,
      "clip_url": "/api/studio/files/….mp4",           // 入选片（裁头后）= StudioShot.video_url
      "first_frame_url": "/api/studio/files/chybrid_ff_….png",
      "context_latent": "toiv_drama_c/context/cd023e9b_1_17313_00001.safetensors",
      "worker": "http://100.68.100.90:8264",
      "error": "", "error_code": null,
      "candidates": [                  // 【现有】StudioShot.candidates_json 原样透出（下列字段均已存在）
        {
          "id": "…", "seed": 17313, "status": "done", "is_picked": true, "url": "…", "url_untrimmed": "…",
          "job_id": "<comfy prompt_id>", "worker": "…", "pipeline": "c_hybrid",
          "context_latent": "…", "first_frame": "…", "prompt": "…(≤500)",
          "pick_score": 0.71, "pick_note": "…", "gate_status": "",
          "face_mean": 0.62, "face_rank": 0.60, "facecrop_mean": 0.6, "face_score_backend": "insightface|clip",
          "relative_pass": true, "relative_delta": 0.05, "neg_max": 0.55,
          "continuity": 0.8, "regression": 0.1, "burnin_penalty": 0, "ocr_penalty": 0,
          "text_gate": { "hit": false, "kind": "", "text": "", "frames_checked": 24, "error": "" },
          "cut_gate": { "blocked": false, "late_cuts": 0, "min": 2 },
          "hard_cuts": [9], "head_trim": { "frames": 10, "cut_frame": 10, "in_anchor_zone": true },
          "hard_cut_penalty": 0, "hard_cut_reseed_hits": [],
          "scene_gate": "pass",
          "outfit_check": { "action": "", "target": "", "mismatches": [] },  // 仅告警
          "hood_log": { },                                                   // 仅记录，reliable=false
          "ref_overrides": { }
        }
      ]
    }
  ]
}
```

`gate_status="未通过-需复核"`（【现有】`GATE_NEEDS_REVIEW`）表示该候选被门禁拦下。BeefTV 展示规则建议：分数/门禁只给运营看；用户侧只看 `status` 与 `clip_url`。

### 3.4 取消 `POST /api/jobs/{job_id}/cancel`

【现有】行为：本人可取消；终态 409；DB 先落 `canceled`；按 `params.segment_prompt_ids` 传播取消并对 worker 发 cancel/interrupt；`chain-*` 占位 prompt_id 跳过 worker 清场。

【Batch6 适配】（C 渲染不为每个候选建 Job，所以现有传播查不到成员）：
1. 后台任务在每次 `queue_prompt` 前、每次轮询间隙检查 Job 是否已 `canceled`；是则对**当前在跑的 Comfy prompt_id** 调 `client.cancel_prompt()`（与 `_wait_video_url` 客户端断开时的处理相同）并退出；
2. 当前段 `StudioShot` 恢复到渲染前状态（复用 `render_shot` 的 `preserve_selected` 逻辑），未开始的段保持 `pending`；
3. 已完成段与成片保留，可后续追加；
4. 返回体沿用现有 `{ok, id, status:"canceled", worker_action, canceled_segments}`。

---

## 4. 错误码表

约定【Batch6】：同步接口错误 `{"detail": "<中文原因>", "code": "PC_…", "retryable": bool}`（`detail` 保持现有中文字符串，旧前端不受影响）；异步失败写入 Job：`status=error`、`error=<中文>`、`chain.error_code`、`chain.failed_segment`。HTTP 列对异步错误表示「若同步返回时的状态码」。
今天的映射【现有】：`RenderError → 502`、`ValueError → 422`、非管理员传 worker_url → 403，**所有失败都只有中文 detail 无 code**，Batch6 通过 `RenderError` 子类携带 code 实现。

| code | HTTP | 可重试 | 含义 / 今天的触发点（代码原文） |
|---|---|---|---|
| `PC_BAD_REQUEST` | 422 | 否 | 参数非法：`pipeline_invalid`、非法 `ref_style`、段数/时长越界 |
| `PC_ASPECT_UNSUPPORTED` | 422 | 否 | Batch6 首版只支持 9:16（现有代码强制竖屏） |
| `PC_WORKER_FORBIDDEN` | 403 | 否 | 非管理员指定 worker：「worker_url 仅管理员可用」 |
| `PC_WORKER_NOT_WHITELISTED` | 422 | 否 | 「worker_url 不在白名单:…」（Batch6：不在池配置内） |
| `PC_START_NOT_FOUND` | 404 | 否 | start.job_id / video 不存在或非本人（同 lookup 的 404 不泄露存在性） |
| `PC_START_NOT_VIDEO` | 422 | 否 | 起点 Job 未完成或无视频产物 |
| `PC_MAKEUP_MISSING` | 422 | 否（先定妆） | 「c_hybrid 首镜需要角色全身定妆图（参考图含 full/全身）」 |
| `PC_REFS_MISSING` | 422 | 否（先定妆） | 「管线 C 需要角色三视图或场景参考图」 |
| `PC_PREV_SEGMENT_MISSING` | 409 | 否 | 「c_hybrid 需要上一镜(idx=…)入选视频」「上一镜视频不在本地」 |
| `PC_TAIL_FRAME_FAILED` | 500 | 是 | 「c_hybrid 抽上一镜尾帧失败:…」 |
| `PC_REF_UPLOAD_FAILED` | 502 | 是 | 「参考图上传失败」「首帧上传失败」「无法拉取参考图」 |
| `PC_H3_DISABLED` | 503 | 否 | 「H3 视频生成引擎已禁用(TOIV_H3_ENABLED=false)」 |
| `PC_WORKER_UNAVAILABLE` | 503 | 是 | 「H3 实例不可达(…)」；池内无健康 worker |
| `PC_WORKER_NODE_MISSING` | 503 | 否 | 「H3 实例 … 缺少 MiniMaxH3AudioConditioningT8 / MiniMaxH3MotionContext 节点」 |
| `PC_VRAM_INSUFFICIENT` | 503 | 是（错峰） | `ensure_h3_vram` 驱逐后仍不足 / 宿主机 RAM 预检失败 |
| `PC_MODEL_MISSING` | 503 | 否（运维） | Comfy 校验/执行报模型文件不在列表（如在 :8264 跑 Qwen 步）；由 `execution_error`/提交校验信息识别 |
| `PC_SUBMIT_FAILED` | 502 | 是 | 「管线 C 提交失败:…」（`queue_prompt` ComfyUIError，非模型缺失类） |
| `PC_COMFY_EXECUTION_ERROR` | 502 | 是（1 次） | 「Comfy 任务失败无视频产物:<exception_message>」（OOM、节点异常） |
| `PC_COMFY_INTERRUPTED` | 502 | 是 | Comfy 任务被 interrupt（非本链取消，如他人 /interrupt、worker 重启）；history `status_str=error` 且无 `execution_error` |
| `PC_CONTEXT_LATENT_MISSING` | 409 | 否（需重跑上一段或 allow_no_latent） | LoadLatent FileNotFound（latent 不在该 worker、已被清理、clip_index 错） |
| `PC_TIMEOUT` | 504 | 是 | 「视频生成超时(1800s)」（`_POLL_TIMEOUT`，含排队） |
| `PC_EMPTY_OUTPUT` | 502 | 是 | 「视频产物下载为空」 |
| `PC_ALL_CANDIDATES_FAILED` | 502 | 是 | 「全部候选生成失败」（每个候选都 RenderError） |
| `PC_GATE_TEXT_BLOCKED` | 422 | 改提示词后 | 「选优失败:全部候选未过文字门禁(衣物品牌字/字幕)」（字幕/logo OCR，3 次换 seed 后仍命中） |
| `PC_GATE_HARD_CUT_BLOCKED` | 422 | 改提示词后 | 「全部候选未过门禁 … 镜内硬切≥2」 |
| `PC_GATE_FACE_BLOCKED` | 422 | 加候选后 | 「无人脸达标(需 face_mean≥0.45/0.60…)」「无人脸相对门禁达标(需 self≥neg_max+0.03)」 |
| `PC_GATE_SCENE_BLOCKED` | 422 | 改提示词后 | 「无人脸+场景双门禁同时达标」 |
| `PC_SCORER_UNAVAILABLE` | 503 | 是（运维） | 「人脸评分不可用且无连贯材料」/ `face_scorer_error:*`（禁止静默回落首候选） |
| `PC_CHAIN_ABORTED` | 409 | 修复第 k 段后追加 | 第 `failed_segment` 段无入选，后续段未提交（= 驱动脚本 `chain_abort`）；`cause_code` 给出根因码 |
| `PC_CHAIN_BUSY` | 409 | 稍后 | 链上已有 queued/held/running 的 Job，不能追加/改选 |
| `PC_JOB_TERMINAL` | 409 | 否 | 「作业已终态(…),无需取消」 |
| `PC_CANCELED` | —（Job 状态） | 否 | 用户取消（Job `status=canceled`，`error="已被用户取消"`） |
| `PC_QUEUE_FULL` | 429 | 是（`Retry-After`） | 超出用户/全局并发上限（§5.4） |
| `PC_AUDIO_MISSING` | 422 | 否 | `keep_audio=true` 但段片无音轨（「分镜成片缺音轨」） |
| `PC_ASSEMBLE_FAILED` | 502 | 是 | 拼接失败：时长与源片误差 ≥0.5s、concat ffmpeg 失败 |
| `PC_INTERNAL` | 500 | 是 | 未分类异常（带 trace id 写日志） |

说明：`outfit_check` / `hood_log` 只告警，不产生错误码；`brand/sign` 店招类 OCR 只记录不拦。

---

## 5. 生产端口方案

### 5.1 已知事实（2026-10-05 核实）

| 端口（100.68.100.90） | 角色 | 管线 C 节点 | Qwen | 备注 |
|---|---|---|---|---|
| :8195 | h3-eval 评测 worker | 有 T8 + MotionContext（`/object_info` 200） | 有模型（设定卡表情编辑在 :8262/:8195 跑） | 驱动脚本、实验链默认 pin 这里 |
| :8264 | 生产 H3 池 | 有 T8 + MotionContext（`/object_info` 200） | **无 Qwen 模型**（节点类存在，权重缺）→ 不能定妆、不能 Qwen-Edit 参考修复 | core `.env` `TOIV_H3_BASE_URLS` 当前只有它；与其他 H3 作业共享，出现过 65 s/it（对比 12.8 s/it）、排队 90 分钟 |
| :8262 | 设定卡/超分/Qwen | **无** H3 节点 | 有 | 设定卡优先；其他作业每批 ≤8，排空 + 15 s 间隔（`fix/chybrid-ref-vlm-gate` 规则） |
| :8196 :8205 :8261 :8263、cuda:3 | — | — | — | **永久禁用**（代码已有 `_FORBIDDEN_WORKER_PORTS`/`_FORBIDDEN_WARMUP_PORTS` 先例） |

代码层面今天并非「只限 :8195」：未 pin 的 Studio C 渲染走 `pick_h3_client()` → `.env` 里的 :8264；只有管理员 `worker_url` 与驱动脚本 pin :8195。问题是**没有 worker 亲和**（续写 latent 只在出它的 worker 上）、**没有并发上限**、白名单硬编码。

### 5.2 结论

**正式上线：管线 C 渲染以 :8264 为主池，:8195 作为溢出/回退与灰度，二者都纳入可配置的「C 池」；定妆与所有 Qwen 步骤固定在 :8262（:8195 兜底），绝不进 :8264。** 理由：:8264 是生产 H3 池且已装齐 C 节点；:8195 是评测机，不能作为唯一生产承载，但空闲时是最好的溢出口；排队争用靠「队列感知路由 + 每 worker 并发上限 + 链级亲和」解决，而不是把正式流量钉死在评测机。

### 5.3 池配置（替代硬编码 URL）【Batch6】

```bash
# deploy/.env（core）
TOIV_PIPELINE_C_POOL='[
  {"name":"h3_prod","url":"http://100.68.100.90:8264","role":"primary","max_running":1,"max_pending":1,"caps":["h3_t8","motion_context"]},
  {"name":"h3_eval","url":"http://100.68.100.90:8195","role":"overflow","max_running":1,"max_pending":0,"caps":["h3_t8","motion_context","qwen_edit"]}
]'
TOIV_QWEN_EDIT_POOL='[{"name":"sheet","url":"http://100.68.100.90:8262","priority":"character_sheet","batch_max":8},
                      {"name":"h3_eval","url":"http://100.68.100.90:8195","role":"fallback"}]'
TOIV_WORKER_FORBIDDEN_PORTS=8196,8205,8261,8263
```

- 启动校验：URL 端口命中禁用表 → 拒绝启动并报错；每个 C 池成员启动与每 5 分钟探 `/object_info/MiniMaxH3AudioConditioningT8`、`/object_info/MiniMaxH3MotionContextLoadLatent`，缺节点自动摘除。
- `H3_WORKER_OVERRIDE_WHITELIST` 改为从池配置派生；管理员 `worker_pool` / `worker_url` 只能在池内选。
- 不动现有 `TOIV_H3_BASE_URLS`（其它 H3 功能继续用）；C 链只读 `TOIV_PIPELINE_C_POOL`。

### 5.4 并发与路由【Batch6】

1. **每 worker**：ToIV C 链 `max_running=1`（一次只有一个 C prompt 在跑），`max_pending` ≤1；候选串行（现有行为）。
2. **全局**：同时在跑的 C 链 ≤ 池内健康 worker 数（目前 2）；**每用户** 1 条在跑链；超出 → Job `held`（复用 `hold_queue`，`hold_reason="C 池繁忙，排队第 N"`），等待 >30 min 返回/标 `PC_QUEUE_FULL`。
3. **队列感知路由（只在链开始时选 worker）**：对每个候选 worker 取 `/queue`（`queue_counts()` 现有）→ 估算 `eta = (running + pending) × 该 worker 近 N 次 C 段均耗`（ToIV 本地记录 s/it，识别 65 s/it 级降速）。选 eta 最小者；主池 eta > 15 min 且 :8195 空闲 → 走 :8195；都忙 → held。
4. **链级亲和（硬约束）**：链一旦绑定 worker，后续段与追加都发同一 worker（latent 在其 output 目录）。绑定 worker 失效：
   - 未出第一段前 → 换 worker 重新开始；
   - 链中途 → 默认 `PC_CONTEXT_LATENT_MISSING`；若确认 :8195/:8264 共享 output 目录（开放问题 1）则允许迁移；
   - 可选降级：`allow_no_latent=true` 时在新 worker 仅用尾帧首帧续写（接缝质量下降，链详情标 `latent_continuity=false`）。
5. **重试**：可重试错误（表 §4）同段自动重试 1 次，超时/中断类重试前重新做健康检查；门禁类不自动重试（避免烧卡），直接 `PC_CHAIN_ABORTED`。
6. **不打扰他人**：C 链不调用 :8264 的 `/free` 驱逐（沿用 `ensure_h3_vram` 队列非空直接放行的规则），不对他人 prompt 发 interrupt；取消只 cancel 本链 prompt_id。

### 5.5 定妆与 Qwen 步骤放在哪

| 步骤 | worker | 说明 |
|---|---|---|
| 角色设定卡 / 定妆（`/studio/characters/{cid}/character-sheet*`） | :8262（优先），:8264 **仅限不含 Qwen 的出图步** | 代码 `_SHEET_ALLOWED_PORTS={8262,8264}`；Batch6 把含 Qwen-Edit 的子步（表情编辑、panel-replace、ref 修复）限定为 `TOIV_QWEN_EDIT_POOL`，排除 :8264 |
| Qwen-Edit 参考修复（帽兜放下版等 → `ref_overrides`） | :8262 → :8195 回退 | 遵守 :8262 每批 ≤8、排空 + 15 s 间隔 |
| 管线 C 渲染 | C 池（:8264 主、:8195 溢出） | §5.3/5.4 |
| 门禁/选优（OCR、InsightFace/CLIP、硬切检测）、尾帧抽取、裁头、拼接 | core 本机（API 进程线程池） | 现有：`asyncio.to_thread` 防阻塞事件循环 |

BeefTV 侧流程因此是：先在 Studio 完成定妆（或传已定妆角色）→ 再调 `c-chains`；`c-chains` 本身不触发定妆。

### 5.6 上线步骤

1. Batch6 代码合入后，先 `TOIV_PIPELINE_C_POOL` 只配 :8195（灰度，等价今天驱动脚本）；
2. 跑雨夜样片 4 段对比 :8195 vs :8264（同 seed，`seed` 字段现有），确认 :8264 产物与门禁通过率一致；
3. 加入 :8264 为 primary，:8195 改 overflow；观察 3 天 s/it 与排队 eta；
4. BeefTV 接入。

---

## 6. 开放问题

1. :8195 与 :8264 是否共享同一 ComfyUI output 目录？决定链中途能否跨 worker 迁移、追加是否必须回原 worker。
2. BeefTV 是否需要横屏（16:9）？现有代码强制竖屏且产出 24 fps，横屏需单独评测 H3 质量。
3. BeefTV 的鉴权方式：用哪个租户/账号调用？`/api/studio/files/{name}` 需登录态（且不校验属主），成片是否需要签名 URL 或转存到 BeefTV 自己的存储？
4. worker 上的 context latent / Comfy 产物保留多久？决定「追加」的可用窗口；是否需要 ToIV 把 latent 复制回 NAS。
5. `keep_audio=false` 时，段片也剥音还是只在成片剥？是否需要接配音/对口型（现有 voice/lipsync 步骤）进入这条链？
6. 门禁全拦时的策略：自动加候选重跑（多耗 GPU）还是立即中止交人工？默认本契约选「中止 + PC_CHAIN_ABORTED」。
7. :8195 作为评测机，是否允许正式流量溢出？谁有权在评测期间把它摘出 C 池？
8. `fix/chybrid-ref-vlm-gate`（1c4ce371，参考图 VLM 验收门禁）尚未进 fb10f4be，Batch6 是否一并纳入（会新增一类门禁错误码）？
9. c_hybrid 接缝：下一段前 12 帧锚定上一段尾帧，拼接时是否要去重/裁掉锚定帧，避免成片出现短暂定格？
10. 从外部视频起步（start.type=video）只有首帧锚定、没有 latent，接缝质量是否可接受？是否限制为只允许 ToIV 自产视频。
