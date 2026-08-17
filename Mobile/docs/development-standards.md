# ToIV 移动端开发规范与流程

> 版本：v1.0（2026-08-11）
> 适用范围：`ToIV/Mobile/` 目录下全部移动端代码
> 上位约束：ToIV 根仓库 `AGENTS.md`（🔒 硬性规则）、用户画像中的项目约束（Lucide 唯一图标库、真机验证、里程碑文档化）
> 技术基线：见 [ADR 0001](adr/0001-tech-stack-react-native-expo.md)

---

## 一、Overview

本文档定义 ToIV 移动端从编码到上架的全流程标准：代码规范、目录架构、版本控制、测试流程、部署流程、协作机制。目标是**任何一段代码、任何一次发布，都可预期、可审查、可回滚**。

## 二、Goals & Non-Goals

**Goals**
- 一套代码覆盖 iOS + Android，TypeScript 严格模式零豁免。
- 每个里程碑（M{n}）满足：实现 + TDD 测试 + 全量回归 + 真机验证 + 文档落账（STATE.json / TEST_LOG.md）。
- JS 层缺陷可 OTA 热修，原生层缺陷可走商店管道，双向可回滚。

**Non-Goals**
- 不做小程序/鸿蒙端（复议见 ADR 0001 第 5 节）。
- 端上不跑模型推理、不做重度音视频处理。
- 不重复造 Web 已有的管理后台能力（移动端聚焦创作与消费链路）。

## 三、工程架构基线

### 3.1 目录结构（Expo Router 约定）

```
Mobile/
├── src/
│   ├── app/                  # 仅放路由（Expo Router 文件即页面）
│   │   ├── _layout.tsx       # 根布局：Provider 挂载、字体、Splash
│   │   ├── (auth)/login.tsx
│   │   └── (tabs)/           # 主导航：generate / jobs / library / profile
│   ├── components/           # 通用组件（ui/ 基础件 + 业务件）
│   ├── features/             # 业务模块（generate/ jobs/ library/ auth/）
│   ├── hooks/                # 跨模块自定义 Hooks
│   ├── lib/                  # api client、token、轮询、工具（纯逻辑，可单测）
│   ├── stores/               # Zustand stores（客户端状态）
│   ├── theme/                # 设计 Token、五套色板、NativeWind 配置
│   └── types/                # API DTO（与 apps/web/lib/types.ts 对齐）
├── e2e/                      # Maestro 流（.yaml）
├── docs/                     # 本目录（规范/ADR/调研）
├── app.json / eas.json       # Expo 与 EAS 配置
└── package.json
```

**规则**
- `src/app/` 内**只放路由文件**，禁止写业务组件/工具函数（Expo Router 会把每个文件当路由）。
- 业务逻辑下沉 `features/` 与 `lib/`；组件无直接 fetch，一律走 `lib/api.ts` + TanStack Query。
- 路径别名 `@/* → src/*`，禁止三层以上相对导入（`../../../`）。

### 3.2 状态分层（强制）

| 状态类型 | 载体 | 示例 |
|---|---|---|
| 服务端状态 | TanStack Query | 引擎列表、作业轮询、画廊分页 |
| 客户端全局 | Zustand（MMKV 持久化） | 主题/色板、创作草稿、NSFW 意图标记 |
| 组件本地 | useState/useReducer | 输入框值、Modal 开合 |
| 表单 | 受控组件 + zod 校验 | 登录、生成参数 |

- 🔒 token 只存 `expo-secure-store`；NSFW 请求头 `X-NSFW: 1` 由 api client 按意图注入（对齐 Web 行为）。
- 生成作业轮询复刻 Web `usePoll/trackJob` 语义：指数退避（1s→2s→4s，封顶 8s），页面失焦暂停，恢复立即拉一次。

### 3.3 API 基址（吸取 Web 端烘焙教训）

- **运行时配置**，禁止构建期写死：`app.json extra.apiBase` 提供默认值，设置页可覆盖，优先级「用户覆盖 > EAS Channel 环境 > 默认」。
- 默认生产值 `http://192.168.71.47:8090`；任何 `localhost/127.0.0.1` 出现在非 dev 构建 = CI 拦截（对齐 deploy.sh 防呆精神）。
- 登录响应字段是 `token`（**不是** `access_token`）——写进 `lib/api.ts` 类型，防回归。

