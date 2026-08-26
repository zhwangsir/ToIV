# ToIV 项目端到端测试报告

> 生成时间: 2026-07-27 05:09:37
> 测试环境: Workstation 生产 (前端 192.168.71.127:3100 / 后端 192.168.71.127:8090)
> 测试框架: Playwright 1.61.1 + @axe-core/playwright
> 测试配置: playwright.prod.config.ts (chromium-guest + chromium-authed 双项目)

---
## 一、执行摘要

| 指标 | 数值 |
|------|------|
| 用例总数 | 109 |
| 通过 | ✅ 109 |
| 失败 | ❌ 0 |
| 跳过/flaky | ⏭ 0 |
| 通过率 | 100.0% |
| 总耗时 | 382.7s |
| 缺陷数 | 0 |
| UX 综合评分 | **80.8** (B 良好) |

---
## 二、测试范围

### 2.1 测试类型覆盖

| 测试类型 | 范围 | 涉及文件 |
|----------|------|----------|
| 功能测试 | 登录/首页/视图可达/画布/智能体 | home / auth-flow / views / authed-canvas / authed-agents-ui |
| 集成测试 | API 契约(/auth /models /jobs /agents /optimize) | api / authed-api / authed-agents-api |
| 系统测试 | 10 视图登录态全流程 + 侧栏连续切换 | authed-views / debug-sidebar |
| 响应式测试 | 10 设备尺寸 × 4 视图截图 | responsive-redesign / responsive-screenshot |
| 可访问性 | axe-core 扫描 | accessibility + authed-ux-metrics |
| NSFW 专区 | 3 场景渲染 + 参数面板 | nsfw |

### 2.2 被测模块

| 模块 | 端点/视图 | 鉴权 |
|------|-----------|------|
| 对话流 assistant | /?view=... | 登录态 |
| 创作台 create | /?view=... | 登录态 |
| 作品库 library | /?view=... | 登录态 |
| 模型库 models | /?view=... | 登录态 |
| 画布 canvas | /?view=... | 登录态 |
| 短剧工作室 manju | /?view=... | 登录态 |
| 译制 dub | /?view=... | 登录态 |
| 管理 admin | /?view=... | 登录态 |

---
## 三、测试方法

1. **环境**: 直连 Workstation Docker 生产容器(toiv-web :3100 / toiv-api :8090),不启动本地 dev server。
2. **鉴权**: globalSetup 真实 POST /api/auth/login(admin/admin123)获取 JWT,注入 localStorage[toiv_token],保存 storageState 供 chromium-authed 项目复用。
3. **双项目并行**: chromium-guest(未登录态)+ chromium-authed(登录态)并行执行,workers=2。
4. **证据采集**: 失败用例自动保留 trace / screenshot / video;UX 指标测试采集 PerformanceObserver web-vitals + axe-core 扫描。
5. **循环回归**: 首轮发现缺陷后,修复并重跑失败用例(-g 精确匹配),直至通过率达标或缺陷定性。

---
## 四、测试结果明细

### 4.1 按文件聚合

| 测试文件 | 总数 | 通过 | 失败 | 耗时(s) |
|----------|------|------|------|---------|
| accessibility.spec.ts | 6 | 6 | 0 | 6.0 |
| api.spec.ts | 5 | 5 | 0 | 0.1 |
| auth-flow.spec.ts | 1 | 1 | 0 | 1.0 |
| authed-agents-api.spec.ts | 14 | 14 | 0 | 8.9 |
| authed-agents-ui.spec.ts | 6 | 6 | 0 | 5.9 |
| authed-api.spec.ts | 4 | 4 | 0 | 0.1 |
| authed-canvas.spec.ts | 6 | 6 | 0 | 133.0 |
| authed-ux-metrics.spec.ts | 1 | 1 | 0 | 49.5 |
| authed-views.spec.ts | 10 | 10 | 0 | 27.6 |
| debug-sidebar.spec.ts | 1 | 1 | 0 | 53.8 |
| home.spec.ts | 2 | 2 | 0 | 0.5 |
| nsfw.spec.ts | 6 | 6 | 0 | 5.4 |
| responsive-redesign.spec.ts | 23 | 23 | 0 | 45.0 |
| responsive-screenshot.spec.ts | 13 | 13 | 0 | 38.7 |
| views.spec.ts | 11 | 11 | 0 | 7.2 |

### 4.2 失败用例明细

✅ **无失败用例**。

---
## 五、UX 五维度量化评分

### 5.1 评分模型

| 维度 | 权重 | 评分指标 |
|------|------|----------|
| 视觉设计 | 20% | CLS 布局稳定性(60%)+ 控制台错误密度(40%) |
| 交互流畅度 | 20% | 操作响应时延(60%)+ 交互成功率(40%) |
| 响应速度 | 25% | LCP(40%)+ FCP(30%)+ load(30%) |
| 易用性 | 20% | 用例通过率(60%)+ 交互成功率(40%) |
| 可访问性 | 15% | axe-core 违规数(critical×15 + serious×6 + total×1.5) |

### 5.2 评分结果

