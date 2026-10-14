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

## 批次 2：U2 集成 + T-U UI 审计（2026-10-14 晚，续）

（执行中，见下批追加）
