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


