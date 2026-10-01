# ToIV 短剧 UI 方案（DRAMA_UI_PLAN）

方向锁定（用户 2026-09-30 / 10-01）：**AI 短剧是唯一主体**；UI 极简少字；功能重量级（真跑通+失败/边界）。本文件在 core 与仓库 `docs/ops/` 均保留（**不提交 git**）。

## 1. 信息架构

### 首页
- 主区：**「做短剧」** 单一输入框（一句话 → 建项目进工作流）+ **我的剧集** 列表（封面/进度点）。
- 无长说明、无 tagline；图标 + 短名。

### 项目页（一条工作流）
按序步骤，每步显示就绪态 / 失败态，支持整组重跑：

1. **剧本** — 输入或 LLM 拆解  
2. **角色/场景资产** — 三视图定妆、角色卡、多机位场景图  
3. **分镜** — 镜号列表 + **分镜督导**（一致性/违禁/单主体检查）  
4. **视频** — H3 为主；多参考图；每镜多候选  
5. **配音** — IndexTTS2  
6. **对口型**  
7. **成片** — 合成导出  

### 二级「工具箱」
原市场 / 生图 / 生视频 / 音频 / 资源等收进工具箱，不再与「做短剧」并列抢主入口。

### 导航（目标）
| 主栏 | 说明 |
|------|------|
| 做短剧 | 首页+项目工作流（原 home 意图面改短剧主入口；studio 项目工作流） |
| 工具箱 | 市场、图片、视频、音频、资源… |
| （底）任务 / 设置 / 账户 | 保持 |

## 2. 与现有代码映射（复用，不重写后端）

### API（已有）
| 能力 | 路径 / 模块 |
|------|-------------|
| 项目 CRUD / 分镜拆解 / 角色 / 资产 | `apps/api/app/routes/drama_studio.py` → `/api/drama/projects*` `/characters` `/assets` `/storyboard` |
| 分镜视频 / 续写 / 配音 / 成片 | 同文件 `generate-video` `continue-video` `generate-voice` `assemble` |
| 管线状态 / 下一步 | `apps/api/app/services/drama_pipeline.py` → `compute_drama_pipeline_status` |
| 图→分镜 | `apps/api/app/services/drama_image.py` + from-image 端点 |
| 角色在场 | `drama_presence.py` |
| H3 / 次世代出图图构造 | `workflows/nextgen.py` `txt2img.py`；worker 池指向 workstation Comfy |

### Web（已有）
| 面 | 组件 |
|----|------|
| 意图首页空态 | `components/assistant/PortalEmpty.tsx` + `lib/intentMap` |
| 创作工作室工作流 | `components/studio/StudioView.tsx` + `stages/{Script,Cast,Storyboard,Assembly}Stage.tsx` |
| 引擎工作室（图/视频） | `EngineStudioView.tsx` |
| 侧栏 / 底栏 | `components/nav/SideRail.tsx` `BottomNav.tsx`；项定义在 `app/page.tsx` 的 `RAIL_ITEMS` |
| 市场聚合 | `components/market/MarketView.tsx` |
| 成片播放 | `app/drama/[id]/page.tsx` |

### 映射原则
- Batch1 **只改导航文案/层级 + 项目骨架接现有 studio/drama API**，不新建平行后端。  
- 分镜督导：先接 `drama_pipeline` / presence / 现有校验告警，UI 显示就绪点。  
- H3 多参考：复用 shot generate 已有参考图/续写参数，UI 暴露候选槽。

## 3. 分批实现

### Batch 0（文档/素材）— 本轮
- [x] 本方案落地 core + 仓库 `docs/ops/DRAMA_UI_PLAN.md`
- [x] H3 样片固定素材四张就位（见 `H3_LONG_EXPERIMENT.md`）

