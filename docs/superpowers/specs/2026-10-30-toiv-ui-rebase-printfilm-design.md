# ToIV UI 换基重构设计（printfilm 基座）

> 状态：待用户复审（写码前最后一道门）。方向级批准：2026-10-30 用户「可以，就按照这个开始吧」。
> 前序：`2026-10-29-toiv-ui-rebuild-requirements.md` / `...-design.md`（自研 studio 系统，Plan1–5b 已部署）；本 spec **取代其视觉与壳层路线**，保留其需求清单与纪律。

## 0. 目标与基座

- 目标：以他人成熟 UI 为基座重构 ToIV 前端（用户判自研融合仍不达标），并在其上叠加 ToIV 专属能力；美观优先级最高，能力零丢失。
- 基座：**printfilm**（`third_party/reference-repos/yi1108--printfilm`，provenance commit `62f8d95d7ee6a5af9543351040e6183e9dcbbe65`，**MIT**）。
  - 栈匹配：React 19 + TS + Vite 8 + react-router 7 + @xyflow/react 12 + lucide；i18n zh/en（zh 默认）。
  - 域匹配：`pages/studio/`（Create→Storyboard→Editor→StyleConfig 创作主链）、`pages/drama/`（项目/分集/分镜编辑/React Flow 画布/资产库）、Tools/Templates/History/Settings。
  - 改写点集中：`src/api/http.ts` 的 `getToken()` 注入点；env 仅 `VITE_API_BASE`/`BASE_URL`；vite.config 极简（base/proxy 由我方增量配置提供）。
- 许可证合规：MIT 全文与版权头随 vendor 树保留；`apps/prime/web/NOTICE` 记录 MIT + provenance commit；AGPL（ArcReel/AIMovieStudiov2）、社区许可（CineGen/BigBanana）、ELv2（dramaclaw）、自定义 Source-Available（BeefTV 新材料）**一律不 vendor**。
- 非目标：不运行 printfilm 自带 FastAPI；不做计费/钱包（删 `pricing`/`billing`/`WeChatGroupFab`）；不改 ToIV API 契约；不动内容锁纪律（限制只在前端 `@content-lock`）。

## 1. 落点与 vendor 纪律

- 新包 `apps/prime/web/`：printfilm `frontend/` 原样落入 `src/`（保持上游路径以便跟上游 diff）；`package.json`/`vite.config.ts` 为我方增量（base=`/studio/`、dev proxy、别名 `@/`→`src/`、`@content-lock`）。
- **vendor 冻结**：测试 `test/prime-vendor-frozen.test.ts` 对 `src/` 内 vendor 文件清单做 sha256 清单校验（与 provenance 一致）；任何对 vendor 文件的修改必须走「上游同步」流程并更新清单，禁止随手改。
  - **bootstrap 白名单（唯一例外，改动仅限入口换接）**：`index.html`、`src/main.tsx` 允许把入口指向 `src/toiv/bootstrap.tsx`；路由树在 bootstrap 内自建（直接 import vendor 页面组件），vendor `App.tsx` 弃用不改——冻结面保持 100%。
- ToIV 增量只落：`src/toiv/**`（adapters/shell/addons/皮肤层）、路由表包装文件、`src/styles/toiv-skin.css`（CSS 变量覆盖层）。
- 部署契约不变：Go canvas backend 以 `base=/studio/` 服务 dist；`deploy/deploy.sh` 增 `--prime` 开关切换 dist 来源（默认旧 dist，灰度→全量→退役）。

## 2. 路由映射（prime → ToIV 语义，均在 `/studio` base 下）

| prime 路由 | ToIV 语义 | 数据源 |
|---|---|---|
| `/`、`/studio` | 项目库（画布面 home） | `/api/studio/projects` + canvas `/studio/api/canvas-projects` 双源 |
| `/studio/new` | 新建向导 | createDramaProject / import-svml |
| `/studio/:id` | 流水线面·分镜主视图 | `/api/studio/projects/{id}`（beats→卡副文本、candidates→takes） |
| `/studio/:id/style` | 场景/视图锚点管理 | `/api/drama/.../scenes`、variants、freeze-anchor、attach |
| `/studio/:id/editor` | 剪辑湾 | shots+audio；导出复用 multitrack/jianying 移植模块 |
| `/drama/projects/:id/canvas`、`.../episodes/:eid/canvas` | 画布面（React Flow） | scenes/shots 节点化 |
| `/drama/assets`、`/assets` | 资产库（角色/场景/音色） | characters + character-sheet + scenes |
| `/tools`、`/tools/:id` | 工具中心 | market/tools intent |
| `/history` | 作品库+任务中心 | `/api/jobs` + library |
| `/settings` | 设置 | W4 原生，之前 iframe 桥 |
| `/auth` | ToIV 会话 | miniapp_token 交换 + `/api/auth/me` |
| 删除 | `/pricing`、billing、WeChatGroupFab | — |
| iframe 桥 `/studio/legacy/*` | library 详情、plugins、kpi、composer（/create 无 project）、旧引擎 `/canvas/:id` | 旧 canvas web 第二 dist；同源注入降级样式 |

## 3. 数据层与鉴权

