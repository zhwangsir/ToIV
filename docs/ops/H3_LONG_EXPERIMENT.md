# H3 长视频 A/B/C/D 对比实验

方向：用 MiniMax H3 做连续长视频（AI 短剧核心能力）。用户 2026-09-30 23:53 批准。

## 状态

- 当前阶段：`d. A-seg1 生成中` — 方法 A 第一段（中文）已提交 :8205
- 已完成：
  - `a. 准备` — 两插件已装入 `ComfyUI-h3-eval`（:8195），节点已注册，H3 latent smoke PASS
  - `b. 固定素材` — 文案 + 四张图（768×1344）见 `tmp/h3_long_exp/assets/`
  - `c. 开跑 A` — 2026-10-01 02:45 CST 提交 A-zh-seg1
- 素材路径：
  - `linxia_front.png` / `linxia_side.png` / `linxia_full.png` / `scene_rain_store.png`
  - 证据：`ASSET_GEN_LOG.md`、`gen_meta.json`（Comfy :8197，未打断 :8196）
- 在跑：A-zh-seg1 → Comfy `:8205`（cuda:2）prompt_id `184e0c8d-fc9e-4c9d-bbec-ee6d64850712`；首帧 `linxia_full.png`；FL2VA pruned int8；768×1344×362@24fps；前缀 `h3exp_A_zh_seg1`
- 下一步：等 A-seg1 成片 → 抽末帧续 A-seg2 → 记指标 → 再 B/C/D × 中/英

## 实验设计

| 做法 | 说明 |
|------|------|
| A | 现有 h3 extend（只接最后一帧 i2v） |
| B | Motion Context：上一段结尾 22 帧画面 + 24 帧（1s）声音，Trim + match_tail |
| C | B + 每段 Ref2VA（主角定妆图 + 场景图）；带声音续写必须 Ref2VA |
| D | 关键帧优先：5 张关键帧 → H3 首尾帧并行 → 拼接 |

每种做法各跑两种提示词：ToIV 中文「生成一段…」；H3 官方英文三段式。

测量：人脸相似度、接缝 SSIM/光流、音量 RMS 跳变、静音秒数（<-30dB）、总耗时。成片与表：`tmp/h3_long_exp/`。

## 运行日志

### 2026-10-01 00:53 CST — 推进+监督

- **健康检查**：API `:8090/api/health` ok；Web `:3100/:3200` 200；Comfy `:8195/:8196/:8197` 200（TS `100.68.100.90` / core `100.77.80.100`）
- **做了什么**：
  1. 备份 `custom_nodes` 列表 → `~/toiv_backups/h3_eval_custom_nodes_*.txt`
  2. 安装 `ComfyUI-H3-Motion-Context`（NikoDemon80 @5335715）与 `ComfyUI-MiniMaxH3-Contex-Loop`（ethanfel Context-Loop @5d62cbc，目录名按计划保留 Contex-Loop）
  3. 空闲队列下重启 :8195；日志：`h3_motion_context: nodes registered`；Contex-Loop 0.2s 加载
  4. `object_info`：Motion Context 6 节点 + Chain 系节点在册；`RHMiniMaxH3*` / `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` / `MiniMaxH3AddGuide` 仍在
  5. Smoke：`EmptyMiniMaxH3LatentAV` → `MiniMaxH3MotionContextSaveLatent` → **success**（prompt_id `10d77c76-206c-499b-9e63-b3711ed1a74f`）
  6. 固定戏文案与双语文案写入 `tmp/h3_long_exp/assets/`（scene_brief / prompts_zh / prompts_en_h3 / methods）
- **证据**：插件目录在 workstation `~/ComfyUI-h3-eval/custom_nodes/`；进度与素材在 core 上述路径
- **下一步**：生成定妆图（正/侧/全身）+ 场景图，然后按 A→B→C→D × 中/英提示词开跑并测指标

### 2026-10-01 02:28 CST — 推进+监督

- **健康检查**：API `:8090/api/health` ok；Comfy `:8195` 有任务、`:8196` 未打断、`:8197` 用于生图
- **做了什么**：
  1. 在 `:8197` 用 RealVisXL Lightning 生成林夏定妆正/侧/全身 + 雨夜便利店场景（768×1344）
  2. 正面曾出黄衣，已用强化「全黑冲锋衣」提示重出；侧面用 90° profile 提示重出
  3. 文件落入 `tmp/h3_long_exp/assets/`；证据 `ASSET_GEN_LOG.md` / `gen_meta.json`
  4. 同步新建 `docs/ops/DRAMA_UI_PLAN.md`（短剧 UI 主线方案）
- **状态**：`b. 固定素材` → **可开跑 A**
- **下一步**：启动方法 A 第一段（中文提示）；Batch1 导航「做短剧」+ 项目工作流骨架

### 2026-10-01 02:45 CST — 短剧 10 分钟汇报

- **健康检查**：core API `:8090` ok（worker `:8196`）；Web `:3100/:3200` 200；Comfy `:8195` 跑 jyy_s60v2 第4段、`:8196` 空闲未打断、`:8197` 空闲、`:8205` 接 H3 实验
- **做了什么**：
  1. 确认 Batch1「做短剧/工具箱」已在 core web 源码与运行中的 toiv-web（02:31 重启）
  2. 将定妆/场景图拷到 `:8205` input；提交方法 **A 第一段中文**（未碰 `:8196`、未用 cuda:3）
  3. prompt_id `184e0c8d-fc9e-4c9d-bbec-ee6d64850712`；输出目录 `/home/merlin/h3exp_gpu2/output/` 前缀 `h3exp_A_zh_seg1`
- **旁路**：`:8195` 仍在跑杨锋 jyy_s60v2（约每 20 分钟一段；当前段 prompt 混入元指令文本，成片后需目检）
- **下一步**：A-seg1 出片后抽末帧跑 A-seg2；同步 Batch2 短剧项目工作流骨架
