# UI 整改方案 · 2026-10-26

用户原意（截图+口述）：现网 tip 光幕过大挡「和 ToIV 一起创作」；创作页浅底上深紫半透明大胶囊居中抢戏；侧栏白底与 Freezone 暗舞台割裂；除深浅色切换与创作页外，其它页观感不合格。停吹捧，按吸收台账整改。

对照：`docs/WAVE2_ABSORB_LEDGER.md`、`apps/canvas/docs/LANDING_HOME_RESTYLE_HANDBACK.md`、`CONTENT_MODE_LIGHT_CURTAIN_HANDBACK.md`、`third_party/dramaclaw/DESIGN.md`。  
Canvas 页（store `2a7cb835-…`）：UI方案 `2b37d548` / 竞品 `7f62671e` / 深挖 `9a6e4b46` / 台账 `cd3cf4be`（本机 ReadCanvas 链格式未通，以仓内台账为准）。

约束：进既有 BeefTV/`app-user-workspace` 主壳，禁第二产品壳；许可台账不变（ELv2/SAL 只抽节奏 token，MIT 可标源复制）。

---

## 1. 问题定性

| # | 现象 | 根因 |
|---|------|------|
| 1 | 光幕挡标题 | StageHost 绝对定位居中 + 宽≈340/高48 浮岛 |
| 2 | 深紫大胶囊抢戏 | adult 态高饱和紫半透明 + 强 glow；浅色创作页上尤刺眼 |
| 3 | 侧栏白 vs 舞台暗割裂 | product 侧栏 `--user-page-bg` 浅色轨与 Freezone `#0a0c12` 未统一 |
| 4 | 多页「不合格」 | Wave0 只换了创作台壳；官网/登录/列表页仍旧材质或半套 token |

---

## 2. 光幕紧急修复（本波代码）

- 位：舞台**右上**（`top:10px; right:14px`），禁止居中  
- 尺：高 **28px**、宽约 **132–168px**，一行工具带量级  
- 视觉：弱边弱影；成人态仅低饱和纹理，去掉大紫 glow / 装饰 hint  
- 逻辑不变：`setR18Mode` / me/mode、确认闸、普通|成人+图标双通道  
- handback：更新见 commit；详 `CONTENT_MODE_LIGHT_CURTAIN_HANDBACK.md`

---

## 3. 不合格页表

| 路径 / 组件 | 现状一句 | vs 参考差距 | 目标态（一眼美） | 建议吸收源 |
|-------------|----------|-------------|------------------|------------|
| `/` 官网 `apps/web/public/site/*` | 已暗+青蓝，仍偏薄静态营销页 | vs DramaClaw 剧场/海报墙节奏弱 | 剧场级首屏但不抢 CTA；与登录同壳 | DC DESIGN token/节奏（重写） |
| `/?view=home` 登录 `LandingPage`+`landing.css` | 暗壳已上，与官网/工作室浅色创作仍跳变 | Beef 产品壳与 DC 登录舞台未一条链 | 登录↔创作主题连贯；光幕不出现在未登录 | DC 暗登录节奏；Beef IA |
| `/studio/` home `home-dashboard` | Freezone 底+青 CTA，信息架构仍「编辑部卡片」 | vs Beef 工作台密度/导演入口弱 | 导演仪表：最近项目海报感+主 CTA 清晰 | BeefTV IA；DC Freezone 面 |
| `/studio/create` 创作台 | 相对最完整；浅色时侧栏/光幕曾打架 | 浅色轨缺「工具带」位给模式芯片 | 浅/深都：右上紧凑芯片；标题不被挡 | 本波光幕；Beef 顶栏工具带 |
| `/studio/toiv/drama` 短剧项目 | 列表/工作区偏功能堆叠 | vs LumenX 分镜卡、CineGen 镜头网格 | 项目卡海报化+阶段条可见 | LumenX MIT；BigBanana 阶段 IA |
| `/studio/toiv/tasks` 任务中心 | 工具表格式，壳层感弱 | vs Beef 任务/审核失败分类呈现 | 任务卡+状态色轨进 Freezone | Beef 失败分类模式（重写） |
| `/studio/toiv/market` 工具台 | 市场格，成人筛选与壳割裂 | vs Beef 市场/插件浏览节奏 | 暗壳商店+成人态纹理一致 | Beef IA；DC chip 节奏 |
| `/studio/settings` 设置 | 表单墙；内容模式已降级说明 | vs DC/Beef 设置分区与材质 | 分区卡片+同一 surface token | Beef 设置 IA |
| `/studio/toiv/library` 及子页 | 媒体库偏默认 Ant/灰卡 | vs LumenX/Toonflow 资产浏览 | 资产网格+预览材质统一 | Toonflow MIT；LumenX |
| 侧栏 `workspace-sidebar-nav` | 浅色白底与暗舞台双主题分裂 | Freezone 要求暗优先一体 | 暗默认侧栏；浅色为受支持备选且同 token | DC Freezone；Beef 导航 |

---

## 4. 整改波次建议

**P0 壳链（先视觉一条线，禁第二壳）**  
1. 光幕紧急缩小+右置（本 commit）  
2. 侧栏/舞台浅深 token 统一（Freezone 暗优先；浅色备选不回旧灰编辑部）  
3. 官网 → 登录 → home → create 同 DC/Beef 色轨与字阶  
4. drama / tasks / market 列表页进同一 surface/卡片节奏  

**P1** library、settings 分区抛光；LumenX 分镜/三视图已落地处对齐材质。  

**许可**：ELv2/SAL 只抽；MIT 标源。不 push 由 TL 口令。

---

## 5. 需用户确认的决策点

1. **默认主题**：创作页坚持浅色，还是暗优先（DC）浅色备选？影响侧栏/光幕对比方案。  
2. **光幕最终挂载**：继续 stage 右上绝对定位，还是并入 `creation-workbench-chrome` / 未来真顶栏右侧？  
3. **P0 下一刀**：先「侧栏暗一体」还是先「官网/登录与 create 同链」？  
4. 不合格页表是否漏小程序/admin（本清单仅 web+canvas 用户壳）。

---

## 6. 可执行短清单（5～10）

1. 光幕：右上、28px 高、去居中浮岛（本波）  
2. 创作浅色：芯片用浅底弱边，禁深紫大胶囊  
3. 侧栏：暗 Freezone 默认，与舞台同 `#0a0c12` 系  
4. home：最近短剧卡海报化，压编辑部点阵残留  
5. drama 列表：卡面+阶段条对齐 creation phase  
6. tasks：Freezone panel + 状态轨  
7. market：成人筛选与光幕纹理同语汇  
8. settings：分区卡，无第二套开关 UI  
9. 官网/登录：与 create 跳转无「换肤闪断」  
10. 每波截图：create 标题区干净、芯片仅右上角