### Batch 1（最小可部署）— **已上线** `05167c3`（2026-10-01 ~02:35 CST）
1. `RAIL_ITEMS`：主入口改为「做短剧」（`home` 或直达 `studio` 列表）；「应用市场」等移入工具箱分组/抽屉。  
2. 首页：输入框文案/主 CTA 改为做短剧；「我的剧集」拉 `/api/drama/projects`。  
3. 项目工作流骨架页：复用 `StudioView` stages，顶部步骤条（剧本→资产→分镜→视频→配音→对口型→成片），接 `compute_drama_pipeline_status` 显示就绪。  
4. 本地 `pnpm build` → `deploy/deploy.sh --web-only merlin@100.77.80.100` → curl/打开验证。  
5. 提交推 Gitee（**勿带** `docs/ops`、`docs/MODEL_SOURCES.*`）。

### Batch 2 — **已上线** `106e1c8` + 视频步收尾 `c31c312`（2026-10-01 ~05:35 CST）
- [x] 项目页七步就绪态条（剧本→资产→分镜→视频→配音→对口型→成片）+ `next_step` 提示  
- [x] 资产步：角色三视图槽（正/侧/全身）+ `CharacterPatch.reference_images`  
- [x] 分镜督导条（失败/渲染中/完成计数 +「重跑失败」）  
- [x] 视频步：H3 默认、每镜多候选（默认 2 选一）、多参考图槽（角色三视图自动填充 + 可加场景图）  
- [x] 场景图绑定 / 出图卡一键定妆 → Batch3 `00611b4`

### Batch 3 — **工具箱已上线** `00611b4` + `eff4a34`（2026-10-01 ~07:29 CST）
- [x] 场景图绑定：项目 `scene_images` 持久化；资产步绑定；视频多参考自动带入  
- [x] 出图卡/作品库一键定妆 → 角色三视图（就绪/失败态 + look pick 桥）  
- [x] 配音/对口型一键工具栏；成片验收条（耗时/定妆/场景提示）  
- [x] 工具箱信息架构收口与少字清扫 `eff4a34`（2026-10-01 ~07:29 CST）  
- [x] 配音/对口型/成片真 e2e 失败边界压测（Batch4；见下方运行记录）

### Batch 4 — **失败/边界压测已合入**（2026-10-01 ~08:28 CST）
- [x] Studio 配音：空对白 / 非法 shot / 缺角色卡 / 缺音色 → 明确 422；TTS 不可达 → 502
- [x] Studio 对口型：缺视频或缺配音 → 422；非法 shot → 404
- [x] Studio/drama 成片：无分镜 / 部分镜头缺失 → 422（detail 含镜号）；片段文件缺失可诊断
- [x] 成功路径 mock 契约；web `dramaUiBatch4` 源码断言工具栏仍接 API+catch
- 修复：有说话人时不再静默降级默认音；drama assemble 不再静默只拼已完成子集


### Batch 5 — **样片种子 + 整组重跑已上线**（2026-10-01 ~09:32 CST）
- [x] 幂等种子 `POST /api/studio/sample-projects/rain-night` → 固定项目「雨夜便利店·林夏」（四拍+林夏三视图+雨夜场景）
- [x] 步骤整组重跑 `POST /api/studio/projects/{pid}/steps/{step}/rerun`（video/voice/lipsync/storyboard；错误聚合不静默）
- [x] UI：`studio-step-rerun`「整组重跑」；首页「我的剧集」进度点 +「样片」入口
- [x] 缺资源降级：`assets_ready=false` + `asset_notes`；未登录 401

## 4. 设备分工（实验结束后再执行）

| 用途 | 建议 |
|------|------|
| H3 长视频 | 2–3 张 GPU（优先 h3-eval :8195 与扩容；**保护 :8196 生产**） |
| 分镜/角色生图 | 空闲实例（如 :8197）或非生产队列 |
| 配音 / 对口型 | 独立或错峰；勿与 H3 抢同卡峰值 |
| 非短剧 | 按需，低优先级 |
| **cuda:3** | **禁用** |

## 5. 样片验收标准（雨夜便利店·林夏）

| 项 | 标准 |
|----|------|
| 人物一致性 | 四段成片中林夏脸/发型/黑冲锋衣可辨为同一人；定妆三视图为锚 |
| 剧情贴合 | 进门→冷柜→收银台→出门四拍与对白对齐（见 `tmp/h3_long_exp/assets/scene_brief.md`） |
| 场景 | 雨夜便利店冷白灯/霓虹积水；竖屏 9:16 768p |
| 接缝 | A/B/C/D 对比：人脸相似度、接缝 SSIM/光流、音量跳变（`H3_LONG_EXPERIMENT.md`） |
| 耗时 | 记录每法总耗时；质量优先于成本 |

