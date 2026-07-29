# ToIV 四问题 UX 修复设计文档

> 日期：2026-07-28
> 范围：画布/工作室切换、采样器/调度器解释、短剧工作室与漫剧关系、作品库缩略图加载

---

## 一、问题总览

| # | 问题 | 根因 | 影响 |
|---|---|---|---|
| 1 | 画布页面中画布与工作室切换功能无法正常工作 | `ModeSwitcher` 只修改本地 `appMode` 状态，未调用 `changeView` 切换视图；`appMode` 与当前 `view` 也不同步 | 用户点击切换无响应 |
| 2 | 图像创作页面采样器/调度器缺少含义解释 | 代码中无解释数据与说明 UI | 用户不理解参数含义，难以选择 |
| 3 | 短剧工作室与漫剧产品定位重叠，且短剧工作室像独立网站 | 桌面端 `dramaStudio` 视图渲染独立外壳（无 DynamicIsland/Topbar），与 `manju` 并列出现在工具菜单 | 产品逻辑混乱、体验割裂 |
| 4 | 作品库缩略图未正确显示 | `imageUrl` 对非 `/` 开头路径拼接不健壮；`<img>` 无错误兜底 | 图片 404/空 src 时无占位展示 |

---

## 二、设计目标

1. 让「画布 / 工作室」切换真正改变视图，并保持状态同步。
2. 为采样器、调度器提供专业释义、搭配原则与最佳实践提示。
3. 将短剧工作室与漫剧整合为统一的「短剧创作中心」，明确二者为同一创作入口下的两种模式。
4. 保证作品库缩略图在各种路径格式下都能正确加载，加载失败时显示占位。

---

## 三、方案设计

### 3.1 画布 / 工作室切换修复

**现状**

- `page.tsx` 中 `appMode` 是独立 state，`ModeSwitcher` 仅调用 `setAppMode`。
- `showModeSwitcher = view === "canvas" || view === "dramaStudio"`。

**改动**

- 将 `ModeSwitcher` 与 `view` 绑定：
  - `view === "canvas"` 时，ModeSwitcher 显示「画布」激活。
  - `view === "dramaStudio"` 时，ModeSwitcher 显示「工作室」激活。
- 点击 ModeSwitcher 按钮时，直接调用 `changeView("canvas")` 或 `changeView("dramaStudio")`。
- 移除独立的 `appMode` state，用 `view` 派生当前 mode，避免状态双源。
- 保留 ModeSwitcher 组件 props 不变（mode/onChange），但由父组件传入派生值和视图切换函数。

**文件**

- `apps/web/app/page.tsx`

---

### 3.2 采样器 / 调度器解释说明

**现状**

- `CreateView.tsx` 中采样器、调度器仅显示下拉选项，无解释。

**改动**

- 新增数据文件 `apps/web/lib/sampling.ts`，包含：
  - 各采样器（Euler、DPM++ 2M Karras、UniPC、DDIM 等）的简短说明、速度、质量、收敛性。
  - 各调度器（normal、Karras、exponential、simple、sgm_uniform 等）的说明。
  - 推荐搭配表：采样器 → 默认/推荐调度器、适用场景（写实/动漫/快速迭代/高质量）。
- 在 `CreateView.tsx` 中：
  - 每个下拉框右侧显示当前选项的「一句话说明」。
  - 新增可折叠的「采样器与调度器说明」卡片，展示完整搭配原则与最佳实践。
- 说明文案保持专业、简洁，不遮挡主流程。

**文件**

- `apps/web/lib/sampling.ts`（新建）
- `apps/web/components/create/CreateView.tsx`

---

### 3.3 短剧工作室与漫剧关系重新规划

**产品定位**

- **漫剧（Manju）**：漫画/静态分镜 + 配音 + Ken Burns 动画，适合低成本、快速出片。
- **短剧工作室（Drama Studio）**：影视级实拍短剧工作流（剧本 → 角色 → 分镜 → 合成），适合高品质真人短剧。
- 二者同属「短剧创作」大入口，只是创作形态不同。

