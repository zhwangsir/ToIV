# 竞品深度调研与优化路线图（2026-08-13）

> 对标：Liblib / 堆友 / RunningHub / MiniMax Design / 千问创作（+ Lovart/Flowith/Skywork/即梦/可灵参照）
> 范围：用户提出的五大方向 + 调研发现的冰山其余部分
> 性质：调研报告 + 落地路线图（不含实现代码）

---

## 〇、执行摘要

2025-2026 行业收敛出的**Agent 化创作六段式范式**：
`一句话入口 → 可视化拆解 → 主从多 Agent（Owner/Worker/Verifier）→ 参考锁定保一致性 → 画布资产管理 → 可编辑交付 + Skill 复用飞轮`。

ToIV 现状是**「强引擎中台 + 弱 Agent 前台」**：底层算力/引擎（H3、LongCat、LTX、Wan、TTS、反推）与工程质量（1195 测试、温度熔断、显存预检）已超过多数竞品的可控性口碑，但前台缺六段式范式中的「多 Agent 编排、Skill 资产化、评测闭环」三件套。本路线图按 **R1→R5** 五个阶段补齐，全部基于自托管栈（无新增云依赖）。

---

## 一、竞品能力矩阵（调研结论浓缩）

### 1.1 五家对标对象的关键发现

| 对象 | 对我们最有价值的发现 | 来源要点 |
|---|---|---|
| **千问创作** | 首页四入口：Agent Teams / AI 生图 / AI 视频 / WorkFlow；PPT 链路「先出大纲→用户确认→再生成」的前置确认设计；技能广场 9 大类 | create.qianwen.com 实测报道 |
| **MiniMax Design/Mavis** | **Agent Team 三角色（Owner/Worker/Verifier 对抗迭代）**；五步链路（Agent Mode→Canvas Flow→Skill Ready→Local Index→Output Sync 审核节点）；H3 多模态参考 **9 图+3 视频+3 音频分工式参考**；主 Agent 秒回"已拆分后台执行"解决长任务失联感 | MiniMax 官方博客 |
| **Liblib** | 算力经济系统（模型被用→创作者分算力）；在线 LoRA 训练；LibTV Agent 成品直出；2.0 后从模型超市转「模型聚合+专业工作流」 | liblib.art/viphome、36kr |
| **堆友** | **设计专家 Skill 交易**（方法论封装为可调用 Skill，人的经验资产化）；电商批量出图（实拍图+Excel 卖点→3 分钟批量出图）；全站免费商用 | D20 峰会、smzdm 实测 |
| **RunningHub** | 工作流一键封装「AI 应用」（隐藏节点、几个输入框）；**开发者最高 70% 分成**；RHTV 画布原生 Agent 支持**节点级暂停/干预/局部修改**（非盲盒生成）；按秒计费+调试不扣费 | 官方通稿 |

### 1.2 用户口碑高发痛点（=我们的差异化机会）

1. **算力排队/积分焦虑**（最高频：即梦高峰排队 2-10h、积分规则月改三次）→ ToIV 自有集群不排队、成本透明，可做口碑杀手锏
2. **生成可控性"抽卡"** → 我们的评测闭环（本文第四节）直接命中
3. **长任务 Agent 失联感**（MiniMax 官方承认最大单一反馈来源）→ 秒回+任务卡片+checkpoint 恢复
4. **工具能力边界露怯** → Skill 必须带 evals 测试集，质量可机验（GPT Store 失败教训：价值要沉淀在资源/流程/评测集，不是一句提示词）

---

## 二、方向一：末帧续写 + 多参考常驻

### 商业标杆
- 多参考上限：Vidu Q1 **7 张**、可灵 4、Runway Gen-4 References 3、MiniMax H3 **9 图+3 视频+3 音频**（分工式：图1定氛围、图2锁主角）
- 末帧续写：可灵延至 5 分钟、Veo 3.1 Extend 链式 20×7s=148s；普遍 3 次续写后主体漂移
- 音频/动作参考：Wan2.2 S2V（音频驱动）、即梦动作模仿、可灵 Elements 3.0（视频片段做主体参考，提取 3D 结构）