## 四、代码规范

### 4.1 语言与风格

- TypeScript `strict: true`；`tsc --noEmit` 必须 0 错误方可合并。
- ESLint（`eslint-config-expo` 基底）+ Prettier；`no-explicit-any: error`；`no-console: ["error", { allow: ["warn","error"] }]`。
- 命名：组件 `PascalCase`；Hook `useXxx`；普通文件 `kebab-case.ts`；路由文件遵 Expo Router（`index.tsx` / `[id].tsx` / `_layout.tsx`）；常量 `UPPER_SNAKE_CASE`。
- 注释用**中文**，解释「为什么」而非「是什么」；公开函数写 TSDoc。
- 导入顺序：react/react-native → 三方库 → `@/` 别名 → 相对路径（ESLint import/order 强制）。

### 4.2 🔒 禁令清单（违反即 CI 红）

1. **图标**：仅 `lucide-react-native`，统一经 `components/ui/Icon.tsx` 封装调用；禁止 emoji 当图标、禁止其他图标库、禁止散落自定义 SVG。
2. **颜色/尺寸硬编码**：禁止裸写 `#hex` 与魔法数字，必须引用 `theme/` Token。
3. **token 存储**：禁止 AsyncStorage/MMKV 存认证 token。
4. **any 逃逸**：禁止 `as any` / `@ts-ignore`（测试文件豁免需注释理由）。
5. **业务组件直连网络**：禁止组件内 fetch/axios，必须经 `lib/api.ts`。
6. **emoji**：代码、注释、UI 文案、提交信息中均不使用（用户全局偏好）。

### 4.3 组件规范

- 单一职责，超 200 行必须拆分；Props 超 5 个改用配置对象。
- 所有交互组件必须定义 `default / pressed / disabled / loading` 四态。
- 列表一律 `FlashList`（或 FlatList + `getItemLayout`），图片一律 `expo-image` 带缓存与占位。
- 动效只走 Reanimated（UI 线程），禁止 JS 线程驱动动画；遵守《UI/UX 设计指南》动效时长/缓动表。

## 五、版本控制策略

### 5.1 分支模型（Trunk-Based，复用 ToIV 根仓库）

- `main` 唯一主干，受保护；**禁止直接 push main**。
- 短命特性分支：`feat(mobile)/xxx`、`fix(mobile)/xxx`，生命周期 ≤3 天，合完即删。
- Mobile 代码全部落在 `Mobile/`，与 `apps/api`、`apps/web` 严格隔离（🔒 项目隔离约束）；跨目录改动必须单独 PR 并在描述中声明影响面。

### 5.2 提交信息（Conventional Commits）

```
<type>(mobile): <中文摘要>

类型：feat / fix / refactor / test / docs / chore / perf / style
例：feat(mobile): 接入作业轮询指数退避
```

- 一个提交只做一件事；提交前必过 `lint-staged`（prettier + eslint + tsc 增量）。
- 🔒 **commit / push 必须得到用户明确指令**（用户硬性规则），日常只备好暂存与提交信息草稿。

### 5.3 版本号

- 应用版本 SemVer（`app.json version`）；`runtimeVersion` 与原生指纹绑定。
- 构建号 EAS `autoIncrement`，禁止手工改。
- CHANGELOG 按里程碑维护在 `TEST_LOG.md`，不另立文件。

## 六、测试流程（TDD 强制）

### 6.1 测试分层

| 层 | 工具 | 范围 | 门禁 |
|---|---|---|---|
| 单元 | Jest + jest-expo | `lib/`、`stores/`、`hooks/` 纯逻辑 | 覆盖率 ≥80% |
| 组件 | React Native Testing Library | 交互四态、可访问性标签、快照 | 关键组件 100% 覆盖 |
| 契约 | MSW mock core API | api client 错误码/超时/重试 | 每个端点至少 1 例 |
| E2E | Maestro | 关键路径 5 条：登录→生成提交→轮询完成→画廊播放→设置换主题 | 合并 main 前必过 |
| 🔒 真机 | 实体 iOS + Android | 每里程碑验收 | 模拟器结果不构成验收 |

