# ToIV 前端 UI 重建 · 功能与需求清单（Requirements Inventory）

> 状态：草案 v1（2026-10-29）· 供用户复审
> 用途：UI 重建的"不得丢失"基线。任何新 UI 方案必须覆盖本清单 P0 全部条目；P1 默认覆盖；P2 可延后但须显式记录。
> 关联：视觉身份基准 = dramaclaw（SuperTale：深中性 + 电光青）；范式 = 三面（流水线主面 / 画布 / 剪辑湾）；现状勘察见会话记录与 `docs/ops/ACCEPTANCE_AUDIT_20261029.json`。

---

## A. 产品定位与硬约束（不可谈判）

1. **本地优先**：模型推理、素材、生成结果全部留在本机；自有设备集群（LAN/Tailscale）算本地；不接第三方云推理。
2. **限制只做前端**：后端零审查、零过滤、零管控；主代码不得散落 `if (nsfw)`、敏感词判断、红线拦截。
3. **锁文件唯一来源**：`apps/canvas/web/src/content-lock.ts`（web 端镜像 `apps/web/lib/content-lock.ts`）；经 `@content-lock` 别名消费；删除锁文件 → 构建/启动/功能全部照常，接口回落放行 no-op，不报错不白屏不缺功能。
4. **UI 美观优先于功能数量**；技术栈保持 React / Go / FastAPI。
5. **旧 UI 冻结**：重建期间不再修改旧 UI（含其 CSS/测试钉值）；新系统独立目录，strangler 逐页切换，切换完成后删除旧实现。
6. **许可纪律**：dramaclaw 为 Elastic-2.0 —— 只借鉴视觉语言与交互范式，**不 vendor 其源码/CSS**；字体仅用 OFL/系统字体；参考仓许可沿用 `docs/ops/LICENSE_DEPENDENCY_AUDIT_20261029.json`。

---

## B. 信息架构现状 → 新三面归属

| 现路由（/studio 前缀省略） | 现页面 | 新归属面 | 优先级 |
|---|---|---|---|
| `/` → `/create` | 创作工作台（导演台） | 流水线面（主面） | P0 |
| `/create?project=:id` / `?run=:id` | 项目/作业上下文创作 | 流水线面 | P0 |
| `/toiv/drama`、`/toiv/drama/:id` | 短剧列表/工作区 | 流水线面（剧本/分镜阶段） | P0 |
| `/canvas`、`/canvas/:id`、`/projects*` | 节点画布/项目库 | 画布面 | P0 |
| `/library`、`/library/works/:id` | 媒体库/作品详情 | 流水线面（资产阶段）+ 独立库页 | P0 |
| `/assets` | 资产存储/归档恢复 | 流水线面（资产阶段子页） | P1 |
| `/tasks`、`/toiv/runs/:id` | 任务中心/作业详情 | 三面共享任务抽屉 + 独立页 | P0 |
| `/toiv/market` | 工具市场 | 流水线面（工具阶段）/独立页 | P1 |
| `/settings` | 设置（R18/渠道/模型/算力/诊断） | 独立页（三面共享入口） | P0 |
| `/plugins`、`/plugins/eagle` | 插件中心 | 独立页 | P2 |
| `/agents` | 外部 Agent 客户端 | 独立页 | P1 |
| `/toiv/kpi` | KPI | 独立页 | P2 |
| `/home` | 首页仪表盘（已降级） | 退役或并入流水线面首页 | P2 |
| `/desktop*` | Cosmos 桌面壳（默认不可达） | 退役（源码保留种子） | 不做 |
| 成片/音画/导出 | 现散落于 create/preview | **剪辑湾面（新增）** | P0 |

> 结论：现产品缺一个独立的"成片/音画/导出"面（剪辑湾），重建时补齐；其余为现功能的重新组织，不新增业务域。

---

## C. 功能清单（按域）

