# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手反复犯同样的错误，每次会话必须先读本文件
> **维护者**：设备管家（AI Assistant）
> **最后更新**：2026-09-11（项目管家：Int/Preview 修复 dirty 部署上 core；复测进行中）：**Int Number + Preview-only 修复已 dirty 部署上 core** — Int Number normalization + Preview-only **does not** mark_done 已经 `deploy.sh --skip-web` 上 core；**未** git commit（dirty deploy only）；`apps.py` / `tracker.py` sha 已核（真源 `.regen_tmp/app_test_matrix_p0/deploy_int_tracker.md`：apps=`21f1acf7…` tracker=`ae3fc155…`；**勿 stage**）；`140266` / `116926` 复测 **进行中**；前置 tip `1e94140` 残差根因现已 dirty deploy 落地；**禁止**标 shipped/online；产品码仍 dirty 勿 stage；无产品 SHA；本地 tip 无 push；status=`live_on_core_dirty_int_preview_fix_retesting`；STATE `l2_int_preview_dirty_deploy_2026_09_11`；`updated_at` 2026-09-11T02:31:00+08:00；via ToIV 开发 tip；此前 2026-09-11（项目管家：L2 RH 残差根因；Int→Number；Preview 误 mark_done；将 dirty deploy）：**L2 RH 残差根因 FYI** — （1）ComfyLiterals **Int** 必须为 **`Number`**（校验）；（2）**Preview-only** 误 **`mark_done`**；产品改动已落地但 **未 git commit**，将 **dirty deploy**；`140266` 仍缺 `yolov10m` / `vitpose` + 权重需 **`Wan22Animate/`** 前缀；真源 `.regen_tmp/app_test_matrix_p0/l2_rh_residual_notes.md` **勿 stage**；前置 tip `1eaa34e`：002481 PASS；140266 无产物；116926 Int Number + Wan2_2-Animate-14B_fp8…KJ 缺；**禁止**标 shipped/online；产品码仍 dirty 勿 stage；无产品 SHA；本地 tip 无 push；status=`live_on_core_l2_rh_residual_rootcause_pending_dirty_deploy`；STATE `l2_rh_residual_rootcause_2026_09_11`；`updated_at` 2026-09-11T02:29:00+08:00；via ToIV 开发 tip；此前 2026-09-11（项目管家：10-class 后复测；002481 PASS；140266 无产物；116926 仍缺）：**10-class 后 L2 复测** — `002481`（短 id；AGENTS 已有全 id `rh-acc-0024814594-adc75c`）**PASS**；`140266`（`rh-acc-1402669058-f27871`）job 成功但 **无产物/无输出**；`116926`（`rh-acc-1169267714-43e935`）仍缺 **Int Number** 校验 + 缺权重 `Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors`；真源 `.regen_tmp/app_test_matrix_p0/l2_retest_after_10class.json` **勿 stage**；已交 **模型下载** / **设备管家**；**禁止**标 shipped/online；产品码仍 dirty 勿 stage；无产品 SHA；本地 tip 无 push；status=`live_on_core_l2_retest_after_10class`；STATE `l2_retest_after_10class_2026_09_11`；`updated_at` 2026-09-11T02:19:00+08:00；via ToIV 开发 tip；此前 2026-09-11（项目管家：Easy/SDVN 后复测；3 RH 仍 fail；新缺 10 class）：**Easy-Use+SDVN 后 L2 复测** — **3** 张 RH 卡仍 fail；新缺 **10** class_type：`JWInteger` / `rgthree Any Switch` / `GoogleTranslate` / `LayerMask SAM Ultra V2` / `Int` / `SAM2×2` / `GetImageSize+` / `MathExpression|pysssss` / `PlaySound|pysssss`；真源 `.regen_tmp/app_test_matrix_p0/l2_retest_after_easy_sdvn.json` **勿 stage**；已交 **设备管家** 一次性安装；**禁止**标 shipped/online；产品码仍 dirty 勿 stage；无产品 SHA；本地 tip 无 push；status=`live_on_core_l2_retest_after_easy_sdvn`；STATE `l2_retest_after_easy_sdvn_2026_09_11`；`updated_at` 2026-09-11T01:43:00+08:00；via ToIV 开发 tip；此前 2026-09-11（设备管家：LIVE — LongCat :8197 链入 Easy-Use + SDVN；三 class Y）：**LongCat :8197 又链入** `ComfyUI-Easy-Use` + `SDVN_Comfy_node`；三目标 class **Y**（`SDVN Any Show` / `easy seed` / `easy positive`）；关闭 tip `defae10` / STATE `l2_retest_after_longcat_nodes_2026_09_11` 残差节点缺口；status=`live_device_fyi`；STATE `longcat_8197_easy_use_sdvn_2026_09_11`；`updated_at` 2026-09-11T01:40:00+08:00；via 设备管家 / 项目管家 tip；产品码仍 dirty 勿 stage；本地 tip 无 push；此前 2026-09-11（项目管家：LongCat 节点后 L2 复测；wan-animate PASS；新缺 SDVN/easy）：**LongCat 节点后 L2 复测** — **wan-animate PASS**（fixture 残差对该 app 已关）；此前缺节点的 3 张 RH 卡节点缺口已清；新缺 **`SDVN Any Show`** / **`easy seed`** / **`easy positive`**；真源 `.regen_tmp/app_test_matrix_p0/l2_retest_after_longcat_nodes.json` **勿 stage**；已交 **设备管家** 再装；**禁止**标 shipped/online；产品码仍 dirty 勿 stage；无产品 SHA；本地 tip 无 push；status=`live_on_core_l2_retest_after_longcat_nodes`；STATE `l2_retest_after_longcat_nodes_2026_09_11`；`updated_at` 2026-09-11T01:38:00+08:00；via ToIV 开发 tip；此前 2026-09-11（设备管家：LIVE — LongCat :8197 链入 Bjornulf/WanAnimatePreprocess/controlnet_aux；三目标 class Y）：**LongCat :8197 已链入** `Bjornulf_custom_nodes` / `WanAnimatePreprocess` / `controlnet_aux`；三目标 class **Y**（关 L2 残差节点缺口 Bjornulf_ShowFloat / PoseAndFaceDetection / PixelPerfectResolution）；wan-animate ffmpeg/fixture 残差仍开；status=`live_device_fyi`；STATE `longcat_8197_nodes_bjornulf_wananim_ctrlaux_2026_09_11`；via 设备管家 / 项目管家 tip；产品码仍 dirty 勿 stage；本地 tip 无 push；此前 2026-09-11（项目管家：L2 路由 dirty 部署；抽测4/4 improved、pass0）：**L2 路由 dirty 部署（非 git shipped）** — live_core 经 `deploy.sh --skip-web`（~01:27 CST）部署 L2 路由修复；**产品仍未 git commit**（dirty deploy only）；抽测 **4/4** `routing_improved=true`、**pass=0**；残差：缺节点 **3** class_type（Bjornulf_ShowFloat / PoseAndFaceDetection / PixelPerfectResolution）+ wan-animate ffmpeg/fixture（VHS 抽音失败）；真源 `.regen_tmp/app_test_matrix_p0/l2_retest_after_routing.json` **勿 stage**；已交 **设备管家** 装缺节点；**禁止**标 shipped/online（仅 dirty-deployed）；产品码仍 dirty 勿 stage；无产品 SHA；本地 tip 无 push；此前 2026-09-11（项目管家：L2 路由修复（分支未commit；pytest52；抽测中））：**L2 路由修复（未 commit / 非 shipped/online）** — 分支 `feat/app-guides-admin-cms`（uncommitted）；`_pick_app_client` 识别 **WanVideo*** → 专池；`/run` + upload media 与 graph **同机**；pytest routing/upload/apps：**52 passed**；正部署抽测原 **503** 卡；残差：LongCat 缺权重；nunchaku 溢出；pulid EOF；无 LTX 专池；下一步：**抽测原 503 卡**；产品码仍 dirty 勿 stage；勿 stage `.regen_tmp`；无产品 SHA；本地 tip 无 push；此前 2026-09-11（项目管家：P0 L2 热门24 pass8/fail_product15/timeout1）：**P0 L2** 热门 **24** — pass **8** / fail_product **15** / fail_timeout **1**；pass：h3-i2v / t2v / fl2v / i2v-15s-fast / txt2img-basic / img2img-basic / wan-animate-2 / qwen-image-edit；主因：市场卡未钉专池 → 通用池 **503**；H3 upload 默认不上 **:8195**；真源 `.regen_tmp/app_test_matrix_p0/l2_summary.json` **勿 stage**；产品实现仍未 commit；**非 shipped/online**；下一步：开发修路由/上传对齐；产品码仍 dirty 勿 stage；此前 2026-09-11（项目管家：P0 L0 实测 550/550 pass）：**P0 L0** 完成 — **550/550 pass**（全部公开 apps）；纠正 tip `ae2b868` 所写 P0 L0=`in_progress` → `pass`/`done`；产品实现仍未 commit；更广路线图**非 shipped/online**（仅 L0 结果完成）；P1/P3/P2 仍 planned；产品码仍 dirty 勿 stage；此前 2026-09-11（项目管家：拍板 P0实测→P1说明卡→P3扩展Admin→P2说明书KG）：用户确认全序 — **P0** 分级实测 → **P1** 应用说明卡（用法/作用）→ **P3** 万能管理台（**扩展现有 Admin**，非另起后台）→ **P2** 说明书知识图谱；~~tip `ae2b868` 曾写 P0 L0=`in_progress`~~ 已纠正；**非 shipped/online**（产品实现未 commit）；旁证：AdminView 现仅 users/agents/audit；最小 KG `GET /api/admin/knowledge-graph` ≈1295 nodes / 608 edges、无 howto；公开 apps ≈**550**（video359/image189），描述短 p50≈40 chars；产品码仍 dirty 勿 stage；此前 2026-09-10（项目管家：capability_gap closeout（公开550；误藏×2已放回））：用户目标「能做全做、做不到隐藏、核验公开可用」已完成 — closeout 核验后 soft-hide×3（含 2×fetch_error 误藏 + 1×blocked `rh-acc-6076858369-17c38d`）公开 **551→548**；v23 对照 NO_DELTA soft-hide；恢复误藏×2（`rh-acc-3038288898-fe20f8`、`rh-acc-8206083073-eb11b5`）→ 公开 **550**；公开集 public_not_ok=0（main OK / dedicated_aware）；still_waiting **42** 全 hard_blocked 保持隐藏；公开侧通用池缺节点 **0**；dedicated_h3 optional×8 按既往 skip；硬阻保持隐藏：42 + `17c38d`；真源 `.regen_tmp/capability_gap_closeout_20260910/` + `capability_gap_scan_v23/CLOSEOUT.md` **勿 stage**；本轮能力缺口扫描待命结束；产品码仍 dirty 勿 stage；此前 2026-09-10（项目管家：v22 unhide ×4 + v22b Animate Q4（546→550→551））：ToIV 开发生产已落地 — v22 unhide **4**（`is_public=true`）`rh-acc-1099076609-5b577d` / `rh-acc-9943753729-f90502` / `rh-acc-3915150338-73e61b` / `rh-acc-4551318530-b94c9f` → 公开约 **546→550**；v22b unhide **1** `rh-acc-7233807361-883e22` Animate Q4 GGUF（换装+换脸+换背景- Animate Wan2.2）→ **550→551**；主 OK 扫侧 **457**（:8196 已恢复）；产品码仍 dirty 勿 stage；此前 2026-09-10（项目管家：通用池 extrapaths 补 `unet: unet`；Animate GGUF 走 UnetLoaderGGUF）：设备管家通用池 toiv extrapaths 已补 `unet: unet`；Animate GGUF 以 **UnetLoaderGGUF** 为准可见；旁注**未落地**：能力缺口已交 v22 unhide **4** 给开发；扫时 :8196 拒连致主 OK 偏低；Animate Q4 `mount_pending`；完整 unhide 数字等 ToIV 开发生产回报再定；产品码仍 dirty 勿 stage；此前 2026-09-10（项目管家：MODEL_SOURCES v21 P0 后 ok**464**/blocked**335**/total**799**（去重））：ToIV 模型下载 v21 P0 general-pool；newly_ok **4** ≈**32.00** GiB（Wan2.2-Fun-A14B-InP-low-noise-MPS / flux-2-klein-base-4b / QwenRebalanceV10_v10LoraR64 / wan2.2-i2v-rapid-aio-nsfw-v7）；already_on_nas **1**（Wan2.2-Animate-14B-Q4_K_S.gguf）；本批 blocked **40**；前 tip **467/343/810** → **464/335/799**（去重后净变 Δ ok−3/blocked−8/total−11）；真源 `.regen_tmp/capability_gap_v21_p0_models_download_summary.json` **勿 stage**；未写 h3/；产品码仍 dirty 勿 stage；此前 2026-09-10（项目管家：v20 fill节点≈27/30class + MODEL_SOURCES 467/343/810 + v21 unhide×36 →546）：设备管家通用池 v20 fill 节点包约 **27**、三机齐 **30** class_type（明细以设备→开发为准，勿编造包名）；MODEL_SOURCES v20 unhide 后 ok**467**/blocked**343**/total**810**（newly_ok**2**≈51.23GiB；摘要勿 stage）；capability_gap_scan_v21 批量 unhide **36**（P0 nodes→OK **6** + 另 **30**）公开约 **510→546**；仍等下载 **47** / 仍缺节点 **27**；真源 unhide_ready_after_v21 勿 stage；产品码仍 dirty 勿 stage；此前 2026-09-10（项目管家：animate2 unhide 已落地 **508→510**；admin soft-hide 可再上架（core `--skip-web`×2 已落地；产品码仍 dirty 待 commit）— admin `_visible`+PUT 再上架（seed 不覆已有 is_public）；animate2×2 `wan-animate-2`+`rh-character-replacement-minimax-h3-7582cc8e` **已 unhide**（非待办）；重启误开 avatar-talk/facedetailer/hunyuan-i2v/latentsync 已再 soft-hide；通用 P0 **80** 仍等 fill（`unhide_after_fill_p0.json`）；v20 dedicated_aware 已并 animate2 → **512**（H3=510 + animate2=2）；真源 `dedicated_aware.json`+`dedicated_aware_animate2_v20.json` 勿 stage；v21+ 必跑 animate2 postprocess；产品公开约 **510**；此前 项目管家：mass soft-hide unusable v20 ×**388**（用户拍板只留能用）；清单 hide**398**/新藏~**388**；生产 soft-hide **388**；公开约 **896→508**；keep=main_ok∪ok_if_dedicated_h3=**510**（API list_len 510，含 2 张非公开 keep）；真源 `.regen_tmp/.../soft_hide_all_non_usable_v20.json` + `soft_hide_all_unusable_v20.json` **勿 stage**；验收 `post_soft_hide_verify_v20` **ok**：公开 **508** ⊆ keep **510**；漏网 **0**；不全量 v21；此前 项目管家：soft-hide hard-block-only v20 ×**10**（仅硬阻、无缺节点）公开约 **908→898**；短 id 511ac0 dc3518 bd7f4d 6244b3 2babaa 15deeb 0b9198 f7ba44 615ed6 7fa928；不扫 v21；Gitee main `dae4ee8`；GitHub 仍不可达；此前 项目管家：capability_gap_scan_v20 OK**245**（持平 vs v19）；dedicated-aware **510**（0）；apps **908**（−1 soft-hide ef8fd7，对齐 02737db）；blocked **663**；主 OK 持平；等长尾或产品拍板再扫；worker ≈**838**/822/822；此前 项目管家：soft-hide `rh-acc-1004064770-ef8fd7`（Z-image真实感-电商高清文生图；UltimateSD 已清；仅缺 beyondREALITYZIMAGE）公开约 **909→908**；更新 24ae742「勿藏」口径；此前 项目管家：capability_gap_scan_v19 OK**245**（+1 vs v18）；dedicated-aware **510**（+1）；apps **909**（post soft-hide 8851286018）；blocked **664**；已清 Remix high/low + moodyRealMix + BEYOND；UltimateSDUpscale 清（node gap）；worker ≈**838**/822/822；此前 项目管家：MODEL_SOURCES v17 长尾齐 ok**465**/blocked**339**/total**804**；newly_ok≈**49.55** GiB（Wan Remix high+low / moodyRealMix / BEYOND 淡妆浓抹）；`beyondREALITY_beyondREALITYZIMAGE` **blocked**（勿冒充淡妆浓抹 BF16）；soft-hide `rh-acc-8851286018-43497c` 市场约 **910→909**；勿藏 `rh-acc-1004064770-ef8fd7`；未写 h3/；主池 UltimateSDUpscale ssitu@a5547db9（Coyote-A@2322caa；无 pip）；此前 项目管家：capability_gap_scan_v18 OK**244**（持平 vs v17）；dedicated-aware **509**（0）；apps **910**；blocked **666**；已清 BEYOND REALITY SUPER Z IMAGE 3.0 淡妆浓抹 BF16（complete；仍不抬主 OK）；worker ≈**838**/822/822；此前 MODEL_SOURCES BR BF16 ok**462**/blocked**342**/total**804**（Δ+1/−1 vs 0f6a0a4）；`BEYOND REALITY SUPER Z IMAGE 3.0 淡妆浓抹 BF16.safetensors` → `diffusion_models/` ≈**11.46** GiB；自 v16 长尾续下已落地；未写 h3/；此前 项目管家：capability_gap_scan_v17 OK**244**（+2 vs v16）；dedicated-aware **509**（+2）；apps **910**（post soft-hide）；blocked **666**；已清四枚长尾 LoRA：SESELAORUYAO / DarkKlein9b_v2BFS_extracted_lora_r256 / Kook_Qwen_V3极致真实 / Kook_Zimage_如梦似幻；worker ≈**835**/819/819；此前 MODEL_SOURCES v16 非 H3 ok**461**/blocked**343**/total**804**（Δ+4/−4 vs 7617fd4）；newly_ok **4** ≈1.94 GiB；already_on_nas **10**；BEYOND REALITY 续下中未计入；未写 h3/；此前 项目管家：soft-hide blocked-only **12** → `is_public=false`；市场约 **922→910**；此前 capability_gap_scan_v16 OK**242**（持平 vs v15）；dedicated-aware **507**（0）；apps **922**；blocked **680**；已清 flux1-redux + 紫灵/韩立/宋玉；worker ≈**830**/814/814；此前 MODEL_SOURCES v15 非 H3 ok**457**/blocked**347**/total**804**（Δ+3/−3 vs 2f104c9）；此前设备管家：三机 extrapaths 补 style_models；8196/8188/8193 均 **2**=flux1-redux-dev+flex1_redux_siglip2_512；解 v15 假缺；等 v15 下载批次后扫 v16；此前项目管家：capability_gap_scan_v15 OK**242**（+7 vs v14）；dedicated-aware **507**（+7）；apps **922**；blocked **680**；gimmvfi **三端已清**（含:8193）；此前 MODEL_SOURCES v14 非 H3 ok**454**/blocked**350**/total**804**（Δ+7/−7 vs d2816ac）；此前 capability_gap_scan_v14 OK**235**（+11 vs v13b）；dedicated-aware **500**（+9）；apps **922**；此前 ToIV 开发：H3 T8后侧扫旁证 h3_ok**212**/still**55**；别名**265**/2 + soft-hide→公开954；此前设备管家：H3:8195 T8/blockcache/KJNodes/vrgamedevgirl **装齐** — 仅 h3-eval，未进通用池；此前：生图池 Comfy FE 齐套 **1.52.7** — WS/pc01/pc02/LB:8188；哈希去重 soft-hide**243**/kept85/del0，市场 2163→**1920**，rh-acc 949→**706**；渐变假封面 UX **114→0**；H3 未动；三项用户决策均完成；~~pc01 待升 1.52.7~~ SUPERSEDED；~~1.45.x 分裂~~ SUPERSEDED for gen-pool FE）
> **读取规则**：每次会话开始时必须完整阅读本文件，尤其注意「⚠️ 易错点」和「🔒 硬性规则」
> **历史归档**：2026-08-21~09-03 全部变更叙事（含回归数据/生产实证细节）见 `.archive/AGENTS-full-20260903.md`，本文件只留活口径

---

## 〇、🔒 硬性规则（每次会话必读）

### 规则一：所有后端服务都来源于 Workstation

> 所有 AI/算力后端服务（ComfyUI/LB、H3、LongCat、Animate2 等生图/视频主路，以及历史上的 IndexTTS2.5、ASR、Embedding、LiveAct、FlashTalk、OpenTalking、JoyCaption 等）来源均在 Workstation(192.168.71.127 / 100.68.100.90)上（**2026-09-07 起数字人/口播等非生图非视频常驻已停 disable，现网保留见第三节**）。
>
> - core(192.168.71.47)只跑 ToIV web/api + PostgreSQL/Redis，是业务网关，不是算力来源
> - 本机 Mac 只是操作终端；配置里的 `127.0.0.1`/`localhost` 地址只是本地 dev 兜底，**真机排查一律先查 Workstation**
> - 排查「服务离线/引擎不可达」时，第一反应必须是 SSH 到 Workstation 查 systemd 状态和端口监听，禁止臆断服务不存在

### 规则二：文档仅供参考，必须真机验证

> AGENTS.md、STATE.json、TEST_LOG.md 等所有文档都仅供参考，不能替代真机验证。
>
> - 凡涉及 GPU 显存、服务状态、端口监听、文件路径、挂载状态、模型占用、硬件配置等问题，必须先 SSH 执行真实命令（`nvidia-smi`、`systemctl status`、`ss -tlnp`、`mountpoint`、`df -h`、`free -h` 等）后再作答
> - 文档与真机输出冲突时，**以真机输出为准**，并据此修正文档
> - 禁止凭记忆、文档或臆测回答容量/状态/可用性类问题
> - **「已停用/已退役」类记录尤其要复核：stop 不等于 disable，主机重启后 enabled 的服务会自动复活（2026-08-23 ltx25 实证）**

---

## 一、集群设备清单（13 组）