### ToIV 现状
- 末帧续写已有（H3 continue-video，GA 已验证）；LongCat 已用 context window（81/overlap16）
- 参考图：单参考图（RefImageUpload/ipadapter）；无多参考、无参考视频、无统一参考资产管理

### 落地建议（全部 Apache 2.0 / 可商用，96GB 单卡从容，与现有 WanVideoWrapper 生态同源）

| 优先级 | 方案 | 能力 | 显存 |
|---|---|---|---|
| **P0** | **Wan2.1-VACE-14B** | 统一多参考入口：多图+mask+**参考视频**（动作迁移/V2V/首尾帧）自由组合，ComfyUI 官方原生节点 | fp8 ~16GB |
| **P0** | **Wan2.2 Animate** | 参考视频驱动角色动作/表情 + Replace 换角 | fp8 16-24GB / GGUF Q4 8-12GB |
| **P1** | **SkyReels-A2** | 3 元素 E2V（人+物+场景），双分支保真；元素预处理管线是关键 | 单卡 batch 小可跑 |
| **P1** | **Wan2.1 Phantom-14B** | ≤4 张主体参考（⚠️ 自定义 License，商用前核对） | bf16/fp8 |
| **P1** | **Wan2.2 S2V-14B** | 音频驱动说话/唱歌，分钟级 | fp8 ~16GB |
| **P2** | **Uni3C** | 参考视频→运镜+人体动作迁移 | 0.95B 控制器 |
| **P2** | **Wan2.1-FLF2V-14B** | 首尾帧插值 | 14B |

**长视频连续性**：继续走 context window 路线（WanVideoWrapper 三件套 ContextOptions+BlockSwap+VRAMManagement 已社区验证 1025 帧），把 LongCat 经验推广到 Wan 系；末帧 i2v 保留作 H3 专线。

**产品层**：建「参考资产库」（角色/场景/道具/风格卡，常驻项目级，对标 MiniMax 分工式参考与 Lovart Brand Kit），每镜头从资产库勾选引用，而非每次上传。业界共识：**参考元素 ≤4 是质量拐点**，UI 应引导分工（一张锁角色、一张定氛围）。

---

## 三、方向二：AI 自动拆段 + 自动修指代

### 调研结论
- **拆段**：三级层次切分（叙事段落 → 镜头 shot 为最小生成单元 → 内建时长预算）；镜头粒度按下游模型稳定时长切（≤12-15s），每镜头四要素：主体/位置/动作/机位。**用 LLM 结构化 JSON 输出 shot list，不用传统 NLP 切分**（TextTiling 不懂镜头可生成性）
- **修指代**：混合路线最优——① 剧本阶段 LLM 建**实体注册表** `{实体ID: 规范外观描述}`（单一事实源）；② 拆段时 LLM 受约束重写：每镜头 `subjects:[实体ID]` + 自足画面描述（prompt 内不出现裸代词）；③ fastcoref/Stanza 做廉价校验兜底（防幻觉、支持增量重拆）。中文零指代普遍，LLM 路线权重应更高（CorefInst 已证指令微调 LLM 反超传统 SOTA 2pp）
- **资产先行（Asset-First）**是跨镜头一致性性价比最高手段：移除视觉锚点，角色一致性从 7.99 崩到 0.55（Lights, Camera, Consistency）

### ToIV 现状
- storyboard/orchestrator 已有 LLM 拆解（L3 层 qwen3.6），角色视觉 token 跨镜一致已验证
- **缺口**：无显式实体注册表（外观描述散落在 prompt 里）、无指代消解校验、无增量重拆

### 落地建议
1. 拆段 prompt 改造：输出强制 JSON schema `{scenes:[{shots:[{duration, subjects:[entity_id], visual_desc, motion_desc, camera}]}]}` + `entities:[{id, canonical_appearance}]`
2. 生成前闸门：fastcoref 扫描 visual_desc 残留代词 → 有则回退 LLM 重修
3. 实体注册表与方向一的参考资产库打通：entity_id ↔ 参考图三视图

---

## 四、方向三：主 Agent 统一入口 + 多 Agent 并行

### 调研结论（AniME/MiniMax Team 范式最成熟）