### C1 创作主线（流水线面 · 剧本/素材/分镜/视频阶段）P0
- 项目：新建、从图片创建、SVML 词锚脚本导入、项目切换与上下文（`?project=`）。
- 剧本：beats 词锚编辑、改词重排（reflow，persist 试算/落库）、说话人/对白通道、cue 风格锚。
- 素材：场景清单、场景锚点（基础场景/变体/冻结不可变快照/绑定分镜/重冻不漂移）、角色设定卡（含 toonflow 四视图模板）、多视图一致性（主视/反打/左立面/右立面 + 视图锁）。
- 分镜：镜头卡（prompt/dialogue/duration/render_mode/beats）、候选 takes 生成与择一（`is_picked`）、单镜渲染/配音/对口型、整批渲染、加速档显式选项（默认满血）。
- 生成反馈：队列状态（done/running/queue 三色）、失败通知与重试策略（经 contentGate 判定是否自动重试）、文本任务恢复、冲突处理（creation-conflict）。
- 媒体池：素材/产物/分组/筛选/成人素材隐藏（经锁）、pending 占位、结果资产水合。
- 预览：时间线预览（失败回落）、视频播放器、音频回放。

### C2 画布面 P0
- 节点编辑：script/image/video/audio 节点、参考链接与边、选择工具条、右键菜单、分组/打组/解组、世界图层。
- 版本：版本历史、版本预览、同步状态与草稿、操作日志、修订冲突。
- 助手：画布助手侧栏（turns/composer/模型选择）、浮动 Agent 泡、提议边（虚线）与审批语义。
- 体验：快捷键 modal、缩放/小地图、刷新壳、同步进度。

### C3 剪辑湾面（新增）P0
- 镜头条（缩略 + 时长 + 状态）、大预览（时码 HUD、letterbox）、transport。
- 多轨序列：视频轨 + 音频轨（旁白/对白/BGM）、clip 拖拽排序、转场、播放头。
- takes 轨：候选列表、ACTIVE 择一、来源（Source）切换。
- 导出：Render MP4、导出预设、EDL 体检/剪点计划/成片自评/视觉下钻（fusion 能力入口）。
- 转写：packed transcript 查看与词级检索（library-transcript-search 能力复用）。

### C4 资产与作品 P0
- 媒体库四轨：素材/产物/作品/历史；分组与重命名；检索（含 transcript 全文检索）。
- 作品详情：媒体、transcript、EDL/QA 入口、下载/桌面保存、归属与签名 URL 语义不变。
- 资产治理：归档与恢复、存储用量、外部资产源（eagle 等 P2）。

### C5 任务中心 P0
- 三源聚合：ToIV 作业 + 画布任务 + 智能体 runs；状态/错误/hold_reason；取消；批量。
- 作业详情：产物、候选、日志、重提。

### C6 设置与门控 P0
- R18 门控 pane（开关语义经锁；X-NSFW 上下文）、内容门控徽标与成人窗帘/隐藏（经锁）。
- 渠道与模型：模型槽位表、默认网格、mix 预设、服务编辑、lora 行、协议/能力浏览器、LLM mutex banner、连接测试。
- 算力：本地算力 pane、RunningHub pane、fleet/引擎状态、诊断面板。
- 偏好：prompt 偏好、外观（主题/明暗/强调色）→ 由新 token 系统接管。

### C7 智能体与工具 P1
- 外部 Agent 客户端连接与管理（/agents）、agent run 详情。
- 工具市场：引擎/工具卡、能力与协议浏览、插件中心与文档 modal（P2）、eagle 库（P2）。
- 姿势参考库（pose gallery）、choice-browser、workflow 测试台/图编辑（P2）。

### C8 本地与桌面 P1
- 本地工作区模式：IndexedDB 仓、与后端同步、离线回落。
- 桌面运行时：媒体保存、更新准备/启动、PWA。
- 外观 bootstrap、主题 store、skin themes → 新系统单一来源。

