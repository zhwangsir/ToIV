# ToIV 全站实用性调研报告（2026-08-30）

> 四路并行调研汇总：视频生成链路代码审计 / 23 视图逐一 UX 审计 / 生产环境浏览器走查 / 历史遗留盘点。
> NSFW 专项不在本报告范围。所有结论均带代码行号或生产实测证据。

---

## 〇、最严重的发现（先读这三条）

### S1. 生产环境创作页整体不可用（P0，生产实测）
`GET /api/models/engines` 生产实测 **34.2s**（疑似探测内网 worker 走 TCP 超时）> 前端 30s 超时
→ `GenerateView.tsx:954-957` 引擎未就绪时 `onChange` 直接丢弃输入，**提示词框打不进字**，生成按钮永久禁用。
测试人员反馈的「核心视频生成功能难用」第一嫌疑人。**修复目标 <2s**：worker 探测短超时并发化 + 结果缓存（registry 已有 8s TTL，需排查为何未生效）；前端 `if (!engine) return` 改为本地草稿态暂存。

### S2. 公网弱口令 + R18 开启（安全隐患，非走查项但必须报）
生产站 `admin / admin123` 弱口令，且该账号 R18 模式开启；`deploy/.env` 明文。**建议立即改密**。

### S3. 一批「已修好但没上线/没推送」的修复（高）
本地已修但生产没有的：`eb51c86` UX 包（停止按钮不真取消等）、`58cf643` 助手假超时回放、`e833f33`+`a5e04ea` 上下文溢出、LoRA 自动选型 `93c275e`+`e1f856e`、`859b60f` 竖版 422。**一键部署即可消除一大批测试差评**，成本最低收益最大。

---

## 一、P0 阻断级（5 项）

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| P0-1 | 生产 engines 接口 34.2s 超时 → 创作页全瘫、输入被吞 | 生产实测 + GenerateView.tsx:954 | 探测并发短超时+缓存；无引擎时本地草稿态 |
| P0-2 | SSE 传输断线被误判为业务失败，DB 误标 error 又被 tracker 翻回，状态撕裂 | jobs.py:900-902 + trackJob.ts:482-494 | WS 异常只断流不 mark error，交回孤儿/超时回收 |
| P0-3 | 取消非终态：mark_done 可复活 canceled；链式续写取消不传播（白烧 GPU） | tracker.py:140-148 + video_generators.py:153-185 | canceled 列终态跳过；_wait_files/duration chain 检测中断 |
| P0-4 | 子编辑器轮询无终态兜底：作业消失/取消 → 多镜头/关键帧链编辑器永久锁死 | MultiShotEditor.tsx:72-103；KeyframeChainEditor.tsx:109-135 | 轮询加 canceled/404/总超时终态 + 停止出口；allSettled |
| P0-5 | 画布页公网架构性不可用（HTTPS 混合内容拦 HTTP 直连）；LAN :3100 也不通 | 生产实测「ComfyUI 连接失败」 | 服务端代理 ComfyUI；恢复 LAN 入口 |

## 二、P1 严重体验（12 项）

| # | 问题 | 证据 |
|---|---|---|
| P1-1 | 失败原因不落库，全链路只剩「生成出错」，用户无法知道为什么失败 | models.py Job 无 error 列 |
| P1-2 | 任务中心对失败报绿色成功 toast；无失败重试 | TaskCenter.tsx:98-112 |
| P1-3 | 前端 35min 跟踪超时 < 后端 2h，且超时文案被改写成「请重试」误导重复提交 | trackJob.ts:206 + friendlyError.ts:22 |
| P1-4 | 上传 30s 超时无进度条，200MB 驱动视频几乎必败 | api.ts:79 + upload.py 上限 200MB |
| P1-5 | 提交无幂等，超时重试 = 同一内容跑两单 | 提交链路无 client_request_id |
| P1-6 | 引擎列表失败时主界面零反馈，窄屏完全无感知 | GenerateView.tsx:1015-1026 |
| P1-7 | 生成按钮禁用无原因提示（缺参考图/音频时用户不知缺什么） | PromptBar.tsx:167-178 |
| P1-8 | 假空态通病：Skill 市场/Studio 项目列表/形象列表加载失败静默显示为空 | lib/agents.ts:87；StudioView.tsx:62-75；AvatarTalkView.tsx:227-239 |
| P1-9 | 长操作无取消/无进度：图像编辑运行中、视频导出、360° 环绕；「清空重来」「删分镜」无确认 | ImageEditView:1190；VideoEditView:346,200；StoryboardStage:58 |
| P1-10 | 动态分镜「前往工作室」丢 projectId，落列表页找不到刚建的项目 | AnimaticView:590 vs page.tsx:624 |
| P1-11 | 观测面板 40 处硬编码 hex 不随主题；伪 token `--danger` 4 处恒硬编码 | ObservabilityView:733+；MultiShot/KeyframeChain/AiVideoEdit |
| P1-12 | 任务中心中止用原生 window.confirm，全站独此一处 | TaskCenter.tsx:130 |

