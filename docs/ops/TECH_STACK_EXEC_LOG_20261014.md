# ToIV 技术栈方案执行日志（2026-10-14 起）

> 配套 `TECH_STACK_PLAN_20261014.md`（v3）与 `TECH_STACK_EXEC_PROMPT_20261014.md`。本文件记录各波执行证据与验收结果；每批一节，新批追加在后。

---

## 批次 1：T0 基线校准与卫生 + 用户四条新拍板（2026-10-14 晚）

### 执行者会话开工程序（§十 第一步）
1. 读 AGENTS.md 全文 ✅（当时 93,738B，超契约 4.6×）
2. 真机核实基线：
   - workstation `nvidia-smi`：GPU0 25.7G（冒测装模型中）/ GPU1 84.6G / GPU2 62.1G / GPU3 47.8G；RAM 159/183G；load 7~9
   - core PG（psql 直查）：total 14304 / public 2166 / pass 2170 / **public&pass 2156** / 未测 11,096 / fail 730 / timeout 305 / **running 3（战役在跑）**
   - `/api/opentalking/status`（带 token）: `{"enabled":true,"reachable":false}`
3. running=3 > 0 → 按 §十 走「不碰实例的 T0 项优先」，T1 顺延。

### 用户中途新拍板（本批生效，四条）
| # | 拍板 | 落地 |
|---|------|------|
| U1 | **opentalking 数字人下架**（不修复），资源优先 AI 短剧创作与视频内容 | 见下「T0-3 改判」 |
| U2 | **引用 img2threejs + hypit 功能** | 许可裁定+集成实施见批次 2 |
| U3 | **所有模型保持使用最新的模型** | 记为常备原则：一切引入/A-B 默认取最新版；各波落地时核对上游 latest |
| U4 | **整体 UI 优化，现在体验很不好** | 立项 **T-U 波（高优先）**，批次 2 起执行 |

### T0-1 AGENTS.md 归档瘦身 ✅
- 旧全文 93,738B → `.archive/AGENTS-full-20261014.md` 留档。
- 新 AGENTS.md：§七 焦点压缩为当日一条、§六 易错点去叙事留规则（全部 H-*/D-*/N-*/W-*/E-*/P-* 条目保留，叙事版见归档）、§八 只留开口项。
- 验收：`wc -c` = **20,473B < 20,480B** ✅

### T0-2 GPU 补账 + util 调优 ✅（判据修正）
- **补账**：qwen3-embedding :9302（进程名 `nemotron-venv` 有误导）实为 SentenceTransformer 自写脚本 `/opt/qwen3-embedding-server.py`、非 vLLM（**无 gpu-memory-utilization 参数可调**）、CVD=1 落 GPU1 —— 已入 AGENTS §三。
- **调优**：D6 默认「调 util」不可行 → 改为**重启回收**（服务 10-06 起连续跑 8 天显存膨胀）。10-14 17:2x 重启 `sudo systemctl restart qwen3-embedding`：active + `/health` ok；GPU1 **84.6G→56.1G（释放 28.5G，余量 41.8G）**。
- **判据如实修正**：方案验收「GPU1 余量≥60GB」在 H3#2（:8264，41.3G 常驻）不迁走的前提下不可达；实际达成 41.8G。若后续需要 60GB+，须把 H3#2 迁卡（新决策点，暂不动）。

### T0-3 opentalking：从「修复」改判「下架」（U1）✅
诊断过程（留档备查）：
1. core env：`TOIV_OPENTALKING_BASE_URL=http://192.168.71.127:4403`，enabled=true。
2. workstation 真机：`:4403` **无人监听**、无同名 systemd unit、无进程——不是「挂了」，是服务本体被归档。
3. `/home/merlin/systemd-archive/` 内找到整条链三个 unit：`opentalking.service`（:4403 unified API，CVD=3）+ `opentalking-tts-shim.service`（:19092→IndexTTS :9200 适配）+ `flashtalk.service`（ws:9000 渲染引擎）。journal 显示 09-07 05:57 被显式 stop 后归档；`.env` 完整（LLM 指 spark02、embedding 指 :9302、默认模型 flashtalk）。
4. 复盘：reachable=false 的根因=**整栈被人为归档**（旧记录「引擎离线」是症状不是诊断）。结合 U1 用户拍板下架，不复活。

处置：
- workstation 三 unit **保持归档态不复活**（代码与 .env 留盘可回滚）。
- core `TOIV_OPENTALKING_ENABLED=true→false` **已备好、待翻转**：⚠️ 冒测战役 running=3，禁重启 toiv-api（P-18b），翻转合并进 T1 的 running=0 窗口一次性做。
- web 数字人入口隐藏 → 归入 T-U UI 批。

### D7 pc01 撤池 ✅（闭账）
真机核实 `backends.json`：**已是 `:8196`(w1.5) + `:8263`(w1.0) 双后端**，pc01 :8188 早已不在池——AGENTS 旧记录「仅 gpu0 单成员」过期（:8263 为后加入成员）。D7 无需动作，闭账；pc01 修复降为非紧急开口项。

