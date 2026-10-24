> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行主机 / 端口 / 权重 / DOWN 口 → [`docs/ops/CLUSTER_TRUTH.md`](CLUSTER_TRUTH.md)。正文仅作考古，禁止盲抄配置。

# ToIV 技术栈演进与整合方案（2026-10-14）

| 项 | 内容 |
|------|------|
| **标题** | ToIV 技术栈演进与整合方案 v2：白皮书 × 真机现状 × OSS 调研仓 三源合并路线 |
| **版本** | **v3**（2026-10-14；v1/v2 同日成文，v3 增世界漫游 T-W 波） |
| **输入** | ① 用户白皮书《ToIV 2026 本地 AIGC 综合创作平台技术选型白皮书》v1.0（10 分册）② **用户 OSS 调研仓 `~/Desktop/ALLProject/Ai-OSS-Reference`（SURVEY.md：A 批 49 条目 + B 批 61 仓 + C 批 522 仓 + D 批 4003/988 克隆，共 637 条）** ③ AGENTS 活口径 ④ V5 计划（产品功能轴，执行中）⑤ 2026-10-14 真机核实（§1）⑥ **[v3] 用户新增功能指令：世界模型交互探索（WorldWalk），调研真源 `docs/ops/WORLD_MODEL_INTERACTIVE_RESEARCH_20261014.md`** |
| **用户拍板（2026-10-14，本文档生效依据）** | 「任何功能都应该放开」→ **D3 训练栈全档解禁**（推翻 V5 §15「不做自研训练/微调」）、**D4 SkyReels 对照 A/B 开跑**。范围澄清：UGC/多租户/公开运营等**运营边界不在本次解禁范围**，如需推翻另行拍板。 |
| **用户拍板 v3.1（2026-10-14 晚，执行中途新增）** | ①**opentalking 数字人下架不修复**（T0-3 改判；资源优先 AI 短剧创作与视频内容）；②**引用 img2threejs + hypit 功能**（img2threejs=Apache-2.0 可直接引入；hypit=修改版 Apache，**单租户自有设施运行明确许可→本地自用可并码**，多租户/商业转售禁、CLI/报告 LOGO 不可移除，转公开前须清）；③**模型保持最新**原则（一切引入/A-B 默认取最新版）；④**整体 UI 优化立项高优先（T-U 波）**。执行证据 `docs/ops/TECH_STACK_EXEC_LOG_20261014.md`。 |
| **性质** | 方向与执行计划。与 V5 并行不互斥：V5 = 产品功能轴，本文 = 模型/引擎/算力/引入标准轴。其余既有拍板（R18 物理隔离、splice2 默认、本地自用）不推翻。 |

---

## 0. 结论摘要

**一句话方向**：白皮书假设的硬件（4× RTX PRO 6000 + 2× DGX Spark）真机核实**就是现网**；白皮书的技术栈约 2/3 已在产；OSS 调研仓证明我们缺的另一半（评测门禁、预览档、声音资产、技能/工具标准形态、HTML 渲染范式）**全部有成熟开源件可直接取**——v1 识别的五大系统性缺口，v2 每个都补上了具体引入路径：

| v1 五大缺口 | v2 补上的开源答案（调研仓实证） |
|------------|-------------------------------|
| ① 评测门禁缺失 | **laya/nimble System-1 决策头**（33ms/单步、校准概率，替代生成式 LLM 判定，成本降 1–2 个数量级，SURVEY §5 标 P0）+ **pyiqa** 无参考指标（BRISQUE/NIQE/CLIP-IQA+）+ VLM 评审 → 三层 ModelBench |
| ② 预览/终渲不分档 | 视频 **TI2V-5B**（白皮书）+ TTS **pocket-tts**（CPU 可跑+ComfyUI 节点，调研 C 批）→ 双介质预览档 |
| ③ GPU 槽位失衡 | LongCat 迁 GPU3（T1，纯运维无依赖） |
| ④ 音频/数字人缺口 | TTS 三档体系（IndexTTS 终渲/GPT-SoVITS 音色资产/pocket-tts 预览）+ ACE-Step/AudioGen 清 sfx 501 账；数字人对照池从白皮书 3 件扩到 6 件（+InfiniteTalk 无限长口播/LatentSync/EchoMimicV2/OpenAvatarChat，全部 Apache/MIT 可引入） |
| ⑤ 编排原则未提炼 | 调研结构性结论直接给答案：**「MCP server + ComfyUI 节点 + CLI」是 2026 标准交付三件套**；技能包对齐 **agentskills 规范**（26K★规范本体）别自创；**HTML→视频**（hyperframes 61.2K★ Apache）成为字幕/片头/海报卡的新渲染范式 |
| **[v3] 新功能：世界漫游 WorldWalk**（用户指令：走进 AI 生成的世界自由探索） | **双路线落地方案**：B「生成→3D 重建→浏览器漫游」（零常驻 GPU，闭环短剧选景：漫游选机位→回写分镜）+ A「神经流式」（**HelixWorld** Apache 单卡 70G 音视同步 / **HY-WorldPlay** 720p@24fps 开源）→ 终态混合；详见 T-W 波与调研文档 |

**三源合并后的四主轴**（§3）：A 收敛与稳态 → B 评测驱动的槽位治理（+决策头质检）→ C 能力补全（声音资产/训练栈已解禁/数字人）→ **D 新范式与标准对齐**（HTML 渲染通道、技能规范、三件套交付、Pixelle 评估、竞品拉片）。波次 T0–T10 见 §4。

**一句话边界**：不换 LLM 大脑、不容器化、不做 LangGraph 重写、splice2 默认不动（A/B 输赢都需再拍板才换）、AGPL/未声明许可**只读不并码**（调研仓已盘出 AGPL 167 条 + 未声明 431 条红线清单）、去 AI 水印能力永久禁用、R18 绝不进 /studio、维持仅本地自用。

---

## 1. 真机基线（2026-10-14 实测，全部带证据）

### 1.1 硬件核实

| 项 | 实测值 | 命令/证据 |
|----|--------|-----------|
| workstation GPU | **4 × RTX PRO 6000 Blackwell Workstation Edition，97887 MiB/卡** | `nvidia-smi --query-gpu`（本会话） |
| RAM | 183Gi 总 / **154Gi 已用 / available 29Gi**（高位，守 H-3） | `free -h` |
| spark02 | **GB10（DGX Spark），aarch64**；spark01/02 = DSv4 TP2 双机 | `ssh dgmt-spark@192.168.71.84 nvidia-smi` |

**白皮书全部硬件假设就是现网，零采购可落地。**

### 1.2 GPU 槽位现状（compute-apps 实测映射）

