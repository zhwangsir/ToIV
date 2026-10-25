## 2026-10-26 Asia/Shanghai · t87u 全开包（Remix 默认 / qwen-edit loras / P1b live / 清残留 / push+部署）

- **Remix v3 → I2V 现网默认**：`WanI2VParams.high_unet/low_unet` + `style_presets.video_i2v` → `wan22RemixT2VI2V_i2v{High,Low}V30.safetensors`；**未改 T2V**。
- **经典 `/generate/qwen-edit`**：请求体 `loras` → `parse_loras_value` + `apply_image_loras`（与市场对齐）。
- **P1b**：workstation NAS 实扫 `base-inventory.json` **live=true count=226**（resolved 115 / unknown 111）。
- **残留**：删除 `.bak*` / APPEND_DRAFT / `_civhf_*` / `_deepen_*` / `_purpose_*` 调研草稿（未入库存）。
- **单测**：`test_wan_i2v_builder` + `test_style_presets` + `test_qwen_edit` + `test_wan_accel` + `test_app_deep_knobs` → **116 passed**。
- **push**：origin(Gitee)+github 均 `work/p0-fusion-20261016` @ `adb69062`（新分支）。
- **部署**：`deploy/deploy.sh --all core` ✅；BUILD_ID=`20261025-230604-adb69062`；api `:8090/api/health` / web `:3100` / canvas-api-pg `:8290` 就绪；未用 FORCE_API_RESTART。
- **Mega-v12**：由保鲜员走 HF（本执行器未下大文件）。
- **未动**：Acc / 换密 / 隔离永久删。

---

## 2026-10-26 Asia/Shanghai · 文档瘦身（五件套 + docs 唯一 md）

- **动作**：`docs/**/*.md` 共 102 份归档至 `ALLProject/.archive/toiv-docs-20261026/`（按原相对路径）；新建 `docs/README.md`（唯一 docs md）。
- **合并**：`CLUSTER_TRUTH` 主机/端口/权重/SSH/DOWN 并入 `AGENTS.md`（LLM 口径保留 Mia `:8888`）；`DEVELOPMENT.md` 增「现行设置/模型/图谱」摘要；`README.md` 导航改为五件套。
- **TEST_LOG**：2026-10-20 之前正文 + 近窗内旧子弹 → 归档 `TEST_LOG_history_before_20261020.md`；本文件近窗保留。
- **验收**：`find docs -name '*.md' | wc -l` → 1；根 `*.md` → README/AGENTS/DEVELOPMENT/TEST_LOG。
- **未做**：push / 部署 / 删隔离 / Acc·安全；未删 `MODEL_SOURCES.json` 等非 md 账本。
- status=`docs_slim_five_piece_2026_10_26`

## 文档说明（近窗）

> 完整历史（2026-10-20 之前及本波从近窗剥离的旧子弹）已归档到
> `/Users/wangzhenyu/Desktop/ALLProject/.archive/toiv-docs-20261026/TEST_LOG_history_before_20261020.md`。
> 本文件只保留近窗记录，便于阅读。

## 2026-10-26 Asia/Shanghai · 保鲜 Remix v3 收尾 + Mega-v12 结案（接棒留痕）

- **Remix v3**：成功（断点续完；MateBook 中转→NAS）
  - High/Low 各 **14291272136** B → `comfyui-models/diffusion_models/wan22RemixT2VI2V_i2v{High,Low}V30.safetensors`
  - MateBook 暂存已清；双轨旁路；现网默认 keep；未重启 Comfy
- **Mega-v12**：Civitai 未见正式卡（Phr00t 搜 0）→ **结案不硬下**；盘上仍 Mega-v11；若要 v12 另案 HF `Phr00t/WAN2.2-14B-Rapid-AllInOne`
- **账本**：`MODEL_SOURCES` +2 ok → **ok=670 / blocked=384 / total=1055**；排行 md 已追加（保鲜员）
- **未** commit/push/部署（账本改动仍在工作区，待口令打包）

## 2026-10-26 04:44 Asia/Shanghai · t82u P1b 基座 + Forge loras + edit + 图谱轻尾巴

- **P1b 基座**：`scripts/ops/gen-base-inventory-json.py` → `apps/canvas/web/src/generated/base-inventory.json`
  - MateBook **无 NAS 挂载** → 种子 `docs/NAS_MODEL_PICKER.json`（`live=false`，UI 标明非实时）
  - **count=221** · familyResolved=**113** · unknown=**108**（族未解析，不瞎标）
  - 设置槽 `model-slot-table` 合并库存选项；`lib/base-inventory.ts`
- **Forge**：`txt2img_payload(..., loras=)` → prompt `<lora:NAME:W>`；`_submit_forge_txt2img` 传入 `req.loras`
- **qwen-image-edit**：证伪有 `LoraLoader`（`workflows/qwen_edit.py`/`lora_chain`）→ 已接
  - `supports_market_loras` / 前端 `marketAppSupportsLoras` / `enrich` / 引擎 `_qwen_edit_params`
  - `apply_image_loras` 跟随已有 LoraLoader 末端 + 改写 `TextEncodeQwenImageEdit`
  - 经典 `/generate/qwen-edit` 仍无独立 loras 字段（市场 apps.run 已接）
- **图谱轻尾巴**：`MODEL_COMPAT_GRAPH` 摘要+Mermaid；trigger 深爬：缓存卡多数 **trainedWords=0**，边数未增（`CIVITAI_TRIGGER_DEEPEN_20261026.md`）
- **验证**
  - API：`pytest test_forge_loras_payload + test_app_deep_knobs + test_image_loras_param_schema` → **19 pass**
  - Web：`bun test base-inventory + model-compat + slot-lora + market-advanced` → **39 pass**
- **commit**：本地 1–3 个；**未 push / 未部署**；未动 Remix/Mega/隔离永久删/Acc

## 2026-10-26 Asia/Shanghai · 出图 loras 真接线 + 图谱 P2

- **出图接线**
  - `engine_registry`：`txt2img` / `img2img` / `nsfw-txt2img` / `nsfw-img2img` 增加 `type=loras`（options 空）
  - `app_deep_knobs`：`supports_market_loras` 覆盖 `txt2img-basic` / `img2img-basic` / 上列引擎 id；`apply_image_loras`（Checkpoint + nextgen）
  - 前端 `marketAppSupportsLoras` 同上；**`qwen-image-edit` 仍 false**
  - 缺口文档改为「已接线出图；edit 未接」
- **图谱 P2**
  - phase=`P2`；节点 679 / 边 **2098 → 2142**
  - `conflicts_with` scope=file **22**（保留 role **14**）；`substitutes` **22**
  - compatible_with A=21（catalog；无伪造实测）；phaseNotes 写明无 LoRA 雨夜实测回写
  - UI：LoRA 卡短互斥提示；`queryCompat` 暴露 conflicts/substitutes
- **验证**
  - `cd apps/canvas/web && bun test test/model-compat.test.ts test/slot-lora.test.ts test/toiv-market-advanced-params.test.ts` → **35 pass**
  - `cd apps/api && uv run pytest tests/test_app_deep_knobs.py tests/test_engine_registry.py::test_image_loras_param_schema -q` → **14 pass**
- **commit**：本地 1–2 个 feat commit；**未 push / 未部署**；未动 Acc/安全/Remix/隔离目录

## 2026-10-26 Asia/Shanghai · 接棒 P1.5b 推荐强度 + 设置视觉二轮

- **图谱**：`recommended_strength` **22 → 351**（全量 LoRA）
  - 来源：catalog=21 · card(卡页描述)=17 · model_sources=1 · heuristic=312
  - `strength_range.source` 区分；phase=`P1.5b`
  - 节点 679 / 边 **1769 → 2098**；trigger 边仍 153
  - 卡页缓存写入 `recommendedStrength` 15 张（解析自 description；**无 token 入库**）
- **UI**：LoRA 弹层强度 pill 接图谱默认；heuristic 标「·推断」
- **设置视觉二轮**：模型与算力短文案 + 绑定卡片网格；高级 Collapse 卡片化（`SETTINGS_VISUAL_PASS2_20261026.md`）
- **出图 loras 缺口**：出图/Qwen schema 仍无 `loras`；有字段的是 h3/ltx/wan-nsfw；不硬注入（`MARKET_LORAS_SCHEMA_GAP_20261026.md`）
- **验证**：`bun test test/model-compat.test.ts test/slot-lora.test.ts` → **18 pass**
- **预览**：http://127.0.0.1:3001/settings?section=common|compute|advanced
- **未 commit / 未 push / 未部署**

## 设置视觉 + 图谱 P1.5 · 2026-10-26 00:45 Asia/Shanghai

- **A 视觉**：`docs/ux/SETTINGS_VISUAL_PASS_20261026.md`；常用区槽位主表面、去长文案、LoRA 弹层分层、快捷/R18/互斥降噪
- **B 图谱**：Civitai API（Bearer，仅本机 token 文件；**未**写入任何 json/md）补 57 卡页 → `docs/ops/_card_cache_20261025/civ_*.json` + `civ_full_cache/`
  - `requires_trigger`：**17 → 153**（有 trigger 的 LoRA **8 → 52**/351）
  - `recommended_strength`：仍 **22**（卡页少 weight；catalog 为主）
  - Qwen-image A/B：仍 **54**；节点 **679** / 边 **1769**；phase=`P1.5`
  - P1b 轻量：BaseModel **3 → 40**（MODEL_SOURCES 族可解析 checkpoint；**未**做完整 NAS 扫描）
- **出图 loras 注入**：市场 schema 仍仅 h3-/ltx* 带 `loras`；出图/Qwen **缺口未硬撑**（校验可跑、不假装注入）
- **测试**：`bun test test/model-compat.test.ts test/slot-lora.test.ts` → **18 pass**
- **预览**：http://127.0.0.1:3001/settings
- **未做**：永久删隔离、commit/push、排行榜大下载（保鲜员并行）、P2 可视化
- **未 commit / 未 push / 未部署**

## 知识图谱 P1 · 2026-10-25 23:45 Asia/Shanghai

- **范围**：trigger+推荐强度进图谱/卡片；钉选生成前兼容校验；配方引用图谱边；Qwen-image A/B 补强
- **图谱**：`build-model-compat-graph.py` 再生 → `model-compat-graph.json`（phase=P1）
  - Qwen-image **A/B：3 → 54**（HF/包名/cluster=`qwen_img` 升 B；未伪造 A；无证据仍 C）
  - `requires_trigger`：**12 → 17**（catalog + MODEL_SOURCES 可解析 trainedWords；civ API 403 未深爬）
  - `recommended_strength`：**21 → 22**（catalog 为主 + 1 条 strength tip）