**改动**

- 在 `apps/web/components/drama-studio/DramaStudioView.tsx` 顶部新增 **子模式切换器**：「短剧模式」与「漫剧模式」。
- 选择「漫剧模式」时，DramaStudioView 内部渲染 `ManjuView` 的内容（通过直接渲染组件或抽出的 `ManjuWorkspace`）。
- 选择「短剧模式」时，渲染原有的 Drama Studio 工作流。
- `page.tsx` 调整：
  - DynamicIsland 菜单中的「漫剧」移除，仅保留「短剧工作室」（作为统一入口）。
  - BottomNav 的「新建」CTA 指向 `dramaStudio`。
  - `manju` 视图保留（兼容旧 URL/外部链接），但菜单中不再单独暴露。
  - `dramaStudio` 在桌面端不再使用独立外壳，统一走主 `app-shell`（与 `canvas` 等视图一致）。
- 由于 DramaStudioView 原桌面端自行渲染顶部退出按钮，将其改为依赖主 Topbar/DynamicIsland 导航。

**文件**

- `apps/web/app/page.tsx`
- `apps/web/components/drama-studio/DramaStudioView.tsx`
- `apps/web/components/manju/ManjuView.tsx`（视情况导出可复用工作区组件）

---

### 3.4 作品库缩略图加载修复

**现状**

- `imageUrl(path)`：若 path 不以 `http` 开头，则直接拼接 `${API_BASE}${path}`。
- 当 `path` 是相对路径但缺少前导 `/` 时（如 `api/images?...`），会生成错误 URL。
- `LibraryView.tsx` 中 `<img>` 没有 `onError` 处理。

**改动**

- 修复 `imageUrl`：
  - 若 path 以 `http` 开头，直接返回。
  - 否则确保 path 以 `/` 开头后再拼接 API_BASE。
  - 空 path 返回空字符串，避免触发异常请求。
- 在 `LibraryView.tsx` 中为 `<img>` 增加 `onError`：
  - 加载失败时隐藏 `<img>`，显示占位图标。
  - 占位图标根据 job status 显示 loading/error/image。
- 保留 `<img loading="lazy">`，提升长列表性能。

**文件**

- `apps/web/lib/api.ts`
- `apps/web/components/library/LibraryView.tsx`

---

## 四、测试策略

| 层 | 内容 | 方式 |
|---|---|---|
| 前端类型检查 | `npx tsc --noEmit` | 命令 |
| 前端构建 | `npm run build` | 命令 |
| 后端回归 | `pytest -q` | 命令 |
| 交互验证 | 画布/工作室切换、短剧模式切换、采样器说明展示、缩略图占位 | 浏览器/Playwright |

新增/更新测试：

- `apps/web/e2e/authed-canvas.spec.ts`：验证画布/工作室 ModeSwitcher 切换。
- 在现有 `authed-views.spec.ts` 或 `home.spec.ts` 中验证统一短剧入口。
- `apps/api/tests` 中若 `imageUrl` 逻辑有服务端对应函数则补充，否则以前端单元测试为主。

---

## 五、实现顺序

1. 修复 `imageUrl` + 作品库 `<img>` 错误兜底。
2. 修复画布/工作室切换（绑定到 `changeView`）。
3. 新增采样器/调度器解释数据与 UI。
4. 重构短剧工作室与漫剧关系（统一入口 + 子模式切换）。
5. 运行 `tsc --noEmit`、`npm run build`、`pytest -q`。
6. 更新 `STATE.json` 与 `TEST_LOG.md`。

---

## 六、边界与回退

- `manju` 视图保留，旧 URL `?view=manju` 仍可访问。
- DramaStudioView 在桌面端走主外壳后，其内部原有的 account/logout 处理改为使用主 Topbar（已提供）。
- 若用户后端未返回某些采样器/调度器，说明自动隐藏，不影响选择。
- 缩略图修复不修改后端产物 URL 格式，仅增强前端 URL 拼接与错误处理。
