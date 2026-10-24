> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行主机 / 端口 / 权重 / DOWN 口 → [`docs/ops/CLUSTER_TRUTH.md`](CLUSTER_TRUTH.md)。正文仅作考古，禁止盲抄配置。

# 经典 web 视图处置清单（S12-a · 2026-10-11）

> 盘点依据：apps/web 全视图只读扫描（Explore 代理 38 次工具核实）。R18 关键事实：经典 web 的 X-NSFW 机制（`lib/r18.ts` + AgeGate）渗透 7 处视图；**canvas 全程无 R18 代码，纯 SFW**——R18 经典流是唯一需用户拍板项。

## 一、立即退役（3，canvas 已完全覆盖）

| 视图 | 理由 |
|---|---|
| fusion | 纯导航枢纽，canvas home 完全替代 |
| canvas | ComfyUI iframe 画布，canvas 应用本体替代 |
| /nsfw | 已重定向首页（M9），随 R18 决策一并清理 |

## 二、只读保留（1，无对应实现）

| 视图 | 理由 |
|---|---|
| avatartalk | 数字人（WebRTC 实时+LongCat 成片+直播助手）——唯一实现，canvas 无对应；R18 决策后定去留 |

## 三、迁移（12，按 PLATFORM_V2_CONTRACT 逐段进行中/待做）

| 视图 | 待迁点 | canvas 对应 |
|---|---|---|
| home | **entry.json 探测跳转逻辑**（退役前须迁至网关/canvas 自身，否则失去 cutover 开关） | home |
| image/video | R18 引擎集（h3-nsfw-fl2v 等）、AssetPicker/remix 深链 | create+画布 |
| audio | 人声分离、音色克隆 UI | create 音频（S10 后端已齐） |
| imageEdit | 扩图、3D、OrbitViewer | 画布 mask-edit |
| videoEdit | 时间线剪辑精修 | v2 时间线（排序/时长/字幕已齐） |
| animatic | from-image 入口 | 分镜段 |
| studio | 七步工作台残余段 | /toiv/ws 六段式（主线进行中） |
| dub | 多语言译制链（听写/翻译/克隆） | lipsync/字幕已部分覆盖 |
| library | Boards 看板 | /library |
| entities | 主体类型化 | 资产段（S6 已接 Entity） |
| resources | train/backlot 或淘汰 | settings |
| market | R18 应用面 | /toiv/market（分页已齐） |
| /drama/[id] | 播放器 analytics | drama-detail |
| /agent-runs | 计划确认门 | /toiv/agent+tasks |

## 四、拆分（1）

**settings**：主题/引擎状态只读 → 退役；**R18 开关唯一入口** → 随 R18 决策安置。

## 五、R18 经典流去向（用户决策选项）

- **A. 保留经典 web 只读壳**（推荐起步）：R18 流继续走经典 image/video/market/library，其余视图按上表退役；改动最小，R18 与 SFW 物理隔离保留。
- **B. canvas 增设 R18 模式**：把 X-NSFW 机制+AgeGate 移植 canvas（设置开关+引擎过滤+市场过滤）；经典 web 全量退役；工程量约 1-2 批。
- **C. R18 流退役**：仅本地自用口径下不再保留成人内容流；全部经典视图按清单处置。

## 六、变更记录

- 2026-10-11 v1：初版（Explore 全视图扫描）。