- **前端**：`model-compat.assertLoraCompatible`；`slot-lora.resolvePinnedLorasForGenerate`；设置卡展示 trigger/推荐强度；市场 `onRun` 注入前校验（不兼容阻断；schema 无 loras 不假装注入）；配方 `applyPresetLoraPins` 写图谱边
- **测试**：`bun test test/model-compat.test.ts test/slot-lora.test.ts` → **18 pass**
- **预览**：http://127.0.0.1:3001/settings → 常用 → 管理 LoRA（MateBook）
- **未做**：P1b NAS 基座全量；P2 可视化；civ 全量 trainedWords（403）；永久删隔离
- **未 commit / 未 push / 未部署**

## 项目管家入账 · 2026-10-25 23:35 Asia/Shanghai

- **口径**：设置+库存+图谱 P0 **工作区已落地、未入库**；下一优先 **P1**（见 `STATE.json` → `settings_kg_p0_workspace_2026_10_25`）
- **分支**：`work/p0-fusion-20261016` tip 已 commit 仍为 `e641dda4`；大量未 commit/未 push（勿擅自 commit/push/部署生产；Acc/安全 Dly 仍冻结）
- **指针**：换机续作 `docs/ops/HANDOFF_PROMPT_SETTINGS_KG_20261025.md`；方案/账本 `docs/ux/MODEL_COMPAT_KNOWLEDGE_GRAPH_PLAN_20261025.md` · `docs/ux/SETTINGS_REDESIGN_PLAN_20261025.md` · `docs/ops/PURPOSE_UNKNOWN_QUARANTINE_20261025.md` · `docs/ops/MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md` · `docs/ops/MODEL_COMPAT_GRAPH_20261025.md`
- **现网 LLM**：生产 Mia `:8888`（`DeepSeek-V4.1-Flash-1017`）；回滚 bak `.bak.mia-8888-20261025`
- **待用户口令**：隔离是否永久删；本批是否 commit
- **管家动作**：仅五件套入账；**未**写业务代码；**未** commit/push

## DOC_TRUTH_SWEEP · 2026-10-23 19:30 Asia/Shanghai

- 2026-10-25 09:16 Asia/Shanghai — MODEL+LoRA 真机库存清单：`docs/ops/MODEL_AND_LORA_INVENTORY_20261025.md`（NAS toiv loras=264；H3 loras=38；Windows loras=129；并集 basename 见文档；LLM 在跑 Mia:8888；只读未 commit）


## 2026-10-25 · 底模↔LoRA 知识图谱 P0（拍板 D1–D4 全推荐）

- **拍板**：D1 灰显可强制 · D2 H3/出图严格分族 · D3 JSON 账本 · D4 与 inventory 并列 basename join
- **产物**：`scripts/ops/build-model-compat-graph.py` → `apps/canvas/web/src/generated/model-compat-graph.json`（schemaVersion=1）；人读 `docs/ops/MODEL_COMPAT_GRAPH_20261025.md`；方案文首/§H 已标已拍板
- **规模**：节点 ~543 · 边 ~1580 · LoRA 白名单 351；compatible_with A≈21 / B≈108 / C≈194
- **前端**：`src/lib/model-compat.ts`（familyOfBase / queryCompat / compatStatus）；设置页 LoRA 管理按当前底模族过滤；仅 C 灰显+「命名推断，未确认」；H3 专属不出图/运动槽
- **测试**：`bun test test/model-compat.test.ts test/slot-lora.test.ts` → 12 pass
- **预览**：http://127.0.0.1:3001/settings → 常用 → 管理 LoRA
- **未做（P1）**：trainedWords 全量、钉选注入生成、NAS 基座全量枚举
- **未 commit / 未 push / 未部署**

## WAVE_CLOSE / NAMING_N3 — 2026-10-24 09:50 Asia/Shanghai


## 2026-10-25 08:45 CST — LLM 切 Mia :8888 + 设置页改版方案

- **动作**：生产 core `deploy/.env` 切 LLM → `http://192.168.71.84:8888/v1` / model `DeepSeek-V4.1-Flash-1017`（L1/L2/L3/NSFW/DISPLAY/PROXY 同步）；`toiv-api` 已 restart。
- **兼容**：`TOIV_LLM_PROXY_MODELS=DeepSeek-V4.1-Flash-1017,deepseek-v4-flash-dspark`；core + 本机 `llm_proxy.py` sanitize 后把白名单别名改写为 `settings.llm_model` 再打上游（旧 canvas 仍发 `deepseek-v4-flash-dspark` 可用）。
- **本机未 commit**：`apps/api/app/routes/llm_proxy.py`、`apps/canvas/web/src/lib/local-model-defaults.ts`（ALIAS/BASE `:8888`）、`.env.example`、`local-compute-pane` 文案、`docs/ux/SETTINGS_REDESIGN_PLAN_20261025.md`。
- **冒烟**：admin JWT → `/api/system/llm` 显示新 model；`/api/llm/v1/chat/completions` 用旧别名返回 `model=DeepSeek-V4.1-Flash-1017` content=`OK`（PASS）；直连 `:8888` 亦 OK。
- **回滚**：`ssh core-lan 'cp -a /home/merlin/toiv/deploy/.env.bak.mia-8888-20261025 /home/merlin/toiv/deploy/.env && cp -a /home/merlin/toiv/api/app/routes/llm_proxy.py.bak.mia-8888-20261025 /home/merlin/toiv/api/app/routes/llm_proxy.py && sudo systemctl restart toiv-api'`
- **未做**：未 deploy canvas/web（线上设置页文案仍可能显示旧别名，但代理已改写）；未改 fleet_registry/AGENTS 文档行；未 commit/push；设置大 UI 未动（仅方案）。

- **PLAN**: `docs/ops/WAVE_CLOSE_PLAN_20261024.md`
- **Commits (no push)**: `af00a40a` fix(api) N1 · `d5991b37` docs CLUSTER_TRUTH/DOC_SWEEP · `52e7db23` fix(canvas) gate aliases
- **Deploy**: `--skip-web core` ✅ api health ok；`--web-only core` ✅ BUILD=`20261024-014946-52e7db23`
- **Disk**: core `api/app/config.py` defaults = deepseek-v4-flash-dspark / :8188 / :9311 toiv-vlm（无 qwen3.6 / :8189）
- **Gate live**: beeftv-prod + staging toiv-llm 仅 deepseek-v4-flash-dspark（bak.naming-n3-*）
- **Probe**: spark models=[deepseek-v4-flash-dspark]；H3:8264=200；VLM=[toiv-vlm]；web version.json 对齐 tip
- **Frozen skipped**: Acc-8Step · Security Dly · push · DOWN ports online
- status=`wave_close_naming_n3_deployed_no_push`

- **范围**：仓库文档真相清扫（branch `work/p0-fusion-20261016`）；**未** commit / push / deploy；**未**改生产 `.env` / 重启 spark。
- **探针**：MateBook en0=`192.168.71.118` → core health ok；spark02 `/v1/models`=DSv4+废弃别名；spark01:8000 refused；VLM `:9311`=`toiv-vlm`；H3/Comfy 8188/8196/8197/8199/8262-8265=200；TTS/embed/demucs OK；whisper×4=200；DOWN 口 spot-check refused。
- **新建现行真源**：`docs/ops/CLUSTER_TRUTH.md`
- **重写**：`AGENTS.md`（~5.6KB 短规则）；`skills/toiv-cluster/connections.md`；`README.md` 运行口径/文档地图
- **DEVICE_MODELS**：正文迁 `docs/_archive/20261023/`；原路径改 stub 指向 CLUSTER_TRUTH
- **横幅**：约 88 份历史 md（docs/ops 波次、docs/ux/research、docs 根、DEVELOPMENT、deploy README、agent knowledge 等）加 `DOC_TRUTH_SWEEP`「非现行」条
- **知识页**：canvas `b21e123b-…` 待注 docs sweep 状态
- **残留风险**：spark live 仍 serve qwen*/glm* 伪装别名；生产 core `.env` LLM 键可能仍旧（仓库 N1 已改默认）

---