## 三、P2 打磨（精选）

- 完成但无产物显示成功空白舞台（tracker.py:189 + ResultPanel:438）
- 会话历史刷新即丢、结果无下载按钮（GenerateView:449；ResultPanel 全文）
- 进度 100% 后评分期定格像卡死（jobs.py:699-731）
- 数值参数无即时校验，非法输入静默回落（ParamField.tsx:151）
- 降级轮询扫全量 200 条而非 lookup 单查（trackJob.ts:380；GenerateView:462 pollFinalResult）
- 空态两套体系并存（ui/Empty vs 6 处私造）；Library/Drama 手写页头；3 处 PageHeader 死引用
- 工作室项目状态腐烂（11 天仍「生成中」）；8 个「未命名项目」无法区分
- 生产构建残留 `/@vite/client` 引用；作品库部分视频缩略图 ERR_ABORTED；SEED 19 位精度截断
- admin 视图无前端门控且无导航入口；画布错误页泄露内网 IP
- 视图切换整页刷新 + 3s 水合空白

## 四、历史遗留（高价值）

1. **8 项已修未上线**（见 S3）——部署即收益
2. LLM 瑕疵：推理英文泄漏进 text 流；长对话题材漂移（AGENTS.md:329）
3. 旧 agent_workflow 作业 done 但 results 空（AGENTS.md:328）
4. toiv-tts NRestarts=6363 不稳 + workstation swap 100% 用满——与「按需资源分配」议题直接相关
5. 批量精修/eval watcher 进程内驻留，重启即丢
6. 工程债：root latentsync :8600 旧容器、studio04 退役清理挂起、双远程漂移

---

## 五、修复计划（分波次）

### Wave 0：止血（当天，零开发量）
- W0-1 **部署现有未上线修复**（eb51c86 等 8 项）→ 生产验证 → 双推远程
- W0-2 **改生产弱口令** + 排查 .env 暴露面
- W0-3 恢复 LAN :3100；排查 engines 34.2s 慢因（worker 探测超时并发化+缓存）

### Wave 1：视频生成核心链路根治（P0-2/3/4 + P1-1/2/3/5）
状态机三修（SSE 误杀、取消终态、编辑器锁死）+ Job.error 列落库 + 任务中心按终态分别 toast/重试 + 超时文案透传 + 提交幂等。
**这是测试人员「视频生成缺陷」反馈的正主**。

### Wave 2：创作页韧性（P1-4/6/7 + P2 精选）
上传长超时+进度条、引擎失败主界面 ErrorBar、禁用原因提示、会话历史/在跑恢复、下载按钮、失败占位、进度分阶段、参数即时校验、lookup 替换全量扫描。

### Wave 3：逐页 UX 精修（对照 UI_STANDARD §10，按 14 页顺序表）
每页过一遍验收清单：假空态收敛、取消/确认门补齐、伪 token/硬编码清剿、PageHeader/Empty 组件收敛、断链修复、移动端 44px。

### Wave 4：生产加固与工程债
画布服务端代理、构建残留清理、缩略图间歇失败、项目状态腐烂 reconcile、admin 门控、旧容器/退役清理。

### 长期轨道（独立排期）
- 应用市场（M1-M6，方案已定稿）
- 按需资源分配（R1-R5 冷层 scale-to-zero，直接缓解 toiv-tts/workstation 资源紧张）

**每波次完成标准**：对应测试全绿（后端 pytest / web npm test / tsc 0 / 干净 build）+ 生产验证 + STATE/TEST_LOG 更新 + commit。
