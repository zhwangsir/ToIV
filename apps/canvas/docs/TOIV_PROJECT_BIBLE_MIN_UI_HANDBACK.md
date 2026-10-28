# ToIV · P0-4 ProjectBible 前端最小面 Handback（W2-A）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit / 未 push / 未 deploy**）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280×800
- **口径**：BeefTV + A6 `#4A7FC1` + B1 `250/67/56`；**未**动 DesktopShell / 后端 NSFW 闸 / MODEL_SOURCES / 后端仓

---

## 做了什么

1. **前端客户端** `apps/canvas/web/src/services/toiv/project-bibles.ts`
   - `listProjectBibles` → `GET /api/project-bibles`
   - `getProjectBibleWorking` → 无 version（工作副本）
   - `getProjectBibleVersion(id, version)` → **强制显式 version**；拒绝空 / `latest`
   - `listProjectBibleVersions`
2. **最小 UI** `ProjectBiblePanel`
   - 展示：`characters` / `locations` / `style_prefix` / `version`（+ frozen 徽标）
   - 读历史必须在 Version 下拉里显式选择；「读钉版」走 `?version=`
   - 诚实空态：无 Bible / API 不可达（登录失败等）→ 文案标明 **API-only**，不伪造夹具数据
   - **未**加任何 NSFW / content_mode 闸
3. **入口（创作台旁栏 + 舞台页）**
   - 左轨链接：**设定圣经** → `/create?section=bible`（有 project 时带 `project=`）
   - `section=bible` 时中栏舞台挂载 `variant="page"`
   - 其它 section：左轨底部挂载 `variant="rail"` 紧凑面（避免与舞台重复）

---

## UI 入口

| 入口 | 路径 |
|---|---|
| 创作台左轨 | `CreationStudioAssetRail` · `data-testid=creation-rail-bible` |
| 舞台页 | `/create?section=bible`（可选 `&project=`） |
| 组件 | `apps/canvas/web/src/components/toiv/project-bible-panel.tsx` |

---

## Fixture / 截图

| 文件 | 绝对路径 |
|---|---|
| Fixture | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/fixture-w2a-project-bible.html` |
| PNG 1280 | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/w2a-project-bible.png` |

**CTA 采样**：`rgb(74, 127, 193)`（`#4A7FC1`）

---

## 改动文件面

- `apps/canvas/web/src/services/toiv/project-bibles.ts`（新）
- `apps/canvas/web/src/components/toiv/project-bible-panel.tsx`（新）
- `apps/canvas/web/src/components/toiv/project-bible-panel.css`（新）
- `apps/canvas/web/src/components/create/creation-studio-asset-rail.tsx`
- `apps/canvas/web/src/pages/create/creation-workbench.tsx`
- `apps/canvas/docs/TOIV_PROJECT_BIBLE_MIN_UI_HANDBACK.md`
- `apps/canvas/docs/shots/fixture-w2a-project-bible.html`
- `apps/canvas/docs/shots/w2a-project-bible.png`

---

## 验收对照

- [x] 列表经 `GET /api/project-bibles`
- [x] 冻结/历史读需显式 version；客户端拒绝 `latest`
- [x] 展示 characters / locations / style_prefix / version
- [x] 无 FE NSFW 闸
- [x] 空态诚实（empty / api_only）
- [x] tip `0a426713`；未 commit

## 残点 / 风险

| 项 | 说明 |
|---|---|
| 现网硬刷 | 内存仓无持久；未登录会话时列表走 api_only 文案；FIXTURE 示意钉版态 |
| ingest/freeze UI | 本波只读；写入仍 API/夹具 |
| 短剧详情页旁挂 | 入口落在 `/create` 三栏（短剧工作台同壳）；未另开 `/toiv/drama` 独立页 |
| 持久化 DB | 仍为 API 内存骨架（黄潜夹具测过）；alembic 草案未强制 apply |

**禁 commit / push / deploy。停手等审。**