- 2026-10-22 **F5 f5p PARTIAL（满配未过）**（执行器）：核生产 expr soft_floor=0.12 已 live；队列空；ONE anime async `88a7e5bc…` → hard-fail `expr_0 脸面积 0.081 < 0.15`（低于 soft_floor，非近失竞态，**不**再松阈）；soft-keep 警告卡取证；Ref2VA 跳过。证据：`sheet_poll_f5p_anime.json` + WAVE_F5 CHECKPOINT。status=`f5p_partial_hard_expr_area`；updated_at 2026-10-22T09:15:00+08:00。
- 2026-10-22 **F5 抗中断短程 f5o PARTIAL→更近 PASS**（执行器）：诊断 f5n=`face_front 0.261<0.35` 为 soft-ok 部署竞态；生产 API 已有 soft-ok。提交 ONE anime async `97c5a6ef…` → 越过人脸硬裁，卡 `expr_0 脸面积 0.139<0.15`；soft-keep 警告卡；fix `assert_expr_base_face_area` soft_floor=0.12 + 单测；`deploy/deploy.sh --skip-web core` 完成。未第二枪 GPU / 未 H3 新一镜 / 未 push。证据：`test-results/f5_rain_accept/sheet_poll_f5o_anime.json` + WAVE_F5 CHECKPOINT。status=`f5_resilient_partial_closer`；updated_at 2026-10-22T09:10:00+08:00。
- 2026-10-22 **F0_COMMIT_DONE 近窗固化（仍不 push）**（接棒；用户批准推荐包 F0→F1–F4→F0b→F5）：①`6c6798e6` feat(ux): Wave Doc→P3 壳层近窗——首页/侧栏/阶段轨/双视图 + Default H3:8264；②`f2d4a9a5` feat(wave-m): gate 默认 SFW-v23 + NAS inventory/模型源对齐；③`e4bcd639` feat(continue): D5-A 剧组协助 + 六画风变体 + N2 探针摘分母；④（本提交）docs: FINAL_FORM F0–F5 + WAVE_* 收口 + 本行。 tip=`1f264efe`（④docs；③`e4bcd639` continue）；**未 push**、未部署、未重启。 test-results/ SFW-v23 png 仍 gitignore（<1MB 本地留存）。 方案见 `docs/ux/research/FINAL_FORM_PLAN_20261022.md`。 status=`F0_COMMIT_DONE`；updated_at 2026-10-22T06:05:00+08:00。
- 2026-10-21 **部署窗 tip→线上对齐（A+R1+REMOTE=core；未 push）**（接棒；用户「开始吧」+ 方案 GO）：本机 tip `e5307c63`；干净 web BUILD_ID=`20261021-153602-e5307c63`（无 `-dirty`）；`DEPLOY_DRAIN_WAIT_SEC=120 ./deploy/deploy.sh --all core` → 快照+rsync+drain clear+重启 api/web+canvas 换装，日志 `✅ 部署完成`；线上 BUILD `20261017-062022-44043682-dirty` → `20261021-153602-e5307c63`；health：api ok、web 200、canvas-api-pg live 200、公网 `/`+`/version.json`=`e5307c63`；drain（venv）clear；未 FORCE、未换密、未改 deploy/.env、未 deploy-admin、未 rollback。浏览器手点（超时文案/徽章/市场更深参数/设定卡失败抽屉）**需用户硬刷新后自测**。status=`deploy_window_align_tip_live_e5307c63`；updated_at 2026-10-21T23:37:00+08:00。
- 2026-10-21 **感知波本地 commit 收口（仍不 push）**（接棒；用户批准超时UX+设定卡失败态+市场高级/更深参数+徽章一并 commit）：①`31110f0b` feat(ux): 客户端超时视为仍在跑 + 烟测徽章未验证/慢链（14 files）；②`df685f0b` feat(studio): 设定卡失败态——拒图可见、人话原因、警告仍留图（10 files）；③`cf9178d2` feat(market): 常用高级/更深参数（LoRA·超分）+ 抽屉超时与徽章接线（9 files，含 TEST_LOG 留痕）。工作区干净；**未 push**、未部署、未重启 toiv-api。status=`perception_wave_three_commits_local_no_push`；updated_at 2026-10-21T22:55:00+08:00。
- 2026-10-21 **市场徽章：timeout → 未验证/慢链**（接棒；用户拍板改市场徽章，感知优先，安全/上线不做）：映射层 `apps/canvas/web/src/services/toiv/smoke-badge.ts`（`formatSmokeBadgeLabel` / `smokeBadgeTone` / `isLikelySlowChainApp`）；`market-page` 烟测徽章不再原样甩英文 `timeout`。对照：`timeout` 旧=英文 timeout（中性/易当失败）→ 新=已知慢引擎「慢链」(warning) / 否则「未验证（慢链）」(warning)；`fail`/`error` 仍「烟测失败」(error)；`pass` 仍「烟测通过」。助手侧 `_smoke_label`「实测超时」→「未验证（慢链）」对齐。**不改** worker 全局 timeout 秒数、不 commit/push/部署/重启 api。证据：`cd apps/canvas/web && bun test test/toiv-smoke-badge.test.ts` → **6 pass**；`cd apps/api && uv run pytest -q tests/test_smoke_badge_label.py` → **2 passed**。status=`market_smoke_badge_timeout_unverified_local_green`；updated_at 2026-10-21T20:45:00+08:00。
- 2026-10-21 **R18 市场抽屉补更深参数（LoRA / 输出超分）**（接棒；用户拍板继续补 LoRA/分段等更深参数，只接真字段）：盘点结论——经典引擎台 `loras`/`resolution_target`/`segment_extend` 在 engine_registry；市场 `app_seed` 原无这些 knobs，`/api/apps/{id}/run` 原先也不注入。本刀**已接**：①`loras`（H3→`h3_video._inject_loras`；LTX→`lora_chain` 改接线；`null`=AI `resolve_submit_loras` / `[]`=关 / 钉选≤3）②`resolution_target`（run 后 `maybe_chain_upscale`，H3/LTX/longcat/wan 家族）。**明确未接**：`segment_extend`（依赖 h3_studio DurationPlan 末帧续段链，市场 run 未接，禁止假 UI）。实现：`app_deep_knobs.py` + `apps.run`/`get_app` enrich + seed H3/LTX schema；前端「更深参数」折叠 + `LorasField` + `enrichMarketSchemaWithDeepParams`。**不改**安全/换密；不 commit/push/部署/重启 api。证据：`cd apps/api && uv run pytest -q tests/test_app_deep_knobs.py` → **10 passed**；`cd apps/canvas/web && bun test test/toiv-market-advanced-params.test.ts test/toiv-market-m2.test.ts test/content-mode.test.ts` → **28 pass**。status=`market_deep_params_lora_upscale_local_green`；updated_at 2026-10-21T06:18:00+08:00。
- 2026-10-21 **R18 市场抽屉补常用高级参数**（接棒；用户拍板感知优先，安全/上线不做）：`market-run.ts` 分层 `splitMarketRunParams`/`splitMarketRunParamsWithConvenience`；便捷 `_ui_resolution`/`_ui_duration` 写回 width/height/length/frames（run payload 不含 UI 键）；`mergeMarketModeChips` 补 15s-fast / `h3-r2v-voice` 捷径；抽屉「常用高级」默认折叠 + `data-testid=market-advanced-toggle`。**不改**设定卡门禁、不换密、不 commit/push/部署/重启 api。证据：`cd apps/canvas/web && bun test test/toiv-market-advanced-params.test.ts test/toiv-market-m2.test.ts test/content-mode.test.ts` → **23 pass**。status=`r18_market_advanced_params_local_green`；updated_at 2026-10-21T04:45:00+08:00。
- 2026-10-21 **感知版设定卡失败态：拒图可见 + 人话原因 + 重试 + 警告仍留图**（接棒；用户拍板修设定卡失败态，安全/上线不做）：后端 `character_sheet/ux.py`（`humanize_gate_failure` / `build_sheet_gate_failure_payload` / `keep_rejected_as_warning_sheet`）；`CharacterSheetError` 挂 `rejected_bytes`；异步 Job/`_generate_sheet_core` 失败写结构化字段（`rejected_preview_url`+`reason_zh`+`gate_failures`+`soft_keep_available`，preview 带 `sig`）；新端点 `POST .../character-sheet/keep-rejected`；list sheets 读 `.gate_warn.json` 标 `gate_warning`；`studio_file_access` 修正 `char_panel_`/`char_sheet_` 文件名属主启发（cid8=parts[2]）。前端 `sheet-gate-failure.ts` + 抽屉：拒图预览、人话、技术细节折叠、再生成、`仍保留此图（仅警告）`；`toivMediaUrl` 拼 token。**不改** worker timeout、市场烟测徽章；不 commit/push/部署/重启 api。证据：`cd apps/api && uv run pytest -q tests/test_sheet_gate_failure_ux.py tests/test_character_sheet_package_split.py` → **9 passed**；`cd apps/canvas/web && bun test test/toiv-sheet-gate-failure.test.ts test/toiv-client-timeout.test.ts` → **7 pass**。status=`sheet_gate_failure_ux_local_green`；updated_at 2026-10-21T04:00:00+08:00。
- 2026-10-21 **感知版 #13 / P3 超时感知：统一「仍在后台跑」+任务中心**（接棒；用户拍板修超时感知，安全/上线不做）：共享 helper `apps/canvas/web/src/services/toiv/client-timeout.ts`（`isClientTimeoutError` / `formatClientTimeoutMessage` / `userFacingCaughtError` / `isStillRunningMessage`）+ `TasksCenterLink`（`/toiv/tasks`）。接入：设定卡轮询截止/axios 超时→info 态仍在跑；剧本拆解 deadline；市场 run catch（超时不当 `runFailed`）；图片工具 catch+Callout；创作超分 toast（info）；`upscale` poll deadline 统一文案；经典 web `friendlyError`+`trackJob` 同步。**不改** worker 全局 timeout 秒数、不改市场烟测徽章、不 commit/push/部署/重启 api。证据：`cd apps/canvas/web && bun test test/toiv-client-timeout.test.ts test/toiv-upscale.test.ts` → **7 pass**；`cd apps/web && node --import ./tests/register.mjs --test tests/generateWave12.test.ts tests/trackJob.test.ts` → **31 pass**。status=`client_timeout_still_running_ux_local_green`；updated_at 2026-10-21T02:00:00+08:00。
- 2026-10-21 **TEST_LOG 四批收口补记**：四批 SHA 齐——`9b186967` / `e0ad0a7e` / `68662984` / `426aebf5`；工作区干净；**仍不 push**。status=`wave_a_four_batches_committed_local_no_push`；updated_at 2026-10-21T00:43:00+08:00。
- 2026-10-21 **四批本地 commit 收口（仍不 push）**（接棒；用户批准四批按序全部 commit）：批1 `9b186967` chore(release): dirty-build gate + deploy drain + credential hygiene docs（14 files）；批2 `e0ad0a7e` fix(api): P-1 IDOR for scope/orch files + audit #1–#12 api slice（49 files）；批3 `68662984` feat(canvas/web): R18 content-mode + market shell + mobile padding（31 files）；批4 `426aebf5` docs(ops): weak-spot sniff + commit batch plan 20261021 + handoff sync（12 files）。真源 `docs/ops/COMMIT_BATCH_PLAN_20261021.md`。**未 push**、未部署、未重启 toiv-api、未碰生产 secrets。status=`wave_a_four_batches_committed_local_no_push`；updated_at 2026-10-21T00:42:00+08:00。
- 2026-10-21 **弱项嗅探评估 + 波次 A**（接棒；用户拍板执行波次A）：P0 弱项 W1 未 commit 审计山 / W2 生产换密未做 / W3 scope+orch 文件 IDOR（仅登录无归属）。推荐下一刀=波次A：**已执行**起草分批 commit 方案 + 补 W3；仍不 push/不部署/不换密/#13 未动。方案：`docs/ops/COMMIT_BATCH_PLAN_20261021.md`（四批：release+安全 → api 域含 W3 → canvas/web → ops+TEST_LOG）。status=`wave_a_w3_local_green_commit_plan_drafted`；updated_at 2026-10-21T00:41:00+08:00。
- 2026-10-21 **W3 文件 IDOR 落地**（接棒；TDD）：缺口实址 `apps/api/app/routes/scope.py` `get_scope_file`、`apps/api/app/routes/audio_orchestrate.py` `get_orch_file`。复用 `studio_file_access`：新增 `assert_job_backed_file_access` / `user_owns_job_backed_file`（HMAC `studio_file_sig` 即能力 + `Job.result` 属主回退 + admin 直通；跨用户统一 404「产物不存在」）。路由挂 `session`+可选 `sig`。新测 `tests/test_scope_orch_files_idor.py`；顺带改 `test_scope.py` 直调传 session。证据：`cd apps/api && uv run pytest -q tests/test_scope_orch_files_idor.py tests/test_studio_files_idor.py tests/test_scope.py::test_files_rejects_bad_name_and_missing tests/test_scope.py::test_generate_happy_path_job_done_and_file_served` → **13 passed**；`tests/test_audio_orchestrate.py` → **14 passed**。未 commit/push/部署/重启 toiv-api。status=`w3_scope_orch_idor_local_green`；updated_at 2026-10-21T00:41:00+08:00。
## 2026-10-20 · 待办#9 R18 三口径收口(D-U1=B 代码化)