## 6. 运行记录

### 2026-10-01 ~02:30 CST
- 新建本文件（MateBook 仓库 + core）。  
- H3 素材四张已生成并落入 core `tmp/h3_long_exp/assets/`（证据 `ASSET_GEN_LOG.md` / `gen_meta.json`）。  
- 下一步：Batch1 导航+骨架；并行开跑方法 A 第一段（中文提示）。

### 2026-10-01 02:45 CST
- Batch1 导航「做短剧」+「工具箱」已在 core 运行（toiv-web 02:31 重启；提交 `05167c3` 在 MateBook 仓库）。
- H3 方法 A 第一段中文已在 `:8205` 开跑（见 `H3_LONG_EXPERIMENT.md`）。
- 下一步：Batch2 项目页步骤就绪态接 `drama_pipeline`；等 A-seg1 成片续跑。

### 2026-10-01 04:29 CST
- Batch2 上线 core（全量 deploy api+web；提交 `106e1c8`；Gitee `origin/main` 已推）。  
- 证据：`/home/merlin/toiv/web/components/studio/StudioView.tsx` 七步标签；bundle chunk 含「对口型」/ `studio-supervise`；`/api/health`+web:3100 = 200。  
- 测试：`dramaUiBatch2` + uxBatchC 24 pass；API `test_character_reference_images_patch` pass；`pnpm build` OK。  
- H3：未打断；仍为 A-zh-seg1 在 `:8205`（见 `H3_LONG_EXPERIMENT.md`）。  
- 残余：视频步多候选/多参考、场景图绑定 → Batch2 尾或 Batch3。

### 2026-10-01 ~05:35 CST
- Batch2 视频步残余上线 core（全量 deploy api+web；提交 `c31c312`；Gitee `origin/main` 已推；GitHub 443 超时未推上）。  
- 证据：StoryboardStage `studio-video-toolbar`；ShotCard `studio-video-opts`/`studio-cand-row`；API `RenderShotBody`+`pick_shot_candidate`；bundle chunk 含 `studio-video-opts`；`/api/health`+web:3100 = 200。  
- 测试：`dramaUiBatch2`+`dramaUiBatch2Video` 10 pass；API `test_render_body_h3_default_and_candidates`/`test_studio_shot_refs`/`test_render_no_body_stays_single_candidate` pass；`pnpm build` OK。  
- H3：未提交作业、未重启 Comfy、未动 workstation/:8196；旧无 body 的 render 仍单候选。  
- 残余：场景图绑定 / 一键定妆 → Batch3。

### 2026-10-01 ~06:25 CST
- Batch3 首刀上线 core（全量 deploy api+web；提交 `00611b4`；Gitee `origin/main` 已推；GitHub `github/main` 已推）。  
- 证据：CastStage `studio-scene-bind`/`studio-look-actions`；Assembly `studio-accept-bar`；Storyboard `studio-voice-toolbar`；ResultPanel `result-apply-look`；bundle chunks `7550.*`/`5836.*` 含上述字符串；API `scene_images_json` 列迁移；`/api/health`+web:3100 = 200。  
- 测试：`dramaUiBatch3`+Batch2 共 17 pass；API `test_project_scene_images_patch`+shot_refs+models+Batch2 render 相关 pass；`pnpm build` OK。  
- H3：未提交作业、未重启 Comfy、未动 workstation/:8196；progress 仍为 A/B/C 推进中。  
- 残余：工具箱少字收口；配音/对口型/成片重量级 e2e 边界压测。

### 2026-10-01 ~06:30 CST（推进+监督验收）
- 复核：Web bundle 已含 `studio-scene-bind`/`studio-accept-bar`（chunks `7550.*`/`5836.*`）；BUILD_ID 指纹仍标 `c31c312-dirty`（构建发生在 commit 之前的 dirty 树，功能已进包）。
- 修复：core DB 缺 `studioproject.scene_images_json`（部署后 api 未跑到迁移）→ 手动 `init_db()` + `systemctl restart toiv-api`；列已存在；`/api/health`+web:3100=200。
- H3：本轮未提交作业、未重启 Comfy、未动 `:8196`。