| GPU | 已用/96GB | 常驻服务（实测归属） | 判读 |
|-----|-----------|---------------------|------|
| GPU0 | 13.9GB | :8196 gpu0-alt + :8197 LongCat(Wan2.2) + :9200 IndexTTS | **两个冒测主力共卡 = W8 吞吐上限的物理根源** |
| GPU1 | 78.7GB | :8264 H3-worker#2（41.3GB）+ qwen3-embedding :9302（37.3GB，卡位此前未登记，进程名 `nemotron-venv` 有误导性 → T0 补账；37GB 偏肥可调） | 健康 |
| GPU2 | 62.1GB | :8195 H3 主（UUID 钉卡）+ :8262 超分（空载） | 健康 |
| GPU3 | 47.8GB | :8199 Wan-Animate-2（空载）+ :9311 toiv-vlm（44.6GB）+ :8263 超分 | **~48GB 闲置 = T1/T3 落点** |

### 1.3 生产库与链路现值

| 指标 | 值（2026-10-14） |
|------|------------------|
| app 总数 / public / pass | 14,304 / **2,156** / **2,161** |
| smoke 未测 / fail / timeout | **11,115** / 726 / 299 |
| running | **3（战役在跑——T1 重启必须等窗口）** |
| opentalking | `{"enabled":true,"reachable":false}`——**数字人引擎离线，实测复现，T0-3 修** |

### 1.4 调研仓基线（新输入）

`~/Desktop/ALLProject/Ai-OSS-Reference`：SURVEY.md（186KB）+ 637 条档案 + 988 仓已浅克隆（`repos-toiv/` 等），含逐仓 LICENSE 留档、star/推送 GitHub API 实测（2026-10-11/12 快照）、能力信号抽取（mcp/comfyui/cli/skill…）。**这是跨会话资产，后续一切引入动作以它为第一真源。**

---

## 2. 白皮书 × 现网：逐领域差距矩阵（v1 保留 + v2 修订）

裁定四类：**已有·保持** / **引入·阶段N** / **原则采纳·不重写** / **否决·理由**。v2 修订处以 **[v2]** 标注。

### 2.1 图像

| 白皮书建议 | 现网现状 | 裁定 |
|-----------|---------|------|
| 终渲 FLUX.2-dev（量化） | flux2 已在角色资产线 | T8 窗（进窗条件：ModelBench 建成 + LoRA 配方成熟） |
| 中文/编辑 Qwen-Image-2.1 | qwen_edit_like 路由在产 | **T4 引入 A/B**（调研 A 批 §3.7 注意：Qwen-Image-2.1 为研究许可、明确不可商用——本地自用可过，**转公开运营前必须换**，风险 R7） |
| 设计/字体 Ideogram 4 | 无 | T8 窗 |
| 角色一致性 SDXL+LoRA/IP-Adapter/InstantID | 协议 v1 + majicMIX/flux2 | 已有·强化；**[v2] D3 解禁后 L1 图像 LoRA（ai-toolkit）入 T6** |
| HunyuanImage-3.0 | 无 | T8 窗 |
| 预览 schnell/klein | 无分档 | 与视频预览位合并（T3） |

### 2.2 视频

| 白皮书建议 | 现网现状 | 裁定 |
|-----------|---------|------|
| H3 精品有声 | :8195/:8264 生产 | 已有·保持 |
| Wan2.2 主生产 | LongCat :8197 | 已有·保持 |
| SkyReels-V2-DF 长镜 | splice2 是 10-07 拍板默认 | **[v2] D4 已批：T6 开跑对照 A/B**（W7-3 盲评量表裁决；输赢都需再拍板才换默认） |
| 预览位 TI2V-5B/LTX distilled | 无 | T3 引入（合流 V5 W3-2） |
| HunyuanVideo-1.5 | 无 | 不引（T8 也不优先） |
| Wan LoRA 训练资产位 | **[v2] D3 解禁：T6 执行**（musubi-tuner，调研 D-LORA 确认现成入口；Wan-Animate 不复用 Wan2.2 LoRA，官方告警） | 引入·T6 |
| **[v2] 无限长口播视频** | 无 | **调研 B 批 InfiniteTalk（8.0K★，可自由引入）入 T7 对照池**——与 splice2「短视频+拼接」互补，解长口播镜头 |

### 2.3 LLM / VLM

| 白皮书建议 | 现网现状 | 裁定 |
|-----------|---------|------|
| 大脑 Qwen3-32B on Spark | DSv4-flash TP2 无审查 1M ctx 70.5tok/s | **否决换脑**（R18 面刚需无审查；白皮书不知现网） |
| DeepSeek 满血/Qwen3-235B | — | 不做 |
| 导演 Qwen3-VL | :9311 8B BF16 | 已有·保持 |
| 评审 InternVL3.5 | 无 | **[v2] 换答案：不引入大评审模型，改用 laya/nimble System-1 决策头做结构化判定**（33ms、校准概率、ONNX/纯 CPU、MCP server 现成——SURVEY §5 对 C2 质检标 P0；生成式评审只留给 VLM 打分这一层） |

### 2.4 音频（**[v2] 扩为三档体系**）

| 白皮书建议 | 现网现状 | 裁定 |
|-----------|---------|------|
| 默认 TTS CosyVoice3 | IndexTTS 2.5 :9200 主路（勿再停） | **否决换默认**；**[v2] 调研 D-TTS 给出 A/B 对照组：Qwen3-TTS(13.7K★,Apache)/OmniVoice(14.5K★,600+语)/voicebox(56.9K★,MIT+MCP)** → 全部进 T5 的 ModelBench 听感评测集，赢不了不动 |
| 角色音色克隆 GPT-SoVITS | 无 | **T5 引入（D3 已解禁）**：一角一音色卡入资产协议（参考音哈希/情绪覆盖/CER 回归集） |
| **[v2] TTS 预览档/兜底** | 无 | **pocket-tts（9.9K★,MIT，「fits in your CPU」+ ComfyUI 节点）**：CPU 出预览配音，与 T3 视频预览档同构；亦是 GPU 全忙时的降级路径 |
| BGM ACE-Step 1.5 | sfx 恒 501 | **T5 引入并清账**；**[v2] 调研 D-MUSIC 补第二路径 audiocraft AudioGen（音效专用）**——sfx 走 AudioGen、BGM 走 ACE-Step 分开供给 |
| VC：RVC / Fish | 无 | 不引 |
| **[v2] 词级时间戳** | whisper 集群是句级用途 | **faster-whisper/whisperX（MIT/BSD）入 T5 试点**——V5 W4-5「词锚定时间轴」（译制/字幕/口型共用底座）的地基 |

### 2.5 数字人（**[v2] 对照池从 3 件扩到 6 件，全部可引入**）

