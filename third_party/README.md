# third_party — 六仓融合源码工作区

> **用途**：dramaclaw / Toonflow / hypit / video-use 源码在此供对照与移植；**整树不入仓**（见根 `.gitignore`）。
> **BeefTV** 不在此目录——已并入 `apps/canvas`（产品主 UI）。
> **重新拉取**：从 `~/Desktop/ALLProject/Ai-OSS-Reference/repos/` rsync（排除 `.git`/`node_modules`/`dist`）。
> **入仓内容**：本 README、`licenses/` 许可证原文、融合记录。移植进 `apps/` 的代码按目标项目自己的许可声明。

## 许可口径（逐仓已读 LICENSE 原文，2026-10-15）

| 目录 | 上游 | 许可 | 可否并码进 ToIV | 约束 |
|---|---|---|---|---|
| `video-use/` | browser-use/video-use | **MIT** | ✅ 自由并码 | 保留版权与 MIT 文本；`apps/api` 已含 `edit_pack.py` 等移植件 |
| `toonflow/` | HBAI-Ltd/Toonflow-app | **MIT** | ✅ 自由并码 | 保留版权与 MIT 文本 |
| `hypit/` | hypit-ai/hypit | **修改版 Apache-2.0** | ✅ 单租户自用可并码 | 禁止多租户 SaaS / 商业再分发；CLI/报告/清单等用户可见面**不得去 logo/版权**（不露出该面则不适用） |
| `dramaclaw/` | dramaclaw/dramaclaw | **Elastic-2.0**（部分 Apache） | ⚠️ 自用/派生可用，**需保留 NOTICE/品牌归属** | 不得作为对第三方的托管服务提供；不得去掉产品署名；转公开/分发前必须再核 Elastic 限制 |
| （BeefTV→canvas） | glanderness/BeefTV | 已在 `apps/canvas` 内 | ✅ 已融合 | 命名/生产路径 `beeftv-prod` 待产品化翻转 |

**红线**（继承 AGENTS）：
- ChatCut=GPL、OpenMontage=AGPL：**只读借鉴，代码与 skill 文本一字不抄**。
- 引入新依赖/并码前再开该仓 `LICENSE` 核对；与上表冲突以上游原文为准。
- dramaclaw 若 ToIV 未来对外 SaaS，**必须换实现或换许可**，禁止直接带 Elastic 代码上多租户。

## 目录与融合落点

| 源 | 对照什么 | ToIV 落点 | 方式 |
|---|---|---|---|
| `dramaclaw/` | 场景派生/锚点冻结/角色双层/走位 blocking | `apps/api` scene_asset / character_asset | 设计采纳（优先），并码须 NOTICE |
| `toonflow/` | 阶段门控、三视图模板、{{ref N}}、SOP 技能 | drama 六段流 / agents 技能 | 设计采纳 + MIT 模板 |
| `hypit/` | SVML 词锚、文件即记忆、plan→build→get | `svml_lite.py` / import-svml / agent 记忆 | 设计采纳 + 单租户并码 |
| `video-use/` | pack_transcripts、EDL、timeline_view、剪规、自评 | `apps/api/app/services/edit_*.py` | **MIT 并码**（已落一批） |

## 融合进度（活口径）

| 能力 | 状态 |
|---|---|
| video-use Packed Transcript + EDL + 词边界 + timeline_view + 自评链 | ✅ api `edit_pack/edit_job/edit_view` + 测试 |
| hypit SVML 导入（drama + studio 双域） | ✅ 端点已落 |
| hypit 词锚时间轴 + 改词重排 | ✅ `svml_timeline.py` + `POST /studio/shots/{sid}/reflow-beats` + canvas `WordAnchorTimeline` |
| dramaclaw scene_asset v0 | ✅ 模型/路由 v0；变体/锚点深融合未完 |
| Toonflow 门控确认卡 | ✅ 整批渲染前确认卡（数量/加速档/说明）；三视图模板未并 |
| BeefTV=主 UI 收编 web 1.6 万行重叠 | ⏳ 绞杀者迁移过半（F1–F8），双壳仍在 |
| 命名 BeFTV→ToIV | ✅ 文档/品牌口径已收；`beeftv-prod` 等**生产路径未翻**（部署耦合） |

详细波次见 `docs/ops/UI_UNIFY_FUSION_PLAN_20261014.md`。

## 13 仓调研（2026-10-27）

- 完整报告：[`AI_STUDIO_REFERENCE_REPORT.md`](AI_STUDIO_REFERENCE_REPORT.md)，含逐仓优势、生成链、页面级 UI、许可证与 ToIV P0/P1/P2 映射。
- 独立上游 clone：`reference-repos/`（整树由根 `.gitignore` 排除）；报告固定各仓 commit，许可冲突与未实机验证范围单独标明。
- 此目录仅用于研究对照，不代表已吸收对应代码；任何移植仍须先核上游 LICENSE/NOTICE。