- **既有拍板**: `UI_UNIFY_FUSION_PLAN` §4 D-U1=B(2026-10-15):canvas 内建 R18 门控;web 不保留独立 R18 面;未成年=唯一法律禁区。
- **三口径→一策**: canvas 开关+X-NSFW=主路径;web `/nsfw` 专区=架构退役;「R18→经典壳互斥」=F12 执行债(决策卡 A/B/C,默认暂 B);API 旧注释「仅 /nsfw 专页」改正文为请求级头。
- **落地**: `app/r18_policy.py`;`nsfw_ctx.py`+`main` 中间件注释;`video/h3/apps` 403 文案统一「R18 上下文(X-NSFW)」;canvas 过时「纯 SFW」注释/文案;`docs/ops/R18_POLICY_D_U1B_20261020.md`;`tests/test_r18_policy_d_u1b.py`。
- **验证**: policy+drama 门控 **12 passed**;test_r18 抽样 5 passed;canvas `r18-mode` 2 passed。无 commit/push、无切分支、无重启、无真 NSFW 生成。
- **仍需拍板**: 经典壳 NSFW 引擎台立刻撤(A) vs 暂留到 canvas 补齐(B,现状) vs 永久双入口(C=推翻 D-U1,不推荐)。






## 2026-10-20 · 移动端适配（壳层；非 #13）

- **盘点**：canvas `/studio` 已有 viewport/PWA/侧栏浮层/M4-2；MiniProgram=唯一原生移动端(U10a/b)；web 薄壳+viewport。无限画布触控完整化未交付。
- **本刀**：扩 `toiv-mobile.css`（市场/任务/工具壳、抽屉全宽、44px、safe-area）；market/tasks/工具页挂 class；`test/toiv-mobile-shell.test.ts`；缺口图 `docs/ops/MOBILE_ADAPTATION_GAP_20261020.md`。
- **验证**：`bun test test/toiv-mobile-shell.test.ts`（+ market m2 回归）。无 commit/push、无切分支、无重启 toiv-api。

## 2026-10-20 · 待办#12 凭据卫生（文档脱敏；生产换密未做）

- **脱敏**:AGENTS §二改指针表；`skills/toiv-cluster/credentials.md` 废止明文入库；PROMPT/api/SKILL/平台 skill、handoff/报告、`.env.example`、STATE/DRAMA 中弱默认字面量已替换为占位/键名。
- **生产换密**:未执行——须改 core `deploy/.env` 的 `TOIV_ADMIN_PASSWORD` 并重启 toiv-api；生成窗纪律下本刀不重启。Runbook:`docs/ops/CREDENTIAL_HYGIENE_ROTATE_20261020.md`。
- **守卫**:`scripts/release/test_cred_hygiene.py` + CI release-gate。无 commit/push；公开 GitHub 历史仍可能含旧明文，待用户批准推送/历史治理。

## 2026-10-20 · 待办#11 deploy drain 覆盖 studio 生成窗

- **旧缺口**:`deploy.sh` 重启 toiv-api 前只 pgrep `tmp/batch*_*.py`,不覆盖 studio_batch_render/parse/Comfy Job/烟测 campaign → 两次误杀在飞作业。
- **落地**:`deploy/deploy_drain.py`(快照纯函数 + `--probe-local` 读 api environ 的 PG);`assert_api_drain` 挂入 `remote_restart`;`FORCE_API_RESTART=1` 唯一强制旁路;`DEPLOY_DRAIN_WAIT_SEC` 可选等待。文档 `docs/ops/DEPLOY_DRAIN_STUDIO_20261020.md`。
- **验证**:`python3 -m pytest scripts/release/test_deploy_drain.py -q` → **15 passed**;dry-run busy→3 / clear→0。无 commit/push、无切分支、无重启 toiv-api、无生产部署、未查生产库。
- **运维**:部署前 drain 自动跑;忙则 exit 3。干跑用 `--snapshot-json`。

## 2026-10-20 · 待办#10 发版自动化 · BUILD_ID -dirty 硬闸(P-2)

- **现状**:`next.config.mjs` 生成 `YYYYMMDD-HHmmss-<sha>[-dirty]`;旧 `deploy.sh` 只校 sha==HEAD,**放行 dirty**。
- **门禁**:
  - `scripts/release/build_id_gate.py`(解析/拒 dirty/可选 require-head/洁净工作区)
  - `deploy/deploy.sh` 推 web 前先跑 gate;**无 ALLOW_DIRTY_WEB**;`ALLOW_STALE_WEB` 不能绕过 dirty
  - CI job `release-gate`(常驻单测+CLI)
  - `scripts/release/preflight.sh` + `docs/ops/RELEASE_AUTOMATION_P2_20261020.md`
- **验证**:`python3 -m pytest scripts/release/test_build_id_gate.py -q` 全绿;CLI dirty→1 / clean→0。无 commit/push、无切分支、无重启、无生产部署、未打 tag。
- **发版路径**:洁净树 → `./scripts/release/preflight.sh` → `cd apps/web && rm -rf .next && npm run build` → 再预检 → `deploy/deploy.sh --web-only`(需另批授权)。

## 2026-10-20 · 待办#9A 续·canvas NSFW 挂载与提交面

- **拍板上下文**:选项 A 已撤经典壳;用户选补 canvas 对 NSFW 引擎挂载(非重写 EngineStudio)。
- **挂上**:
  - 孪生父卡 `txt2img-basic`/`img2img-basic`/`h3-{t2v,i2v,fl2v,r2v}` → 抽屉「内容模式」SFW|R18(仅 R18 开),`POST /apps/{id}/run` 带 `content_mode`。
  - 纯 R18 市场卡 `ltx-txt2video`/`ltx-img2video`/`ltx-lipsync`/`wan-nsfw-i2v`(开 R18+X-NSFW 后列表可见)。
  - 市场「R18」筛选 chip;设置页 R18 捷径;映射表 `CLASSIC_NSFW_TO_MARKET`。
- **仍缺**:canvas 无经典引擎注册表直连(`/api/models/engines`+EngineStudio 参数面);`ltx-nsfw-*` 引擎 id ≠ 市场 app id(工作流路径等价、UX 不等价);扩展孪生(15s-fast/r2v-voice)无单独捷径。
- **测试**:canvas `bun test test/content-mode.test.ts` **9 passed**;m2 回归 7 passed。`r18-mode` 2 fail 为既有 stub 污染(readonly window),非本刀引入。web e2e `r18-mode.spec` 廉价改 image/video → 期望 `/studio/create`。无 commit/push、无切分支、无重启、无真 NSFW 生成。
- **操作**:设置 → 开 R18 → 应用市场 →「R18」筛选或打开 H3/文生图父卡切内容模式 R18 → 运行(进任务中心)。
- **建议下一刀**:可选 canvas 轻量引擎台(`/toiv/engine-studio`)挂 engines catalog;或把 create 页意图条在 R18 下深链孪生+默认 content_mode=nsfw;修 stale e2e 设置页 R18 开关(web 已卸)。

## 2026-10-20 · 待办#9 续·选项 A：撤经典壳 R18 引擎台

- **拍板**:用户选 A——成人内容只走 canvas R18 门控;立刻撤 web 经典壳引擎台。
- **落地**:`apps/web/app/page.tsx` 卸 `EngineStudioView`、R18 不再绕过 `/studio` handoff、`image|video|create|generate|ltxstudio` → `/studio/create`;回落面板改链 canvas;web 薄壳不再 `initR18Mode`。`EngineStudioView` 标 deprecated(单测保留)。`f9HomeHandoff.test.ts` 改契约;`docs/ops/R18_POLICY_D_U1B_20261020.md` 记 A 已落地。
- **验证**:`npm test`(apps/web) **353 pass / 0 fail**。无 commit/push、无切分支、无重启、无真 NSFW 生成。
- **暂不可达**:原经典 `EngineStudioView` 直连的 NSFW 引擎台 UX(nsfw-txt2img/img2img、h3-nsfw-*、ltx-nsfw-*、wan-nsfw-i2v)不再从 web 进入;canvas `/create` 现为应用市场面——开 R18 后门控+X-NSFW 可见市场 NSFW 孪生,但未必逐引擎等价桌面。下一刀建议补 canvas 引擎台挂载。

## 2026-10-22 · Wave Doc（N9∥N6∥N8）— 文档纠偏落地

- **口令**：用户拍板【全部按推荐包】；本波纯文档，**无**业务运行时改码 / commit / push / 部署 / 下载模型。
- **分支**：`work/p0-fusion-20261016`（tip 基准 `e5307c63` + 本地未提交文档）。
- **N9** `docs/SERVICE_INVENTORY.md`：文首加 ⛔过期警告；勘误 H3 生产 **:8264**、IndexTTS **:9200**、VLM **:9311**；:8195 标 legacy；总表保留 09-13 考古，未伪全表重采。
- **N6** `docs/AI短剧产品方案.md`：删除「默认仍是 c / 尚未做」现行断言；承认 tip 已默认 `ref2va`；§8 改为部署核对 + UI 管线选择 + 真机一镜；**禁止**再立项「切默认」。
- **N8** 新建 `docs/ops/DRAMA_STUDIO_CONVERGENCE_GATE_20261022.md`；`AGENTS.md` §〇b 加一行指针。
- **契约自检**：`rg` 产品方案不再主张「默认仍是 c」「尚未做」为现行；INVENTORY 文首含过期警告且 8264/9200/9311 可见；门禁卡可读。
- **下一波**：Wave Default（N1→N2）— H3 默认基址 :8195→:8264；fleet_registry 对齐 AGENTS §三。标记 **READY_FOR_WAVE_DEFAULT**。

## 2026-10-22 · Wave Default（N1→N2）— H3 默认 :8264 + fleet 对齐 AGENTS §三

- **口令**：全自动流水线；Wave Doc 已完成；本波仅改默认/注册表/单测，**无** commit / push / 部署 / 下载 / 重启生产 / 改生产 `.env`。
- **分支**：`work/p0-fusion-20261016`。
- **N1** 无 env 默认生产口 `:8195` → **`:8264`**（LAN `192.168.71.127` 不变）
  - `apps/api/app/config.py`：`h3_base_url` 默认与注释
  - `apps/api/.env.example`、`deploy/.env.example`：`TOIV_H3_BASE_URL`→8264；注释标明 8195=legacy
  - `apps/api/app/services/h3.py`：模块头注释；**白名单仍含** `:8195`+`:8264`
  - `apps/api/app/services/worker_warmup.py`：注释同步；`_ALLOWED_WARMUP_PORTS` 仍含 8195
  - 新增单测：`test_h3_default_base_is_8264`、`test_h3_worker_override_whitelist_keeps_legacy_8195`
  - 契约：`rg 'TOIV_H3_BASE_URL=.*8195' apps/api/.env.example deploy/.env.example` → **0 命中**
- **N2** `fleet_registry` workstation.services 对齐 AGENTS §三
  - H3 口 **8264**；新增 **8265**、**9311**；摘 **8261**、**OpenTalking 4403**、注册表内 **8195**
  - CosyVoice 9201–9203 / ASR 9210 / SenseVoice 9211：**保留**并 note「待运维确认」
  - `tests/test_fleet.py` 断言同步（含负向：8195/8261/4403 not in ports）
- **验证**：`apps/api/.venv/bin/pytest tests/test_fleet.py tests/test_h3_multi_instance.py -q` → **25 passed**（约 1.6s）。
- **下一波**：Wave P1（N3∥N4∥N10 + IA P1）。标记 **READY_FOR_WAVE_P1**。

