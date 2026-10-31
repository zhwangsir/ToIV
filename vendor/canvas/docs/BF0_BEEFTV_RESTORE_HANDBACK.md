# BF0 · 恢复 BeefTV 初始形态 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit / 未 push / 未 deploy**）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280
- **口径**：BeefTV 初始壳形态 + A6 `#4A7FC1` + B1 `250/67/56` + 光幕/redline 单锁 + ToIV 侧栏五项
- **对照源**：`third_party/reference-repos/glanderness--BeefTV/web/src/pages/home/` + aux `beeftv_p1_xfer/toiv-m6a/web/src/pages/home/`

---

## 做了什么

### Home → BeefTV `home-dashboard` 结构
1. **Hero**：`新建画布创作` → `/canvas?mode=new`（点阵 hero + 白底 Plus 卡）
2. **Capability 单行**：`beefTVCapabilityItems`（画布/视频/图片/音频 + 短剧/创作台/工具箱/作品库/任务）
3. **杀掉首页意图墙**：`homeIntentBarItems` / `HOME_INTENT_ENTRIES` **不再** import/map 到首页；export 仍留在 `home-data.ts` 供工具台/市场后用
4. **最近项目**：BeefTV recent-card 网格 + `ProjectPreview`；数据对齐 BeefTV `home/index.tsx`（`listWorkspaceCanvasProjectsPage` / local canvas store）
5. **算力条**：降为 capability 上方弱提示（`ComputeStatusStrip` compact），无大横幅
6. **新建短剧 / 雨夜**：降为次按钮条，不抢 Hero
7. **CSS**：`beeftv-home*` + token 桥 `--toiv-*` / A6；去掉首页主导 `fz-desk` 拼盘

### Create `/create` 无 project
1. **composer-first**：`creation-workbench.tsx` 在无 `?project=` 时直接挂 `CreatePage`（`data-surface="beeftv-create"`），不套三栏密台
2. **`?project=` 三栏 workbench 保留**（短剧特有，BF1 再精修）
3. FeaturedWorks / 灵感瀑布保持 W1-B 删除态，无回潮

### 契约测同步
- `agent-product-entry-retired` / `project-preview` / `local-capability-surface` / `local-workspace-bootstrap` / `home-dark-palette` 已按 BF0 口径改写

---

## Fixture / 截图

| 文件 | 绝对路径 |
|---|---|
| Home FIXTURE | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/fixture-bf0-home.html` |
| Home PNG | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/bf0-home.png` |
| Create empty FIXTURE | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/fixture-bf0-create-empty.html` |
| Create PNG | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/bf0-create-empty.png` |
| Handback | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/BF0_BEEFTV_RESTORE_HANDBACK.md` |

**CTA**：accent `#4A7FC1` / `rgb(74,127,193)`（create CTA + fixture badge）。

---

## 改动文件面

- `apps/canvas/web/src/pages/home/home-dashboard.tsx`
- `apps/canvas/web/src/pages/home/home-dashboard.css`
- `apps/canvas/web/src/pages/home/index.tsx`
- `apps/canvas/web/src/pages/home/home-data.ts`（注释；意图 export 保留）
- `apps/canvas/web/src/pages/create/creation-workbench.tsx`（无 project → composer-first）
- `apps/canvas/web/test/agent-product-entry-retired.test.tsx`
- `apps/canvas/web/test/project-preview.test.ts`
- `apps/canvas/web/test/local-capability-surface.test.ts`
- `apps/canvas/web/test/local-workspace-bootstrap.test.ts`
- `apps/canvas/web/test/home-dark-palette.browser.test.ts`
- `apps/canvas/docs/shots/fixture-bf0-home.html`
- `apps/canvas/docs/shots/fixture-bf0-create-empty.html`
- `apps/canvas/docs/shots/bf0-home.png`
- `apps/canvas/docs/shots/bf0-create-empty.png`
- `apps/canvas/docs/BF0_BEEFTV_RESTORE_HANDBACK.md`

---

## 验收对照

- [x] 首页一眼 BeefTV：大新建 + 单行能力 + 最近预览卡
- [x] 无「快捷」密铺图标墙
- [x] CTA ≈ `#4A7FC1`；侧栏仍 ToIV 五项（FIXTURE 示意）
- [x] tip `0a426713`；未 commit
- [x] Create 空态 composer-first；`?project=` 三栏保留

## 残点 / 风险

| 项 | 说明 |
|---|---|
| 现网硬刷 | 无会话；仅 FIXTURE |
| 短剧最近列表 | 本波首页最近改为画布项目；短剧入口仍在 capability「短剧工作台」与次按钮 |
| home-dark-palette browser | 依赖本机 Chrome；结构选择器已切 `beeftv-*` |
| BF1 | 短剧密台精修 / 工具意图进工具台 / DramaClaw 节点几何 / OGA 可借点 — **本波不做** |

**禁 commit / push / deploy。停手等审。**
