# ToIV UI 重建 · Plan 4：共享页换壳 + web 换装 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（inline）。

**Goal:** 库/任务/设置三共享页迁入新壳（通用 legacy-host 路由 + 逐页降级 CSS）；apps/web 登录/落地页换 studio 身份；真机验证与推送。**删除旧壳/globals.css/antd 不属本计划**（Plan 5，入口条件见下）。

**Architecture:** 新增通用 `StudioLegacyHostRoute({ face, page, hideSelectors })`：新壳包旧页组件，scoped CSS 隐藏与新壳重复的页级 header；旧页文件零改动。web 侧仅加 token 导入 + 作用域皮肤类，不动结构。

**Spec:** `docs/superpowers/specs/2026-10-29-toiv-ui-rebuild-design.md` §6 步骤⑤（删除=步骤⑥→Plan 5）。

**Plan 5 入口条件（记录）**：`/toiv/drama`、`/toiv/market`、`/agents`、`/plugins*`、`/toiv/kpi`、`/home`（退役）全部迁移或退役后，才允许删 `UserLayout`/`globals.css`/antd 依赖；届时同步删 `STUDIO_FACE_FALLBACK`。

## Global Constraints

同 Plan 1-3（锁纪律/无 antd 新代码/无硬编码色/!important=0/语义测试/URL 兼容/旧页文件零改动/bun-only（canvas）与 npm-only（web）/四套件门禁）。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/studio/routes/studio-legacy-host-route.tsx` | 通用宿主路由（face + 旧页 lazy + 降级选择器） |
| `src/router.tsx`（改） | /library、/tasks、/settings 提外层指向宿主路由 |
| `src/studio/studio.css`（追加） | 三页页级 header 降级选择器 |
| `apps/web/app/styles/web-studio-skin.css`（新） | 登录/落地作用域皮肤（token 映射） |
| `apps/web/app/layout.tsx`（改） | 导入 studio-tokens.css + web-studio-skin.css |
| 测试：`test/studio-legacy-host.test.tsx`、`apps/web/tests/webStudioSkin.test.ts` | 契约 |

---

### Task 1: 通用 legacy-host 路由 + 三共享页

- [ ] **Step 1 失败测试**：`StudioLegacyHostRoute` 静态渲染含 `.stv-shell` 与 `.stv-legacy-host`；hideSelectors 写入 `data-hide` 属性供 CSS 钩子。
- [ ] **Step 2 红**
- [ ] **Step 3 实现**：组件签名 `StudioLegacyHostRoute({ face, label, children, hideSelectors }: { face: StudioFace; label: string; children: ReactNode; hideSelectors: string })`，渲染 `<StudioShell …><div className="stv-legacy-host" data-hide={hideSelectors}>{children}</div></StudioShell>`；CSS：`.stv-legacy-host { position: relative; flex: 1; min-height: 0; overflow: auto; }` + 三组降级规则（库页 `.workspace-page-header`、任务页 `.tasks-page-header`、设置页 `.settings-page-header`——实施时以真页 header 类名为准，grep 确认后写入）。
- [ ] **Step 4 路由**：/library、/tasks、/settings 提至外层 studio 路由块，element = 宿主路由包旧页 lazy（MediaLibraryPage/ToivTasksPage/SettingsPage）。
- [ ] **Step 5 绿 + lint + typecheck + palette 契约**；Commit `feat(canvas): 库/任务/设置迁入新壳（legacy-host）`

### Task 2: apps/web 登录/落地换装

- [ ] **Step 1 失败测试**（apps/web node:test）：`web-studio-skin.css` 存在且仅含 var() 映射与作用域选择器 `.toiv-landing`/`.toiv-login`，无硬编码 hex。
- [ ] **Step 2 红**
- [ ] **Step 3 实现**：layout.tsx 增加两行 import（studio-tokens.css 已生成于 apps/web/app/styles/；web-studio-skin.css 新文件：在 `.toiv-landing, .toiv-login` 作用域内把旧变量（--bg-canvas/--accent 等，以 web globals.css 真变量名为准）映射到 studio token；登录/落地根元素加作用域类（仅 className 追加，零结构改动）。
- [ ] **Step 4 绿**：`npm test && npm run typecheck`；Commit `feat(web): 登录/落地页换 studio 身份皮肤`

### Task 3: 真机验证 + 部署 + 推送

- [ ] 部署 `--canvas-only` + web 在 core 本机构建部署（`deploy.sh` 默认链，注意 P-2 BUILD_ID 门禁）
- [ ] 验证脚本扩展：/studio/library、/studio/tasks、/studio/settings 三面断言 `.stv-shell` + 旧页内容在 + 页级 header 隐藏；web 登录页截图对比
- [ ] 四套件全绿；commit 取证；push gitee（+github 网络恢复时）

## Self-Review

- 删除旧壳/globals/antd 明确移出本计划并给出 Plan 5 入口条件，避免半迁移断路由。
- 降级选择器以真页类名为准（Step 3 内 grep 动作写明），非占位。
- web 换装仅作用域皮肤 + 类名追加，符合"web 只换身份不重构"。