```
用户输入 → 主 Agent/Director
  · 意图澄清 → 秒回"已拆成 N 步"（治失联感）
  · 层级规划：需求→剧本→分场→镜头 DAG
  · 全局资产记忆库（角色/场景/风格 token）
        │ 规划期串行（强依赖）
        ▼ 生成期并行 fan-out
  图像 Agent×N / 视频 Agent×N(GPU 配额限流) / 音频 Agent(词级时间戳) / 字幕 Agent
  评审 Agent（VLM 质检→带批注重生成，≤k 次）
        ▼
  后期 Agent = 确定性代码（EDL JSON 时间线 → ffmpeg：concat 归一化/xfade 转场/
              sidechain 混音 ducking/ASS 字幕/loudnorm 响度）
```

关键工程教训：
- **规划与生成分离**：剧本/分镜串行，生成并行；DAG 只把资产锚点设为生成上游
- **合成层用确定性代码**（MoviePy/ffmpeg），不让 LLM 决策剪辑
- **评审回路局部化**（只用在创意决策点，否则成本爆炸）
- 编排框架：**LangGraph**（显式状态图+并行分支+checkpoint+interrupt，最贴合）优于 CrewAI/AutoGen
- 框架教训："单 Agent+好工具能解决就不上多 Agent"——ToIV 应按任务复杂度分级，简单生成仍走现有直链

### ToIV 现状
- agent/ 目录 = 单 Agent 问答助手（LLM+RAG+tools），无任务 DAG、无并行专职 Agent、无导演角色
- drama_studio 编排是固定流水线，非 Agent 驱动

### UX 范式（Devin+Manus+Flowith+Lovart 合成）
1. 任务卡片+流水线双形态；计划可见（Manus todo 式）、产物可见、干预点显性化
2. 干预操作收敛四类：**编辑文案 / 重生成（带引导词）/ 替换上传 / 通过**，嵌在卡片上
3. 并行感知：多镜头泳道/网格 + GPU 排队位置（我们独有的真实队列数据）
4. **确认门控分级**：剧本/分镜强制确认，镜头级免确认+事后单点重生，合成前时间线预览一次确认
5. 失败透明化：打回原因可见（"角色发色不一致，已重生成"）

---

## 五、方向四：Skills 广场（提示词资产化）

### 调研结论
- **格式**：SKILL.md + 资源包（Anthropic 规范已是事实标准）：YAML frontmatter（name/description/triggers/inputs/outputs/version/author）+ evals/（强制 golden 测试集）+ resources/ + scripts/；**渐进披露**三级加载（元数据常驻索引 ~100token，全文按需）
- **商店机制红线**（GPT Store 失败教训）：禁止裸用量排序（刷单）、上架必须审核+查重、分成首日上线（扣子：T+7 自动分账、开发者 70%、优质 90-95%）、使用零门槛
- **Dify 审核流水线值得抄**：GitHub PR + CI 门禁（格式/安装测试/隐私声明/evals 通过率）+ 风险分级（脚本类 default-deny 沙箱）
- **对话造技能**：入口在每次成功任务之后（就地转化）：访谈澄清 → LLM 抽象成 SKILL.md（变量提取）→ 自动造 3-5 测试用例 → A/B 验证 → 三级可见性发布（私有/团队/广场）
- 排序信号 = 任务完成率 × 7日留存 × evals 通过率 × 评分（防刷：仅完成任务用户可投票）

### ToIV 现状
- marketplace.py = **模型**安装（civitai/HF→NAS），非技能市场
- agent/knowledge/ 9 个 md 已具备知识文件雏形，但无触发路由、无 evals、无用户自创

### 落地建议
1. Skill 包格式对齐 SKILL.md 规范 + 强制 evals/；skill 内容 = 提示词链 + 工作流模板 + 参考资产 + 评测集
2. 首批官方技能（供给侧冷启动）：宣传片、电商产品图（对标堆友 Excel 卖点批量）、有声书、播客、短剧（我们最强链路）
3. 商店二期再接分成；一期先做「安装即用 + 完成率公开」

---

## 六、方向五：评测闭环（质量门禁 + HITL）

### 调研结论：三层漏斗架构