### T0-6 调研仓路径与红线登记 ✅
已入新 AGENTS.md §七 真源行：`~/Desktop/ALLProject/Ai-OSS-Reference` 为引入第一真源（637 条，逐仓 LICENSE 留档）；AGPL 167 + 未声明 431 只读不并码；引入仅限 Apache/MIT/BSD 且逐仓读 LICENSE。

### 本批新增易错点
- **P-24（本批）**：「服务 reachable=false」的第一诊断动作是 **SSH 到目标机查端口+systemd 归档目录**，而不是先看应用层配置——本次 :4403 三件全在 `systemd-archive/` 里，应用层完全无恙。
- **P-25（本批）**：验收判据里的目标值要**对照现场约束复核可达性**（GPU1 余量≥60GB 与 H3#2 常驻 41.3G 物理冲突），不可达时如实改记，不硬凑。

### 本批未做/顺延
- T0-4（W0-1b 红灯/W0-2 回归）→ 归入 T-U UI 波一并排障（同属前端真机回归）。
- T0-5 DESIGN.md token 契约 → 批次 2。
- T1 → 等 running=0 窗口。

---

## 批次 2：U2 集成 + T-U UI 审计与首修（2026-10-14 晚，续）

### U2-1 hypit SVML 词锚定 → 短剧线（api 侧，已提交待部署）✅
- 许可裁定：hypit = **修改版 Apache 2.0**，(a) 多租户 SaaS 禁、(b) 商业转售禁、(c) CLI/报告 LOGO 不可移除；**「obtaining Hypit and running it yourself on your own infrastructure / single-tenant deployments」明确许可 → ToIV 本地自用可并码**；产出视频归用户。转公开运营前须替换或购商业授权（入 R7 清单）。
- `apps/api/app/services/svml_lite.py`：`||` 拍分隔、`@{cue}词@{/cue}` **跨拍词锚**（hypit 原语义：锚开启到闭合间经过的每一拍都记录 cue + 锚内词）、`<角色|voice>` 说话人前缀、`[scene:/mood:/beat:]` 行内元数据、`---` 分镜分隔、`<shot>` XML 信封双形态；字数估时（4.2 字/s，夹 2–15s，显式 duration 优先）。
- `POST /api/drama/projects/{pid}/import-svml`：确定性解析不经 LLM，复用 `_create_shots_from_analysis`（清旧镜/自动建角色/视觉 token 注入全套），原始脚本留底 `project.script`（词锚信息可随时重析，为 W4-5 词锚定时间轴留根）；`auto_duration=false` 回默认 6s。
- 测试：`test_svml_lite.py` 13 例全绿（拍切分/跨拍锚/双形态/锚错误 422/估时夹值/端到端落库/归属校验）；`test_drama_studio.py` 98 例回归无破坏。

### U2-2 img2threejs 引入（api 技能正典，已提交待部署）✅
- Apache-2.0 无限制。改编为 ToIV 注册表格式 `app/skills/img2threejs/SKILL.md`（分阶段雕刻管线/质量门控/诚实保真度声明/ToIV 场景提示）+ `LICENSE-NOTICE.md` 归属留档；上游 forge 状态机（3.7MB）不引入，保留在调研仓克隆。
- **连带加固（真雷）**：`skills/registry.py` docstring 承诺「解析失败直接跳过不拖垮注册表」，但 `yaml.safe_load` 无 try——本批一个坏 frontmatter 实证把 `SkillsRegistry()` 初始化直接炸 ScannerError（生产上一个坏 SKILL.md 文件就能打死 api 启动）。已修（YAMLError/OSError → 返回 None 跳过）+ 防回归测试。skills 23 例全绿。

### T-U-1 真机 UI 审计（LAN 浏览器走查：首页/短剧工作台/工具箱/任务中心/智能体）✅
| # | 发现 | 处置 |
|---|------|------|
| 1 | **P-20 级真雷**：短剧项目卡「打开工作台」→ **404**（`/toiv/ws/...` 丢 `/studio` 前缀） | **已根修**：canvas 挂 `/studio` basename，裸 `<a href>` 绕过 router 前缀；`drama-page.tsx:93`/`drama-detail.tsx:184`（`/drama/...` 路径本身也错，应为 `/toiv/drama/:id`，双错）/`channel-settings-pane.tsx:498`（`/agents`）三处改 `<Link to>`；新增 `p20-subpath-anchor.test.ts` 全量源码扫描防线（2 例过）。canvas tsc 0 错 |
| 2 | 数字人入口（fusion 卡/@面板/⌘K/离线导航 4 处） | **已下架**：全摘 + 深链走「已下架」说明页；组件保留待 T7 对照池复用；防回归测试入 assistantPortal |
| 3 | 工具箱首次进入 spinner >10s（`全部 0` + 转圈），整页刷新后 5s 内正常渲染 200 应用 | **观察项**：API 实测 179ms/200 条正常 → 前端导航态问题（疑 client-side nav 竞态），待复现，不盲修 |
| 4 | 首页「意图」区「数字人」chip → market `avatar-talk` 应用 | **保留**（核实：avatar-talk=LongCat-Avatar ComfyUI 说话视频，不在 opentalking 下架范围，属视频内容生成=用户优先方向）；下架的只是 opentalking 实时数字人视图，LongCat 说话视频能力经工具箱无损可达 |
| 5 | 首页/短剧列表/任务中心/智能体视觉与结构 | 正常（暗色一致、任务中心可见 W8 战役作业在跑） |

