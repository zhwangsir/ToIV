# 两项目完全融合方案（ToIV × BeefTV，2026-10-06 立版）

> 用户裁决：当前 /studio + 跳转不是融合，要求完全融合为一个项目。
> 本档为唯一规划依据；执行按里程碑推进，每批可独立验收/回滚。

## 一、两张皮的本质（现状盘点）

| 维度 | BeefTV（ToIV-canvas） | ToIV（main） |
|---|---|---|
| 前端 | Vite+React19 SPA，antd6+tailwind4，三层 token 21.7k 行 | Next.js，123 个视图 tsx，自有 token（今晨已对齐 BeefTV 色值） |
| 后端 | Go(gin+gorm)，**仅 sqlite 驱动**，per-user 每人一进程（120MB/人） | FastAPI，PG+Redis 中央，全部业务（市场/作品/任务/智能体/短剧/渲染编排） |
| 认证 | gate cookie（JWT 换发 + exchange 桥） | ToIV JWT（localStorage） |
| 数据 | 画布/项目/资产/模型配置在 per-user sqlite | 市场 6773 应用/作品库/agent-runs/短剧项目在 PG |
| 挂载 | /studio 经 Next rewrite → gate :8281 | /?view=* 全部视图 |

**跳转感的根源**：两个独立前端 + 两个数据域 + 两套认证；侧栏 external 链接只是把缝隙盖住了。

## 二、终态定义（什么才算"完全融合"）

```
浏览器 → toiv.wineryz.top
  ┌─────────────────────────────────────────────┐
  │ 单一前端：BeefTV SPA 承载全部产品功能          │
  │  /  首页(画布+ToIV模块卡)                      │
  │  /canvas/*  画布(现状)                        │
  │  /toiv/tasks /toiv/library /toiv/market      │
  │  /toiv/agent(对话) /toiv/drama(短剧工作台)     │  ← 全部原生路由页，同壳同语言零跳转
  └─────────────────────────────────────────────┘
  /api/*       → toiv-api(FastAPI+PG)            ← 业务数据域
  /canvas-api/* → canvas-api(Go 单实例+PG)        ← 画布数据域(表迁入同一 PG)
  认证：ToIV JWT 直读直校（同源），gate 退役
  仓库：ToIV main 单仓（apps/canvas-web + canvas 后端并入），单 CI 单部署
  Next 仅存：marketing 落地页 + 登录 + 静态托管 SPA
```

四条硬标准：①SPA 内无整页跳转 ②单一 PG 数据平面（画布与业务互相引用资产）③单一认证 ④单仓单部署。

## 三、里程碑

### M1 模式建立 + 小模块原生化（1-2 天）——先证明全链模式
- BeefTV web 内建 `services/toiv/` 客户端：同源 `/api/*` + `localStorage.toiv_token`（JWT 直带，不再依赖 gate 换发）
- 新增原生路由页：`/toiv/tasks`（agent-runs 列表）、`/toiv/library`（作品库网格）——antd 风格重写，消费 ToIV API 契约（对齐 main 仓 lib/api.ts 端点）
- 侧栏「TOIV 创作」组 external 链接 → 内部路由（task/library 先切）
- 验收：SPA 内点任务中心/作品库零跳转、数据与旧视图一致；模式（api client/页面骨架/错误态）沉淀为模板

### M2 大模块迁移（3-5 天）
- `应用市场`：列表/筛选/详情原生页；「运行应用」→ 创建 ToIV job → 结果引导至任务中心
- `智能体对话`：**推荐组件移植而非重写**——把 ToIV chat 面块（SSE+工具卡+会话管理，逻辑已成熟）包装为 BeefTV 内嵌组件，外层换 BeefTV 壳与 token；跑通 /toiv/agent 路由
- 旧 Next 对应视图开始降级为 fallback（模块级开关 toiv_module_fallback）

### M3 短剧工作台迁移（5-8 天，最大件）
- 项目列表 → 角色/设定卡编辑 → 分镜板 → 渲染管线状态 → 成片预览，逐块原生迁移（API 全部现成，纯前端工程）
- 完成后旧 Next 视图退役（Next 仅留 marketing+login+静态托管）

### M4 服务与仓融合（3-4 天）
- Go 后端补 postgres 驱动（gorm 分支 + sqlite→PG 迁移脚本），canvas-api 单实例化，per-user 进程模型与 gate 退役（serve.mjs 的静态托管/代理职责移交 Next 或 nginx）
- JWT 直校验：Go 侧验 ToIV JWT（共享密钥或内省端点）
- ToIV-canvas 源码并入 main 单仓：`apps/canvas-web`（SPA 源码）+ `services/canvas-api`（Go），统一 CI；GitHub ToIV-canvas 仓归档只读
- 部署合一：deploy.sh 一条命令出全站

## 四、关键决策点（需拍板）

| # | 决策 | 推荐 | 理由 |
|---|---|---|---|
| D1 | 产品主干 | **BeefTV SPA** | 设计体系成熟、画布是产品核心资产；Next 视图是过渡遗产 |
| D2 | 画布后端归宿 | **补 PG 单实例化** | 终态单数据平面；per-user sqlite 省事但两域永存、120MB/人不可扩展 |
| D3 | 智能体对话 | **组件移植起步** | 逻辑成熟（SSE/工具卡/会话），重写风险高；后续再渐进重构 |
| D4 | 迁移期兼容 | 模块级 fallback 开关 | 每个模块新旧并行到验收，单模块可秒退 |

## 五、风险与对策
1. 交互细节损耗（antd vs 原组件）：M1 模板先立交互基线，逐模块对照验收
2. 短剧工作台状态复杂（渲染轮询/门禁状态机）：最后迁，届时已有 5 个模块经验
3. sqlite→PG 数据迁移：写一次性迁移脚本 + 双写校验窗口；画布数据量小（个人用）
4. 双仓合并期 CI：M4 前两仓并存（现状已可），合并动作独立成批
5. gate 退役风险：保留 gate 代码与 ENTRY_ON 开关一个版本周期，R0 回滚路径不变

## 六、总量
专注开发约 **3-4 周**（M1 1-2d / M2 3-5d / M3 5-8d / M4 3-4d）；每里程碑独立交付可停可退。
