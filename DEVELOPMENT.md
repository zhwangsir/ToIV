# ToIV 开发指南

> **版本**: 2026-08-26
> **适用读者**: 开发人员 / 运维人员
> **核心文档**: [AGENTS.md](AGENTS.md) / [STATE.json](STATE.json) / [TEST_LOG.md](TEST_LOG.md) / [README.md](README.md)


**2026-09-08 LIVE：MODEL_SOURCES batch12 后计数更新**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`；**ok 262 / blocked 130 / total 392**（前 239/120/359）；updated `2026-09-08T05:20:38+08:00`；根目录无 `MODEL_SOURCES*`；后续每批追加。status=`inventory_updated_batch12`；STATE `model_sources_inventory_2026_09_08`；updated_at 2026-09-08T05:21:00+08:00。由 ToIV 模型下载追加；本 commit 含清单正文 + 五件套进度。

**2026-09-08 LIVE：MODEL_SOURCES 清单已落入 docs（历史；进一步片→batch12 计数更新）**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`；**ok 239 / blocked 120 / total 359**；updated `2026-09-08T04:59:25+08:00`；根目录无 `MODEL_SOURCES*`；后续每批下载追加这两份。NAS 短索引：`toiv/comfyui-models/SOURCES.md`（非仓内正式清单）。status=~~`inventory_landed`~~ → 见上条 `inventory_updated_batch12`；STATE `model_sources_inventory_2026_09_08`（+ `model_sources_inventory_convention_2026_09_08` → ready）；updated_at 2026-09-08T05:00:00+08:00。由 ToIV 模型下载落入；本 commit 含清单正文 + 五件套进度。

**2026-09-08 CONV：模型/内容下载来源清单稳定路径（~~awaiting~~ → inventory_landed）**：用户要求下载须维护带来源的清单（供更新与查文档）。稳定路径（仓内，就绪后提交）：`docs/MODEL_SOURCES.md`（人读）+ `docs/MODEL_SOURCES.json`（机读）。**根目录仍只留五件套**，勿把 `MODEL_SOURCES*` 放仓库根。维护：ToIV 模型下载；项目管家五件套只引用此路径。口径：覆盖已下载到 NAS 的模型/内容 + HF/Civitai/RH/本地出处；**不**替代 `engine_registry` / `model_wiki` / admin knowledge-graph / `model_profiles`。WIP 草稿仅 `.regen_tmp/`，勿当正式清单。status=~~`convention_set_awaiting_inventory`~~ → **`inventory_landed`**（见上条）；STATE `model_sources_inventory_convention_2026_09_08`；updated_at 2026-09-08T04:56:00+08:00。清单正文已落入 docs（见上条 LIVE）。

**2026-09-08 LIVE：市场左侧空白已修上 core dirty**：BUILD_ID `20260907-203017-6417f2a-dirty`；根因空 `.rh-col` 仍 flex 占宽；改容器 `ResizeObserver` + 跳过空列 + 重置 placement；**非** IO/刷新问题。叠在市场瀑布流无感追加之上（further of `market_waterfall_seamless_append`）。status=`live_on_core_dirty`；STATE `market_left_blank_fix_2026_09_08`；updated_at 2026-09-08T04:32:00+08:00。产品树 dirty 未 commit 产品码；远程未推。勿 stage product/`.regen_tmp`。

**2026-09-08 LIVE：表单媒体/HF/封面/presets 收口（市场≈1083）**：Animate V8 **15→16**（视频+图）；127 双输入 rh-acc gap **0**；demo 本地 **182**，defaults **127/127**；功能封面 +**15**（非 NSFW generate）；HF 应用侧清完（藏 `Flux-文生图-96c82d`；模型库未动）；presets MateBook+core=`[]`；`presets_anti_resurrect=cleared_empty_array`；误种 soft-hide **959**；市场≈**1083** / rh-acc **837** / rh-h3·minimax listed **0**；SFW/R18 9 dual-mode parents + twin soft-hide。status=`done`；STATE `rh_form_media_hf_covers_2026_09_08`（+ `r18_merge` watch 已清）；报告 `.regen_tmp/rh-form-media-hf-covers-20260908.md`（勿提交）；updated_at 2026-09-08T04:04:00+08:00。产品树 dirty 未 commit 产品码；远程未推。勿 stage product/`.regen_tmp`/`rh_h3_presets.json`。