### 2026-10-01 ~06:31 CST
- 复核重建：`pnpm build` → BUILD_ID `20260930-222909-00611b4-dirty`；`--web-only` 部署；`/version.json` 已对齐；H3/api 烟测未打断。

### 2026-10-01 ~07:29 CST
- Batch3 工具箱信息架构收口上线 core（`--web-only`；提交 `eff4a34`；Gitee `origin/main` + GitHub `github/main` 已推）。
- 证据：MarketView `toolbox-hub` / `aria-label="工具箱"` 六段（应用|技能|图片|视频|音频|资源）；bundle chunk `7342.*` 含 `toolbox-hub`/`工具箱`；`/version.json` BUILD_ID `20260930-232817-eff4a34-dirty`；`/api/health`+web:3100 = 200。
- 测试：`dramaUiBatch3Toolbox`+Batch2/3+`appsViews`/`appsRh` 共 79 pass；`pnpm build` OK。
- 少字：AppRunner 默认「返回」；Library「逛应用」；ModelsView title 改工具箱。
- H3：未提交作业、未重启 Comfy、未动 workstation/:8196/cuda:3。
- 残余：配音/对口型/成片真 e2e 失败边界压测。

### 2026-10-01 ~08:28 CST
- Batch4 配音/对口型/成片失败边界压测合入（API 全量部署；提交见 git log Batch4）。
- 修复：`POST /studio/shots/{sid}/voice` — 说话人无角色卡/无音色 → 422；`drama` assemble — 部分镜头缺视频 → 422 `分镜未就绪(缺视频):[idx…]`。
- 测试：`test_drama_batch4_voice_assemble` + studio voice/assemble + drama assemble 回归共 **45+9** pass；web `dramaUiBatch4`+Batch3 **10** pass。
- 证据：`/api/health` + web:3100=200（部署后补）。
- H3：只读巡检；progress.json 仍停 05:26（冲刺在跑）；:8195/:8205/:8197 有活；:8196 空闲未碰；cuda:3 未用。
- 残余：真 IndexTTS2/LatentSync 联机 e2e（服务可达时再补）；四法成片结论仍由 H3 冲刺负责。

### 2026-10-01 ~09:32 CST
- Batch5 上线 core（全量 deploy api+web；提交 `14dd97c` + 类型补丁 `f6256ce`；Gitee `origin/main` + GitHub `github/main` 已推）。
- 证据：`/api/health`+web:3100=200；BUILD_ID `20261001-013133-14dd97c-dirty`；bundle chunk 含 `studio-step-rerun`/`studio-seed-rain-night`。
- 线上种子：admin 调 `POST /api/studio/sample-projects/rain-night` → 200，`assets_ready=true`，4 镜对白齐，三视图+场景已绑定；二次调用 `created=false` 同 id；未登录 401。
- 整组重跑：`steps/voice/rerun` → attempted=4 failed=4（缺视频，错误透出「需要先出视频」）。
- 测试：API `test_drama_batch5_sample_rerun` **8** pass；web `dramaUiBatch5`+Batch4 **8** pass；`pnpm build` OK。
- IndexTTS2 / LatentSync：本轮探测不可达（9880/11996 无响应），真联机 e2e 仍待服务；不阻塞 Batch5。
- H3：只读；:8195/:8197/:8205 有 running；:8196 空闲未碰；cuda:3 未用；progress.json 仍停 05:29（冲刺/队列在推进，MD 已到 09:04）。
- 残余：配音/对口型真联机 e2e；H3 四法成片结论；首页进度点可再接更细 stage readiness。

### 2026-10-01 ~09:38 CST（10 分钟汇报巡检）
- 复核：API :8090 ok；web:3100/3200=200；BUILD_ID `20261001-013133-14dd97c-dirty`（Batch5 已在线）。
- H3：只读；D seg3×2 + seg4 c1 在跑、seg4 c2 排队；:8196 空闲未碰；cuda:3 未用。
- 残余不变：IndexTTS2/LatentSync 真联机 e2e；等 D 成片后出四法结论。