### T0-5 DESIGN.md token 契约立项 ✅
- `docs/DESIGN.md`：格式对齐 google-labs-code/design.md（Apache-2.0，格式对齐不并码）；124 个 token 由 `scripts/gen_design_md.py` 从 `globals.css :root` 真源生成；prose 五节（颜色/排版/形状动效/使用铁律 P-2b 全集/机器校验）。
- `apps/web/tests/designTokens.test.ts` 4 例：声明 token ⊆ 真源、核心组双向覆盖防漂移、engineStudio 区零 hex 复查、契约正文存在性。web 全量 **1178/1178 全绿**。

### 部署与 LAN 验收（已完成）
- **web-only**：BUILD_ID `20261014-102310-88c6251f`（sha 对齐 HEAD），toiv-web 重启健康；**canvas-only**：core 本机构建换装，canvas-api-pg 第 1 探即就绪。toiv-api **未动**（战役 running=3 纪律）。
- **LAN 实弹验收**：①短剧卡「打开工作台」→ `/studio/toiv/ws/ea5cd51c…` **404 消失**，v2 六段工作区正常打开（截图验收）；②`/?view=avatartalk` → 「数字人功能已下架」说明页正确渲染（token 化样式正常）。
- **三端测试基线**：api 全量 **4379 passed / 38 skipped / exit=0**（34:58）；web **1178/1178**；canvas `tsc --noEmit` 0 错 + P-20 新测试 2/2 + skills/svml/drama_studio 针对性全绿。
- **canvas 全量 bun test 并发失败=预存环境性**（stash 对照实证：HEAD 同样 `backend not ready`+Bun 1.2.17 段错误，峰值 RSS 80GB；archive-sqlite-restore 单跑 3.9s 过）。记观察项，不记本批账。

### 提交与推送
- `2c84e79c`（T-U/T0 批：数字人下架+P-20 根修+DESIGN.md+AGENTS 瘦身）+ `88c6251f`（U2 批：SVML+img2threejs+registry 加固）+ 本收口批。
- **待 running=0 窗口捆绑执行**：api 部署（SVML 端点/img2threejs/registry 加固）+ `TOIV_OPENTALKING_ENABLED=false` 翻转 + T1（LongCat 迁 GPU3+160 装包+逐实例核验）。



---

## 批次 3：D-U1 拍板 B + FU1 短剧深融合 + R18 门控骨架（2026-10-15）

### D-U1 拍板落账（用户）
- 用户原话：「不想设置任何红线和限制……纯本地学习测试使用」→ **选 B**：撤销 R18 红线架构，canvas 内建 R18 门控模式，web 退役到登录+官网。**唯一绝对禁区=涉未成年（法律底线，非架构红线）**。方案 §4 已改判。

### FU1-a scene_asset v0（api，dramaclaw 设计采纳，待 api 窗部署）✅
- 新表 `DramaScene`（create_all 自动建，零 schema 变更）：base_scene_id 派生变体（变体只存 variant_prompt 增量+time_of_day）、environment_prompt、master/reverse 参考图、frozen_anchor 冻结锚点 JSON、camera_presets 机位预设。
- prompt 组装器 `[环境基础]+[变体增量]+[时段板]`（7 个时段白名单短语）；派生场景经 session 向上解析基础环境。
- 端点：列表(基础带 variants+孤儿透出)/建场景/派生变体(禁止二阶派生)/PATCH/删除(级联变体+分镜 scene_ref 就地解绑)/freeze-anchor(master|reverse|selected,缺图 422)/attach(写 DramaShot.scene_layout JSON 的 scene_ref 键——**零 schema 变更**；环境词幂等注入 prompt)/shot scene-ref 读回。
- 测试 4 例 + 相关回归 165 例全绿。

### FU1-b Studio 域 SVML 拆镜（api+canvas）✅（生产 e2e 待 api 窗）
- 关键发现：v2 工作区跑在 **Studio 域**（`/api/studio/projects`，StudioProject/StudioShot），非旧 DramaProject 域——SVML 端点补了 Studio 域形态：`POST /studio/projects/{pid}/import-svml` 返回与 script/parse **同构** drafts（**不落库**），前端复用既有「建角色+PUT shots 全量替换」链——单一写路径。
- canvas 六段工作区剧本段新增「导入词锚定脚本」面板（语法占位提示/确定性解析提示/404 窗口友好文案）；`importSvmlStudio` client 函数。
- 测试 2 例；drama/skills/svml 回归 140 例全绿。**开口**：api 部署后工作区真机导入 e2e。