| 来源 | 候选 | 裁定 |
|------|------|------|
| 白皮书 | LivePortrait + MuseTalk 1.5 / Hallo2 | T7 对照 |
| **调研 B 批** | **InfiniteTalk（无长度上限对话视频）/ LatentSync（6.1K★,字节,离线精修唇形）/ EchoMimicV2（4.7K★,Apache）/ OpenAvatarChat（3.8K★,阿里,实时交互全链路 ASR/LLM/TTS/口型/流式）** | **T7 对照池扩充**——全部 Apache/可自由引入，且 LatentSync/EchoMimicV2 有 ComfyUI 化路径（新实例守 E-1 `resolve_worker()` + E-3 真机 e2e） |
| 现网 | Wan-Animate-2 + opentalking M1–M6（reachable=false） | **T0-3 先修离线**，修不好直接用对照池替换选型 |

### 2.6 编排与基建（**[v2] MCP 立场从「T8 条件触发」升级为「三件套交付规范」**）

| 白皮书/调研建议 | 现网现状 | 裁定 |
|----------------|---------|------|
| LangGraph 状态机 + MCP 总线 | FastAPI agent-runner + canvas agent-host + ComfyUI-LB | **原则采纳·不重写框架**（四原则映射现网不变） |
| **[v2] 「MCP server + ComfyUI 节点 + CLI」= 标准交付三件套**（调研 C §7.2.5：mcp 与 comfyui 信号高频共现，Pixelle/ArcReel/LuxTTS/pocket-tts 均此形态） | 工具面自有 schema；ComfyUI 节点已有若干；CLI 零散 | **[v2] 升级为平台交付规范**：T5/T-H/T-P 起所有新能力按三件套交付（例：音色资产=MCP server + ComfyUI 节点 + CLI；HTML 渲染同理）；存量能力随触碰逐步补齐。MCP 端点收敛到 agent-host 工具总线，**不改控制面** |
| **[v2] 技能包对齐 agentskills 规范**（26K★ Apache，规范本体；调研 SKILL 子系统结论「别自创」） | SKILL_ENTRIES 自有格式 + canvas skill-packages | **T-S 对齐**（联动 V5 W5-4）；分发试点 `npx skills` 同款形态 |
| Docker Compose / K8s | systemd 舰队 | **否决迁移**（v1 理由不变；调研 COMFY 子系统的 StabilityMatrix 仅作实例治理借鉴，AGPL 只读） |
| GPU 四分法 | GPU0 三服务共卡 | 改良不重排（T1/T3） |
| MinIO | NAS 双树 | 保持 |

### 2.7 评测（**[v2] 自动指标层从单层变三层**）

| 建议 | 现网现状 | 裁定 |
|------|---------|------|
| 三套业务测集 + 盲评 + 评测可推翻权重 | smoke=单应用闸；无模型级 A/B | **T2 建 ModelBench**（固定测集+盲评页吸收 W7-3，不变） |
| **[v2] 质检判定换 System-1 决策头**（laya 32.3K★/nimble；33ms、Schema+校准概率、ONNX/CPU、带 MCP server） | 内容/门禁判定走 DSv4 生成式（慢且贵、需解析文本，P-9 文案陷阱那类） | **T2 起试点，T4 全用**：结构化是/否+置信判定换决策头；生成式只留 VLM 打分与盲评兜底。成本延迟降 1–2 个数量级 |
| **[v2] 无参考图像质量指标**（pyiqa：BRISQUE/NIQE/CLIP-IQA+/MUSIQ） | 无 | **T2 自动指标层加入**（NOASSERTION 许可→pip 独立服务调用，不并码） |
| **[v2] 本地内容闸**（NudeNet 轻量裸检） | 未成年硬阻断+X-NSFW 语义在 | 可选补充（AGPL→**独立服务调用、不并码不改码不分发**口径，见 D10） |

### 2.8 OSS 引入矩阵（调研仓 C 批 18 条逐条裁定 + A/B/D 批关键件）

> 引入方式五类：**评估引入**（沙箱真机 e2e 后定）/ **规范对齐**（格式/协议层面采纳）/ **直接引入**（许可干净+场景明确）/ **借鉴思路**（AGPL/未声明许可，只读不并码）/ **禁用**。