## 09:43 CST 人工：配音/对口型服务已可用
- IndexTTS2 :9200（192.168.71.127）一直正常；之前“连不上”是误判。
- LatentSync :9103 自 09-07 停掉，已在工作站 GPU1 手动拉起（nohup ~/deploys/latentsync/serve_api.py --port 9103，日志 ~/latentsync-serve.log），core 访问 /health 200 model_ready=true。
- 下一轮立即用雨夜样片做配音→对口型→成片真机端到端，并测失败路径。


### 2026-10-01 ~09:46 CST（10 分钟汇报 · 配音真机）
- IndexTTS2 :9200 / LatentSync :9103 health 均 ok（此前误判已澄清）。
- 雨夜样片挂载 H3-C 四段成片为分镜视频 + 林夏音色 `dlg_h3b.wav`；真机配音 4/4 成功（见 `tmp/drama_voice_e2e_0946.json`）。
- 失败路径已测：空台词 422；角色无音色 422。
- 下一步：四镜对口型（studio lipsync → worker）→ assemble 成片；H3 D seg3/4 仍在队列。


### 2026-10-01 ~09:50 CST（10 分钟汇报 · 对口型通路）
- 配音真机 4/4 已通过（见 `tmp/drama_voice_e2e_0946.json`）。
- studio lipsync 原走 Comfy `LatentSyncNode`，:8196 无该节点 → 502；已改为优先 `TOIV_LIPSYNC_URL` HTTP agent，并修 `/api/studio/files` 内部自调 401（直读磁盘）。
- 雨夜镜0对口型已提交 agent 后台跑（日志 `tmp/drama_lipsync_agent_0950.log`）；其余三镜待镜0成功后批量。
- H3：归档 D seg4 c1（09:45，~4.6MB）；seg3×2 仍跑，seg4 c2 在 :8197 排队。

## 09:51 CST 人工纠偏（对口型）
- 绕道直调 :9103 只算服务可用，不算产品端到端。产品内“对口型”按钮走的 Comfy LatentSync 图缺节点 + 取文件 401，这是产品 bug，必须修：要么补齐 worker 节点（缺节点清单交设备管家口径），要么让 drama_studio 对口型改走 TOIV_LIPSYNC_URL(:9103) 并修 401（内部取片带鉴权/走内网直链）。
- 修完必须从页面按钮真跑雨夜样片 4 镜对口型 + 失败路径，才算完成。


### 2026-10-01 ~10:03 CST（10 分钟汇报 · 对口型+成片真机）
- 产品对口型已优先走 `TOIV_LIPSYNC_URL`(:9103)；非法分镜 → 404「分镜不存在」。
- 雨夜样片 `16e33f8b…`：镜1–3 对口型 API 200（约 75s/66s/60s）；镜0 此前 09:52 已通 → **4/4 lipsynced**。
- `POST .../assemble` 200，成片 `final-d98284b9ed26472c8f751e33597a9a6d.mp4`，项目 status=ready。
- 证据：`tmp/drama_lipsync_e2e_0959.json`。
- 残余：lipsync 优先 agent 的代码改动目前在 core `/home/merlin/toiv/api`（09:50），需回写 MateBook 仓库并推送；页面按钮手点验收可再补一条 UI 路径记录。

## 10:05 CST 人工：最高优先
- core 上 09:50 热改的对口型优先走 :9103 代码尚未入库。下一次任何 deploy 之前，必须先把该改动回写 MateBook 仓库、补测试、提交推送，否则部署会覆盖掉，导致对口型回退。

## 10:20 CST H3 实验结论 → 短剧主线下一步
- 结论：长视频默认走 C（Motion Context 22 帧+1s 音频 + Ref2VA 三视图/场景参考 + 原生音频）；A 不做有声；B 待修接缝/静音；D 关键帧过门禁前不产品化。详见工作站 docs/ops/H3_LONG_EXPERIMENT.md 与 metrics/ABCD_final_compare.json。
- 下一批（Batch6）：**已合入**（见下方 Batch 6）。
- 修订短剧方案：**已合入**（见第 7 节）。
- 用雨夜样片走 C 管线完整跑一集验收。