```
产物 → L1 确定性闸门(毫秒,免费: 格式/分辨率/时长/可解码/敏感词)
     → L2 领域 Harness(秒级,本地专家小模型):
         图: LAION美学 + CLIPScore/TIFA对齐 + ImageReward偏好（双门:对齐+偏好,缺一不可）
         视频: FastVQA技术分 + 时序一致性（⚠️ DOVER 2024-08 起非商业许可）
         文案: RAGAS忠实度 / RefChecker三元组 / SelfCheckGPT
         + 领域 checklist 逐条核验（如"短剧分镜规范20条"）
     → 双阈值三态: ≥τ高直通 / 中间带评语重生成(best-of-K, ≤2轮) / 低分升级
     → L3 VLM-as-Judge（裁判评语=缺陷定位,回注重生成; AIGVE-MACS 实证 +53.5%）
     → HITL: 对比预览+方向性提问+可编辑状态；30秒可决策；异步不阻塞；超时默认动作
人工裁决 → 回流偏好数据校准阈值 + 沉淀为技能 evals（数据飞轮）
```

关键工程要点：
- 评委模型必须先用人工标注集校准才能进 CI；候选项当不可信输入（防注入操纵评委）
- **安全红线**：涉及钱/删除/发布的闸门写死在代码层，不能写在提示词里（可被"我已预授权"绕过）
- 闸门可观测性：人工触发率 >5% 改提示词/重训，<0.1% 撤闸门

### ToIV 现状
- quality/ 已有规则检查（scene_pacing/slideshow_risk/variation_checker）= L1 雏形
- **缺口**：无 L2 打分模型、无打分→重生成回路、无人工升级节点、无评委校准机制

### 落地建议（全部本地可跑）
- P0：promptfoo 式分层断言 + RAGAS/RefChecker 文案门 + LAION 美学 + CLIPScore（一周可接入）
- P1：Q-Align（一模型统管图/视频质量+美学，pyiqa 一行调用）+ TIFA；评委用 spark02 qwen3.6 / studio04 Qwen2.5-VL-72B 本地化，评语回注重生成
- P2：FastVQA 视频门 → LangGraph interrupt 式 HITL → 裁决回流 evals

---

## 七、R1→R5 路线图（建议）

| 阶段 | 内容 | 依赖 | 价值 |
|---|---|---|---|
| **R1** | 实体注册表 + 拆段 JSON schema + fastcoref 指代闸门 + L1/L2 质量门（LAION+CLIPScore+RAGAS） | 纯后端，无新模型 | 一致性+质量基线，成本最低见效最快 |
| **R2** | VACE-14B + Wan2.2 Animate 引擎接入（多参考+参考视频）+ 参考资产库（项目级常驻） | GPU 容量评估（真机 nvidia-smi 先行） | 追平 MiniMax 9图参考的核心体验 |
| **R3** | 主 Agent 统一入口：LangGraph 导演 Agent + DAG + 并行专职 Agent + EDL→ffmpeg 合成层 + 任务卡片 UX | R1/R2 | 六段式范式主体 |
| **R4** | Skills 广场一期：SKILL.md 格式 + evals 门禁 + 对话造技能 + 5 个官方技能 | R3 | 资产飞轮启动 |
| **R5** | HITL 升级节点 + 评委校准 + 裁决回流 evals + 商店分成二期 | R3/R4 | 评测闭环完整化 |

**差异化定位**（避开竞品红海）：自有算力不排队+成本透明、引擎可控（温度熔断/显存预检）、R18 合规分级能力（竞品基本没有）、技能 evals 机验（GPT Store 没有的质量闸）。

---

## 附：主要来源

- MiniMax Agent Team: minimax.io/blog/minimax-agent-team-long-running-1779893953
- 框架论文: Mora(2403.13248) / FilmAgent(2501.12909) / AniME(2508.18781) / AniMaker(2506.10540) / AesopAgent(2403.07952)
- 指代: fastcoref(2209.04280) / CorefInst(2509.17505) / FreeStory / DreamStory(TPAMI 2025) / StoryGPT-V(CVPR2025)
- 多参考: docs.comfy.org/tutorials/video/wan/vace · SkyReels-A2(2504.02436) · Phantom GitHub · Wan2.2-S2V 官方工作流
- Skills: anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills · 扣子模板结算文档 · Dify marketplace PR 流水线
- 评测: promptfoo LLM-as-Judge · AIGVE-MACS(2507.01255) · MSVBench · Q-Align · TIFA · LangGraph interrupt