| 仓库（★/许可） | 引入方式 | 归属 | 一句话理由 |
|----------------|---------|------|-----------|
| ArcReel（5.4K/AGPL） | **借鉴思路** | 合流 V5 W3/W4-2 | 小说→资产→分镜→视频→**剪映草稿**闭环 = 短剧线最完整同构；「导出剪映」这步直接抄流程设计，代码一行不并 |
| Pixelle-Video（28.9K/Apache） | **评估引入** | **T-P** | 全自动短视频引擎 + ComfyUI/MCP 双接入；沙箱评估后三择一（挂池/借鉴/弃用），默认倾向借鉴其 ComfyUI+MCP 接法 |
| hyperframes（61.2K/Apache） | **评估引入** | **T-H** | HTML 写视频、agent 原生；字幕/片头/海报卡/歌词卡的新渲染通道，中文排版痛点直接消（HTML/CSS 是最好的中文排版引擎） |
| huobao-drama（16.1K/未声明）/ waoowaoo（14.5K/未声明） | **借鉴思路**（读流程编排） | T-S 竞品拉片 | 许可未声明禁并码；产品结构与 ToIV 高度重叠，必读其编排 |
| Jellyfish（6.7K/Apache） | **借鉴+可选引入** | T-S 竞品拉片 | 任务/素材组织与人工介入点设计可参考，Apache 允许局部并码 |
| voicebox（56.9K/MIT） | **借鉴+MCP 形态参照** | T5 | 声音工作室上位参照；桌面形态与 ToIV web 不匹配，不整仓引入，学其 MCP server 暴露方式 |
| pocket-tts（9.9K/MIT） | **直接引入** | T5 | CPU TTS + ComfyUI 节点 = 预览档/降级路径，零 GPU 成本 |
| Qwen3-TTS（13.7K/Apache）/ OmniVoice（14.5K/Apache） | **评估引入** | T5 评测集 | IndexTTS A/B 对照组，ModelBench 听感集 |
| video-shotcraft（11.3K/Apache）/ brag（15.3K/MIT）/ GPT-Image2-Skill（5.7K/MIT） | **直接引入（skill 资产）** | T-S 首批 | 电影感产品视频 skill / 项目→宣传条 / 图像提示词库；MIT/Apache 可自由用 |
| shuohao-skills（4.4K/Apache）/ shanyin-director-master（577/MIT）/ shanyin-screenwriting-master（1.3K/MIT）/ OnlyShot（310/MIT） | **直接引入（skill 资产）** | **T-S 首批重点** | 短剧 skill 全家桶：拆角色/排大纲/场景道具/剧本/**九列分镜表**/全格式编剧；OnlyShot 自称「17 失败模式沉淀」= W1-4 失败模式注册表的同类实现，重点读 |
| pascalorg/editor（24.8K/MIT）/ photocraft（49K/Apache）/ filmcraft（10.4K/Apache） | 借鉴思路 | T8 窗 | Rust 编辑器内核参考；ToIV 无自研 NLE 拍板（V4-4），只读 |
| graphify（125.6K/Apache） | 借鉴思路 | T8 窗 | admin 图谱反查已有，对照其索引与增量策略 |
| agentskills（26.1K/Apache） | **规范对齐** | **T-S** | Agent Skills 规范本体，ToIV 技能包格式对齐目标，别自创 |
| ~~utopia（8.3K/Apache）~~ | **[v3] 移出世界模型线** | 改记 KG/RAG 对照 | 自称 enterprise world model，实为 Rust 知识图谱/graphrag 系统（v2 误标，v3 纠正） |
| **[v3] HY-World 2.0 / HY-WorldPlay / HunyuanWorld-Mirror / WorldCrafter / VerseCrafter（Tencent 系，NOASSERTION）+ HelixWorld（Apache）+ LingBot-World v2 + AMD Micro-World** | **评估引入** | **T-W 世界漫游（v3 新增）** | 交互式世界探索功能：路线 A=流式（HelixWorld 单卡 70G 音视同步 / WorldPlay 720p@24fps），路线 B=重建漫游（WorldMirror 前馈 3D 高斯）；真源 `WORLD_MODEL_INTERACTIVE_RESEARCH_20261014.md`；Tencent 系引入前逐仓读 License.txt（本地已克隆） |
| RedInk（5.6K/未声明） | 借鉴思路 | T8 窗 | 小红书图文，未声明禁并码 |
| remove-ai-watermarks（6K/Apache） | **禁用（永久红线）** | — | 去 AI 水印/溯源，违反模型服务条款+与内容合规口径冲突；调研仓已标不可采用 |
| **A 批**：laya(32.3K)/nimble | **评估引入** | **T2 P0** | System-1 决策头=质检/门禁判定引擎（§2.7） |
| **A 批**：design.md（28.3K） | 规范对齐 | T0-5（合流 V5 W6-5） | 机器可读 token 真源格式，解 P-2b 三约束 |
| **A 批**：OpenMontage（66.7K/AGPL） | 借鉴思路 | 合流 V5 C4/C5 | pipeline/skill 文件组织法抄作业，不并码 |
| **A 批**：hypit SVML | 借鉴思路 | 合流 V5 W3-1/W4-5 | 分镜 DSL/词锚定语言设计参照 |
| **A 批**：dramaclaw/Toonflow | 借鉴思路 | T6 场景资产 | 「一致性=资产注册+场景世界」——ToIV 缺**场景/机位一致性实体**，T6 试点 scene_asset（合流 V5 W2） |
| **A 批**：MoneyPrinterTurbo（129.9K） | 借鉴思路 | 合流 V5 W3 | 文案→素材→字幕→配音→成片的 pipeline 分段成熟范式 |
| **B 批**：VideoLingo/video-subtitle-remover（Apache） | 评估引入 | T5/T8 | 译制链（V5 W4-5/F7）补强：字幕切割→翻译→对齐→配音→双语 |
| **B 批**：Phantom | 借鉴思路 | T8 窗 | subject-consistent video generation，C1 一致性观察 |

**许可总红线（调研 §7.4/§8.4 已盘全量）**：AGPL 167 条只读不并码；未声明许可 431 条禁并码（引入前逐仓读 `repos*/<slug>/LICENSE`，本地已留档）；32 条 suspect（fork/star 异常）用前复核 issue 真实度。

---

## 3. 四主轴（未来 6–12 个月方向）

**主轴 A｜收敛与稳态**：W8 收尾与上架闸、opentalking 修复、AGENTS 归档、W0-1b/W0-2、装包窗口、pc01 决策、**竞品拉片对照表 v1**（huobao/waoowaoo/Jellyfish + D-STORY 批，纯读代码零 GPU）。

**主轴 B｜评测驱动的槽位治理**：ModelBench（三层自动指标：决策头+无参考 IQA+VLM；盲评页）→ 预览双轨（视频 TI2V-5B + TTS pocket-tts）→ 图像栈 A/B。*槽位可热切换、评测做裁判、决策头做门禁。*

**主轴 C｜能力补全（D3 已解禁，全量执行）**：TTS 三档体系 + 声音资产 + BGM/sfx 清账 → 训练栈（Wan LoRA / 图像 LoRA / 音色）+ SkyReels 长镜对照 + scene_asset 场景一致性试点 → 数字人修复与六件对照池选型。

**主轴 D｜新范式与标准对齐**：HTML 渲染通道（hyperframes）→ **世界漫游 WorldWalk（[v3] 路线 B 先行：生成→3D 重建→浏览器漫游→机位回写分镜；路线 A 流式 PoC：HelixWorld/HY-WorldPlay）** → 技能包对齐 agentskills + 三件套交付规范 → Pixelle 沙箱评估 → 短剧 skill 资产批量引入（shuohao/shanyin/OnlyShot/shotcraft/brag）。

---

## 4. 可执行波次（T0–T10）

> 排期按单人+AI 会话双轨口径；GPU-小时为粗算。与 V5 互锁见 §5。**[v2] 新增/变更以粗体标出。**

### T0 基线校准与卫生（本周，~0 GPU-小时）

| # | 动作 | 验收判据 |
|---|------|----------|
| T0-1 | AGENTS.md 归档（66KB→<20KB 契约） | `wc -c` < 20480 |
| T0-2 | GPU 补账（embedding 卡位）+ util 调优（GPU1 释放 ~20GB，D6） | §三表补卡位；GPU1 余量 ≥60GB |
| T0-3 | ~~opentalking reachable=false 排障~~ **[v3.1 改判]下架不修复**（诊断实证：:4403 三 unit 自 09-07 起整体被归档=根因；用户拍板 U1 资源优先短剧/视频） | 三 unit 保持归档态；core env enabled=false 待 running=0 窗翻转；web 入口 T-U 隐藏 |
| T0-4 | 债务：W0-1b 红灯、W0-2 回归、pc01 决策（D7 撤池默认） | 闭账或决策记录 |
| **T0-5** | **DESIGN.md token 真源契约立项（design.md 规范格式，合流 V5 W6-5，解 P-2b 三约束；SURVEY §5 标 P0）** | 契约文档落 `docs/`，globals.css token 可机器校验 |
| **T0-6** | **调研仓路径与红线清单入 AGENTS**（`~/Desktop/ALLProject/Ai-OSS-Reference` 为引入第一真源；AGPL167/未声明431/禁用项三清单引用 SURVEY §7.4/§8.4） | AGENTS §四或 §五新增一行 |

