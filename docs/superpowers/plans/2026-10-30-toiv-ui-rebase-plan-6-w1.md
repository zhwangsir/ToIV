# ToIV UI 换基重构 · Plan 6（W1 基座落地）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 printfilm（MIT, React 19）前端作为 ToIV 新基座落地：vendor 冻结拷贝 + 自建 bootstrap 路由 + ToIV 鉴权接管 + 项目库双源 + 任务抽屉/三面切换 addons + `--prime` 灰度部署开关。

**Architecture:** 新包 `apps/prime/web/`；vendor 源码原样入 `src/`（sha256 冻结清单），ToIV 增量只落 `src/toiv/**` 与 `src/styles/toiv-skin.css`；`index.html`/`src/main.tsx` 为唯一 bootstrap 白名单（仅换入口）；路由树自建并弃用 vendor `App.tsx`；鉴权经 `localStorage.token` 注入点零改 vendor；部署经 `deploy/deploy.sh --prime` 切换 dist 来源，单开关回退。

**Tech Stack:** React 19 / TS / Vite 8 / react-router 7 / @xyflow/react 12 / lucide-react；测试 bun:test + node:test（`--experimental-strip-types`）+ playwright harness；部署 Go canvas backend（base=/studio）。

**Spec:** `docs/superpowers/specs/2026-10-30-toiv-ui-rebase-printfilm-design.md`（§1 落点/冻结、§2 路由映射、§3 数据层、§4 addons、§5 门禁、§6 波次、§9 契约证据）

## Global Constraints

- 许可证：MIT 全文与版权头随 vendor 保留；`apps/prime/web/NOTICE` 记 `MIT © yi1108/printfilm contributors` + provenance `62f8d95d7ee6a5af9543351040e6183e9dcbbe65`；不 vendor 任何 AGPL/社区许可/ELv2 代码。
- vendor 冻结：`src/` 内 vendor 文件 sha256 清单测试；白名单仅 `index.html`、`src/main.tsx`（改动限入口换接）。
- 门禁作用域：`src/toiv/**` 与新增 css 受债务门禁（!important=0；硬编码色仅 token/皮肤层；内联样式键白名单 left|width|paddingTop|backgroundImage；单 css ≤800 行；无 antd）；语义测试禁 RGB/像素钉值。
- 内容锁：限制只在前端 `@content-lock`（别名指向 `apps/canvas/web/src/content-lock.ts` 单源）；删锁不得报错/白屏/缺功能。
- 写路径纪律：`PUT /api/studio/projects/{id}/shots` 全量替换（GET→merge→PUT）；改词走 `reflow-beats`；生成默认满血档。
- 品牌文案只用 ToIV；删 billing/pricing/WeChatGroupFab 路由与组件引用（vendor 文件不删，路由不挂）。
- 每 task 结束一个 commit；四门禁（typecheck/lint/build/测试分块）绿才提交；生产取证在 T8。
- 提交只 stage 自己的文件；`STATE.json`/`TEST_LOG.md` 属并行管家，勿动。

---

### Task 1: vendor 拷贝 + NOTICE + 包骨架 + 冻结哈希测试

**Files:**
- Create: `apps/prime/web/`（自 `third_party/reference-repos/yi1108--printfilm/frontend/` 拷贝 `src/`、`index.html`、`package.json`、`tsconfig*.json`、`tests/`；不拷 `node_modules`/`dist`）
- Create: `apps/prime/web/NOTICE`
- Create: `apps/prime/web/vite.config.ts`（增量：base=`process.env.BEEFTV_PUBLIC_BASE || "/"`、dev proxy `/api`→`VITE_API_PROXY_TARGET||http://127.0.0.1:8080`、alias `@toiv/`→`src/toiv/`、`@content-lock`→`../../canvas/web/src/content-lock.ts`）
- Create: `apps/prime/web/scripts/freeze-manifest.mjs`（生成 `test/prime-vendor.manifest.json`：`src/` 全文件 sha256 + 白名单标注）
- Test: `apps/prime/web/test/prime-vendor-frozen.test.ts`

- [ ] **Step 1: 拷贝 vendor 树**

```bash
cd /Users/wangzhenyu/Desktop/ALLProject/ToIV
mkdir -p apps/prime/web
rsync -a --exclude node_modules --exclude dist \
  third_party/reference-repos/yi1108--printfilm/frontend/ apps/prime/web/
```

- [ ] **Step 2: 写 NOTICE**

```
printfilm (https://github.com/yi1108/printfilm)
MIT License — Copyright (c) yi1108/printfilm contributors
Vendored commit: 62f8d95d7ee6a5af9543351040e6183e9dcbbe65
Vendored tree: src/ (frozen, see test/prime-vendor.manifest.json)
```

- [ ] **Step 3: 生成冻结清单并写测试**

