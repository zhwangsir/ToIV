# H3 全链路 dogfood 报告:《诛仙》十镜短剧（2026-08-15）

> 任务：MiniMax H3 引擎跑一部完整短剧（真人/高清/炫酷打斗），过程中找问题。
> 项目 id `5e1da2f4f1524c33ba9c461b71ae6805`；最终成片 v2（修复后）：**59.9s，1344×768@24fps，aac 44.1kHz 立体声**。

## 一、运行实录

| 阶段 | 路径 | 结果 |
|---|---|---|
| 建项目 | POST /drama/projects（1344×768@24） | ✅ |
| 剧本拆解 | POST …/storyboard（num_shots=10，配置层 LLM） | ✅ 10 镜，角色自动建行（普智/张小凡/陆雪琪/碧瑶/道玄） |
| 逐镜生成 | POST …/generate-video-v2 {model:"h3", prompt_override: 真人化} | ✅ 10/10 提交成功，H3 单实例排队 ~6min/镜 |
| 收口 | tracker + 写回 + reconcile + 手工兜底 | ⚠️ 发现 P0-1/P0-2（已修） |
| 合成 | POST …/assemble | ⚠️ v1 无音轨+降分辨率；修复后 v2 全规格 |

成片验收（抽帧 10 张）：真人写实质感达标（非动漫风）；名场面构图准确（雨夜传珠/擂台对决/碧瑶挡剑/火龙共战）；**意外亮点：H3 对「碧瑶挡剑」「火龙」自发渲染出正确中文字幕**（痴情咒全文、「别管明天了，好吗」）——prompt 未给台词，纯模型先验 + 音画同出能力。

## 二、发现的问题与处置（5 个已修）

| # | 现象 | 根因 | 修复 | commit |
|---|---|---|---|---|
| P0-1 | 批量提交后 7/10 镜永久 generating | 写回等待 900s 超时豁免后 return，无人再收口；H3 单实例排队必然超窗 | 写回改预算循环续等（总预算 7200s，逐轮重读 Job 定性） | adcc937 |
| P0-2 | 重启 reconcile 把 7 镜误标 error | `Job.prompt == shot.prompt` 精确匹配对 prompt_override 必然失配 | 两段匹配：精确→（seed≠0）kind+seed+属主兜底 | adcc937 |
| P1-a | 成片无音轨（H3 音画同出被抹掉） | `_build_ffmpeg_command` 仅配音/BGM 时映射音频，concat a=0 | clip_audio 探测 + anullsrc 补偿 + concat a=1 | adcc937 |
| P1-b | 成片 1280×720@16 ≠ 项目 1344×768@24 | AssembleOptions 默认固定 | aspect="auto"/fps=0 继承项目 | adcc937 |
| P1-c | 前端写死 aspect:"16:9" 覆盖后端 auto | useDramaProject.ts:1245 | 改 "auto" + fps 0 继承 | b62f1a4 |

生产手工兜底：7 镜按 kind+seed 从 Job 表回写（与 P0-2 修复逻辑同思路，验证了兜底匹配正确性）。

## 三、优化建议（未修，按 ROI 排序）

1. **剧本拆解的动漫标签偏置**（高）：_STORYBOARD_SYSTEM 示例是 danbooru 风格（1boy/2boys），真人风格项目会被带偏（本次 10/10 镜初始 prompt 全带动漫计数标签，且男女混镜错标 "2boys"）。建议：style 含「真人/写实」时切换 prompt 范式并禁用计数标签；style 未融入镜 prompt 的问题一并修。
2. **拆镜剧情漂移**（高）：第 9 段「田不易之死」被拆成「道玄被侵蚀」，田不易/苏茹未入角色表，关键台词未进 dialogue 字段。建议：拆解后加 LLM 自检轮（覆盖度校验：剧本每个段落/命名角色是否都有对应 shot），或复用 pipeline/status 的覆盖度思想。
3. **批量生成 ETA 与排队感知**（中）：H3 单实例 ~6min/镜，10 镜排队 1 小时无任何排队位置/ETA 提示；pipeline/status 可扩展 queue_position。写回预算循环已保正确性，体验层待补。
4. **assemble 字幕与 H3 自发字幕可能重复**（中）：H3 名场面自发烧字幕后，若 assemble 再 drawtext 会双字幕。建议 assemble 增加 `burn_subtitles: bool`（默认关 for H3 链）或检测片段已有字幕区域时跳过。
5. **crossfade + 内嵌音轨**（低）：当前丢音轨+warning；acrossfade 链待做。
6. **H3 i2v 未走通验证**（低）：本次纯 t2v；i2v 转运链未 dogfood。

## 四、结论

H3 全链路（拆解→生成→收口→合成）可产出**真人质感、音画同出、全规格**的完整短剧；四个 P0/P1 缺陷在 24h 内修复并上线（1588+ 测试全绿）。H3 的中文名场面先验是超预期亮点。剩余优化集中在剧本拆解的真人化范式与体验层。