| 设备 | 角色 | LAN IP | Tailscale IP | 类型 | SSH 用户 |
|---|---|---|---|---|---|
| ~~studio01-04~~ | **2026-08-29 全线下线退役**（EXO :52415 全超时，fleet_registry 已移除；L2/L3 LLM 收拢 spark02） | .109/.111/.112/.113 | 100.67.43.40 / 100.91.0.121 / 100.115.27.68 / 100.126.182.23 | Mac Studio M3 Ultra 512GB | dgmt-studio01-04 |
| openclaw01-04 | OpenClaw 网关 :18789 均 200（2026-08-28） | .86/.75/.81/.85 | **100.115.23.67** / 100.76.35.7 / 100.76.140.121 / **100.125.217.11**（01/04 以 TS 2026-08-27 为准，旧 100.69.0.4 / 100.91.128.30 作废） | Mac mini M4 16GB (hw.model=Mac16,10) | dgmt-openclaw01-04 |
| spark01 | **GLM-5.3-Flash TP2 worker（rank1）**：`vllm_glm53` 容器，与 spark02 组 200GbE RAIL 集群（192.168.200.13；RAIL 密钥已修，spark02→本机 RAIL SSH 免密 ✓）。**LIVE Embedding**：Qwen3-Embedding-4B @ :9302（GPU）；core `TOIV_EMBED_BASE_URL=http://192.168.71.82:9302/v1`；用户级 systemd Linger=no。旧 qwen38sg/Qwen3-VL/molmo2 容器保留 Exited。 | .82 | 100.81.235.124 | Linux GB10 | dgmt-spark |
| spark02 | **现网 LLM/VLM API**（2026-09-10 切换）：`vllm_glm53` @ :8000 — **GLM-5.3-Flash EXL3-4bpw TP2**（双 Spark 200GbE RAIL，DFlash2 推测解码，KV=fp8_ds_mla），served `glm-5.3-flash` + 别名 `qwen3.8-27b`/`qwen3.6-uncensored`（core .env 零改动），max_model_len **524288**；实测 17.4 tok/s（500tok 精确），工具调用/视觉 ✓，core 路径 ✓。旧 `vllm_node`（Qwen3.8-27B-NVFP4）已 stop 保留回滚（`docker start vllm_node`）。LiveKit 栈仍在。启动方式：`~/launch-glm53-vllm-tp2.sh 1`(worker)→`0`(head)，重启后需手动拉起（restart=no）。 | .84 | 100.86.42.89 | Linux GB10 | dgmt-spark |
| workstation | 算力+全部后端服务 | 192.168.71.127 | **100.68.100.90** | Linux 4×RTX PRO 6000 | merlin |
| pc01 | ComfyUI worker :8188 | **192.168.71.116**(08-25 DHCP 漂移,MAC 指纹实证) | 100.69.134.27 | Windows RTX 5090 | home |
| pc02 | ComfyUI worker :8193 + 编辑实例 :8194；**TS≠LAN**：LAN 均 200（08-28），⚠️ Tailscale 08-27 离线 21d | 192.168.71.114 | 100.107.94.26 | Windows RTX 5090 | w |
| NAS | SMB 存储 44T | 192.168.71.7 | 100.80.237.96 | Linux | dgmt-nas |
| 小米路由器 | BE10000 Pro,**AP/有线中继模式**(08-26 切换),管理页 192.168.71.42 | 192.168.71.42 | — | — | — |
| 光猫 | 主网关/拨号(MAC 7c:c9:26:ef:01:93) | 192.168.71.1 | — | — | — |
| cloud | 香港网关/frps/OpenResty | 43.119.32.180 | 100.83.78.114 | Linux | root |
| core | **ToIV 生产服务器**(web :3100 + api :8090 + PG + Redis)；:8100/:3501 未监听（AIGCPannel 在 MateBook Colima :8080/:8100） | 192.168.71.47 | **100.77.80.100** | Ubuntu | merlin |
| beijing | **CN 入口** toiv.wineryz.top（OpenResty+ACME）；hostname `iZ2ze325an97cwlbt1wxfdZ`；Docker `1Panel-openresty` + `1Panel-frps`（frps 0.68.1）听 7000/7500/13100/18090，另有 `1panel-core` :1722；1.6Gi RAM 无 swap；40G 盘约用 15% | 8.140.222.24 | — | Ubuntu 24.04.4 LTS（阿里云） | root |
| MateBook | 操作终端 | **192.168.71.9**（2026-08-28；~/NAS 已挂） | 100.74.15.34 | macOS | 本机 |

> 🔒 跨地区访问原则(2026-08-23):**浏览器侧直连一律 Tailscale 优先**(画布 iframe 100.68.100.90:8188、工作流 :8189,LAN 地址仅回退候选);core→workstation 服务间调用保留 LAN(共址直连快)。

---

## 二、关键凭据（禁止再次询问）

| 服务 | 用户名 | 密码 | 备注 |
|------|--------|------|------|
| NAS SMB | dgmt-nas | Aki.19950108 | 192.168.71.7，共享名 NAS |
| Tailscale Auth Key | — | tskey-auth-kPM5hHvNGY11CNTRL-UTn8rtRjK8Pfw3riNoGB8Pru71VhdRR9C | 已用于 core 授权 |
| ToIV admin | admin | admin123 | 生产 core |

**NAS 挂载**：
- Linux(Workstation)：fstab 自动挂载 `/home/merlin/nas_mount`，凭据 `/root/.smbcredentials`；**每次 workstation 重启后必须 `mountpoint /home/merlin/nas_mount` 核实**
- Windows(PC01/02)：`cmdkey /add:192.168.71.7 /user:dgmt-nas /pass:Aki.19950108` + SYSTEM session 自挂 Z:（见易错点 W-2）

---

## 三、Workstation GPU 分配（🔒 启动服务前必须核对）

> 显存数字为快照,**动态变化,容量规划前必须重新 `nvidia-smi`**(H-2)。RAM 总量 183G:多引擎并跑前必须 `free -h` 查 available(H-3)。

| GPU | 服务 | 端口 | systemd |
|-----|------|------|---------|
| GPU0 | **现网常驻** ComfyUI gpu0-alt(cache-lru 8) / LongCat(cache-lru 3) ；~~JoyCaption / IndexTTS2 / CosyVoice2 / hy3dtex~~ 等非生图非视频常驻已停 disable（2026-09-07） | :8196 / :8197 （停用端口见近期变更） | comfyui-gpu0-alt / comfyui-longcat（joycaption/tts/hy3dtex 等已停） |
| GPU1 | ~~LiveAct / embedding / 超分 / Hunyuan3D~~ 等非生图非视频常驻已停 disable（2026-09-07）；现网无生图视频常驻 | — | units disabled |
| GPU2 | **现网常驻 MiniMax H3**（UUID 钉卡）；~~ASR/音频/InfiniteTalk/Fish S2~~ 等已停 disable（2026-09-07） | :8195 | toiv-comfyui-h3 |
| GPU3 | **现网常驻 Wan-Animate-2**；~~FlashTalk / OpenTalking / 超分 / i2L~~ 等已停 disable（2026-09-07）；LTX-2.5 仍退役 | :8199 | comfyui-wan-animate-2（Wan-Animate-2 :8199） |

**ComfyUI-LB 后端**（3 后端）：本地 **:8196**(GPU0,`comfyui-gpu0-alt` 已转正;:8189 退役,见 H-7) + pc01 :8188 + pc02 :8193。GPU1/2/3 不入 LB 池（专用实例 :8197/:8195/:8199/:8201/:8261-8263 均专用;每新增同机专用实例必须补 `deps.resolve_worker()` 精确匹配,见 E-1）。

**2026-09-07 现网保留集合**：H3:8195 / gpu0-alt:8196 / LB:8188 / longcat:8197 / animate2:8199。空闲约 G0 94G / G1 97G / G2 57G / G3 95G（设备管家核对；停服后 GPU0/1/3 ≈ empty 94–97G，G2 仍挂 H3 故 ~57G free）。

**🔒 池后端变更操作口径(2026-09-03 起,动态化已上线)**：改 ComfyUI 池后端**只编辑 workstation `/opt/comfyui-lb/backends.json`**——LB 每 5s 查 mtime 热重载(零重启、不丢 prompt_map),`GET :8188/admin/backends` 返回清单+健康;ToIV api 池按 `TOIV_COMFY_WORKERS_REGISTRY_URL`(core env 已配)60s TTL 自动跟随(回环地址自动改写到注册表主机);`TOIV_COMFY_WORKERS` env 静态列表仅作 LB 挂掉时的兜底。**禁止再直接改 core env 切池成员、禁止改 LB 源码切后端**(源码内置列表仅为文件缺失时的兜底)。AIGCPannel local_gateway 上传扇出同样惰性拉取 /admin/backends。

**超分 fleet**：:8261/:8262/:8263 三卡并行 4x-UltraSharp 帧超分,由融合超分链/`scripts/ops/video_4k_upscale_parallel.py` 调用。

**关键服务路径**：ComfyUI=/opt/ComfyUI(venv) · IndexTTS2=/home/merlin/index-tts · H3 实例=/home/merlin/ComfyUI-h3-eval（09-03 ComfyUI 0.34.0 git a87667f，含 #15439 MiniMaxH3AddGuide；ImageToVideo/ReferenceToVideo 仍在；INT8/Turbo 未重下） · LongCat=/home/merlin/ComfyUI-longcat · LTX2.5=/home/merlin/ComfyUI-ltx25 · JoyCaption=/opt/toiv-joycaption(transformers 直跑,勿用 vLLM) · pynvml 锁扇用 /opt/nemotron-venv/bin/python · hy3dtex=/home/merlin/toiv-hy3dtex(torch 2.13+cu130) · Hunyuan3D=/home/merlin/ComfyUI-hunyuan3d

**散热政策(2026-08-16 用户拍板)**：🔒 **无软件温度熔断**——GPU 自降频即保护,生产禁止以温度为由中止任务;锁扇(fan_guard.py 常驻 /tmp,⚠️ tmpfs 重启即清须重传)是吞吐优化;仅持续 ≥95°C 才人工介入。BIOS 机箱风扇已满速(08-23)。

---

## 四、NAS 模型路径

| 路径 | 内容 | 大小 |
|------|------|------|
| `NAS/Windows/ComfyUI/ComfyUIModel/models` | 主模型库(workstation /opt/ComfyUI/models 指向此处的 symlink) | 524GB+ |
| `NAS/toiv/comfyui-models` | ToIV 专用模型 | ~260GB |

PC01/02 的 `extra_model_paths.yaml` 指向 `Z:/Windows/ComfyUI/ComfyUIModel`（**不得含 custom_nodes 键**,会启动报错）。

**H3 Ref2VA 权重（2026-09-07 MateBook NAS 核实）**：
- bf16 LIVE：`NAS/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_bf16.safetensors`（66280487368 bytes ≈62GiB；MateBook `/Users/wangzhenyu/NAS/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_bf16.safetensors`；workstation 通常 `/home/merlin/nas_mount/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_bf16.safetensors`）
- 同目录 INT8 已有：`NAS/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors`
- **仍缺**：`minimax_h3_ref2va_pruned_bf16`（勿把 NAS/#recycle 未完成 aria2 副本当 live）
- 设备管家：已完整落盘；H3 无需为下载重启

---

**模型/内容下载来源清单（稳定路径；2026-09-08）**：
- 仓内正式清单：`docs/MODEL_SOURCES.md`（人读）+ `docs/MODEL_SOURCES.json`（机读）。**根目录五件套不变**，勿在仓库根新增 `MODEL_SOURCES*`。
- 用途：每次模型/内容下载维护带来源的条目（HF / Civitai / RH / 本地），供更新核对与查文档。
- 维护：ToIV 模型下载；项目管家五件套只引用本路径。WIP 草稿放 `.regen_tmp/`，就绪再落入 `docs/`。
- **不**替代 `engine_registry` / `model_wiki` / admin knowledge-graph / `model_profiles`；清单指向 NAS 落盘路径 + 出处 URL。
- STATE `model_sources_inventory_convention_2026_09_08` → `model_sources_inventory_2026_09_08`：**ok 411 / blocked 376 / total 787**（updated `2026-09-08T18:17:37+08:00`；capability_gap_v3_v4；前 381/384/765）；清单在 docs，持续追加。

## 五、Core 生产状态（活口径）

- **服务**：toiv-api :8090 / toiv-web :3100 systemd 常驻,`deploy/deploy.sh` 部署;PostgreSQL 18 / Redis 真机运行（仅 bind 127.0.0.1，探测用回环地址）。
- **域名双入口**：toiv.dgmt.top(香港 cloud,frp-kcp) + toiv.wineryz.top(**beijing CN 入口** OpenResty+ACME；Docker `1Panel-openresty` + `1Panel-frps` 0.68.1 听 7000/7500/13100/18090，另有 `1panel-core` :1722);openresty → frp 本地 127.0.0.1:18090/13100。
- **引擎矩阵拍板(08-21)**：R18=Wan2.2+LTX2.3;H3 全面替代 LTX2.5;RAM OOM 根治(MemoryMax/排队误杀修复)。
- **LLM/VLM（2026-09-10 LIVE：GLM-5.3-Flash 上位，qwen3.8-27b 退役保留回滚）**：`TOIV_LLM_*` / VLM 等仍指向 spark02 `http://192.168.71.84:8000`（`/v1`），**core .env 零改动**——GLM 以 served 别名 `qwen3.8-27b`/`qwen3.6-uncensored` 兼容承接。容器 `vllm_glm53`（EXL3-4bpw 320B MoE/18B 激活，TP2 跨 spark01+02 200GbE RAIL，DFlash2 推测解码），max_model_len **524288**（旧 32768 的 16 倍，69k 历史超窗压缩超时问题自然消除）。实测：500tok 精确 17.4 tok/s、工具调用 ✓、视觉 ✓、core 路径 ✓。旧容器 `vllm_node`（Qwen3.8-27B-NVFP4）已 stop 留存，回滚：`docker stop vllm_glm53 && docker start vllm_node`。历史：2026-09-07 曾切 qwen3.8-27b；备份 `.env.bak-qwen27b-20260907` 仍有效。
- **Embedding（2026-09-07 LIVE @ spark01 :9302）**：Qwen3-Embedding-4B（GPU）@ `192.168.71.82:9302`；core `TOIV_EMBED_BASE_URL=http://192.168.71.82:9302/v1`；toiv-api 已重启；备份 `.env.bak-embed-20260907`；用户级 systemd Linger=no。设备管家确认 LIVE（cuda）；**现网 Embedding 非 workstation :9302**。此前「下一步 Embedding→spark01 intent」**已完成**。
- **视频评分器灰度**：`TOIV_VIDEO_SCORER_ENABLED=true`(阈值 0.65,timeout 120s);⚠️ 迁移 DDL BOOLEAN 默认值必须 TRUE/FALSE,PG 不认 DEFAULT 0。
- **web_search 代理**：`TOIV_WEB_SEARCH_PROXY=http://192.168.71.9:7897`(MateBook Clash;依赖 Mac 在线,离线自动降级)。
- **workstation 常驻 ToIV 服务**：trainer :9100 / lipsync :9103 / 3dops :9402 / scope :9401 / sysmetrics :9403 等仍在清单；**2026-09-07 数字人/口播及一批非生图非视频常驻已停 disable**（FlashTalk / OpenTalking / LiveAct / FishS2 / JoyCaption 等 inactive，含 joycaption :9304 / liveact :9400 / embedding :9302 / hy3dtex :9404 / i2l :9101 等）。WS embedding :9302 已于 09-07 停；**现网 Embedding 已迁 spark01 :9302**（非 WS）。现网生图/视频保留见第三节（H3/gpu0-alt/LB/longcat/animate2）。勿再声称 joycaption/liveact 仍常驻。
- **数字人 M1–M6 已上线**（形象库/TTS 直通/ASR→SRT/LatentSync 对口型/直播助手/绿幕抠像）;**音频编排** tts/separate/concat/mix/variant 可用,sfx 仍 501(选型 MOSS-SoundEffect v2.0)。
- **内容限制管控已下线零残留**(08-23 用户拍板自行重做;未成年硬阻断+X-NSFW 头语义保留)。
- **trainer 五坑**(08-27 四连败实证,细节见归档):①YAML device 恒 cuda:0 ②GPU2 训练前先 `POST :8195/free` ③training_folder 每作业独立 ④产物双嵌套目录 ⑤可选参数全量默认值。

---

## 六、⚠️ 易错点（按主题归并,保留教训精华）

### H. 硬件/容量类

- **H-1 禁止臆造硬件数据**：任何硬件配置/容量问题必须先 SSH 真机确认（曾臆造 Mac Studio 内存翻车）。
- **H-2 显存数字是快照不是真理**：容量规划/共卡部署必须现场 `nvidia-smi`;vLLM 默认 `--gpu-memory-utilization 0.9`,共卡必须显式调低。
- **H-3 多引擎并跑先算 RAM**：183G 曾被多引擎同驻耗尽致 OOM 杀 H3;上架大 RAM 模型前 `free -h`;H3 已加 `MemoryMax=160G`。
- **H-4 「DB 标 error」≠「生成失败」**：批量失败先查 ComfyUI `/history/{pid}`,产物在就回写,禁止盲目重提浪费 GPU(排队≠丢失,tracker 已修)。
- **H-5 温度政策**：无软件熔断(见第三节);风扇曲线懒惰时锁扇 100% 是提速手段。
- **H-6 CUDA_VISIBLE_DEVICES 数字索引≠nvidia-smi 索引(09-03 实证)**：GPU0("requires reset")不进 CUDA 数字枚举,数字序号偏移(CVD=1→物理 GPU2,CVD=2→物理 GPU3)。🔒 新服务锁卡一律用 **GPU UUID**(`Environment=CUDA_VISIBLE_DEVICES=GPU-xxxx`),起服后 `nvidia-smi --query-compute-apps=pid,gpu_uuid` 复核。toiv-comfyui-h3 已用 drop-in gpu-pin.conf 钉 GPU-0e6e9149…(物理 GPU2)。**GPU0 reset 仍未修(独立事项)**。
- **H-7 comfyui-gpu0 :8189 已退役（2026-09-06 收口）**：占用者查明=unit 内僵尸进程 3233 的失控线程（R 态,SIGKILL 无效,与 GPU0 requires reset 同源,只能重启清）;unit 已 `disable`（防重启复活/双开）。**:8196 gpu0-alt 转正为正式本地池后端**（enabled,backends.json/core env 均是 8196）。8189 端口与 GPU0 枚举恢复都挂 workstation 重启窗口（见待办）。AIGCPannel 侧 `start-aigcpannel.py` 与文档漂移已在 09-03~06 修正（:8196）,其 `.env` 旧 COMFYUI_LB_BACKEND_URLS 已注释停用。

### D. 退役/迁移记录类

- **D-1 stop≠disable,重启会复活**(08-23 ltx25 实证)：退役服务必须 `systemctl disable`(或 mask);「已迁移/已停用」记录跨项目冲突时必须真机复核。
- **D-2 一次性手工迁移没有守护会静默失效**：生产依赖变更后必须实测业务链路,不能只看服务 active。

### N. 网络/代理类

- **N-1 跨境链路波动会污染 A/B 结论**：A/B 必须同时段交替测;「502/超时」先排除全局链路事件;frpc 加 `loginFailExit=false`。
- **N-2 HF/外网下载**：core/workstation 直连 HF/civitai 超时;**hf-mirror.com 从 workstation 直连 + aria2c -x16 实测 67MB/s 是主路**(aria2 稀疏文件看日志 DL 行;重定向落地哈希文件名按大小改名;ModelScope resolve URL 同可);Mac Clash(192.168.71.9:7897 / TS 100.74.15.34:7897)为备。**依赖 Mac 在线,大模型下载提前规划**。
- **N-3 Tailscale 跨地区访问**：浏览器侧 TS 优先;workstation 服务须监听 0.0.0.0 才经 TS 可达。
- **N-4 Windows 长命令经 SSH 会被换行截断**：写远端文件用 PowerShell `-EncodedCommand`;`schtasks /change` 非交互挂起,用 `/create /f` 覆盖重建。

### W. Windows 类

- **W-1 SSH session 隔离**：SSH 里 net use 盘符桌面看不到、Start-Process 启的进程断连即被杀;长期服务用计划任务+bat(pc01 InteractiveToken)。
- **W-2 SYSTEM 计划任务看不到用户盘符映射**：ps1 开头在任务自己 session 里 `net use Z:` 重挂;模型可见性最终裁判是 ComfyUI 进程的 object_info,SSH 里 `dir Z:` 是假阴性。

### E. 引擎/工作流类

- **E-1 新专用 ComfyUI 实例必须补 `deps.resolve_worker()` 精确匹配**：否则同机实例被 hostname 回退错配,作业成功但产物 502。InfiniteTalk :8201 已补(09-03 `3446b75`,已部署 core)。
- **E-2 LongCat 链路坑**：TI2V i2v 用 WanVideoEncode→extra_latents;Avatar v1.5 音频必须 whisper-large-v3;WanVideoWrapper 必须 `rope_function="comfy"`。
- **E-3 引擎探测通过≠链路可跑**：新引擎必须真机 e2e 后交付(LTX 音画链实证)。
- **E-4 vLLM 坑**：NVML mismatch 炸平台探测(补丁 /home/merlin/patch_vllm_nvml.py);跑不了 LLaVA 架构 JoyCaption(用 transformers);vllm-node 镜像缺 vllm[audio];**served-model-name 别名机制——换模型保别名=core 零改动**。
- **E-5 mlx-vlm(studio04)视频只认本地路径**（该依赖已退役,此坑只在回滚 studio04 时复活:恢复 .env 两行+重启）。
- **E-6 超分竖屏源必须显式 --target-w/--target-h**,生产一律 `--keep-frames`(默认删帧无法续跑)。
- **E-7 回写协程生命周期不得超过 tracker 作业生命周期**(08-29 三视图卡死实证)：worker 停机可超 2h,一次性等待必死;所有「等待作业完成再落库」的后台任务按**多轮等待+启动 reconcile** 双保险写。

### P. 平台机制类