## 2026-10-22 · Wave P1（N3∥N4∥N10 + IA P1 核心）— 进门语义收敛

- **口令**：全自动流水线；Wave Doc+Default 已完成；本波改 canvas 壳 + web 深链中间件，**无** commit / push / 部署 / 下载 / 重启。
- **分支**：`work/p0-fusion-20261016`。
- **N3 首页**：主 CTA「新建短剧」→ `createStudioProject` → `/toiv/ws/:id?section=script`；最近短剧列表；能力瓷砖/意图条收入「更多能力」默认折叠；次 CTA「打开雨夜示例」接 `POST /studio/sample-projects/rain-night`；忙闲占位文案藏端口。
- **N4 侧栏**：顶「新建短剧」→ `/toiv/drama?new=1`；稳态序 短剧项目 → 任务中心 → 工具台 → 设置；自由画布/智能体/媒体库进「高级 / 自由画布」可折；命令面板 + PWA shortcut 同步一词一义。
- **N10**：任务中心迁出「新建智能体任务」Create，改引导链到 `/toiv/agent` 与短剧；`LocalBadges` 产品面仅「本地」+能力中文名，**不展示** `:8264` 等 worker。
- **IA 附加**：drama-workspace `statusLabelZh` 镜头状态中文化；`middleware` 公网 `/toiv/*` 308→`/studio/toiv/*`（G4）；雨夜 CTA 已接线后端样片 API。
- **验证**：`bun test` agent-product-entry / workspace-command-palette-f9 / local-capability-surface / studio-market-gap-p1 → **39 pass**；`node --test tests/f12RetiredRedirects.test.ts` → **pass**。
- **P1_REMAINING**：L1 忙闲未接真实 fleet/hold API（仅占位文案）；L5 依赖三态完整设置页未做（标 P1.5）；登录回跳 `next=` 依赖既有 `app-base` 路径，未另开登录流改码。
- **下一波**：Wave P2（N7 + 声画阶段轨）。标记 **READY_FOR_WAVE_P2**。

## 2026-10-22 · Wave P2（N7 + IA P2 核心）— 无台词越过 + 阶段轨/定妆/管线

- **口令**：全自动流水线；Doc/Default/P1 已完成；本波 **无** commit / push / 部署 / 下载 / 重启。
- **分支**：`work/p0-fusion-20261016`。
- **N7 后端** `compute_studio_next_step`：仅 `dialogue.strip()` 非空镜进 voice/lipsync 分母；无台词全 `rendered` → `assemble`（有成片/全 done 才 done）；混合项目只催有词镜。
- **单测**：`test_drama_pipeline.py` 更新既有用例 + `test_studio_next_step_no_dialogue_skips_voice_lipsync`。
- **批渲**：`RenderProjectBody.pipeline` 默认 `ref2va`，整批可传 c/c_hybrid；client `renderShotAsync`/`triggerBatchRender` 透传。
- **IA P2 UI**（`drama-workspace.tsx`）：
  1. 阶段轨 StageRail：剧本→定妆→分镜→生成→配音→口型→合成；next_step 高亮「当前」
  2. 定妆门禁：无参考图禁用整批/单镜渲染 + 人话提示；角色卡「已定妆/待定妆」
  3. 管线选择器：默认 ref2va；c / c_hybrid 标专家；continue 接缝旁注走管线 C
  4. 合成段站内预览强化 + 时间线合成成功跳「合成」
  5. 任务回跳：`?section=&shot=` 高亮滚动；tasks 画布任务有 project/shot 上下文可链回 ws
  6. 失败文案复用 `userFacingCaughtError`（整批/合成）
- **验证**：
  - `apps/api/.venv/bin/pytest tests/test_drama_pipeline.py tests/test_studio_batch_render_async.py tests/test_drama_batch6_pipeline_c.py -q` → **50 passed, 3 skipped**
  - `apps/api/.venv/bin/pytest tests/test_drama_pipeline.py tests/test_studio_voice.py -q` → **28 passed**
  - `apps/canvas/web` `bun run typecheck` → **pass**
- **P2_REMAINING**：
  - ToIV Job 列表未透出 `project_id` → studio_batch_render 行尚无稳定回跳（画布任务已可）
  - 「跳过口型并标注」二次确认流未做（仍可对口型按钮）
  - 管线选择仅会话态，未持久化到项目字段
  - 选优 QA 失败专属人话表未扩（仍走通用 caught error）
- **下一波**：Wave P3（N5 + 双视图）。标记 **READY_FOR_WAVE_P3**。

## 2026-10-22 · Wave P3（N5 + IA P3 核心）— 创作语义菜单 + 看板投影 + 检视器

- **口令**：全自动流水线；Doc/Default/P1/P2 已完成；本波 **无** commit / push / 部署 / 下载 / 重启。
- **分支**：`work/p0-fusion-20261016`。
- **N5 添加菜单（D3-A）**
  - `add-node-menu-tools.tsx`：一级=文本/图像/视频/音频/合成/分组；**不再** `LOCAL_CREATE_PRESETS.map` 挂引擎名
  - 默认视频创建绑 **H3**（`defaultLocalVideoPreset`）；默认图像绑本地出图
  - `LOCAL_CREATE_PRESETS` / `LOCAL_MARKET_FEATURED` 标签改为创作语义（图像/短剧视频/…），引擎仍保留 modelRef/protocol
  - 市场精选副标题同步创作语义
- **IA P3**
  1. **列表 ↔ 看板投影**（`drama-shot-board.ts` + drama-workspace）：同源字段；切换保留 `selectedShotId`
  2. **右侧检视器**：镜头提示语/管线/台词/声画/预览/动作；减少浮层挡操作
  3. **叠盖治理**：image/video/audio settings popover 默认 `dock="end"` 右侧停靠（G5）
- **验证**
  - `bun test` local-capability-surface / add-node-menu-creative-semantics / drama-shot-board / canvas-create-menu-search → **24 pass**
  - `bun run typecheck` → **pass**
  - 静态：`add-node-menu-tools.tsx` 无 `本地·H3` / `:8264` / `LOCAL_CREATE_PRESETS.map`
- **P3_REMAINING**
  - 竖排流水线投影（LocalMiniDrama 文→帧→视频）未做（本波交付看板轻量档）
  - 空画布 ≥3 模板 / 一键整理 / 端口业务名悬停（P3.5–P3.6）未做
  - 自由画布「节点设置里换引擎」完整下拉 UX 仍靠既有 ModelPicker（预设列表未单独挂设置面板）
- **累计残余（供收口）**
  - **P1.5**：L1 忙闲真实 fleet/hold；L5 依赖三态设置页
  - **P2_REMAINING**：Job 列表 project_id 回跳；跳过口型二次确认；管线选择持久化；选优 QA 人话表
  - **P3_REMAINING**：见上
- **标记**：`READY_FOR_WAVE_WRAP`（P1–P3 主闭环可收口；P4/Dly 不做）

## 2026-10-22 · P3 残余清扫（执行器 B）— 竖排 / 空态模板 / 端口业务名 / 引擎预设

- **范围**：P3_REMAINING；可与 A 并行；主要改 `apps/canvas/web`。
- **分支**：`work/p0-fusion-20261016`；**无** commit / push / 部署。
- **交付**
  1. **竖排流水线投影**：`DramaShotViewMode` 增 `pipeline`；`DRAMA_PIPELINE_STAGES` 文→帧→视频→配音→口型；drama-workspace 三视图切换保留 `selectedShotId`；看板未破坏。
  2. **空画布 ≥3 模板**：`CANVAS_EMPTY_TEMPLATES`（短剧分镜条 / 图生视频 / 空白）；guided+freeform 空态露出；`createImageToVideoTemplate` + hook；一键整理文案接 zoom dock。
  3. **端口业务名悬停**：`canvasPortBusinessLabel` / `canvasPortHoverTitle`；ConnectionSideRail title/aria；市场 LocalBadges `localCapabilityHoverTitle`（产品面不露 :8264，admin 可选）。
  4. **引擎预设设置面板**：`LocalEnginePresetPanel` 挂入 image/video settings popover；`localVideoEnginePresets` / `localImageEnginePresets`；一级菜单仍创作语义。
- **验证**
  - `bun test` drama-shot-board / canvas-empty-templates / add-node-menu / local-capability-surface → **28 pass**
  - `bun run typecheck` → **pass**
- **标记**：`P3_REMAINING_DONE`

## 2026-10-22 · Wave P1.5 + P2 残余清扫 — L1/L5 / Job 回跳 / 跳过口型 / 管线落库 / QA 人话

- **执行器**：残余清扫 A；口令「开始吧，做完所有的工作」子任务。
- **分支**：`work/p0-fusion-20261016`；**无** commit / push / 部署 / 重启生产。
- **P1.5 L1 忙闲**
  - 新增 `GET /api/fleet/brief`（任意登录用户）：人话 summary + mine.held/active + 设备摘要；**不暴露端口**
  - `ComputeStatusStrip` 挂首页（full）与短剧工作台（compact）；设置「模型与算力」同挂 full
- **P1.5 L5 依赖三态**
  - 新增 `GET /api/studio/deps-status`：api / tts / h3 → reachable|degraded|unreachable + 人话；不可达时禁用配音/生成 CTA
- **P2 Job project_id 回跳**
  - `_job_dict` 透出 `project_id`（params 优先，result 回落）
  - 任务中心 ToIV 作业行 `jumpHref` → `/toiv/ws/:pid?section=shots`
- **P2 跳过口型二次确认**
  - `POST /studio/shots/{sid}/lipsync/skip` + `skip_lipsync_for_shot`（mux 配音、`lipsync_skipped=True`）
  - UI：`window.confirm` → 调用；徽章「未对口型」
- **P2 管线持久化**
  - `StudioProject.preferred_pipeline`（db 补列）+ `ProjectPatch`；工作台选择器 hydrate + PATCH
- **P2 选优/QA 人话**
  - `studio-qa-failure.ts`；pick/render/voice/lipsync/batch/assemble catch 叠加专属文案
- **验证**
  - `pytest tests/test_jobs.py::test_job_dict_exposes_project_id tests/test_wave_p15_p2_remaining.py` → **5 passed**
  - `pytest tests/test_fleet.py` → **10 passed**
  - `bun test test/studio-qa-failure.test.ts` → **3 pass**
  - `bun run typecheck` → **pass**（顺手修 market-page type import 混排 TS1003）
- **标记**：`READY_FOR_P3_REMAINING`

## 2026-10-22 · D5-A 剧组协助开关 + gate 文档对齐 / bak 清扫

- **执行器**：接棒工程师；口令「继续完成没有完成的内容」→ D5-A 优先。
- **分支**：`work/p0-fusion-20261016`；**无** commit / push / 部署 / 重启。
- **D5-A**
  - 新增 `apps/canvas/web/src/services/toiv/crew-assist-mode.ts`（按项目 `localStorage`，默认关）
  - `drama-workspace` 顶栏「剧组协助」Switch；开时人闸旁轻提示（定妆 / 生成前确认 / 合成）；**不**建 Agent Team、不代发
  - 测试：`bun test test/crew-assist-mode.test.ts`
