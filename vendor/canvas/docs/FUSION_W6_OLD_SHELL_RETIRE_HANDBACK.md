# W6 · 旧壳退役 Handback（过审放行改码 · tip 待回传）

- **日期**：2026-11-02（Asia/Shanghai）
- **执行**：跨端设计 · 执行器
- **仓**：MateBook `43fb3826-…` `/Users/wangzhenyu/Desktop/ALLProject/ToIV`
- **分支**：`work/p0-fusion-20261016`
- **基线（现网已齐）**：`ee2d3f69` · BUILD `20261102-013012`
- **口径**：Prime `/studio` = **唯一创作入口**；旧 BeefTV / `vendor/canvas/web` **308/Navigate 收口** —— **不是**功能融合。
- **状态**：**TL 过审放行改码**（三钉已钉死）→ 本波改码 + commit + 双远端 push；**禁部署**（父代理交运维 `--all --prime core`）。

---

## TL 三钉（定稿）

1. **#8 library 勿「或」**：字面 `/library`·`/studio/library*` → Prime **`/library`（PrimeLibrary 作品库）**；顶栏/文案「资产库」→ **`/drama/assets`（AssetsHub）**。两者禁止收成同一落点。
2. **#14**：`AuthPage` + 未挂载 `App.tsx` 旧树 → **本波物理删**（清引用/冻结清单；只认 `ToivLoginPage`）。
3. **#1**：裸 `/create`（无项目相关 query）→ **`/studio`**（不要默认 `/studio/new`）。有 `?project=`/`run`/`section` 等则保留 query 落到 `/studio`。

---

## 改码落点（本波）

| 面 | 动作 |
|---|---|
| `vendor/legacy-web/middleware.ts` | RETIRED + `/studio/create|desktop|toiv/{market,tasks,library,agent}*` → Prime；`/library`→`/studio/library`；market→`/studio/tools`；tasks→`/studio/tasks` |
| `vendor/legacy-web/app/page.tsx` | EXTERNAL_VIEW + handoff/薄壳链 → `/studio`·`/library`·`/tools`·`/tasks` |
| `vendor/legacy-web/app/drama/[id]/page.tsx` · `agent-runs/page.tsx` | → `/studio?project=` · `/studio/tasks` |
| `vendor/canvas/web/src/router.tsx` | `/create*`·desktop·agent·ws/runs → `RetireCreateToPrime`；`/`·`/home`→HomePage（防 canvas 自环）；create 源码保留 |
| `frontend/app/src/toiv/bootstrap.tsx` | `/create`·`/create/*` → `/` 保留 search |
| `frontend/app/src/App.tsx` · `pages/AuthPage.tsx` | **物理删**；`prime-vendor.manifest` 重冻 |

---

## 验收口径（部署后由运维/父代理验）

1. 公网 `/create`、`/studio/create`、`/desktop`、`/toiv/agent` → 308/落地 **Prime `/studio`**，无 BeefTV 三栏主壳。
2. `/library` → `/studio/library`（作品库）；「资产库」仍 `/drama/assets`。
3. `/studio`·`/studio/new` 健康；无双壳主入口。
4. 登录 = `ToivLoginPage`；`AuthPage`/`App.tsx` 不存在。
5. `/studio/desktop*` 不闪旧桌面皮。

---

## 挂账（不在本波）

- `/projects/:id` 工作流深链完整 IA 映射；`/toiv/drama*` → Prime `/drama` 核对
- Cosmos 种子迁出；canvas 侧栏/⌘K 仍含 `/create` 内链（点击会整页收口 Prime）
- SoftGlow/精选灵感/redline/姿势库/printfilm LICENSE·css 文件名 — 禁碰

---

## 证据索引

| 面 | 路径 |
|---|---|
| 公网 308 | `vendor/legacy-web/middleware.ts` |
| 经典壳外链 | `vendor/legacy-web/app/page.tsx` |
| canvas Navigate | `vendor/canvas/web/src/router.tsx` |
| Prime 路由 | `frontend/app/src/toiv/bootstrap.tsx` |