- **P-1 产物 URL 已签名+归属校验**：测试构造产物 URL 必须带 sig 或先建档;<img>/<video> 走 `?token=` 认证。
- **P-2 Next.js 生产构建必须 `rm -rf .next` 干净重建;deploy.sh 只 rsync 不重建**——部署前必须确认本地 .next BUILD_ID 是当次新构建,验证前端变更必须截图/查 BUILD_ID,不能只看 API。
- **P-2b styled-jsx 作用域坑**：多组件文件一律 `<style jsx global>`+前缀命名;UI 改动必须真机截图验证。
- **P-3 浏览器自动化测 React**：原生事件不触发合成事件(select 用 native setter+dispatchEvent);多 textarea 用 `.promptbar-textarea` 精确定位。
- **P-4 命令行自杀坑**：`pkill -f` 模式串用 `[f]an_guard` 式转义;torchrun 须连父进程一起杀;/tmp 是 tmpfs(大文件写 /var/tmp)。
- **P-5 并行 SSH 会话会互相改写状态(高优)**：关键服务「莫名掉线」先 `journalctl -u <svc>` 查停止来源再处置。**当前实况:AIGCPannel 项目会话也在操作 workstation(见 H-7/七),动服务前留意**。
- **P-6 杂项**：workstation pip 用清华镜像、github 用 ghfast.top(uv 装 git+ 依赖会被重定向失败,先手 clone 改本地路径);core 登录返回字段是 `token`;上传 kind 必须下划线风格;H3 生成前先 free 缓存。
- **P-7 新 Python 服务环境三坑**(sm_120 Blackwell)：torch 必须 cu128+/cu130;老牌 CV 包 `--no-build-isolation --no-deps`+torchvision 补丁;**库主版本升级后旧调用约定必须逐处核对,能跑≠语义对**(trimesh/diffusers 实证)。

---

## 七、近期关键变更（只留活口径;全史见 `.archive/AGENTS-full-20260903.md`）

### 2026-09-11（项目管家：Int/Preview 修复 dirty 部署上 core；复测进行中）
- **部署（ToIV 开发；via 项目管家）**：Int Number normalization + Preview-only **does not** mark_done 已经 `deploy.sh --skip-web` **dirty 部署上 core**。
- **Git**：产品改动 **未** git commit（dirty deploy only）；**非** shipped/online；无产品 SHA。
- **sha 已核**：`apps.py` / `tracker.py`（真源 `.regen_tmp/app_test_matrix_p0/deploy_int_tracker.md`：apps=`21f1acf786f678622b8031788f630ba44f6cb58df227ee8f2516bfd57ef06f1b`；tracker=`ae3fc155b7c79fcfc38bfbc0e42adf77d26474981dcd00aa94bab7fbdfc27ef8`；**勿 stage** `.regen_tmp`）。
- **复测进行中**：`140266` / `116926`。
- **前置 tip**：`1e94140`（L2 RH 残差根因；将 dirty deploy）— **dirty deploy 现已落地**。
- **硬口径**：**非** shipped/online；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`live_on_core_dirty_int_preview_fix_retesting`（非 shipped）；STATE `l2_int_preview_dirty_deploy_2026_09_11`；`updated_at` 2026-09-11T02:31:00+08:00。via 项目管家（ToIV 开发 tip）。


### 2026-09-11（项目管家：L2 RH 残差根因；Int→Number；Preview 误 mark_done；将 dirty deploy）
- **残差根因（ToIV 开发；via 项目管家）**：
  1. ComfyLiterals **Int** 必须为 **`Number`**（validation）。
  2. **Preview-only** 错误地 **`mark_done`**。
- **产品**：改动已落地但 **未 git commit**；将 **dirty deploy**（非 git shipped）。
- **`140266` 仍缺**：`yolov10m` / `vitpose` + 权重需在 **`Wan22Animate/`** 前缀下。
- **真源**：`.regen_tmp/app_test_matrix_p0/l2_rh_residual_notes.md`（**勿 stage**）。
- **前置 tip**：`1eaa34e`（002481 PASS；140266 无产物；116926 Int Number + Wan2_2-Animate-14B_fp8…KJ 缺）。
- **硬口径**：**非** shipped/online；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`live_on_core_l2_rh_residual_rootcause_pending_dirty_deploy`（非 shipped）；STATE `l2_rh_residual_rootcause_2026_09_11`；`updated_at` 2026-09-11T02:29:00+08:00。via 项目管家（ToIV 开发 tip）。
- **跟进（本 tip）**：dirty deploy **已完成**（见上条 Int/Preview；status 现 `live_on_core_dirty_int_preview_fix_retesting`）。


### 2026-09-11（项目管家：10-class 后复测；002481 PASS；140266 无产物；116926 仍缺）
- **结果（ToIV 开发；via 项目管家）**：10-class 安装后 L2 复测。
- **`002481` PASS**（短 id；AGENTS 已有全 id `rh-acc-0024814594-adc75c`）。
- **`140266`**（`rh-acc-1402669058-f27871`）：job 成功但 **无产物/无输出**。
- **`116926`**（`rh-acc-1169267714-43e935`）：仍缺 **Int Number** 校验 + 缺权重 `Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors`。
- **真源**：`.regen_tmp/app_test_matrix_p0/l2_retest_after_10class.json`（**勿 stage**）。
- **交接**：已交 **模型下载** / **设备管家**。
- **前置 tip**：`e81f8f3`（Easy/SDVN 后复测；3 RH 仍 fail；新缺 10 class；已交设备）。
- **硬口径**：**非** shipped/online；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`live_on_core_l2_retest_after_10class`（非 shipped）；STATE `l2_retest_after_10class_2026_09_11`；`updated_at` 2026-09-11T02:19:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-11（项目管家：Easy/SDVN 后复测；3 RH 仍 fail；新缺 10 class）
- **结果（ToIV 开发；via 项目管家）**：LongCat Easy-Use + SDVN 链入后 L2 复测 — **3** 张 RH 卡仍 fail。
- **新缺 10 class_type**（不编造包名；`SAM2×2` 按给定记两项，不发明精确类名）：
  1. `JWInteger`
  2. `rgthree Any Switch`
  3. `GoogleTranslate`
  4. `LayerMask SAM Ultra V2`
  5. `Int`
  6–7. `SAM2×2`（两项 SAM2 相关 class）
  8. `GetImageSize+`
  9. `MathExpression|pysssss`
  10. `PlaySound|pysssss`
- **真源**：`.regen_tmp/app_test_matrix_p0/l2_retest_after_easy_sdvn.json`（**勿 stage**）。
- **交接**：已交 **设备管家** 一次性安装。
- **前置 tip**：`7bad3a4`（Easy-Use+SDVN；`SDVN Any Show` / `easy seed` / `easy positive` Y）。
- **硬口径**：**非** shipped/online；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`live_on_core_l2_retest_after_easy_sdvn`（非 shipped）；STATE `l2_retest_after_easy_sdvn_2026_09_11`；`updated_at` 2026-09-11T01:43:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-11（设备管家：LIVE — LongCat :8197 链入 Easy-Use + SDVN；三 class Y）
- **结果（设备管家；via 项目管家）**：LongCat `:8197` 又链入自定义节点包 **`ComfyUI-Easy-Use`** + **`SDVN_Comfy_node`**；三目标 class **Y**。
- **关 defae10 残差节点缺口**：`SDVN Any Show` / `easy seed` / `easy positive` 在 `:8197` 已填（对应 LongCat 节点后 L2 复测交接的新缺）。
- **硬口径**：本 tip 仅记设备 LIVE FYI；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`live_device_fyi`；STATE `longcat_8197_easy_use_sdvn_2026_09_11`；`updated_at` 2026-09-11T01:40:00+08:00。via 设备管家 / 项目管家 tip。

### 2026-09-11（项目管家：LongCat 节点后 L2 复测；wan-animate PASS；新缺 SDVN/easy）
- **结果（ToIV 开发；via 项目管家）**：LongCat `:8197` 节点链入后 L2 复测 — **wan-animate PASS**（此前 ffmpeg/fixture 残差对该 app 已关）。
- **节点缺口**：此前因缺节点失败的 **3** 张 RH 卡，节点缺口已清（Bjornulf_ShowFloat / PoseAndFaceDetection / PixelPerfectResolution 侧已填）。
- **新缺**：`SDVN Any Show` / `easy seed` / `easy positive`。
- **真源**：`.regen_tmp/app_test_matrix_p0/l2_retest_after_longcat_nodes.json`（**勿 stage**）。
- **交接**：已交 **设备管家** 再装缺节点。
- **硬口径**：**非** shipped/online；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`live_on_core_l2_retest_after_longcat_nodes`（非 shipped）；STATE `l2_retest_after_longcat_nodes_2026_09_11`；`updated_at` 2026-09-11T01:38:00+08:00。via 项目管家（ToIV 开发 tip）。
- **节点缺口跟进（2026-09-11）**：上述三 class 缺口已由设备管家链入 Easy-Use + SDVN 填齐（见上节；STATE `longcat_8197_easy_use_sdvn_2026_09_11`）。

### 2026-09-11（设备管家：LIVE — LongCat :8197 链入 Bjornulf/WanAnimatePreprocess/controlnet_aux；三目标 class Y）
- **结果（设备管家；via 项目管家）**：LongCat `:8197` 已链入自定义节点包 **`Bjornulf_custom_nodes`** / **`WanAnimatePreprocess`** / **`controlnet_aux`**；三目标 class **Y**。
- **关 L2 残差节点缺口**：`Bjornulf_ShowFloat` / `PoseAndFaceDetection` / `PixelPerfectResolution` 在 `:8197` 已填（对应 L2 dirty-deploy 交接的缺节点）。
- **仍开残差**：~~wan-animate ffmpeg/fixture（VHS 抽音等）仍未关~~ → **已关（2026-09-11 复测）**：wan-animate **PASS**（见上节 LongCat 节点后 L2 复测）。
- **硬口径**：本 tip 仅记设备 LIVE FYI；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`live_device_fyi`；STATE `longcat_8197_nodes_bjornulf_wananim_ctrlaux_2026_09_11`；`updated_at` 2026-09-11T01:33:00+08:00。via 设备管家 / 项目管家 tip。

### 2026-09-11（项目管家：L2 路由 dirty 部署；抽测4/4 improved、pass0）
- **结果（ToIV 开发；via 项目管家）**：live_core 经 `deploy/deploy.sh --skip-web`（~01:27 CST）部署 L2 路由修复；**产品仍未 git commit**（dirty deploy only；分支 tip 旁证 `0da7f30`，路由修复 uncommitted）。
- **抽测**：原池 503 样本 **4/4** `routing_improved=true`；产品 **pass=0** / fail_product=4。
  - `wan-animate`：已到 worker `:8197`，残差 VHS/ffmpeg 抽音 fixture（`drive_2s.mp4`）。
  - `rh-acc-0024814594-adc75c` / `rh-acc-1402669058-f27871` / `rh-acc-1169267714-43e935`：缺节点 class_type — Bjornulf_ShowFloat（👁 Show Float）/ PoseAndFaceDetection / PixelPerfectResolution（完美像素）。
- **真源**：`.regen_tmp/app_test_matrix_p0/l2_retest_after_routing.json`（**勿 stage**）。
- **交接**：已交 **设备管家** 安装缺节点。
- **后续（2026-09-11）**：`:8197` 上三目标 class 已 **Y**（包链入见上节）；节点缺口侧已填；ffmpeg/fixture 仍开。
- **硬口径**：**非** git shipped/online；仅 **dirty-deployed**；产品实现仍**未 commit**；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`live_on_core_dirty_routing_improved_pass0`（非 shipped）；STATE `l2_routing_dirty_deploy_retest_2026_09_11`；`updated_at` 2026-09-11T01:30:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-11（项目管家：L2 路由修复（分支未commit；pytest52；抽测中））
- **结果（ToIV 开发；via 项目管家）**：**L2 路由修复**已在工作树落地，**尚未 git commit**（分支 `feat/app-guides-admin-cms` uncommitted）。
- **改动要点**：
  - `_pick_app_client` 识别 **WanVideo*** → 专池（dedicated pool）。
  - `/run` + upload media 与 graph **同机**跑。
- **测试**：pytest routing/upload/apps — **52 passed**。
- **部署**：正部署 / 抽测原 **503** 卡（市场卡未钉专池曾致通用池 503）。
- **残差（仍已知）**：LongCat 缺权重；nunchaku 溢出；pulid EOF；无 LTX 专池。
- **下一步**：**抽测原 503 卡**。
- **硬口径**：产品实现仍**未 commit**；**禁止**标 shipped/online；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`routing_fix_uncommitted_spotcheck`（非 shipped）；STATE `l2_routing_fix_uncommitted_2026_09_11`；`updated_at` 2026-09-11T01:27:00+08:00。via 项目管家（ToIV 开发 tip）。


### 2026-09-11（项目管家：P0 L2 热门24 pass8/fail_product15/timeout1）
- **结果（ToIV 开发；via 项目管家）**：**P0 L2** 热门 **24** — pass **8** / fail_product **15** / fail_timeout **1**。
- **pass**：h3-i2v / t2v / fl2v / i2v-15s-fast / txt2img-basic / img2img-basic / wan-animate-2 / qwen-image-edit（ids：`h3-t2v` / `h3-i2v` / `h3-fl2v` / `h3-i2v-15s-fast` / `txt2img-basic` / `img2img-basic` / `wan-animate-2` / `qwen-image-edit`）。
- **主因**：市场卡未钉专池 → 通用池 **503**；H3 upload 默认不上 **:8195**。
- **真源**：`.regen_tmp/app_test_matrix_p0/l2_summary.json`（**勿 stage**）。
- **下一步**：开发修路由/上传对齐。
- **硬口径**：产品实现仍**未 commit**；**禁止**标 shipped/online；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`fail_product_majority`（L2 热门24；L0 仍 `pass`）；STATE `p0_l2_hot24_2026_09_11`；`updated_at` 2026-09-11T01:17:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-11（项目管家：P0 L0 实测 550/550 pass）
- **结果（ToIV 开发；via 项目管家）**：**P0 L0** 完成 — **550/550 pass**（全部公开 apps）。
- **纠正**：tip `ae2b868` 曾标 P0 L0=`in_progress` → 现改为 **`pass`/`done`**。
- **硬口径**：产品实现仍**未 commit**；更广路线图**禁止**标 shipped/online（**仅 L0 结果完成**）；P1/P3/P2 仍 `planned`；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`pass`；STATE `p0_l0_pass_2026_09_11`（并更新 `roadmap_p0_p1_p3_p2_2026_09_11` P0=`pass`）；`updated_at` 2026-09-11T00:44:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-11（项目管家：拍板 P0实测→P1说明卡→P3扩展Admin→P2说明书KG）
- **用户确认全序（ToIV 开发；via 项目管家）**：
  1. **P0** 分级实测 — ~~开发已开工 P0 L0（status=`in_progress`）~~ → **已纠正**：P0 L0 **550/550 pass**（见上条）。
  2. **P1** 应用说明卡（用法/作用）。
  3. **P3** 万能管理台 — **扩展现有 Admin**，非另起后台。
  4. **P2** 说明书知识图谱。
- **旁证（先前调研，纳入 STATE）**：
  - AdminView 今日：仅 users / agents / audit。
  - 最小 KG 已有：`GET /api/admin/knowledge-graph` ≈**1295** nodes / **608** edges；**无 howto**。
  - 公开 apps ≈**550**（video**359** / image**189**）；描述有但短（p50≈**40** chars）。
- **硬口径**：产品实现**未 commit** — **禁止**标 shipped/online（仅 L0 结果 done）；产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；本地 tip **无 push**。
- Status：`roadmap_confirmed`→P0 L0 现 `pass`（其余=`planned`；**非 shipped**）；STATE `roadmap_p0_p1_p3_p2_2026_09_11`；原 `updated_at` 2026-09-11T00:37:00+08:00（L0 纠正见 2026-09-11T00:44:00+08:00）。via 项目管家（ToIV 开发 tip）。


### 2026-09-10（设备管家：LIVE — GLM-5.3-Flash EXL3 TP2 双 Spark 部署上线）
- **切换**：spark02 `:8000` 现网 LLM/VLM 由 `vllm_node`（Qwen3.8-27B-NVFP4）→ **`vllm_glm53`（GLM-5.3-Flash EXL3-4bpw，Entrpi kit v2.3-tier1）**；TP2 跨 spark02(head/rail .12)+spark01(worker/rail .13) 走 200GbE RAIL；DFlash2 推测解码、KV=fp8_ds_mla、MAX_LEN 524288。
- **兼容设计**：served `glm-5.3-flash` + 别名 `qwen3.8-27b`/`qwen3.6-uncensored`（launcher 注入），**core `.env` 零改动**、OpenClaw 网关零改动透明承接。
- **验证**：kit 冒烟 391 ✓；500tok 精确 **17.4 tok/s**（旧 qwen 设备侧 15.4）；工具调用 ✓；视觉 ✓；core 路径（model=qwen3.8-27b）✓。
- **权重**：`~/models/glm53-exl3`（175.6GiB×2 节点）+ drafter `~/models/glm53-dflash2-mxfp8`；下载路线 hf-mirror+`HF_HUB_DISABLE_XET=1`（Xet 后端国内 401；单流峰值 ~118MB/s）。
- **修复**：spark02 `~/.ssh/config` 陈旧 `Host 192.168.200.*`（root@2222+/root 密钥）已删——曾废掉 kit 的 RAIL rsync 免密。
- **运维**：容器 restart=no，**重启后手动** `~/launch-glm53-vllm-tp2.sh 1`(spark01)→`0`(spark02)；回滚 `docker stop vllm_glm53 && docker start vllm_node`（旧容器 stop 留存 spark02）。
- **OpenClaw(.26)**：18:45 已自指 spark02:8000+qwen 模型名 → 别名自动承接，无需改动；32768 超窗问题随 524288 消除。
- Status：`live_deployment`；STATE `glm53_flash_tp2_live_2026_09_10`；`updated_at` 2026-09-10T21:55:00+08:00。via 设备管家。

### 2026-09-10（项目管家：capability_gap closeout（公开550；误藏×2已放回））
- **目标完成（ToIV 开发 + 能力缺口）**：用户目标「能做全做、做不到隐藏、核验公开可用」已完成；本轮能力缺口扫描待命结束。
- **序列**：
  1. closeout 核验后 soft-hide×**3**（含 2×`fetch_error` 误藏 + 1×blocked `rh-acc-6076858369-17c38d`）→ 公开 **551→548**。
  2. v23 对照 **NO_DELTA** soft-hide；恢复误藏×**2**（`rh-acc-3038288898-fe20f8`、`rh-acc-8206083073-eb11b5`）→ 公开 **550**。
  3. 公开集 `public_not_ok=0`（main OK / dedicated_aware）。
  4. `still_waiting` **42** 全 `hard_blocked`，保持隐藏；公开侧通用池缺节点 **0**。
  5. dedicated_h3 optional×**8** 按既往 skip。
  6. 硬阻保持隐藏：42 + `17c38d`。
- **真源（勿 stage）**：`.regen_tmp/capability_gap_closeout_20260910/`；`capability_gap_scan_v23/CLOSEOUT.md`。
- **旁注**：产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；无 push。
- Status：`docs_closeout`（本地 tip；无产品 SHA）；STATE `capability_gap_closeout_2026_09_10`；`updated_at` 2026-09-10T19:22:00+08:00。via 项目管家（ToIV 开发 tip）。


### 2026-09-10（项目管家：v22 unhide ×4 + v22b Animate Q4（546→550→551））
- **生产已落地（ToIV 开发；core）**：
  - v22 unhide **4** → `is_public=true`：`rh-acc-1099076609-5b577d` / `rh-acc-9943753729-f90502` / `rh-acc-3915150338-73e61b` / `rh-acc-4551318530-b94c9f`；公开约 **546→550**。
  - v22b unhide **1** → `is_public=true`：`rh-acc-7233807361-883e22` Animate Q4 GGUF（换装+换脸+换背景- Animate Wan2.2）；公开约 **550→551**（叠加 **546→551**）。
- **扫侧**：主 OK **457**（:8196 已恢复；此前拒连致主 OK 偏低可归档）。
- **旁注**：产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；无 push。
- Status：`docs_unhide`（本地 tip；无产品 SHA）；STATE `v22_unhide_x4_v22b_animate_q4_2026_09_10`；`updated_at` 2026-09-10T18:20:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-10（项目管家：通用池 extrapaths 补 unet；Animate GGUF 走 UnetLoaderGGUF）
- **设备管家（通用池 extrapaths）**：toiv 段已补 `unet: unet`。
- **Animate GGUF 可见性**：以 **UnetLoaderGGUF** 为准可见（勿按其它 loader 口径报缺）。
- **旁注（未落地）**：能力缺口已交 v22 unhide **4** 给开发；扫时 :8196 拒连致主 OK 偏低；Animate Q4 `mount_pending`；完整 unhide 数字等 ToIV 开发生产回报再定。
- **旁注**：产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；无 push。
- Status：`live_device_fyi`（本地 tip；无产品 SHA）；STATE `genpool_extrapaths_unet_animate_gguf_2026_09_10`；`updated_at` 2026-09-10T18:06:00+08:00。via 项目管家（设备管家 tip）。

### 2026-09-10（项目管家：MODEL_SOURCES v21 P0 后 464/335/799（去重））
- **MODEL_SOURCES（ToIV 模型下载；v21 P0 后 + 去重）**：ok**464**/blocked**335**/total**799**（header/JSON `updated_at` 2026-09-10T17:58:18+08:00；前 tip v20 unhide 467/343/810；Δ ok**−3**/blocked**−8**/total**−11**，去重导致总数下降）。
  - newly_ok **4** ≈**32.00** GiB：`Wan2.2-Fun-A14B-InP-low-noise-MPS` / `flux-2-klein-base-4b` / `QwenRebalanceV10_v10LoraR64` / `wan2.2-i2v-rapid-aio-nsfw-v7`（MateBook aria2c proxy:7897 → SSD → rsync NAS；未写 h3/）。
  - already_on_nas **1**：`Wan2.2-Animate-14B-Q4_K_S.gguf`（unet/；勿再下；路径可见性交设备管家）。
  - 本批仍 blocked **40**（无精确公网 basename / BFL gated 等；勿假改名）。
  - 真源：`.regen_tmp/capability_gap_v21_p0_models_download_summary.json`（**勿 stage**）。
- **旁注**：产品码仍 dirty **勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；无 push。
- Status：`docs_model_sources`（本地 tip；无产品 SHA）；STATE `model_sources_v21_p0_dedup_2026_09_10`；`updated_at` 2026-09-10T18:00:00+08:00。via 项目管家（ToIV 模型下载）。

