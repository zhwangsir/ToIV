# 世界模型交互探索（WorldWalk）调研报告（2026-10-14）

| 项 | 内容 |
|------|------|
| **需求原文** | 「通过使用世界模型响应用户持续导航、视角变换等交互操作，真正实现人可以走进 AI 生成的世界自由探索」 |
| **产品代号** | WorldWalk（世界漫游） |
| **调研输入** | ① 用户 OSS 调研仓 `~/Desktop/ALLProject/Ai-OSS-Reference`（637 条档案 + 988 浅克隆，本文所有★/许可/能力信号均为仓库实测快照）② 2026-10-14 外网核实（DeepMind/Decart/World Labs/NVIDIA 官方源，见 §9）③ ToIV 真机基线（4× RTX PRO 6000 96GB + 2× DGX Spark，TECH_STACK_PLAN §1） |
| **结论先行** | **能做，且分两条互补路线**：路线 B「生成→3D 重建→浏览器漫游」今天就能在现网栈上落地（几乎零新增 GPU 常驻成本，画质高，与短剧选景闭环）；路线 A「神经流式交互」（Genie 3 式走进无限世界）已有开源实现可本地跑（**HY-WorldPlay 720p@24fps / HelixWorld 单卡 70GB 含空间音频**），需独占一张 96GB 卡。终态是 C 混合（B 做世界底盘 + A 做边界即时扩展）。PoC 计划见 §7（并入 TECH_STACK_PLAN v3 的 T-W 波）。 |
| **一处纠错** | 用户调研仓中 `deeplethe/utopia`（8.3K★）自称 "enterprise world model"，实为 **Rust 知识图谱/RAG 系统**（graphrag/pgvector/时序知识图谱），与视觉交互世界无关——TECH_STACK_PLAN v2 曾把它列进世界模型观察窗，**v3 已摘除**（改记为 KG/RAG 对照件）。 |

---

## 1. 体验标杆（闭源，定义产品形态与上限，不可本地部署）

