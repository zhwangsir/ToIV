# 管线状态重算 + 合法 ID 校验 · 实现文档（2026-08-15）

> 依据：DramaClaw 调研（docs/2026-08-15-dramaclaw-deep-dive.md 第二节 #1/#2）
> 落点说明：用户任务书写的 workflows.py / drama_analytics.py 经审计为误指——前者是 ComfyUI 模板管理、后者是埋点聚合，均与分镜管线无关。实际落点：新建 `services/drama_pipeline.py` + `routes/drama_pipeline.py`（状态重算），`routes/drama_studio.py` + `services/studio/storyboard.py|schemas.py`（ID 校验）。
> 同批交付：T1 SKILL 纪律标准化见 docs/2026-08-15-agent-skill-discipline.md。

---

## 一、管线状态重算（T2/T3a）

### 改造前

| 问题 | 实证 |
|---|---|
| 状态漂移 | DramaShot 四条独立状态列各自手写；DramaProject.status 可被 PATCH 任意改写（无枚举校验） |
| 分裂态 | `wait_for_jobs(900s)` 超时即标 shot error，但 tracker 窗口 7200s——900~7200s 完成的作业 Job=done / shot=error 且 video_url 永不回写 |
| 无 next_step | 前端只能拉全量项目（GET /drama/projects/{pid}）自行推断，无任何「下一步该做什么」指引；全仓 grep next_step 零命中 |

### 改造后

**`GET /drama/projects/{pid}/pipeline/status`**（routes/drama_pipeline.py，鉴权+归属同既有模式，404 不泄露存在性）：

```json
{
  "stages": { "storyboard|video|voice|lipsync|assemble": {"status": "pending|partial|done|error", "detail": {...}} },
  "next_step": {"step": "video", "label": "生成分镜视频", "action": "/drama/shots/{sid}/video", "shot_ids": ["..."]},
  "recoverable": [{"shot_id": "...", "job_id": "...", "url": "...", "chain": "..."}],
  "generated_at": "...", "elapsed_ms": 2.61
}
```

核心语义（services/drama_pipeline.py，472 行，全程只读零写入）：

1. **状态即真相在产物**：七阶段（ingest/characters/storyboard/video/voice/lipsync/assemble）由 DB 行 + 产物存在性实时重算，不新增任何状态列。
2. **产物三级判定** `ok/missing/unknown`：本地 URL（/api/drama/output|voice、/api/studio/files）→ `drama_output_root()` + `is_file()`（2s TTL stat 缓存，防 NAS 抖动刷屏）；`/api/images?...` 代理 URL → 查 Job 行（tenant+user 归属 + status=done + result 含 filename）；判不了的一律 unknown 不武断标 missing（历史/异机产物不卡死 next_step）。
3. **领域规则内置**：配音/对口型仅适用有台词分镜（无台词计 skipped）；状态列 done 即计入完成、产物缺失只在 detail.missing_shot_ids 点名不阻塞；assemble 的 URL 在但文件丢失才标 error（漂移标红）。
4. **分裂态可恢复检测** `recoverable[]`：shot error + 匹配 Job（kind + seed + prompt，对齐 reconcile_interrupted 策略）done + 产物复检可取回 → 标记可恢复，前端/运维可一键修复。
5. **分裂源头修复**（drama_studio.py）：`_await_shot_video_writeback` 超时后重读 Job 最新状态再定性——非终态保持 generating（交 tracker 7200s 窗口 + reconcile 兜底），已 error 才标 error，竞态 done 正常回写；7 处硬编码 900/600 统一为 `_job_wait_timeout()` 派生（min(cap, job_track_timeout)）。

**Studio 侧**：`GET /studio/projects/{pid}/status` 追加 `next_step`（draft→render→voice→lipsync→assemble→done 纯函数，error 分镜排首位），原契约字段零改动。

### 性能影响

- 实测：24 分镜全链 done（含 48 次本地 stat）重算 **2.61ms**；stat 缓存 2s TTL；/api/images 判定为单条 Job 查询（tenant+user 索引）。
- 每次重算 logger.info 输出阶段摘要 + recoverable 数 + 耗时，生产可观测。
- 风险：stat 缓存模块级——同进程内先建文件再调 compute 需清 `_stat_cache`（测试 fixture 已处理）。

---

## 二、合法 ID 校验（T3b）

### 改造前

三条剧本拆解 LLM 链全部「prompt 恳求 + 文本 JSON 提取 + 手工 dict 规整」，零校验框架；LLM 输出角色名的大小写/空白变体（" mary " vs "Mary"）会直接造出重复角色行。

### 改造后（pydantic v2 原生 validation_context，无新依赖）

**链 A**（drama_studio.py）：`ShotOut`/`ShotAnalysisOut` 模型 + `_request_storyboard_analysis()`：
- `model_validate(…, context={"valid_character_names": 项目角色名集合, "new_characters": []})`
- 校验策略（与「新角色自动建行」既有特性兼容，**刻意不照搬 DramaClaw 的打回重试**）：
  1. 精确命中 → 通过
  2. 大小写/空白近匹配 → 自动纠正为库内名 + logger.info（消灭同名双角色）
  3. 全新名 → 放行 + 记入 new_characters（走既有自动建行）+ logger.info
  4. 结构非法（非 JSON/shots 类型错）→ 校验错误摘要（loc:msg 前 5 条）反馈进 prompt **重试一次** → 仍败 502 带明确原因
- `_coerce_shot` 手工规整迁为 before-validator + `ge=2, le=15` 硬约束，grid/from-image 两处共用调用点零改动

**链 B**（storyboard.py + schemas.py）：`parse_script(..., known_characters=None)` 可选参数；`CharacterDraft`/`ShotDraft` before-validator 走同一 `reconcile_character_names()` helper（两链策略单一事实源）；context 无 valid 键 = 校验未启用原样放行（兼容 grid/from-image 旧路径）。路由 routes/studio.py:266-281 已接线（查 StudioCharacter 名集合传入）。

### 决策记录

- 只有结构级错误触发重试；字段级类型错被 before-validator 吸收为安全默认（与旧容忍度等价），不产生无谓重试
- 截断先于校验（`shots[:num_shots]`），多余镜头坏数据不阻断
- 502 detail 文案从「分镜生成失败，请重试」→「…（原因）」，无测试依赖旧文案

---

## 三、回归与验证

| 项 | 结果 |
|---|---|
| 新增测试 | test_drama_pipeline.py 12 例 + test_storyboard_valid_ids.py 11 例，全绿 |
| 全量 pytest | **1561 passed**（test_redis_integration 2 失败为预存，git stash 双次验证与本批无关） |
| 契约兼容 | 只增不改；唯一改动既有测试是 test_studio_projects.py 的精确相等断言（追加 next_step 断言） |
| 既有拆解回归 | drama_studio/studio_storyboard/storyboard_resolve 等 163+56 例全绿 |

## 四、遗留事项

1. `_writeback_candidate`（多候选回写）有同类超时分裂隐患，本批只修 `_await_shot_video_writeback`，后续同法推广
2. Studio error 归因：当前仅 render 置 error；若 voice/lipsync 未来置 error，需加 error_stage 列才能精确归因
3. next_step 的 lipsync 是否 gate 成片为产品决策，可在 `_next_step` order 中移除