**2026-09-08 LIVE：SFW/NSFW 合并已上 core dirty partial**：BUILD_ID `20260907-195752-2a1c833-dirty`；**9** 对合并；封面双标 + 应用内切换 + twin soft-hide；残 LTX/wan-nsfw 等未并；watch=`presets_anti_resurrect_cleared_empty_array`；presets_anti_resurrect=`cleared_empty_array`；soft_hide_mistaken_reseed=959（勿 stage 产品/`rh_h3_presets.json`/`.regen_tmp`）。status=`live_on_core_dirty_partial`；STATE `r18_merge_into_sfw_2026_09_08`；features={dual_tags,in_app_toggle,twin_soft_hide}；merged_pairs=9；updated_at 2026-09-08T04:04:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-08 LIVE：家族模板 wipe1166 + 准确重入131 COMPLETE（rh-acc≈837）**：删 **1166**（`rh-h3`/`rh-minimax*`）；准确重入 **+131**；跳过 **360**（detail_code_901×289 + null_workflowId×71）；错误 **0**；直播 rh-acc ≈ **837**；抽检 **12/12**；KEEP 原 rh-acc + 产品 h3-* builtins；家族克隆 **0**；新 131 表单 repair updated**91**/unchanged**40**/with_select**83**；防复活已清空 `apps/api/app/data/rh_h3_presets.json`（bak 保留；路径仅记文档，勿提交）。status=`wipe_reseed_done`；STATE `rh_form_cover_fidelity_2026_09_08` + `rh_family_wipe_accurate_reseed_2026_09_08`；报告 `.regen_tmp/rh-family-wipe-accurate-reseed-20260908.md`（勿提交）；updated_at 2026-09-08T03:21:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-08 LIVE：封面效果对齐完成（修35；剩18待真出图）**：rh-acc **全 RH CDN**；修 **35**（5 rh-acc mp4→still CDN + 30 builtin 上传 RH 图）；剩约 **18** 无 RH 映射 builtin 待真出图（禁 NSFW `/covers/generate` 渐变）；可见 apps≈**811**；rh-acc 期间 sibling reseed **706→763**；市场家族 `rh-h3` 克隆当前 **0**；家族 wipe/reseed **已完成**（见上条 wipe1166+重入131；rh-acc≈837）。status=`done_18_pending_real_art`；STATE `cover_effect_align_2026_09_08`；报告 `.regen_tmp/cover-effect-align-20260908.md`（勿提交）；updated_at 2026-09-08T03:21:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-08 LIVE：RH 表单封面保真（research→拍板→~~执行中~~ → wipe_reseed_done）**：rh-acc **706** 修 **168** / 已齐 **529** / skip code_901 **9** / errors **0**；封面 RH CDN **706/706**；LIST→select 修复；去 graph fallback 多余字段；封面改写仅 **2**。真正错位主因≈**1166** 家族模板克隆（`rh-h3`/`rh-minimax*`，无 webappId，本地海报封面）。**用户拍板已完成**：wipe **1166** → 准确重入 **131**；跳过 **360**；rh-acc≈**837**；抽检 **12/12**；家族克隆 **0**；keep=`rh-acc + product builtins`。status=`wipe_reseed_done`；decision=`wipe_family_clones_accurate_reseed`；STATE `rh_form_cover_fidelity_2026_09_08` + `rh_family_wipe_accurate_reseed_2026_09_08`；报告 `.regen_tmp/rh-form-cover-fidelity-20260908.md` / `.regen_tmp/rh-family-wipe-accurate-reseed-20260908.md`（勿提交）；updated_at 2026-09-08T03:21:00+08:00。产品树 dirty 未 commit 产品码；远程未推。


**2026-09-08 LIVE：生图池 Comfy FE 齐套 1.52.7 + 去重/封面三项完成（fe_homogenized_dedupe_covers_done）**：FE 齐套 WS/pc01/pc02/LB:8188 均为 frontend **1.52.7**；`fe_gate=met`；`fe_homogenized=true`；`homogenize_pending=false`；H3 未动。~~pc01=1.49.6→1.52.7 进行中~~ SUPERSEDED；~~1.45.x 分裂~~ SUPERSEDED for gen-pool FE。去重：85组 kept85 soft-hide**243** deleted0；市场 **2163→1920**；rh-acc **949→706**；日志 `.regen_tmp/dedupe-hash-20260908.json`（勿提交）。渐变假封面：用户可见 **114→0**；日志 `.regen_tmp/gradient-cover-fix-20260908.json`（勿提交）。STATE `rh_comfy_covers_dupes_audit_2026_09_08`；updated_at 2026-09-08T02:21:00+08:00。产品树 dirty 未 commit 产品码；远程未推。