### R18 门控模式骨架（canvas，**已部署即刻生效**）✅
- `services/toiv/r18-mode.ts`：localStorage 持久化+dataset.r18 全局样式钩子+`nsfwHeaderEnabled`；client.ts 拦截器 R18 开启时全请求附加 `X-NSFW: 1`（后端 nsfw_ctx 零改动，未成年硬阻断不受影响）。
- `R18SettingsPane`：两步确认门（开启→显式确认）+状态呈现+关闭；入口 `initR18Mode()` 恢复持久化。单测 2 例+tsc 0 错。
- **LAN 验收**：设置页 R18 面板渲染正确、开启态持久化呈现、关闭按钮在位（截图）；用户已在浏览器实测开启。

### 部署与提交
- canvas `--canvas-only` 已部署（R18 骨架即刻生效）；api 侧（DramaScene+studio SVML+drama SVML+img2threejs）继续攒批等 running=0。
- 提交：`e0a1…`（本批）推送双远端。

---

## 存档检查点（2026-10-15，用户指示暂停存档）

### 本会话总账（2026-10-14 晚 ~ 10-15，7 个提交，双远端齐）
| 批 | 内容 | 状态 |
|----|------|------|
| 批1 | T0 卫生：AGENTS 93.7KB→20.4KB 归档/embdding 重启回收 28.5G/LB 池口径修正/opentalking 下架改判/D7 闭账 | ✅ |
| 批2 | U2 引入：hypit SVML 解析器+导入端点(13T)/img2threejs 技能+registry 加固(23T)/DESIGN.md token 契约(4T)/T-U 审计+数字人下架+P-20 短剧 404 根修 | ✅ web+canvas 已部署 |
| 批3 | D-U1=B 拍板/R18 门控骨架(LIVE)/scene_asset v0(4T)/Studio 域 SVML(2T) | ✅ R18 已部署，api 侧攒批 |
| 提交链 | `2c84e79c`→`88c6251f`→`a4c17669`→`8bf7aec6`→`9f65e0d1`→`ef02f652`（+本档） | Gitee+GitHub 齐 |

### 三处拍板存档
1. 10-14 四条：opentalking 下架（资源优先短剧/视频）/引用 img2threejs+hypit/模型保持最新/UI 优化高优先。
2. 10-14 晚：完全使用 BeefTV(canvas) 那一套 + 六仓深度融合（方案 `UI_UNIFY_FUSION_PLAN_20261014.md`）。
3. 10-15：**D-U1=B 不设红线架构**——canvas R18 门控模式，web 退役到登录+官网；涉未成年仍绝对禁区（法律级）。

### 生产现态（存档时点）
- core：web/canvas-api-pg active（canvas 含 R18 面板+SVML UI 面板）；**toiv-api 10-14 04:24 起未重启**（战役纪律）。
- 战役：running=3，public 2166→**2216**（持续上架中）。
- workstation：GPU0~40G(战役装模)/GPU1 56.1G(回收 28.5G 后)/GPU2 62.1G/GPU3 47.8G；LB 池=:8196+:8263。

### 下一会话入口（按序）
1. 读 AGENTS.md（<20KB 新版）+ 本文件存档节 + `UI_UNIFY_FUSION_PLAN_20261014.md`。
2. **等 running=0 窗口**→一次性 api 部署捆绑包：DramaScene+两个 SVML 端点+img2threejs+registry 加固+`TOIV_OPENTALKING_ENABLED=false` 翻转+SVML 工作区真机 e2e+T1（LongCat 迁 GPU3+160 装包+逐实例 object_info 核验）。
3. FU2 成片剪辑包：video-use(MIT) 五件套并码移植（packed transcript/EDL 协议/词边界剪规/timeline_view VLM 下钻/渲染后自评闭环）。
4. F9 助手统一（canvas /toiv/agent 吸收 web 浮层+⌘K）→ F10 引擎台四缺口 → F11 库收编 → F12 web 壳退役（R18 已由 canvas 面板承接，无阻塞）。
5. 挂账观察项：工具箱首进 spinner>10s（API 179ms 正常，疑前端导航态竞态）；canvas 全量 bun test 并发失败=预存环境性（Bun 段错误）。

---

## 批次 4：2026-10-15 凌晨 止血 + 取窗 + 取证（本会话）