- **文档**
  - `docs/ops/WAVE_M_PROGRESS_20261022.md`：总览/边界与「当前=SFW-v23」对齐；保留提案历史
  - `docs/ops/DEVICE_MODELS_IN_USE_20261022.md`、`MODEL_FRESHNESS_BASELINE_20261022.md`：补记 gate 已切 v23
- **bak**：10 个 `.bak_gate_v23_*` / `.bak_wave_m0_*` 移出仓库 → `/tmp/toiv-bak-20261022/`（扁平同名合并为 8；live 源仍为 v23）
- **未做（冻结）**：P4 导出/Agent 一键；Dly；未启动 CosyVoice / 角色变体 UI
- **标记**：`D5A_DONE`

## 2026-10-22 · N2 CosyVoice/ASR 真机探针 + 角色资产变体下单 UI

- **执行器**：接棒工程师；**无** commit / push / 部署 / 重启。
- **分支**：`work/p0-fusion-20261016`

### Task 1 — fleet 探针（附录 C #1）

探针时刻：**2026-10-22 04:11 Asia/Shanghai** · host=`192.168.71.127`（fleet_registry `probe_host` / LAN）

| host:port | TCP | HTTP | 处置 |
|-----------|-----|------|------|
| 192.168.71.127:9200 IndexTTS | ok | `/health` → **200** engine=indextts2 | 对照；仍 http 进分母 |
| :9201 CosyVoice2 | **Connection refused** | — | `probe=none` 摘分母；note 记探针 |
| :9202 CosyVoice3 | **Connection refused** | — | 同上 |
| :9203 Qwen3-TTS | **Connection refused** | — | 同上 |
| :9210 ASR | **Connection refused** | — | 同上 |
| :9211 SenseVoice | **Connection refused** | — | 同上 |

- 改：`apps/api/app/services/fleet_registry.py`（`_declared` + 五口 note）
- 测：`tests/test_fleet.py` 断言 probe=none + note 含 Connection refused
- 验证：`.venv/bin/pytest …test_registry_workstation…` + 直接 import 断言

### Task 2 — 角色资产变体 UI 下单

- 落点：短剧工作区设定卡抽屉（非新表面）
- **可下单**：`ancient_realistic` / `anime` → 现有 `submitSheetAsync`（=regenSheet）
- **缺口**：realistic/ink_wash/cyberpunk/three_d — 历史 img2img+PUT `style_variants`，**无产品化下单 API**；UI 徽标「待 API」+ 已登记则展示缩略图
- 文件：`character-style-variants.ts`、`client.fetchCharacterAsset`、`drama-workspace` `data-testid=character-variant-order`
- 测：`bun test test/character-style-variants.test.ts` → **5 pass**

### 仍开（非本轮）

- Mega-v11 / Acc-8Step smoke；dogfood 一镜；扩展画风产品化 API；P4/Dly 冻结

- **标记**：`N2_PROBE_DONE` · `VARIANT_ORDER_UI_DONE`

## 2026-10-22 · 可选 Mega/Acc 可见性探针 + 会话总收口

- **执行器**：接棒；**无** commit / push / 部署 / 重启 / 出片作业。
- **探针时刻**：约 2026-10-22 04:14 Asia/Shanghai · LAN `192.168.71.127`
- **Mega-v11 :8197**：up；`wan2.2-rapid-mega-aio-v11.safetensors` 在 CheckpointLoader 列表；queue_running=1 → **跳过出片**
- **Acc-8Step :8264**：up；Ref2VA+FL2VA Acc LoRA 在 LoraLoader；生产 int8 仍在 → **跳过长 GPU 旁路出片**
- **收口文**：`docs/ux/research/WAVE_REMAINING_CLEARED_20261022.md`
- **git tip**：`e5307c63` · 分支 `work/p0-fusion-20261016` · 工作区脏
- **标记**：`OPTIONAL_SMOKE_VISIBILITY_DONE` · `SESSION_REMAINING_CLEARED`

## 2026-10-22 · CONTINUE 产品壳 dogfood（D5-A + 变体下单）

- **时间**：2026-10-22 05:05 Asia/Shanghai；**无** commit/push/deploy/restart/出片作业
- **栈**：本地 Vite `:3010`（`vite.dogfood.config.ts` 双代理）+ core API `:8090` + studio bootstrap `:3100/studio`
- **登录**：`email=admin` / `admin123`
- **项目**：雨夜便利店·林夏 `16e33f8b93dd45d9abca779816ede9b5`（2 角色）
- **D5-A**：Switch 剧组协助 off→on；`localStorage toiv_crew_assist:<pid>=1`；「人闸仍强制」文案 — PASS
- **变体 UI**：`character-variant-order` 可见；下单变体：古风写实 ×1；扩展档「待 API」— PASS（未点生成）
- **波B 项目** `78e17c5b…`：无角色 → 仅验证开关 PASS
- **生产缺口**：`/api/fleet/brief`、`/api/studio/deps-status` 404（未部署）；Admin fleet 仍 8/25
- **GPU**：Acc/Mega/雨夜一镜出片本窗跳过（无 &lt;10min 安全脚本）
- **证据**：`/tmp/toiv_dogfood_rain2.{json,png}`
- **标记**：`CONTINUE_SHELL_DOGFOOD_PASS`

## 2026-10-22 · CONTINUE IMAGE_SMOKE gate SFW-v23 @ :8196

- **时间**：2026-10-22 05:11 Asia/Shanghai；队列提交前 running=0/pending=0；**无** commit/push/deploy/restart
- **路径**：复用 Wave M1② 成功 Comfy API 图（CheckpointLoaderSimple=`Qwen-Rapid-AIO-SFW-v23.safetensors`，8/768/euler）
- **prompt_id**：`9c642d81-87e5-4188-a258-1a8001cb65fa`
- **结果**：status=**success** · 轮询 **114.23s** · `Continue_IMAGE_SFWv23_00001_.png` **682209** bytes
- **落盘**：`test-results/continue_sfw_v23_image_smoke.json` · `test-results/Continue_IMAGE_SFWv23_00001_.png`
- **脚本**：`scripts/e2e/rapid_sfw_v23_image_smoke.py`（已加 history 长超时重试）
- **标签**：`IMAGE_SMOKE`（非 FULL_VIDEO）
- **未做**：Acc-8Step/Mega 视频；扩展画风 API（本窗优先 GPU）
- **标记**：`CONTINUE_IMAGE_SMOKE_SFWV23_PASS`

## 2026-10-22 · 扩展画风 API（STYLE_VARIANT_API_DONE）

- **时间**：2026-10-22 Asia/Shanghai；**无** commit / push / deploy / restart；**无** Acc/Mega 视频 / 雨夜定妆×4
- **策略**：扩展档作 **prompt-pack / style_key** 挂在现有 `POST .../character-sheet/async`（submitSheetAsync）；无新微服务
- **后端**
  - `SHEET_STYLES` → 六档；`SHEET_STYLE_PATTERN`；helpers：`sheet_is_hanfu` / `sheet_uses_anime_xl` / `sheet_is_photoreal` / `sheet_style_zh`
  - `_STYLE_SUFFIX` / `_STYLE_NEGATIVE` / `_SHEET_CKPT` / `_THEME` / `_CARD_THEMES` 覆盖六档
  - pydantic：`schemas.py`×7 + `studio.FrameVariantsRequest` allowlist 放宽
  - 汉服门禁仍仅 `ancient_realistic`；写实→DreamShaper；水墨/赛博/3D→Animagine XL
- **前端**：`character-style-variants.ts` 四档 `sheetOrderable: true`；「待 API」区随 `!sheetOrderable` 自然消失
- **测试**
  - `apps/api/tests/test_sheet_style_variants.py`（allowlist / mapping / CharacterSheetRequest）
  - `bun test test/character-style-variants.test.ts`
- **解锁**：`realistic` · `ink_wash` · `cyberpunk` · `three_d`（先前「待 API」四档）
- **未做**：真机 sheet 出图冒烟；Acc/Mega 视频
- **标记**：`STYLE_VARIANT_API_DONE`

## 2026-10-22 · CONTINUE 收口 · Acc/Mega VIDEO 诚实停 + WRAP
- LAN 192.168.71.127 :8264/:8197/:8196 system_stats 200 · queue 0/0；无 <15min Acc/Mega 旁路 → `scripts/e2e/acc_8step_min_frames_smoke.py` skeleton exit 2；WAVE_REMAINING「CONTINUE 收口」；标记 `CONTINUE_STREAK_WRAP` · tip `e5307c63` dirty

## 2026-10-22 · F1_KEYFRAME_QA_LAMPS_DONE

- **时间**：Asia/Shanghai；起点 tip `f915b665`；**无** push / deploy / restart；F1 **可 commit**
- **关键帧默认**
  - FE `storyboard-drive.ts`：DEFAULT=keyframe；`videoRenderGate`；默认镜头视图=pipeline
  - UI：分镜驱动选择器；配景采用关键帧；单镜/整批软闸
  - BE：`preferred_drive_mode` + db 幂等列；`POST /studio/shots/{sid}/adopt-keyframe`；render 422 `{code:KEYFRAME_REQUIRED}`；`force_direct` 旁路
- **失败码/质检**：`STUDIO_FAILURE_TABLE` + `resolveStudioFailure` + `studioQaMessageWithHint`（含 KEYFRAME_REQUIRED）
- **控片就绪灯**：`control-readiness` + `ControlReadinessLamps`（六灯）挂工作区
- **测试**：bun 13 pass（storyboard-drive / control-readiness / studio-qa-failure）；pytest `test_keyframe_drive.py` 6 pass
- **进度**：`docs/ux/research/WAVE_F1_PROGRESS_20261022.md`
- **未做**：F2–F5 / push / deploy
- **标记**：`F1_KEYFRAME_QA_LAMPS_DONE`


## 2026-10-22 · F2_CREW_ONE_CLICK_DONE

- **时间**：Asia/Shanghai；起点 tip `e76b8e18`；**无** push / deploy / restart；F2 **可 commit**
- **一键成片（专家）**
  - FE `crew-one-click.ts`：剧组协助闸 → `createAgentRun({level:L2, opts.auto_approve:false})` → `/toiv/runs/:id`
  - UI：`drama-workspace` 仅 `crewAssist` ON 露「一键成片」；专家文案钉人闸
  - 复用既有 `agent_team_graph`（计划确认门图外 + assembly_gate interrupt）；**不**自动放行
- **测试**：bun 13 pass（crew-one-click / crew-assist-mode）
- **进度**：`docs/ux/research/WAVE_F2_PROGRESS_20261022.md`
- **未做**：F3–F5 / push / deploy / Acc / 安全 Dly
- **标记**：`F2_CREW_ONE_CLICK_DONE`