**2026-09-08 LIVE：用户已拍板三项（~~decided_executing / fe_partial~~ → 见上条齐套结果）**：① Comfy LB FE **≥1.49.6** 统一；② 同图哈希去重（same_image_hash）；③ 渐变假封面全量重生。~~Status=执行中 / fe_partial~~ **SUPERSEDED by** `fe_homogenized_dedupe_covers_done`。STATE `rh_comfy_covers_dupes_audit_2026_09_08`；decisions={comfy_lb_fe:">=1.49.6 unify", dedupe:"same_image_hash", covers:"regen_all_gradient_fake"}；原 updated_at 2026-09-08T02:15:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-08 LIVE：RH Comfy版本分裂+封面UX+重复调研（research_done_awaiting_user）**：打开失败主因=Comfy LB FE 分裂 ~~WS **1.45.20** / pc02 **1.45.21** / pc01 **1.49.6**~~ SUPERSEDED for gen-pool FE；userdata 正确；失败后残留旧图；rh-acc Subgraph **0%**(0/949)；FireRed banner 新名 / canvas 留 Z-Image。RH 主路径=**app_runner**；开工作流需 FE≥1.49.6 或钉 pc01。`toiv_workflow_query` 已在 WS/pc01/pc02 `/extensions` 列出（先前「待重启」可能已过时）。封面：DB empty=**0**；UX 渐变=抽象 cover（~68 R18 rh-h3）；H3 R18 SFW inherit×**7**；CDN 949 OK。重复：stem **60/236**；hash **85/328**。pending_user=[dedupe_rules, comfy_lb_unify_or_pin_pc01, r18_gradient_cover_regen]。STATE `rh_comfy_covers_dupes_audit_2026_09_08`（滚动 open_workflow / cover notes）；报告 `.regen_tmp/rh-comfy-covers-dupes-audit-20260908.md`（勿提交）；updated_at 2026-09-08T02:10:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-08 LIVE：Comfy 打开工作流加固（WS LIVE；web dirty BUILD；扩展已列出；版本分裂为打开 blocker）**：`toiv_workflow_query` harden 同上；WS LIVE；web BUILD `20260907-174430-c309d02-dirty`；probe OK。**更新**：扩展已在 WS/pc01/pc02 `/extensions` 列出；打开失败主因=Comfy LB FE 版本分裂（见上条调研）。status=`hardened_live_version_skew_blocker`。STATE `open_workflow_comfy145_query_2026_09_08` + `rh_comfy_covers_dupes_audit_2026_09_08`；报告 `.regen_tmp/fix-comfy-load-covers-20260908.md` / `.regen_tmp/rh-comfy-covers-dupes-audit-20260908.md`（勿提交）；updated_at 2026-09-08T02:10:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-08 LIVE：worker `_pick_app_client` 扩 H3/LongCat/Wan*（API live_on_core）**：`_pick_app_client` 扩 H3/LongCat/Wan*；503 列缺模型/节点；API 已上 core（`live_on_core`）。STATE `worker_pick_app_client_expand_2026_09_08` updated_at 2026-09-08T01:20:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-08 LIVE：市场 prune 付费云端专用 −263（2426→2163）**：付费云端专用删 **263**；保留可本地化；市场 **2426→2163**。STATE `market_prune_paid_cloud_2026_09_08` updated_at 2026-09-08T01:20:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-08 LIVE：封面 coverless/gap_pending→0（UX 真理已滚动）**：DB empty/**coverless**=**0**；local **1214**；CDN **949**；bad_files **0**。UX「无封面」= CSS 渐变或抽象 cover 文件（~68 R18 rh-h3）；H3 R18 SFW inherit×**7**。STATE `cover_gen_coverless_2026_09_08` + `rh_comfy_covers_dupes_audit_2026_09_08`；报告 `.regen_tmp/fix-comfy-load-covers-20260908.md` / `.regen_tmp/rh-comfy-covers-dupes-audit-20260908.md`（勿提交）；updated_at 2026-09-08T02:10:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-07 市场瀑布流无感追加 LIVE on core LAN（历史基线；进一步片→市场左侧空白已修；未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260907-164531-9ec0144-dirty`；去掉 CSS `column-count`；`.rh-grid` → N 列 `.rh-col`；placement Map 保列位；续载只往最短列底追加；resize 才整表重分；叠在市场小步续载 / 无限滚动 / 市场 UX / UI P4 瀑布流之上（further of market_small_step_load）。STATE `market_waterfall_seamless_append_2026_09_07` status=`live_on_core_dirty` updated_at 2026-09-07T16:45:31+08:00。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 LIVE：RH 准确重入库第二轮扩种 SCALE2（累计1212；池未耗尽）**：Phase C 准确 RH 第二轮扩种完成。本轮新种 **500**；累计 `rh-acc-*` = **1212**（RH id 去重；scale2 前约 700，中途 aborted partial ~12 → baseline 712 before this +500）。累计跳过 **1048**（`null_workflowId` 1047 + `export_code_810` 1）；累计 create 错误 **0**（先前 2 个 `create_422` 已重试成功：webapps 1976578710449033218、2042457691490099202）。抽检 **12/12**：节点+封面+RH id 一致。已处理 webappId **2260**；池未耗尽（catalog 8747，约 6487 未处理，多数会跳过）。脚本加固：POST 前丢掉非 ASCII binding leaf（对齐 Core `_BINDING_FIELD_RE`）。无新 BUILD（HTTP 种库）。无模板克隆。族累计 other375 / flux231 / ltx210 / qwen205 / wan197 / h3 7。STATE `rh_accurate_reseed_scale2_2026_09_07` + `rh_clone_purge_reimport_2026_09_07`：new_seeded=500，cumulative_seeded=1212，cumulative_skipped=1048，cumulative_errors=0，prior_create_422_recovered=true，spot_check=12/12，processed=2260，remaining_unprocessed≈6487，pool_exhausted=false，families={other:375,flux:231,ltx:210,qwen:205,wan:197,h3:7}，binding_harden=drop_non_ascii_leaves，build_id=null，no_template=true，status=`reseed_scale2_done_pool_remaining`；`updated_at` 2026-09-07T20:55:00+08:00。报告 `.regen_tmp/rh-accurate-reseed-scale2-20260907.md`（勿提交）。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-07 LIVE：RH 准确重入库扩种完成（累计700；仍在扫）**：Phase C 准确 RH 扩种完成。本轮新种 **500**；累计 `rh-acc-*` = **700**（RH id 去重 700）。累计跳过 **752**（皆 `null_workflowId`）；累计 create 错误 **2**（`create_422`；bindings 非 `inputs.*`/`widgets_values.*`）。抽检 **12/12**：节点+封面+RH id 一致。无新 BUILD（HTTP 种库）。无模板克隆。族累计 other224 / flux135 / ltx118 / qwen115 / wan110 / h3 6；processed ids 1454。ToIV **仍在扫可导出库存**（勿标全量 reseed done）。STATE `rh_accurate_reseed_scale_2026_09_07` + `rh_clone_purge_reimport_2026_09_07`：new_seeded=500，cumulative_seeded=700，cumulative_skipped=752，cumulative_errors=2，error_reason=create_422 (bindings not inputs.*/widgets_values.*)，spot_check=12/12，families={other:224,flux:135,ltx:118,qwen:115,wan:110,h3:6}，build_id=null，no_template=true，status=`reseed_scale_done_scanning_more`；`updated_at` 2026-09-07T20:20:00+08:00。报告 `.regen_tmp/rh-accurate-reseed-scale-20260907.md`（勿提交）。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-07 LIVE：RH 准确重入库第一批完成（200；more pending）**：种入 **200**（无模板克隆；exported Comfy API graph）；跳过 **294**（null_workflowId/未开放）；错误 **0**。族分布 flux50 / qwen42 / ltx36 / wan32 / h3 6 / other39。抽检 **8/8**：节点+封面+RH id 一致；ids prefix `rh-acc-*`。无新 BUILD（HTTP 种库）。`no_template_reseed=true`。STATUS `reseed_batch1_done_more_pending`（勿标全量 reseed done）。STATE `rh_clone_purge_reimport_2026_09_07` + `rh_accurate_reseed_batch1_2026_09_07`：reseed_pilot_batch1 done，seeded=200，skipped=294，errors=0，family counts as above，spot_check=8/8，build_id=null，no_template=true；`updated_at` 2026-09-07T20:00:00+08:00。报告 `.regen_tmp/rh-accurate-reseed-20260907.md`（勿提交）。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-07 LIVE：10Eros 模型出处补全（64/64）已上 core（勿标 reseed done）**：模型出处覆盖 **62/64 → 64/64（100%）**；flagged apps **10 → 0**。wiki + `engine_registry` 已写 civitai/HF（H3 `10Eros_Max_h3_TURBO_ref2va_beta2_int8_convrot` → HF cicalooo + Civitai 2851079；LTX `10eros_v14` → civitai.red 2447875 + HF TenStrip/LTX2.3-10Eros）；顺带填 `hunyuan_video` / `flux1-dev`。BUILD_ID 仍为既有脏构建 `20260907-103808-6e94327-dirty`（本轮主要改 api；`deploy/deploy.sh` API restarted；health OK）。准确重入库 **PILOT 仍进行中**（勿标 reseed done / 勿发明计数）。STATE `model_provenance_10eros_2026_09_07` + `rh_clone_purge_reimport_2026_09_07` provenance 字段已更至 64/64；`updated_at` 2026-09-07T19:50:00+08:00。报告 `.regen_tmp/10eros-provenance-20260907.md`（勿提交）。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-07 LIVE：RH 真工作流导出已打通；准确重入库 PILOT 进行中（勿写 reseed done / 勿发明计数）**：RH 真工作流导出 METHOD FOUND。Recipe：`POST /api/webapp/detail` → `workflowId`；`POST /api/openapi/getJsonApiFormat`（apiKey+Bearer）→ `data.prompt` = Comfy API JSON。Verified 3+ samples（Flux2-klein 17 nodes、H3 Lip Sync 22、H3 T2AV 33 等）。Limits：`workflowState=0` 或 author ACL → fail（1913 / WORKFLOW_NOT_EXISTS）。Prior BLOCKER `TOKEN_MISSION` / wrong path → **SUPERSEDED** for apps with `workflowId`+`workflowState=1`。清库已完成（rh-*=0；累计≈8611；删数已报）。准确重入库为 **PILOT in progress**（非全量 batch）；`reseed_started=true`；`reseed_count` 仍 null/TBD（勿发明）。完成后报告：reseed count、skip-reason stats、spot-check results、BUILD_ID if deployed。未部署，**无 BUILD_ID**。`no_template_reseed=true`。STATE `rh_clone_purge_reimport_2026_09_07`：`status=reseed_in_progress_export_ok`，export_method as above，prior_blocker superseded，reseed_started=true，reseed_pilot=true，reseed_count=null，updated_at 2026-09-07T19:45:00+08:00。报告 `.regen_tmp/rh-graph-export-path-20260907.md`（勿提交）。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-07 LIVE：RH 清库完成（rh-*=0；重入库 BLOCKER；勿写 reseed done）**：`rh-*` 已清 **0**；本轮删 **3392**（API 1149 + SQL 2243）；相对 wipe_before 累计约 **8611**；admin is_builtin 403 故用 SQL。保留应用 **48**（47 builtins + `Flux-文生图-96c82d`）；未删产品内置。模型出处 **96.9%（62/64）**；未证主因 `10Eros_Max_h3_*` / `10eros_v14`（约 10 个 H3/LTX NSFW）；另曾标 hunyuan_video I2V + flux1-dev-fp8（pulid）。准确 RH 重入库 **0**；**BLOCKER**：RH 无可用工作流图导出（detail 仅元数据；export 403 TOKEN_MISSION）。未部署，**无 BUILD_ID**。`no_template_reseed=true`。STATE `rh_clone_purge_reimport_2026_09_07`：`status=wipe_done_reseed_blocked`，rh_remaining=0，deleted_this_run=3392，cumulative≈8611，retained_apps=48，model_provenance=62/64，reseed=0，blocker=RH_workflow_export_TOKEN_MISSION，build_id=null，deployed=false，updated_at 2026-09-07T19:30:00+08:00。报告 `.regen_tmp/rh-wipe-resume-20260907.md`（勿提交）。产品树 dirty 未 commit 产品码；远程未推。