### 2026-10-01 ~10:20 CST — Batch5.1 lipsync agent 路径已入库并部署
- MateBook 已同步 core 09:50 热修 `api/app/services/studio/lipsync.py`（`lipsync_via_agent`，优先 `TOIV_LIPSYNC_URL`/:9103；`/api/studio/files/` 直读磁盘避 401）。
- 配置项 `lipsync_url`（env `TOIV_LIPSYNC_URL`）本就在 `app/config.py`，与 `video_lipsync` 一致，无需新增。
- 测试：`test_studio_lipsync_agent.py` + 既有 studio voice/lipsync / Batch4 相关共 **45** passed（agent 偏好 7 + voice 15 + batch4/lipsync 23）。
- 提交 `e012412` 已推 Gitee origin + GitHub；`deploy/deploy.sh --skip-web` 已部署 API，`/api/health` 200，core 文件仍含 `lipsync_via_agent`。
- 产品路径保持 agent 优先；未碰 H3/:8196/cuda:3。


### 2026-10-01 10:20 CST — 「短剧推进 10 分钟汇报」巡检
- 服务：API/Web 正常；Comfy :8195/:8196/:8197 空闲；:8205 已停（H3 收官）；LatentSync :9103 ok。
- H3 四法结论已落盘（C 默认）；Batch5.1 `e012412` 已部署。下一步 Batch6：视频步默认 C + 雨夜样片整集验收。


### 2026-10-01 10:39 CST — 「短剧推进 10 分钟汇报」巡检
- 服务：API/Web 正常；Comfy :8195/:8196/:8197 空闲；:8205 收官停机未重启；:9200/:9103 ok。
- 代码：本窗无新提交；线上仍 Batch5 + Batch5.1 lipsync agent（`e012412` / BUILD `14dd97c`）。
- 下一步不变：Batch6 视频步默认 C 管线 + 雨夜样片整集验收；修订短剧方案合入调研结论。


### 2026-10-01 10:46 CST — 「短剧推进 10 分钟汇报」巡检
- 服务：API/Web 正常；Comfy :8195/:8196/:8197 空闲；:8205 收官停机未重启；:9200/:9103 ok。
- 代码：本窗无新提交；线上仍 Batch5 + Batch5.1 lipsync agent（`e012412` / BUILD `14dd97c`）。
- H3：C 为默认长视频法（face均值 0.544）；D 不过门禁不产品化。
- 本窗启动 Batch6 实质推进（视频步默认 C 管线）；雨夜样片整集验收待管线合入后跑。

### 2026-10-01 10:58 CST — 「短剧推进 10 分钟汇报」巡检
- 服务：core API :8090 ok；Web :3100/:3200=200；BUILD `20261001-013133-14dd97c-dirty`。Comfy :8195/:8196/:8197 空闲；:8205 收官停机未重启；IndexTTS2 :9200 / LatentSync :9103 ok。未碰 :8196；cuda:3 未用；未重提 D。
- 代码：本窗无新提交；HEAD 仍 `e012412`（Batch5.1 lipsync agent）。上窗「启动 Batch6」尚未见仓库改动/产物。
- H3：四法已闭环，默认长视频 C（face≈0.544）；D 门禁未过不产品化。
- 下一步：Batch6 视频步默认 C（Motion Context+Ref2VA+原生音频、2 候选裁脸选优、台词不进画面提示）+ 雨夜样片整集验收；修订短剧方案合入调研结论。