## 2026-10-22 · F3_BGM_KPI_DONE

- **时间**：Asia/Shanghai；起点 tip `12052c14`；**无** push / deploy / restart；F3 **可 commit**
- **BGM 声床**
  - BE：`bgm_bed` + `mix_bgm_under_video` + assemble 混音；项目 `bgm_*`；上传 `/studio/projects/{pid}/bgm`
  - FE：`BgmBedPanel`（时间线/合成）；挂 URL·上传·音量·对白闪避
- **KPI 北向**
  - BE：`ProductKpiEvent` + `/studio/kpi/events|summary`；合成记 episode_assembled
  - FE：四指标面板 + `/toiv/kpi`；path_touch / rework / queue_wait 埋点；**空=暂无数据**
- **测试**：bun 4 pass（bgm-bed / product-kpi）；pytest 5 pass（test_bgm_bed_f3 / test_product_kpi_f3）
- **进度**：`docs/ux/research/WAVE_F3_PROGRESS_20261022.md`
- **未做**：F4 剪映 · F0b 部署 · Acc · 安全 Dly · 雨夜一镜
- **标记**：`F3_BGM_KPI_DONE`



## 2026-10-22 · F4_JIANYING_DRAFT_DONE

- **时间**：Asia/Shanghai；起点 tip `180134ce`（docs）/ `9bbc8914`（feat）；**无** push / deploy / restart；F4 **可 commit**
- **剪映草稿**
  - BE：原创 `jianying_draft.py`（`toiv_jianying_draft_v1`）→ ZIP（content/info/meta + assets + IMPORT.md）
  - API：`GET /api/studio/projects/{pid}/export/jianying`
  - FE：`JianyingExportButton` 挂合成段；替换「即将推出」文案；`exportStudioJianyingDraft`
  - 纪律：**只学协议，不拷 AGPL/GPL**
- **测试**：bun 4 pass（jianying-draft）；pytest 7 pass（test_jianying_draft_f4）
- **进度**：`docs/ux/research/WAVE_F4_PROGRESS_20261022.md`
- **未做**：FCPXML · F0b 部署 · Acc · 安全 Dly · 雨夜一镜
- **标记**：`F4_JIANYING_DRAFT_DONE`

## 2026-10-22 · F0B_DEPLOY_DONE

- **时间**：2026-10-22 06:19–06:21 Asia/Shanghai（CST / UTC+8）
- **决策**：A 本机 rsync + R1 `--all` + REMOTE=`core`；**不** push；**不**换密；**不** FORCE；**不** deploy-admin
- **本机 tip**：`b94ae940`（完整 `b94ae94080b4cfb0f64eeb5b182e7e6e64a4f268`）· 分支 `work/p0-fusion-20261016` · 部署前工作区干净
- **本地 BUILD**：`20261021-221837-b94ae940`（`apps/web` 干净重建；preflight OK）
- **线上 BUILD**：`20261021-221837-b94ae940`（core `web/.next/BUILD_ID` 与公网 `/version.json` 一致；**无** `-dirty`）
- **命令**：`DEPLOY_DRAIN_WAIT_SEC=120 deploy/deploy.sh --all core` → exit 0 · 「✅ 部署完成」
- **顺序实证**：快照 `.rollback-previous` → rsync api/web/deploy → rsync `.next` → drain clear → restart toiv-api → toiv-web → canvas（88 插件 + gate template + Go/vite 换装）
- **健康**
  - core：`toiv-api` / `toiv-web` / `canvas-api-pg` **active**；`:8090/api/health` 200；`:3100` 200；`:8290/api/health/live` 200
  - 公网：`https://toiv.wineryz.top/` 200；`/api/health` 200；`/version.json` → `{"buildId":"20261021-221837-b94ae940"}`
- **路由对齐（先前本地 dogfood 生产 404）**
  - `/api/fleet/brief` → **401**（未认证，路由在线）
  - `/api/studio/deps-status` → **401**
  - `/api/studio/kpi/summary` → **401**
- **gate**：`/home/merlin/toiv-studio/gate/model-config.template.json` 含 `Qwen-Rapid-AIO-SFW-v23.safetensors` / `checkpoints/Qwen-Rapid-AIO-SFW-v23.safetensors`
- **回滚**：`.rollback-previous/{api-app,web-next,canvas-bin,canvas-dist,canvas-plugins,canvas-api.env}` 在位；失败可用 `deploy/deploy.sh --rollback core`
- **未做**：F5 雨夜一镜 · Acc/Mega · 安全 Dly · push · admin
- **标记**：`F0B_DEPLOY_DONE`


## 2026-10-22 · F5_RAIN_ACCEPT_PARTIAL

- **时间**：2026-10-22 06:21–06:30 Asia/Shanghai（CST / UTC+8）
- **生产 BUILD**：`20261021-221837-b94ae940`（`/version.json`）
- **项目**：雨夜便利店·林夏 `16e33f8b93dd45d9abca779816ede9b5` · `preferred_pipeline=ref2va` · `preferred_drive_mode=keyframe` · 四镜 `seam_to_next` 空（不续写）
- **定妆×4**：林夏 anime/ancient 面板在档；本窗真提 realistic×2 + anime×1（均门禁）；anime **soft-keep** 警告卡；GPU 有真实重试（core 日志 slate/emblem）
- **UI（prod）**：`/studio/toiv/ws/…` 剧组协助 · 就绪阶段链 · 剧组 ON→一键成片 · `/toiv/kpi`；截图在 `test-results/f5_rain_accept/`（gitignore）
- **剪映**：`GET /api/studio/projects/{pid}/export/jianying` → ZIP 27 665 921 B · `toiv_jianying_draft_v1` · 4v+4a
- **未做**：新 H3 一镜重渲 · Acc/Mega · 安全 Dly · **push**
- **结论**：**PARTIAL（主闭环可见）**；满配 PASS 仍差「门禁全绿新定妆 + 可选新一镜」
- **文档**：`docs/ux/research/WAVE_F5_RAIN_ACCEPT_20261022.md` · `WAVE_FINAL_FORM_WRAP_20261022.md`
- **标记**：`F5_RAIN_ACCEPT_PARTIAL`

## 2026-10-22 F5r Ref2VA PASS_WITH_SOFT_SHEET
- sheet area 0.146 soft-ok; Ref2VA shot0 done ~1474s; video `62d66b39_1_2204_00001_.mp4`; tip 1e97302c; no push

## 2026-10-23 · Naming-spec landing Wave N1

- **时间**：2026-10-23 18:54 Asia/Shanghai（CST / UTC+8）
- **tip**：`53803db2`（改后未 commit；工作树脏）
- **范围**：仓库默认值 + `fleet_registry` + `.env.example` + 本地 `.env` LLM 字段 + 最小 AGENTS 漂移；**未**改生产 core `.env`、**未**重启 `dsv4_60`、**未** deploy/commit/push
- **铁律**：一个磁盘权重一个 weight id；served 名不得伪装成另一家模型家族
- **Canvas**：https://cursor.com/canvas/store-2a7cb835-7fcb-4cd4-b2c8-cb0ee07b899c/b21e123b-da5f-43d9-90af-a3842894cfcc
- **关键默认 before→after**
  - `llm_model`：`qwen3.6-uncensored` → `deepseek-v4-flash-dspark`
  - `llm_display_name`：谎称 Qwen3.8 → `DeepSeek-V4-Flash-DSpark (abliterated, spark TP2)`
  - `vlm_server_url` / `vlm_model_id`：`WS:8000` / `qwen3.6-uncensored` → `:9311` / `toiv-vlm`
  - `comfy_workers`：`:8189` → `:8188`；`upscale_workers` 摘 `:8261`
  - spark01 registry：Qwen3-VL-32B → DSv4 TP2 rank1 headless（probe=none）
  - spark02 registry：Qwen3.8 → ep.llm.primary DSv4；whisper 探针 `/v1/models` → `/health`
  - WS 离线口（:8200/:8300/:9004/:9304/:9400–9404 等）→ `probe=none` archive
- **测试**：`pytest tests/test_fleet.py tests/test_naming_defaults_n1.py tests/test_llm_proxy.py` → **24 passed**
- **Deferred**：spark `--served-model-name` 清 qwen*/glm* 别名；生产 core `.env` 对齐；deploy
- **标记**：`NAMING_SPEC_N1_REPO_LANDING`

## NAMING_N2_CORE_SPARK — 2026-10-23 19:58 Asia/Shanghai

Goal: production core `.env` hot-align + spark served-alias purge (canonical only).

### core `/home/merlin/toiv/deploy/.env`
- Backup: `.env.bak.naming-n2-20261023195818`
- Keys changed (no secrets printed):
  - `TOIV_LLM_MODEL` / `DISPLAY_NAME` / `NSFW_MODEL` / `L2_MODEL` / `L3_MODEL` → `deepseek-v4-flash-dspark` (+ honest display)
  - `TOIV_EVAL_VLM_BASE_URL` → `http://192.168.71.127:9311`；`TOIV_EVAL_VLM_MODEL` → `toiv-vlm`（原误指 spark02 LLM）
  - `TOIV_COMFY_WORKERS` → `http://192.168.71.127:8188`（原 TS `:8196`）
  - `TOIV_COMFY_WORKERS_REGISTRY_URL` → LAN `:8188/admin/backends`
  - `TOIV_H3_BASE_URL(S)` / `TOIV_LONGCAT_BASE_URL` → LAN `:8264` / `:8197`
  - `TOIV_UPSCALE_WORKERS` → LAN `:8262,:8263`
  - `TOIV_LLM_PROXY_MODELS` kept multi during cold-start; shrink after `/v1/models` canonical-only
- `sudo systemctl restart toiv-api` → active；`GET /api/health` → ok workers=`http://192.168.71.127:8188`

### spark
- Script both hosts: `~/dsv4-serve.sh` → only `--served-model-name deepseek-v4-flash-dspark`；bak `.bak.naming-n2-*`
- Restart order: stop both → rank1 sk01 @19:58:49 → rank0 sk02 @19:59:03
- Cold load in progress at log time；final `/v1/models` + chat smoke appended below when ready.


#### Final (20:04 Asia/Shanghai)
- `/v1/models` ids = `["deepseek-v4-flash-dspark"]` only
- chat smoke: model=deepseek-v4-flash-dspark → content `N2_OK`
- alias purge verified: qwen3.8-27b / qwen3.6-uncensored / glm-5.3-flash → HTTP 404 NotFoundError
- `TOIV_LLM_PROXY_MODELS` shrunk to single name; `toiv-api` restarted again; `/api/health` ok
- Cold start wall: ~5–6 min (faster than historic 20–45min estimate; AOT cache hit)

### Not done
- git commit / push / full deploy

## 2026-10-25 08:36 Asia/Shanghai — V4.1 Mia EAQ2.9 ABLIT 双轨 :8888 起服 + R18 探针 PASS