**2026-09-07 PROGRESS / IN PROGRESS：RH 清库进度（rh-* 约剩 3392；已续删；未完成；勿写 complete）**：清库中途 executor 基础设施 unauthenticated 中断；当前 core 约剩 `rh-*` **≈3392**（原先近万已删大半）；admin token 仍可用；已重启续删 + 内置/模型出处审计；**禁止模板重种**（`no_template_reseed=true`）。仍 `in_progress` / not done；完成后报告：删除数、重入库数、内置变更、模型出处覆盖、BUILD_ID。STATE `rh_clone_purge_reimport_2026_09_07`：`status=in_progress_on_core`，`rh_star_remaining≈3392`，`interrupted_unauthenticated` then resumed。**勿发明精确已删数量**；未发明集群/GPU；产品树 dirty 未 commit 产品码；远程未推。

**2026-09-07 SCOPE UPGRADE / IN PROGRESS：RH 清库重入库口径升级（含内置 + 全量严格出处；未完成；勿写 complete）**：用户 ADDENDUM（via ToIV 开发）——**内置应用也要动**（不再「内置保留」）；所有内容与所有模型来源必须可核对（HF / Civitai / RH / 本地）；口径升级为全量严格出处。仍 `in_progress`；完成后报告：删除数、重入库数、内置变更、模型出处覆盖、BUILD_ID。STATE `rh_clone_purge_reimport_2026_09_07` scope_upgrade：`builtin_also=true`，`strict_provenance_all_sources=[HF,Civitai,RH,local]`，`status=in_progress_on_core`。~~先前「内置应用保留」~~ → **SUPERSEDED**。勿发明已删/重入库数量/集群/GPU；产品树 dirty 未 commit 产品码；远程未推。