### T1 冒测吞吐解锁 + GPU 槽位再平衡（1–2 周，~20–30 GPU-小时；**必须等 running=0 窗口**）

不变（v1 原案）：LongCat 迁 GPU3（UUID 钉卡+E-1+复核全套 H-6 纪律），与 160 装包+逐实例重启+object_info 核验（P-15）**合并同一停机窗**；验收=分卡+吞吐 ≥1.5×+节点总数不降；W8 批C 按闸放量。回滚=drop-in 改回 GPU0（<10 分钟）。

### T2 ModelBench MVP（2–3 周，~15 GPU-小时）**[v2] 自动指标三层化**

| # | 动作 | 验收判据 |
|---|------|----------|
| T2-1 | 固定测集落库（写实短剧帧 30/中文海报 20/产品三视图 10/短剧镜头集 15，提示词+参考+种子全冻结） | 入库带 hash 不可变 |
| T2-2 | **三层自动指标：①laya/nimble 决策头（是/否+置信，结构化判定）②pyiqa 无参考 IQA ③:9311 VLM 打分**；同输入同种子两跑分数一致 | 一致性 100%（决策头/IQA 天然确定，VLM 层温度=0） |
| T2-3 | admin 盲评页（吸收 W7-3 量表，同屏对照隐藏模型名） | 一轮 ≥3 人次 |
| T2-4 | 槽位晋升 SOP（测集→报告→盲评→拍板→切换→回滚；评测可推翻权重不可推翻门禁） | 裁决 ≥1 场真实 A/B 出报告（首选 T4） |

### T3 预览/终渲双轨（2 周，~15 GPU-小时；合流 V5 W3-2）

不变（v1 原案）：TI2V-5B 入 NAS + 预览实例钉 GPU3 余量；studio 预演档路由；smoke prescreen 前置闸（**语义红线：prescreen 只产 blocked_preview/进全量测，pass 仍只出自真模型 smoke**——守 E-9/P-13）；验收=预演 P95 < 终渲 1/3、误杀 <10%、全量需求降 ≥30%；回滚=摘 LB 池+env 开关。
**[v2] 增补**：预演档的配音同步降级到 pocket-tts CPU 档（T5 就绪后接通），预览全链路零 GPU 增量。

### T4 图像栈 A/B：Qwen-Image-2.1 vs 现役（2–3 周，~20 GPU-小时）

不变（v1 原案）：ModelBench 裁决；若换默认走结构化 edits 回放迁移（P-13 纪律）+ E-9 三分支复查；100 应用抽样 0 回归。**[v2] 门禁判定换决策头**（T2 产物）；**Qwen-Image-2.1 研究许可标记入 MODEL_SOURCES 许可四旗标**（转公开前必须替换，R7）。

### T5 音频能力补全（2–3 周，~20 GPU-小时；IndexTTS 主路一字不动）**[v2] 扩为三档体系**

| # | 动作 | 验收判据 |
|---|------|----------|
| T5-1 | GPT-SoVITS 服务化（钉卡避开 GPU0）+ 资产协议 voice 维度 | 1 角色完成音色资产，30s 对白样盲听通过 |
| T5-2 | pocket-tts 部署（CPU 档）+ ComfyUI 节点注册 | 预览配音零 GPU；节点 object_info 就绪 |
| T5-3 | ACE-Step 1.5（BGM）+ **audiocraft AudioGen（sfx）**分职部署 | **sfx 501 清账**；样片带生成 BGM 成片 |
| T5-4 | TTS A/B 评测集（IndexTTS vs Qwen3-TTS/OmniVoice/CosyVoice3，ModelBench 听感流程） | 报告出，默认不动除非完胜 |
| T5-5 | **faster-whisper/whisperX 词级时间戳试点**（合流 V5 W4-5 词锚定） | 一条样片词级对齐字幕产出 |
| 交付形态 | **全部按三件套交付**：MCP server + ComfyUI 节点 + CLI | 三件套各自 e2e 通过 |

### T6 训练栈与长镜对照（**D3+D4 已批，转正执行**；4–6 周，~80 GPU-小时）

| # | 动作 | 验收判据 |
|---|------|----------|
| T6-1 | **SkyReels-V2-DF 对照 A/B**（同脚本同角色 vs splice2，W7-3 盲评裁决） | 对照报告；换不换默认**另行拍板**（10-07 保护） |
| T6-2 | **Wan2.2 角色 LoRA 试点 1 角色**（musubi-tuner，GPU3 夜窗，rank16–32，30–80 段数据） | 跨 10 镜 face score ≥ 参考路线基线 |
| T6-3 | **图像 LoRA 试点**（ai-toolkit，与协议 L1 衔接：定妆图集→LoRA→版本入资产库） | 1 角色 L1 资产闭环 |
| T6-4 | **scene_asset 场景一致性试点**（dramaclaw「导演世界」思路：场景锚点/机位实体，合流 V5 W2） | 1 场景跨镜一致性对照样片 |
| 纪律 | 训练全部夜窗/空窗；与推理互斥锁（白皮书 GPU3 日训夜渲同构）；**L4 全参仍需单独立项拍板**（成本护栏） | — |

### T7 数字人修复与选型（2 周，~15 GPU-小时；前置=T0-3）

| # | 动作 | 验收判据 |
|---|------|----------|
| T7-1 | 现栈修复后，**六件对照池**出同源样片：Wan-Animate-2 / LivePortrait+MuseTalk / **InfiniteTalk（长口播）** / **LatentSync（唇形精修）** / **EchoMimicV2** / **OpenAvatarChat（实时）**（白皮书 3 件+调研 B 批 3 件，全部许可干净） | 对照矩阵（延迟/身份/唇形/长时程）+ 选型入档 |
| T7-2 | 资产协议补 avatar 字段（avatar_driver/lipsync_engine/identity_ref/eval_clip，白皮书四字段） | 协议升版 |

### **T-P Pixelle-Video 沙箱评估**（1–2 周，~10 GPU-小时）**[v2 新增**

| # | 动作 | 验收判据 |
|---|------|----------|
| T-P-1 | 独立 venv+独立端口沙箱部署（**不进 LB 池、不碰生产路由**；Apache 可并码） | 沙箱起服，e2e 出一条片（E-3） |
| T-P-2 | 评估三问：①其 ComfyUI+MCP 接法能否反哺三件套规范 ②其全自动管线与 ToIV 自研管线（V5 W3）重叠度 ③有无可摘的模块 | **三择一结论：借鉴（默认）/挂池/弃用**，报告入档 |