- `src/toiv/adapters/`：ToIV 形状 → prime 视图模型（shots→storyboard cards；candidates→takes；scenes→canvas nodes；jobs→任务项；recipes→配方卡）。
- 写路径纪律继承：`PUT /api/studio/projects/{id}/shots` 为**全量替换**，适配器必须 GET→merge→PUT；改词必须走 `reflow-beats`；生成默认满血档。
- 鉴权：`http.ts` 的 `getToken()` 返回 ToIV JWT；启动时 `?miniapp_token=` 交换会话（移植 canvas web 现有 exchange）；`RequireAuth` 改判 ToIV session；登出清会话回 `/auth`。
- 任务/生成：render/voice/lipsync → ToIV 端点 → `/api/jobs` 轮询进任务抽屉（作业/画布/智能体三源）。

## 4. ToIV 加东西（addons）

三面切换（流水线/画布/剪辑湾=路由组切换件）、任务胶囊+抽屉三源、配方 tab（存/导出 `*.toiv-recipe.json`/安装 schema 校验/复用）、companion 小爪、PIKO 计时件、内容锁门控（`@content-lock` 接 R18/未成年面）、品牌色最小替换（`toiv-skin.css` 变量覆盖，不动 vendor 文件）。

## 5. 视觉与债务门禁

- 视觉身份=printfilm 原生；仅品牌色/圆角经 `toiv-skin.css` 覆盖层最小替换（不再混三家语言）。
- 门禁适配：现有 `test/studio-debt-metrics.test.ts` 扩展作用域到 `apps/prime/web/src/toiv/**` 与新增 css（!important=0、硬编码色仅 token/皮肤层、内联样式键白名单 left|width|paddingTop|backgroundImage、单 css ≤800 行、无 antd）；vendor 基线经冻结哈希豁免；语义测试禁 RGB/像素钉值。
- token 单源：`toiv-skin.css` 变量映射表 + 与 `studio/theme/tokens.css` 的同步测试（品牌色一处改）。

## 6. 波次（每波=commit+门禁+生产取证；回退=deploy 单开关回旧 dist）

- **W1 基座落地**：vendor 拷贝+NOTICE+冻结哈希测试；vite base/proxy/别名；auth 接 ToIV；壳顶栏（三面切换+任务胶囊+companion）；HomePage 项目库双源；`--prime` 灰度开关。验收：`/studio/` 出 prime 壳+32 真项目卡；回退单开关演练。
- **W2 流水线**：Storyboard/StyleConfig/Editor 接 ToIV（含 PUT 全量替换纪律、reflow、配方 tab、导出器移植）；生成→jobs+抽屉。验收：真项目 create→storyboard→render→editor 导出走查 e2e。
- **W3 画布+资产库**：React Flow 节点接 scenes/shots；冻结锚点/绑定 e2e；角色/场景/音色资产库。验收：真场景画布渲染+冻结→绑定→渲染消费链。
- **W4 共享面原生**：history/settings/tools/library 详情原生替代并撤对应桥。
- **W5 桥与全量**：iframe 桥补齐 plugins/kpi/composer/旧引擎；`--prime` 默认开；14 路由生产取证。
- **W6 退役**：删旧 studio 三面与桥、旧 dist 下线；达成 UserLayout/globals.css/antd 删除入口。

## 7. 测试与验收

- 组件语义测试（renderToStaticMarkup）覆盖 addons 与 adapters；浏览器 harness 复用 Bun.build 别名插件指 prime 入口（失败路径 503 约定保留）。
- 生产 e2e：`tmp/ui-proto/verify-studio-5b.mjs` 选择器迁移到 prime 结构 + 配方 e2e 保留；锁删除演练；四套件绿为合并门禁。
- 验收口径继承需求清单 P0/P1；美观验收=用户对 W1/W2 真机截图拍板。

## 8. 风险与回退

- vendor 漂移→冻结哈希测试拦截；上游跟进=定期 diff provenance commit。
- iframe 桥体验割裂→仅 W5 前过渡，同源可注入降级样式；W6 全撤。
- 许可风险→仅 MIT 基座；NOTICE+版权头保留；候选排除清单见 §0。
- 部署风险→`--prime` 单开关；每波生产取证后才推进下一波。

## 9. 基座契约证据（2026-10-30 核，provenance `62f8d95d`）

- **鉴权注入零改 vendor**：`src/api/client.ts` 的 transport 为 `getToken: () => localStorage.getItem('token')`；我方 auth 模块在 `miniapp_token` 交换后写 `localStorage.token`（登出 `removeItem`），API base 经 `VITE_API_BASE` 指 `/api`（dev proxy；生产同源由 Go backend 转发）。错误策略沿用 vendor `throwApiError`，其 `apiErrorMessage` 已兼容字符串/数组 detail（ToIV 422/503 语义可直接展示）。
- **路由单点**：vendor 路由树在 `src/App.tsx`（`<Routes>` 全表见 §2 映射来源）；按 §1 bootstrap 白名单弃用之，路由表自建于 `src/toiv/bootstrap.tsx`。
- **测试设施**：`npm test` = `node --experimental-strip-types --test tests/*.test.mjs`（已有 `tests/http.test.mjs`）→ 门禁与适配器测试同 runner 落地；lint=oxlint；build=`tsc -b && vite build`。
- **UI kit 可复用**：`components/ui/` = Button/Modal/DialogHost/PillTabs/PillFilter/Stepper/StatCard/Pagination/FilterSelect/Icons/ComingSoon/CreateChoiceModal/HelpCenter → addons 一律复用，不新造轮子。
- **画布即接点**：依赖含 `@xyflow/react@12`；`pages/drama/CanvasPage.tsx`、`EpisodeStoryboardPage` 为 W3 节点化接点。
- **样式面**：`styles/printfilm.css` 7304 行 + `pages/drama/drama.css` 7117 行，含 486 处 CSS 变量 → 品牌替换走变量覆盖层可行（§5）。