**2026-09-07 INTENT / IN PROGRESS：RH 错挂克隆清库 + 准确重入库（历史口径；~~内置保留~~ → SUPERSEDED by 上条 SCOPE UPGRADE；未完成；勿写 complete）**：用户下令删掉所有错挂 RH 克隆卡并重新准确入库；封面/名称/工作流必须一致，不许再模板克隆；~~内置应用保留~~（已作废）。ToIV 已开始在 core 清 `rh-*` 并研究 RH 真工作流导入。Status：`in_progress` / not done；STATE `rh_clone_purge_reimport_2026_09_07`=`in_progress_on_core`。勿发明已删数量/集群/GPU；产品树 dirty 未 commit 产品码；远程未推。

**2026-09-07 打开工作流导航已修 LIVE on core LAN（未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260907-103808-6e94327-dirty`；根因 `#canvas` 无效，改为 `/?view=canvas`；打开应用去掉简洁/工作流，仅 RH 运行台 +「在画布中编辑」；API open-in-comfy itself was fine，SPA hash ignored；tests appsWorkflow+appsRh **37** pass；报告 `.regen_tmp/fix-open-workflow-nav-20260907.md`（勿提交）。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 RH 参考图/提示词默认值 LIVE on core LAN（未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260907-095758-c383011-dirty`；UI media default + 远程封面预览（提交仍要真上传）；seed `inject_rh_ref_defaults`；回填 **8626**（top300 RH detail 提示词 **287/300**，其余家族默认+封面 CDN）；Errors **0**；关闭此前 RH UX Tab gap「参考图/提示词默认值仍缺」；报告 `.regen_tmp/rh-ref-defaults-20260907.md`（勿提交）。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 RH 图生新入库封面回填完成（数据侧已上 core；空封面 13→0；有效缺封面 0；无产品 SHA；远程未推文档）**：空 `cover_url` **13→0**；**6387** 保持 RH CDN；**13** 无 coverUrl 用同族 CDN+admin 上传补齐；有效缺封面 **0**；scope **6400** new image RH apps；total market **8646**；LAN core `http://192.168.71.47:8090`；报告 `.regen_tmp/cover-backfill-image-rh-20260907.md`（勿提交）。AGENTS.md 已回写短注。

**2026-09-07 RH UX Tab+封面 contain+管理员出处链接 LIVE on core LAN（未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260907-092308-9db9030-dirty`；应用详情 | 我的生成 Tab；封面 object-fit contain；admin `rh_webapp_url` + `source_links`（引擎 HF/Civitai）；模型页 admin Civitai+HF；~~仍缺参考图/提示词默认值~~ → **已关闭**（见上条 RH 参考图/提示词默认值 LIVE）。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 RH 图生全量入库完成（数据侧已上 core；种入 6400；错误 0；无产品 SHA；远程未推文档）**：认证 search 字段分页（`search` 非 `searchValue`）；去重 **6511** → 分类 **6408** → 种入 core **6400**（错误 0）；base：`qwen-image-edit` 2040 / `img2img-basic` 2419 / `txt2img-basic` 1941；leftover 69 + video_skipped 34；already on core skipped 8；core apps ≈**9846**；LAN core `http://192.168.71.47:8090`；报告 `.regen_tmp/rh-image-ingest-20260907.md`（勿提交）。AGENTS.md 已回写短注。