- 目标：#1 Mia-AiLab DeepSeek-V4.1-Flash-1017 EXL3 EAQ 2.9bpw + Keys ablit，TensorFold TP2，端口 8888（不顶替现网默认）
- 权重：Mia/Engram/Keys 双机齐；嫁接 n_edited=104；rank0/rank1 cache 已建
- 镜像：`tensorfold-dsv41:exl3-tp2-928adbd0e57d` 双机一致（本机灌入 pytorch 基座后本地编译）
- 模式：免 NFS sudo，host-path `NFS_VOLUME=$HOME/.cache/huggingface`，`PREPARE=0`
- 起服：临时停 `dsv4_60`（同 GPU 互斥）；`./start.sh` 冒烟 OK；API `http://192.168.71.84:8888/v1` model=`DeepSeek-V4.1-Flash-1017`
- R18 探针：R18_CN / R18_EN / EDGE_CN 均 PASS（无拒答启发式命中，有正文）
- 冻结：未 commit / 未 push；未改 ToIV 默认入口；现网 `:8000` 当前停（dsv4 已 stop）
- 待定：是否长期切默认到 Mia，或恢复 dsv4_60 与 :8888 二选一占卡

## 2026-10-25 09:00 Asia/Shanghai — Settings P0 IA（常用 / 模型与算力 / 高级）前端落地

- 范围：`apps/canvas/web` 设置页信息架构减负；不 commit / 不 push / 不部署生产；未碰 Acc/安全；未改 core
- 改动：`pages/settings/index.tsx` 三区 Segmented（默认常用）；LocalCompute 下沉「模型与算力」；渠道/RunningHub/Prompt/诊断进「高级」Collapse
- 产品面去端口：`local-compute-pane` Tags/文案、`localChannelProtocolLabel` 改友好标签（本机 LLM · Mia V4.1 / 本地出图等）；算力条 compact 无端口
- 兼容：旧 `?section=channels|models|runninghub|diagnostics` 映射到新 IA
- 核验：`bun test` local-model-defaults / nas-bind-ux / studio-market-gap-p1 / workspace-command-palette → 29 pass；touched files 无 tsc 报错（仓库另有 drama-workspace / control-readiness 既有错误）
- 本地看：`cd apps/canvas/web && bun run dev` → http://127.0.0.1:3000/settings（或 /studio/settings 视壳路由）

## 2026-10-25 09:05 Asia/Shanghai — 多模型搭配可控方案（文档）

- 触发：用户反馈设置 P0 后「可控性太差」——多模型不同搭配不知怎么控
- 交付：`docs/ux/MODEL_MIX_CONTROL_PLAN_20261025.md`（角色槽/配方/库存；设置 vs 短剧台；P0.5；拍板 M1–M3）
- 回写：`docs/ux/SETTINGS_REDESIGN_PLAN_20261025.md` §8 指针
- 范围：方案 + 文档；**未**大改前端 / 未 commit / 未 push / 未部署 / 未停起 LLM

## 2026-10-25 09:20 Asia/Shanghai — 设置页多模型搭配 P0.5（槽位/配方/互斥）

- 拍板：M1/M2/M3 均按方案建议
- 交付：常用区角色槽表（对话/助手/VLM只读/出图/出视频·主H3/出视频·运动/TTS只读）+ 配方芯片（短剧默认/高质量慢/省显存，localStorage）+ Mia↔dsv4 互斥提示（不自动起停）+ 模型与算力页头引导回「常用」
- 代码：`apps/canvas/web/src/lib/model-mix-presets.ts`；`pages/settings/{model-slot-table,model-mix-presets-bar,llm-mutex-banner,index,local-compute-pane}.tsx`
- 测试：`bun test` model-mix-presets / model-slot-table / settings-assistant-model-row / settings-preference-spacing / studio-market-gap-p1 / local-model-defaults → **30 pass**
- 预览：vite 在 **:3001**（`--port 3000` 被占回落）→ http://127.0.0.1:3001/settings
- 冻结：未 commit / 未 push / 未部署 / 未停起 LLM

## 2026-10-25 09:45 Asia/Shanghai — 设置搭配纠正：用户自选主控 + LoRA 挂件

- 触发：用户纠正「搭配不能固定死」「很多 LoRA 怎么办」
- 心智：角色槽每行下拉自选 = 主控；快捷示例折叠次要（非最优）；LoRA = 挂在出图/视频槽下的挂件
- 代码：`model-slot-table` Select 行；`model-mix-presets*` 降级文案；`slot-lora.ts` + `slot-lora-row.tsx`（候选走 `/api/models/engines`，空态指 NAS/市场，不造假库存）
- 文档：`docs/ux/MODEL_MIX_CONTROL_PLAN_20261025.md` §3.2/§3.4/§9
- 测试：`bun test` model-mix-presets / model-slot-table / slot-lora / settings-assistant-model-row → **11 pass**
- 预览：http://127.0.0.1:3001/settings（常用区先槽位自选，快捷示例折叠在下）
- 冻结：未 commit / 未 push / 未部署 / 未自动起停容器

## 2026-10-25 · 模型来源/用途全量调研（只读）

- 产出：`docs/ops/MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md` + `docs/ops/MODEL_SOURCE_PURPOSE_LORA_20261025.csv`
- 覆盖：非 LoRA 280 行 + LoRA 去重 404；合计 684；证据 A33 / B322 / C271 / D58
- 方法：库存真机表 × MODEL_SOURCES × lora_catalog(21) × 命名簇；H3/Qwen-Rapid 抽查官方卡页
- 冻结：未改服务 / 未 commit / 未 push / 未部署

## 2026-10-25 Asia/Shanghai — 模型来源用途加深核实轮

- 范围：主库 LoRA 账本缺口 88 + 原 D 级再攻 + C 簇代表款上网核实；只读磁盘/HF/Civitai；**未** commit/push/部署/改运行模型。
- 主库 88：升 B **64** / 仍 C **22** / 仍 D **2**；`MODEL_SOURCES` 追加 64（ok 493→557）。
- LoRA 证据：A21 / B177→**245** / C178→**115** / D28→**23**；合计 D 58→**53**。
- 结论：产品相关（加速蒸馏、官方 IC、在跑默认、可对卡画风）**能查清**；私训/哈希-only/leetspeak/断链 **不能装 100%**。
- 文档：`docs/ops/MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md` §7；`MODEL_SOURCE_PURPOSE_DEEPEN_88_20261025.csv`；CSV/账本已更新。

## 2026-10-25 Asia/Shanghai — Civitai+HF 定点检索轮（C/D→B）

- 范围：LoRA evidence C/D（约 138）+ 主库加深残留 22C+2D + 研究表非 LoRA C/D；公开 HF/Civitai API + 少量 WebSearch；**未** commit/push/部署/改服务。
- LoRA：B 245→**355** / C 115→**19** / D 23→**9**（升 B **+110**；两站无命中 **28**）。
- 主库 88：原残留 C22 本轮升 B → **B86 / D2**（仍 D：`30-360-high`、`i2l_smoke_20260827`）。
- 非 LoRA 表：17 升 B / 1 无命中（`glm53-dflash2-mxfp8`）；断链大模型找到上游卡但本地 symlink 仍废。
- 用户判断「主源= Civitai+HF」：**基本成立**；公开款大多能查到 B；两站无命中=私训/改名/删卡/哈希，不是第三大源。
- 文档：`docs/ops/MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md` §8；`MODEL_SOURCE_PURPOSE_CIVHF_20261025.csv`；`MODEL_SOURCES.json`（bak `.bak.civhf-20261025`）。

### 2026-10-25 Asia/Shanghai — 模型用途确定度（卡页 P-A/B/C/D）
- 范围：LoRA 404 + 在跑/默认 10；抓 Civitai 57 + HF 141 卡页缓存；只读服务。
- LoRA 用途：P-A 94 / P-B 257 / P-C 53 / P-D 0。
- 结论：作用大多可归类（P-A+P-B≈87%）；产品级确定仅 P-A≈23%；来源 B≠用途 P-A。
- 产物：`docs/ops/MODEL_PURPOSE_FROM_CARDS_20261025.csv`；调研 §9；`MODEL_SOURCES.notes` 回写 P-A/P-B（bak `.bak.purpose-20261025`）。未 commit/push。

## 2026-10-25 — purpose P-C LoRA quarantine (Asia/Shanghai)
- 依据 `docs/ops/MODEL_PURPOSE_FROM_CARDS_20261025.csv`：用途 **P-C** 53 basename；磁盘实例 **58** 经 workstation CIFS **同卷 mv** 隔离（未 rm）。
- 根：`toiv/comfyui-models/_quarantine_purpose_unknown_20261025/`（loras+h3）与 `Windows/.../models/_quarantine_purpose_unknown_20261025/`。
- 跳过 0 / 失败 0；`lora_catalog`∩P-C=∅；无产品默认硬引用。
- 账本 `docs/MODEL_SOURCES.json`（及 app data 镜像）对应行 `status=blocked`；文档 `docs/ops/PURPOSE_UNKNOWN_QUARANTINE_20261025.md`。未 commit/push/deploy。

## 2026-10-25 Asia/Shanghai — 设置页接入调研库存（LoRA A+B × P-A/P-B）

- 范围：前端可读库存 JSON + LoRA 管理弹层；**未** commit / push / 部署生产。
- 生成：`scripts/ops/gen-lora-inventory-json.py` → `apps/canvas/web/src/generated/lora-inventory.json`（可用 **351**；跳过隔离 53 + non_lora 10）。
- 规则：available + 来源 A/B + 用途 P-A/P-B；P-C/quarantine/blocked/来源 C|D 默认隐藏。
- UI：`slot-lora-row` 展示用途文案、类型标签、来源链接；引擎候选与库存 merge，引擎空时库存兜底。
- 基座下拉：仍用渠道/算力已配置列表（完整 NAS 基座枚举未接，UI 已注明）。
- 单测：`apps/canvas/web/test/slot-lora.test.ts`（inventory + merge + localStorage）。
- 文档：`docs/ux/MODEL_MIX_CONTROL_PLAN_20261025.md` / `SETTINGS_REDESIGN_PLAN_20261025.md` 各补「库存接入」一句。

## 2026-10-25 22:58 Asia/Shanghai — 模型搭配知识图谱方案（仅文档）

- 范围：只写方案；**未**实现代码、未 commit/push/部署。
- 产物：`docs/ux/MODEL_COMPAT_KNOWLEDGE_GRAPH_PLAN_20261025.md`（本体/边/流水线/JSON 并列存储/设置过滤/Agent query_compat/P0–P2/决策点）。
- 审计缺口：inventory 无 baseFamily·trigger·强度；slots_for 启发式交叉污染；compat 真源待图谱。
- 推荐：`model-compat-graph.json` 与 inventory 并列 + basename join；P0 抽 civ baseModels+catalog 边并按族过滤。