### 2026-09-10（项目管家：v20 fill节点≈27/30class + MODEL_SOURCES 467/343/810 + v21 unhide×36 →546）
- **设备管家（通用池 v20 fill 节点）**：节点包约 **27**；三机齐 **30** class_type（明细以设备→开发为准，**勿编造包名**）。
- **MODEL_SOURCES（ToIV 模型下载；v20 unhide 后）**：ok**467**/blocked**343**/total**810**（header 已同步 JSON `updated_at` 2026-09-10T16:46:45+08:00；前 tip v17 465/339/804；Δ ok**+2**/blocked**+4**/total**+6**）。
  - newly_ok **2** ≈**51.23** GiB：`10Eros_Max_h3_TURBO-hybrid_beta3_int8_convrot` + `minimax_h3_ref2va_int8_convrot`（H3-only → `h3/diffusion_models/`）。
  - 同批 blocked 新记 **4**（near-miss / 无精确源；勿假改名）；already_on_nas **14**；P0 animate2 distill 已在 NAS（路径注给设备管家，勿复制到通用 diffusion_models）。
  - 真源：`.regen_tmp/capability_gap_v20_unhide_download_summary.json`（**勿 stage**）。
- **capability_gap_scan_v21 + 批量 unhide（ToIV 开发+能力缺口）**：主 OK **454**（vs v20 **245**，Δ+**209**；含私有全集 apps **2172**，与 v20 公开向 **908** 不可直接比）；dedicated_aware_ok **1600**（+animate2→**1614**）；`ok_if_dedicated_animate2` **14**。
  - 批量 unhide **36**（`is_public=true` fail=0）：其中 P0 nodes→OK **6** + 另 **30**；公开约 **510→546**。
  - 仍等下载 **47** / 仍缺节点 **27**（P0_nodes_total **33** − OK **6**）；排除 hard/hang **0**。
  - 真源：`.regen_tmp/capability_gap_scan_v21/actionable/unhide_ready_after_v21.json`（+ `_applied.json`；**勿 stage**）。
- **旁注**：产品码仍 dirty（admin soft-hide 可再上架等）**勿 stage**；勿 stage `.regen_tmp`；无产品 SHA；无 push。
- Status：`docs_consolidated`（本地 tip；无产品 SHA）；STATE `v20_fill_nodes_model_sources_v21_unhide_2026_09_10`；`updated_at` 2026-09-10T17:02:00+08:00。via 项目管家（设备管家 tip + ToIV 模型下载 + ToIV 开发/能力缺口）。

### 2026-09-10（项目管家：animate2 unhide 已落地 508→510；admin soft-hide 可再上架）
- **产品改动（仍 dirty 未 commit；勿 stage；status 仍 `pending_product_commit`）**：
  - `apps/api/app/routes/apps.py`：admin `_visible` — 可见目录 soft-hide 卡，并可 PUT `is_public=true` 再上架；不窥视他人私有应用。
  - `apps/api/app/services/app_seed.py`：seed **不覆盖** 已有 `is_public`。
  - `apps/api/tests/test_apps.py`：`test_admin_can_unhide_soft_hidden_catalog_and_builtin`。
- **生产已落地（core 两轮 `deploy.sh --skip-web`）**：admin soft-hide 可再上架；seed 不再覆盖已有 `is_public`（产品码仍 dirty 未 commit）。
- **animate2 dedicated unhide 已落地（不是待 unhide）**：`wan-animate-2` + `rh-character-replacement-minimax-h3-7582cc8e`（图含 WanAnimate2ToVideo；`:8199`）→ 公开；市场 **508→510**。
- **重启误开再藏**：曾误开 `avatar-talk` / `facedetailer` / `hunyuan-i2v` / `latentsync`，已重新 soft-hide；公开口径仍 **510**。
- **能力缺口**：通用 P0 unhide 候选 **80** 仍在 `.regen_tmp/capability_gap_scan_v20/actionable/unhide_after_fill_p0.json`（等 fill；**勿 stage**）；animate2×2 已从候选变为已 unhide。
- **v20 dedicated_aware 旁路已齐（ToIV 开发）**：`dedicated_aware_ok(H3)=510`；`ok_if_dedicated_animate2=2`（均已 unhide）；`with_animate2=512`。真源 `.regen_tmp/capability_gap_scan_v20/dedicated_aware.json` + `actionable/dedicated_aware_animate2_v20.json`（**勿 stage**）。**v21+ 必跑 animate2 postprocess**。
- **旁注**：勿 stage `.regen_tmp`/产品 dirty；无产品 SHA；产品公开约 **510**。
- Status：`pending_product_commit`（产品码）；animate2 unhide / admin relist **生产已落地**；STATE `admin_soft_hide_relist_wan_animate2_2026_09_10`；`updated_at` 2026-09-10T15:55:00+08:00。via 项目管家（ToIV 开发 + 能力缺口）。

### 2026-09-10（项目管家：mass soft-hide unusable v20 ×388）
- **用户拍板**：只保留当前能用的应用，其余隐藏。
- **动作**：生产 soft-hide **388** 张 → `is_public=false`（ToIV 开发已执行；hid_ok=388 / fail=0）。
- **清单 vs 生产**：清单 hide **398** / 新藏约 **388**（398 − 已藏硬阻-only ×10）；生产落地 soft-hide **388**。
- **市场**：公开约 **896→508**（期望公开 **510**；API list_len **510**，含 **2** 张非公开 keep）。
- **规则 / keep**：KEEP = main_ok ∪ ok_if_dedicated_h3（dedicated_aware_ok）= **510**（main_ok **245** + dedicated_aware_only **265**）；soft-hide 其余 v20 扫描公开集。
- **验收（能力缺口）**：`post_soft_hide_verify_v20` **ok**（@ 2026-09-10T14:15:43+08:00）；公开 **508** ⊆ keep **510**；漏网 **0**；keep−public=**2**（已非公开 keep：`Flux-文生图-96c82d` / `rh-acc-7881019393-f5fc8e-fc7180`）；清单398−生产388=10 为已藏硬阻-only，**无补差**；**不全量 v21**。
- **真源**：`.regen_tmp/capability_gap_scan_v20/actionable/soft_hide_all_non_usable_v20.json`（清单 hide398）+ `soft_hide_all_unusable_v20.json` / `soft_hide_all_unusable_v20_applied.json`（生产落地）+ `post_soft_hide_verify_v20.json`（验收；**勿 stage**；已 applied/verified）。
- **旁注**：AGENTS **不列** 388 ids（见 JSON）；产品 dirty **勿提交**；未写 h3/；无 MODEL_SOURCES 变更；不扫 v21。
- Status：`soft_hide_docs`（无产品 SHA；验收 ok）；STATE `soft_hide_all_unusable_v20_2026_09_10`；`updated_at` 2026-09-10T14:22:00+08:00。via 项目管家（ToIV 开发 tip + 能力缺口验收）。

### 2026-09-10（项目管家：soft-hide hard-block-only v20 ×10）
- **动作**：仅缺 hard-blocked/no-source 且 **无缺节点** 的 **10** 张 → `is_public=false`（ToIV 开发已执行）。
- **市场**：公开约 **908→898**。
- **规则**：missing_nodes_on_all_workers empty AND every missing_models_on_no_worker ∈ hard-blocked/no-source；exclude already soft-hidden；exclude H3-node residuals。
- **ids**：`rh-acc-0951611393-511ac0` / `rh-acc-1075350528-dc3518` / `rh-acc-1796676609-bd7f4d` / `rh-acc-2769283074-6244b3` / `rh-acc-3253770242-2babaa` / `rh-acc-5038745602-15deeb` / `rh-acc-5875539969-0b9198` / `rh-acc-6473673730-f7ba44` / `rh-acc-8106374145-615ed6` / `rh-acc-9431956482-7fa928`（短：511ac0 dc3518 bd7f4d 6244b3 2babaa 15deeb 0b9198 f7ba44 615ed6 7fa928）。
- **真源**：`.regen_tmp/capability_gap_scan_v20/actionable/soft_hide_hard_block_only_v20.json`（**勿 stage**；已 applied）。
- **旁注**：不扫 v21；放宽版不需要；Gitee main 已在 `dae4ee8`（v20 tip）；GitHub 仍不可达；未写 h3/；无 MODEL_SOURCES 变更。
- Status：`soft_hide_docs`（无产品 SHA）；STATE `soft_hide_hard_block_only_v20_2026_09_10`；`updated_at` 2026-09-10T14:05:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-10（项目管家：capability_gap_scan_v20 完成）
- **主口径**：apps **908**（−1 soft-hide `rh-acc-1004064770-ef8fd7`，对齐 tip `02737db`；vs v19 **909**）；OK **245（持平 vs v19，+0）**；blocked **663**（−1）；unlocalizable **0**。
- **dedicated-aware**：**510（0）**；only_h3 **265**；blocked_remaining_after_dedicated **398**。
- **worker models**：8196=**838**；8188=**822**；8193=**822**；style_models=**2**；loras=**337**；diffusion_models=**170**；checkpoints=**55**。
- **soft-hide 对齐**：`rh-acc-1004064770-ef8fd7` 已从公开列表/blocked 消失（gone_from_public_or_list / gone_from_blocked）。
- **主 OK 持平**：无新下载批次抬升；等长尾或产品拍板再扫。
- **仍缺 Top 非 H3**：银月/燕如嫣/梅凝/韩立南宫婉/peiling3(**6**) + model.pt(**5**) + Kook亚洲人像/Licon-MSR/bfs rank128B/new_flux-2-klein-9b(**4**)。
- **Top 缺节点**仍 **H3/RH + TT/Comfly**。
- **旁注**：soft_hide_note — v20 vs v19：confirm ef8fd7 gone；apps expect ~908。
- **真源**：`.regen_tmp/capability_gap_scan_v20/`（**勿 stage**）；tip `.regen_tmp/capability_gap_scan_v20/actionable/tip_for_project_steward.json`。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v20_2026_09_10`；`updated_at` 2026-09-10T13:50:00+08:00。via 项目管家（ToIV 能力缺口 tip）。

### 2026-09-10（项目管家：soft-hide rh-acc-1004064770-ef8fd7 — UltimateSD 已清后续）
- **动作**：`rh-acc-1004064770-ef8fd7`（Z-image真实感-电商高清文生图）→ `is_public=false`（ToIV 开发已执行）。
- **原因**：仅缺 hard-blocked `beyondREALITY_beyondREALITYZIMAGE.safetensors`（无精确公开源）；**UltimateSDUpscale 已清**（v19 node gap；主池 ssitu@a5547db9）。
- **市场**：公开应用约 **909→908**。
- **口径更新**：24ae742 / MODEL_SOURCES v17 tip 明示「**勿**藏 ef8fd7（还缺 UltimateSD）」——现 UltimateSD 已清，本 tip **覆盖**该勿藏口径。
- **同权此前**：`rh-acc-8851286018-43497c` 已于 24ae742 soft-hide（910→909）。
- **真源**：`.regen_tmp/capability_gap_scan_v19/actionable/soft_hide_beyondreality_zimage_followup.json`（**勿 stage**）。
- Status：`soft_hide_docs`（无产品 SHA）；STATE `soft_hide_ef8fd7_beyondreality_followup_2026_09_10`；`updated_at` 2026-09-10T13:46:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-10（项目管家：capability_gap_scan_v19 完成）
- **主口径**：apps **909**（post soft-hide `rh-acc-8851286018-43497c`；vs v18 **910**）；OK **245（+1 vs v18）**；blocked **664**（−2）；unlocalizable **0**。
- **dedicated-aware**：**510（+1）**；only_h3 **265**；blocked_remaining_after_dedicated **399**。
- **worker models**：8196=**838**；8188=**822**；8193=**822**；style_models=**2**；loras=**337**；diffusion_models=**170**；checkpoints=**55**。
- **已清 missing 4**（v17 长尾 newly_ok 落地 + worker 可见）：Wan2.2_Remix_NSFW high+low / moodyRealMix_zitV5DPO / `BEYOND REALITY SUPER Z IMAGE 3.0 淡妆浓抹 BF16`；`still_missing_named`={}。
- **UltimateSDUpscale**：`still_in_missing_nodes`=[] / related=[] / top15=[]（设备管家三机已装；node gap 清）。
- **仍缺 Top 非 H3**：银月/燕如嫣/梅凝/韩立南宫婉/peiling3(**6**) + model.pt(**5**) + Kook亚洲人像/Licon-MSR/bfs rank128B/new_flux-2-klein-9b(**4**)。
- **Top 缺节点**仍 **H3/RH + TT/Comfly**。
- **旁注**：soft_hide_note — v19 after v17 longtail newly_ok=4；apps 910→909 via soft-hide 8851286018。
- **真源**：`.regen_tmp/capability_gap_scan_v19/`（**勿 stage**）；tip `.regen_tmp/capability_gap_scan_v19/actionable/tip_for_project_steward.json`。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v19_2026_09_10`；`updated_at` 2026-09-10T07:21:00+08:00。via 项目管家（ToIV 能力缺口 tip）。