```bash
cd apps/prime/web && node scripts/freeze-manifest.mjs
```

```ts
// test/prime-vendor-frozen.test.ts
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "prime-vendor.manifest.json"), "utf8"));
const ALLOWLIST = new Set(["index.html", "src/main.tsx"]);

describe("prime vendor freeze", () => {
    test("vendor tree matches provenance manifest", () => {
        for (const entry of manifest.files) {
            if (ALLOWLIST.has(entry.path)) continue;
            const body = readFileSync(resolve(import.meta.dir, "..", entry.path));
            expect(createHash("sha256").update(body).digest("hex")).toBe(entry.sha256);
        }
    });
    test("bootstrap allowlist is exactly index.html and main.tsx", () => {
        expect(manifest.allowlist).toEqual([...ALLOWLIST].sort());
    });
});
```

- [ ] **Step 4: 安装依赖并跑门禁基线**

```bash
cd apps/prime/web && bun install && bun run build && bun test test/prime-vendor-frozen.test.ts
```
Expected: build 绿（vendor 原样可编译）；冻结测试绿。

- [ ] **Step 5: Commit**

```bash
git add apps/prime/web && git commit -m "feat(prime): vendor printfilm 基座（MIT 冻结拷贝 + NOTICE + 冻结哈希门禁）"
```

### Task 2: bootstrap 路由树 + 壳顶栏 addons + 皮肤覆盖层

**Files:**
- Create: `src/toiv/bootstrap.tsx`（BrowserRouter + 自建 `<Routes>`：§2 映射表；vendor `App.tsx` 不挂）
- Create: `src/toiv/shell/ToivTopBar.tsx`（三面切换=路由组切换件、任务胶囊、companion 小爪挂载点）
- Create: `src/styles/toiv-skin.css`（CSS 变量覆盖层：品牌色/圆角，仅变量）
- Modify: `index.html`、`src/main.tsx`（白名单：入口改指 `src/toiv/bootstrap.tsx` + import 皮肤 css）
- Test: `test/prime-bootstrap.test.tsx`（renderToStaticMarkup：路由表含三面与删除面不挂载）

- [ ] **Step 1: 写失败测试**

```tsx
// test/prime-bootstrap.test.tsx（节选断言）
expect(routes).toContain('/studio/:id');          // 流水线
expect(routes).toContain('/drama/projects/:projectId/canvas'); // 画布
expect(routes).toContain('/studio/:id/editor');   // 剪辑湾
expect(routes).not.toContain('/pricing');         // 计费删除
```

- [ ] **Step 2: 运行确认 RED** → `bun test test/prime-bootstrap.test.tsx` Expected: FAIL（bootstrap 未建）
- [ ] **Step 3: 实现 bootstrap + TopBar + skin**（TopBar 复用 vendor `components/ui/PillTabs` 做三面切换；任务胶囊按钮 aria-label="打开任务中心"）
- [ ] **Step 4: GREEN + 门禁** → `bun run typecheck && bun run lint && bun test test/prime-bootstrap.test.tsx test/prime-vendor-frozen.test.ts`
- [ ] **Step 5: Commit** `feat(prime): bootstrap 路由树与壳顶栏 addons（三面切换/任务胶囊/皮肤层）`

### Task 3: ToIV 鉴权接管（零改 vendor）

**Files:**
- Create: `src/toiv/auth/session.ts`（`miniapp_token` 交换→`localStorage.token`；`currentToken()`；`logout()`；boot 时若无 token 且无交换参数→跳 `/auth`）
- Create: `src/toiv/auth/AuthGate.tsx`（包装 vendor `RequireAuth` 语义：无 session 渲染 vendor AuthPage 的 ToIV 登录表单替换件）
- Test: `test/prime-auth.test.ts`（交换参数写入 token；登出清除；无 token 跳 auth）

- [ ] **Step 1: 失败测试**（断言 `localStorage.token` 写入/清除与跳转目标）
- [ ] **Step 2: RED** → `bun test test/prime-auth.test.ts`
- [ ] **Step 3: 实现**（交换走 Go backend 现有 `/studio/auth/exchange` 语义移植；API base 经 `VITE_API_BASE=/api`）
- [ ] **Step 4: GREEN + 门禁**
- [ ] **Step 5: Commit** `feat(prime): ToIV 会话接管（localStorage.token 注入点，零改 vendor）`

### Task 4: 项目库双源 adapter + HomePage 接线

**Files:**
- Create: `src/toiv/adapters/projects.ts`（`loadPrimeProjects()`：`/api/studio/projects` + `/studio/api/canvas-projects` 合并，输出 vendor HomePage 卡片视图模型；失败源降级+warn toast）
- Create: `src/toiv/addons/ProjectHome.tsx`（包装 vendor HomePage 数据注入；空态带"新建项目"动作）
- Test: `test/prime-projects.test.ts`（mock 双源合并/单源失败降级/空态）