### 4-0 三处对存档口径的纠正（全部真机取证）
1. **「等 running=0」不是不可达门禁，running 列也不是孤儿**：api 启动日志实证 10-14 04:24:48 `reconcile_interrupted_smokes cleared 3 running card(s)`（main.py:252 已接线）。先前把 3 条 running 读成「10-13 孤儿」是误读 `updated_at`（无 onupdate，读出来是导入时刻）——正是 P-18b 原文警告的坑。真实在飞的活儿确实写 running（app_smoke.py:579），驱动停后 3 条里 2 条由 api 协程跑完（api 不因客户端断开取消），第 3 条落 pass。
2. **「完成侧停了 8 小时」是时区误读，作废**：`smoke_at` 由 `datetime.utcnow()` 写入=UTC，PG 时区 Asia/Shanghai。01:32 CST 查到的 max(smoke_at)=17:31 实为 1 分钟前。战役从未停摆。
3. **吞吐真值 ~21/h**（驱动自报 21-22/h + 180s 窗口实测 1 条/3min），不是存档说的 40-50/h。未测 10961（image 5812/video 5064/audio 89）。

### 4-1 吞吐降速真因链（实测）
- **host RAM 耗尽 + 75G swap**：free=157/183G、free 1G、/swap.img 7.6/8G + /swapfile-hyi 67.6/96G。两个 H3 实例占 59.9G+40.4G RSS。进程 D 态（wchan=wait_for_response）、ComfyUI HTTP 8s 不应答、模型加载慢。
- **LB 探针抖动**：3h 内 65 次 UNHEALTHY↔HEALTHY，直连探测却 1.9ms/200。根因=探测与媒体代理共用 session、HEALTH_TIMEOUT=3s、单次失败即摘除。已打补丁（10s + 连续 2 次失败才摘除，脚本 scripts/ops/patch_lb_probe_20261015.py，备份 comfyui-lb.py.bak-20261015-probe），应用后同窗口仅 1 次（真摘除）。
- **:8263 真卡死**：同 prompt 20+min、history 冻结、CPU 30s 涨 3s、GPU 0% → 重启（节点数 5309 前后一致，P-15 过关）。
- **worker_warmup 空转**：ace_step_1.5_turbo_aio.safetensors 只在 :8262/:8196 可见，:8195/:8264 ckpt 列表为空（H3 口只挂 h3/ 树）；旧实现取「第一个空闲候选」→ 音乐图打到 :8264 必 400。已修为按图核验可见性。
- **:8195 闲置 24h 白占 59.9G RAM + 61.9G 显存**（近 24h api 日志 0 次打 :8195、828 次打 :8264；生产 env 只指 :8264）→ 用户拍板 stop+disable。回收后 free 1G→63G、available 26G→87G、GPU2 62088MiB→23MiB。

### 4-2 窗口内一次完成（api 02:21:02 重启，PID 1042765）
- 部署捆绑包（88c6251f+9f65e0d1+4c80f558）：DramaScene 表建成（count 0）、两个 SVML 端点注册（未鉴权 401 非 404）、registry 加固、img2threejs。
- `TOIV_OPENTALKING_ENABLED=false` 进程内实测生效（env 备份 .env.bak-20261015-opentalking）。
- **P-18b 根治上线**：app.smoke_started_at 列 + 提交写 + reconcile 清 + `/api/admin/apps/smoke/status` 透出 running_cards{count,without_started_at,max_age_sec,ids}。生产实测读到 count=0。
- 全量基线 **4393 passed / 38 skipped / exit=0**（4m09s）。

### 4-3 SVML 真机 e2e（API + 浏览器双取证）
- API 级：POST /api/studio/projects/{pid}/import-svml 返回 {shots,characters,count}，`---` 分镜、[scene:]/[mood:] 与 <角色|voice> 正确、duration_sec 2-15s 夹值、**导入前后 studioshot 行数不变=端点确不落库**。
- 浏览器级（Playwright 受控浏览器，admin 既有登录态）：空项目「8264同seed验收0921」→ 剧本段「导入词锚定脚本」面板 → 粘贴含 @{回头}…@{/回头} 词锚样例 → 「解析并导入分镜」→ 自动跳 ?section=storyboard，分镜表 2 行（雨夜巷口 5s / 霓虹街口 3s，hardcut/draft/AI 配景），PG 复核 2 行落库 + 角色「林夏」自动建 + 无说话人行进视觉 prompt。截图 ~/svml-import-storyboard.png。
- **发现缺口（#18）**：解析器 Beat 带 cues/anchor_words（svml_lite.py:59-67），但 studio 路由只映射 8 个固定键（studio.py:152-165）→ 词锚到不了前端，FU1 时间轴/改词重排拿不到输入。

### 4-4 战役重启与新坑
- 驱动按原参重启（7148 清单→过滤后 6729，concurrency 3），日志改落 ~/toiv-ops-logs/rh_smoke/（RH_SMOKE_OUT_DIR 旋钮，根除 stash 换 inode 孤儿日志坑）。
- **新坑（#19）**：:8196 跑 SEEDVR2 超分时 CPU 密集（7B DiT 物化 CPU + BlockSwap 32/36），/queue 40s 全超时、GPU 0%，但日志在推进=长 CPU 阶段非卡死。驱动 900s 超时先于此类作业完成 → 假 timeout 混入归因（368 条 timeout 需重估）。