### 2026-09-10（项目管家：MODEL_SOURCES v17 长尾齐 + beyondREALITYZIMAGE blocked + soft-hide）
- **MODEL_SOURCES**：ok**465**/blocked**339**/total**804**（header 已同步 JSON `updated_at` 2026-09-10T07:14:32+08:00）。
- **相对前 tip**：0616f0c 462/342（Δ +3/−3）；若 BEYOND 淡妆浓抹已计则相对 0f6a0a4 量级 **+4/−4**。
- **newly_ok≈49.55 GiB**：Wan2.2_Remix_NSFW high+low / moodyRealMix_zitV5DPO / `BEYOND REALITY SUPER Z IMAGE 3.0 淡妆浓抹 BF16`（ok，≠ RH double-prefix 名）。
- **blocked 确认**：`beyondREALITY_beyondREALITYZIMAGE.safetensors` — 无精确公开源；**勿**冒充/等同淡妆浓抹 BF16。
- **soft-hide 1**：`rh-acc-8851286018-43497c`（仅缺该 blocked 权重）→ `is_public=false`；市场约 **910→909**；**勿**藏 `rh-acc-1004064770-ef8fd7`（还缺 UltimateSDUpscale）。
- **未写 h3/**。
- **真源**：`.regen_tmp/capability_gap_v17_download_summary.json` / `beyondreality_zimage_trace.json` / `capability_gap_scan_v18/actionable/soft_hide_beyondreality_zimage_only.json`（**勿 stage**）。
- **主池 UltimateSDUpscale（设备管家）**：`ssitu/ComfyUI_UltimateSDUpscale` @ `a5547db9`；submodule Coyote-A @ `2322caa`；**无 pip**；主池三机已装；object_info：UltimateSDUpscale / CustomSample / NoUpscale / Guider；**未** soft-hide `rh-acc-1004064770-ef8fd7`（仅记节点；可能日后 unblock）。
- Status：`inventory_and_soft_hide_docs`（无产品 SHA）；STATE `model_sources_v17_beyondreality_soft_hide_2026_09_10`；`updated_at` 2026-09-10T07:18:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-10（项目管家：capability_gap_scan_v18 完成）
- **主口径**：apps **910**（post soft-hide）；OK **244（持平 vs v17，+0）**；blocked **666**（0）；unlocalizable **0**。
- **dedicated-aware**：**509（0）**；only_h3 **265**。
- **worker models**：8196=**838**；8188=**822**；8193=**822**；style_models=**2**；loras=**337**。
- **已清 missing**：`BEYOND REALITY SUPER Z IMAGE 3.0 淡妆浓抹 BF16.safetensors`（complete **12309881296** B；MODEL_SOURCES BR BF16 落地 + worker 可见）；`still_missing_named`={}。
- **主 OK 持平**：BEYOND 在 v17 已不在 missing_models（当时 incomplete）；完整落地后仍因卡上他缺不抬主 OK。
- **仍缺 Top 非 H3**：银月/燕如嫣/梅凝/韩立南宫婉/peiling3(**6**) + model.pt(**5**) + Kook亚洲人像/Licon-MSR/bfs rank128B/new_flux-2-klein-9b(**4**)。
- **Top 缺节点**仍 **H3/RH + TT/Comfly**。
- **旁注**：soft_hide_note — v18 focus: BEYOND REALITY cleared from missing after complete download + worker refresh。
- **真源**：`.regen_tmp/capability_gap_scan_v18/`（**勿 stage**）；tip `.regen_tmp/capability_gap_scan_v18/actionable/tip_for_project_steward.json`。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v18_2026_09_10`；`updated_at` 2026-09-10T06:43:00+08:00。via 项目管家（ToIV 能力缺口 tip）。

### 2026-09-10（项目管家：MODEL_SOURCES BR BF16 — ok462/blocked342/total804）
- **计数**：ok **462** / blocked **342** / total **804**（BR BF16 落地；前 tip 0f6a0a4 461/343/804；Δ ok+1 / blocked−1）。
- **清单**：`docs/MODEL_SOURCES.md` + `MODEL_SOURCES.json` 已对齐；JSON `updated_at` 2026-09-10T06:37:18+08:00。
- **下载摘要**：`BEYOND REALITY SUPER Z IMAGE 3.0 淡妆浓抹 BF16.safetensors` → `diffusion_models/`；**12309881296** B（≈11.46 GiB；ok）；自 v16 长尾续下已落地（此前「续下中未计入」）；**未**写 `h3/`。
- **真源**：`.regen_tmp/capability_gap_v16_download_summary.json`（**勿 stage**）。
- Status：`inventory_updated`；STATE `model_sources_br_bf16_2026_09_10`；`updated_at` 2026-09-10T06:40:00+08:00。via 项目管家（ToIV 模型下载）。


### 2026-09-10（项目管家：capability_gap_scan_v17 完成）
- **主口径**：apps **910**（post soft-hide；vs v16 扫时 922）；OK **244（+2 vs v16）**；blocked **666**（−14）；unlocalizable **0**。
- **dedicated-aware**：**509（+2）**；only_h3 **265**。
- **worker models**：8196=**835**；8188=**819**；8193=**819**；style_models=**2**；loras=**337**。
- **已清 missing 4**（v16 下载长尾 LoRA）：SESELAORUYAO / DarkKlein9b_v2BFS_extracted_lora_r256 / Kook_Qwen_V3极致真实 / Kook_Zimage_如梦似幻；`still_missing_named`={}；`loras_all_cleared`。
- **主 OK +2**：与四枚 LoRA 清缺对齐；apps 口径已含 soft-hide 12。
- **仍缺 Top 非 H3**：银月/燕如嫣/梅凝/韩立南宫婉/peiling3(**6**) + model.pt(**5**) + Kook亚洲人像/Licon-MSR/bfs rank128B/new_flux-2-klein-9b(**4**)。
- **Top 缺节点**仍 **H3/RH + TT/Comfly**。
- **旁注**：BEYOND REALITY SUPER Z IMAGE 3.0 淡妆浓抹 BF16 续下中（incomplete；仍不在 missing_models）。
- **真源**：`.regen_tmp/capability_gap_scan_v17/`（**勿 stage**）；tip `.regen_tmp/capability_gap_scan_v17/actionable/tip_for_project_steward.json`。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v17_2026_09_10`；`updated_at` 2026-09-10T06:10:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-10（项目管家：MODEL_SOURCES v16 非 H3 — ok461/blocked343/total804）
- **计数**：ok **461** / blocked **343** / total **804**（v16 长尾一批；前 tip 7617fd4 457/347/804；Δ ok+4 / blocked−4）。
- **清单**：`docs/MODEL_SOURCES.md` + `MODEL_SOURCES.json` 已对齐；JSON `updated_at` 2026-09-10T05:44:41+08:00。
- **下载摘要**：newly_ok **4** ≈1.94 GiB（SESELAORUYAO / DarkKlein9b_v2BFS_extracted_lora_r256 / Kook_Qwen_V3极致真实 / Kook_Zimage_如梦似幻）；already_on_nas **10**；P0/P1 blocked 含：亚洲人像/3kman-reface/ComfyUI_00002_/add_real_details/detail-new/h-anime4；BEYOND REALITY 续下中未计入；**未**写 `h3/`。
- **真源**：`.regen_tmp/capability_gap_v16_download_summary.json`（**勿 stage**）。
- Status：`inventory_updated`；STATE `model_sources_v16_non_h3_2026_09_10`；`updated_at` 2026-09-10T06:06:30+08:00。via 项目管家（ToIV 模型下载）。


### 2026-09-10（项目管家：soft-hide blocked-only 12 — v16 后续）
- **动作**：仅缺 hard-blocked 精确名且无其他节点缺的 **12** 张 → `is_public=false`（ToIV 开发已执行）。
- **市场**：列表约 **922→910**。
- **规则**：only remaining models are hard-blocked exact names；no non-hang missing nodes。
- **真源**：`.regen_tmp/capability_gap_scan_v16/actionable/soft_hide_blocked_only_v16.json`（**勿 stage**）。
- Status：`soft_hide_docs`（无产品 SHA）；STATE `soft_hide_blocked_only_v16_2026_09_10`；`updated_at` 2026-09-10T05:24:54+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-10（项目管家：capability_gap_scan_v16 完成）
- **主口径**：apps **922**；OK **242（持平 vs v15，+0）**；blocked **680**；unlocalizable **0**。
- **dedicated-aware**：**507（0）**；only_h3 **265**。
- **worker models**：8196=**830**；8188=**814**；8193=**814**；style_models=**2**；loras=**333**。
- **已清 missing 5**：flux1-redux-dev / flex1_redux_siglip2_512 / ltx2.3紫灵触发词ziling / ltx2.3韩立触发词hanli / ltx2.3宋玉触发词songyu（style_models mount + v15 download batch）。
- **主 OK 不涨**：卡上仍有他缺；Top 仍缺多为已文档 blocked。
- **仍缺 Top 非 H3**：Licon-MSR-V1_B / model.pt / new_flux-2-klein-9b(**7**) + 角色 LTX LoRA(**6**) + bfs rank128B / nvfp4(**5**)。
- **Top 缺节点**仍 **H3/RH + TT/Comfly**。
- **真源**：`.regen_tmp/capability_gap_scan_v16/`（**勿 stage**）；tip `.regen_tmp/capability_gap_scan_v16/actionable/tip_for_project_steward.json`。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v16_2026_09_10`；`updated_at` 2026-09-10T05:20:30+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-10（项目管家：MODEL_SOURCES v15 非 H3 — ok457/blocked347/total804）
- **计数**：ok **457** / blocked **347** / total **804**（v15 非 H3 续下；前 tip 2f104c9 454/350/804；Δ ok+3 / blocked−3）。
- **清单**：`docs/MODEL_SOURCES.md` + `MODEL_SOURCES.json` 已对齐；JSON `updated_at` 2026-09-10T05:16:39+08:00。
- **下载摘要**：newly_ok **3** ≈0.28 GiB（紫灵/韩立/宋玉 Civitai → `loras/`）；already_on_nas **12**；blocked 含：银月/燕如嫣 opaque/梅凝/韩立南宫婉/peiling3/nvfp4 gated/Kook亚洲人像/model.pt/h-anime4 登录墙 + 已知 trio（Licon-MSR-V1_B / new_flux-2-klein-9b / bfs…rank128B）；**未**写 `h3/`。
- **下一步**：此后可扫 capability_gap **v16**（**未**声称 v16 已做）。
- **真源**：`.regen_tmp/capability_gap_v15_download_summary.json`（**勿 stage**）。
- Status：`inventory_updated`；STATE `model_sources_v15_non_h3_2026_09_10`；`updated_at` 2026-09-10T05:18:30+08:00。via 项目管家（ToIV 模型下载）。


### 2026-09-10（设备管家：LIVE — 三机 extrapaths toiv 补 style_models）
- **变更**：三机 `extra_model_paths` toiv 段加 `style_models: style_models`。
- **验收**：`/models/style_models` 计数均为 **2** — WS:8196 / pc01 `192.168.71.116`:8188 / pc02:8193；含 `flux1-redux-dev` + `flex1_redux_siglip2_512`。
- **影响**：解 v15 **假缺**（folder mount）；**未**扫 v16——等模型下载 v15 批次后再复扫 **v16**。
- Status：`live_device_fyi`；STATE `genpool_extrapaths_style_models_2026_09_10`；`updated_at` 2026-09-10T04:56:00+08:00。via 设备管家 / 项目管家。

### 2026-09-10（项目管家：gimmvfi 三端已清口径修正）
- **真机核（设备管家 SSH）**：WS `127:8196` `/models/frame_interpolation`、pc01 **`192.168.71.116:8188`**（勿用 .115）、pc02 `114:8193` 均含 `gimmvfi_r_arb_lpips_fp32.safetensors`（pc02 另含 rife*）。
- **口径**：gimmvfi **三端已清**（8196/8188/8193）；**作废**「8193 仍空不挡」。
- 无产品 SHA；不跑 v15b。STATE `capability_gap_scan_v15_2026_09_10` 同步；`updated_at` 2026-09-10T04:55:00+08:00。via 项目管家（设备管家核验 follow-up）。

### 2026-09-10（项目管家：capability_gap_scan_v15 完成）
- **主口径**：apps **922**；OK **235→242（+7）**；blocked **687→680（−7）**；unlocalizable **0**。
- **dedicated-aware**：**500→507（+7）**；only_h3 **265**。
- **worker models**：8196=**825**；8188=**806**；8193=**805**。
- **已清 newly_ok 7**：DarkBeast-Klein9b-V2-BFS-BF16 / flux1-dev.sft / Flux2 Klein动漫转写实… / Klein 一致性增强 / Flux2-Klein-9B-一致性V2 / ltx2.3-video-restoration-general-lora / 4x-ClearRealityV1。
- **gimmvfi**：**三端已清**（8196/8188/8193；设备管家 SSH 核：WS `/models/frame_interpolation` + pc01 `.116:8188` + pc02 `:8193` 均含 `gimmvfi_r_arb_lpips_fp32.safetensors`）；**不跑 v15b**。
- **仍缺 Top 非 H3**：Licon-MSR-V1_B / model.pt / new_flux-2-klein-9b(**7**) + 角色 LTX LoRA(**6**) + bfs rank128B / nvfp4(**5**)。
- **新 Top**：非 H3 缺模 ≤**7** apps；Top 缺节点仍 **H3/RH + TT/Comfly**。
- **真源**：`.regen_tmp/capability_gap_scan_v15/`（**勿 stage**）；tip `.regen_tmp/capability_gap_scan_v15/actionable/tip_for_project_steward.json`。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v15_2026_09_10`；`updated_at` 2026-09-10T04:46:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-10（项目管家：MODEL_SOURCES v14 非 H3 — ok454/blocked350/total804）
- **计数**：ok **454** / blocked **350** / total **804**（v14 非 H3 续下；前 tip d2816ac 447/357/804；Δ ok+7 / blocked−7）。
- **清单**：`docs/MODEL_SOURCES.md` + `MODEL_SOURCES.json` 已对齐；JSON `updated_at` 2026-09-10T04:40:53+08:00。
- **下载摘要**：newly_ok **7**；already_on_nas **13**；blocked_documented≈**20**（含 Licon-MSR-V1_B / new_flux-2-klein-9b / bfs…rank128B）；≈39.95GiB；**未**写 `h3/`。
- **真源**：`.regen_tmp/capability_gap_v14_download_summary.json`（**勿 stage**）。
- Status：`inventory_updated`；STATE `model_sources_v14_non_h3_2026_09_10`；`updated_at` 2026-09-10T04:42:30+08:00。via 项目管家（ToIV 模型下载）。


### 2026-09-10（项目管家：capability_gap_scan_v14 完成）
- **主口径**：apps **924→922**（软隐藏 −2）；OK **224→235（+11）**；blocked **687**；unlocalizable **0**。
- **dedicated-aware**：**491→500（+9）**；only_h3 **265**。
- **worker models**：8196=**817**；8188·8193=**798**。
- **已清 P0/P1**：FullDynamic_Ultimate_Fusion_Elite / Kook_Zimage_瑶光 / lightx2v_elite_it2v_animate_face / Flux2-Klein-9B-True-v2-bf16 / WAN22_MoCap_fullbodyCOPY_ED / Wan2.2-Fun-A14B-InP-Fusion-Elite。
- **仍缺命名**：LTX-2.3-Licon-MSR-V1_B(7)、new_flux-2-klein-9b(7)、bfs_head…rank128B(5)、gimmvfi_r_arb_lpips_fp32(7，疑 folder，已催设备)。
- **新 Top**：非 H3 缺模 ≤**7** apps；Top 缺节点仍 **H3/RH + TT/Comfly**。
- **真源**：`.regen_tmp/capability_gap_scan_v14/`（**勿 stage**）；tip `.regen_tmp/capability_gap_scan_v14/actionable/tip_for_project_steward.json`。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v14_2026_09_10`；`updated_at` 2026-09-10T04:32:00+08:00。via 项目管家（ToIV 开发 tip）。

### 2026-09-10（ToIV 模型下载：MODEL_SOURCES v13b 非 H3 — ok447/blocked357/total804）
- **计数**：ok **447** / blocked **357** / total **804**（v13b 非 H3 批次；前 436/368/804；Δ ok+11 / blocked−11）。
- **清单**：`docs/MODEL_SOURCES.md` + `MODEL_SOURCES.json` 已对齐；JSON `updated_at` 2026-09-10T04:25:36+08:00。
- **下载摘要**：newly_ok **11**；already_on_nas **2**；blocked_documented **5**；~60.5GiB；**未**写 `h3/`。
- **真源**：`.regen_tmp/capability_gap_v13b_download_summary.json`（**勿 stage**）。
- Status：`inventory_updated`；STATE `model_sources_v13b_non_h3_2026_09_10`；`updated_at` 2026-09-10T04:26:00+08:00。via ToIV 模型下载。


### 2026-09-10（ToIV 开发：H3 `:8195` T8后侧扫旁证）
- **对照**：v13b only_h3 **267** → :8195。
- **主匹配**：h3_ok **212** / still **55**（较 T8前 208/59，**+4/−4**）。
- **别名旁证**：h3_ok **265** / still **2**（turbo_T8 无源 1 + `MinimaxH3LatentUpscaler3D` 1）。
- **T8**：六节点 class_type **全 Y**（BlockCache/Sage/VRGDG + DualClock/AVDecode/AudioConditioning）。
- **:8195 nodes**：**967→1753**；权重结案仍 **Y34/N3**。
- **soft-hide**：别名残 2 已 hide（`rh-acc-1201993730-d1b241`、`rh-acc-8038814721-b7052e`）；公开约 **956→954**；别名旁证 only_h3 **265** 可跑口径成立。
- **真源**：`.regen_tmp/capability_gap_scan_v13b/actionable/h3_8195_side_scan_t8/`（**勿 stage**）。
- Status：`side_scan_post_t8_docs`；STATE `h3_8195_side_scan_t8_2026_09_10`；`updated_at` 2026-09-10T04:21:10+08:00。via ToIV 开发。


### 2026-09-10（设备管家：LIVE — H3:8195 T8/blockcache/KJNodes/vrgamedevgirl 装齐）
- **范围**：仅 **h3-eval**（`:8195`）；**未**进通用池。
- **Earlier**：`T8mars/comfyui-minimax-h3-audio-T8` @ `e4ff860`；DualClock / AVDecode / AudioConditioning T8 = **Y**。
- **Now**：blockcache-T8 @ `36336dce`；KJNodes @ `57105374`；vrgamedevgirl @ `c85fda6d`。
- **验收**：目标 `class_type` **全 Y**；T8 / Sage / VRGDG 节点**齐**。
- **旁证**：~~侧扫由能力缺口再跑~~ → **T8后侧扫已完成**（见新 tip：主 212/55；别名 265/2 + soft-hide）。
- Status：`live_device_fyi`；STATE `h3_8195_t8_nodes_2026_09_10`；`updated_at` 2026-09-10T04:16:30+08:00。via 设备管家。


### 2026-09-10（ToIV 开发：capability_gap_scan_v13b 完成）
- **主口径**：apps **924**；OK **210→224（+14）**；blocked **700**；unlocalizable **0**。
- **dedicated-aware**：**477→491（+14）**；only_h3 **267**。
- **worker models**：8196=**806**；8188·8193=**787**。
- **folder 目标全清**：ltx spatial 1.1/1.0、MelBandRoformer_fp16、Qwen3.5-9B*（extrapaths 生效）。
- **MODEL_FOLDERS**：含 `latent_upscale_models` / `vocal_separator` / `MelBandRoFormer` / `LLM`（扫描已对齐）。
- **新 Top**：非 H3 缺模 ≤**7** apps；Top 缺节点仍 **H3/RH + TT/Comfly**。
- **真源**：`.regen_tmp/capability_gap_scan_v13b/`（**勿 stage**）。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v13b_2026_09_10`；`updated_at` 2026-09-10T04:15:00+08:00。via ToIV 开发。


### 2026-09-10（设备管家：LIVE — 通用池 extrapaths 补 LLM/vocal_separator/MelBandRoFormer）
- **变更**：通用池 `extra_model_paths` 加 `LLM` / `vocal_separator` / `MelBandRoFormer`；并 patch llama-cpp **勿覆盖** LLM 路径。
- **影响**：解开 v13 still_missing 中似 folder-mount 项（MelBandRoformer_fp16 / Qwen3.5-9B* 相关；ltx spatial 或仍另轨）。**未**扫 v13b——仅 mount/路径修复。
- **旁证**：~~T8前 only_h3 **267→h3_ok 208 / still 59**（deferred）~~ → **T8后侧扫** 主 **212/55**、别名 **265/2**（见新 tip）；原 N3 中 **2 不挡**、T8 turbo **挡 1**；结案仍 **Y34/N3**；真源旧 `.../h3_8195_side_scan/` + 新 `.../h3_8195_side_scan_t8/`（**勿 stage**）。
- Status：`live_device_fyi`；STATE `genpool_extrapaths_llm_vocal_melband_2026_09_10`；`updated_at` 2026-09-10T04:08:00+08:00。via 设备管家。


### 2026-09-10（ToIV 开发：H3 `:8195` 复验结案 + H3补齐关闭）
- **复验**：Y=**34** / N=**3**（共 **37**；+14 vs 初验 Y20/N17）。
- **latent**：bf16 + fp16 **皆 Y**。
- **下载**：新下 **13** OK ~121GiB → `h3/`；无源 blocked **3** 结案（与复验 N=3 一致）。
- **通用池 mount**：已补 LLM/vocal_separator/MelBandRoFormer（见新 tip）；ltx spatial 或仍另轨；**未**扫 v13b；两轨勿混。
- **真源**：`.regen_tmp/.../h3_8195_audit_live_reverify.json`（**勿 stage**）。
- Status：`h3_buqi_reverify_closed`；STATE `h3_8195_reverify_2026_09_10`；`updated_at` 2026-09-10T03:56:00+08:00。via ToIV 开发。

### 2026-09-10（ToIV 模型下载：MODEL_SOURCES H3 dedicated — ok436/blocked368/total804）
- **计数**：ok **436** / blocked **368** / total **804**（H3 dedicated 批次；前 422/365/787）。
- **清单**：`docs/MODEL_SOURCES.md` + `MODEL_SOURCES.json` 已对齐。
- **路径**：写入仅 `h3/`；真源 `.regen_tmp/h3_8195_download_summary.json`（**勿 stage**）。
- Status：`inventory_updated`；STATE `model_sources_h3_8195_2026_09_10`；`updated_at` 2026-09-10T03:56:00+08:00。via ToIV 模型下载。

### 2026-09-10（ToIV 开发：capability_gap_scan_v13 完成）
- **主口径**：apps **924**；OK **206→210（+4）**；blocked **714**；unlocalizable **0**。
- **dedicated-aware**：**457→477（+20）**；only_h3 **251→267**。
- **worker models**：8196=**760**；8188·8193=**711**（各+10）。
- **已清**：`qwen3-vl-32b-int8_convrot`、`Kook_Zimage_真实幻想_Turbo`。
- **仍缺 P0/P1**：多为 folder mount（ltx spatial 1.1/1.0、MelBandRoformer_fp16、Qwen3.5-9B*）→ 通用池 extrapaths 已补（见新 tip）；**未**扫 **v13b**（v13 非终局）。
- **真源**：`.regen_tmp/capability_gap_scan_v13/`（**勿 stage**）。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v13_2026_09_10`；`updated_at` 2026-09-10T03:56:00+08:00。via ToIV 开发。

### 2026-09-10（ToIV 模型下载：MODEL_SOURCES v12 非 H3 — ok422/blocked365/total787）
- **计数**：ok **422** / blocked **365** / total **787**（v12 非 H3 批次；前 412/375/787）。
- **清单**：`docs/MODEL_SOURCES.md` + `MODEL_SOURCES.json` 已对齐。
- **下载摘要（ToIV 开发）**：newly_ok **11**；already_on_nas **38**；blocked/refresh **23**；vague skip **4**；remaining_open **305**。
- **后续**：设备核可见性后 **v13**；真源 `.regen_tmp/capability_gap_v12_download_summary.json`（**勿 stage**）。
- Status：`inventory_updated`；STATE `model_sources_v12_non_h3_2026_09_10`；`updated_at` 2026-09-10T03:50:00+08:00。via ToIV 模型下载 / ToIV 开发。

### 2026-09-10（ToIV 开发：H3 `:8195` 权重验收）
- **结果**：Y=**20** / N=**17**（共 **37**）。
- **齐**：核心日用（vae / fl2va·ref2va pruned / nvfp4 te）。
- **缺 17**：多为 turbo/fp8/T8/10Eros 变体 + `latent_upscaler`（通用 NAS 有 bf16；H3 yaml 曾未挂 `latent_upscale_models`——**已补**（见设备补齐））。
- **后续**：缺清单已转模型下载仅 `h3/` 路径；真源 `.regen_tmp/.../h3_8195_audit_live.md`（**勿 stage**）。
- **设备补齐（设备管家）**：H3 `ComfyUI-h3-eval` `extra_model_paths` 已加 `latent_upscale_models`；bf16 upscaler **硬链**到 `toiv/.../h3/`。
- **可见性（ToIV 开发）**：`latent_upscaler` **bf16** 在 `:8195` 已可见（yaml+硬链）；**fp16 仍缺**。
- Status：`audit_done_docs`（无产品 SHA）；STATE `h3_8195_weight_audit_2026_09_10`；`updated_at` 2026-09-10T03:40:00+08:00。via ToIV 开发。

### 2026-09-10（ToIV 开发 / 设备管家：capability_gap_scan_v12 完成）
- **主口径**：apps **925→924**；OK **200→206（+6）**；blocked **718**；unlocalizable **0**。
- **dedicated-aware**：**451→457**（only_h3 仍 **251**）。
- **RMBG**：缺模榜已清（`extra_model_paths` RMBG 生效）；原 10 卡中 **3 OK / 7** 仍因其他缺口 blocked。
- **扫描**：固化 `MODEL_FOLDERS+=RMBG` + 目录名匹配。
- **Top 缺模**仍几乎全 **H3 专用**；挂起 TT/Bjornulf/VRAM 维持；无新通用池真缺模增量。
- **真源**：`.regen_tmp/capability_gap_scan_v12/`（**勿 stage**）。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v12_2026_09_10`；`updated_at` 2026-09-10T03:25:00+08:00。via ToIV 开发 / 设备管家。

### 2026-09-10（设备管家：LIVE — 生图池 extrapaths toiv 补 RMBG）
- **变更**：生图池 `extra_model_paths` toiv 段加 `RMBG: RMBG`。
- **验收**：四端 `/models/RMBG` 已列 **RMBG-2.0**。
- Status：`live_device_fyi`；STATE `genpool_extrapaths_rmbg_2026_09_10`；`updated_at` 2026-09-10T03:20:00+08:00。via 设备管家。（设备核 folder 齐；可扫 v12。）

### 2026-09-10（ToIV 模型下载：MODEL_SOURCES RMBG-2.0 — ok412/blocked375/total787）
- **计数**：ok **412** / blocked **375** / total **787**（RMBG-2.0 落入后；前 411/376/787）。
- **清单**：`docs/MODEL_SOURCES.md` + `MODEL_SOURCES.json` 已对齐（header 同步 JSON）。
- **落盘（ToIV 开发）**：`NAS/toiv/comfyui-models/RMBG/RMBG-2.0/model.safetensors` **884878856B**；设备核 folder 后能力缺口 **v12**。
- Status：`inventory_updated`；STATE `model_sources_rmbg20_2026_09_10`；`updated_at` 2026-09-10T03:16:00+08:00。via ToIV 模型下载。

### 2026-09-10（ToIV 开发：capability_gap_scan_v11 完成）
- **主口径**：apps **934→925**；OK **191→200（+9 vs v10）**；blocked **725**；unlocalizable **0**。
- **旁路 dedicated-aware**（不改主 ok）：only_h3 **251** → dedicated_aware_ok **451**；仍 blocked **474**；only_qe **0**。
- **P2**：已清节点见 REPORT；挂起 TT/Bjornulf/VRAM；RMBG-2.0 仍缺 **10** apps。
- **另**：未推 tip `d7aae62` 已双推；又 soft-hide hang-only 残 1 张 `rh-acc-0600098818-f3e460`（公开约 **957→956**）。
- **真源**：`.regen_tmp/capability_gap_scan_v11/`（**勿 stage**）。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v11_2026_09_10`；`updated_at` 2026-09-10T03:01:00+08:00。via ToIV 开发。

### 2026-09-08（设备管家：LIVE — 通用池 P2 装 audio-separation/RMBG/comfy-image-saver(+InpaintCropAndStitch/GIMM-VFI/SAM2)）
- **已装**：audio-separation/RMBG/comfy-image-saver(+InpaintCropAndStitch/GIMM-VFI/SAM2)。
- **挂起/跳过**：TT_img_enc/Bjornulf/VRAMReserver（原因见补注）。
- **补注（ToIV 开发）**：已装验收 **AudioCrop/RMBG/String Literal(+InpaintCropImproved/GIMM/SAM2)** 四端 Y。
  - **未装原因**：`TT_img_enc*` — 上游 `liangtongt/TT-tools` 已删，无唯一同名映射；`Bjornulf_ShowInt` — `justUmen/Bjornulf_custom_nodes` 有同名但巨型包硬依赖，风险高跳过；`VRAMReserver` — 无精确 `class_type` 注册（`ReservedVRAMSetter` 不算）。
  - **soft-hide**：仅卡上述未装节点的 **9** app 已 soft-hide（公开约 **966→957**）；RMBG-2.0 权重在模型下载；v11 进行中。
- Status：`live_device_fyi`；STATE `general_pool_p2_audio_rmbg_2026_09_08`；`updated_at` 2026-09-08T23:37:00+08:00。via 设备管家。

### 2026-09-08（ToIV 开发：capability_gap_scan_v10 完成）
- **结果**：apps **934**；OK **185→191（+6）**；累计 v8:163→191（+28），v1:58→191。
- **blocked**：**743**（models_only 382 / nodes_only 108 / both 253）；unlocalizable **0**；fetch_errors **0**。
- **worker nodes** ≈**3561**/**3441**/**3391**；**P1 八类**退出全局缺节点。
- **Top 缺节点**仍以 **H3 专用**为主（通用扫描口径；`:8195` 已有 RHMiniMax 不计入）。
- **后续**：下一波 P2 须核同名 → `.regen_tmp/capability_gap_scan_v10/actionable/next_wave_after_v10.md`；已令设备管家；真源 `.regen_tmp/capability_gap_scan_v10/`（**勿 stage**）。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v10_2026_09_08`；`updated_at` 2026-09-08T22:51:00+08:00。via ToIV 开发。

### 2026-09-08（设备管家：LIVE — 通用池 P1 装 WhatDreamsCost/Frame-Interpolation/Stand-In/LayerStyle+Advance）
- **已装**：WhatDreamsCost/Frame-Interpolation/Stand-In/LayerStyle+Advance。
- **验收**：相关 `class_type` 四端齐。
- Status：`live_device_fyi`；STATE `general_pool_p1_whatdreamscost_2026_09_08`；`updated_at` 2026-09-08T22:45:00+08:00。via 设备管家。

### 2026-09-08（ToIV 开发：capability_gap_scan_v9 完成）
- **口径**：通用三机 `8196`/`8188`/`8193`；**未并** `8194`/`8195`。
- **结果**：apps **1050→934**；OK **163→185（+22）**；blocked **749**（models_only 370 / nodes_only 114 / both 265）；fetch_errors **0**。
- **unlocalizable**：**61→0**（RHHidden 已出公开扫描集）。
- **worker nodes** ≈**3453**/**3331**/**3287**（较 v8 +~70）。
- **P0 五包**已退出全局缺节点；Top 缺节点仍以 **H3 专用**为主（预期）；杂项见 `.regen_tmp/capability_gap_scan_v9/actionable/next_wave_after_v9.md`。
- **后续**：已令设备管家装 **P1**；**P2** 核同名；产品 dirty **未 commit**；真源 `.regen_tmp/capability_gap_scan_v9/`（**勿 stage**）。
- Status：`scan_complete_docs`（无产品 SHA）；STATE `capability_gap_scan_v9_2026_09_08`；`updated_at` 2026-09-08T22:12:00+08:00。via ToIV 开发。

### 2026-09-08（设备管家：LIVE — 通用池 P0 装 ComfyMath/MelBandRoFormer/SDPose-OOD/Licon-MSR/Florence2）
- **已装**：ComfyMath/MelBandRoFormer/SDPose-OOD/Licon-MSR/Florence2。
- **验收**：四端相关 `class_type` 齐。
- Status：`live_device_fyi`；STATE `general_pool_p0_misc_comfymath_2026_09_08`；`updated_at` 2026-09-08T22:07:00+08:00。via 设备管家。（capability gap 下一波杂项；v9 可扫，见 STATE `capability_gap_soft_hide_dedicated_pool_2026_09_08`。）

### 2026-09-08（ToIV 开发：LIVE on core dirty — capability gap 收口；软隐藏+专池路由）
- **软隐藏**：不可本地化应用 RHHiddenNodes + 裸 Text，union≈**100** → `is_public=false`；core DB `app` 公开≈**982** / 非公开≈**1313** / 总≈**2295**（相对此前列表页约 1050→950 量级；以 DB 为准）。
- **`_pick_app_client` 扩路由 LIVE on core**（`deploy --skip-web` 成功，api health OK）：
  - H3（二次扩，已 redeploy `--skip-web`）：`RHMiniMaxH3*` + `RH_MinimaxHailuoH3*`；任意 `class_type` 含 `MiniMaxH3|MinimaxH3|HailuoH3` → `TOIV_H3_BASE_URL`=`http://192.168.71.127:8195`（system_stats 200）。
  - QwenEdit：扩 Advance/Custom/EditUtils + 启发式，排除 AILab_QwenVL/Qwen3_VQA 等 → 默认 `http://192.168.71.114:8194`（system_stats 200；core `.env` 未显式写 `TOIV_QWEN_EDIT_BASE_URL`，走 config 默认）。
- **能力扫描累计 OK**：v1 **58** → v8 **163**（+105）。下一波杂项清单：`.regen_tmp/capability_gap_scan_v8/actionable/next_wave_misc_packages.md`（装齐后扫 v9）。
- **通用池 workers 仍**：`127:8196` / `116:8188` / `114:8193`。
- **勿 stage**：`.regen_tmp` / 产品 dirty / `rh_h3_presets.json`。
- **设备验收（设备管家）**：H3 专用 `http://192.168.71.127:8195`（`minimax_h3_*`+`MiniMaxH3*` OK）；QwenEdit 专用 `http://192.168.71.114:8194`（EditUtils OK，Advance 已 Y（见进度））。
- **补注（ToIV 开发）**：`RHMiniMaxH3*` **有公开包、非 unlocalizable**：`HM-RunningHub/ComfyUI_RH_MinMaxH3`（或 `RH-RunningHub/ComfyUI-RH-MiniMax-H3`）；设备管家仅装 H3 `:8195`。QwenEdit Advance 缺 → 装 **QwenEditUtils** 于 `:8194`；装齐后扫 **v9**。
- **进度（ToIV 开发）**：QwenEdit `:8194` **Advance 已 Y**（`Comfyui-QwenEditUtils`）；H3 RH 包已在 `:8195` 独占装齐；通用 P0 **未齐**，**v9 仍等**。
- **设备确认（设备管家）**：H3 `:8195` **独占** `ComfyUI_RH_MinMaxH3`；`RHMiniMaxH3*` **Y**；**通用池无**。QwenEdit `:8194` Advance 已齐（与进度一致）。
- **细化（ToIV 开发）**：H3 `:8195` 独占 `ComfyUI_RH_MinMaxH3` @ **`d6c5f7b0`** → `RHMiniMaxH3*` **33 class Y**；通用池未装。`RH_MinimaxHailuoH3*` **无同名** → **16** app soft-hide（市场公开 **982→966**）。QwenEdit Advance 已 Y；P0 未齐，v9 仍等。
- Status：`live_on_core_dirty`（**无产品 commit SHA**；产品树仍 dirty 未推）；STATE `capability_gap_soft_hide_dedicated_pool_2026_09_08`；`updated_at` 2026-09-08T21:50:00+08:00。via ToIV 开发。

### 2026-09-08（设备管家：LIVE — 通用池装 SoundFlow/LG_Tools/art-venture）
- **已装**：SoundFlow + LG_Tools + art-venture。
- **验收**：三 `class_type` 四端齐。
- Status：`live_device_fyi`；STATE `general_pool_soundflow_lg_artventure_2026_09_08`；`updated_at` 2026-09-08T20:17:00+08:00。via 设备管家。

### 2026-09-08（设备管家：LIVE — 通用池装 cg-use-everywhere/Qwen3-VL-Instruct/Crystools）
- **已装**：cg-use-everywhere + Qwen3-VL-Instruct + Crystools。
- **验收**：四端相关 `class_type` 齐。
- **无同名**：`Qwen3_VQA_Plus`。
- Status：`live_device_fyi`；STATE `general_pool_cg_qwen3vl_crystools_2026_09_08`；`updated_at` 2026-09-08T19:51:00+08:00。via 设备管家。

### 2026-09-08（设备管家：LIVE — 通用池 P0 装 mixlab/Derfuu/QwenVL/PainterFlux/MemoryCleaner）
- **已装 P0**：mixlab/Derfuu/QwenVL/PainterFlux/MemoryCleaner。
- **未解**：Text 同名未解（KayTool 未批）。
- Status：`live_device_fyi`；STATE `general_pool_p0_custom_nodes_2026_09_08`；`updated_at` 2026-09-08T19:17:00+08:00。via 设备管家。

### 2026-09-08（设备管家：LIVE — 生图池装 WanAnimatePreprocess/TTP_Toolset/llama-cpp）
- **已装**：WanAnimatePreprocess + TTP_Toolset + llama-cpp。
- **验收**：四端相关 `class_type` 齐。
- **无同名开源**：`YOLOModelLoader`。
- Status：`live_device_fyi`；STATE `genpool_wananimate_ttp_llamacpp_2026_09_08`；`updated_at` 2026-09-08T18:27:00+08:00。via 设备管家。

### 2026-09-08（ToIV 模型下载：LIVE — MODEL_SOURCES capability_gap_v3_v4）
- **路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（根目录无 `MODEL_SOURCES*`）。
- **计数**：ok **411** / blocked **376** / total **787**（前 381/384/765）；updated `2026-09-08T18:17:37+08:00`。
- **批次**：能力缺口 v3/v4（含 `capability_gap_v3_batch1` 段：本轮新下 13 + 已在 NAS 文档化 4 等）。
- **维护**：后续每批下载追加这两份；true gaps 仍为 0；可本地化缺口清零口径仍有效。
- Status：`inventory_updated_capability_gap_v3_v4`；STATE `model_sources_inventory_2026_09_08`；`updated_at` 2026-09-08T18:18:00+08:00。via ToIV 模型下载。

### 2026-09-08（设备管家：LIVE — 生图池 extra_model_paths toiv 补 onnx/detection）
- **需加键**：`onnx: onnx`、`detection: detection`（toiv 段）。
- **PC NAS 另有**：`onnx: models/onnx`。
- **验收**：2026-09-08 四端 `/models/onnx` 已列 `yolov10m`。
- Status：`live_device_fyi`；STATE `genpool_extra_model_paths_onnx_detection_2026_09_08`；`updated_at` 2026-09-08T18:00:00+08:00。via 设备管家。

### 2026-09-08（设备管家：LIVE — 生图池批量装优先包；四端 Top class_type 齐）
- **优先包**：SDVN/Comfyroll/rgthree/SeedVR2/Custom-Scripts/controlnet_aux/various/GGUF/WAS。
- **验收**：四端 Top `class_type` 齐；`Text Multiline` = WAS Suite。
- Status：`live_device_fyi`；STATE `genpool_priority_custom_nodes_2026_09_08`；`updated_at` 2026-09-08T17:39:00+08:00。via 设备管家。

### 2026-09-08（设备管家：LIVE — pc01/pc02 extra_model_paths toiv 补 SEEDVR2/pose）
- **文件**：pc01/pc02 `C:\ComfyUI\extra_model_paths.yaml` 的 `toiv` 段（同 WS）。
- **已加键**：`SEEDVR2: SEEDVR2`、`pose: pose`。
- **生效**：2026-09-08 已加并 `schtasks` 重启。
- Status：`live_device_fyi`；STATE `pc_extra_model_paths_seedvr2_pose_2026_09_08`；`updated_at` 2026-09-08T17:28:00+08:00。via 设备管家；对齐 WS tip `ws_extra_model_paths_seedvr2_pose_2026_09_08`。

### 2026-09-08（设备管家：LIVE — WS extra_model_paths toiv 补 SEEDVR2/pose）
- **文件**：WS `/opt/ComfyUI/extra_model_paths.yaml` 的 `toiv` 段。
- **已加键**：`SEEDVR2: SEEDVR2`、`pose: pose`（对应 `nas_mount/toiv/comfyui-models/{SEEDVR2,pose}`）。
- **生效**：2026-09-08 已加并重启 `gpu0-alt:8196`。
- Status：`live_device_fyi`；STATE `ws_extra_model_paths_seedvr2_pose_2026_09_08`；`updated_at` 2026-09-08T17:11:00+08:00。via 设备管家。

### 2026-09-08（ToIV 模型下载：LIVE — MODEL_SOURCES capability_gap_batch1）
- **路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（根目录无 `MODEL_SOURCES*`）。
- **计数**：ok **381** / blocked **384** / total **765**（前 370/383/753）；updated `2026-09-08T16:55:00+08:00`。
- **批次**：能力缺口 batch1（含 local-alias / HF dir 快照等；true gaps 仍为 0）。
- **维护**：后续每批下载追加这两份；可本地化缺口清零口径仍有效（missing 737→0）。
- Status：`inventory_updated_capability_gap_batch1`；STATE `model_sources_inventory_2026_09_08`；`updated_at` 2026-09-08T17:00:00+08:00。via ToIV 模型下载。

### 2026-09-08（设备管家：LIVE — pc01 Comfy 启动前须挂 NAS 正确 share）
- **必做**：启动前 `net use \\192.168.71.7\NAS`（**share 名 `NAS`，不是 `dgmt-nas`**）。
- **脚本已改**：`start_comfyui.ps1` + `MountNAS`（按正确 share 挂载）。
- **验收**：修复后模型计数对齐 WS≈**581**。
- Status：`live_ops_required`；STATE `pc01_nas_netuse_share_nas_2026_09_08`；`updated_at` 2026-09-08T16:52:00+08:00。via 设备管家；此前「临时 net use 恢复」升级为本活口径。

### 2026-09-08（ToIV 模型下载：LIVE — MODEL_SOURCES qwen_edit_pc01_sync）
- **路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（根目录无 `MODEL_SOURCES*`）。
- **计数**：ok **370** / blocked **383** / total **753**（前 368/383/751）；updated `2026-09-08T16:25:00+08:00`。
- **增量**：Qwen Edit pc01 同步后追加 `qwen_2.5_vl_7b_fp8_scaled.safetensors` + `qwen_image_vae.safetensors`（NAS hardlink + robocopy → pc01）。
- **维护**：后续每批下载追加这两份；可本地化缺口清零口径仍有效（missing 737→0）。
- Status：`inventory_updated_qwen_edit_pc01`；STATE `model_sources_inventory_2026_09_08`；`updated_at` 2026-09-08T16:27:00+08:00。via ToIV 模型下载。

### 2026-09-08（设备管家：LIVE — 生图/视频 worker 节点装齐；pc01 NAS 临时恢复）
- **已装 custom nodes（生图/视频 worker）**：WanVideoWrapper + LayerStyle + ComfyLiterals(Int) + Easy-Use。
- **无法本地装**：RHHiddenNodes（不可本地化）。
- **pc01 NAS UNC**：~~已临时 `net use` 恢复~~ → 见上条：启动前须 `net use \\192.168.71.7\NAS` （share=`NAS` 非 `dgmt-nas`）；`start_comfyui.ps1`+`MountNAS` 已改；WS≈581。
- Status：`live_device_fyi`；STATE `worker_custom_nodes_pc01_nas_2026_09_08`；`updated_at` 2026-09-08T13:51:00+08:00。via 设备管家；细节以设备侧矩阵为准。

### 2026-09-08（ToIV 模型下载+设备管家：LIVE — MODEL_SOURCES batch16 清尾；可本地化缺权重清零）
- **路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（根目录无 `MODEL_SOURCES*`）。
- **计数**：ok **368** / blocked **383** / total **751**（前 339/352/691）；updated `2026-09-08T07:10:35+08:00`。
- **清尾**：市场可本地化缺口已清零（原扫缺 missing **737** → **0**）；blocked 为 gated/无溯源/近名（Klein 社区 SKU、BFL Kontext/krea gated、GGUF/无溯源、精度近名等）。
- **细节路径**：`ALLProject/ToIV/.regen_tmp/` 与 `NAS/toiv/comfyui-models`（含 `SOURCES.md` 短索引）。
- **维护**：后续每批下载追加这两份。
- Status：`inventory_updated_batch16_gap_cleared`；STATE `model_sources_inventory_2026_09_08`；`updated_at` 2026-09-08T07:13:00+08:00。via 设备管家+ToIV 模型下载。

### 2026-09-08（ToIV 模型下载：LIVE — MODEL_SOURCES batch15 计数更新）
- **路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（根目录无 `MODEL_SOURCES*`）。
- **计数**：ok **339** / blocked **352** / total **691**（前 321/264/585）；updated `2026-09-08T06:43:56+08:00`。
- **维护**：后续每批下载追加这两份。
- Status：~~`inventory_updated_batch15`~~ → 见上条 batch16；STATE `model_sources_inventory_2026_09_08`；原 `updated_at` 2026-09-08T06:44:00+08:00。

### 2026-09-08（ToIV 模型下载：LIVE — MODEL_SOURCES batch14 计数更新）
- **路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（根目录无 `MODEL_SOURCES*`）。
- **计数**：ok **321** / blocked **264** / total **585**（前 292/159/451）；updated `2026-09-08T06:17:23+08:00`。
- **维护**：后续每批下载追加这两份。
- Status：~~`inventory_updated_batch14`~~ → 见上条 batch15；STATE `model_sources_inventory_2026_09_08`；原 `updated_at` 2026-09-08T06:18:00+08:00。

### 2026-09-08（ToIV 模型下载：LIVE — MODEL_SOURCES batch13 计数更新）
- **路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（根目录无 `MODEL_SOURCES*`）。
- **计数**：ok **292** / blocked **159** / total **451**（前 262/130/392）；updated `2026-09-08T05:46:49+08:00`。
- **维护**：后续每批下载追加这两份。
- Status：~~`inventory_updated_batch13`~~ → 见上条 batch14；STATE `model_sources_inventory_2026_09_08`；原 `updated_at` 2026-09-08T05:47:00+08:00。

### 2026-09-08（ToIV 模型下载：LIVE — MODEL_SOURCES batch12 计数更新）
- **路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（根目录无 `MODEL_SOURCES*`）。
- **计数**：ok **262** / blocked **130** / total **392**（前 239/120/359）；updated `2026-09-08T05:20:38+08:00`。
- **维护**：后续每批下载追加这两份。
- Status：~~`inventory_updated_batch12`~~ → 见上条 batch13；STATE `model_sources_inventory_2026_09_08`；原 `updated_at` 2026-09-08T05:21:00+08:00。

### 2026-09-08（ToIV 模型下载：LIVE — MODEL_SOURCES 清单已落入 docs）
- **路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（根目录无 `MODEL_SOURCES*`）。
- **计数**：ok **239** / blocked **120** / total **359**；updated `2026-09-08T04:59:25+08:00`。
- **维护**：后续每批下载追加这两份；WIP 仍可镜像 `.regen_tmp/`；NAS 短索引 `toiv/comfyui-models/SOURCES.md`。
- **口径**：URL 不发明，仅从下载日志复制；覆盖 NAS 落盘路径 + HF/Civitai/RH/本地出处。
- Status：~~`inventory_landed`~~ → 见上条 batch12；STATE `model_sources_inventory_2026_09_08`；原 `updated_at` 2026-09-08T05:00:00+08:00。

### 2026-09-08（项目管家：CONV — 模型/内容下载来源清单稳定路径）
- **用户要求**：模型/内容下载须维护带来源的清单（供更新与查文档）。ToIV 模型下载正在撰写。
- **稳定路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（仓内；就绪后提交）。**根目录仍只留五件套**。
- **维护**：ToIV 模型下载；项目管家五件套只引用此路径。WIP → `.regen_tmp/`。
- **边界**：不替代 `engine_registry` / `model_wiki` / admin KG / `model_profiles`。
- Status：~~`convention_set_awaiting_inventory`~~ → **`inventory_landed`**（见上条）；原 STATE `model_sources_inventory_convention_2026_09_08`；`updated_at` 2026-09-08T04:56:00+08:00。本 commit 只定路径，清单正文另由下载 bot 落入 `docs/`。

### 2026-09-08（ToIV 开发：LIVE — 市场左侧空白已修上 core）
- **LIVE**：市场左侧空白已修上 core；BUILD_ID `20260907-203017-6417f2a-dirty`；产品树 dirty 无独立 SHA。
- **根因**：空 `.rh-col` 仍 flex 占宽（**非** IO/刷新问题）。
- **修复**：容器 `ResizeObserver` + 跳过空列 + 重置 placement。
- 叠在市场瀑布流无感追加之上（further of `market_waterfall_seamless_append`）。
- Status：`live_on_core_dirty`；STATE `market_left_blank_fix_2026_09_08`；`updated_at` 2026-09-08T04:32:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

### 2026-09-08（ToIV 开发：LIVE — 表单媒体/HF/封面/presets 收口；市场≈1083）
- **表单媒体**：Animate V8 **15→16**（视频+图）；127 双输入 rh-acc gap **0**；demo 本地 **182**，defaults **127/127**。
- **功能封面**：+**15**（非 NSFW `/covers/generate`）。
- **HF**：应用侧清完（藏 `Flux-文生图-96c82d`）；模型库未动。
- **presets**：MateBook+core `rh_h3_presets.json`=`[]`；`presets_anti_resurrect=cleared_empty_array`；误种 soft-hide **959**；市场可见≈**1083**，rh-acc **837**，rh-h3/minimax listed **0**。
- **SFW/R18**：9 dual-mode parents；twin soft-hide（见 `r18_merge`）。
- Status：`done`；STATE `rh_form_media_hf_covers_2026_09_08`；报告 `.regen_tmp/rh-form-media-hf-covers-20260908.md`（勿提交）；`updated_at` 2026-09-08T04:04:00+08:00。产品树 dirty 未 commit 产品码；远程未推。勿 stage product/`.regen_tmp`/`rh_h3_presets.json`。

### 2026-09-08（ToIV 开发：LIVE — SFW/NSFW 合并已上 core dirty partial）
- **LIVE**：SFW/NSFW 合并已上 core dirty（partial）；BUILD_ID `20260907-195752-2a1c833-dirty`；**9** 对合并；封面双标（SFW+NSFW）；应用内切换；twin soft-hide。
- **残留**：LTX / wan-nsfw 等未并。
- **watch / presets**：MateBook+core 已 `[]`；`presets_anti_resurrect=cleared_empty_array`；误种 soft-hide **959**（**勿 stage** 产品文件 / `.regen_tmp` / `rh_h3_presets.json`）。
- Status：`live_on_core_dirty_partial`；STATE `r18_merge_into_sfw_2026_09_08`；features={dual_tags, in_app_toggle, twin_soft_hide}；merged_pairs=9；residual=[ltx_nsfw, wan_nsfw,…]；watch=`presets_anti_resurrect_cleared_empty_array`；presets_anti_resurrect=`cleared_empty_array`；soft_hide_mistaken_reseed=959；`updated_at` 2026-09-08T04:04:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

### 2026-09-08（ToIV 开发：LIVE — 家族模板 wipe1166 + 准确重入131 COMPLETE；rh-acc≈837）
- **Wipe**：删 **1166** 家族模板克隆（`rh-h3` / `rh-minimax*`）；Postgres DELETE（admin API 对 builtin 403）；**防复活**已清空 `apps/api/app/data/rh_h3_presets.json`（bak 保留；路径仅记文档，**勿提交**）。
- **准确重入**：+**131**；跳过 **360**（`detail_code_901`×289 + `null_workflowId`×71）；错误 **0**；直播 rh-acc ≈ **837**；抽检 **12/12**。
- **KEEP**：原 rh-acc + 产品 h3-* builtins；家族克隆 **0**。
- **新 131 表单 repair**：updated **91** / unchanged **40** / with_select **83**。
- Status：`wipe_reseed_done`；STATE `rh_form_cover_fidelity_2026_09_08` + `rh_family_wipe_accurate_reseed_2026_09_08`；报告 `.regen_tmp/rh-family-wipe-accurate-reseed-20260908.md`（勿提交）；`updated_at` 2026-09-08T03:21:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

### 2026-09-08（ToIV 开发：LIVE — 封面效果对齐完成；修35；剩18待真出图）
- **封面效果对齐**：rh-acc **全 RH CDN**；修 **35**（5 rh-acc mp4→still CDN + 30 builtin 上传 RH 图）；剩约 **18** 无 RH 映射 builtin 待真出图（**禁** NSFW `/covers/generate` 渐变）。
- 可见 apps ≈ **811**；rh-acc 期间 sibling reseed **706→763**；市场家族 `rh-h3` 克隆当前 **0**；家族 wipe/reseed **已完成**（见上条 wipe1166+重入131；rh-acc≈837）。
- Status：`done_18_pending_real_art`；STATE `cover_effect_align_2026_09_08`；报告 `.regen_tmp/cover-effect-align-20260908.md`（勿提交）；`updated_at` 2026-09-08T03:12:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — RH 表单封面保真调研完成；拍板 wipe→准确重入库；~~执行中~~ → COMPLETE 见上条）
- **rh-acc 保真修复**：扫描 **706**；修 **168** / 已齐 **529** / skip `code_901` **9** / errors **0**；封面多为 RH CDN（**706/706**）；封面改写仅 **2**。LIST→select 修复；去 graph fallback 多余字段。
- **真正错位主因**：约 **1166** 家族模板克隆（`rh-h3` / `rh-minimax*`，无 `webappId`，本地海报封面）——非 rh-acc 丢 UI 元数据。
- **用户拍板（~~执行中~~ → COMPLETE）**：wipe 家族 `rh-h3` / `rh-minimax*` 模板克隆 → 按 RH 准确图+原表单重入库；**保留** `rh-acc` 与产品 builtin。**已完成**：删 **1166** / 重入 **131** / 跳过 **360** / rh-acc≈**837** / 抽检 **12/12** / 家族克隆 **0**（详见上条 wipe+reseed LIVE）。
- 仍待后续：非 ASCII binding / 缺导出节点 / 图槽 demo / `code_901`。
- Status：~~`decided_executing`~~ → **`wipe_reseed_done`**；decision=`wipe_family_clones_accurate_reseed`；keep=`rh-acc + product builtins`；STATE `rh_form_cover_fidelity_2026_09_08` + `rh_family_wipe_accurate_reseed_2026_09_08`；报告 `.regen_tmp/rh-form-cover-fidelity-20260908.md` / `.regen_tmp/rh-family-wipe-accurate-reseed-20260908.md`（勿提交）；`updated_at` 2026-09-08T03:21:00+08:00。


### 2026-09-08（ToIV 开发：生图池 Comfy FE 齐套 1.52.7 + 去重/封面三项完成）
- **生图池 Comfy FE 齐套**：WS / pc01 / pc02 / LB:8188 均为 frontend **1.52.7**；`fe_gate=met`；`fe_homogenized=true`；`homogenize_pending=false`。**H3 未动**。~~pc01=1.49.6→1.52.7 进行中~~ **SUPERSEDED**。~~WS 1.45.20 / pc02 1.45.21 / pc01 1.49.6~~ **SUPERSEDED**（gen-pool FE versions）。
- **同图哈希去重（执行完）**：85 组；kept **85**；soft-hide **243**；deleted **0**；市场可见 **2163→1920**；rh-acc **949→706**。日志 `.regen_tmp/dedupe-hash-20260908.json`（勿提交）。
- **渐变假封面（执行完）**：用户可见 **114→0**。日志 `.regen_tmp/gradient-cover-fix-20260908.json`（勿提交）。
- Status：`fe_homogenized_dedupe_covers_done`（三项用户决策均完成）；STATE `rh_comfy_covers_dupes_audit_2026_09_08`；`updated_at` 2026-09-08T02:21:00+08:00。

### 2026-09-08（ToIV 开发：用户已拍板三项；~~执行中 / fe_partial~~ → 见上条齐套结果）
- 用户已拍板（via ToIV 开发）：① Comfy LB FE **≥1.49.6** 统一；② 同图哈希去重（type-hash / same-image hash）；③ 渐变假封面全量重生。
- ~~Status：执行中 / fe_partial_dedupe_covers_done（pc01 同版进行中）~~ **SUPERSEDED by** 上条 `fe_homogenized_dedupe_covers_done`。原 `updated_at` 2026-09-08T02:15:00+08:00 / 02:16:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — RH Comfy版本分裂+封面UX+重复调研；等用户拍板）
- **打开失败主因（调研时）**：Comfy LB FE 版本分裂 — ~~WS **1.45.20** / pc02 **1.45.21** / pc01 **1.49.6**~~ **SUPERSEDED for gen-pool FE**（现 WS/pc01/pc02/LB:8188=**1.52.7** 齐套；~~pc01=1.49.6~~ SUPERSEDED）；userdata 正确；load abort 后残留旧图；rh-acc Subgraph **0%**（当时 0/949）。FireRed：banner 新名、canvas 留 Z-Image。
- **RH 效果主路径**：打开应用 runner（`app_run`）；开工作流需 FE≥1.49.6 或钉 canvas 到 pc01。`toiv_workflow_query` **现已在** WS/pc01/pc02 `/extensions` 列出（先前「待重启」可能已过时）。
- **封面**：DB empty=**0**；UX 渐变=抽象 cover 文件（~68 R18 rh-h3 `appcover-7ae2fc…`）；已给 **7** 个 H3 R18 builtin 盖 SFW 海报；CDN rh-acc **949** OK。
- **重复**：name-stem **60组/236**；type-hash **85组/328**。等用户拍板：去重规则 / FE 统一或钉 pc01 / R18 家族封面 regen。
- STATE `rh_comfy_covers_dupes_audit_2026_09_08`（+ 滚动 `open_workflow_comfy145_query_2026_09_08` / `cover_gen_coverless_2026_09_08`）；报告 `.regen_tmp/rh-comfy-covers-dupes-audit-20260908.md`（勿提交）；`updated_at` 2026-09-08T02:10:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — Comfy 打开工作流加固；WS LIVE；扩展已列出）
- 加固：`toiv_workflow_query` 等 canvas/graph ready、backoff `getCanvas:null`、禁误 `app.clean()`（改 `graph.clear`）、postMessage `toiv-load-workflow`、afterConfigureGraph retry；CanvasView parent→iframe postMessage after load（+800ms/+2500ms）；保留 userdata `?workflow=`。
- WS `/opt/ComfyUI/custom_nodes/toiv_workflow_query/` LIVE（8196 + LB :8188）；web BUILD `20260907-174430-c309d02-dirty`（chunk 含 toiv-load-workflow）；probe open-in-comfy `h3-nsfw-t2v` OK。
- **更新**：`toiv_workflow_query` 现已在 WS/pc01/pc02 `/extensions` 列出（先前「待重启」可能已过时）。打开失败主因已滚动为 **Comfy LB FE 版本分裂**（见上条调研）。status=`hardened_live_version_skew_blocker`。
- STATE `open_workflow_comfy145_query_2026_09_08` + `comfy_load_harden_covers_2026_09_08` + `rh_comfy_covers_dupes_audit_2026_09_08`；报告 `.regen_tmp/fix-comfy-load-covers-20260908.md` / `.regen_tmp/rh-comfy-covers-dupes-audit-20260908.md`（勿提交）；`updated_at` 2026-09-08T02:10:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — worker `_pick_app_client` 扩 H3/LongCat/Wan*）
- `_pick_app_client` 扩 H3/LongCat/Wan*；503 列缺模型/节点；API 已上 core（`live_on_core`）。
- STATE `worker_pick_app_client_expand_2026_09_08`；`updated_at` 2026-09-08T01:20:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — 市场 prune 付费云端专用 −263）
- 付费云端专用删 **263**；保留可本地化；市场 **2426→2163**。
- STATE `market_prune_paid_cloud_2026_09_08`；`updated_at` 2026-09-08T01:20:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — 封面 coverless/gap_pending→0；UX 真理已滚动）
- coverless/gap_pending → **0**（清 68 坏本地封面文件后 regenerate）；local apps **1214**；CDN **949** 故意保留；bad_files **0**。
- **UX 真理**：DB empty=0 正确；用户可见「无封面」= CSS 分类渐变 **或** 抽象紫/红渐变图当 `cover_url`（~68 R18 rh-h3 `appcover-7ae2fc…`）；已给 **7** H3 R18 builtin 盖 SFW 海报。
- STATE `cover_gen_coverless_2026_09_08` + `comfy_load_harden_covers_2026_09_08` + `rh_comfy_covers_dupes_audit_2026_09_08`；报告 `.regen_tmp/fix-comfy-load-covers-20260908.md` / `.regen_tmp/rh-comfy-covers-dupes-audit-20260908.md`（勿提交）；`updated_at` 2026-09-08T02:10:00+08:00。

### 2026-09-07（ToIV 开发：LIVE — 市场瀑布流无感追加已上 core；进一步片→左侧空白已修）
- 市场瀑布流无感追加已上 core LAN（真机）；BUILD_ID `20260907-164531-9ec0144-dirty`；产品树 dirty 无独立 SHA。
- 去掉 CSS `column-count`；`.rh-grid` → N 列 `.rh-col`；placement Map 保列位；续载只往最短列底追加；resize 才整表重分。
- 叠在市场小步续载 / 无限滚动 / 市场 UX / UI P4 瀑布流之上（further of market_small_step_load）。
- STATE `market_waterfall_seamless_append_2026_09_07`：`status=live_on_core_dirty`，`updated_at` 2026-09-07T16:45:31+08:00；further → `market_left_blank_fix_2026_09_08`。
- **进一步片**：市场左侧空白已修（见上条 2026-09-08；BUILD `20260907-203017-6417f2a-dirty`；空 `.rh-col` flex 占宽 → ResizeObserver + 跳过空列 + 重置 placement）。

### 2026-09-07（ToIV 开发：LIVE — RH 准确重入库第二轮扩种 SCALE2 累计1212）
- **准确 RH 第二轮扩种完成（Phase C）**：本轮新种 **500**；累计 `rh-acc-*` = **1212**（RH id 去重；scale2 前约 700，中途 aborted partial ~12 → baseline 712 before this +500）。
- **累计跳过 1048**（`null_workflowId` 1047 + `export_code_810` 1）；**累计 create 错误 0**（先前 2 个 `create_422` 已重试成功：webapps 1976578710449033218、2042457691490099202）。
- **抽检 12/12**：节点 + 封面 + RH id 一致。已处理 webappId **2260**；池未耗尽（catalog 8747，约 6487 未处理，多数会跳过）。
- **脚本加固**：POST 前丢掉非 ASCII binding leaf（对齐 Core `_BINDING_FIELD_RE`）。无新 BUILD（HTTP 种库）。无模板克隆。
- **族累计**：other **375** / flux **231** / ltx **210** / qwen **205** / wan **197** / h3 **7**。
- STATE `rh_accurate_reseed_scale2_2026_09_07` + `rh_clone_purge_reimport_2026_09_07`：`new_seeded=500`，`cumulative_seeded=1212`，`cumulative_skipped=1048`，`cumulative_errors=0`，`prior_create_422_recovered=true`，`spot_check=12/12`，`processed=2260`，`remaining_unprocessed≈6487`，`pool_exhausted=false`，`binding_harden=drop_non_ascii_leaves`，`build_id=null`，`no_template=true`，`status=reseed_scale2_done_pool_remaining`；`updated_at` 2026-09-07T20:55:00+08:00；报告 `.regen_tmp/rh-accurate-reseed-scale2-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：LIVE — RH 准确重入库扩种完成 累计700）
- **准确 RH 扩种完成（Phase C）**：本轮新种 **500**；累计 `rh-acc-*` = **700**（RH id 去重 700）。
- **累计跳过 752**（皆 `null_workflowId`）；**累计 create 错误 2**（`create_422`；bindings 非 `inputs.*`/`widgets_values.*`）。
- **抽检 12/12**：节点 + 封面 + RH id 一致。无新 BUILD（HTTP 种库）。无模板克隆。
- **族累计**：other **224** / flux **135** / ltx **118** / qwen **115** / wan **110** / h3 **6**；processed ids **1454**。
- ToIV **仍在扫可导出库存**——勿标全量 reseed done。`no_template_reseed=true`。
- STATE `rh_accurate_reseed_scale_2026_09_07` + `rh_clone_purge_reimport_2026_09_07`：`new_seeded=500`，`cumulative_seeded=700`，`cumulative_skipped=752`，`cumulative_errors=2`，`spot_check=12/12`，`build_id=null`，`no_template=true`，`status=reseed_scale_done_scanning_more`；`updated_at` 2026-09-07T20:20:00+08:00；报告 `.regen_tmp/rh-accurate-reseed-scale-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：LIVE — RH 准确重入库第一批完成 200）
- **准确 RH 重入库第一批完成**：种入 **200**（无模板克隆；exported Comfy API graph）；跳过 **294**（null_workflowId/未开放）；错误 **0**。
- **族分布**：flux **50** / qwen **42** / ltx **36** / wan **32** / h3 **6** / other **39**。
- **抽检 8/8**：节点 + 封面 + RH id 一致；ids prefix `rh-acc-*`。
- **无新 BUILD**（HTTP 种库；API 码未改）。`no_template_reseed=true`。更多批次仍 **pending**——勿标全量 reseed done。
- STATE `rh_clone_purge_reimport_2026_09_07` + `rh_accurate_reseed_batch1_2026_09_07`：`reseed_pilot_batch1=done`，`seeded=200`，`skipped=294`，`errors=0`，`spot_check=8/8`，`build_id=null`，`no_template=true`，`status=reseed_batch1_done_more_pending`；`updated_at` 2026-09-07T20:00:00+08:00；报告 `.regen_tmp/rh-accurate-reseed-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：LIVE — 10Eros 模型出处补全 64/64）
- **模型出处**覆盖 **62/64 → 64/64（100%）**；flagged apps **10 → 0**。
- wiki + `engine_registry` 已写 civitai/HF：H3 `10Eros_Max_h3_TURBO_ref2va_beta2_int8_convrot`（HF cicalooo/10Eros-Max-h3-int8-convrot + Civitai 2851079）；LTX `10eros_v14`（civitai.red 2447875 + HF TenStrip/LTX2.3-10Eros）。
- 顺带：`hunyuan_video` wiki family HF；`flux1-dev` `huggingface_url` → FLUX.1-dev。Curated wiki cards **43**（was 40）。
- BUILD_ID 仍 `20260907-103808-6e94327-dirty`（本轮主要改 api；API restarted；health OK）。
- 准确重入库 **PILOT 仍进行中**——**勿标 reseed done**；`no_template_reseed=true`。
- STATE `model_provenance_10eros_2026_09_07`；`rh_clone_purge_reimport_2026_09_07` provenance→**64/64**；`updated_at` 2026-09-07T19:50:00+08:00；报告 `.regen_tmp/10eros-provenance-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：LIVE — RH 真工作流导出已打通；准确重入库 PILOT 进行中）
- **Export METHOD FOUND**：`POST /api/webapp/detail` → `workflowId`；`POST /api/openapi/getJsonApiFormat`（apiKey+Bearer）→ `data.prompt` = Comfy API JSON。
- **Verified samples**：Flux2-klein **17** nodes、H3 Lip Sync **22**、H3 T2AV **33** 等（3+）。
- **Limits**：`workflowState=0` 或 author ACL → fail（1913 / WORKFLOW_NOT_EXISTS）；勿模板伪造。
- Prior BLOCKER `TOKEN_MISSION` / wrong path → **SUPERSEDED** for apps with `workflowId`+`workflowState=1`。
- **Wipe 已完成**（rh-*=0；累计≈8611；删数已报）。准确重入库为 **PILOT in progress**（非全量）；`reseed_started=true`；**reseed_count TBD 勿发明**。
- 完成后报告：reseed count、skip-reason stats、spot-check results、BUILD_ID if deployed。未部署，**无 BUILD_ID**。`no_template_reseed=true`。
- STATE `rh_clone_purge_reimport_2026_09_07`：`status=reseed_in_progress_export_ok`，export_method as above，prior_blocker superseded，`reseed_started=true`，`reseed_pilot=true`，`reseed_count=null`，`build_id=null`，`deployed=false`；报告 `.regen_tmp/rh-graph-export-path-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：LIVE — RH 清库完成 rh-*=0；重入库被 RH 导出挡住）
- **LIVE wipe**：`rh-*` 已清 **0**；本轮删除 **3392**（API 1149 + SQL 2243）；相对 wipe_before 累计约 **8611**。admin API 对 is_builtin `rh-*` 403，故用 core Postgres SQL 清剩余。
- **保留应用 48**（47 builtins + `Flux-文生图-96c82d`）；未删产品内置。
- **模型出处**覆盖 **96.9%（62/64）**；未证主因：`10Eros_Max_h3_*` / `10eros_v14`（约 10 个 H3/LTX NSFW 应用）；另曾标 hunyuan_video I2V + flux1-dev-fp8（pulid，family HF 后纳入覆盖）。
- **准确 RH 重入库 0**；**BLOCKER**：RH 无可用工作流图导出（detail 仅元数据；export 403 `TOKEN_MISSION`）。未部署，**无 BUILD_ID**。`no_template_reseed=true` 仍有效——**勿声称重入库已完成**。
- STATE `rh_clone_purge_reimport_2026_09_07`：`status=wipe_done_reseed_blocked`，`rh_remaining=0`，`deleted_this_run=3392`，`cumulative≈8611`，`retained_apps=48`，`model_provenance=62/64`，`reseed=0`，`blocker=RH_workflow_export_TOKEN_MISSION`，`build_id=null`，`deployed=false`；报告 `.regen_tmp/rh-wipe-resume-20260907.md` / `builtin-provenance-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：PROGRESS / IN PROGRESS — RH 清库进度：rh-* 约剩 3392，已续删）
- 清库中途 executor 基础设施 unauthenticated 中断；当前 core 约剩 `rh-*` **≈3392**（原先近万已删大半）；admin token 仍可用。
- 已重启续删 + 内置/模型出处审计；**禁止模板重种**（`no_template_reseed=true`）。
- 仍 `in_progress_on_core` / not done；完成后报告：删除数、重入库数、内置变更、模型出处覆盖、BUILD_ID。
- STATE `rh_clone_purge_reimport_2026_09_07`：`rh_star_remaining≈3392`，`interrupted_unauthenticated` then resumed。
- **勿写已完成**；**勿发明精确已删数量**；未发明集群/GPU 变更。

### 2026-09-07（ToIV 开发：SCOPE UPGRADE / IN PROGRESS — RH 清库重入库口径升级：含内置 + 全量严格出处）
- 用户 ADDENDUM：内置应用也要动（~~内置保留~~ → **SUPERSEDED**）；所有内容与所有模型来源必须可核对（HF / Civitai / RH / 本地）；口径升级为全量严格出处。
- 仍 `in_progress` / not done；完成后报告：删除数、重入库数、内置变更、模型出处覆盖、BUILD_ID。
- STATE `rh_clone_purge_reimport_2026_09_07`：`builtin_also=true`，`strict_provenance_all_sources=[HF,Civitai,RH,local]`，`status=in_progress_on_core`。
- **勿写已完成**；**勿发明已删/重入库数量**；未发明集群/GPU 变更。

### 2026-09-07（ToIV 开发：INTENT / IN PROGRESS — RH 错挂克隆清库 + 准确重入库；历史口径 ~~内置保留~~ SUPERSEDED）
- 用户下令：删掉所有错挂 RH 克隆卡并重新准确入库；封面/名称/工作流必须一致，不许再模板克隆；~~内置应用保留~~（已作废，见上条 SCOPE UPGRADE）。
- 先前 `rh-*` 家族模板种子正在清库，以便按 RH 真工作流准确导入；ToIV 已在 core 开始清 `rh-*` 并研究导入。
- Status：`in_progress` / not done；**勿写已完成**；**勿发明已删数量**；未发明集群/GPU 变更。

### 2026-09-07（ToIV 开发：打开工作流导航已修已上 core）
- 打开工作流导航已修并上 core LAN（真机）；BUILD_ID `20260907-103808-6e94327-dirty`；产品树 dirty 无独立 SHA。
- 根因：`#canvas` 无效（SPA 只认 `/?view=canvas`）；API `POST /api/apps/{id}/open-in-comfy` itself was fine。
- 打开应用去掉简洁/工作流，仅 RH 运行台 +「在画布中编辑」。
- tests appsWorkflow+appsRh **37** pass；报告 `.regen_tmp/fix-open-workflow-nav-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：RH 参考图/提示词默认值已上 core）
- 打开应用参考图/提示词默认值已上 core LAN（真机）；BUILD_ID `20260907-095758-c383011-dirty`；产品树 dirty 无独立 SHA。
- UI：media `default` + 远程封面预览（提交仍要真上传）；seed `inject_rh_ref_defaults`。
- 回填 **8626** 个应用（top300 RH detail 提示词 **287/300**，其余家族默认+封面 CDN）；Errors **0**。
- 关闭此前 RH UX Tab gap「参考图/提示词默认值仍缺」。报告 `.regen_tmp/rh-ref-defaults-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：RH 图生新入库封面回填）
- RH 图生新入库封面回填完成（数据侧已上 core LAN `http://192.168.71.47:8090`）。
- 空 `cover_url` **13→0**；**6387** 保持 RH CDN；**13** 无 coverUrl 用同族 CDN+admin 上传补齐。
- 有效缺封面 **0**；scope **6400** new image RH apps；total market **8646**。
- 报告 `.regen_tmp/cover-backfill-image-rh-20260907.md`（勿提交）；无产品 SHA；未发明集群/GPU 变更。

### 2026-09-07（ToIV 开发：RH UX Tab+封面 contain+管理员出处已上 core）
- RH UX Tab+封面 contain+管理员出处链接已上 core LAN（真机）；BUILD_ID `20260907-092308-9db9030-dirty`；产品树 dirty 无独立 SHA。
- 应用详情 | 我的生成 Tab；封面 object-fit contain。
- admin `rh_webapp_url` + `source_links`（引擎 HF/Civitai）；模型页 admin Civitai+HF。
- ~~仍缺参考图/提示词默认值~~ → **已关闭**（见上条 RH 参考图/提示词默认值已上 core）。

### 2026-09-07（ToIV 开发：RH 图生全量入库完成）
- RH 图生全量入库已完成（数据侧已上 core LAN `http://192.168.71.47:8090`）；认证 search 字段分页（`search` 非 `searchValue`）。
- 去重 **6511** → 分类 **6408** → 种入 core **6400**（错误 0）；base：`qwen-image-edit` 2040 / `img2img-basic` 2419 / `txt2img-basic` 1941。
- leftover 69 + video_skipped 34；already on core skipped 8；core apps ≈**9846**。
- 报告 `.regen_tmp/rh-image-ingest-20260907.md`（勿提交）；无产品 SHA；未发明集群/GPU 变更。

### 2026-09-07（ToIV 开发：应用封面回填完成）
- core 有效缺封面 **547→0**（空 `cover_url` 4→0；本地 cover 404×543 靠恢复 `/data/app-covers/` 下 **10** 个共享家族 PNG；另上传 4 张空应用封面）。
- 根因：10 共享家族封面文件缺失，543 `rh-*` 仍指向它们（疑似 admin 上传 `_remove_cover_file` 删共享 URL）。
- 未跑 GPU generate；家族仍共享封面（by design）；`expand_top` 可选后续。报告 `.regen_tmp/cover-backfill-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：作品库选封面叠层已修已上 core）
- 作品库选封面叠层已修并上 core LAN（真机）；BUILD_ID `20260907-082025-be7d5c7-dirty`；产品树 dirty 无独立 SHA。
- 原因：sticky `.rh-params` 困住 fixed Modal；改为 portal 到 `document.body`。

### 2026-09-07（ToIV 开发：市场小步续载已上 core；进一步片→市场瀑布流无感追加）
- 市场小步续载已上 core LAN（真机）；BUILD_ID `20260907-080948-7b6f9e7-dirty`；产品树 dirty 无独立 SHA。
- 每页 10；细条 loading；rootMargin 150；新卡 fade-in。
- 叠在市场无限滚动 / 市场 UX 之上（further of market_infinite_scroll / market_ux）。进一步片见上条市场瀑布流无感追加 LIVE。

### 2026-09-07（ToIV 开发：市场无限滚动已上 core；进一步片→市场小步续载）
- 市场无限滚动已上 core LAN（真机）；BUILD_ID `20260907-075325-693aa19-dirty`；产品树 dirty 无独立 SHA。
- 去掉「显示更多」；IO sentinel 续载。
- 叠在市场 UX / UI P4 瀑布流之上（further of market_ux / ui_p4_market_waterfall）。

### 2026-09-07（ToIV 开发+设备管家：H3 Ref2VA bf16 已入库 NAS）
- bf16 LIVE：`NAS/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_bf16.safetensors`（66280487368 bytes ≈62GiB；MateBook ls 核实）。
- 同目录 INT8 已有：`minimax_h3_ref2va_pruned_int8_convrot.safetensors`；**仍缺** `minimax_h3_ref2va_pruned_bf16`。
- workstation 通常同相对路径于 `/home/merlin/nas_mount/toiv/comfyui-models/...`；H3 无需为下载重启。
- 勿列 NAS/#recycle 未完成 aria2 副本为 live。

### 2026-09-07（ToIV 开发：应用详情 RH 布局已上 core）
- 应用详情 RH 布局已上 core LAN（真机）；BUILD_ID `20260907-072931-ea942fc-dirty`；产品树 dirty 无独立 SHA。
- 左封面 / 右打开应用 + 打开工作流 / 节点信息；admin 出处；封面 expand×40 已重踢。
- supersedes comfy_open_edit 中「详情页 RH 布局仍推进中」。

### 2026-09-07（ToIV 开发：Comfy 二次编辑通路已上 core）
- Comfy 二次编辑通路已上 core LAN（真机）；BUILD_ID `20260907-070508-718d466-dirty`；产品树 dirty 无独立 SHA。
- `POST /api/apps/{id}/open-in-comfy` → 画布自动加载；save-back 未做。
- 封面 expand 已重踢；详情页 RH 布局仍推进中→SUPERSEDED（见上条应用详情 RH 布局 LIVE）。
- 叠在市场 UX Comfy 导出/打开之上（further of market_ux）。

### 2026-09-07（ToIV 开发：市场 UX 已上 core LAN；进一步片→Comfy 二次编辑）
- 市场 UX 已上 core LAN（真机）；BUILD_ID `20260907-064811-db3fa3e-dirty`；产品树 dirty 无独立 SHA。
- 去分类；瀑布流 + Skeleton + 懒加载；高级引擎 → 更多引擎；封面 expand_top=40 生成中；Comfy 导出/打开已落地（完整二次编辑仍推进）。
- 进一步市场 UX 片（叠在 UI P4 市场瀑布流/详情之上）。

### 2026-09-07（ToIV 开发：UI P4 市场瀑布流/详情已上 core LAN）
- UI P4 市场瀑布流/详情已上 core LAN（真机）；BUILD_ID `20260906-231138-69957d0-dirty`；产品树 dirty 无独立 SHA；进一步片见上条市场 UX。
- 此前 UI P4 小程序主题对齐 web v9 intent（local_uncommitted_core_build_unchanged）**SUPERSEDED**→本条；小程序主题对齐仍可能在本地 dirty 树中单独未 commit。

### 2026-09-07（ToIV 开发：UI P3 封面 expand_top 已上 core LAN）
- UI P3 封面 expand_top 已上 core LAN（真机）；BUILD_ID `20260906-225725-b22d0af-dirty`；主改 api；产品树 dirty 无独立 SHA。

### 2026-09-07（ToIV 开发：UI P2 库占位已上 core LAN）
- UI P2 库占位已上 core LAN（真机）；BUILD_ID `20260906-225725-b22d0af-dirty`；ThumbPlaceholder 按类型；产品树 dirty 无独立 SHA。

### 2026-09-07（ToIV 开发：UI P1 主题对比度已上 core LAN）
- UI P1 主题对比度已上 core LAN（真机）；BUILD_ID `20260906-225049-7588708-dirty`；cinema/graphite 暗色轨对比度修复；产品树 dirty 无独立 SHA。

### 2026-09-07（ToIV 开发：provenance+KG 已上 core LAN）
- provenance 剥离 + Admin knowledge-graph 已上 core LAN（真机）；BUILD_ID `20260906-224852-921256b-dirty`；admin `GET /api/admin/knowledge-graph` 200（~1295 nodes / 608 edges；可选 `?entity=` neighborhood）；普通用户去 RH:{id}/civitai_url，管理员保留；产品树 dirty 无独立 SHA。

### 2026-09-07（ToIV 开发：市场合并首片已上 core LAN）
- 市场合并首片已上 core LAN（真机）；BUILD_ID `20260906-224447-8e33d9e-dirty`；api :8090 / web :3100 200；nsfw-recommendations 无 X-NSFW→403；资源区 R18 推荐仅 admin+R18；ModelsView Civitai|HF；产品树 dirty 无独立 SHA。

### 2026-09-07（设备管家+ToIV 开发：Embedding → spark01 :9302 LIVE）
- **设备侧 LIVE**：spark01 Qwen3-Embedding-4B @ `192.168.71.82:9302`（GPU / cuda）；用户级 systemd Linger=no。
- **core LIVE**：`TOIV_EMBED_BASE_URL=http://192.168.71.82:9302/v1`；toiv-api 已重启；备份 `.env.bak-embed-20260907`；无产品 SHA。
- **非 WS**：workstation embedding :9302 已停（09-07）；**现网 Embedding 已迁 spark01 :9302**（设备管家确认）。
- 此前「下一步 Embedding→spark01 intent」**DONE**。

### 2026-09-07（设备管家+ToIV 开发：Spark LLM/VLM 真机切 27B @ spark02；core 已切 LIVE）
- **设备侧 LIVE（SSH 核实）**：spark02 `vllm_node` @ `192.168.71.84:8000` — Qwen3.8-27B-NVFP4，served `qwen3.8-27b`（别名 `qwen3.6-uncensored`），max_model_len 32768；设备冒烟 ~15.4 tok/s；加载后 MemAvailable ~2.7Gi。
- **core LIVE**：`TOIV_LLM_*` / VLM 等 → `http://192.168.71.84:8000` + model `qwen3.8-27b`；toiv-api 已重启，LAN health 200；备份 `.env.bak-qwen27b-20260907`；core 路径冒烟 ~27 tok/s。
- **双机 qwen38sg Flash-Next 已停 Exited**（spark01/02）；spark01 :8000 **不再提供 LLM API**。勿再写双机入口。
- LiveKit 栈仍在 spark02（drt-livekit/egress/redis:6380）。
- ~~**下一步**：Embedding 放空闲 **spark01**（intent，未做）~~ → **DONE**：见上条 Embedding LIVE @ spark01 :9302。
- **SUPERSEDED**：此前「Spark 保留 Flash-Next」架构锁定、`intent_only_awaiting_cutover_plan`（0ce5aed）、以及「core 路由改中」中间态，均被本条真机+core 双切替代。

### 2026-09-07（设备管家：workstation 停服快照；ToIV 开发执行）
- 已停并 disable：数字人/口播及一批非生图非视频常驻（FlashTalk / OpenTalking / LiveAct / FishS2 / JoyCaption 等 inactive）
- 现网保留：H3:8195、生图 gpu0-alt:8196、LongCat:8197、Animate2:8199、LB:8188（pc workers 仍在池）
- 核对时空闲约：G0 94G / G1 97G / G2 57G / G3 95G（停服后 GPU0/1/3 ≈ empty 94–97G；G2 仍 H3 故 ~57G free）
- **口径更正（2026-09-07）**：ToIV 开发已停 WS 迁脑；**取消**「Flash-Next 迁 WS GPU0+3」全部计划。旧「WS GPU0+3 拟迁 Flash-Next / 切 core 后拆 spark Qwen / Spark 仅 LiveKit+空内存」作废（SUPERSEDED）。
- ~~架构意图（2026-09-07 更正）：Spark **保留** Flash-Next……~~ **SUPERSEDED by 2026-09-07 Spark LLM/VLM 真机+core 双切 27B@spark02**。日产=WS+5090 仍成立；Embedding→spark01 **DONE**（见上条 LIVE）。
- spark02 LiveKit 仍保留（现网事实，非「Flash-Next 拆走后的唯一用途」）。

### 2026-09-06（ToIV 会话：workstation 重启窗口 + spark 集群重建）

- **workstation 重启窗口完成**：GPU0 恢复 CUDA 枚举（index 0,UUID GPU-c2193dfe）,8189 卡死进程随重启清除;数字 CVD 服务落卡全部符合设计（gpu0-alt/joycaption/longcat→GPU0,四音频→GPU2,UUID 钉卡服务不动）;NAS 挂载/LB 三后端/core 全链验证,txt2img 冒烟 success。
- **spark 双机集群重建（spark01 死机物理重启后）**：①容器 `qwen38sg` 两个 /tmp bind-mount 随 reboot 丢失（tmpfs,docker 误建 root 空目录致启动失败）→ 容器重建,**挂载源改到家目录**（`/home/dgmt-spark/`）根治;②decode 崩溃链：镜像 stock `flash_fwd_sm120.py` 在 SM120 误开 TMA（上游 flash-attn #2671）+ pack_gqa 半成品（#2656/#2671）+ **head_dim=256 在 GB10 99KB smem 上 FA4 cute 不可用**（#2750 同类,tile 常数不感知 hdim）→ 处置：整包升级 **flash-attn-4 4.0.0b29**（目录级挂载 `/home/dgmt-spark/fa4pkg/flash_attn`）+ qwen_sparse_attn_backend 补丁（SM12x 且 hdim>128 的 decode 走 **SDPA 块对角 mask 路径,GPU 构图禁 host 同步**;文件在 spark01/02 家目录,无免密 sudo）。LLM 出文冒烟通过,core→spark 提示词优化链路验证通过。
- **同批收口**：6 例预存测试修复（`55c3902`,全量 3035 绿）;8189 退役/8196 转正;cloud sshd GSSAPI=no（SSH 走 TS 100.83.78.114）;DRT 包 staging 到 core。

### 2026-09-06（设备管家：beijing SSH 公钥已通）
- MateBook 已装 id_ed25519 公钥；~/.ssh/config 有 `Host beijing` → 8.140.222.24 User root IdentityFile ~/.ssh/id_ed25519；BatchMode 免密已通。密码勿写。

### 2026-09-06（设备管家：beijing 真机只读登入）
- hostname iZ2ze325an97cwlbt1wxfdZ；Ubuntu 24.04.4 LTS；1.6Gi RAM 无 swap；40G 盘约用 15%
- 角色确认：CN 入口 toiv.wineryz.top（OpenResty + ACME）
- Docker：1Panel-openresty + 1Panel-frps（frps 0.68.1）听 7000/7500/13100/18090；另有 1panel-core :1722
- SSH：当时公钥未通；现 MateBook 已装 id_ed25519 公钥，~/.ssh/config 有 `Host beijing` → 8.140.222.24 User root IdentityFile ~/.ssh/id_ed25519，BatchMode 免密已通。密码勿写。
- 未改服务；密码不入文档

### 2026-09-04

- **全站美化方向A「精修控制台」五波收官（`33c045c`/`2393957`/`79bd123`/`2988b9c`,均已部署 core,生产截图验证）**：版型令牌系统（`--layout-measure/content/wide`、节奏/栅格/媒体 AR 档）+字阶圆角旧档删除+琥珀点睛（`--accent-glow`,聚焦环/激活指示/链接 hover 三触点）+浮层 `--shadow-pop` 弹簧入场+空态三档（stage/section/inline,Fraunces 斜体+琥珀图标）+19 视图全量版型对齐;UI_STANDARD v2.0 成文。方向C（Film Atelier 复兴）demo 被否,留档 `.regen_tmp/film-atelier-demo.html`。细节见 TEST_LOG。

### 2026-09-03（本周）

- **端点统一+动态切换上线（ToIV `3446b75`+`7edabc5`,已部署 core）**：①LB（AIGCPannel 仓 `platform/deploy/comfyui-lb/comfyui-lb.py`,已部署 workstation）后端列表外置 `/opt/comfyui-lb/backends.json` mtime 热重载 + `GET /admin/backends`;②ToIV api 池 `TOIV_COMFY_WORKERS_REGISTRY_URL` 60s TTL 跟随注册表（失败沿用现状,回环地址改写到注册表主机——生产实证抓获：LB 报 127.0.0.1:8196 对 core 不可达）;③AIGCPannel 三处漂移清单收口（local_gateway 惰性拉取/start 脚本/model_library,KREA2 直连 :8189→:8196）。真机 e2e：改 JSON 加假后端 5s 内出现且 UNHEALTHY、删除即消失、零重启;txt2img 冒烟落 :8196 执行。操作口径见第三节。**⚠️ AIGCPannel 仓改动未提交**（其规则:未要求不 commit;另其 `platform/backend/.env` 含旧 `COMFYUI_LB_BACKEND_URLS` 需其会话手动改 :8196,否则 env 显式值压过动态拉取）。⚠️ ToIV 后端全量 pytest 有 **6 个预存失败**（test_agent_gen_tools/test_app_seed H3 用例,干净树复现,与本次无关,疑 09-03 应用市场批次引入,待查）。
- **操作方查明=AIGCPannel**：workstation 上的并行操作（gpu0-alt 顶班 :8196、:8195 ComfyUI 升 0.34.0、8189 反复重启）均为 **AIGCPannel 项目会话**所为（证据:`start-aigcpannel.py:112` 硬连 :8189 池、gpu0-alt unit 建于 08-31 03:21、AIGCPannel/AGENTS.md 自述 09-03 :8195 升级与其 P0–P6 短剧 H3 改造同期）。**LoRelay 无集群操作证据**（GPU 租赁产品,仅文档提及）。ToIV 侧只记录不动其服务。
- **LB 本地后端 :8189→:8196**（H-7）;core health 200;GPU 快照(MiB used/97887):0=27275/1=94125/2=38159/3=84997。
- **RunningHub H3 应用市场（ToIV 开发,已双推已上 core）**：`262bb5a`(市场+1166 社区预制 rh-* 播种)+ `133f15a`(H3 市场应用走专用 :8195 非通用池);core BUILD_ID `20260903-020621-262bb5a-dirty`。
- **Studio Console W1–W4 收官（ToIV 开发,已部署+实测）**：W3 六视图套版(92a8bba/892fa95/3a27ca7)+W4 drama 全链退役 -9329 行(4922bca)。
- **H3 GPU 钉卡**（gpu-pin.conf UUID→物理 GPU2,见 H-6;GPU0 reset 未修）。
- **:8195 ComfyUI 0.30.0→0.34.0**（含原生 MiniMaxH3AddGuide;INT8/Turbo 未重下）。
- **算力补装**：Wan2.2 Remix v3.0(NSFW I2V)入库 NAS;comfyui-infinitetalk :8201(GPU2,e2e 已冒烟,⚠️ 未补 resolve_worker 见 E-1);toiv-fishs2 :9212(Fish S2 Pro TTS,GPU2 常驻~20G,情感标记实测生效)。模型清单与坑见归档。

### 2026-08-29（三视图根治 + 体验治理,均已部署 core）

- **三视图卡死根治(e4bb0b3)**：回写协程多轮等待+api 启动 reconcile(教训=E-7);同批上线全量进度体系+任务中心+主体库重做。
- **R18 LTX t2v 路径锁(42dba0c)**：无首帧一律 422 引导 i2v;H3 标 ordinary_default,LTX/Wan R18 标 advanced 沉底;B3 多主体 entity_ids 透修。
- **七项体验治理**：studio01-04 舰队移除+L2/L3 收拢 spark02(86a94e8);导航收口+五页「‹ 返回融合」(6c69b6f);剧本拆解异步化提交制(fae48dc);14 个非 H3 视频引擎标 advanced、H3 entity_ids 上限 9(05f7703);资产双源 Tab+jobs/lookup(aefea45)。
- **任务中心中止(35b8b87)**：`POST /api/jobs/{id}/cancel`;**ltx-nsfw-t2v 标 hidden(60d6168)**。⚠️ `deploy/.env` 第 9 行裸 URL 是历史遗留,不影响运行。

### 2026-08-28~30（ToIV 开发批次,细节/推送状态以 git 与归档为准）

- UX 体验包 `eb51c86`、Job.nsfw 合同 `fb78872`(X-NSFW 只作门禁,nsfw 仅显式意图);助手可靠性三修复(a5e04ea 长会话折叠/e833f33 上下文溢出/58cf643 SSE 超时回放);LoRA 策划卡 93c275e/e1f856e、LTX 竖版 859b60f(本地批次)。
- 设备侧:OpenClaw 01-04 实锤 M4 非 M2;`TOIV_WEB_SEARCH_PROXY` 改 LAN `.9`;08-27 全设备真机复核(GPU/服务清单见归档)。

### 2026-08-21~26（底座性变更,摘要）

- **引擎矩阵拍板(08-21)**：R18=Wan2.2+LTX2.3;H3 全面替代 LTX2.5;RAM OOM 根治(MemoryMax/排队误杀修复)。
- **ltx25 退役根治(08-23)**：`disable --now` 已执行,注册表零残留;同批:hold 排队(FIFO 自动放行)、10Eros-Max H3 R18 能力、作品库回收站 72h、资源预算预检、H3 LoRA 管线(ai-toolkit minimax_h3,⚠️ 帧网格 17n+5、训练别设 HF_HUB_OFFLINE=1)。
- **08-24 大批上线**：观测面板 fleet+sysmetrics :9403、3dops :9402、助手异步工具+提案确认门、提示词优化方言体系、Wan-Animate-2 :8199(GPU3,必须 Comfy-Org 转换版权重)、SCoPE :9401、Z-Image base 族、i2L 管线、360° 相机(Qwen-Edit-2511+Multiple-Angles-LoRA)、Qwen-Image-Edit :8194(pc02)、IndexTTS 2.0→2.5(emo_text 默认 true)、模型目录治理(剔除清单唯一事实源 model_profiles)。
- **08-25**：GPU 三方换卡均衡(JoyCaption/LongCat→GPU0,四音频→GPU2);hy3dtex :9404 上线;spark01 molmo2→Qwen3-VL-32B(注:09-03 又被 qwen3.8-flash-next 取代)。
- **08-26**：小米路由器切 AP 模式根治网络孤岛(教训:「设备离线」先查二层拓扑/网关一致性)。

---

## 八、待办事项

- [x] RH 同图哈希去重完成（same_image_hash；85组 kept85 soft-hide243 del0；市场2163→1920；rh-acc949→706）— STATE `rh_comfy_covers_dupes_audit_2026_09_08`
- [x] Comfy LB FE 同版齐套 **1.52.7**（WS/pc01/pc02/LB:8188；gate met；fe_homogenized=true）— STATE `rh_comfy_covers_dupes_audit_2026_09_08`
- [x] 渐变假封面全量重生完成（用户可见 114→0）

- [x] workstation 重启窗口（09-06 完成:GPU0 枚举恢复、8189 清除、落卡全复核、全链冒烟）
- [x] spark 集群修复（09-06:spark01 死机物理重启+容器家目录挂载重建+FA4 b29+QSA hdim256 SDPA 补丁,LLM 冒烟通过）
- [ ] DRT 部署到 core（包已备妥 `/home/merlin/drt-bundle/` 六件:source-v2/images/config/pg dump/redis dump/minio data,2026-09-06 由 ToIV 会话中转;执行归 DRT 负责人,compose.prod+Caddyfile,注意 core 的 PG/Redis 是 ToIV 生产共用勿冲突）
- [ ] Cloud 公网 :22 跨境疑似 QoS（握手挂 2min 被 sshd LoginGraceTime 切断）;已修 GSSAPIAuthentication=no（TS 路径 21s→5.4s）;**SSH 一律走 Tailscale 100.83.78.114**
- [x] comfyui-gpu0 :8189（09-06 收拢:占用者=unit 内僵尸进程 3233 的失控线程,杀不掉;unit 已 **disable**（防重启复活/防重启后双开）,8189 退役,**:8196 gpu0-alt 转正为正式本地池后端**,backends.json 已是 8196 无需动;随 workstation 重启窗口一并清算）
- [x] GPU0 reset 尝试（09-06:--gpu-reset Not Supported,只能重启,并入上条重启窗口）
- [x] 6 个预存测试失败（09-06 `55c3902`:133f15a H3 走专用实例后旧打桩 miss,测试曾真实触达生产 :8195;补四处 H3 接缝 stub,全量 3035 绿）
- [x] InfiniteTalk :8201 补 `deps.resolve_worker()` 精确匹配（E-1,09-03 `3446b75` 已部署 core）
- [x] 已核销：ltx25 处置 / trackJob abort / test_duration flaky / ToIV 迁移 core / 域名双入口 / spark02 无审查替换 / `TOIV_CIVITAI_API_KEY`