### **T-H HTML 渲染通道**（2 周，~5 GPU-小时）**[v2 新增**

| # | 动作 | 验收判据 |
|---|------|----------|
| T-H-1 | hyperframes 沙箱评估：headless 渲染→帧→NVENC 合成链路 | 出一条 10s HTML 渲染样片（字幕卡/片头） |
| T-H-2 | 首个落地场景=**字幕条/片头卡/海报卡**镜头类型入分镜契约（合流 V5 W3-1 JSON 升版与 W4 时间线；HTML 模板版本化=「代码即媒体资产」） | 一条样片用 HTML 镜头替代 ffmpeg drawtext，中文排版目检优于现状 |
| T-H-3 | 三件套交付（MCP server + ComfyUI 节点 + CLI） | 各自 e2e 通过 |
| 边界 | HTML 渲染是**第四种镜头类型**（DiT 视频/拼接/数字人之外），不做「整片 HTML 化」 | — |

### **T-S 技能与工具标准对齐**（2–3 周滚动，~0 GPU-小时）**[v2 新增**

| # | 动作 | 验收判据 |
|---|------|----------|
| T-S-1 | ToIV 技能包格式对齐 agentskills 规范（SKILL.md 结构/多宿主目录/`npx skills` 分发形态；联动 V5 W5-4，**别自创**） | 格式契约文档+1 个自有技能按新格式重打包双跑通过 |
| T-S-2 | **短剧 skill 资产首批引入适配**：shuohao-skills / shanyin-director（九列分镜表）/ shanyin-screenwriting / OnlyShot（17 失败模式沉淀，重点比对 W1-4 注册表）/ video-shotcraft / brag / GPT-Image2-Skill（全部 Apache/MIT） | ≥3 个 skill 在 ToIV 助手内可调用出真产物 |
| T-S-3 | **三件套交付规范落文档**（新能力=MCP server+ComfyUI 节点+CLI；MCP 端点收敛 agent-host 工具总线，不改控制面） | 规范入 docs，T5/T-H/T-P 按此交付 |
| T-S-4 | 竞品拉片对照表 v1（huobao-drama/waoowaoo/Jellyfish/BigBanana/LumenX/aid-studio，读编排与人工介入点） | 对照表入 docs，滚动更新 |

### **T-W 世界漫游 WorldWalk**（**[v3] 新增**；真源 `docs/ops/WORLD_MODEL_INTERACTIVE_RESEARCH_20261014.md`）

