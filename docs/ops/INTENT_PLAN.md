# ToIV 意图优先推进计划（INTENT_PLAN）

用户锁定（2026-09-30）：24h 持续实质推进 + 监督；每次运行必须交付至少一项真实改进。

## 总目标
把「应用市场」收成「你想做什么」：常用 20 件事一点就出片/出图，参数少、名字短、效果最好。

## 任务清单
- [x] **a. 评分表**：常用 20 事 — 20/20 有 live 中位耗时；15+ 项有效果分（视频暂定 3）；证据 `tmp/intent_scorecard_20260930.json`
  - 证据：`tmp/intent_scorecard_20260930.json` + `.md`；起步脚本 `tmp/intent_audit2.py` / `tmp/intent_scorecard_build2.py`
  - 子项：耗时补齐（`tmp/intent_live_smoke_20260930.json`）、效果分抽产物
- [x] **b. 每事 1–2 张最佳卡**：短名含内置；wave3–5 软隐藏；图生/文生视频引擎差昇收成模式（`tmp/intent_modes_wave5_20260930.json`）；公开 PASS ~184→86
- [~] **c. 补齐空缺**：缺口核查见 `tmp/intent_plan_c_gaps_20260930.json`；配音无隐藏 TTS（需新工作流/模型）；抠图/线稿够用；补帧/3D 已挂模式，真 3D/纯补帧仍缺
- [~] **d. 首页按意图进入**：门户空态已上意图芯片+输入+最近作品（edc85ca）；一图上传/高级参数折叠与全站少字清扫仍待续
- [x] **e. 速度分档**（快速/精细）+ 排队/失败原因可见
- [x] **f. 改完重跑评分表，出前后对比** — 证据 `tmp/intent_scorecard_20261003.{json,md}` + `tmp/intent_scorecard_compare_20260930_vs_20261003.md`（公开 86→85；本窗 live：抠图/局部重绘/音乐）

### 旧待办（a–f 之后）
- [ ] 13 张黑封面
- [ ] 1142 张 RH 外链封面本地化
- [ ] 暂藏卡产品侧修复
- [ ] R18 质量
- [ ] API 两个旧测试失败

## 运行记录

### 2026-09-30 10:24–10:50（Asia/Shanghai）推进+监督
- **健康**：公开 184 全部 smoke=pass；API `:8090/api/health` ok；Web `:3100/:3200` 200；Comfy `:8195/:8196/:8197` 200（TS `100.68.100.90`）
- **实质产出**：
  1. 新建 `docs/ops/INTENT_PLAN.md`；评分表 `tmp/intent_scorecard_20260930.{json,md}`（起步 `tmp/intent_audit2.py` / `tmp/intent_scorecard_build2.py`）
  2. 实跑 8 张图片意图卡 smoke 全 PASS，写入 `tmp/intent_live_smoke_20260930.json`：抠图 6.9s、放大 223s、文生图 122s、线稿上色 142s、产品图 164s、人像写真 146s、老照片修复 110s、局部重绘 84s
  3. 短名改库 6 张：`文生图` / `老照片修复` / `局部重绘` / `线稿上色` / `人像写真` / `产品图`（证据 `tmp/intent_renames_20260930.json`）；`removebg` 为内置卡，API 禁改名，仍叫「抠图去背」
- **评分表进度**：20 意图均可做（公开侧）；13/20 已有中位耗时；效果分仍待打；缺耗时：文生视频/对口型/配音/视频放大补帧/视频换装/音乐/3D
- **下一步**：实跑剩余 7 项耗时（先音乐+3D，再视频类）；抽产物打效果分；计划 b 继续短名换装/换背景并隐藏同类冗余

### 2026-09-30 12:22–12:30（Asia/Shanghai）推进+监督
- **健康**：API `:8090/api/health` 200；Web `:3100/:3200` 200；Comfy `:8195/:8196/:8197` 200（TS `100.68.100.90`）
- **实质产出**：
  1. 计划 b：短名改库（换装/换装·九视图/换背景/换背景·多功能/放大/图生视频/3D/音乐/文生视频/对口型/配音/视频放大补帧/视频换装 等）；证据 `tmp/intent_renames_wave3*_20260930.json`
  2. 同类软隐藏 71 张（`is_public=False`），公开约 184→113 且恢复对口型候选卡；证据 `tmp/intent_softhide_wave3_20260930.json`
  3. 评分表回写音乐 55.9s、3D 126.2s 与 10 项暂定效果分；`tmp/intent_scorecard_20260930.{json,md}` / `tmp/intent_quality_scores_20260930.json`
  4. 启动 wave3 live smoke 队列 5 项（文生视频/对口型/配音/视频放大补帧/视频换装），日志 `tmp/intent_live_smoke_wave3.log`
- **下一步**：收 wave3 耗时写入评分表；对已出产物做目视效果分；计划 c 核对配音/抠图/补帧/线稿/3D 缺口是否仍需从隐藏 PASS 池补位

### 2026-09-30 14:19–14:30（Asia/Shanghai）推进+监督
- **健康**：API `:8090/api/health` 200；Web `:3100/:3200` 200；Comfy `:8195/:8196/:8197` 200（TS `100.68.100.90`）；active_jobs=0
- **实质产出**：
  1. 收齐 wave3 视频 live 耗时并回写评分表（缺耗时 5→0）：文生视频 234s、对口型 304s、配音 366s、视频放大/补帧 257s、视频换装 470s；证据 `tmp/intent_live_smoke_20260930.json` / `tmp/intent_scorecard_20260930.{json,md}`
  2. 计划 b 软隐藏 wave4 共 13 张（含 ace-music-legacy），公开 PASS 114→101；证据 `tmp/intent_softhide_wave4_20260930.json`
  3. 内置短名：API 允许 admin 改内置 `name`；种子改为 抠图/音乐/配音/视频换装/放大；部署 `101979d`（`deploy.sh --skip-web merlin@100.77.80.100`）
  4. 视频类效果分暂定 3（待目视校准）；图片类维持 4