### 4-5 提交
`4c80f558`（smoke_started_at + 预热 ckpt 门 + LB 补丁脚本）、`8493662c`（日志目录旋钮）。双远端待推。

---

## 批次 5：2026-10-15 加速/量化审计（用户问「慢+占资源」后的自主第一步）

### 5-1 接线率审计（类名取自包源码 NODE_CLASS_MAPPINGS，未打运行中实例的全量 object_info）
| 能力 | 安装面 | 应用图引用(总/上架/过) | builtin | 判定 |
|---|---|---|---|---|
| SageAttention 补丁(PathchSageAttentionKJ) | 池实例 | 1252/129/129 | — | **已接线且规模验证=舰队事实标准** |
| FlashVSR 超分 | /opt+LongCat | 117/3/3 | — | 已接线，小样本过 |
| GGUF loaders | 全实例 | 140/9/9 | — | 已接线 |
| TeaCache/MagCache 包版 | 仅 /opt | 33/0/0（30 未测） | 无 | **RH 图接了但零验证**；required_nodes 已含→路由知晓 |
| WanVideoWrapper 内置 MagCache | 随 wrapper | — | wan_vace.py | builtin VACE 已接 |
| CacheDiT_Model_Optimizer | 仅 /opt | 0 | nextgen.py 加速档 | builtin 有档但默认关；phantom_studio 默认 turbo、h3_studio 走 h3_accel profiles |
| CacheDiT H3/Wan/LTX2 优化器 | 仅 /opt | 0 | 无 | 纯闲置；且 H3 实例(h3-eval)没装 CacheDiT=安装面错位 |
| MiniMaxH3BlockCacheT8 | H3+LongCat 实例 | 0 | 无 | **纯闲置**：图内节点(experimental)，threshold=0 即等价关闭=天然 A/B 旋钮 |
| CompileModel / NNLatentUpscale | 仅 /opt | 0 | 无 | 纯闲置（sm_120 风险，暂不动） |

### 5-2 两个假设被实测修正
- 「SEEDVR2 32/36 offload 是舰队配置」错：那是 **1445 张 RH 第三方图里作者自调的 blocks_to_swap**（分布 0/16/20/25/30/32/36/40）；builtin 超分走 ComfyUI 原生 seedvr 节点，无此旋钮。批量改第三方图不合所有权纪律 → #21 改判为「给 SEEDVR2 重作业有余量的卡/超时分级」，不动别人图。
- 「加速没接」错一半：builtin 已有完整加速档体系（wan_t2v/i2v 的 turbo=4 步 Seko 双 LoRA、turbo_cache=8 步+EasyCache；nextgen 的 Lightning+CacheDiT），只是**多数路径默认关**；phantom_studio 已默认 turbo。把哪条产品路径默认开加速档=质量取舍，留用户拍板。

### 5-3 已落（零质量代价）
- 驱动超时分级：video/SeedVR2/BlockSwap/VACE 家族 → 2400s（api 上限 3600 内）；客户端 timeout 后 90s 回读 PG 真值再定 status，止住假 timeout 归因与漏上架（api 协程不因客户端放弃而停，实测证）。
- 30 个自带 TeaCache/MagCache 的未测应用入 `tmp/rh_smoke_20261013/priority_accel_apps.txt`（下轮 ROUND_IDS 可切）。

### 5-4 下一步（按收益/风险）
① H3 block cache 接进 builtin H3 链（opt-in 参数默认关 + 同 seed A/B + 单实例灰度）；② 图系 DiT 补 fp8（#22，Qwen-Image 系先行）；③ 视频系切盘上 fp8/GGUF（#23）；④ 加速档默认值拍板（产品决策）。

---

## 批次 6：2026-10-15 烟测默认加速档（用户拍板：产品满血默认+显式选项，测试默认加速拿结果）

- 实现（43b57b08）：`settings.smoke_accel_level` 默认 **balanced**；`app_smoke._apply_smoke_accel`
  仅对 H3 家族图生效，`apply_acceleration` 对不可加速/规格缺失/连线校验失败原样返回（宁慢不坏）；
  admin 单跑端点 body.accel 可覆盖（"off"=本次满血，非法档 422）；生效档进 fixes 摘要与日志。
- 档位依据（core 规格 h3_accel_profiles.json 实测）：balanced=BlockCache T8+SageAttention，
  **2.94x / SSIM 0.8194（min 0.7847 过 0.75 门）/ recommended=true / 生产三档复测通过**；
  lossless 档 recommended=false 会被 apply_acceleration 自动拒（前端勿展示）；
  extreme=12.9x/SSIM 0.7494 预览级，须用户知情选择。
