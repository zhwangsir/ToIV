# ToIV v4 方案计划 · 融合完成后(2026-10-12)

> 前提:F1–F7 融合七批已全部交付(见 STATE `fusion_f1..f7` 条目)。本计划是融合完成、
> 全量测试收口后的**下一阶段重规划**,替代 `PLATFORM_V3_PLAN_20261011.md` 的排期部分
> (六条能力主线目标不变,优先级按融合后新现实重排)。

## 1. 融合后盘面(2026-10-12 实证)

- **经典 web = R18 壳**:VALID_VIEWS 17→8(home/image/video/avatartalk/library/market/settings+入口探测);11 条退役深链全部归位 canvas(浏览器级 23/23 PASS)。
- **canvas = 唯一 SFW 工作面**:六段工作区 + 从图片创建 + 音频/图片/视频剪辑/译制四工具页 + 任务中心(三源+大目标直建)+ 智能体任务详情(SSE+双确认门)+ 市场/媒体库。
- **测试基线**:api 4027 过/106 挂(存量债,根因=422 处理器 ValueError 序列化,pre-v2 已存在);web 1158/1162;canvas tsc 零错;各批生产实弹 PASS。
- **已知债**:多模态 VLM 缺位(08-05 起,锁 from-image AI 模式)、设定卡质量债(参考图过不了门禁,异步 0 成功样本)、未随迁小功能(§4 V4-5 清单)、token 双体系残留。

## 2. v4 波次(按价值排序)

| 波次 | 内容 | 验收 | 批数 |
|---|---|---|---|
| **V4-0 质量收口**(前置) | ①api 测试债清理:修 422 序列化 handler(一处消大半)→逐类清零到全绿基线;②多模态 VLM 上架(设备域:GPU2/3 余量充足,Qwen3-VL 级 vLLM+`TOIV_VLM_*` 配置)→from-image AI 模式自动复活;③设定卡参考图质量债(宽源/outpaint 路线) | api 套全绿;from-image 真图实弹 done;设定卡异步 done≥1 | 2–3 |
| **V4-1 Agent 同构**(v3 C3,融合后最大价值释放) | F2–F7 新端点全部工具化(`breakdown_script/from_image/audio_tools/image_tools/video_edit/dub_chain/run_detail` 等,与 UI 同一 API 面);画布节点即工具(Toonflow 式);虚拟剧组 team.json(导演/编剧/分镜/画师/剪辑/质检) | 对话助手可代操全部工具页与工作区主流程;剧组可唤起 | 2–3 |
| **V4-2 一致性深水区**(v3 C1) | 三视图注册表(front 锚点/side·back 参考生成);参考槽位分层参数化(角色/风格/动作,抄海螺 9-3-3);阶段感知换参考(story-claw);多主体合并参考(NovelFlow) | 双角色镜一致性 A/B 实测;槽位参数面 UI+Agent 共用 | 2–3 |
| **V4-3 质检自动化**(v3 C2) | 镜头级 VLM 四问门禁(脸/服/景/幻脸)进 candidates;低于阈值自动重生成(上限 2,只补失败候选);成片前按镜抽检 | 门禁分数落库;自动重试实测 | 1–2 |
| **V4-4 真时间线决策**(v3 C4,条件已成熟) | `/toiv/video-tools`(表单式三轨)与 v2 时间线并存 → 拍板:播放列表+表单式够用(后置富交互) or 上时间线 DSL(ShortGPT EML,LLM 可操作) | 决策记录+实施或显式后置 | 1–3 |
| **V4-5 小功能补齐批** | 未随迁清单:autocut 自动剪切/highlights 高光集锦/动漫口型(anime-lipsync)/AiVideoEdit(AI 剪辑)/GLB 内联查看器/OrbitViewer 拖拽播片/agent-run 泳道视图与「在对话中继续」草稿通道 | 逐项入 canvas 或显式淘汰 | 1–2 |
| **V4-6 架构收尾**(随批次渐进) | token 统一(经典 CSS 随 R18 壳终态一并处理);StudioProject/DramaProject 域合并(from-image 已落 v2 域,经典 DramaProject 数据双轨收口);桌面端重建跟进(wails 重构建含新 canvas);R18 翻案通道(A 维持) | 域单宿主;桌面同版本冒烟 ok | 2–3 |

总量约 11–19 批。V4-1 与 V4-0 可部分并行(不同代码域)。

## 3. 决策点(默认值不回复则按默认走)

| 时点 | 决策 | 默认 |
|---|---|---|
| V4-0 前 | api 测试债修复范围(只修 handler vs 清零到全绿) | 清零到全绿 |
| V4-0 前 | 多模态 VLM 选型与落卡(GPU2/3) | Qwen3-VL 级,GPU3 |
| V4-4 初 | 真时间线上不上 | 表单式+播放列表够用则显式后置 |
| R18 | 维持 A | 维持 A |

## 4. 明确不做(继承 v3 §6)
社区/UGC、商业积分、多租户(默认关)、c_hybrid 长视频连续生成、自研模型训练、RH 市场扩容、SlotLab 跟踪。

## 5. 变更记录
- 2026-10-12 v1:初版——F1–F7 融合完成+全量测试收口(api 4027/106 存量债、web 1158/1162、浏览器 23/23)后重排 v3 主线。