**2026-09-07 应用封面回填完成（数据侧已上 core；有效缺封面 547→0；无产品 SHA；远程未推文档）**：core 有效缺封面 **547→0**（空 `cover_url` 4→0；本地 cover 文件 404 的 543 张靠恢复 `/data/app-covers/` 下 **10** 个共享家族 PNG 修好；另上传 4 张空应用封面）。根因：10 个共享家族封面文件从 `/data/app-covers/` 缺失，而 543 个 `rh-*` 仍指向它们（疑似 admin 上传 `_remove_cover_file` 删掉了共享 URL）。未跑 GPU generate；家族仍按设计共享封面；`expand_top` 可选后续。报告 `.regen_tmp/cover-backfill-20260907.md`（勿提交）。AGENTS.md 已回写短注。

**2026-09-07 作品库选封面叠层已修 LIVE on core LAN（未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260907-082025-be7d5c7-dirty`；原因：sticky `.rh-params` 困住 fixed Modal；改为 portal 到 `document.body`。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 市场小步续载 LIVE on core LAN（历史；进一步片→市场瀑布流无感追加 LIVE；未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260907-080948-7b6f9e7-dirty`；每页 10；细条 loading；rootMargin 150；新卡 fade-in；叠在市场无限滚动 / 市场 UX 之上（further of market_infinite_scroll / market_ux）。现见上条市场瀑布流无感追加 LIVE（同族进一步片；新 BUILD）。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 市场无限滚动 LIVE on core LAN（历史；进一步片→市场小步续载 LIVE；未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260907-075325-693aa19-dirty`；去掉「显示更多」；IO sentinel 续载；叠在市场 UX / UI P4 瀑布流之上（further of market_ux / ui_p4_market_waterfall）。现见上条市场小步续载 LIVE（同族进一步片；新 BUILD）。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 H3 Ref2VA bf16 已入库 NAS（MateBook 核实；仍缺 pruned_bf16；无产品 SHA；远程未推；AGENTS 已回写）**：完整落盘 `NAS/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_bf16.safetensors`（66280487368 bytes ≈62GiB；MateBook abs `/Users/wangzhenyu/NAS/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_bf16.safetensors`）；同目录已有 INT8 `NAS/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors`；**仍缺** `minimax_h3_ref2va_pruned_bf16`；workstation 通常 `/home/merlin/nas_mount/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_bf16.safetensors`；设备管家：已完整落盘，H3 无需为下载重启；勿把 NAS/#recycle 未完成 aria2 副本当 live。

**2026-09-07 应用详情 RH 布局 LIVE on core LAN（未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260907-072931-ea942fc-dirty`；左封面 / 右打开应用 + 打开工作流 / 节点信息；admin 出处；封面 expand×40 已重踢。supersedes comfy_open_edit 中「详情页 RH 布局仍推进中」。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 Comfy 二次编辑通路 LIVE on core LAN（未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260907-070508-718d466-dirty`；`POST /api/apps/{id}/open-in-comfy` → 画布自动加载；save-back 未做；封面 expand 已重踢；详情页 RH 布局仍推进中→SUPERSEDED（见上条应用详情 RH 布局 LIVE）。叠在市场 UX Comfy 导出/打开之上（further of market_ux）。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 市场 UX LIVE on core LAN（历史；进一步片→Comfy 二次编辑 LIVE；未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260907-064811-db3fa3e-dirty`；去分类；瀑布流 + Skeleton + 懒加载；高级引擎 → 更多引擎；封面 expand_top=40 生成中；Comfy 导出/打开已落地（完整二次编辑仍推进）。进一步市场 UX 片（叠在 UI P4 市场瀑布流/详情之上）。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 UI P4 市场瀑布流/详情 LIVE on core LAN（历史；进一步片→市场 UX LIVE；未 commit；无产品 SHA；产品树 dirty）**：已部署 core LAN；BUILD_ID `20260906-231138-69957d0-dirty`；市场瀑布流/详情。现见上条市场 UX LIVE（同族进一步片；新 BUILD）。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 UI P4 小程序主题对齐 web v9（历史；SUPERSEDED→市场瀑布流/详情已上 core；local_uncommitted_core_build_unchanged；未上 core；core BUILD 当时未变；未 commit；无产品 SHA）**：小程序主题对齐 web v9；本地未 commit；下一步曾为市场瀑布流/详情。现市场瀑布流/详情已上 core LAN（见上条 LIVE）。小程序主题对齐仍可能在本地 dirty 树中单独未 commit。

**2026-09-07 UI P3 封面 expand_top LIVE on core LAN（未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260906-225725-b22d0af-dirty`；封面 expand_top；主改 api。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 UI P2 库占位 LIVE on core LAN（未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260906-225725-b22d0af-dirty`；ThumbPlaceholder 按类型。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 UI P1 主题对比度 LIVE on core LAN（未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260906-225049-7588708-dirty`；cinema/graphite 暗色轨对比度修复。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 provenance 剥离 + Admin knowledge-graph LIVE on core LAN（未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260906-224852-921256b-dirty`；admin `GET /api/admin/knowledge-graph` 200（~1295 nodes / 608 edges；可选 `?entity=` neighborhood）；普通用户去 RH:{id}/civitai_url，管理员保留 provenance。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 provenance 剥离 + Admin knowledge-graph（历史；SUPERSEDED→on core LAN uncommitted；本地未 commit；当时部署中；无产品 SHA；非现网；AGENTS 当时未动）**：本地已加 provenance 剥离 + Admin knowledge-graph API；普通用户去 RH:{id}/civitai_url，管理员保留；未 commit、部署中；勿写已上 core / LIVE。现已上 core LAN（未 commit），见上条 LIVE on core LAN。

