> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# ToIV 当前产品最终形态 — 批准方案与执行计划（2026-10-22）

> 用户拍板：「按推荐包开干：F0 commit → F1–F4 → F0b 部署 → F5 雨夜；导出剪映；Acc/安全 Dly 不进」

## 定义

**当前产品最终形态** = 推荐包近窗（Doc→P3 + Wave M + continue 非冻结项）固化后，完成冻结的 **P4 产品切片**，再以 **雨夜真机一镜**验收主闭环。

不是整个 ToIV 宇宙终态；安全 Dly、微服务/SaaS、3D 导演台、H3 音画换默认、Acc 写入生产默认——**一律 OUT**。

## 已齐（进入 F0 工作区）

- 壳层 Doc → Default → P1 → P2 → P3 + 残余（P1.5/P2/P3）
- Wave M：gate / displayName / inventory → **Qwen-Rapid-AIO-SFW-v23**
- Continue：D5-A 剧组协助、N2 CosyVoice/ASR 探针摘分母、六画风变体下单、壳 dogfood、SFW-v23 静帧 smoke 脚本

## 执行序（IN）

| 波 | 内容 | 备注 |
|----|------|------|
| **F0** | commit 近窗工作区 | **本文件所属波**；**PUSH 否** |
| **F1** | 关键帧默认 · 失败码/质检 · 控片就绪灯 | P4 成片增强 |
| **F2** | 剧组一键成片（打开已有剧组模式，专家开关） | 复用 agent_team_graph |
| **F3** | BGM 声床 + 北向 KPI 看板 | |
| **F4** | 导出：**剪映草稿**（一种） | 只学协议，不拷 AGPL/GPL |
| **F0b** | 部署窗：生产吃 tip（消 404、分母、gate） | 需另窗明示 |
| **F5** | 雨夜一镜验收 | 定妆×4 · tip=ref2va · 不续写 |

依赖：`F0 → (F1∥F2) → F3 → F4 → F0b → F5`。

## OUT（本最终不做）

- 安全 Dly：换密 / filter-repo / IDOR / #13 改码
- alembic · DRT · 微服务 · SaaS · 计费/上架/小程序
- H3 音画一体换默认；3D 导演台
- Acc/Mega 替生产 `:8264` int8；Acc/Mega 全视频出片（旁路另窗）
- Playwright 回 CI、legacy 大清理（旁路另窗）

## 纪律

- 分支：`work/p0-fusion-20261016`（不切）
- F0：**commit 是 · push 否 · deploy 否 · restart 否**
- F0b / push：须用户再明示

## 状态

- F0：✅ 见 `TEST_LOG.md` `F0_COMMIT_DONE`（tip 钉 `f915b665` 线）
- F1：✅ 关键帧默认 · 失败码/质检 · 控片就绪灯 — 见 `WAVE_F1_PROGRESS_20261022.md` / `F1_KEYFRAME_QA_LAMPS_DONE`
- F2：✅ 剧组一键成片（专家开关 → createAgentRun → agent_team_graph，人闸保留）— 见 `WAVE_F2_PROGRESS_20261022.md` / `F2_CREW_ONE_CLICK_DONE`
- F3：✅ BGM 声床 + 北向 KPI — 见 `WAVE_F3_PROGRESS_20261022.md` / `F3_BGM_KPI_DONE`
- F4：✅ 剪映草稿导出（toiv_jianying_draft_v1）— 见 `WAVE_F4_PROGRESS_20261022.md` / `F4_JIANYING_DRAFT_DONE`
- F0b：✅ 生产 BUILD `20261021-221837-b94ae940`（见 `F0B_DEPLOY_DONE`）
- F5：✅ **PARTIAL（主闭环可见）** — `WAVE_F5_RAIN_ACCEPT_20261022.md` / `F5_RAIN_ACCEPT_PARTIAL`；收口 `WAVE_FINAL_FORM_WRAP_20261022.md`