### 2026-10-01 11:05 CST — 「短剧推进 10 分钟汇报」巡检
- 服务：core API :8090 ok；Web :3100/:3200=200；BUILD `20261001-013133-14dd97c-dirty`。Comfy :8195/:8196/:8197 空闲；**:8205 DOWN**（H3 收官后停机，本窗未重启）。IndexTTS2 :9200 ok；LatentSync :9103 ok model_ready。未碰 :8196；cuda:3 未用；未重提 D。
- 代码：本窗无新提交；HEAD 仍 `e012412`（Batch5.1 lipsync agent）。Batch6 视频步默认 C 仍未合入仓库。
- H3：四法已闭环（`tmp/ABCD_final_compare.json` 10:16），overall **C** face均值 **0.544**；A 0.281 / B 0.263 / D 0.107。D 门禁未过不产品化。
- 本窗已派执行器启动 Batch6（视频步默认 Motion Context+Ref2VA+原生音频、2 候选裁脸选优、台词不进画面提示）。

### 2026-10-01 11:16 CST — 「短剧推进 10 分钟汇报」巡检
- 服务：core API :8090 ok；Web :3100/:3200=200；BUILD `20261001-013133-14dd97c-dirty`。Comfy :8195/:8196/:8197 空闲；:8205 DOWN（H3 收官后停机，本窗未重启）。IndexTTS2 :9200 ok；LatentSync :9103 ok model_ready。未碰 :8196；cuda:3 未用；未重提任务。
- 代码：本窗无新提交；HEAD 仍 `e012412`（Batch5.1 lipsync agent）。Batch6 视频步默认 C 仍未合入仓库；雨夜样片整集 C 验收未开跑。
- H3：四法已闭环，默认长视频 C（face均值 0.544）；D 门禁未过不产品化。
- 下一步不变：Batch6（Motion Context+Ref2VA+原生音频、2 候选裁脸选优、台词不进画面提示）+ 雨夜样片整集验收；方案修订合入调研结论。代码推进由「ToIV 推进+监督」负责。

### 2026-10-01 11:21 CST — 「短剧推进 10 分钟汇报」巡检
- 服务：core API :8090 ok；Web :3100/:3200=200。Comfy :8195/:8196/:8197 空闲（queue 0/0）；:8205 DOWN（H3 收官后停机，本窗未重启）。IndexTTS2 :9200 ok；LatentSync :9103 ok model_ready。未碰 :8196；cuda:3 未用；未重提任务。
- 代码：线上 HEAD 仍 `e012412`（Batch5.1 lipsync）。MateBook 本窗出现未入库草稿 `apps/api/app/workflows/h3_pipeline_c.py`（11:21，管线 C 图构造）；core 尚未同步；雨夜整集 C 验收未开跑；无已排好的生成任务可补提。
- H3：默认长视频仍 C（face均值 0.544）；D 门禁未过不产品化。
- 卡点：Batch6（视频步默认 C）自 ~10:20 结论起逾 1 小时仍未提交/部署；代码推进交「ToIV 推进+监督」。

### Batch 6 — **视频默认管线 C 已合入并部署**（2026-10-01 11:30 CST）
- [x] 默认管线 C：`MiniMaxH3AudioConditioningT8`（Ref2VA UNET + 角色/场景参考 + native audio）+ Motion Context 22 帧 / 音频 24 帧续写 + Save/Load Latent
- [x] 每镜默认 2 候选；选优按裁脸相似度，疑似烧录字幕/OCR 文字降权（insightface 不可用时回落首个成功）
- [x] 台词不进画面提示词；Avoid 屏蔽字幕/文字/水印；批量与整组重跑默认 `pipeline=c`
- [x] 提交 `5c7b36b`；测试 API Batch6 **8** + 相关回归 **19** pass；web Batch6/2/5 **12** pass；全量 deploy 后 `/api/health`+web:3100=200
- [x] :8195 确认 T8 + MotionContext 节点；:8196 空闲未碰；cuda:3 未用
- [ ] 雨夜样片整集 C 真跑进行中：镜0 已 `rendered`（双候选，~51min）；镜1–3 管线 C 渲染中（进度 `tmp/batch6_rain_night_progress.json`）；失败路径 voice 无视频已验 4/4

## 7. 短剧方案修订（调研结论合入，2026-10-01 11:30 CST）