| 产品 | 时间 | 能力 | 对 ToIV 的意义 |
|------|------|------|----------------|
| **DeepMind Genie 3** | 2025-08 发布；2026-01 [Project Genie](https://labs.google/projectgenie) 在 Google Labs 公测 | 文本/图 → 照片级可导航世界，**24fps 实时**，长程一致性 | 体验天花板参照：「走一步生成一步」的无限世界 |
| **Decart Oasis 1→3** | 2024-10 → 2026 | Oasis 1（20fps Minecraft 级）→ 3（**<40ms 延迟**，API only） | 低延迟标杆；证明消费级体验可工程化，但已闭源 API 化 |
| **World Labs（Fei-Fei Li）** | Marble 2025-11 → World API 2026-01 → **Atlas 2026-09** | Marble：文本/图/视频/粗 3D → 可导航 3D 世界（可导高斯点云）；Atlas：像素级相机控制 + 3D 重建 | 商业路线 B+C 的同向验证：世界可导出、可编辑、可组合 |
| **NVIDIA Cosmos** | 2025-01 起，开放权重（NVIDIA Open Model License） | Physical AI 世界基座模型 + Omniverse/OpenUSD 场景编排 | 面向机器人/仿真不是消费者漫游；仅作物理一致性参照 |

**含义**：闭源阵营把「走进 AI 世界」分成了两种产品——**流式无限世界**（Genie 3/Oasis）与**可导出可编辑的持久 3D 世界**（World Labs）。开源侧两条线在 2025-12 至 2026-09 间密集追平到「可本地跑」水位。

## 2. 开源可本地的世界模型池（全部在用户调研仓有档案/克隆）

| 仓库 | ★/许可 | 形态 | 关键事实（仓库/官方核实） | 路线 |
|------|--------|------|---------------------------|------|
| **Tencent-Hunyuan/HY-WorldPlay**（HY-World 1.5） | 1.6K / NOASSERTION（仓内 License.txt） | **流式视频扩散** | 一句话/一图 → 沉浸交互 3D 世界；**720p@24fps 实时**、长程几何一致（主打卖点）；训练框架全开源；基于 HunyuanVideo/Wan，SageAttention + AngelSlim fp8 量化可选；2025-12-17 发布，arXiv 2512.14614 | **A（旗舰）** |
| **NoizAI/HelixWorld** | 627 / **Apache-2.0** | 实时**音视双模**世界模型 | 「给它一张图和一句提示，向前走或转身——画面和声音一起更新，空间声场随相机转动」；**BF16 单卡 ~70GB**；2026-08 起，10-08 仍在推 | **A（许可最干净+带空间音频）** |
| **Tencent-Hunyuan/HY-World-2.0** | 2.7K / NOASSERTION | 多模态世界模型套件 | 重建+生成+模拟 3D 世界；Model Zoo 三系：WorldMirror（重建）/ HY-Pano（全景生成）/ **WorldStereo（世界扩展）**；gsplat 技术栈；全权重开源 | B/C（地基） |
| **Tencent-Hunyuan/HunyuanWorld-Mirror** | 1.2K / NOASSERTION | 前馈几何预测 | 一次前向出相机位姿/深度/法线/点云/**3D 高斯**（ICML 2026）；HF 在线 demo | B（重建骨干） |
| **TencentARC/WorldCrafter** | 473 / NOASSERTION | 相机控制视频世界模型 | 图/文 → 一致的相机控制场景探索；**隐式 3D 感知记忆跨视点保持场景**；2026-09-14 建，自带 Interactive Demo | D（预演片） |
| **TencentARC/VerseCrafter** | 441 / NOASSERTION | 4D 几何控制视频世界 | 相机+多物体运动的显式 4D 控制；**带 Blender 插件**（导演在 Blender 推机位→出探索视频） | D（预演片，导演侧） |
| **LingBot-World v2**（B 批已克隆） | — / 开源权重 | 视频生成系世界模拟器 | arXiv 2601.20540（2026-01）：开源世界模拟器，宣称开源侧 top-tier | A |
| **AMD Micro-World** | 2026-02 / 开源 | 动作控制交互视频 | AMD ROCm 博客发布，动作控制的开域可探索场景生成 | A（注意 AMD 优先生态，NVIDIA 适配需验） |
| **OpenDCAI/OpenWorldLib** | 879 / **Apache-2.0** | 统一代码库 | 聚合 hunyuan-world/lingbot-world/gsplat/VGGT 的世界模型训练推理框架 | 工程地基 |
| **JD JoyAI-Echo / Echo-WM**（A 批，本地已克隆） | 2.0K / **LTX-2 Community License + 仅学术非商用** | **全模态世界模型**（LTX-2.3 底座 + Gemma-3-12b 文本塔，roadmap 上 2.5） | 2026-10-14 本地核实：**四流联合最强**（视频+环境声+音乐+语音，分列 video-cfg/audio-cfg）；交互=**Action DSL 脚本式**（w/s/a/d+i/k/j/l，`w-60,a-60` 段式，**非实时键鼠流**）；Base 段长 ~10s/30 步，Flash=4 步 DMD 蒸馏自回归（sink+FIFO 有界缓存），**流式在线 demo 官方未发**（coming soon）；六段式 prompt 技能+FOV 控制（MoGe-2 自动）+Gradio+多 GPU 批跑+第三方 ComfyUI 节点；UE 数据引擎（物理轨迹+MRQ 渲染） | **A 雏形+D（预演）**；T-W2 音频流来源与 `world.walk` 接口设计参照 |
| 早期研究线 | GameNGen / DIAMOND / MUSE 等 | 游戏内交互生成 | 历史脉络（2024–2025），已被上表超越，不部署 | — |

**许可口径**：Tencent 系四仓均为 NOASSERTION（仓内有 License.txt，本地已克隆可直接读）——按既定红线「引入前逐仓读 LICENSE」执行；HelixWorld/OpenWorldLib 为 Apache 可并码；闭源三家的体验只能参照不能复制。

## 3. 四条技术路线（本调研核心框架）

### 路线 A｜神经流式交互（"真·走进生成的世界"）

```
用户输入（键鼠动作 token / 文本指令）
   → 动作条件化流式视频扩散（逐帧生成、滑动上下文）
   → 帧流回浏览器（WebRTC/低延迟流）
```
- **体验**：Genie 3 式——世界不存在于任何 3D 表示里，走一步算一步，理论无限。
- **开源水位（2026-10）**：HY-WorldPlay 720p@24fps 实时 + 几何一致性主打；HelixWorld 单卡 70GB 且**画面与空间音频同步更新**（沉浸感差异化）。
- **代价**：①独占一张 96GB 卡持续推理（不能与冒测/训练共卡）；②画质天花板显著低于 DiT 成片（漫游像「可玩的预览」，不是成片）；③长程漂移仍在收敛中（各家主打卖点恰说明这是硬问题）。
- **ToIV 判定**：**做，但定位为「探索/预演体验」而非生产画质**。首个沙箱选 HelixWorld（Apache 干净 + 70G 恰好单卡 + 音视同步），画质上限目标盯 HY-WorldPlay。

### 路线 B｜生成 → 3D 重建 → 自由漫游（今天就能做）

```
场景提示词（来自剧本/分镜/一句话）
   → 现网图像栈生成多视角/全景（Qwen-Image、HY-Pano 类）
   → 前馈重建（HunyuanWorld-Mirror：一次前向出 3D 高斯；或 TRELLIS/Hunyuan3D 出 mesh）
   → 浏览器端 Three.js/WebGL 或 3DGS 渲染 → WASD+鼠标自由漫游
```
- **体验**：World Labs Marble 同向——世界是持久的 3D 资产，可反复进入、可编辑、**可导出**；漫游是客户端渲染，**60fps 轻松、服务器零常驻 GPU**。
- **代价**：世界有限（生成时圈定范围），不是「无限生成」；动态物体弱（静态场景为主）。
- **ToIV 判定**：**首选落地路线**。生成侧复用现网图像栈（零新模型），重建侧 HunyuanWorld-Mirror/TRELLIS（调研仓确认可自由引入），渲染侧 canvas 已是 Web 技术栈 + img2threejs 提供了「代码即 3D 资产」范式。「走进 AI 生成的世界」的体验完整成立。

### 路线 C｜混合（终态）：B 做世界底盘 + A 做边界扩展

漫游到世界边缘 → 触发流式生成扩展新区块（HY-World 2.0 的 **WorldStereo（World Expansion）** 正是这个设计）→ 增量重建并入底盘。近景用确定性 3D（高画质稳定），远方用流式生成（无限感）。World Labs Atlas 的「生成+重建+模拟」闭环是商业同构。

### 路线 D｜相机控制视频（预演片，非实时漫游）

WorldCrafter/VerseCrafter：秒-分钟级出「可控机位探索视频」，不是实时交互。价值在**导演侧**：VerseCrafter 的 Blender 插件 = 在 Blender 里推机位→出探索视频；与 T6 场景资产/分镜预演衔接，列为 D 线辅助件不单独立项。

### 路线横评

| 维度 | A 流式 | B 重建漫游 | C 混合 | D 相机视频 |
|------|--------|-----------|--------|-----------|
| 「走进去」体验 | ★★★★★（无限） | ★★★★（世界内自由） | ★★★★★ | ★★（看片非漫游） |
| 实时性 | 24fps（开源实测口径） | 60fps+（客户端渲染） | 近端 60/远端 24 | 非实时 |
| 画质 | 720p 流式级 | 高（等于图像栈上限） | 分区 | 高（DiT 级） |
| 服务器 GPU | **独占一卡常驻** | **零常驻**（重建时分钟级） | 一卡+按需 | 按次 |
| 与短剧主链闭环 | 弱 | **强（选景/机位回写）** | 强 | 中（导演预演） |
| 开源成熟度 | HY-WorldPlay/HelixWorld 可跑 | 全链路现成 | 地基已有、集成自研 | 可跑 |
| 落地顺序 | 第二步 | **第一步** | 终态 | 随取随用 |

## 4. ToIV 硬件可行性测算（4× RTX PRO 6000 96GB 映射）

| 负载 | 显存 | 落位 | 备注 |
|------|------|------|------|
| HelixWorld BF16 | ~70GB/卡 | 独占一卡（夜窗 PoC → 专用窗） | 恰好单张 96GB；量化可再降（README 未给 fp8 数，实测补） |
| HY-WorldPlay（HunyuanVideo 基座 + SageAttention/fp8） | 待实测（官方面向 80G 级卡） | 独占一卡 | E-3 纪律：真机实测延迟/显存后落位，不抄官方口径当真 |
| HunyuanWorld-Mirror 前馈重建 | 数 GB–十余 GB 级 | 与图像栈共卡或 GPU0 余量 | 分钟级离线任务，无常驻 |
| 多视角生成（8–12 张） | 复用现网图像栈 | 按现有队列 | 单场景 ~5–10 分钟 GPU |
| 漫游渲染 | **0**（浏览器 WebGL） | 客户端 | 手机亦可（降采样） |
| **调度结论** | 路线 B 全部塞进现有余量；路线 A 需要一个「专用窗」（与 T6 训练互斥、与 W8 冒测错峰——沿用既有互斥锁与夜窗纪律） | | |

## 5. 产品集成方案（WorldWalk 在 ToIV 的落位）

### 5.1 三个用例（按价值排序）

1. **短剧选景/机位闭环（最高价值，主推）**：剧本/分镜的场景描述 → 生成世界（路线 B）→ 导演在 canvas 里**漫游选机位** → 机位参数（位置/朝向/FOV/焦段）**回写分镜 JSON**（W3-1 契约增 `world_camera` 字段）→ 该机位自动出关键帧参考图 → 进一键成片。世界漫游从「玩具」变成短剧线的上游工具。
2. **IP 世界探索**：剧迷/自用走进成片世界（雨夜街道、1224 案场景）；路线 A 提供无限延展版。**R18 边界照旧**：SFW 世界进 canvas；R18 世界只进经典 web R18 面，物理隔离不破。
3. **数字人入世界**：漫游场景 + 数字人（T7 对照池的 OpenAvatarChat 实时链路）= 虚拟演播/世界内导览；与 HelixWorld 的空间音频天然契合。

### 5.2 交付形态（三件套，守 v2 已定规范）

每个能力 = **MCP server + ComfyUI 节点 + CLI**：
- `world.build`（提示词→世界资产：多视角生成+重建，入 NAS 资产树+版本化）；
- `world.walk`（漫游会话：B 路线=静态资产下发；A 路线=动作流↔帧流）；
- `world.camera`（机位捕获/回写分镜）——对 agent 暴露后，**助手可以说「帮我生成雨夜街道并走到第二个路口」**。

### 5.3 资产与契约

- 世界资产 = `world_asset`（3D 高斯/mesh + 生成提示词 + 源图集 + 版本 hash），与 character_asset/scene_asset（T6-4）同库同纪律；scene_asset 是世界资产的单场景特例，二者统一设计避免两套表达（V5 W2 路线 A 精神）。
- 分镜契约增 `world_camera` 可选字段（不破坏既有消费方）。

## 6. 风险登记

| # | 风险 | 缓解 |
|---|------|------|
| W-R1 | 画质预期落差（流式 720p vs 成片级） | 产品文案明确「漫游=预演/探索档」；成片永远出自 DiT 链路 |
| W-R2 | 一卡独占挤占冒测/训练 | 专用窗调度+互斥锁（既有纪律）；W8 存量账优先级高于 WorldWalk |
| W-R3 | 长程几何漂移（路线 A） | HY-WorldPlay 主打此点仍需盲评；3 分钟连续漫游无崩坏为验收线 |
| W-R4 | Tencent 系 NOASSERTION 许可 | 本地仓已克隆，T-W0 逐仓读 License.txt 后再定引入深度；本地自用口径风险可控，转公开前复核 |
| W-R5 | AMD Micro-World 的 NVIDIA 适配 | 不列入首发，观察 |
| W-R6 | 浏览器端 3DGS 渲染兼容性 | Three.js 生态成熟（img2threejs 已验证路线）；fallback mesh 渲染 |
| W-R7 | R18 世界与 canvas 物理隔离被绕过 | 世界资产带内容分级旗标，SFW 闸在资产层强制（同应用分级纪律） |

## 7. PoC 计划（并入 TECH_STACK_PLAN v3 = T-W 波）

| # | 动作 | 周期/GPU | 验收判据 |
|---|------|---------|----------|
| **T-W0** | 选型沙箱：读 4 个 Tencent 仓 License.txt（本地克隆直读）；HelixWorld 起服实测（延迟/画质/显存/音频）；HY-WorldPlay 权重下载 + 720p24fps 复现实测 | 1 周 / ~10 GPU-h | 两份实测报告（E-3 口径：真机数字，不抄 README） |
| **T-W1** | **路线 B MVP**：现网图像栈 8–12 视角生成 → HunyuanWorld-Mirror（或 TRELLIS）重建 → canvas Three.js 漫游（WASD+鼠标）→ 机位回写分镜 JSON | 1–2 周 / ~10 GPU-h | 雨夜街道场景可自由漫游（≥60fps）+ 导出机位出关键帧参考图 |
| **T-W2** | **路线 A 流式 PoC**：胜者（HelixWorld vs HY-WorldPlay，按 T-W0 实测）独占一卡；浏览器动作流→帧流（WebRTC）；夜窗运行 | 2 周 / 专用窗 | 端到端延迟 <150ms、≥15fps、3 分钟连续漫游无几何崩坏（盲评） |
| **T-W3** | 混合终态 + 闭环：WorldStereo 式边界扩展；机位回写接 W3 分镜；数字人入世界试点 | 后置（Q1+） | 「漫游选机位→一键成片」全链演示 |

## 8. 结论与建议

1. **该功能成立且值得做**：开源水位（HY-WorldPlay 720p@24fps 开源、HelixWorld Apache 单卡 70G、WorldMirror 前馈重建）刚好跨过「可本地跑」门槛，且 4×96GB 舰队是天然宿主。
2. **先 B 后 A 终态 C**：路线 B 一周级落地、零常驻成本、直接闭环短剧选景（最高价值）；路线 A 做体验旗舰（无限世界+空间音频）；混合是终态。
3. **HelixWorld 是首发沙箱**（Apache 最干净、70G 恰配单卡、音视同步差异化）；**HY-WorldPlay 是画质/一致性上限目标**（许可待读）。
4. **纠错入账**：utopia 实为 KG/RAG 系统，从世界模型线摘除。
5. 全部交付守三件套规范；世界资产与 scene_asset 统一设计；R18 世界只进经典面。

## 9. 来源索引

**本地档案**（`~/Desktop/ALLProject/Ai-OSS-Reference/notes/detail-c/` 与 `repos-discovered/`）：HylixWorld=NoizAI_HelixWorld.md、Tencent-Hunyuan_HY-World-2.0.md / HY-WorldPlay.md / HunyuanWorld-Mirror.md、TencentARC_WorldCrafter.md / VerseCrafter.md、OpenDCAI_OpenWorldLib.md、OpenDriveLab_WorldEngine.md、deeplethe_utopia.md（纠错）、SURVEY.md §6.4/§7.2.6（lingbot-world-v2/MoWorld/EchoWM）。

**外网核实（2026-10-14）**：
- [Genie 3: A new frontier for world models（DeepMind）](https://deepmind.google/blog/genie-3-a-new-frontier-for-world-models) ｜ [Project Genie（Google Labs 公测）](https://labs.google/projectgenie) ｜ [Project Genie 博文](https://blog.google/innovation-and-ai/models-and-research/google-deepmind/project-genie)
- [Oasis 项目页](https://oasis-model.github.io) ｜ [Decart 官网（Oasis 3 <40ms）](https://decart.ai)
- [World Labs 官网](https://www.worldlabs.ai) ｜ [Marble 发布](https://www.worldlabs.ai/blog/marble-world-model) ｜ [World API](https://www.worldlabs.ai/blog/announcing-the-world-api) ｜ [Atlas](https://www.worldlabs.ai/blog/atlas)
- [HY-WorldPlay GitHub](https://github.com/Tencent-Hunyuan/HY-WorldPlay) ｜ [WorldPlay 技术报告（arXiv 2512.14614）](https://arxiv.org/html/2512.14614v1) ｜ [HF 权重](https://huggingface.co/tencent/HY-WorldPlay)
- [NVIDIA Cosmos 官网](https://www.nvidia.com/en-us/ai/cosmos) ｜ [Cosmos 平台论文（arXiv 2501.03575）](https://arxiv.org/html/2501.03575v1)
- [LingBot-World 论文（arXiv 2601.20540）](https://arxiv.org/html/2601.20540v1) ｜ [AMD Micro-World（ROCm 博客）](https://rocm.blogs.amd.com/artificial-intelligence/micro-world/README.html) ｜ [2026 世界模型横评（LTX 博客）](https://ltx.io/blog/best-world-models)