- 部署前排雷：balanced 会加 MiniMaxH3MemoryEfficientSageAttentionPatch(KJNodes)+MiniMaxH3BlockCacheT8，
  而 apply_acceleration 不校验节点安装 → 单类探测核实 :8264 两类均 PRESENT 后才部署。
  顺带修正批次 5 审计措辞：blockcache 并非「纯闲置」——直接图引用为 0，但 h3_accel balanced 会动态接入。
- **真机验证**：POST /api/admin/apps/h3-t2v/smoke（不传 accel）→ pass + fixes=['accel=balanced']，
  端到端 184s（规格 native 515s → balanced 175s 去噪），约 2.8x 实测生效。
- 全量基线 4398 passed / 38 skipped / exit=0（+5 例加速档测试）。战役 04:09 带加速档重启。
- 开口：#24 加速档显式选项进产品路径（默认满血，档位带倍率/SSIM 说明）；#21/#22/#23 不变。

---

## 批次 7：2026-10-15 池扩容 + 缺件真因改判 + 词锚透传

- **池扩到三后端**：新通用实例 comfyui-gpu2-gen :8265（GPU2 整张空卡，UUID 0e6e9149 钉卡 H-6；
  drop-in 带 hf-mirror+headless-audio；instances 目录独立）。P-15 节点数 parity 5311=:8196；
  backends.json 热重载生效（gpu0,gpu3→+gpu2）；:8188 路由正常。启动期 NAS 扫描使 probe 一度 82s，
   settle 后毫秒级——新实例加池前必须等 probe 延迟回落，否则被自己的探针误摘。
- **缺件真因改判**：计划下载的 3 个资产（Z-Image-Engineer V4/V6 Q8 GGUF、flux1-redux-dev）
  **盘上全在**（NAS LLM/ 与 style_models/）。missing_model 的主因是**可见性/路由**（作业派到只挂
  h3/ 树的实例），不是文件缺失——:8195 停 + :8265 双树可见即治。规划器留档
  scripts/ops/plan_missing_downloads.py（只收 ledger_ok 或 hf 单候选+basename 唯一+目录可判定；
  本轮 plan=0 可下新增，104 blocked/170 absent 不碰）。
- **#18 词锚透传**：studio SVML drafts 增加附加字段 beats[{text,cues,anchor_words}]（既有 8 键不变）；
  +1 例跨拍锚断言测试。待下一 api 窗部署。
- 吞吐杠杆现状：池 2→3 后端 + H3 烟测默认 balanced(2.94x) + 超时分级；待复测稳态吞吐。

---

## 批次 8：2026-10-15 FU2 成片剪辑包完成（video-use MIT 五件全并码 + 生产 e2e）

- 五件：edit_pack(Packed Transcript,whisper/Scribe 双形状)/edit_edl(EDL 契约+词边界剪规硬规则)/
  edit_render(30ms 音频淡入淡出+单一输出帧率+无损 concat+质量梯)/edit_view(帧条+波形+词标签合成图)/
  edit_grade(ebur128+blackdetect+freezedetect 客观 QA+上限轮自评闭环,响度出带自动加增益重渲一次)。
- 编排 edit_job：单飞；EDL→素材落地→三级词级 ASR→packed md→校验不过不渲染→自评→下钻图；
  路由 /api/admin/edit/jobs(202/409)+状态+产物白名单发放；媒体转录索引 MediaTranscript 表+
  /admin/media/transcript+/admin/media/transcripts/search(去空格归一检索)。
- **修了两个真缺陷**：①mp4 当 audio/wav 贴 whisper 集群=500 且旧代码静默吞非 200 → 词级链在
  core 静默退化成均分（board_film 卡拉OK 同受害）；修在共享缝：非 wav 先抽 16k 单声道。
  ②剪规把「切边压在词起点」判成 0ms 静音=unsafe（e2e 抓出）；新语义=词内才 midword，
  首末词外侧 clean，其余看所处静音窗宽。
- **生产 e2e（scripts/ops/e2e_film_edit.py，两步式=agent 工作流）**：真配音成片 54.7s →
  外部 whisper 26 词/5 短语 → 片头 2.6s 静音内宽 EDL 放行（规则正确）→ 首短语内切点被拦
  (midword_cut) → 按 packed md ≥0.5s 间隙选切点跨两 take 出片 → 自检一轮过
  (mean -27.8 dBFS 在带内、零 findings) → final.mp4/timeline_view.png/takes_packed.md 均 200。
- 基线 4429 passed / 38 skipped / exit=0。
- 开口：#24 加速档显式选项 UI；F11 媒体库 UI 接检索面；#22/#23 量化试点；F9-F12。

## 批次 9：2026-10-15 #16 观察项收口 + #22 质量门基建

- **canvas 全量 bun test 并发崩溃=预存环境性，归档**：stash 对照实证 HEAD 同样 `backend not ready`
  + Bun 1.2.17 段错误、峰值 RSS 80GB；单跑全过。CI 口径建议：分片/串行跑 canvas 全量，
  不以并发全量作为门禁（本批不入 CI 配置，留档待 F12 测试清洗波统一处置）。