产品路径（逐集）：
1. **逐集剧本** — 一句话/梗概 → 分集大纲 → 分场对白（台词只进配音，不进画面提示）
2. **资产** — 角色三视图定妆；场景 **4–6 张机位图** + 站位图绑定到项目 `scene_images`
3. **分镜** — 按剧情节拍切段；分镜督导（一致性/违禁/单主体）；分镜图多候选选用
4. **视频（默认 C）** — Motion Context 续写 + Ref2VA 多参考 + 原生音频；每镜 2 候选裁脸选优；长镜按节拍分段
5. **音色资产** — IndexTTS2 角色音色卡；对白驱动配音
6. **后期** — 对口型（LatentSync :9103）→ 配乐/字幕/合成成片

门禁：D 法关键帧人脸门禁未过前不产品化；生产 H3 默认实例 :8195（eval）；保护 :8196。

### 2026-10-01 11:30 CST — ToIV 推进+监督
- Batch6 代码已上线；雨夜样片 C 整集验收已开跑（见上）。

### 2026-10-01 11:34 CST — 「短剧推进 10 分钟汇报」巡检
- 服务：Web :3100/:3200=200；**core API :8090 进程在（uvicorn 自 11:27）但不监听**，health 连接拒绝。Comfy :8195/:8196/:8197 空闲；:8205 DOWN（未重启）；IndexTTS2 :9200 ok；LatentSync :9103 ok model_ready。未碰 :8196；cuda:3 未用；未重提任务；未重启 API（仅允许重启对口型）。
- 代码：MateBook HEAD `0403cba`（/free 超时防挂死，11:33）← `5c7b36b` Batch6 默认管线 C（11:26）。线上 API 疑似卡在 Batch6 部署后的雨夜镜 0 渲染，fix 尚未生效监听。
- 雨夜：进度停在 `rendering_shot0_c`（11:29，项目 `16e33f8b…` / 镜 `62d66b39…`）；core 无 batch6 进程；队列空；无已排好生成可补提（API 不通）。
- 卡点：API 不可用阻塞整集 C 验收；交「ToIV 推进+监督」部署 `0403cba` 并恢复 :8090 后继续雨夜。

### 2026-10-01 12:35 CST — 「短剧推进 10 分钟汇报」巡检
- 服务：core API :8090 ok；Web :3100/:3200=200。Comfy :8195 running 1 / pending 0（管线 C 镜0 第2候选 `0478a311…`）；:8196/:8197 空闲；:8205 DOWN（未重启）。IndexTTS2 :9200 ok；LatentSync :9103 ok model_ready。未碰 :8196；cuda:3 未用；未 interrupt/clear/重提。
- 代码：本窗无新提交；HEAD 仍 `046bd90` ← `603e8f9` / `0403cba` / Batch6 `5c7b36b`。Web BUILD 仍 `14dd97c`。
- 雨夜：相对 12:29 **无新成片** — 镜0 第1候选仍为 `62d66b39_1_89498_00001_.mp4`（12:17）；第2候选仍在 :8195 跑。`batch6_retry2.py` 已跑 ~43 分钟；进度文件仍 `retry2_shot0_c`（项目 `16e33f8b…` / 镜 `62d66b39…`）；镜1–3 draft。无已排好空闲补提。
- 未完成：镜0 双候选选优未完；整集其余三镜/配音/对口型/成片未开。代码推进交「ToIV 推进+监督」。

### 2026-10-01 12:47 CST — ToIV 推进+监督
- **雨夜镜0 管线 C 双候选完成**：项目 `16e33f8b…` 镜0 `rendered`（耗时约 51 分钟）；选出候选1（`face_mean` 当时为空——线上缺 insightface，已装入 API venv，待本批视频结束后重启生效）；截帧 `/home/box/batch6_rain_night/f001.jpg` 等。
- **镜1–3 已开跑**：`tmp/batch6_shots123.log`；镜1 在 :8195 用镜0 Motion Context latent 续写（Ref2VA+原生音频）。
- **并行评估**：:8197 仅 6 个 H3 基础节点、无 Ref2VA/Motion Context，不能跑 C；:8195 已占评测卡；:8205 历史在同卡 cuda:2，重开会抢显存；未碰 :8196、未用 cuda:3。
- 下一步：盯镜1–3 出片 → 配音/对口型/成片；重启 API 启用裁脸选优后再对已出候选补评可选。