| # | 动作 | 周期/GPU | 验收判据 |
|---|------|---------|----------|
| T-W0 | 选型沙箱：读 Tencent 四仓 License.txt（本地克隆直读）；**HelixWorld 起服实测**（延迟/画质/显存/音频）；HY-WorldPlay 720p24fps 复现实测 | 1 周 / ~10 GPU-h | 两份实测报告（E-3 口径：真机数字，不抄 README） |
| T-W1 | **路线 B MVP**：现网图像栈 8–12 视角生成 → WorldMirror/TRELLIS 重建 → canvas Three.js 漫游（WASD+鼠标）→ **机位回写分镜 JSON**（W3-1 契约增 `world_camera` 可选字段） | 1–2 周 / ~10 GPU-h | 雨夜街道场景自由漫游 ≥60fps + 机位导出关键帧参考图 |
| T-W2 | **路线 A 三件全做成功能**（[2026-10-14 用户拍板「都尝试做成功能」，取消淘汰制）：**HelixWorld**（Apache，实时音视漫游）与 **HY-WorldPlay**（720p@24fps 实时高画质漫游）各出实时沙箱；**Echo-WM**（Action DSL 导航预演 + 四流音频）走现成 ComfyUI 节点接舰队。三者分时独占一卡（夜窗轮换），统一 `world.walk` 接口暴露 | 2–3 周 / 专用窗 | 三功能各自可演示：两个实时漫游端到端 <150ms/≥15fps；Echo-WM 出 Action DSL 预演片含四流音频 |
| T-W3 | 混合终态（WorldStereo 式边界扩展）+ 机位闭环接 W3 + 数字人入世界试点 | Q1+ 后置 | 「漫游选机位→一键成片」全链演示 |

**边界**：漫游=预演/探索档，成片永远出自 DiT 链路；R18 世界只进经典 web R18 面；交付守三件套（`world.build`/`world.walk`/`world.camera` = MCP+节点+CLI）；路线 A 与训练/冒测互斥调度（沿用既有专用窗纪律）。

### **T-U 整体 UI/UX 优化**（**[v3.1] 用户新增拍板，高优先**；与 T0-4/W0-1b/W0-2 前端真机回归合流）

| # | 动作 | 验收判据 |
|---|------|---------|
| T-U-1 | 真机 UI 审计（LAN 直连截图走查 web 全部主页面 + /studio canvas：加载态/错误态/空态/导航/移动端） | 缺陷清单入档（P-21 口径防假阳性） |
| T-U-2 | 高优先修复：数字人入口下架隐藏（U1）+ 审计出的 Top 体验缺陷 | 修复项逐条真机复验 |
| T-U-3 | UI 走查防回归：关键页面截图基线 | 基线入库可复跑 |

### **T8 旗舰观察窗**（滚动，不排期；**[v2] 扩容**）

| 候选 | 进窗条件 |
|------|----------|
| FLUX.2-dev 量化终渲 | T2 建成 + LoRA 配方成熟（白皮书 P13） |
| Ideogram 4 / HunyuanImage-3.0 | 设计场景真出现 + 显存 PoC 立项 |
| LTX-2 / SkyReels-V3 / H3 SGLang | 各自成熟度/瓶颈触发 |
| **世界模型系（Micro-World / LingBot-World v2 / HY-World 未入选件）** | **主体验已升为 T-W 主动线（v3）**；此处仅留落选件的滚动复评 |
| **Phantom（subject-consistent）** | C1 一致性需要新引擎时 |
| **VideoLingo / VSR 译制链** | V5 W4-5 词锚定落地后的规模化需求 |
| **filmcraft/photocyst/pascalorg-editor Rust 编辑器** | 永不主动进（V4-4 自研 NLE 不做），仅跟踪 |
| **graphify 图谱增量策略** | admin 图谱反查性能瓶颈时 |
| **fish-speech / VoxCPM / dia 等 TTS 新品** | ModelBench 听感集季度复评时滚动纳入 |
| MCP 全量总线化 | 三件套规范跑顺且出现第二个工具消费方 |

---

## 5. 与 V5 计划的合流与互锁（**[v2] 扩充**）

| 交叉点 | 处理 |
|--------|------|
| T3 ≡ V5 W3-2（双速出片） | 一个波共同交付 |
| T2 吸收 V5 W7-3（盲评量表）+ **W1 质检闭环**（决策头=W1-2 结构闸的判定引擎） | ModelBench=两者的落地形态 |
| T2-2 决策头 ↔ V5 W1-4 失败模式注册表 | OnlyShot 的 17 失败模式作外部比对样本 |
| T6-1 ≡ V5 W7-2 | 同一 A/B（D4 已批），输赢不自动换默认 |
| **T6-4 scene_asset ↔ V5 W2（一致性补课）** | 场景/机位实体并入 W2 资产域设计 |
| **T-H ↔ V5 W3-1（分镜 JSON 契约）+ W4（剪辑出口/时间线）** | HTML 镜头类型入契约；hyperframes+hypit 同为「代码即时间轴」参照 |
| **T-S ↔ V5 W5-4（Skills 方法论封装层）** | 技能格式统一按 agentskills 规范实现 |
| **T0-5 ↔ V5 W6-5（DESIGN.md token 真源）** | design.md 规范格式直接采纳 |
| **ArcReel/MoneyPrinterTurbo/hypit ↔ V5 W3/W4-2** | 借鉴参照物登记进 V5 对应条目 |
| T1 重启窗口 ↔ V5 W8 装包 160 | 合并同一窗口 |
| 轨 B smoke ↔ 轨 A 验收 | 沿用 V5 §17 错峰纪律 |
| **训练栈 ↔ V5 §15「不做自研训练」** | **已被用户 2026-10-14 拍板推翻（「任何功能都应该放开」）**；V5 该条以本文档为准；L4 全参仍单独立项 |

---

## 6. 资源与预算粗算（**[v2] 更新**）

| 波 | GPU-小时 | 主要吃卡项 |
|----|----------|-----------|
| T1 | 20–30 | 迁移对照+装包回归 |
| T2 | ~15 | 测集跑分+决策头标定 |
| T3 | ~15 | 压测+prescreen 标定 |
| T4 | ~20 | A/B 跑分+抽样回归 |
| T5 | ~20 | 音色训练+BGM+TTS A/B |
| T6 | ~80 | SkyReels 对照+LoRA 夜窗×3 |
| T7 | ~15 | 六件对照样片 |
| **T-P** | ~10 | 沙箱 e2e |
| **T-H** | ~5 | headless 渲染（大头在 CPU/NVENC） |
| **T-S** | ~0 | 纯规范+skill 适配 |
| **T-W0/W1**（v3） | ~20 | 世界重建+漫游 MVP（浏览器渲染零常驻 GPU） |
| **T-W2**（v3） | 专用窗 | 流式 PoC 独占一卡（夜窗，不占共享预算） |
| 合计 | **~220–250** | 不含 W8 存量冒测欠账 110–135（V5 轨 B 独立账，T1 后消化提速） |

---

## 7. 决策点（**[v2]：D3/D4 已拍板落账**；其余默认值不回复则按默认走）

| # | 决策 | 状态/默认 | 备注 |
|---|------|-----------|------|
| ~~D3~~ | **训练栈解禁** | ✅ **已拍板（2026-10-14 用户：「任何功能都应该放开」）**——L0–L3 全开（音色/Wan LoRA/图像 LoRA/人格 LoRA 按需排期）；L4 全参仍单独立项 | V5 §15 对应条目作废；AGENTS 已入账 |
| ~~D4~~ | **SkyReels 对照 A/B** | ✅ **已拍板开跑**（T6-1） | 换默认仍需 A/B 后另行拍板 |
| D1 | LongCat 迁 GPU3 | 默认迁（避 running 窗口） | 可自主执行 |
| D2 | prescreen 前置闸 | 默认加（pass 语义红线不变） | 可自主执行 |
| D5 | CosyVoice3/Fish 换默认 | 默认不换（T5 A/B 裁决） | — |
| D6 | embedding util 调优 | 默认调 | 可自主执行 |
| D7 | pc01 处置 | 默认撤池 | 可自主执行 |
| **D8** | **Pixelle-Video 评估后去向** | 默认**借鉴**（不直接挂池——全自动引擎与自研管线重叠，挂池有契约冲突风险）；报告出来后可推翻 | T-P 收口时回报 |
| **D9** | **AGPL/受限件「独立服务调用」口径**（pyiqa/NudeNet/StabilityMatrix 等：pip/独立进程调用，不并码不改码不分发） | 默认按此口径（AGPL 网络条款在本地自用无对外服务场景不触发；**转公开运营前全清**） | 口径入本节即生效 |
| **D10** | **T6-1 若 SkyReels 完胜 splice2** | 默认**只出报告不换默认**，换默认单独拍板（10-07 保护） | — |

---

## 8. 明确不做（**[v2] 扩充红线**）

1. 不换 LLM 大脑；不做容器化/K8s；不做 LangGraph 重写（v1 理由不变）。
2. 不推翻 splice2 默认（A/B 输赢都需再拍板）。
3. 不追 HunyuanImage-3.0 全量 / DeepSeek 满血 / Fish serving。
4. R18 绝不进 /studio；不公开运营（转公开前：全模型许可法务审 + 凭据轮换 + git 历史清理 + AGPL 面全清）。
5. EMO 不进部署清单（白皮书同判）。
6. 不跑 VBench 推理栈（V5 同判）。
7. **[v2] 去 AI 水印/溯源能力永久禁用**（remove-ai-watermarks 等，调研 §7.2.7 红线）。
8. **[v2] AGPL 167 仓 + 未声明许可 431 仓禁止并码**（只读思路；引入代码仅限 Apache/MIT/BSD 及明确可商用件，引入前逐仓读 LICENSE 留档）。
9. **[v2] facefusion/roop 系换脸仅限自有素材**（调研 §8.4）。
10. **[v2] 不做「整片 HTML 化」**（HTML 只是第四种镜头类型）。
11. **[v2] L4 全参训练不因 D3 解禁自动放开**（成本护栏，单独立项）。

---

## 9. 风险登记册（**[v2] 扩充**）

| # | 风险 | 缓解 |
|---|------|------|
| R1 | 新引擎「探测通过≠链路可跑」（E-3 三连实证） | 每波交付带真机 e2e 出片证据 |
| R2 | 换模半改存量图（P-13） | T4 结构化 edits 回放纪律；一条失败整体不落库 |
| R3 | 专用实例路由绕过模型检查（E-9） | T4 时 h3_like/qwen_edit_like/animate2 三分支复查 |
| R4 | 评测主观性 | 固定测集+种子+盲评规程；ModelBench 报告是换模唯一依据 |
| R5 | prescreen 冒充 pass | D2 红线：prescreen 两态输出，pass 语义不动 |
| R6 | RAM 高位（154/183G）+ 并行会话（H-3/P-5） | 上服务前 `free -h`；关键操作前 `journalctl -u` |
| R7 | **许可面**：Qwen-Image-2.1 研究许可（不可商用）、H3 地域、InsightFace/FLUX.2/Ideogram 非商用、**github 仓凭据明文公开可读** | 本地自用口径全可过；**转公开运营前**：全模型法务审+换掉 Qwen-Image-2.1 等研究许可件+轮换全部凭据+清历史（升格为门禁条件） |
| R8 | W8 战役在跑时误触发重启（running=3 实测） | T1 前置检查 running=0 + ActiveEnterTimestamp |
| **R9** | **第三方 skill/节点包供应链**（skill 内容=提示词资产相对安全，但节点包是代码） | skill 引入前人工审内容；节点包沿用 W8「不无人值守自动安装」纪律；suspect 仓（32 条）用前复核 |
| **R10** | **AGPL 网络条款**（若 AGPL 件以服务形态被对外网络调用） | D9 口径限本地自用；`CANVAS_OPS_TRUSTED_ORIGINS` 白名单已收口；转公开前 AGPL 面全清或替换 |
| **R11** | **训练栈解禁后的算力挤占**（LoRA 夜窗与冒测战役抢 GPU3） | T6 全部夜窗/空窗+互斥锁；W8 战役优先级高于训练（存量账先清） |
| **R12** | **skill 资产质量参差**（社区 skill 的提示词口径与 ToIV 纪律冲突，如成功文案禁 hint 词 P-9） | T-S-2 适配时过一遍 P-9 文案纪律与 R18 边界，冲突项改写或弃用 |

---

## 10. 北极星度量（每波收口回填；**[v2] 增 2 项**）

| 指标 | 现值（2026-10-14） | 目标（T5/T-S 完成时） |
|------|-------------------|------------------|
| public & pass 稳态应用数 | 2,156 | W8 闸控下单调上升（不设数字指标，防 P-17 假收益） |
| 冒测吞吐 | 基线待 T1 前测 | ≥1.5× |
| ModelBench 覆盖槽位 | 0 | ≥3（图像主槽/视频预览槽/TTS 槽） |
| 角色资产完备度（形/声/动/场） | 形 v1 / 声动场皆无 | 形+声+动试点+场试点（T5/T6） |
| 数字人链路 | reachable=false | reachable=true + 六件对照选型报告 |
| 预演档 P95 / 终渲档 P95 | — | 比值回填（目标 <1/3） |
| **[v2] 三件套交付覆盖率**（新能力按 MCP+节点+CLI 交付） | 0 | T5/T-H/T-P 全部 100% |
| **[v2] 技能包规范符合度** | 自有格式 | 对齐 agentskills，≥3 个外部 skill 适配入产 |
| **[v3] WorldWalk** | 无 | T-W1：路线 B MVP 可漫游+机位回写分镜；T-W2：流式 <150ms/≥15fps |

---

## 11. 变更记录

- **2026-10-14 v1**：初版。白皮书×真机差距矩阵+三主轴+T0–T8；当日真机核实（4×RTX PRO 6000/2×DGX Spark、PG 14304/2156/2161/11115、opentalking reachable=false）；否决换脑/容器化/LangGraph；D3/D4 待拍板。
- **2026-10-14 v2**：①**用户拍板落账**：「任何功能都应该放开」→ D3 训练栈全档解禁（推翻 V5 §15 对应条）、D4 SkyReels 对照开跑；运营类边界不在解禁范围。②**合并用户 OSS 调研仓**（`~/Desktop/ALLProject/Ai-OSS-Reference`，637 条四批）：新增 §2.8 OSS 引入矩阵（C 批 18 条逐条裁定+A/B/D 批关键件）；TTS 扩三档体系（+pocket-tts CPU 预览/Qwen3-TTS/OmniVoice/voicebox 对照）；数字人对照池 3→6 件（+InfiniteTalk/LatentSync/EchoMimicV2/OpenAvatarChat）；评测自动指标三层化（+laya/nimble 决策头、pyiqa 无参考 IQA）；**MCP 立场升级为「三件套交付规范」**（调研结构性结论）；新增 T-P（Pixelle 沙箱）/T-H（HTML 渲染通道）/T-S（技能规范对齐+短剧 skill 首批）三波；scene_asset 场景一致性入 T6；新增红线 4 条（去水印永禁/AGPL+未声明不并码/换脸仅自有素材/不做整片 HTML 化）与风险 R9–R12；北极星 +2 项。
- **2026-10-14 v3.1（执行中途，用户四条新拍板）**：①U1 opentalking 数字人下架不修复（T0-3 改判；诊断实证=三 unit 整体归档），资源优先 AI 短剧创作与视频内容；②U2 引用 img2threejs（Apache-2.0，图像→程序化 Three.js agent skill）+ hypit（修改版 Apache：单租户自有设施运行明确许可→本地自用可并码，多租户/商业转售禁、LOGO 不可移除，转公开前须清）功能——img2threejs 走 T-S/T-W1，hypit SVML 词锚定 DSL 服务短剧线（W3-1/W4-5）；③U3 模型保持最新原则；④U4 T-U 整体 UI 优化波立项高优先。T0 批执行证据：AGENTS 93.7KB→20,473B、GPU1 embedding 重启回收 28.5G（余量 41.8G，60GB 判据修正）、LB 池实为 :8196+:8263 双后端（D7 闭账）、PG running=3 战役在跑。详见 `TECH_STACK_EXEC_LOG_20261014.md`。
- **2026-10-14 v3（本版）**：**用户新增功能指令：世界模型交互探索（WorldWalk，「走进 AI 生成的世界自由探索」）**。新增调研真源 `docs/ops/WORLD_MODEL_INTERACTIVE_RESEARCH_20261014.md`（闭源标杆 Genie 3 24fps·Google Labs 公测 / Oasis 3 <40ms / World Labs Marble→World API→Atlas；开源池 HY-WorldPlay 720p@24fps 流式、HelixWorld Apache 单卡 70G 音视同步、HunyuanWorld-Mirror 前馈 3D 高斯、WorldCrafter/VerseCrafter 相机控制、LingBot-World v2、AMD Micro-World；四条技术路线横评；4×96GB 可行性测算与产品集成方案）。本计划新增 **T-W 波**（W0 选型沙箱→W1 路线 B 重建漫游 MVP·机位回写分镜闭环→W2 路线 A 流式 PoC·专用窗→W3 混合终态），主轴 D 并入，预算 +20 GPU-h+专用窗，北极星 +1。**纠错**：`deeplethe/utopia` 实为 Rust 知识图谱/RAG 系统，移出世界模型线（改记 KG/RAG 对照）。