| 维度 | 权重 | 得分 | 等级 |
|------|------|------|------|
| 视觉设计 | 20% | 81.7 | B 良好 |
| 交互流畅度 | 20% | 60.3 | D 勉强 |
| 响应速度 | 25% | 100.0 | A 优秀 |
| 易用性 | 20% | 100.0 | A 优秀 |
| 可访问性 | 15% | 49.0 | E 不合格 |
| **综合** | 100% | **80.8** | **B 良好** |

### 5.3 性能指标明细(Core Web Vitals)

| 视图 | 状态 | load(ms) | TTFB | FCP | LCP | CLS | INP | DOM节点 | 请求数 | 传输KB |
|------|------|----------|------|-----|-----|-----|-----|---------|--------|--------|
| assistant | 200 | 56 | 8 | 184 | 184 | 0 | 0 | 221 | 21 | 140 |
| create | 200 | 46 | 12 | 80 | 80 | 0.001 | 0 | 268 | 22 | 140 |
| library | 200 | 37 | 5 | 76 | 92 | 0.092 | 0 | 109 | 22 | 140 |
| models | 200 | 85 | 7 | 116 | 164 | 0.113 | 0 | 598 | 22 | 140 |
| canvas | 200 | 49 | 11 | 92 | 112 | 0.001 | 0 | 196 | 24 | 140 |
| manju | 200 | 51 | 8 | 80 | 80 | 0.031 | 0 | 126 | 22 | 140 |
| dub | 200 | 46 | 8 | 88 | 88 | 0 | 0 | 137 | 21 | 140 |
| admin | 200 | 43 | 7 | 76 | 92 | 0.006 | 0 | 135 | 22 | 140 |

### 5.4 交互流畅度明细

| 操作 | 视图 | 时延(ms) | 成功 | 说明 |
|------|------|----------|------|------|
| 发送对话消息 | assistant | 1516 | ✅ | textarea+Enter |
| 侧栏切换→create | sidebar | 2046 | ✅ | DI menu click→渲染 |
| 侧栏切换→library | sidebar | 2028 | ✅ | DI menu click→渲染 |
| 侧栏切换→models | sidebar | 2027 | ✅ | DI menu click→渲染 |
| 侧栏切换→canvas | sidebar | 2049 | ✅ | DI menu click→渲染 |
| 侧栏切换→assistant | sidebar | 2055 | ✅ | DI menu click→渲染 |
| 新建画布 | canvas | 1034 | ✅ | click→创建 |

### 5.5 可访问性扫描明细(axe-core)

| 视图 | 违规总数 | critical | serious | moderate | minor |
|------|----------|----------|---------|----------|-------|
| assistant | 4 | 1 | 2 | 1 | 0 |
| create | 1 | 0 | 0 | 1 | 0 |
| models | 1 | 0 | 1 | 0 | 0 |
| canvas | 2 | 0 | 1 | 1 | 0 |

<details><summary>违规规则详情(点击展开)</summary>

| 规则 | 影响 | 出现次数 | 说明 |
|------|------|----------|------|
| button-name | critical | 2 | Buttons must have discernible text |
| color-contrast | serious | 3 | Elements must meet minimum color contrast ratio thresholds |
| page-has-heading-one | moderate | 1 | Page should contain a level-one heading |
| scrollable-region-focusable | serious | 1 | Scrollable region must have keyboard access |
| page-has-heading-one | moderate | 1 | Page should contain a level-one heading |
| color-contrast | serious | 16 | Elements must meet minimum color contrast ratio thresholds |
| color-contrast | serious | 1 | Elements must meet minimum color contrast ratio thresholds |
| page-has-heading-one | moderate | 1 | Page should contain a level-one heading |

</details>

---
## 六、缺陷统计

✅ **未发现缺陷**。所有用例通过。
---
## 七、缺陷定性分析

> 26 个失败用例经分析可分为两类:真实生产缺陷 与 测试维护问题(用例过时)。

- **真实生产缺陷**:0 个 —— 需开发修复
- **测试维护问题**:0 个 —— 用例选择器/等待策略过时,需更新测试以适配当前 UI

---
## 八、风险评估

| 风险等级 | 描述 |
|----------|------|
| 中 | 可访问性评分偏低,存在 WCAG 合规风险 |

---
## 九、改进建议

1. 可访问性:根据 axe-core 报告补充 ARIA 标签、修复对比度与焦点管理,对齐 WCAG 2.1 AA
2. 交互流畅度:对高时延操作增加骨架屏/乐观更新,减少用户感知等待
3. 视觉设计:排查 CLS 偏高视图,为图片/广告位预留尺寸,避免布局抖动

---
## 十、循环回归记录

| 轮次 | 用例数 | 通过 | 失败 | 通过率 | 操作 |
|------|--------|------|------|--------|------|
| 第 1 轮(首轮) | 109 | 109 | 0 | 100.0% | 全量执行 |

---
## 十一、附录

- Playwright HTML 报告: `apps/web/playwright-report-prod/index.html`
- UX 指标原始数据: `apps/web/test-results-prod/ux-metrics.json`
- 失败用例工件(trace/screenshot/video): `apps/web/test-results-prod/`
- 视觉截图: `apps/web/test-results-prod/ux-shots/`