**2026-09-07 市场合并首片 LIVE on core LAN（未 commit；无产品 SHA；产品树 dirty；AGENTS 已按真机更新）**：已部署 core LAN；BUILD_ID `20260906-224447-8e33d9e-dirty`；api :8090 / web :3100 200；`GET /api/models/nsfw-recommendations` 无 `X-NSFW` → 403（verified）；资源区 R18 推荐仅 admin+R18；ModelsView 模型市场 Civitai|HuggingFace 切换。产品树仍 dirty，无独立产品 SHA。勿写已 commit / 已推。

**2026-09-07 市场合并首片本地已改（历史；SUPERSEDED→on core LAN uncommitted；无产品 SHA；未 commit；当时准备部署 core LAN；非现网；AGENTS 当时未动）**：资源区 R18 推荐仅 admin+R18；`GET /api/models/nsfw-recommendations` 无 `X-NSFW` → 403；ModelsView 模型市场 Civitai|HuggingFace 切换。工作区产品改动仍未提交。现已上 core LAN（未 commit），见上条 LIVE on core LAN。

**2026-09-07 core RH 家族预设累计 2226（目录可分类已清；剩 12 不可分类未种；无产品 SHA；非 builtin；AGENTS 未动）**：可分类目录已清；累计 2226；剩 12 不可分类未种。X-NSFW 可见。`rh_family_presets.json` 已更到 2226 但仍未提交；代码侧未提交 `rh_family_preset_seed.py` + `data/rh_family_presets.json` + env `TOIV_SEED_RH_FAMILY`（默认关）。等产品 SHA 后再加厚上线口径。

**2026-09-07 core RH 家族预设累计 1230（历史；计数已 SUPERSEDED→2226；+batch4 500，含 wan-animate 109；无产品 SHA；非 builtin；AGENTS 未动）**：pilot30 + batch2 200 + batch3 500（含 VACE 120）+ batch4 500（含 wan-animate 109）；累计 1230；约剩 996。X-NSFW 可见。`rh_family_presets.json` 已更到 1230 但仍未提交；代码侧未提交 `rh_family_preset_seed.py` + `data/rh_family_presets.json` + env `TOIV_SEED_RH_FAMILY`（默认关）。等产品 SHA 后再加厚上线口径。计数见上条累计 2226。

**2026-09-07 Embedding 迁 spark01 :9302 LIVE（设备管家确认；ToIV 开发；无产品 SHA；远程未推）**：Qwen3-Embedding-4B（GPU/cuda）@ `http://192.168.71.82:9302`；core `TOIV_EMBED_BASE_URL=http://192.168.71.82:9302/v1`；toiv-api 已重启；备份 `.env.bak-embed-20260907`；用户级 systemd Linger=no。WS embedding :9302 已停；**现网 Embedding 已迁 spark01 :9302（非 WS）**。此前「下一步 Embedding→spark01 intent」**DONE**。集群 SoT [AGENTS.md](AGENTS.md)。

**2026-09-07 core RH 家族预设累计 730（历史；计数已 SUPERSEDED→1230；+batch3 500；含 VACE 120；无产品 SHA；非 builtin；AGENTS 未动）**：pilot30 + batch2 200 + batch3 500（含 VACE 120）；X-NSFW 可见。`rh_family_presets.json` 已更到 730 但仍未提交；代码侧未提交 `rh_family_preset_seed.py` + `data/rh_family_presets.json` + env `TOIV_SEED_RH_FAMILY`（默认关）。等产品 SHA 后再加厚上线口径。计数见上条累计 1230。

**2026-09-07 core RH 家族预设累计 230（历史；计数已 SUPERSEDED→730；无产品 SHA；非 builtin；AGENTS 未动）**：pilot30 + batch2 200（Wan/LTX）；X-NSFW 可见。代码侧未提交 `rh_family_preset_seed.py` + `data/rh_family_presets.json` + env `TOIV_SEED_RH_FAMILY`（默认关）。等产品 SHA 后再加厚上线口径。计数见上条累计 730。

**2026-09-07 core 试点 RH 家族预设 30（历史；计数已 SUPERSEDED→230；无产品 SHA；非 builtin 全量；AGENTS 未动）**：Wan2.2→`wan-nsfw-i2v` 20 + LTX→`ltx-*` 10 已入库 core；LAN admin API，X-NSFW 可见。脚本 `apps/api/app/services/rh_family_preset_seed.py` + `.regen_tmp/seed_rh_wan_ltx_pilot.py`（工作区未提交 seed 文件）。等产品 SHA 或全量挂接后再加厚。计数见上条累计 230。

