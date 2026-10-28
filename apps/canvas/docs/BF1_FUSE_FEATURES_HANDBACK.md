# BF1 · 特有功能融入 BeefTV 壳 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit / 未 push / 未 deploy**）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280×800
- **口径**：BeefTV 壳 + A6 `#4A7FC1` + B1 `250/67/56` + redline + ToIV 侧栏五项
- **BF0 硬约束**：首页意图墙 / fz-desk 拼盘 / FeaturedWorks **无回潮**

---

## 做了什么

### 1. 工具意图离首页 → 工具台密台网格
1. 新增 `ToolsIntentGrid`：消费 `homeIntentBarItems`（= `HOME_INTENT_ENTRIES`）
2. 分组：**图像 / 视频 / 音频 / 短剧**（21/21 intent 全覆盖）
3. 挂载：`/toiv/market`（`market-page.tsx`）header 下；BeefTV 密台卡，hover inset accent，无营销海报/彩霓虹
4. 侧栏「工具台」仍 `/toiv/market`；⌘K 工具孤面改指 `/toiv/market#tools-intent-*`
5. 路由 `/toiv/audio|image-tools|video-tools|dub-tools` → Navigate `/toiv/market`（不再 `/create`）

### 2. 短剧三栏表面跟 BeefTV 密台
1. `?project=` workbench 标 `data-surface="beeftv-drama"`
2. `drama-workspace` 在 `projectIdOverride`（台内托管）时：`is-hosted` + 密 padding；减弱嵌套 WorkspacePage section/scroll
3. `creation-studio-three-pane.css` BF1 块：hosted drama 吃 `--toiv-*`；主 CTA `#4A7FC1`；禁 soft-glow/gradient 回潮
4. 节点仍仅 DramaClaw 几何数字（W2-B 灰阶梯子保留）；无第二彩壳 / 无 Toonflow chrome

### 3. 默认路径清晰
| 入口 | 目标 |
|---|---|
| 侧栏「创作」 | `/create` composer-first（BF0） |
| 侧栏「短剧项目」 | `/toiv/drama` |
| 侧栏「工具台」 | `/toiv/market`（意图网格） |
| 首页 Hero「新建画布」 | `/canvas?mode=new`（未改） |
| `/create?project=` | 三栏 + hosted drama |

---

## Fixture / 截图

| 文件 | 绝对路径 |
|---|---|
| 工具台网格 FIXTURE | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/fixture-bf1-tools-grid.html` |
| 工具台网格 PNG | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/bf1-tools-grid.png` |
| 短剧三栏 FIXTURE | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/fixture-bf1-drama-three-pane.html` |
| 短剧三栏 PNG | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/bf1-drama-three-pane.png` |
| Handback | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/BF1_FUSE_FEATURES_HANDBACK.md` |

**CTA 采样**：badge `rgb(74, 127, 193)` = `#4A7FC1`

---

## 改动文件面

- `apps/canvas/web/src/components/toiv/tools-intent-grid.tsx`（新）
- `apps/canvas/web/src/components/toiv/tools-intent-grid.css`（新）
- `apps/canvas/web/src/pages/toiv/market-page.tsx`
- `apps/canvas/web/src/pages/toiv/drama-workspace.tsx`（hosted 密密度）
- `apps/canvas/web/src/components/create/creation-studio-three-pane.css`（BF1 hosted 块）
- `apps/canvas/web/src/pages/create/creation-workbench.tsx`（`data-surface=beeftv-drama`）
- `apps/canvas/web/src/pages/home/home-data.ts`（注释）
- `apps/canvas/web/src/components/layout/workspace-command-palette.tsx`
- `apps/canvas/web/src/router.tsx`（工具孤面 → market）
- `apps/canvas/web/test/workspace-command-palette-f9.test.ts`
- `apps/canvas/web/test/local-capability-surface.test.ts`
- `apps/canvas/docs/BF1_FUSE_FEATURES_HANDBACK.md`
- `apps/canvas/docs/shots/fixture-bf1-*.html` / `bf1-*.png`

**未改**：`home-dashboard` 结构（BF0）、后端、redline POLICY、Cosmos/App Shell、DesktopShell

---

## 自检

- [x] Home 仍 BeefTV（硬对照 BF0：未 import/map `homeIntentBarItems`）
- [x] 工具意图只在工具台 `ToolsIntentGrid`，不在首页
- [x] 短剧三栏近黑密台；CTA `#4A7FC1`
- [x] 侧栏五项路径清晰；创作未绑回意图墙
- [x] `bun test` local-capability-surface + workspace-command-palette-f9：**20 pass**
- [x] tip `0a426713`；未 commit

## 残点 / 风险

| 项 | 说明 |
|---|---|
| 现网硬刷 | 无会话；仅 FIXTURE |
| market 仍 `fz-desk` | 工具台页壳保留 dense desk；意图网格为新增 BeefTV 卡，未回潮首页 fz-desk 拼盘 |
| drama 独立路由 | `/toiv/drama/:id` 工作区仍可用；台内 `?project=` 为 hosted 密台 |
| 哈希锚点 | ⌘K 深链带 `#tools-intent-*`；需浏览器滚动支持（pathname 注册测已去 hash） |

停手等审。