- **工具箱首进 spinner>10s 根因（源码取证）**：`router.tsx:55` 的 `Suspense key={pathname}`
  每次客户端导航整树重挂；`hooks/use-account-file-storage-usage.ts` 的容量计
  `refetchOnMount:"always"` 且 queryFn 不传 AbortSignal → 残留长请求占满 HTTP/1.1 六连接，
  `/api/apps` 排队 >10s；硬刷新杀连接故 <5s。次因：`client.ts:682` 把非数组 200 静默归一成
  「全部 0」（违 P-11）。
  已修：容量计传 signal + `refetchOnMount:true`（staleTime 30s 生效，重挂不再累积）。
  待修（等 F9 代理收工避免同文件冲突）：client.ts 非数组 200 改抛错；W0-2 的 pathname-key
  摘除按既定纪律先做 drama↔library↔market↔tasks 往返×10 真机回归再摘。
- **#22 质量门基建**：scripts/ops/ab_quant_gate.py（同 seed 同提示词 bf16 vs 量化变体各出一张，
  全局 SSIM + 留样 + gate 判读 ≥0.90 灰度/0.80-0.90 仅草稿/<0.80 拒）。
  盘点发现：z_image fp8_scaled 盘上 9-8 就有（z-image-turbo_fp8_scaled_KJ.safetensors），
  生产图却零引用=「盘上有≠产品在用」又一例；我起的重复下载已删。fp8 在 RH 导入图里已是事实
  标准（qwen_image_fp8 143 条在用等），缺口在自家 builtin builder 仍 bf16。

## 批次 10(2026-10-15 晨):量化门判读 + 舰队滚动 + F9/F10/F11 收编 + P-11 形状门

- **#22 门判读**:z-image bf16 vs fp8_scaled_KJ 同 seed A/B=**2.5x(124s→49.6s)/SSIM 0.8632 → draft-only**;样张 a_bf16.png/b_quant.png 肉眼复核=fp8 干净但语义漂移(背景/姿态不同),与 SSIM 一致。灰度落地=烟测路径 ckpt 字符串换权(`smoke_quant_ckpt_swap` 开关可回退),产品默认仍 bf16。
- **#23 改判**:wan2.2 t2v 现网自 08-27 起**默认已是 fp8_scaled 双专家**(当时无同 seed 门)→ 补回顾门脚本 `scripts/ops/ab_wan_quant_gate.py`(A=现网 fp8 / B=fp16 原件,抽 t+2s 帧 SSIM);GGUF 变体判不取(Q8≈fp8 位宽无收益,Q4 画质换不存在的显存压力;且 GGUF loader 节点未装)。
- **missing_node 173 普查**(PG smoke_error 全量重析):156 distinct 类键;主导簇=RH 云端节点(RH_LLMAPI_NODE 16 等,shim 范畴非装包)+ 陈旧错误 + 类键漂移(Text/FL Image Batch To Grid/Render NLF Poses)+ 少量真装包(WanAnimatePlus/Qwen-Image-DiffSynth/SCAIL alias)。
- **零下载修复**:`toiv_classkey_aliases` 包(只加注册键不复制第三方代码;SCAIL 相对导入需合成包加载,首版静默失效已修,留仓 scripts/ops/toiv_classkey_aliases_init.py);克隆 WanAnimatePlus(Apache-2.0 核验)+ ComfyUI_Qwen-Image_new(Apache-2.0 核验)入 /opt 共享树;inspyrenet **PyPI 不存在**且节点包两树皆无 → 记开口(2 app),不冒险动 venv。
- **舰队滚动踩坑**:①api 池=core env 直连 worker,**不经 LB** → backends.json 排水对 api 无效,战役 transport 失败 spike 即此;②nohup 脚本无 sudo → systemctl 拒;③:8196 长作业堵死事件循环,/queue 探针 25s 全超时(非死,是忙)。终态脚本 fleet_final:等 8265 ready → 双实例 sudo 重启 → P-15 双实例计数互核 + 9 目标键断言 → LB 恢复三后端。
- **F9/F10/F11 收编提交**:F9 助手统一(命令面/浮层/分叉/web home 跳转壳 fail-safe)、F10 引擎台四缺口(正典技能 tab/视图预设/超分入口/3D 工具位;GET /api/skills 不存在→静态镜像+注释标 P-14 过期风险)、F11 媒体库台词检索面(admin 门禁+P-11 形状门+浮层预览;F11_GAP 八项记录)。
- **P-11 形状门**:canvas 作业列表两处「非数组 200→静默空集」改抛错+回归断言。
- **#24 提交**:tiers 单一数据源(h3 实测档过滤 recommended=false/无倍率档;wan/qwen 静态参考禁编造数字)+ studio/渲染体 accel 透传 + 剧本工作区 Select 默认满血。