**2026-09-07 Spark LLM/VLM 真机+core 双切 Qwen3.8-27B（LIVE）**：设备管家 SSH 核实 — spark02 `vllm_node` @ `http://192.168.71.84:8000`，Qwen3.8-27B-NVFP4，served `qwen3.8-27b`（别名 `qwen3.6-uncensored`），max_model_len 32768；设备冒烟 ~15.4 tok/s；MemAvailable ~2.7Gi。双机 qwen38sg Flash-Next **Exited**；spark01 :8000 不再提供 LLM API（~117Gi free）；LiveKit 仍在 spark02。ToIV 开发：**core 已切** — `TOIV_LLM_*` / VLM 等 → `.84:8000` + `qwen3.8-27b`；toiv-api 已重启，LAN health 200；备份 `.env.bak-qwen27b-20260907`；core 路径冒烟 ~27 tok/s。Embedding→spark01 **DONE**（见上条 LIVE）。此前「意图未切 / Spark 保留 Flash-Next / core 路由改中」**SUPERSEDED**。集群 SoT [AGENTS.md](AGENTS.md)。

**2026-09-07 workstation 停非生图非视频常驻（设备管家快照；ToIV 开发执行；无产品 SHA；远程未推）**：已停并 disable FlashTalk / OpenTalking / LiveAct / FishS2 / JoyCaption 等数字人/口播及非生图非视频常驻（inactive）。现网保留 H3:8195、生图 gpu0-alt:8196、LongCat:8197、Animate2:8199、LB:8188。核对空闲约 G0 94G / G1 97G / G2 57G / G3 95G（GPU0/1/3 ≈ empty 94–97G；G2 仍 H3 ~57G free）。**口径更正**：ToIV 开发已停 WS 迁脑；**取消**「Flash-Next 迁 WS GPU0+3」（旧「WS GPU0+3 拟迁 Flash-Next / 切 core 后拆 spark Qwen」SUPERSEDED）。现架构意图：Spark **保留** Flash-Next（对话/LLM；Qwen3.8-Flash-Next）；Spark 承接可迁服务（Embedding/知识库/批标注等），算力单独用；ToIV 日产=WS+5090（5090=生图轻视频主池；WS GPU2=H3；现网 H3/8196/LB/longcat/animate2 不变）。spark02 LiveKit 仍保留（现网事实）。**NOTE**：Flash-Next TP2 已近吃满双 Spark 内存，迁服务前先量 free。集群 SoT [AGENTS.md](AGENTS.md)。

**2026-09-07 core 应用封面换 RunningHub 原卡面（无产品 SHA；数据侧已上 core；远程未推文档）**：rh-* 可靠对齐 499/499 已上传本地 appcover；内置非 rh 30/34 已换（跳过 `h3-multishot`、`ltx25-multishot`、`longcat-t2v`、`controlnet`，无可靠匹配）。映射落 MateBook `.regen_tmp/mapped_safe.json` 与 `.regen_tmp/builtin_cover_map.json`（未入库）。AGENTS.md 未动。大脑换 GLM 仍调研中、未切。

**2026-09-07 core VLM 改走 qwen3.8-flash-next（无产品 SHA；env 已上 core）**：deploy/.env 把 `TOIV_VLM_MODEL_ID` 与 `TOIV_EVAL_VLM_MODEL` 从 `qwen3-vl-32b` 改为现网 `qwen3.8-flash-next`；toiv-api 已重启，LAN health 200。LLM URL / Spark Qwen 未动。备份 `.env.bak-vlm-20260907`。AGENTS.md 未动。

**2026-09-07 P0 主题系统 v9（`19d65db`/`4d9e583`，已上线 core，产品 tip 已双推）**：产品 `19d65db`（四预设 minimal/cinema/paper/graphite + 自定义 accent；rh-dark 改消费主题令牌）；部署 tip `4d9e583`（含 UI 整改方案交接文档）。干净构建后 `bash deploy/deploy.sh`；core BUILD_ID `20260906-202535-4d9e583-dirty`（HTML `<!--20260906_202535_4d9e583_-->`）；api :8090 / web :3100 均 200。验证仅 core LAN `http://192.168.71.47:3100` 截图（禁公网穿透）；ThemePicker + 四预设 home/market + 自定义紫 accent + minimal dark 已拍，落 `/tmp/theme-prod/` 与 `.regen_tmp/theme-prod/`。纪律：后续验证只走本地或 core LAN，禁止打 toiv.wineryz.top。AGENTS.md 未动。市场合并（HF/RH/Civitai、去 R18 推荐、模型来源）尚未开工。本地核：origin/main 与 github/main 已是 `4d9e583`。

**2026-09-06 beijing SSH 公钥已通（设备管家）**：MateBook 已装 id_ed25519 公钥；~/.ssh/config 有 Host beijing → 8.140.222.24 User root IdentityFile ~/.ssh/id_ed25519；BatchMode 免密已通。密码不入文档。集群 SoT AGENTS.md。

**2026-09-06 beijing 设备表回写（设备管家只读 SSH；项目管家文档）**：真机只读登入 8.140.222.24（hostname `iZ2ze325an97cwlbt1wxfdZ`）后回写 AGENTS.md 设备表与 §五域名双入口。Ubuntu 24.04.4 LTS；1.6Gi RAM 无 swap；40G 盘约用 15%；角色确认 CN 入口 toiv.wineryz.top（OpenResty+ACME）；Docker `1Panel-openresty` + `1Panel-frps`（frps 0.68.1）听 7000/7500/13100/18090，另有 `1panel-core` :1722；SSH（当时公钥未通，现已通）root 密码可登、MateBook 默认 id_ed25519 公钥不行、~/.ssh/config 尚无 beijing Host。未改服务；**密码不入文档**；Tailscale 仍为 —（未发明）。集群 SoT `AGENTS.md`。

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