### C9 账号与壳（apps/web）P0
- 登录/落地页、handoff 到 /studio、classic 回落面板、退出登录。
- R18/成人面只在 canvas；web 不做引擎台。

---

## D. 非功能需求

### D1 视觉身份（dramaclaw SuperTale，自写实现）
- 色：深中性近黑 `#090909` 底；oklch 语义 token（background/foreground/card/muted/border/ring/primary/secondary/success/warning/destructive/chart/sidebar）；电光青 primary（oklch 0.72 0.145 205）；`.dark`/light 双主题同结构换值。
- 形：radius 16/12/9/pill；柔散投影（dark `0 4px 12px`）；面板 rgba 白（light）/ 深卡（dark）。
- 字：Noto Sans SC / PingFang SC；像素倒计时字体仅用于计时器（OFL 自托管或系统等宽回落）。
- 签名件：sliding-tabs 白色药丸滑块（300ms `cubic-bezier(0.22,0.8,0.24,1)`）、aurora/dark-veil 环境光（克制）、companion 吉祥物浮泡（可关）、focus-visible 环。
- 动效规范：enter/exit 150–220ms ease-out；列表 stagger ≤40ms/项；状态变化有反馈；**禁粒子/禁无意义循环动画**。
- 状态语言：done=success 绿 / running=warning 琥珀 / queue=muted 灰；destructive 仅删除确认。

### D2 性能
- 路由级 lazy + code splitting 组（vendor-react / vendor-icons / vendor-antd 或其后继）；首屏不提前执行组件库 bootstrap。
- 媒体懒加载 + 虚拟列表（长列表必用）；缩略图与全图分离。
- 目标：首屏 JS 不高于现状；路由切换无白屏/无整树重挂。

### D3 可访问性
- skip-link、focus-visible、键盘全导航、aria 状态（任务/生成/门控）、对比度 ≥4.5:1（暗底青/绿/琥珀需校验）、减少动效偏好（prefers-reduced-motion）。

### D4 响应式
- ≥1280 完整三面；1024–1279 降级（检查器折叠为抽屉）；<1024 只读浏览或引导到桌面；不做移动编辑。

### D5 测试策略（替换 RGB 钉值）
- 组件测试断言语义（role/label/state），**禁止断言具体 RGB/像素**（旧钉值债的根因）。
- 关键流浏览器 e2e 保留：登录→create→渲染→任务→库→导出；锁移除演练（删 lock → 构建/启动/功能不降级）。
- 门禁：api pytest / web npm test / canvas-web bun test+lint+typecheck / canvas go vet+test 全绿。
- 视觉回归：可选截图基线（仅关键面，阈值宽松），不作硬门禁。

### D6 锁文件与门控纪律
- 新 UI 任何门控/隐藏/窗帘/徽标一律经 `@content-lock`；缺失即中性 no-op；不得在组件内写内容判断。

---

## E. 明确不做（退役/延后）

- `/desktop*` Cosmos 壳默认交付（源码留种子）；opentalking 数字人；web 引擎台；旧 skills 入口；`/test-voice-recording`、dev labs 进生产；`/home` 独立首页（并入流水线面或退役）；KPI/插件/eagle/workflow 测试台 = P2 延后；移动端编辑。

---

## F. 验收标准

1. **美观门禁（主观 + 对照）**：真机截图三面 vs dramaclaw 参照 vs 旧 UI 三方对比；用户逐面签字。
2. **功能不回归**：C 清单 P0 全条目可走通；关键流 e2e 绿；四套件绿。
3. **锁演练**：删除 `content-lock.ts` 后构建/启动/全功能照常（含成人内容可见性回落中性）。
4. **性能**：首屏 JS ≤ 现状；路由切换无白屏；长列表虚拟滚动生效。
5. **债务清零指标**：新系统 `!important` = 0、内联 style ≈ 0、硬编码色值 = 0（全部走 token）；单文件 CSS ≤ 800 行。