- **评分表进度**：20/20 有中位耗时；效果分覆盖 15+ 意图（换装/换背景/图生视频/风格化等仍待打或沿用空）
- **下一步**：计划 c 核对配音/抠图/补帧/线稿/3D 是否需从隐藏 PASS 池换更好卡；抽视频产物目视校准效果分；启动计划 d 首页意图入口（少字，接 v3）

### 2026-09-30 16:18–16:30（Asia/Shanghai）推进+监督
- **健康**：API `:8090/api/health` 200；Web `:3100/:3200` 200；Comfy `:8195/:8196/:8197` 200（TS `100.68.100.90`）
- **实质产出**：
  1. 计划 b 收口 wave5：短名 `图生视频·H3` / `文生视频·H3` / `对口型·Ovi`；软隐藏 15 张引擎重复/R18 孪生/伪 3D（公开 PASS 101→**86**）；证据 `tmp/intent_softhide_wave5_20260930.json`
  2. 引擎差昇挂模式并热更新 `api/app/data/app_variants.json`：图生视频(+二次元/LongCat)、H3(+15秒加速)、文生视频(+Remix/LongCat)、Ovi(+文生音画)、3D(+真人转3D/多角度)、视频放大补帧(+FlashVSR变身)；证据 `tmp/intent_modes_wave5_20260930.json`
  3. 计划 c 缺口核查：`tmp/intent_plan_c_gaps_20260930.json` — 配音隐藏 PASS 无独立 TTS；抠图/线稿保持；真 3D mesh / 纯补帧仍缺
  4. 评分表回写公开数：`tmp/intent_scorecard_20260930.{json,md}`
- **下一步**：计划 d 首页意图入口（少字，接 v3）；配音交模型下载/新工作流；抽视频产物目视校准效果分

### 2026-09-30 18:20–18:35（Asia/Shanghai）推进+监督
- **健康**：API `:8090/api/health` 200；Web `:3100/:3200` 200；Comfy `:8195/:8196/:8197` 200（TS `100.68.100.90`）；公开卡约 86 PASS（wave5 口径）
- **实质产出**：
  1. 计划 d 意图首页落地：`PortalEmpty` 短问候 + 20 个意图芯片（`INTENT_ENTRIES` → `/?view=market&app=`）+ composer + 最近作品；少字（问候去掉长句、离线/弹层提示缩短）
  2. 修正 keeper：`老照片修复`/`产品图`/`图像编辑`/`风格化` id；`intentMap` 补 icon
  3. 单测 1095 全绿；提交 **`edc85ca`**；`deploy.sh --web-only merlin@100.77.80.100` 已上线
- **下一步**：计划 d 续——一图上传入口、高级参数默认折叠、全站多余文案清扫；计划 c 配音 TTS；计划 e 速度分档

### 2026-09-30 20:22–20:40（Asia/Shanghai）推进+监督
- **健康**：API `:8090/api/health` 200；Web `:3100/:3200` 200；Comfy `:8195/:8196/:8197` 200（TS `100.68.100.90`）
- **实质产出**：
  1. 计划 d 续：门户空态加「加图」入口（挂载图片到 composer）；应用运行台「高级」参数分区默认折叠，素材/提示词默认展开
  2. 少字：分组改「素材/高级」；空态「暂无」；排队文案缩短；上传 toast 缩短
  3. 单测 1095 全绿；提交 **`f71faa5`**；`deploy.sh --web-only merlin@100.77.80.100` 已上线（Gitee main；GitHub 443 暂不通未推）
- **下一步**：计划 d 全站多余文案清扫（市场卡/详情/作品库/设置）；计划 c 配音 TTS；计划 e 速度分档

### 2026-10-03 00:49（Asia/Shanghai）推进+监督 · INTENT e
- **实质产出**：速度分档 `speed_tier=fast|quality`（默认精细）落地
  1. API `services/speed_tier.py`：H3→`balanced`/`off`；非 H3 快速档 KSampler steps 折半（≥4）；Job.params 落库；`queued_behind` 回传
  2. Web：`SpeedTierSelect` 段控 + localStorage；AppRunnerView / EngineStudioView；失败走 `plainJobErrorReason`；排队 toast
  3. 单测：API 7 + Web 6 全绿
- **下一步**：计划 f 改完重跑评分表；计划 d 少字清扫续；计划 c 配音 TTS

### 2026-10-03 01:07–01:20（Asia/Shanghai）推进 · INTENT f
- **健康**：API `:8090` ok；Comfy `:8195/:8196/:8197` 队列空；公开卡 **85** 全 smoke=pass；BUILD_ID `20261002-164940-e36d898f-dirty`
- **实质产出**：
  1. 重建评分表脚本 `tmp/intent_scorecard_build_20261003.py`；输出 `tmp/intent_scorecard_20261003.{json,md}`（20 意图）
  2. 前后对比 `tmp/intent_scorecard_compare_20260930_vs_20261003.md`：公开 **86→85（-1）**；速度分档 e36d898 已落地说明写入对比
  3. 本窗 live smoke（队列空闲、图片/音频）：抠图 7.2s、局部重绘 84.2s、音乐 72.1s → `tmp/intent_live_smoke_20261003.json`
  4. 视频类未全量重跑；效果分沿用 09-30；对比中标注关键词串扰（换装/放大中位勿当同卡回归）
- **下一步**：计划 d 少字清扫续；计划 c 配音 TTS；fast/quality 分列耗时 A/B（可选）