- [ ] **Step 1: 失败测试**（32 studio + 2 canvas → 34 卡；canvas 源 503 → 仅 studio 卡 + warn）
- [ ] **Step 2: RED**
- [ ] **Step 3: 实现 adapter + 包装页**（路由 `/` 与 `/studio` 指包装页）
- [ ] **Step 4: GREEN + 门禁**
- [ ] **Step 5: Commit** `feat(prime): 项目库双源接入（studio+canvas，失败源降级）`

### Task 5: 任务抽屉三源挂载

**Files:**
- Create: `src/toiv/addons/TaskDrawerPrime.tsx`（复用 canvas web `tasks-model.ts` 三源逻辑移植：jobs/canvas/agent；cancel 仅 jobs）
- Modify: `src/toiv/shell/ToivTopBar.tsx`（胶囊开合抽屉）
- Test: `test/prime-tasks.test.tsx`（分组/取消按钮仅 jobs/空态）

- [ ] **Step 1–5:** 失败测试→RED→实现→GREEN+门禁→Commit `feat(prime): 任务抽屉三源（作业/画布/智能体）`

### Task 6: deploy `--prime` 灰度开关

**Files:**
- Modify: `deploy/deploy.sh`（canvas 构建分支：`PRIME=true` 时源目录 `apps/prime/web`、构建命令 `bun run build`、dist 产出同 `toiv-studio/dist`；快照/回滚路径不变）
- Test: `apps/canvas/web/test/deploy-prime-flag.test.ts`（脚本文本契约：flag 解析 + 构建源选择分支存在 + 默认旧源）

- [ ] **Step 1: 失败测试**（断言 `--prime)` case 与 `PRIME_SRC=apps/prime/web` 分支、默认 `apps/canvas/web`）
- [ ] **Step 2: RED**
- [ ] **Step 3: 实现脚本分支**（锚点：canvas 构建函数内 vite 构建行；切换源目录与包管理器命令）
- [ ] **Step 4: GREEN**（`bun test` 该文件 + `bash -n deploy/deploy.sh`）
- [ ] **Step 5: Commit** `feat(deploy): --prime 灰度开关（prime dist 单开关切换/回退）`

### Task 7: harness 与门禁作用域扩展

**Files:**
- Create: `apps/prime/web/test/prime-shell.browser.test.ts`（Bun.build 插件：`@/`、`@toiv/`、`@content-lock` 别名 + css stub；断言壳顶栏/三面切换/项目库渲染/鉴权失败跳 auth）
- Modify: `apps/canvas/web/test/studio-debt-metrics.test.ts`（作用域追加 `apps/prime/web/src/toiv` 与新增 css；vendor 大 css 经冻结清单豁免）
- Test: 同上两文件

- [ ] **Step 1: 写 harness（失败路径服务器 503 约定保留）**
- [ ] **Step 2: 跑 harness RED→GREEN**
- [ ] **Step 3: 门禁扩展跑绿**（`bun test test/studio-debt-metrics.test.ts` 于 canvas/web）
- [ ] **Step 4: Commit** `test(prime): 壳 harness 与债务门禁作用域扩展`

### Task 8: 本地取证 + 灰度部署取证 + 收尾

- [ ] **Step 1: 本地 dev 取证**（`bun run dev` + 生产 API proxy：`/` 出 prime 壳+真项目卡；无 token 跳 auth；截图 `/tmp/prime-w1-home.png`）
- [ ] **Step 2: 灰度部署**（`deploy/deploy.sh --canvas-only` 默认旧 dist 复验无回归 → `--prime` 开 → 生产 `/studio/` 出 prime 壳+32 真卡+抽屉真作业；截图 `/tmp/prime-w1-prod.png`）
- [ ] **Step 3: 回退演练**（关 `--prime` → 旧 dist 恢复 → 再开）
- [ ] **Step 4: 四门禁全绿复跑 + commit** `chore(prime): W1 取证与灰度开关落地`
- [ ] **Step 5: 汇报检查点**（真机截图 + 门禁输出 + 回退演练记录）

---

## Self-Review

- Spec 覆盖：§1（T1/T2 冻结+白名单）、§2（T2 路由表）、§3（T3/T4）、§4（T2/T5）、§5（T1/T7 门禁）、§6 W1（T1–T8）、§9（T3 注入点）——全映射。
- 占位符扫描：无 TBD/TODO；每 step 有命令或代码。
- 类型一致：`loadPrimeProjects`/`ToivTopBar`/`TaskDrawerPrime`/`localStorage.token` 全文一致。
- 后续波次：W2–W6 各自出 plan（plan-7…），本 plan 不越界。