### 6.2 TDD 节奏

1. 先写失败测试（Red）→ 2. 最小实现转绿（Green）→ 3. 重构（Refactor）。
2. 修 Bug 必须先补复现测试，再修。
3. PR 模板勾选项：测试已写 / 全量回归已过 / 真机截图或录像已附。

### 6.3 全量回归命令（CI 同款）

```bash
npm run typecheck && npm run lint && npm test -- --coverage
npx maestro test e2e/            # 本地或 Maestro Cloud
```

## 七、部署流程

### 7.1 环境通道

| 通道 | 用途 | 形态 |
|---|---|---|
| development | 本地联调 | Dev Client + Metro |
| preview | 里程碑验收/内测 | EAS Build 内部直装（Ad Hoc / Internal Track） |
| production | 商店发布 | EAS Build → EAS Submit |

### 7.2 发布管道

1. **PR 合并** → CI：typecheck + lint + 单测 + 覆盖率门禁。
2. **里程碑 tag**（`mobile-vX.Y.Z`）→ EAS Build preview → 真机验收（🔒 硬性环节）→ STATE.json / TEST_LOG.md 落账。
3. **商店发布** → `eas build --profile production` → `eas submit`；审核期间 JS 层紧急修复走 **EAS Update（OTA）**，`channel=production`。
4. **回滚**：JS 层 `eas update:republish` 回上一版本；原生层商店管道回上一构建，事故记录进 TEST_LOG.md。

### 7.3 密钥与环境

- 任何 secret（API key、证书）不进仓库；走 EAS Secrets / 本地 `.env`（gitignored）。
- 🔒 NAS/集群凭据只允许引用 AGENTS.md 既有记录，禁止复制进 Mobile 仓库文件。

## 八、协作机制

### 8.1 里程碑工作流（对齐用户既定节奏）

每个 M{n} 交付五件套：**代码 + TDD 测试 + 全量回归 + `STATE.json` 里程碑条目（子任务 M{n}.1/M{n}.2…）+ `TEST_LOG.md` 时序记录（含关键代码片段与测试结果）**。
Mobile 的 STATE/TEST_LOG 落 `Mobile/` 根（新建），格式对齐 ToIV 根仓库。

### 8.2 会话开工规则

1. 先读 ToIV 根 `AGENTS.md` 与本目录三份规范。
2. 🔒 文档仅供参考：凡涉及服务状态/端口/容量的结论，必须 SSH 真机核实后再写进文档。
3. 多里程碑并行时经 Task 子代理推进，互相隔离目录，主会话负责合并与回归。

### 8.3 Code Review 清单（PR 必查）

- [ ] 无违反第四节禁令清单
- [ ] 组件四态齐全、触碰目标 ≥44pt（见 UI/UX 指南）
- [ ] 新端点有契约测试；新逻辑覆盖率达标
- [ ] 浅色主题 + 五色板下截图核对（视觉对称、无高饱和堆色）
- [ ] 文档（STATE/TEST_LOG/规范）同步更新

### 8.4 Definition of Done

功能实现 + 测试绿 + 真机双端验证 + 文档落账 + Review 通过，五者齐备才算 Done。

## 九、安全与性能

- 网络安全：生产仅允许 HTTPS/内网白名单；证书校验不可关；token 过期统一 401 跳登录。
- NSFW：意图头 `X-NSFW` 仅在该板块注入；媒体详情页不缓存到系统相册。
- 性能预算：冷启动 ≤2.5s（53% 用户 3 秒流失红线内）；列表滚动稳定 60fps；首屏图片走 `expo-image` 缓存 + 渐进加载；轮询不得阻塞 UI 线程。

## 十、Monitoring

- 崩溃与错误：Sentry（对齐 Web 端 `@sentry/nextjs` 体系，RN 侧 `@sentry/react-native`）。
- 关键指标：冷启动时长、生成提交成功率、轮询完成率、OTA 更新到达率；里程碑验收时采样记录进 TEST_LOG.md。
