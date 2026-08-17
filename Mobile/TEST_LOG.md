# TEST_LOG — ToIV Mobile

按时间倒序记录每次回归。质量门禁：`tsc --noEmit` 0 错 · `expo lint` 0 警 · `jest --coverage` 全绿且四项覆盖率 ≥ 80%。

---

## 2026-08-15 · 交付前全量回归（M1-M30 收口）

**目的**：交付前最终验证，含 expo export 构建门禁（历史首次跑通）。

**修复**

- `expo export` 初次失败：`agent-runs/[id].tsx` 链 `@/lib/media` → `expo-media-library` 包入口顶层 `class Asset extends ExpoMediaLibraryNext.Asset`，web 端 `requireNativeModule` 空壳 → `Class extends value undefined`。新建 `src/lib/media.web.ts`（Expo 平台扩展，Metro web 优先解析）+ `src/lib/__tests__/media.web.test.ts`（2 用例，web 存根契约与 media.ts 一致）。修复后 Android/iOS/Web 三端 bundle + 17 条静态路由全部导出至 `dist/`。

**数字**

- `npx tsc --noEmit`：0 错误
- `npx expo lint`：0 错误 0 警告
- `npx jest --coverage`：41 套件 **798 用例**全过；覆盖率 Stmts 95.00 / Branch 89.33 / Funcs 97.01 / Lines 95.54（门禁 ≥80 全过）
- `npx expo export`：exit 0（三端 bundle + 17 静态路由）

**已知既有现象（非本次引入）**

- 导出日志 4 条 `expo-file-system is not supported on web` console.warn：profile 页 `estimateCacheBytes()` web 预渲染调用所致，代码已有 try/catch 兜底按 0 计。
- jest 输出含既有的 react-query「Query data cannot be undefined」与 `act(...)` 控制台提示，测试全绿。

---

## 2026-08-15 · M30 里程碑回归（对话助手附图：用户上传图片随消息发送）

**目的**：对话助手输入条新增「图片」ghost 钮（ImagePlus，语言对齐 M20 文档钮）——点击 → `expo-image-picker` 相册选 1 张 → 客户端先验（jpg/png/webp ≤20MB，与后端 upload.py 白名单同源）→ 选图即传 `uploadImage(img2img)` 换 `{filename,worker}` 句柄（chip 转 loading）；输入区上方图片 chip（本地缩略预览 + 文件名，ready 态 X 移除、上传中无 X 规避取消竞态）；发送体带 `image={filename,worker}`（可与 `document_ids` 同发），chip 清空转移到本条 user 气泡本地展示。仅 1 张（后端单 image 契约），已有 chip 再选 = 替换。全程 TDD（每块先红后绿）。

**契约要点（已读后端源码与 Expo v57 文档确认）**

- 上传：复用既有 `uploadImage(image, 'img2img')`（`POST /api/upload?kind=img2img` 无能力门槛，落 pool worker input 目录，edit_image/generate_3d 工具可达），返回 `{filename,worker}`。
- 发送：`POST /api/agent/chat` 的 `ChatRequest.image={filename,worker}`——runner 注入 system 提示并把 attachment 传给 edit_image/generate_3d 工具，从 worker input 目录读字节；可与 `document_ids` 同发。
- **已知限制（后端契约现状）**：后端用户消息落库不含 attachment，会话回放时历史气泡无图——本会话内本地展示（picker 本地 uri 缩略图）即可，不重拉服务端。
- 选图：Expo v57 `ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 })`（docs.expo.dev/versions/v57.0.0/sdk/image-picker 复核；`MediaTypeOptions` 已废弃，用字符串数组新 API）。
- 客户端先验与后端 upload.py 三重校验同源：扩展名白名单 jpg/jpeg/png/webp（gif 不收）+ 20MB 上限，fileName 缺省按 mimeType 推断。

**改动清单**

- `src/features/assistant/attachment-utils.ts`（新）：纯函数层——状态机 `startUpload`（选图即传，替换语义直接覆盖旧态）→ `applyReady`（落句柄，previewUri/name 继承）；`chipFor` 展示模型 / `attachmentBusy`（发送禁用语义）；`imageForRequest`（仅 ready 带 `{filename,worker}`）；`validatePickedImage` / `pickedImageName`；持久化 `attachmentKeyFor`（挂 `assistant_draft:` 前缀 `:image` 后缀，随输入草稿同前缀按会话隔离）+ `serializeAttachment`（仅 ready 落盘，uploading 瞬态不持久化）/ `parseAttachment`（畸形/缺字段一律 null，恢复即 ready 不重复上传）+ `save/load/clearAttachment`（null 等价清除不留占位键，语义对齐 saveDraft 空串）。
- `src/types/api.ts`：+`AgentChatImage{filename,worker}`。
- `src/lib/api.ts`：`agentChatStream` params +`image`，请求体按需注入（与 session_id/document_ids 同规则，缺省省略字段）。
- `src/features/assistant/chat-utils.ts`：`ChatItem` +`image?: ChatImageRef{previewUri,name}`（user 气泡本地展示数据源）。
- `src/features/assistant/assistant-screen.tsx`：composer 文档钮后 +图片 ghost 钮（`assistant-image`，`accessibilityState.disabled = streaming || imageBusy`、`selected = 有 chip`，激活 accent 高亮）；`pickImage` 选图即传（取消/先验失败保留旧 chip；上传失败移除 chip + 内联人话 `assistant-image-error`，最小实现非错误态重试，重选即重试）；chip 渲染（`assistant-image-chip`/`-thumb`/`-loading`/`-remove`，渲染前单次预计算 `imageChip`/`imageBusy`）；`send` 快照 roundImage → `imageForRequest` 随轮上行 + chip 清空（草稿键即时清除）+ user 气泡 `item.image` 本地缩略图（`msg-local-*-attachment`，148×148，expo-image recyclingKey）；会话切换渲染期回填 `loadAttachment(sessionId)`（`applyAttachment` 统一入口：即时落盘无防抖 + 仍是当前会话才刷 UI，防跨会话竞态）；发送键禁用态接入 `imageBusy`（上传中禁发，句柄未就绪发送会丢图）。
- `src/components/ui/Icon.tsx`：`ImagePlus` 复用 M28 已注册项，无新增。
- 测试：`attachment-utils.test.ts`（新）+11；`api.test.ts` M30 块 +2；`assistant-screen.test.tsx` M30 块 +10。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest
Test Suites: 40 passed, 40 total
Tests:       796 passed, 796 total
```

- 较 M29 口径（39 套件 773 用例）净增 +1 套件 +23 用例；lib/stores 覆盖率门禁（四项 ≥80%）持续达标。

**本里程碑新增测试与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| `attachment-utils.test`（新） | +11 | 状态机 startUpload/replace 语义、applyReady 句柄继承；chipFor 三态（uploading 无 X/ready 可 X/null 无 chip）；attachmentBusy 仅上传中；imageForRequest ready 带图/上传中·null 不带；validatePickedImage 白名单（gif 拒/>20MB 拒/合法通过/fileName 缺省按 mime 推断）；pickedImageName 缺省 `upload.<ext>`；serialize/parse 往返（uploading 不落盘）；parse 防御（空串/畸形 JSON/缺字段 null）；键挂 `assistant_draft:` 前缀；save/load/clear 按 sessionId 隔离、null 等价清除 |
| `api.test`（M30 块） | +2 | image 注入 `body.image`（{filename,worker} 随轮上行）；image 与 document_ids 同发、缺省不带 image 字段 |
| `assistant-screen.test`（M30 块） | +10 | 图片 ghost 钮渲染+选图即传（picker 入参/uploadImage img2img 三段式）→ chip 缩略图+文件名+钮激活态；上传中 chip loading 无 X、发送键与图片钮双禁用、完成恢复；发送 image 随轮上行（与 document_ids 同发）+ chip 清空 + 草稿键清除 + user 气泡本地展示；无附图 image undefined；X 移除 chip+草稿键清除+发送不带图；替换重传新句柄随发；上传失败 chip 移除+内联人话；picker 取消静默+gif 先验拦截不上传；流式 busy 图片钮禁用停止恢复；附图句柄随草稿按会话隔离持久化（载入历史会话 chip 清空、回新会话恢复不重复上传） |

**踩坑记录**

1. **上传中 chip 无移除钮（规避取消竞态）**：X 取消上传需要 AbortController 贯穿 picker→upload 链路，复杂度收益不成比；最小实现为上传中仅 loading 不可点，失败自动移除 chip + 人话（重选即重试），测试钉死该语义。
2. **跨会话竞态守卫**：选图上传是异步链路，上传返回时用户可能已切会话——`applyAttachment(sid, next)` 统一入口先落盘（按动作发起时的 sid），仅当 `sessionIdRef.current === sid` 才刷 UI；会话切换走渲染期条件调整（同 detailData 回填模式）回填目标会话已存句柄。
3. **替换语义免额外动作**：后端单 image 契约仅 1 张，已有 chip 再选 = 新 `startUpload` 直接覆盖旧态（含旧 ready 句柄），无需 attach/replace 分支动作；纯函数层以「调用方覆盖赋值」语义测试钉死。
4. **chipFor 单次预计算**：渲染分支多处消费 chip 模型（显隐/padding/缩略图/label/loading 分支），渲染前一次 `const imageChip = chipFor(attachment)` 收口，避免 JSX 内重复调用（TS 窄化红利：`imageChip.uploading` 免可选链）。

---

## 2026-08-15 · M29 里程碑回归（作业进度 SSE 化（会话内））

**目的**：本次会话刚提交的作业（`GenerateResponse` 含 `prompt_id+client_id+worker`，`JobItem` 不含 → 凭据仅存内存不持久化）经 `GET /api/jobs/{prompt_id}/events` SSE 推确定性进度（value/max 百分比进度条 + 质量提示 + 错误人话）；其余作业仍走既有 2s 轮询兜底，行为不回退。三段式：会话内凭据登记（纯函数 registry）→ FSM 消费层（streamJobEvents）→ 追踪屏接入（进度条/done/error/quality_warning/生命周期 abort）。全程 TDD（每块先红后绿）。

**契约要点（已读 apps/api/app/routes/jobs.py L380 源码与 Expo v57 文档确认）**

- 端点 `GET /api/jobs/{prompt_id}/events?client_id=&worker=`（sse_starlette EventSourceResponse）；事件帧 `event: progress|done|error|quality_warning`，data 为 JSON：progress `{value,max}`、done `{images:urls}`（产物相对路径数组）、error `{message}`（后端人话）、quality_warning（视频质量评估，done 前推、不阻塞 done）；保活为注释行（`: ping`），`parseSseStream` 天然忽略。
- 401/403 属立即终止语义（凭据失效/跨租户无权）——expo/fetch 直取 `res.status`，无需 Web 的探针迂回。
- 载体复用既有 SSE 基建 `src/lib/sse.ts`（expo/fetch ReadableStream + 自研 UTF-8 跨块解码，RN 无原生 EventSource）；token 走 query + Authorization 头双通道（对齐 watchAgentRunEvents / api.ts ~L771/~L1013 既有模式）。
- 会话内限制：凭据只在模块级 Map 内存登记，列表/重启后的作业（JobItem 无 client_id/worker）不可 SSE，2s 轮询原样保留兜底。

**FSM 语义（移植 Web trackJob 2.0 简化版，勿照抄 Web 专有探针）**

- `connecting → streaming`；业务 done/error 即终态收流；外部 signal 中止 → 静默 `'aborted'`。
- 看门狗 60s 无业务事件判假死主动重连：**streaming 假死软重连**不计失败立即重建；**connecting 挂死**按连接失败计入退避。
- 重连 500ms 快照窗：窗口内与断线前末帧同负载的 progress/quality_warning 判回放重复丢弃。
- 连续连接失败 ≥3（固定 1s 退避）→ `'fallback'`（调用方回退既有轮询）；401/403 → 立即终止 `'auth'`。
- 分派防御：progress 仅 `max>0` 回调（`pct=min(100, round(value/max*100))` 整数）；单帧坏 JSON 跳过不中断整条流；error 帧缺 message 兜底「生成出错」。

**改动清单**

- `src/features/jobs/job-sse-registry.ts`（新）：纯函数模块级 `Map<promptId,{clientId,worker}>`——`registerJobSseCreds`（提交写入，重提交覆盖）/`getJobSseCreds`（未登记 null）/`clearJobSseCreds`（终态清除幂等）/`resetJobSseRegistry`（会话级清空）；无 IO 无网络。
- `src/lib/job-events.ts`（新）：`streamJobEvents(creds, handlers, options)` 全 FSM 实现（看门狗/快照窗/退避/双通道 token/everConnected 冷启动分级）；导出 `JobProgress`/`JobQualityWarning`/`JobStreamEnd` 类型。
- `src/features/jobs/job-tracker.tsx`：凭据命中且轮询非终态才建流（轮询先到终态清凭据不建流，防 SSE 重复 invalidate/震动）；running 且 progress 时确定性进度条（百分比 display 字号 accent + 220×6 轨道 accentSoft/accent 填充，`tracker-progress-pct/bar`）保留「生成中」标签，无 progress 仍不确定指示；quality_warning → warning 色温和提示（`tracker-quality-warning`，不阻断舞台）；SSE error → effStatus 失败舞台 + 后端人话优先于通用文案；done → Haptics Success + `invalidateQueries(['jobs'])`（列表/作品库同根全覆盖）+ 清凭据；auth/fallback/aborted 静默回退轮询；组件卸载/AppState 退后台 → AbortSignal 断流（对齐 agent-run-detail 清理写法），回前台轮询兜底。
- `src/features/generate/generate-screen.tsx`：提交 onSuccess `registerJobSseCreds(res)` 登记凭据。
- `src/features/jobs/jobs-screen.tsx`：失败重试 onSuccess 同样登记（重试产新 prompt_id 可被 SSE 追踪）。
- `src/stores/auth.ts`：signOut `resetJobSseRegistry()`（凭据不跨会话残留）。
- 测试：`job-sse-registry.test.ts`（新）+7；`job-events.test.ts`（新）+14；`job-tracker.test.tsx` M29.3 块 +9；`generate-screen.test.tsx` +1；`jobs-screen.test.tsx` +1；`auth.test.ts` +1。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 39 passed, 39 total
Tests:       773 passed, 773 total

File            | % Stmts | % Branch | % Funcs | % Lines |
----------------|---------|----------|---------|---------|
All files       |   94.99 |    89.28 |   96.96 |   95.52 |
  job-events.ts |   96.06 |    88.73 |      90 |   97.43 |
  sse.ts        |     100 |    80.76 |     100 |     100 |
```

- 较 M28 口径（37 套件 740 用例）净增 +2 套件 +33 用例；覆盖率四项 ≥80% 阈值达标且与 M28 持平。

**本里程碑新增测试与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| job-sse-registry.test（新） | +7 | 登记取回/未登记 null/重复登记覆盖（重提交语义）/多作业并存互不影响/终态清除后取 null 且其余保留/清除未登记项幂等/reset 清空全部（登出语义） |
| job-events.test（新） | +14 | URL·请求头契约（client_id/worker/token query + Authorization + Accept）；progress 分派 pct 换算且 max<=0 不派发；done 收产物 urls 终态 resolve；error 透传后端 message 终态；quality_warning 透传不阻塞后续 done；坏帧跳过流不断；401/403（it.each 双状态）onAuthError + 立即终止不重连；HTTP 500 连续失败超限 → fallback（默认上限 3）；看门狗 streaming 60s 无事件软重连不计失败；connecting 挂死计失败超限 fallback；快照窗 500ms 同负载丢弃/新负载透传/窗口外恢复；开始前已 aborted 不发请求；流中途外部 abort 静默不重连 |
| job-tracker.test（M29.3 块） | +9 | 未登记凭据 running 不建流（轮询兜底不回退）；登记后按 promptId/clientId/worker 建流携带 AbortSignal；progress 渲染确定性百分比+进度条（保留生成中标签）；done 成功震动+失效 jobs 查询+清凭据；error 后端人话+失败舞台+错误震动+清凭据；quality_warning 温和提示不阻断舞台；卸载中止流（落定 aborted）；App 退后台中止流；轮询先到终态清凭据不建流 |
| generate-screen.test | +1 | 提交成功登记会话内 SSE 凭据（p-m29 → {clientId,worker}） |
| jobs-screen.test | +1 | 失败重试成功登记凭据（新 prompt_id 可被 SSE 追踪） |
| auth.test | +1 | signOut 清空 registry（凭据不跨会话残留） |

**踩坑记录**

1. **React 19 异步 act 队列（同 agent-run-detail emit 模式复防）**：测试驱动 SSE 回调（onProgress/onDone/…）或触发卸载/AppState 清理时，状态更新必须 `await act(async () => { ... })` 包裹，否则断言打到未刷新的旧树；挂载后 effect 建流断言前同样需 flush——M29.3 块封装 `emit()` 辅助统一收口。
2. **轮询与 SSE 竞态守卫**：轮询先落终态时须清凭据且不建流，否则 SSE 会对已终态作业重复 invalidate/震动；实现以轮询态为准（凭据命中且非终态才建流），专设「轮询先到终态」用例防回归。
3. **看门狗分级计策**：connecting 挂死（计连接失败进退避）与 streaming 假死（软重连不计失败）必须区分，混一谈会导致弱网冷启动瞬间打满失败计数误回退轮询。
4. **expo/fetch 直取状态码红利**：401/403 在 RN 侧无需 Web trackJob 的探针迂回（Web EventSource 拿不到状态码），`res.status` 直判即立即终止，FSM 因此比 Web 版少一层探针态。

---

## 2026-08-15 · M28 里程碑回归（作品库↔资产库联动：产物一键存为资产）

**目的**：产物详情操作区新增「存为资产」入口（仅 image 类产物渲染，资产卡只收图片）——点击 → 下载 mediaUrl 产物到缓存 → `uploadImage(fileUri, 'img2img')` 换服务端句柄 → `router.push` 资产编辑屏 `/assets/edit` 带 prefill 参数（encodeURIComponent JSON：images 句柄 + 产物 mediaUrl 预览 + 建议名 + nsfw）；资产编辑屏新建态消费 prefill 预填（可改名/选类别/补图后走既有 createAsset），编辑态忽略、解析失败静默。资产→创作反向联动已由 asset-picker 覆盖，本里程碑仅做产物→资产单向。

**契约要点（已读 Expo v57 官方文档与既有代码确认）**

- 下载链路复用 M25：`expo-file-system` v57 `File.downloadFileAsync(url, new File(Paths.cache, name))` 静态方法落缓存（docs.expo.dev/versions/v57.0.0/sdk/filesystem 复核）——`lib/media.ts` 抽出 `downloadToCache(url)` 返回 file URI（不碰相册权限），`downloadAndSaveToLibrary` 重构复用且行为不变（错误顺序仍先下载失败后权限）。
- 上传走既有 `uploadImage(image, kind)`（`POST /api/upload?kind=img2img` 无能力门槛，落点任意 pool worker；`ASSET_UPLOAD_KIND` 常量复用）。
- expo-router params 只支持字符串：prefill = `encodeURIComponent(JSON.stringify(...))`；编辑屏 `useLocalSearchParams` 读取，解析失败静默忽略。
- 建议名：作业 prompt 去全部空白后按码点取前 12 字（`Array.from` 防代理对截断），空兜底「作品资产」；预填 preview 用产物 mediaUrl（资产未创建前 `assetImageUrl` 不可用）。

**改动清单**

- `src/features/assets/asset-prefill.ts`（新）：纯函数 `suggestAssetName` / `buildAssetPrefillParam` / `parseAssetPrefill`（防御：非串/畸形 JSON/非对象/images 缺失或空/缺 filename·worker 返回 null，缺 name/preview/nsfw 给安全默认）。
- `src/lib/media.ts`：+`downloadToCache`；`downloadAndSaveToLibrary` 复用重构（无行为变化）。
- `src/features/library/artifact-detail.tsx`：isImage 时操作行下载与删除之间 +48x48 图标钮（ImagePlus），busy/disabled/opacity 0.5 与下载钮同态；`saveAsAsset` 流程成功 Haptics Success + push prefill，失败 Haptics Error + 内联人话错误（`detail-save-asset-error`）停留原页；换作业重置反馈态。
- `src/features/assets/asset-edit-screen.tsx`：params 加 `prefill`；新建态渲染期条件调整消费一次（同 detailData 回填模式）预填 images/name/nsfw；编辑态忽略；createAsset 流程不动。
- `src/components/ui/Icon.tsx`：注册表 +`ImagePlus`。
- 测试：`asset-prefill.test.ts`（新）+10；`media.test.ts` +2；`artifact-detail.test.tsx` M28 块 +6；`asset-edit-screen.test.tsx` M28 块 +4。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 37 passed, 37 total
Tests:       740 passed, 740 total

File           | % Stmts | % Branch | % Funcs | % Lines |
---------------|---------|----------|---------|---------|
All files      |   94.71 |    89.38 |   97.54 |   95.01 |
  media.ts     |     100 |       75 |     100 |     100 |
```

- 较 M27 口径（36 套件 718 用例）净增 +22 用例（套件 +1：asset-prefill.test；纯函数 10 + media 2 + 详情 6 + 编辑屏 4）；覆盖率四项 ≥80% 阈值达标且与 M27 持平。

**本里程碑新增测试与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| asset-prefill.test（新） | +10 | 建议名截断 12 字/空白先去除再计字/空·纯空白·null·undefined 兜底；build 编码结构（images/name/nsfw）；往返还原；parse 空·非串·畸形 JSON·非对象 null、images 缺失/空数组 null、缺 filename/worker null、缺 name/preview/nsfw 安全默认 |
| media.test | +2 | downloadToCache 成功返缓存 URI（剥 query 取文件名）不碰相册权限、下载失败抛「下载失败」 |
| artifact-detail.test（M28 块） | +6 | image 渲染入口、video 不渲染；点击成功流（downloadToCache 拼 token URL → uploadImage img2img → push /assets/edit prefill 结构断言）；多产物切第 2 张 preview 对应该张；下载失败/上传失败内联提示不跳转 |
| asset-edit-screen.test（M28 块） | +4 | 新建带 prefill 预填（名称/图片计数/缩略图预览 uri/nsfw 开关 + 不发单查）；直接保存走 createAsset 且 images 含预填句柄；畸形 prefill 静默按空白表单；编辑模式（id+prefill）忽略 prefill 回显 getAsset |

**踩坑记录**

1. **跨 describe mock 泄漏（M27 同坑复防）**：M28 新 describe 与既有 describe 平级，自带 beforeEach `jest.clearAllMocks()` + 对 `mockDownloadToCache`/`mockUploadImage`/`mockGetAsset` `mockReset()` 链式重设默认实现（clearAllMocks 不清实现，防 deferred 泄漏）。
2. **中文字符串计字自坑**：建议名截断用例的手写期望多数了一个字（「十一十二」为 4 字），实现按码点 `Array.from().slice(0,12)` 正确，修正测试期望——TDD 红灯先验的是测试自身。

---

## 2026-08-15 · M27 里程碑回归（资产库批量管理：多选模式 + 批量删除）

**目的**：资产库（M13 参考资产列表屏）补齐与作品库 M25 对齐的批量管理能力——长按卡片或页头「选择」进入多选模式（卡片左上选择圈 + accent 细边框描边，进入时清空既有选择集）；底部批量操作条「已选 N 项」/全选/删除（danger，N=0 禁用）/取消；批量删除走二次确认 Alert → 并发限速 ≤3 循环单删 → 失败项保留勾选；切 kind 过滤/下拉刷新清空并退出多选。

**契约要点（已读 apps/api 源码与 types/api.ts 确认）**

- `DELETE /api/assets/{asset_id}` 仅单删，**后端无批量端点**——批量 = 客户端循环单删，复用 `features/library/batch-utils.ts` 的 `runBatchLimited`（并发上限 `BATCH_CONCURRENCY=3`，签名未动）防打爆后端，单项失败不中断，成败 id 收集汇总。
- **「批量打标」不可行（约束记录）**：后端 `ReferenceAsset` 模型仅 `kind/name/description/images/nsfw` 五字段（见 `types/api.ts` `AssetItem` 与 `lib/api.ts` M13 资产库区注释），**无 tags 字段**，批量打标无处落库，本期不做。
- 删除确认文案对齐 asset-edit 单删语义：「删除 N 项资产？删除后不可恢复（worker 上的图片文件保留）。」——后端单删仅删数据库记录，worker 磁盘上的图片文件保留。
- 删除成功 `invalidateQueries(['assets'])` 前缀失效重取；失败项保留勾选供重试，无剩余勾选自动退出多选。

**改动清单**

- `src/features/assets/assets-screen.tsx`：多选状态（`selecting`/`selectedIds`/`batch` 进度/`batchSummary`）；头部常态「新建 + 选择」并排、选择态双双隐藏（对齐作品库头部布局切换）；`AssetCard` 图片区左上选择圈（未选空心半透明底白描边/已选 accent 实心 + Check 图标）+ 已选 accent 细边框 + `accessibilityState.selected`，选择态下 onPress 切换勾选而非跳编辑，批量进行中点按/长按冻结；长按卡片（delayLongPress 300，守卫无）直接进入并选中该卡；切 kind 过滤/下拉刷新清空并退出；底部操作条（Screen 底边 SafeArea 已避让，样式对齐作品库 M25）「已选 N 项」/全选/删除（danger，N=0 禁用）/取消，进行中显示「删除中 x/N」且全钮禁用防重复点；删除走 Alert 二次确认 → `runBatchLimited(deleteAsset)` → 失效重取 → 成功项移出选择集、失败项保留勾选、无剩余退出；汇总内联于过滤行下方（`summarizeBatch` delete 文案复用：全成「已删除 N 项」/部分「成功 N 项，失败 M 项，失败项已保留勾选」）；进出选择态/勾选/全选/删除触发 Haptics Light（沿用本屏既有触感惯例）；主题 token 全覆盖，无硬编码新色值（既有 #FFFFFF/rgba(0,0,0,0.55) 沿用现状）。
- `src/features/library/batch-utils.ts`：复用 `toggleSelect`/`selectAllIds`/`runBatchLimited`/`summarizeBatch`，**未改签名**，既有 batch-utils.test 不重测。
- `src/features/assets/__tests__/assets-screen.test.tsx`：M27 块 +8 用例（无新套件）。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 36 passed, 36 total
Tests:       718 passed, 718 total

File           | % Stmts | % Branch | % Funcs | % Lines |
---------------|---------|----------|---------|---------|
All files      |   94.69 |    89.38 |   97.52 |   94.98 |
  api.ts       |   91.15 |       84 |   98.52 |   91.58 |
```

- 较 M26 口径（36 套件 710 用例）净增 +8 用例（无新套件，均为 assets-screen 屏用例）；覆盖率四项 ≥80% 阈值达标且与 M26 持平。

**本里程碑新增测试与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| assets-screen.test（M27 块） | +8 | 「选择」钮进入（操作条出现、头部入口隐藏、点卡勾选而非进编辑、再点取消勾选模式保持）；长按进入并选中该卡（accent 描边 + 左上 Check，兼容函数/对象/数组 style 断言）；取消退出清空且头部恢复；全选 3 项 + N=0 删除禁用；切 kind 过滤清空退出；删除全成（Alert 契约含数量与 worker 文件保留声明 → 循环单删 → invalidate `['assets']` 失效重取 → 汇总退出）；部分失败（失败项保留勾选停留选择模式、成功项移出）；进度态「删除中 x/N」三钮禁用防重复点 |

**踩坑记录**

1. **跨 describe 的 mock 泄漏**：M27 describe 与 M13.2 describe 平级，外层 beforeEach 的 `jest.clearAllMocks()` 不覆盖 M27 块内用例，其他 describe 的 `mockPush`/`mockImplementation` 会泄漏进 M27 用例（如点卡断言 push 未被调用却读到历史调用）；M27 自身 beforeEach 须补 `jest.clearAllMocks()` + 对 `mockListAssets`/`mockDeleteAsset` 双 `mockReset()`（清调用记录且清实现，防 deferred 泄漏）。
2. **选择态下点卡须拦截编辑跳转**：`AssetCard` onPress 在选择态下切换勾选而非 `router.push` 进编辑——测试断言「点卡勾选而非进编辑」可防该守卫被回归移除。

---

## 2026-08-15 · M26 里程碑回归（设置页完善：关于 + 清理缓存 + 导出诊断）

**目的**：设置页补「关于」分组（置于高级区后）——「关于 ToIV」弹层（产品名/版本/定位文案/版权行）版本号行副标题直显；「清理缓存」白名单保护（保留登录态/设置/对话草稿，仅清 cache 目录临时下载文件 + MMKV 非白名单键）Alert 二次确认 + 释放量内联反馈；「导出诊断信息」脱敏 JSON（无 token/无存储值）复制剪贴板。

**契约要点（已读 Expo v57 官方文档确认）**

- `expo-file-system` v57 新 API：`new Directory(Paths.cache).size` / `dir.list()` / `item.delete()` 均为**同步**调用（与 lib/media.ts 的 File/Paths 用法同源）；逐项删除保留目录本身，单项失败跳过不中断。
- `expo-constants`：`Constants.expoConfig?.version` / `?.name` 为 v57 推荐版本读取方式（替代 expo-application nativeApplicationVersion，无需原生模块）。
- `expo-device`：`Device.modelName` 设备型号；`expo-clipboard`：`Clipboard.setStringAsync` 复制诊断 JSON。
- 白名单锚点：`toiv.settings`（zustand persist：主题/色板/API 覆盖/NSFW）+ `toiv.cachedUser`（登录态快照）exact 匹配 + `assistant_draft:` 前缀（M24 对话草稿）；token 存 expo-secure-store 不在 MMKV，天然不在清理范围。

**改动清单**

- `src/features/profile/settings-utils.ts`（新）：纯函数层 `formatBytes`（<1KB 取整 `{n} B`，KB/MB/GB 一位小数，负数/NaN 归 0）/ `planCacheClear(keys, whitelist)`（exact+prefixes 白名单分组将删/将留，不改入参）/ `estimateCacheBytes`（cache 目录大小 + MMKV 非白名单键值合计，目录不可读按 0）/ `clearCache`（逐项删 cache 内容 + 移除非白名单键，单项失败跳过且不计入释放，返回释放字节）/ `buildDiagnostics`（app/device/config/storage/generatedAt 五区，osVersion 字符串化，totalBytes 键大小合计）/ `collectStorageKeyStats`（仅键名+大小不透值）；`CACHE_CLEAR_WHITELIST` 常量导出。
- `src/features/profile/profile-screen.tsx`：「关于」分组三行（SettingsRow + Info/Trash2/Share2 图标）；「关于 ToIV」行副标题 `v${APP_VERSION}` 直显 → Modal fade 弹层（产品名 ToIV / 版本 / 定位「一个工作台，装下图像、视频与数字人的完整创作流程。」对齐主站落地页 / © 2026 ToIV / 关闭钮）；「清理缓存」行副标题 `占用 ${formatBytes(cacheBytes)}` → Alert 二次确认（文案声明保留登录/设置/对话草稿，destructive 钮）→ `clearCache()` → 重估 + 内联「已清理 N」；「导出诊断信息」→ `buildDiagnostics`（expoConfig name/version、Platform.OS/Version、Device.modelName、PixelRatio.get()、resolveApiBase()、signedIn 布尔、nsfwIntent、collectStorageKeyStats()、时间戳）→ `Clipboard.setStringAsync(JSON.stringify(diagnostics, null, 2))` → 内联「诊断信息已复制」/「复制失败，请重试」。
- `src/components/ui/Icon.tsx`：注册表 +`Info`/`Trash2`/`Share2`。
- `src/features/profile/__tests__/settings-utils.test.ts`（新）：+16 用例。
- `src/features/profile/__tests__/profile-screen.test.tsx`：M26 块 +7 用例。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 36 passed, 36 total
Tests:       710 passed, 710 total

File           | % Stmts | % Branch | % Funcs | % Lines |
---------------|---------|----------|---------|---------|
All files      |   94.69 |    89.38 |   97.52 |   94.98 |
  api.ts       |   91.15 |       84 |   98.52 |   91.58 |
```

- 较 M25 口径（35 套件 687 用例）净增 +23 用例（套件 +1：settings-utils.test；纯函数 16 + 屏 7）；覆盖率四项 ≥80% 阈值达标。

**本里程碑新增测试与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| settings-utils.test（新） | +16 | formatBytes：0/负数/NaN 归一 0 B、不足 1KB 取整直显、KB/MB/GB 档一位小数；planCacheClear：exact+前缀保留其余待删、前缀仅开头匹配、不改入参空进双空出、白名单契约锚点固定（settings/cachedUser/assistant_draft:*）；estimateCacheBytes：目录+非白名单键合计且白名单不计、目录 size 为 null/读目录抛错按 0 不抛出；clearCache：逐项删 cache+移非白名单键且白名单保留返回释放字节、单项删除失败跳过不中断且失败项不计入、目录不可读仍清 MMKV 键；buildDiagnostics：五区形状与字段映射 osVersion 字符串化、totalBytes 键大小合计设备型号 null 透传、脱敏（序列化产物无 token/无存储值，存储区仅键名+大小）；collectStorageKeyStats：仅键名+值大小不透值本体 |
| profile-screen.test（M26 块） | +7 | 关于行版本号副标题直显；点开弹层（产品名/定位文案/版权行）关闭后消失；清理行副标题估算占用（cache 目录 + 非白名单 MMKV 键）；点清理弹 Alert 文案声明保留登录/设置/对话草稿；确认清理（非白名单键删除 + cache 项删除、白名单 settings/cachedUser/assistant_draft 三项保留、内联「已清理 105 B」）；取消清理键与缓存原样无反馈；导出诊断剪贴板 JSON 五区形状齐备且脱敏（无 token/无存储值/无邮箱） |

**踩坑记录**

1. **RNTL 14 的 `act` 导入源**：须从 `@testing-library/react-native` 导入；从 `react-native` 导入会抛 `act is not a function`（RN 0.86 侧已移除该导出）。
2. **`fireEvent.press` 触发异步链须 await**：点按行触发的 Clipboard/状态落盘是异步的，不 await 直接断言会抢跑（读不到内联反馈文案）；同因 Alert 按钮回调须包 `await act(async () => ...)`。
3. **Mock 类空构造器触发 lint 警告**：jest mock 的 `MockDirectory` 类写 `constructor(..._args: unknown[]) {}` 被 `no-useless-constructor` 判警告——mock 类无构造需求直接删除构造器即可。

---

## 2026-08-15 · M25 里程碑回归（作品库批量管理：多选模式 + 批量删除 + 批量保存相册）

**目的**：作品库补批量管理能力——长按卡片或页头「选择」进入多选模式（选择圈 + accent 细边框，选择集 Set<id> 跨分页保持，切桶/下拉刷新清空退出）；底部操作条全选/保存/删除/取消；批量删除走确认 Alert → 并发限速 ≤3 循环单删 → 失败项保留勾选；批量保存相册仅 image/video（audio/3D 跳过计入汇总），复用既有下载封装。

**契约要点（已读 apps/api/app/routes/jobs.py 源码确认）**

- `DELETE /api/jobs/{job_id}` 仅单删，**后端无批量端点**——批量 = 客户端循环单删，并发限速 ≤3（`BATCH_CONCURRENCY=3`）防打爆后端，单项失败不中断，成败 id 收集汇总。
- 删除成功 invalidateQueries `['jobs']` 前缀失效逐页重取；失败项保留勾选供重试，无剩余勾选自动退出多选。
- 保存相册仅 image/video 支持（audio/3D 跳过计数并保留勾选）；每项取首产物 `mediaUrl` 拼 token 循环走 lib/media.ts `downloadAndSaveToLibrary`（expo-media-library v57 官方文档复核：`File.downloadFileAsync` → `requestPermissionsAsync` → `Asset.create` 与既有封装一致）。

**改动清单**

- `src/features/library/batch-utils.ts`（新）：纯函数层 `toggleSelect`（返回新 Set 不改入参）/ `selectAllIds`（已加载拍平项全选）/ `splitSavable`（image/video 可保存，audio/3D 跳过计数，未知 kind 对齐卡片语义按图像处理）/ `summarizeBatch`（删除全成「已删除 N 项」/部分「成功 N 失败 M，失败项已保留勾选」；保存成败+跳过六态人话）/ `runBatchLimited`（工作池限速 BATCH_CONCURRENCY=3，失败不中断，onProgress 逐项回报 done/total）。
- `src/features/library/library-screen.tsx`：多选状态（`selecting`/`selectedIds`/`batch` 进度/`batchSummary`）；`LibraryCard` 右上选择圈（未选空心半透明底/已选 accent 实心 + Check 图标）+ 已选 accent 细边框 + `accessibilityState.selected`，克制动效仅 pressed opacity；页头「选择」钮与长按卡片两路进入；切过滤桶/下拉刷新清空并退出；底部操作条（Screen 底边 SafeArea 已避让）「已选 N 项」/全选/保存/删除/取消，进行中显示「删除中 x/N」「保存中 x/N」且全钮禁用、卡片点按/长按冻结；删除走 Alert 二次确认（「删除 N 项作品？删除后不可恢复。」对齐 asset-edit 惯例）→ `runBatchLimited(deleteJob)` → 失效重取 → 成功项移出选择集、失败项保留勾选、无剩余退出；保存 `splitSavable` 分流后循环 `downloadAndSaveToLibrary`；汇总内联于过滤行下方（模式内外均可见）。
- `src/features/library/__tests__/batch-utils.test.ts`（新）：+17 用例。
- `src/features/library/__tests__/library-screen.test.tsx`：M25 块 +12 用例。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 35 passed, 35 total
Tests:       687 passed, 687 total

File           | % Stmts | % Branch | % Funcs | % Lines |
---------------|---------|----------|---------|---------|
All files      |   94.69 |    89.38 |   97.52 |   94.98 |
  api.ts       |   91.15 |       84 |   98.52 |   91.58 |
```

- 较 M24 口径（34 套件 658 用例）净增 +29 用例（套件 +1：batch-utils.test；纯函数 17 + 屏 12）；覆盖率四项 ≥80% 阈值达标。

**本里程碑新增测试与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| batch-utils.test（新） | +17 | toggleSelect：未选加入/已选移除、返回新 Set 不改入参；selectAllIds：拍平项全入集、空列表空集；splitSavable：image/video/未知 kind 可保存且 audio/3D 跳过计数、全部不可保存时 savable 空 skipped 为总数；summarizeBatch：删除全成/部分失败、保存全成/含跳过/含失败与跳过/全跳过六态文案；runBatchLimited：并发 1 按序执行 + 进度逐项回报、同时在跑数不超上限、单项失败不中断且失败 id 收集、空输入不调 fn、并发上限常量 ≤3 契约 |
| library-screen.test（M25 块） | +12 | 「选择」钮进入（操作条出现、点卡片勾选而非打开详情）；长按进入并选中该卡（accent 细边框 + Check 标记，兼容函数/对象/数组 style 断言）；再点取消勾选计数回落模式保持；全选选中已加载全部；取消退出清空；切桶/下拉刷新清空退出；删除全成（Alert 文案契约 → 循环单删 → invalidateQueries(['jobs']) 失效重取 → 汇总退出）；删除部分失败（失败项保留勾选、成功项移出）；删除进度态「删除中 x/N」钮禁用；保存分流（image/video 保存、audio 跳过计汇总并保留勾选）；保存进度态「保存中 x/N」完成后汇总退出 |

**踩坑记录**

1. **Pressable 函数 style 在断言侧需全形态兼容**：`borderColor` 断言初版直接读 `props.style.borderColor`，遇函数形态抛 `props.style is not a function`；断言辅助需 `typeof s === 'function' ? s({pressed:false}) : s` 解析后再 `Array.isArray` 拍平取 `borderColor`——RNTL 侧 Pressable style 三种形态（函数/对象/数组）均可能出现。
2. **`jest.clearAllMocks()` 不清实现**：批量测试用 deferred promise 控制 `deleteJob`/`downloadAndSaveToLibrary` 时序，clearAllMocks 仅清调用记录不清 `mockImplementation`，导致下一用例继承上一用例的 deferred 泄漏（进度计数错乱）；改用 `mockReset()` 逐用例隔离实现与调用。

---

## 2026-08-15 · M24 里程碑回归（对话助手三期：分叉会话 fork + 媒体产物点开预览 + 输入草稿持久化）

**目的**：对话助手补三期交互——会话列表项「分叉副本」全量 fork 与回放消息长按「从此分叉」截断 fork（`POST /api/agent/sessions/{sid}/fork` → 跳新会话）；消息气泡图片/视频点开全屏 lightbox（多图翻页 / VideoView 原生控制条播放 / 保存相册）；输入草稿按 sessionId 持久化（MMKV），切换/重进回填、发送成功清空。

**契约要点（已读 apps/api/app/routes/agent.py fork_agent_session 源码确认）**

- `POST /api/agent/sessions/{sid}/fork`：body 可空或 `{at_message_id?: number}`；缺省全量复制，有值截断复制到该消息（含）；`at_message_id` 不在会话内 404 detail「消息不存在」；新会话继承源 title/nsfw；返回会话摘要 `{id,title,nsfw,created_at,updated_at,message_count}`。
- 回放消息才带服务端 id（`GET /api/agent/sessions/{sid}` messages `id:number` 升序）——仅这类消息可「从此分叉」，本轮新消息（本地 id）无分叉入口。

**改动清单**

- `src/lib/api.ts`：`forkAgentSession(sessionId, atMessageId?)`——atMessageId 缺省不带 body；sid 路径 encodeURIComponent；非 2xx 走 apiFetch 人话体系。
- `src/features/assistant/draft-utils.ts`（新）：纯函数层 `draftKeyFor/loadDraft/saveDraft/clearDraft`（key `assistant_draft:{sid}`，新会话 `__new__`，空串写等价清除）+ `useAssistantDraft` hook（300ms 防抖写，pendingRef 捕获输入时 sid 防串键；渲染期回填新会话草稿；`[sessionId]` effect + 卸载 cleanup 补写未落盘内容）。
- `src/features/assistant/media-preview.tsx`（新）：`MediaPreview`——Modal fade + 深色遮罩全屏；图片 FlatList pagingEnabled 翻页（contain + 页码胶囊 + 点按关闭）；视频 expo-video v57 `useVideoPlayer`+`VideoView` 原生控制条（读 v57 官方文档确认用法，与产物详情 VideoStage 同式）；「保存到相册」复用 lib/media.ts `downloadAndSaveToLibrary`，saving/saved/失败人话内联三态；target 保活保证淡出完整。
- `src/features/assistant/chat-utils.ts`：`ChatItem` +`srvId`（回放消息服务端 id，分叉契约入参），`mapSessionMessages` 填充。
- `src/features/assistant/assistant-screen.tsx`：`forkMutation`（成功 invalidateQueries 会话列表 + loadSession 跳新会话；失败人话内联 error 气泡）；回放消息气泡（`srvId` 存在才注入 onFork）长按 Alert 菜单「从此分叉」；MediaBlock 图片/视频卡接 onPreview（audio/model3d 保持纯展示卡）；输入框切换 `useAssistantDraft`（发送成功 clearDraft）；尾部挂 `MediaPreview`。
- `src/features/assistant/session-sheet.tsx`：列表项 +GitFork「分叉副本」钮（非破坏性免二次确认）→ `onFork` prop 上抛主屏。
- `src/components/ui/Icon.tsx`：注册表 +`GitFork`。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 34 passed, 34 total
Tests:       658 passed, 658 total

File           | % Stmts | % Branch | % Funcs | % Lines |
---------------|---------|----------|---------|---------|
All files      |   94.69 |    89.38 |   97.52 |   94.98 |
  api.ts       |   91.15 |       84 |   98.52 |   91.58 |
```

- 较 M23 口径（33 套件 640 用例）净增 +18 用例（套件 +1：draft-utils.test）；覆盖率四项 ≥80% 阈值达标。

**本里程碑新增测试与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| api.test（M24 块） | +4 | forkAgentSession：全量分叉 URL/POST/无 body/Authorization；截断分叉 body `{at_message_id}`；sid 路径编码；404「消息不存在」人话透传 |
| draft-utils.test（新） | +6 | draftKeyFor 键拼接（新会话 `__new__` 占位）；saveDraft/loadDraft 往返与覆盖写；空串写等价清除；clearDraft 移除键（清不存在键不报错）；按 sessionId 隔离；防抖间隔常量 300ms 契约 |
| assistant-screen.test（M24 块） | +8 | 列表「分叉副本」全量 fork（无 at_message_id）→ 列表失效重拉 → 跳新会话回放；回放消息长按 Alert 菜单 → 截断 fork at_message_id 契约上行 → 载入新会话；分叉 404 人话内联 error 气泡且原上下文保留（getSession 仅 1 次）；本轮新消息（无 srvId）长按不出菜单；图片第 2 张点开页码 2/2 → 保存 URL 拼 token 透传 downloadAndSaveToLibrary → 「已保存到相册」→ 关闭；视频卡点开 VideoView 页；音频卡无预览入口；草稿重进回填 + 防抖窗口内未落盘 + 300ms 后落盘；按 sessionId 隔离 + 切换会话补写未落盘内容 + 回切回填；发送成功清空新旧会话键与输入框 |

**踩坑记录**

1. **RNTL 14 没有 `fireEvent.longPress` 便捷方法**：长按须用通用形式 `fireEvent(el, 'longPress')`。`TypeError: fireEvent.longPress is not a function` 抛在 act 环境内会污染后续渲染，导致同文件其他用例连锁出现「waitFor 超时找不到回放文本」的假象——先修触发点再判断真伪失败。
2. **react-hooks/refs 规则禁止渲染期访问 ref**：`useAssistantDraft` 初版在渲染期会话切换分支里调 `flushPending()`（访问 timerRef/pendingRef）被 expo lint 判 error；重构为渲染期只做 `setLoadedSid`+`setValue(loadDraft)` 纯回填，补写迁入 `[sessionId]` effect——pendingRef 捕获的是输入时的旧 sid，effect 落盘不串键，行为契约（切换补写）不变。

---

## 2026-08-15 · M23 里程碑回归（Agent 团队三期：计划编辑 POST /plan + 成片结果 GET /result）

**目的**：M22 裁决交互之上补齐三期——计划门抽屉升级为可编辑面板（改标题/主文案、删任务、加任务 → 先 `POST /api/agent-runs/{id}/plan` 再 resume modify；无改动直 resume approve），done 运行展示成片卡（`GET /api/agent-runs/{id}/result` → VideoView 原生控制条播放 + 保存相册），计划调整与成片交付全程无需回主站。

**契约要点（已读 apps/api/app/routes/agent_team.py edit_plan/run_result 源码确认）**

- `POST /api/agent-runs/{run_id}/plan`：body `{tasks: AgentPlanEditOp[]}`，`AgentPlanEditOp{id, action:'update'|'remove'|'add', title?, input?}`；仅 `awaiting_confirm` 可编辑（其余 409「仅待确认状态可编辑计划」，404「任务不存在:<id>」）。`update`：title 直改 / input 按键合并（不动未提交字段）；`remove`：服务端清理悬挂 depends_on；`add`：支持前端预生成 id，kind/depends_on 从 input 读（缺省 video/无依赖）。返回 `{run_id, plan.tasks}`。
- `GET /api/agent-runs/{run_id}/result`：仅 `done` 可取（其余 409「任务尚未完成」）；`final_url` 取 assemble done 卡 `output.url`（空串=合成产物缺失，前端静默不渲染）；`duration_sec` 为 video/image 卡 `input.duration_sec` 合计；`tasks` 供产物计数。

**改动清单**

- `src/types/api.ts`：`AgentPlanEditOp` / `AgentRunPlanUpdateResult` / `AgentRunResultTask` / `AgentRunResult`；`AgentResumeBody` 注释同步三期语义。
- `src/lib/api.ts`：`updateAgentRunPlan`（POST body `{tasks:ops}`，runId 双段编码，非 2xx 走人话体系）/ `getAgentRunResult`（GET 原样透传）；`resumeAgentRun` 注释补 M23 modify 用途。
- `src/lib/agent-run.ts`：`PlanDraft` / `EMPTY_PLAN_DRAFT` / `buildPlanOps`——语义逐条对齐 Web PlanPanel buildOps：removed 优先生成 remove（该任务 edits 一并忽略）；edits 生成 update（title 仅显式编辑带上；inputText 按 inputKey 缺省取 primaryInputText 主文案键合并进原 input）；added 生成 add（title trim 空回落「新任务」，input 固定 `{prompt}`，序在 update/remove 之后）；空草稿/幽灵 id → 空序列（确认门直投 approve 不走 POST /plan）。
- `src/features/agent-runs/agent-run-detail-screen.tsx`：计划门抽屉升级 `PlanGateEditor`（标题单行/主文案多行输入预填、行内移除、临时行 new-N 可加可移除、kind 中文名 + 依赖行「第 N 步」对齐 Web PlanPanel）；确认流 `submitPlanConfirm`：buildPlanOps 汇总 → 有改动先 POST /plan 再 resume(modify)、无改动直 resume(approve)；任一步失败抽屉保持打开、SheetError 人话内联、编辑痕迹保留可重试；任务全删空确认钮禁用；resume 成功清草稿并失效重查。done 成片卡 `ResultCard`：effStatus=done 时 useQuery 拉 GET /result（queryKey `agent-runs/result/runId`，retry:false；409 竞态与 final_url 空串静默不渲染）；VideoView 原生控制条（expo-video v57 useVideoPlayer + VideoView，读 v57 官方文档确认用法，与产物详情 VideoStage 同式，URL 走 mediaUrl 拼 token）；「保存到相册」复用 lib/media.ts `downloadAndSaveToLibrary`（expo-file-system 下载 cache → expo-media-library 入册），saving/saved/失败人话内联三态。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 33 passed, 33 total
Tests:       640 passed, 640 total

File           | % Stmts | % Branch | % Funcs | % Lines |
---------------|---------|----------|---------|---------|
All files      |   94.68 |    89.33 |    97.5 |   94.97 |
  agent-run.ts |   98.93 |    99.12 |     100 |   98.66 |
  api.ts       |   91.11 |    83.83 |    98.5 |   91.54 |
```

- 较 M22 口径（33 套件 614 用例）净增 +26 用例；覆盖率四项 ≥80% 阈值达标。

**本里程碑新增测试与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| api.test（M23 块） | +7 | updateAgentRunPlan：URL + body `{tasks:ops}` 契约 + Authorization + 返回 `{run_id, plan.tasks}`；runId 路径编码；409「仅待确认状态可编辑计划」人话透传；404「任务不存在」资源人话。getAgentRunResult：URL + 返回形状 `{final_url, duration_sec, tasks}` 原样透传；runId 路径编码 + final_url 空串合法值；409「任务尚未完成」人话透传 |
| agent-run.test（buildPlanOps 块） | +7 | 空草稿（EMPTY_PLAN_DRAFT/全空字段）→ 空序列；update 仅标题只带 title / 仅文案合并原 input 不动未提交键；inputKey 缺省取 primaryInputText 主文案键（prompt/script/无键回落 prompt）；显式 inputKey 优先于主文案键；remove 优先于 edits 痕迹忽略；add 空标题回落「新任务」+ input 固定 `{prompt}` + 序在 update/remove 之后；幽灵 id 忽略（以服务端计划为准遍历） |
| agent-run-detail-screen.test（M23 块） | +12 | 面板预填（标题/主文案主键值/依赖行「第 N 步」）+ 无改动 approve 不调 POST /plan；改标题文案 → ops[update×2] → resume(modify) → 关屉刷新；删+加 → ops[remove/add]（add 空标题回落，input 固定 {prompt}）；新增行可移除 + 全删空确认钮禁用；POST /plan 409 内联不关屉、resume 未调、痕迹保留；resume(modify) 失败内联不关屉；done → GET /result → 成片卡渲染（VideoView/时长/产物计数/保存钮）；final_url 空串不渲染；409 竞态静默不透出；保存成功「已保存到相册」禁重复；保存失败人话内联可重试；非 done 不拉 result |

**踩坑记录**

1. **planMutation 暂时性死区**：`submitGate` 回调引用了后方声明的 `planMutation`，触发 `ReferenceError: planMutation is not defined`；将 planMutation 声明前移至 submitGate 之前解决（hook 声明顺序即 TDZ 边界）。
2. **临时任务 id 必须在 setState 外捕获**：初版在 setState updater 内 `planAddSeq.current++`，updater 渲染期可能被重复执行而读到已自增的值，首个新增行 id 错成 `new-2`（测试断言 `gate-plan-row-new-1` 找不到）；改为 updater 外先捕获当前值再自增，id 生成稳定。

---

## 2026-08-15 · M22 里程碑回归（Agent 团队监控二期：确认门裁决 + 卡片干预）

**目的**：M21 只读监控 + 取消之上补齐二期交互——`POST /api/agent-runs/{id}/resume` 确认门裁决（计划门/合成门，approve/reject + 方向性批注）与 `POST /api/agent-runs/{id}/tasks/{tid}/action` 卡片干预（改文案/重生成/通过），移动端全程无需回主站。plan 编辑/upload/reprompt 后端 501，明确后置三期（待 R3.2）。

**契约要点（已读 apps/api/app/routes/agent_team.py resume_run/task_action 源码确认）**

- `POST /api/agent-runs/{run_id}/resume`：body `{gate:'plan'|'assembly', action:'approve'|'modify'|'reject', feedback?}`；plan 门仅 `awaiting_confirm`/`planning` 可投（其余 409），approve→running、reject→planning + feedback 落 error；assembly 门仅 `awaiting_assembly` 可投（其余 409），approve/reject 均回 running。
- `POST /api/agent-runs/{run_id}/tasks/{task_id}/action`：body `{action:'edit'|'regenerate'|'approve', payload?}`，**返回任务卡片顶层字段（无包装）**，前端用返回卡局部替换不重拉详情。`edit`：`payload={input:{...}}` 合并回 `pending`；`regenerate`：仅 `done`/`error`（409），`attempt≥3` 400，`assemble` 卡 400 走合成门，`payload.guidance` 拼主文案 attempt+1；`approve`：置 `approved`。

**改动清单**

- `src/types/api.ts`：`AgentResumeBody` / `AgentTaskActionBody`。
- `src/lib/api.ts`：`resumeAgentRun` / `agentTaskAction`（双段路径 encodeURIComponent，body 原样透传，非 2xx 走人话体系）。
- `src/lib/agent-run.ts`：`taskDurationSec`（合成门时间线合计时长）。
- `src/features/agent-runs/agent-run-detail-screen.tsx`：确认门横幅（awaiting_confirm→计划门 Layers「计划待确认」/ awaiting_assembly→合成门 Film「合成前确认」，accent 边框 + 「去裁决」CTA）+ 底部抽屉裁决（计划门：任务清单 + approve/reject + reject 批注输入；合成门：时间线时长列 + 合计时长）+ 卡片操作行（taskActionable 非 running/queued 且非 assemble 且 run 非终态：改文案 Pencil 抽屉预填主文案 / 重生成 RefreshCw 抽屉引导词透传 / 通过 Check success 色直提；成功返回卡局部替换不重拉详情，attempt 递增「第 N 次」；失败错误内联/落横幅人话透传）+ SSE confirm_required(gate=assembly) 就地开门不重拉。
- `src/components/ui/Icon.tsx`：注册表 +`Pencil`。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 33 passed, 33 total
Tests:       614 passed, 614 total

File           | % Stmts | % Branch | % Funcs | % Lines |
---------------|---------|----------|---------|---------|
All files      |   94.46 |    89.00 |   97.43 |   94.76 |
  agent-run.ts |   98.68 |    99.01 |     100 |   98.30 |
  api.ts       |   91.03 |    83.83 |   98.46 |   91.45 |
```

- 较 M21 口径（33 套件 595 用例）净增 +19 用例；覆盖率四项 ≥80% 阈值达标。

**本里程碑新增测试与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| api.test（M22 块） | +7 | resume URL/body 契约（gate/action/feedback）+ Authorization；feedback 缺省省略 + runId 路径编码；409 状态不符人话；action 双段路径编码 + body 透传；edit payload={input:{...}} 返回卡顶层无包装；regenerate guidance 透传 + 409 人话；400 合成卡走合成门人话 |
| agent-run-detail-screen.test（M22 块） | +12 | 计划门横幅→approve→resume(plan/approve)→抽屉关闭并刷新；合成门时间线（时长/合计）→批注打回→resume(assembly/reject/feedback)；SSE confirm_required 就地开门；裁决失败内联不关闭；操作行可见性矩阵 ×4（pending 无重生成/done 出重生成/assemble 卡与终态 run 不出操作行/approved 卡隐藏通过）；改文案预填→edit 契约→局部替换不重拉；重生成引导词透传/空引导词省略 payload；通过直提 approved 局部替换；approve 409 错误落横幅 |

**踩坑记录**

1. **跨用例污染**：M22 块初版双 render 用例（先 awaiting_confirm 再 awaiting_assembly）残留首轮 SSE 订阅与 react-query 缓存，致第二段断言拿到旧 run 状态；拆为独立用例 + 去手动 unmount（RTL 自动清理）后稳定。
2. **expo lint 3 警遗留**：M22 开发遗留未用 `AgentRunDetail` 导入、未用 `radius` 解构、冗余 `eslint-disable react-hooks/exhaustive-deps` 指令（依赖阵列已满足规则）；本轮一并清理，回归 0 警。

---

## 2026-08-15 · M21 里程碑回归（Agent 团队监控一期：只读监控 + 取消）

**目的**：主站 Agent 团队执行链路下沉移动端。一期切片：运行列表（状态过滤/轮询）+ 运行详情（SSE 事件流/任务卡片/产物预览/取消确认）；plan 编辑、resume、task action 明确后置二期。

**契约要点（已读 apps/api/app/routes/agent_team.py + services/agent_team_exec.py 源码确认）**

- `GET /api/agent-runs`：运行摘要列表，?limit=50（默认）+ ?status=（可选过滤）；返回 `AgentRunSummary{id, level, goal, status, created_at, task_counts}`。
- `GET /api/agent-runs/{id}`：运行详情，返回 `AgentRunDetail{id, level, goal, status, created_at, tasks, events}`（events 兜底 replay）。
- `POST /api/agent-runs/{id}/cancel`：取消运行；不存在/他人运行一律 404。
- `GET /api/agent-runs/{id}/events?after={cursor}`：SSE 事件流（`Accept: text/event-stream`），事件帧名 `msg`，载荷 `AgentRunEvent`（ack/plan/task_status/blocked/confirm_required/error）。
- 类型语义对齐 Web `apps/web/components/agent-run/agentRunMeta.ts`：run 状态徽章（running→执行中·accent/pending→排队中·neutral/done→已完成·success/failed→已失败·danger/cancelled→已取消·neutral/timeout→已超时·danger/blocked→待确认·warning）；task 状态徽章（pending→排队中/done→完成/failed→失败）；kind 中文名（txt2img→文生图/img2img→图生图/video→视频/audio→音频/model3d→3D/optimize→优化/reverse→反推/chat→对话/unknown→未知）；产物提取规则（video_url/video→video/image_url/image/thumbnail→image/audio_url/audio/voice_url→audio/text→text/否则 none）。

**改动清单**

- `src/types/api.ts`：`AgentRunSummary` / `AgentRunTask` / `AgentRunDetail` / `AgentRunEvent` 联合类型 + `AgentRunTaskBrief`。
- `src/lib/agent-run.ts`（新建）：`runStatusMeta` / `taskStatusMeta` / `taskKindLabel` / `extractTaskMedia` / `primaryInputText` / `toAgentRunEvent` 类型守卫 + `RUN_STATUS_META` / `TASK_STATUS_META` / `TASK_KIND_LABEL` 常量。
- `src/lib/api.ts`：`listAgentRuns` / `getAgentRun` / `cancelAgentRun` / `watchAgentRunEvents`（GET SSE 事件流，after 游标 + token query 双通道 + Authorization/Accept 头）。
- `src/features/agent-runs/agent-runs-screen.tsx`：状态过滤 chips（8 档）+ 运行卡片（goal/徽章/level/任务进度/相对时间）+ 3s 活跃轮询（`hasActiveRuns` 动态启停 `refetchInterval`）+ 空态区分 + 卡片点按跳详情。
- `src/features/agent-runs/agent-run-detail-screen.tsx`：GET 首屏加载 + SSE `after=0` 全量重放（`task_status` 事件合并进任务卡片/ticker 事件流/`plan` 初始化任务列表）+ 任务卡片（徽章/kind 中文名/主文案/产物预览）+ 取消按钮（确认弹窗 → POST cancel → 失效重查）+ 终态关流（`RUN_TERMINAL`）+ `sseConnecting` 加载态。
- `src/features/agent-runs/status-badge.tsx`：共用徽章组件（tone 色调/spin 转圈/accessibilityLabel）。
- `src/features/jobs/jobs-screen.tsx`：标题行右侧 Bot 图标入口（不占 tab 位，栈页跳转 `/agent-runs`）。
- `src/components/ui/Icon.tsx`：注册表 +`Bot`。
- `app/agent-runs/index.tsx` + `app/agent-runs/[id].tsx`：两栈页路由注册（expo-router file-based）。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 33 passed, 33 total
Tests:       595 passed, 595 total

File           | % Stmts | % Branch | % Funcs | % Lines |
---------------|---------|----------|---------|---------|
All files      |   94.42 |    88.86 |   97.36 |   94.71 |
  agent-run.ts |   98.64 |    98.96 |     100 |   98.24 |
```

- 较 M20 口径（30 套件 512 用例）净增 +3 套件 +83 用例；覆盖率四项 ≥80% 阈值达标。

**本里程碑新增测试与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| `lib/__tests__/agent-run.test.ts`（新建） | 21 | runStatusMeta/taskStatusMeta 全状态文案与色调；taskKindLabel 全 kind 映射与未知兜底；extractTaskMedia 全分支（video/image/audio/text/none）+ 空输入防御；primaryInputText 文案优先级链（goal→prompt→title→filename→'（无描述）'）；toAgentRunEvent 类型守卫（ack/plan/task_status/blocked/confirm_required/error 全事件解析 + 异常帧过滤为 null） |
| `lib/__tests__/api.test.ts` | +21 | listAgentRuns ?limit=50 + status 过滤形状/Authorization；getAgentRun id 转义/cancelAgentRun 成功与 404 人话；watchAgentRunEvents GET after 游标/token query 双通道/Authorization·Accept 头/事件解析（ack/plan/task_status/blocked/confirm_required/error）/异常帧过滤/中止信号/终态关流 |
| `features/agent-runs/__tests__/agent-runs-screen.test.tsx`（新建） | 8 | 列表渲染（goal/徽章/level/任务进度/相对时间）；过滤切换（全部→执行中）+ 空态区分；卡片点按导航；轮询激活态 |
| `features/agent-runs/__tests__/agent-run-detail-screen.test.tsx`（新建） | 12 | 详情渲染（goal/徽章/任务卡片/ticker）；SSE task_status 事件合并（pending→done）；plan 事件初始化任务列表；ticker 事件流截断 100 条；取消按钮→确认弹窗→POST cancel→失效重查；终态不订阅 SSE；错误处理 |
| `features/agent-runs/__tests__/status-badge.test.tsx`（新建） | 5 | 各 tone 渲染/spin 转圈/accessibilityLabel |

**与 MiniProgram / Web 的语义对齐**

- 同一契约 agent_team.py；同一状态徽章文案与色调（对齐 Web `agentRunMeta.ts`）；同一产物提取规则与主文案优先级。
- UI 语言各自原生：Web 为 `AgentRunView`/`AgentRunTimeline`/`AgentRunTaskCard`，Mobile 为 `AgentRunsScreen`/`AgentRunDetailScreen`/`StatusBadge`。

**踩坑记录**

1. **SSE 订阅时机**：组件 mount 即开流会导致终态 run 也误订阅，detail 接口返回后再按 `status` 判断是否终态才决定是否开流。修复：useEffect 依赖 `[runId, runStatus]`，终态集合 `RUN_TERMINAL` 直接 return。**教训：SSE 订阅必须后于首屏详情加载，以终态为关流信号。**
2. **「执行中」文本同时命中 chip 与徽章**：测试断言 `getByText('执行中')` 在过滤 chip 和状态徽章同时存在时歧义失败。修复：徽章改用 `testID` 断言 `run-card-{id}-status`。**教训：列表+详情共用文案时，优先 testID 锚定。**
3. **React Hook setState-in-effect 警告**：`useEffect` 中同步 setTasks(detail.tasks) 触发 lint 规则 `react-hooks/exhaustive-deps` 警告。修复：将初始 task 同步逻辑从 useEffect 移至 render 期间，通过比较 plan 引用变更触发状态更新。**教训：初始状态同步尽量在 render 期完成，避免 effect 中同步 setState。**
4. **测试拼写**：SSE 测试中 `init.headers.Acept` 漏写 'c' 导致断言失败。修复：`Accept`。**教训：HTTP 头名拼写敏感，复制粘贴后需二次校验。**

**已知噪音（非失败）**：同 M4 起记录——TanStack Query notifyManager batch 定时器在用例结束后触发 act 提示并使 worker 延迟退出；用例全部通过。

---

## 2026-08-15 · M20 里程碑回归（对话助手二期「文档挂载」：/api/docs + document_ids 随 chat 上行）

**目的**：对话助手可挂载文档引用——上传/列表/删除文档，发送时 `document_ids` 随 `/api/agent/chat` 上行，与 Web AssistantView 同一契约、同一文案语义。

**契约要点（已读 apps/api/app/routes/documents.py 源码确认）**

- `POST /api/docs/upload`：multipart 字段名 `file`；仅 pdf/docx/txt/md；>50MB → 413；类型不支持 → 400；解析失败/空文本 → 422；201 返回 `DocItem{id, filename, kind, size, chunk_count, status, created_at}`（status: ready|partial|no_embed）；大文件解析慢，走 long 超时档。
- `GET /api/docs` → DocItem[]（created_at 倒序由后端保证）。
- `DELETE /api/docs/{doc_id}` → `{ok:true}`；不存在/他人文档一律 404（不泄露存在性）。
- `POST /api/agent/chat` 请求体新增可选 `document_ids: string[]`（空数组省略字段，后端 default_factory=list）。
- 鉴权/错误人话复用 apiFetch 体系（Authorization/X-NSFW 同源头部）。

**改动清单**

- `src/types/api.ts`：`DocItem`。
- `src/lib/doc-utils.ts`（新建）：`docStatusLabel`（ready→已索引 / partial→部分索引(超长截断) / no_embed→未索引(向量服务不可用)，未知原样透传）+ `formatDocSize`（<1024→`{n}B`；<1MB→`{x.x}KB`；否则 `{x.x}MB`）——对齐 Web lib/docs.ts 文案。
- `src/lib/api.ts`：`listDocs` / `uploadDoc`（multipart 字段名 `file`，三段式 `{uri,name,type}`，fileName 缺失按 mimeType 推扩展名兜底，long 超时档）/ `deleteDoc`（id 转义）；`agentChatStream` 加可选 `documentIds`（非空注入 `document_ids`）。
- `src/features/assistant/chat-utils.ts`：`ChatItem` 加 `docs?: ChatDocRef[]`（本轮挂载留痕）。
- `src/features/assistant/doc-sheet.tsx`（新建）：文档面板底部抽屉——上传钮（expo-document-picker v57 `getDocumentAsync` 四 mime 白名单 + copyToCacheDirectory；客户端先验扩展名 + ≤50MB 提前拦截）+ 列表项（文件名 + formatDocSize + docStatusLabel + 挂载勾选 + 删除 ConfirmDialog 二次确认）+ 空态 + `enabled: visible` 按需拉取。
- `src/features/assistant/assistant-screen.tsx`：输入栏左侧 Paperclip ghost 钮（面板开或有挂载时 accent 高亮）+ 输入栏上方横排挂载 chips（X 可移除）+ 发送快照 `attachedDocs`：`documentIds` 随轮上行、chips 清空转移到该条 user 气泡下方留痕（后端不回放文档引用，仅本地轮次展示）。
- `src/components/ui/Icon.tsx`：注册表 +File/Paperclip。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 30 passed, 30 total
Tests:       512 passed, 512 total

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   93.99 |    85.82 |   96.93 |   94.34 |
  doc-utils.ts|     100 |      100 |     100 |     100 |
```

- 较 M19 口径（29 套件 482 用例）净增 +1 套件 +30 用例；覆盖率四项 ≥80% 阈值达标。

**本里程碑新增测试与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| `lib/__tests__/doc-utils.test.ts`（新建） | 8 | docStatusLabel 三态文案 + 未知/空串透传；formatDocSize 边界（0/512/1023/1024/1536/1MB-1/1MB/2.5MB/50MB） |
| `lib/__tests__/api.test.ts` | +11 | document_ids 非空注入/缺省与空数组省略；uploadDoc FormData 形状（字段名 file、三段式、不手设 Content-Type）、fileName 兜底、400/413/422 人话；listDocs 原样返回；deleteDoc id 转义、404 人话 |
| `features/assistant/__tests__/assistant-screen.test.tsx` | +12 | 文档钮渲染与激活态/面板开合才拉列表/列表文案/勾选挂载出 chips 与 X 移除/发送 document_ids 上行 + chips 清空转移气泡/上传成功入参与失效重拉/上传 422 人话/扩展名与 >50MB 先验拦截/picker 取消静默/删除二次确认与挂载卸载/删除 404 不卸载 |

**与 MiniProgram MP20（候选）/ Web 的语义对齐**

- 同一契约 documents.py；同一状态文案与尺寸格式化（doc-utils 对齐 Web lib/docs.ts）；同一发送语义（document_ids 随轮上行、发送后输入区清空、留痕于该条 user 气泡）。
- UI 语言各自原生：Web 为侧栏文档区，Mobile 为底部抽屉 DocSheet + 输入栏 chips。

**踩坑记录**

1. **异步列表断言竞态**：`waitFor(mockListDocs 被调用)` 仅保证请求发出，TanStack Query 数据落盘再渲染还需一拍；直接 `getByTestId('doc-attach-*')` 在套件连跑时偶发找不到（单跑时序宽松能过）。修复：对目标内容一律 `waitFor` 再交互/断言。**教训：查询类 UI 断言以内容为锚，不以「请求已发出」为锚。**
2. **useMutation mutationFn 透传上下文**：`deleteDoc` 经 `useMutation` 调用收到第二参 `{client, meta, mutationKey}`，`toHaveBeenCalledWith('d1')` 失败；改断言 `mock.calls[0]?.[0]`（M4/M19 已记录同类根因，本次新增用例沿用该模式）。
3. **lucide 图标须双处登记**：`Icon.tsx` 注册表漏登记 File/Paperclip 会导致运行期 icon 缺失；已补齐并纳入组件测试渲染链路验证。

**已知噪音（非失败）**：同 M4 起记录——TanStack Query notifyManager batch 定时器在用例结束后触发 act 提示并使 worker 延迟退出；用例全部通过。

---

## 2026-08-14 · M19 里程碑回归（对话助手 Assistant 一期：SSE 流式对话 + 会话管理）

**目的**：主站 Agent 对话能力下沉移动端。一期切片：单轮流式对话（text/tool/媒体事件增量渲染）+ 会话管理（列表/载入/删除）；fork 会话、媒体点开预览、输入草稿持久化留二期。

**契约要点（已读 apps/api/app/routes/agent.py 源码确认）**

- `POST /api/agent/chat`：SSE 流（`Accept: text/event-stream`），入参 `{messages, session_id?}`；响应头 `X-Agent-Session-Id` 回收会话 id（新会话首轮由后端签发）；事件帧名 `msg`，载荷 AgentEvent（`text` 增量 / `tool` 调用 / `image`·`video`·`audio`·`model3d` urls / `error`）。
- `GET /api/agent/sessions`：会话摘要列表（updated_at 倒序，含 message_count）；nsfw 会话由后端按 X-NSFW 上下文过滤，前端不做判断。
- `GET /api/agent/sessions/{sid}`：全消息回放（id 升序即对话顺序）；归属/R18 校验失败一律 404（不泄露存在性）。
- `DELETE /api/agent/sessions/{sid}`：消息随会话一并删除。
- `POST /agent/sessions/{sid}/fork` 存在但不在一期范围。

**改动清单**

- `src/types/api.ts`：`AgentEvent` / `AgentChatMessage` / `AgentSessionSummary` / `AgentSessionMessage` / `AgentSessionDetail`。
- `src/lib/sse.ts`（新建）：`parseSseStream`——Uint8Array 流 → TextDecoder 跨 chunk 拼帧 → `event:`/`data:` 行解析，空行派发，多行 data 以 `\n` 连接，AbortSignal 联动取消。
- `src/lib/api.ts`：`agentChatStream`（expo/fetch 流式 POST，仅派发 `msg` 帧 JSON，单帧坏数据不中断整条流；中止静默等价「未开始的轮次」；无流式 body 报「当前环境不支持流式响应」）+ `listAgentSessions` / `getAgentSession` / `deleteAgentSession`。
- `src/features/assistant/chat-utils.ts`（新建）：`ChatItem`/`ChatMedia` 模型 + `reduceAgentEvent`（事件 → 消息增量归约纯函数）+ `historyForApi`（AGENT_HISTORY_LIMIT=40 截断）+ `mapSessionMessages` + `nextLocalId`。
- `src/features/assistant/assistant-screen.tsx`（新建）：inverted FlatList 消息流 + 贴底输入栏 + 流式中「停止生成」（AbortController）+ 失败人话横幅 + 空态。
- `src/features/assistant/session-sheet.tsx`（新建）：会话抽屉——列表查询 / 点选载入详情回填 / 删除二次确认 / 删除活跃会话清空当前对话。
- `src/app/assistant.tsx`（新建）：栈页路由；`generate-screen.tsx` 头部新增 MessageCircle 入口；`Icon.tsx` 注册表 +MessageCircle/History/Square。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告；--fix 已清 Array<T> 写法告警）

$ npx jest --coverage
Test Suites: 29 passed, 29 total
Tests:       482 passed, 482 total

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   94.47 |    86.29 |   96.73 |   94.95 |
  sse.ts      |     100 |    80.76 |     100 |     100 |
```

- 较 M18 口径（26 套件 436 用例）净增 +3 套件 +46 用例；覆盖率四项 ≥80% 阈值达标。

**本里程碑新增测试套件（3）与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| `lib/__tests__/sse.test.ts` | 12 | 单帧/多帧解析、跨 chunk 边界拼帧、多行 data 连接、event 名切换与复位、空 data 不派发、中止信号、尾包无空行兜底派发 |
| `features/assistant/__tests__/chat-utils.test.ts` | 10 | reduceAgentEvent 七类事件归约（text 追加/tool/四类媒体/error）、historyForApi 40 条截断、mapSessionMessages 回放映射 |
| `features/assistant/__tests__/assistant-screen.test.tsx` | 11 | 空态、发送→流式增量渲染、停止生成中止、失败横幅、会话抽屉列表/载入回填/删除清空活跃会话、创作页入口跳转 |
| `lib/__tests__/api.test.ts` | 111（净增 +13） | agentChatStream 请求形状/Authorization/X-NSFW/session_id 透传/msg 帧解析/坏帧容错/中止静默/无 body 报错/会话 id 响应头回收；sessions 列表/详情/删除三端点 |

**踩坑记录**

1. **jest.mock 工厂内禁用 TS 参数属性**：`class MockApiError extends Error { constructor(public readonly status: number, ...) }` 触发 babel-jest-hoist 作用域检查报 `Invalid variable access`；改写为先声明字段再赋值（M3 已记录同类，本次为新套件再犯后修正）。
2. **可访问性断言用错查询**：流式中停止钮文本经 accessibilityLabel 暴露，`getByText('停止生成')` 查不到；改 `getByLabelText`。**教训：a11y label 承载语义的控件一律按 label 查询。**
3. **TanStack Query mutationFn 透传第二参**：`deleteAgentSession` 经 `useMutation` 调用会收到 `{client, meta, mutationKey}` 上下文，断言 `toHaveBeenCalledWith('s1')` 失败；改断言 `mock.calls[0]?.[0]`（M4 已记录同类根因）。
4. **job-tracker 疑似超时复核**：全量并行跑时该套件出现过一次超时，隔离复跑 10/10 全绿、全量复跑通过——并行 worker 资源抖动，非本次改动引入的缺陷。

**已知噪音（非失败）**：同 M4 起记录——TanStack Query notifyManager batch 定时器在用例结束后触发 act 提示并使 worker 延迟退出；用例全部通过。

---

## 2026-08-14 · M18 里程碑回归（创作页优化提示词：口语输入 → /api/optimize → LLM 扩写回填）

**目的**：Web 端创作页早有 OptimizeButton（口语化输入 → LLM 按题材扩写专业英文 prompt 回填）；Mobile 创作链路补齐该能力，与 MiniProgram MP18 同一契约、同一语义。

**契约要点（已读 apps/api/app/routes/optimize.py 源码确认）**

- `POST /api/optimize`：JSON 入参 `{prompt, kind}`；`kind` 直通后端按题材切系统提示（image/image_edit/video/audio）。
- `optimized` 恒有值；`negative` 仅 image/image_edit/video 类返回（audio 等单段类无），解析失败时后端启发式兜底。
- `model`/`style`/`agent_id`/`style_hint` 为 Web 高阶入参（模型族方言/智能体人格），移动端本期走后端默认。
- 502 优化失败 / 503 LLM 不可达，由 apiFetch 透传人话。

**改动清单**

- `src/types/api.ts`：`OptimizeResult{optimized, negative: string|null}`。
- `src/lib/api.ts`：`optimizePrompt({prompt, kind})` POST /api/optimize，negative 缺省/显式 null 归一化为 null。
- `src/features/generate/prompt-bar.tsx`：优化入口（40×40 圆形 ghost 钮，Sparkles 图标，与反推 Wand2 并排；空 prompt/optimizing/reversing/submitting 禁用 + optimizing 中 ActivityIndicator；a11y label/state 齐备）。
- `src/features/generate/generate-screen.tsx`：`optimize()`——三态防重复 → optimizePrompt → prompt 覆盖回填 + negative 有值写入表单参数（随提交进请求体）；失败人话横幅不覆盖已有 prompt。

**命令输出（截取）**

```
Test Suites: 26 passed, 26 total
Tests:       436 passed, 436 total
```

- `npx tsc --noEmit` 0 错；`npx expo lint` 0 警。
- 覆盖率四项 ≥80% 阈值达标（较 M17 基线 94.01/88.38/96.29/94.48 保持）。
- 新增用例：api.test +6（请求形状+Authorization / audio 无 negative 归一化 / video 带 negative / 显式 null 保持 / 502 / 503）；generate-screen.test +5（按钮渲染+回填且 negative 随提交进请求体 / kind 跟随选中视频引擎 ltx25-t2v / negative null 不写入 / 失败横幅不覆盖 prompt / 空 prompt 禁用不调 API）。

**与 MiniProgram MP18 的语义对齐**

- 同一契约文件 optimize.py；同一回填语义（prompt 覆盖、negative 有值才写入/展开）；同一禁用语义（空 prompt 不发起）；同一失败处理（人话不覆盖已有 prompt）。
- UI 语言各自原生：MiniProgram 为 prompt 卡内右下角 ghost 钮组（图标+文字），Mobile 为 PromptBar 内 40×40 圆形 ghost 钮（纯图标）——均与反推钮并排，对齐 Web OptimizeButton/ReverseButton 相邻关系。

**踩坑记录**

1. **组件测试 fixture 踩白名单禁用样本**：首版用 `VIDEO(ltx2-t2v)` fixture 验证「kind 跟随视频引擎」，该引擎为白名单外禁用样本不可选中，kind 断言漂移。修复：改用 `LTX25_T2V` 可选视频引擎 fixture。**教训：交互类组件测试选 fixture 必须先确认 available/白名单状态，不取禁用样本。**

---

## 2026-08-14 · M17 里程碑回归（创作页反推提示词：选图/视频 → /api/reverse → VLM 回填）

**目的**：Web 端创作页早有 ReverseButton（上传图/视频 → VLM 反推英文 prompt 回填）；Mobile 创作链路补齐该能力，与 MiniProgram MP17 同一契约、同一语义。

**契约要点（已读 apps/api/app/routes/reverse.py 源码确认）**

- `POST /api/reverse`：multipart 字段名 `file`（非 `image`）；`kind` 按 content-type 前缀/扩展名判定；`negative` 仅图像可能返回（视频/音频无）。
- 体积上限 image 20MB / video 50MB（`reverse_max_*_mb`），超限 413；VLM 不可达/非 200/空 → 502。
- `X-NSFW` 头触发 NSFW 图像 JoyCaption 专线；视频一律走 Qwen3-VL。

**改动清单**

- `src/types/api.ts`：`ReverseResult{kind, prompt, negative: string|null}`。
- `src/lib/api.ts`：`reversePrompt(file)`——RN FormData 文件三段式 `{uri,name,type}` 直传（运行时不读 Blob），字段名 `file`；fileName 缺失按 mimeType 推扩展名兜底 `reverse.<ext>`；`long: true` 180s 档（VLM 首 token 慢）；X-NSFW 由 apiFetch 全局意图注入；negative 缺省/null 归一化为 null。
- `src/features/generate/prompt-bar.tsx`：反推入口（40×40 圆形 ghost 钮，Wand2 图标；reversing 中 ActivityIndicator + 禁用；a11y label/state 齐备）。
- `src/features/generate/generate-screen.tsx`：`reverse()`——ImagePicker（images+videos）→ 客户端先验体积（图片 ≤20MB / 视频 ≤50MB，与后端同源，超限不进网络）→ reversePrompt → prompt 覆盖回填 + negative 有值写入表单参数；失败人话横幅不覆盖已有 prompt。

**命令输出（截取）**

```
Test Suites: 26 passed, 26 total
Tests:       425 passed, 425 total
```

- `npx tsc --noEmit` 0 错；`npx expo lint` 0 警。
- 覆盖率：语句 94.01% / 分支 88.38% / 函数 96.29% / 行 94.48%（四项 ≥80% 阈值，较 M16 基线 93.88/89.78/96.25/94.35 稳中有升）。
- 新增用例：api.test +7（字段名 file / fileName 兜底推扩展名 / X-NSFW 开关 / negative 归一化 / 413 透传 / 502 人话）；generate-screen.test +6（按钮渲染+图片回填含 negative 随提交进请求体 / 视频无 negative 请求体不带 / 失败横幅不覆盖 / 取消不调 API / 图片 20MB 拦截 / 视频 50MB 拦截）。

**与 MiniProgram MP17 的语义对齐**

- 同一契约文件 reverse.py；同一回填语义（prompt 覆盖、negative 有值才写入）；同一客户端先验上限；同一失败处理（人话不覆盖已有 prompt）。
- 选择器差异：MiniProgram 用 showActionSheet + chooseImage/chooseVideo（uni.chooseMedia 未入 uni-h5，MP17.3 取证修复），Mobile 用 expo-image-picker 单选器原生支持 images+videos 混合选择——平台能力对齐、交互各自原生。

---

## 2026-08-14 · M16 里程碑回归（作品库服务端 kind 过滤：过滤切换整库生效）

**目的**：M15 无限分页落地后，类型过滤桶只作用于已加载流（客户端过滤），稀疏类型在已加载子集中可能 0 命中、结果不完整。后端 `routes/jobs.py` list_jobs 本轮新增 `kind` 查询参数（与 MiniProgram MP16 同一改动），Mobile 作品库切换过滤桶改为整库生效。

**契约要点（已读 apps/api/app/routes/jobs.py 源码确认）**

- `GET /api/jobs?limit&offset&status&kind`：`kind` 逗号分隔多值（如 `txt2img,wan_t2v`），逐值 strip 去空白，空值/纯空白=全部；与 limit/offset/status 叠加，`Job.kind.in_(kinds)`。
- kind 过滤与 offset 分页正交：hasMore 启发式（本页满=可能还有）在过滤后同样成立。

**改动清单**

- 后端 `apps/api/app/routes/jobs.py`：list_jobs 新增 `kind: str = Query(default="")` → split/strip/滤空 → `stmt.where(Job.kind.in_(kinds))`。
- 后端 `apps/api/tests/test_jobs.py`：新增 `test_jobs_kind_multi_values`（多值命中任一 / 带空白 / 空值等价全部 / 纯空白等价全部 4 断言），test_jobs.py 16/16 全绿。
- `src/lib/api.ts`：`listJobs` 增 `kind?: string`（非空才 encodeURIComponent 序列化；qs 顺序 limit→offset→status→kind）。
- `src/features/library/library-screen.tsx`：`filterToKind`（过滤桶→FILTERS.kinds 逗号串）；`useInfiniteQuery` queryKey 改 `['jobs','library',kindParam]`——切换过滤桶自动作废旧缓存重新查询，分页随 kind 重置；移除 M15 客户端过滤逻辑与相关空态分支。
- `src/features/library/__tests__/library-screen.test.tsx`：mockJobsServer 假服务端支持 kind 过滤切片；新增 M16 用例（切换过滤桶重置分页 + 按 kind 重查只返回匹配类型 + 切回全部恢复）。

**命令输出（截取）**

```
Test Suites: 26 passed, 26 total
Tests:       412 passed, 412 total
```

- `npx tsc --noEmit` 0 错；`npx expo lint` 0 警。
- 后端 `pytest tests/test_jobs.py` 16 passed。
- 覆盖率：语句 93.88% / 分支 89.78% / 函数 96.25% / 行 94.35%（均 ≥80% 阈值，不跌破 M15 基线 93.88/90.16/96.25/94.35）。

**踩坑记录**

1. **后端全量 pytest 193 failed / 48 errors 取证**：失败签名全部为 `Failed: async def functions are not natively supported`——`pytest_asyncio` 未安装导致 async 用例无法收集（test_agent_team_graph / test_assembly / test_audio_sep 等模块的历史遗留环境问题），与本次 kind 过滤改动无关；本次改动文件 test_jobs.py 16/16 全绿。**教训：全量回归大面积失败先看失败签名同根因，区分历史遗留与本次引入。**
2. **RNTL 切换过滤桶断言时机**：切换 filter chip 后 queryKey 变更触发全新查询，直接断言 grid 长度会在旧数据未卸载时假性通过/失败；所有断言前置 `await waitFor` 等加载落定（沿用 M15 的 async fireEvent 经验）。

---

## 2026-08-14 · M15 里程碑回归（作品库无限分页：offset 服务端分页 × 客户端类型过滤交互）

**目的**：后端 `routes/jobs.py` list_jobs 已开放 offset（本轮刚落地，pytest 35/35；已读源码复核：limit 1-200 默认 50、offset ≥0 默认 0、最新在前、越界返回 []）。作品库从「一次性拉 200 条上限」（M6 提量档）迁移到真正的无限分页：`useInfiniteQuery` + FlatList `onEndReached` 追加，滚动到底自动续页，下拉刷新重置 offset=0，类型过滤保持可用。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 26 passed, 26 total
Tests:       413 passed, 413 total（较 M14 口径 391 净增 +22，套件 +1）

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   93.88 |    90.16 |   96.25 |   94.35 |
```

**本里程碑变更与新增用例（净增 +22）**

| 套件 | 用例数（净增） | 覆盖点 |
|---|---|---|
| `lib/__tests__/api.test.ts` | 106（+3） | `listJobs` offset>0 时 qs 带 `&offset=`；offset=0 与缺省一样不进 qs；offset 与 status 同现按 limit→offset→status 序拼接 |
| `features/library/__tests__/library-paging.test.ts` | 9（新套件） | 页大小契约（=50 且在 1-200 内）；`pageHasMore` 满页/不足页/空页；`nextOffset` 页数×页大小；`mergePagesUnique` 多页拼接 / 跨页重复 id 去重保留先出现一份 / 空页空输入；`firstPageOnly` 多页截断首页（pages/pageParams 同步）/ 单页内容不变 |
| `features/library/__tests__/library-screen.test.tsx` | 20（+10） | 首屏按 limit=50+offset=0 拉取；FlatList 虚拟化参数（initialNumToRender=12/windowSize=7/removeClippedSubviews/onEndReachedThreshold=0.5）；onEndReached 追加第二页 offset=50 且跨页重复 id 只留一份；加载下一页期间重复 onEndReached 不重入且 footer 加载中；首页不足页大小即到底 footer「没有更多了」不再发请求；下拉刷新截断首页重拉、新作插顶部；`['jobs']` 前缀失效（轮询/新完成）逐页重取新作插顶部不重复；过滤作用于已加载流（切换不丢数据、可视项少仍可继续加载、切回全部两页都在）；过滤无匹配且可能还有时网格保持挂载、续页后出现匹配；下一页加载失败 footer 错误态、恢复后仍可继续加载 |

**架构决策（防回归记录）**

1. **offset 分页 + hasMore 启发式**：后端无 total/cursor，`pageHasMore = 本页返回数 === limit`（契约注释原义：满页即可能还有）；末页恰好满页时会多发一次空页请求再收尾，代价可接受。`nextOffset = 页数 × 页大小`，与去重后的可见条数解耦（去重吞掉的行仍算已消费的服务端行数，否则 offset 会回退重复拉）。
2. **按 id 去重保序（mergePagesUnique）**：offset 分页下页边界随顶部新作插入漂移——追加页、失效重取都可能带回与已加载前缀重叠的行；合并时先出现（更靠顶部/更新）的一份胜出，FlatList keyExtractor 不会撞 key。
3. **过滤作用于已加载流，与服务端分页正交**：后端无 kind 过滤参数，类型 chips 只过滤已加载数据；计数为已加载前缀口径。切换过滤不重置分页、不丢已加载数据；过滤后可视项少时 `onEndReached` 不被禁用可继续加载；过滤无匹配但整体可能还有时网格保持挂载（空态进 `ListEmptyComponent`），文案区分「该分类暂无作品」（整体空）与「该分类暂无匹配」（已加载流非空）。
4. **useRef 同步锁防重入**：`isFetchingNextPage` 经 TanStack notifyManager setTimeout 异步派发，同一帧内连续 `onEndReached`（VirtualizedList 内容不足一屏会自动再触发）时组件闭包仍是旧值，仅靠状态判断会重复发请求（实测连续两次 fireEvent 发出 2 个真实请求）；ref 锁同步生效，`fetchNextPage().finally()` 释放（该 promise 不 reject，错误进结果态）。
5. **独立 queryKey `['jobs','library']`**：与作业屏 limit 50 的 `['jobs']` 区分，避免同 key 不同参数互覆缓存；删除/新完成作业失效用前缀 `['jobs']` 可模糊命中本 key，TanStack infinite refetch 按 pageParams 逐页重取，mergePagesUnique 保证重取后不重复。
6. **下拉刷新 = 截断首页 + refetch**：`firstPageOnly` 把 InfiniteData 截到首页（pages/pageParams 同步截断），refetch 仅重取 offset=0 一页并由其长度重算 hasMore——等效「重置 offset=0 重拉、抛弃已加载后续页」，且避免 infinite refetch 默认逐页重取全部已加载页的放大请求。

**踩坑记录**

- **RNTL 14 的 `fireEvent` 是 async（内部 `await act(...)`，且 act 统一包装为 `React.act(async ...)`）**：同一测试内连续两个未 await 的 `fireEvent(..., 'onEndReached')` 会让两个 act 作用域交错（A 进→B 进→A 出→B 出），React 报 "overlapping act()" 后 act 栈深度卡死不归零——后续用例中 act 外的状态更新（TanStack notifyManager setTimeout 通知、VirtualizedList `_updateCellsToRender` 定时器）永远排队不冲刷，表现为后续所有组件用例集体 1000ms 超时（单跑全绿、连跑全红，极难定位）。修法：本套件所有 `fireEvent` 逐个 `await`（含 RefreshControl `onRefresh` 裸回调包 `await act(async ...)`）。这也是 M13 已标记「漏 await 引发 flaky」的同类根因，本次完整取证。
- **测试夹具 id 冲突被去重吞掉**：过滤交互用例 page1 末行 `id:'v0'` 与 page2 `makeJobs('v',3)` 生成的 `v0/v1/v2` 撞 id，`mergePagesUnique` 正确吞掉重复行导致可见数 3≠预期 4；夹具前缀改 `vid` 规避。属于夹具 bug 而非实现 bug——去重语义本身由纯逻辑用例锁定。
- `loadMore` 初版仅靠 `isFetchingNextPage` 闭包判断防重入，jest 下连续两次 `onEndReached` 实测发出 2 个请求（状态尚未派发），useRef 锁修复后断言恰好 2 次（首屏 + 首次 onEndReached）通过。

---

## 2026-08-14 · M14 里程碑回归（avatar-talk LongCat-Avatar 数字人引擎接入）

**目的**：后端 `routes/avatar_studio.py` 已就绪——人像首帧 + 驱动音频 → 口型同步数字人视频（LongCat-Avatar v1.5，专用实例 :8197，与 LongCat t2v 同一 ComfyUI 实例；>93 帧自动按 93 帧窗口链式续段，2500 帧≈100s 分钟级长任务）。移动端接入该引擎：上传互钉同 worker（后端转运），schema 动态表单复用既有图像/音频字段链路。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 25 passed, 25 total
Tests:       391 passed, 391 total（较 M13 口径 375 净增 +16，套件持平）

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   93.88 |       90 |   96.25 |   94.35 |
  api.ts      |   92.41 |    89.43 |   97.82 |   92.36 |
```

**本里程碑变更与新增用例（净增 +16）**

| 套件 | 用例数（净增） | 覆盖点 |
|---|---|---|
| `lib/__tests__/api.test.ts` | 103（+4） | M14 describe：`submitAvatarTalk` POST `/api/avatar/talk` 请求体全字段序列化 + Bearer 注入；长超时档（30s 不中止证明 long=true，180s 到点超时人话）；422 detail 人话透传；`uploadKindForEngine('avatar-talk') → 'avatar'` |
| `features/generate/__tests__/generate-screen.test.tsx` | 96（+12） | 纯逻辑 +7：`normalizeEngineSchema`（仅 avatar-talk 的 text 型 audio → audio 型且 default null；其余引擎同引用返回；已 audio 型参数引用保持前向兼容）；`buildAvatarTalkRequest` 缺人像/缺音频 null；默认值全量（480×832/93 帧/25fps/12 步）空 negative/seed 省略；自定义值 + 宽高 snap16（500→496/845→832）；`''` 回落 default 并 clamp 边界（99999→2500）；`buildEngineSubmit` 校验顺序「请先上传人像首帧」→「请先上传驱动音频」；`engineNeedsAudio` 特判。UI +5：抽屉渲染人像首帧 + 驱动音频字段（text→audio 归一化生效证明 `param-sheet-field-audio-pick` 存在）；无人像本地校验不提交；有人像无音频校验（人像上传走 `avatar` kind）；音频上传钉人像落点 worker（`uploadAudio` kind=avatar + pinWorker，`audio/*` 文档类型）；完整链路提交 `submitAvatarTalk` 携互钉句柄 + schema 默认值 |

**既有断言同步（引擎由禁用到可选的语义翻转）**

- M9.3 芯片用例：avatar-talk 转可选；禁用态样本换成白名单外 `UNKNOWN_VIDEO`（ltx2-t2v），保留「禁用且点击不切换选中」覆盖。
- M10/M11 芯片用例：avatar-talk 转可选；M11 额外断言其 nsfw=false 不渲染 R18 徽标。
- `isSupportedEngine` 白名单用例：avatar-talk 入列，未知引擎不可选。
- `AVATAR_TALK` fixture 从空 params 改为与后端 `engine_registry._avatar_talk_params` 严格同形（audio 为 **text 型** default `''`），UI 用例因此真实走「归一化 → RefAudioField」链路而非吃已归一化 fixture。

**架构决策（防回归记录）**

1. **schema 归一化而非改注册表**：后端注册表把 avatar-talk 驱动音频声明为 text 型（Web 走独立 AvatarGenPanel 不吃动态 schema，text 仅作展示）；移动端 `normalizeEngineSchema` 在引擎加载处统一把该参数转 audio 型，复用 M11 RefAudioField 上传/预览/互钉全链路，避免为单引擎复制一套音频字段。归一化仅在 `id==='avatar-talk' 且 key==='audio' 且 type==='text'` 时触发，注册表后续改 audio 型则参数引用保持不动（前向兼容）。
2. **上传 kind=avatar**：`capabilities.py` 对 avatar kind 无模型/节点要求（pool worker 仅存文件，提交时后端转运 :8197 input 目录）；人像图与驱动音频同走该 kind，音频经既有 `mediaPinWorker` 钉人像落点 worker（同 lipsync 互钉语义），`syncAudioWithRefImage` 在人像换 worker/移除时强制清空已传音频。
3. **构建期 snap16**：注册表 width/height step=16 且后端 `_snap16` 非对齐向下取整；构建期同语义取整保证所见即所得（画幅预设直写不经 NumberField 失焦 clamp 的老约束不变）。
4. **shift/cfg/dmd_lora_strength 不进表单**：注册表未暴露，对齐 Web AvatarGenPanel 高级参数缺省不传语义，移动端省略由后端默认（12.0/1.0/1.0）。

**踩坑记录**

- 初版「前向兼容」断言写成整引擎对象引用相等（`toBe`）：实现对 avatar-talk 恒复制外层对象（仅参数级按引用保持），断言改为参数级引用相等后通过。语义不变：已归一化的参数不会被二次处理。

---

## 2026-08-14 · M13 里程碑回归（参考资产库接入：管理页 CRUD + 创作页引用）

**目的**：后端 `reference_assets.py` 已就绪（23/23 pytest）——把「角色/场景/道具/风格」常用参考图沉淀为可复用资产，创作页选中即用不重新上传；同时补齐管理页 CRUD 与我的页入口。

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告；修复前 1 错：asset-edit-screen 回填 useEffect 触发
 react-hooks/set-state-in-effect，改渲染期条件调整后清零）

$ npx jest --coverage
Test Suites: 25 passed, 25 total
Tests:       375 passed, 375 total（较 M12 口径 307 净增 +68，套件 +5）

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   93.84 |    89.94 |    96.2 |    94.3 |
  api.ts      |    92.3 |    89.34 |   97.77 |   92.24 |
```

**本里程碑变更与新增用例（净增 +68）**

| 套件 | 用例数（净增） | 覆盖点 |
|---|---|---|
| `lib/__tests__/api.test.ts` | 99（+9） | 资产 API describe：`listAssets` GET `/api/assets`（无过滤无 qs / kind qs 序列化）；`createAsset` POST 请求体全字段（kind/name/description/images/nsfw）；`getAsset` GET `/api/assets/{id}`；`updateAsset` PATCH 部分更新体；`deleteAsset` DELETE 应答 `{ok,id}`；`assetImageUrl` 走 mediaUrl 代理拼 token query；错误人话透传沿用 apiFetch 通道 |
| `features/assets/__tests__/asset-utils.test.ts` | 20（新套件） | kind 注册表四类齐备且对齐后端 Literal 声明；`assetKindLabel/assetKindIcon` 未知 kind 兜底「其他」/Layers；常量与后端边界同源（图 ≤4 / 名 ≤100 / 上传 kind=img2img）；`validateAssetDraft` 先验矩阵（空名/超长/无图/超 4 张/合法放行）；`validateImagePick` 扩展名白名单与 ≤20MB；`buildAssetPatch` 逐字段 diff（仅变化字段、images 按 filename+worker 等值、全同返回空对象）；`imageExtOf` fileName 缺失按 mimeType 推扩展名 |
| `features/assets/__tests__/assets-screen.test.tsx` | 8（新套件） | `assetColumnCount` 断点 2/3/4 列（与作品库同源）；标题 + 五枚过滤 chips + 缺省 kind 查询；点 chip 按 kind 重查（服务端过滤）；空态（全部）引导文案 + 新建跳 `/assets/edit`；空态（分类）文案切换且不渲染引导；头部新建/返回导航；卡片渲染（名称/kind 徽标 within 作用域断言/多图角标 ×n/R18 徽标仅 nsfw）；点卡片携 id 跳编辑页 |
| `features/assets/__tests__/asset-edit-screen.test.tsx` | 14（新套件） | 新建态：不发起单查；本地先验（空名拦截 → 有名称无图拦截，均不发请求）；gif 客户端先验拒绝；多选两张互钉（第二张 pin 第一张落点 worker）；创建流请求体正确 → 返回；创建失败透传后端人话不返回；SFW 上下文不渲染 R18 开关；R18 上下文开关随创建落库。编辑态：getAsset 回显（标题/名称/kind 选中/描述/图片数/删除按钮）；仅改名 PATCH 只携 name；无变化保存不发 PATCH 直接返回；移除已回显图 PATCH 携缩减 images；删除流（Alert 取消不删 / destructive 确认 → deleteAsset → 返回）；单查 404 展示加载错误 |
| `features/assets/__tests__/asset-picker.test.tsx` | 8（新套件） | 五枚过滤 chips；`visible=false` 不发起列表请求（抽屉关闭不轮询）；资产行渲染（名称/kind 标签/图片数/R18 徽标）；点 chip 按 kind 重查；点资产行展开 1-4 张图再点收起；点选回填 `{filename, worker, previewUri, name}` 并 onClose（previewUri 为 assetImageUrl 代理、不重新上传）；空库/分类空态文案区分；关闭按钮与背景蒙层均触发 onClose |
| `features/generate/__tests__/ref-image-field.test.tsx` | 14（+2） | M13 新增：单图字段渲染「资产库」次级入口；picker 点选回填句柄直接替换现值（不走相册、不调 uploadImage） |
| `features/generate/__tests__/ref-images-field.test.tsx` | 6（新套件） | 多图字段「资产库」入口（满员隐藏）；点选库内图追加句柄（不重新上传、不走相册）；追加不超 max 上限 |
| `features/profile/__tests__/profile-screen.test.tsx` | 6（+1） | 「管理」区渲染参考资产库入口；点按跳 `/assets` |

**架构决策（防回归记录）**

1. 资产上传 kind 固定 `img2img`（`ASSET_UPLOAD_KIND`）：assets 路由不做引擎能力门槛，`upload.py` 的 img2img 通道无门槛；资产图后续可被任意引擎参考字段引用，与具体引擎解耦。
2. 资产句柄视为「已上传完成态」：picker 回填 `{filename, worker}` 直进表单，与既有「上传即钉 worker」状态兼容；多图字段后续新上传以资产图 worker 为钉点（互钉逻辑复用，跨机取不到文件的老约束不变）。
3. 编辑页回填用**渲染期条件调整**（React 官方 "You Might Not Need an Effect" 模式）替代 `useEffect` 内 setState——eslint-config-expo（SDK 57）启用的 `react-hooks/set-state-in-effect` 禁止 effect 内同步 setState；`hydrated` 闸保证仅回填一次，refetch 不覆盖用户编辑。
4. PATCH 最小增量：`buildAssetPatch` 逐字段 diff（images 按 filename+worker 数组等值比较），无变化保存直接返回不发请求（省一次往返）；新建走全量 POST。
5. 资产缩略图统一走 `assetImageUrl(id, idx)`（mediaUrl 代理 + 自动拼 token query），前端不接触 worker 直链——代理层承担归属与 NSFW 上下文门控（他人资产/SFW 下 NSFW 图 404）。

**踩坑记录**

- **RNTL v14 render 异步化**：新版 `render` 返回 Promise，辅助函数 `renderPicker/renderScreen` 调用处漏 `await` → 报 "`render` function has not been called" 或 mock 断言收到 undefined；约定固化：所有 render 辅助函数一律 `await`（`src/test/__tests__/rntl-probe.test.tsx` 自检用例守门）。顺手修复既有 `jobs-screen` / `library-screen` 同型漏 await——单跑能过、全量并发时序下才暴露的 flaky。
- **`getByText('角色')` 多元素命中**：过滤 chip 与卡片 kind 徽标同文案，改用 `within(card).getByText('角色')` 限定作用域断言。
- **`react-hooks/set-state-in-effect`**：SDK 57 的 eslint-config-expo 自带 react-hooks v6 规则集，effect 内回填表单被判 error；改渲染期条件调整后清零（见架构决策 3）。

**已知噪音（非失败）**：同 M4–M12——TanStack Query notifyManager 的 batch 定时器在用例结束后触发 act 提示并使 worker 延迟退出；用例全部通过，后续可引入全局 fake-timers 或 unmount 收尾消除。

---

## 2026-08-14 · M12 里程碑（真机验证载体：EAS Build preview Android 重建）

**目的**：M11 新增原生依赖 expo-document-picker（~57.0.1），M8 的旧 preview 包不含该原生模块——视频引擎全链路（驱动音频选择）真机验证必须重建。

**命令与产物（本轮实测）**

```
$ npx eas build --profile preview --platform android --non-interactive
构建 ID   9109acb0-4aa2-417e-9a4d-acb74a0c6b44（@wineryz/Mobile，SDK 57.0.0）
12:20:18 排队 → 12:36:00 finished（约 16 分钟）
APK      https://expo.dev/artifacts/eas/8buBnoQxsdtAUCSDs0DtrX6EnKQCmLhU7Fr4bd3cXQ4.apk
安装页   https://expo.dev/accounts/wineryz/projects/Mobile/builds/9109acb0-4aa2-417e-9a4d-acb74a0c6b44
```

**踩坑记录**

- `eas whoami` 首次 GraphQL 请求失败（网络抖动），重试即恢复——EAS 操作前先探活。
- 后台执行 `eas build | tail` 会缓冲全部输出直到进程退出；进度查询应另开 `eas build:list --limit=1 --non-interactive`。

**真机走查项（待用户安装 APK 后执行）**：视频引擎全链路（参考图/多图/驱动视频/驱动音频上传 → 提交 → 轮询 → 播放）；NSFW 开关二次确认 + R18 引擎可见性切换；登录/作品库/下载回归。

---

## 2026-08-14 · M11 里程碑回归（R18 视频引擎接入：ltx-nsfw-t2v / ltx-nsfw-i2v / ltx-nsfw-lipsync / h3-nsfw-t2v / h3-nsfw-i2v）

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npm run lint（expo lint）
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 20 passed, 20 total
Tests:       307 passed, 307 total（较 M10 口径 262 净增 +45，套件 +1）

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   93.68 |    89.83 |   95.89 |   94.14 |
  api.ts      |   91.91 |    89.16 |   97.43 |    91.8 |
```

**本里程碑变更与新增用例（净增 +45）**

| 套件 | 用例数（净增） | 覆盖点 |
|---|---|---|
| `lib/__tests__/api.test.ts` | 90（+13） | R18 视频引擎链路 describe：`submitLtxNsfwT2V` POST `/api/generate/ltx-t2v`（含 use_upscale/use_rife 序列化）；`submitLtxNsfwI2V` POST `/api/generate/ltx-i2v`（image/worker 必填）；`submitLtxNsfwLipsync` POST `/api/generate/ltx-lipsync`（audio/id_lora/id_lora_strength）；R18 提交 403（无 X-NSFW 上下文门控）走兜底人话；三函数统一 `long: true` 长超时档（30s 不中止 / 180s 到点人话）；`uploadAudio` POST `/api/upload?kind=ltx_lipsync&worker=<钉点>`（字段名固定 image、三段式直传不手设 Content-Type、无钉点 qs 仅 kind、fileName 缺失按 mimeType 推扩展名 x-m4a→m4a、415 三重白名单透传后端 detail）；`uploadKindForEngine` it.each ×5（ltx-nsfw-i2v→ltx_i2v / ltx-nsfw-lipsync→ltx_lipsync / h3-nsfw-i2v→h3_i2v / 两个 t2v 兜底 img2img） |
| `features/generate/__tests__/generate-screen.test.tsx` | 84（+20） | M11.2 纯逻辑 describe：`buildLtxNsfwT2VRequest`（resolution/duration 预设换算 width/height/length，6s×16fps=96 吸附 8k+1→89，双 switch 始终携带，schema 数值全量）；`buildLtxNsfwI2VRequest`（无参考图 null、有参考图携 image/worker）；`buildLtxNsfwLipsyncRequest`（缺参考图/缺音频 null、双句柄互钉同 worker、id_lora 可覆盖）；`buildH3NsfwT2VRequest`（32 对齐宽高 + 17k+5 帧网格 6/10/15s→141/243/362、loras 缺省空数组）；`buildH3NsfwI2VRequest`（无参考图 null）；`syncAudioWithRefImage`（参考图换 worker 强制清空已钉音频、同 worker 保留、无音频字段引擎不动）；`buildEngineSubmit` 五路分发 + 缺素材本地校验文案；SUPPORTED 白名单五引擎可选。M11.3 UI describe：5 个 R18 引擎芯片可选并渲染 R18 徽标（SFW 引擎无徽标、avatar-talk 仍禁用）；ltx-nsfw-lipsync 完整链路（参考图 + 驱动音频互钉 → submitLtxNsfwLipsync 携双句柄）；h3-nsfw-i2v 提交复用 SFW submitH3I2V 链路；参考图移除后音频字段联动清空 |
| `features/generate/__tests__/ref-audio-field.test.tsx` | 12（新套件） | `RefAudioField` 组件：无值渲染上传按钮 + hint；有值渲染预览行（AudioLines 图标 + 文件名）+ 移除按钮；移除回调 onChange(null)；点按调系统文档选择器（`DocumentPicker.getDocumentAsync({type:'audio/*'})`）；取消选择不上传；扩展名先验拒 .txt；体积先验拒 >20MB；上传成功 onChange 携 `{filename,worker,name}`；上传失败透传后端人话；上传中 loading 态禁重复点击；fileName 缺失按 mimeType 兜底扩展名；文档选择器打开异常兜底人话 |

**架构决策（防回归记录）**

1. 音频选择走 **expo-document-picker**（`getDocumentAsync({type:'audio/*'})`）——expo-image-picker 只支持相册媒体（图片/视频），不能选音频文件；依赖经 `npx expo install expo-document-picker` 安装对齐 Expo v57（~57.0.1），API 形态以 v57 精确版本文档核对后实现。
2. R18 LTX 时长预设换算与 Web `_ltxNsfwLength` 同源：duration 秒 × fps(16) → 吸附 8k+1 帧网格并钳 [9, 241]（6s→89 帧）；H3 时长预设 → 17k+5 帧网格（6/10/15s→141/243/362，模板锁 24fps）与注册表 `_H3_NSFW_DURATIONS` 同源；resolution select 值 `'WxH'` 拆 width/height，注册表 select 不直传。
3. 驱动音频与参考图**互钉同 worker**：`RefAudioField` 上传时以 `pinWorker`（参考图落点）钉点（LTX2.3 口型同机生成，跨机取不到文件）；参考图换 worker/被移除时 `syncAudioWithRefImage` 强制清空音频字段——与 M9 `syncVideoWithRefImage` 同一语义，构建期不纠由 UI 层联动清理。
4. `h3-nsfw-t2v/h3-nsfw-i2v` 复用 SFW `submitH3T2V/submitH3I2V` 链路（同一 POST `/api/h3/*` 端点）：专区可见性由后端按 X-NSFW 头过滤，api client 已按 settings store 开关自动注入，移动端无需额外门控；R18 请求类型亦复用 SFW `H3T2VRequest/H3I2VRequest`。
5. 引擎芯片 R18 徽标：`engine.nsfw === true` 时渲染 `engine-chip-<id>-r18`（取主题 warning 色），对齐 Web `GenerateView` Badge tone=warn；SFW 引擎无徽标，avatar-talk 维持禁用态不变。
6. `uploadAudio` 复用 M8 `apiFetch formData` 通道：字段名固定 `image`（后端 `upload.py` 单一 `UploadFile` 形参名），不手设 Content-Type；客户端先验扩展名白名单 wav/mp3/m4a/ogg/flac + ≤20MB（与后端 `_EXT_TO_KIND` 音频侧子集同源），20MB 走 `long: true` 超时（180s）。
7. **踩坑：jest-expo 57 / RNTL v14 peer 依赖缺口**——`jest-expo@57` 将 RN Jest 预设外置为 peer 依赖 `@react-native/jest-preset@^0.86.2`（缺失报 "The React Native Jest preset that jest-expo relies on has moved to a separate package"）；`@testing-library/react-native@14` 的渲染器亦为 peer 依赖 `test-renderer@^1.0.0`（React 官方弃用 react-test-renderer 后的现代替代，缺失报 "Cannot find module 'test-renderer'"）。两包补装为 devDependencies 后 20 套件全绿；产品运行时依赖零新增（仅 expo-document-picker）。
8. **踩坑：expo lint 口径**——直接 `npx eslint .` 会因 flat config 中 `@typescript-eslint` 插件解析失败报错；项目 lint 口径统一为 `npm run lint`（即 `expo lint`，内部完成插件解析），与 STATE.json qualityGate 一致。

**已知噪音（非失败）**：同 M4–M10——TanStack Query notifyManager 的 batch 定时器在用例结束后触发 act 提示并使 worker 延迟退出；`useQuery({enabled:false})` 无 queryFn 的开发态 console.error 提示（JobTracker 共享缓存派生模式）；用例全部通过，后续可引入全局 fake-timers 或 unmount 收尾消除。

---

## 2026-08-14 · M10 里程碑回归（剩余 SFW 引擎接入：h3-t2v / h3-i2v / longcat-t2v / longcat-i2v / longcat-continue / ace-music）

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告；修复前 2 警：generate-screen.test.tsx 未用 import submitLongCatI2V、api.test.ts Array<T> 写法，均顺手清零）

$ npx jest --coverage
Test Suites: 19 passed, 19 total
Tests:       262 passed, 262 total（较 M9 口径 219 净增 +43，套件 +1）

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   94.88 |     92.5 |   95.58 |   95.53 |
  api.ts      |   94.21 |     93.2 |   97.05 |   94.39 |
```

**本里程碑变更与新增用例（净增 +43）**

| 套件 | 用例数（净增） | 覆盖点 |
|---|---|---|
| `lib/__tests__/api.test.ts` | 77（+11） | M10 六提交函数 describe：`submitH3T2V` POST `/api/h3/t2v`（loras 数组序列化）；`submitH3I2V` POST `/api/h3/i2v`（image/worker 必填）；`submitLongCatT2V/LongCatI2V` POST `/api/longcat/t2v|i2v`（无 cfg，蒸馏链路）；`submitLongCatContinue` POST `/api/longcat/continue`（video 产物 URL）；`submitAceMusic` POST `/api/generate/audio`（tags/lyrics/seconds）；六函数统一 `long: true` 长超时档（30s 不中止 / 180s 到点人话，it 表驱动 ×6）；`uploadKindForEngine` 增 h3-i2v→h3_i2v、longcat-i2v→ltx_i2v（对齐 Web GenerateView 回落，longcat 复用 ltx_i2v 上传通道） |
| `features/generate/__tests__/generate-screen.test.tsx` | 64（+20） | M10.2 纯逻辑 describe：`buildH3T2VRequest`（schema 默认值全量、空 negative/seed 省略、loras 缺省空数组、自定义数值构建期 clamp、loras 缺 strength 补 0.6 并钳 0.5-1.0、脏值剔除）；`buildH3I2VRequest`（无参考图 null、有参考图携 image/worker + loras）；`buildLongCatT2VRequest`（无 cfg 字段）；`buildLongCatI2VRequest`（num_frames 覆盖）；`buildLongCatContinueRequest`（缺源视频 URL null、width/height/fps 空值省略由后端 ffprobe 对齐）；`buildAceMusicRequest`（tags 映射主提示词）；`buildEngineSubmit` 六路分发 + 缺素材本地校验文案；SUPPORTED 白名单六引擎可选。M10.3 UI describe ×2：h3-t2v 抽屉渲染 loras 字段，选 2 个 LoRA + 步进一次强度（0.6→0.65）后提交 `submitH3T2V` 携 loras 数组；非 H3 引擎（txt2img）不渲染 loras 字段 |
| `features/generate/__tests__/loras-field.test.tsx` | 8（+8，新套件） | `LorasField` 组件：options 空兜底显式提示（H3 实例不可达声明态）；选项行 + R18 标 + 计数「已选 n/3」；点选追加 `{name, strength:0.6}` / 再点取消；选中项展示强度步进器（默认 0.60）未选中不展示；plus/minus 按注册表 step ±0.05；强度钳 [0.5,1.0] 边界（0.5 不可再减、1.0 不可再加，浮点规整 2 位小数）；选满 3 个未选项 capped 禁用（accessibilityState.disabled + 点按不追加，已选项仍可取消）；非数组脏值按空数组渲染 |

**架构决策（防回归记录）**

1. loras 第 6 类动态字段落地 `LorasField`（`ParamSheet` 按 `param.type==='loras'` 分发）：多选 ≤3 与后端 `h3_studio.py _MAX_LORAS` 同源；RN 无原生滑杆，强度以 +/- 步进器承载，步进/区间取注册表 `param.step/min/max`（0.05 / 0.5-1.0），结果 `Math.round(×100)/100` 规整防 0.6+0.05 浮点尾差；强度缺省 0.6 为 H3LoraInput 作者推荐值（组件内本地常量，避免组件反向依赖屏幕模块产生循环引用）。
2. capped 语义：选满 3 个仅**未选项**禁用（`accessibilityState.disabled` + 透明度 0.5 + 点按不追加），已选项仍可取消；构建期 `parseLoraValues` 再兜一层（非数组/缺 name 剔除、缺 strength 补 0.6、钳 0.5-1.0），与 UI 层双保险对齐后端 `max_length=3` 422 兜底。
3. schema 未暴露字段一律不传：H3 无 fps/cfg（模板锁 24fps）、LongCat 无 cfg（蒸馏链路固定 1.0）、ACE `tags` 映射主提示词 `positive` 入参位；`longcat-continue` 的 video 走「产物 URL 文本」路径（注册表 text 参数），本地校验非空走 M8 既有 `formError` 通道。
4. `uploadKindForEngine` 单一映射源扩展：`h3-i2v→h3_i2v`（独立上传通道）、`longcat-i2v→ltx_i2v`（复用 ltx 通道，对齐 Web GenerateView 回落）；i2v 类引擎 image/worker 必填契约由构建器 null + 路由层本地校验文案保证，不发无效请求。
5. 提交路由白名单收口：`SUPPORTED_VIDEO_ENGINE_IDS` 9 个（M9 四引擎 + M10 五引擎）、`SUPPORTED_AUDIO_ENGINE_IDS` 1 个（ace-music，音频 kind 引擎唯一接入项）；未接入引擎芯片维持 M9 禁用态语义不变。
6. **踩坑：RNTL v14 全异步 API**——`render`/`rerender`/`fireEvent.*` 均返回 Promise 且内部 `await act()`；Red 阶段测试按 v12 同步写法未 await，导致「overlapping act() calls」跨用例污染（后续用例 render 结果残缺、查询莫名落空，单跑均绿连跑翻车）。修复测试层全量 await（render/rerender/fireEvent.press），组件实现不变；与既有套件 `await render(...)` 写法拉齐。

**已知噪音（非失败）**：同 M4–M9——TanStack Query notifyManager 的 batch 定时器在用例结束后触发 act 提示并使 worker 延迟退出；用例全部通过，后续可引入全局 fake-timers 或 unmount 收尾消除。

---

## 2026-08-14 · M9 里程碑回归（SFW 视频引擎接入：ltx25-t2v / ltx25-i2v / wan-animate / wan-vace）

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 18 passed, 18 total
Tests:       219 passed, 219 total（较 M8 口径 177 净增 +42）

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   94.73 |     92.4 |   95.16 |   95.39 |
  api.ts      |   93.85 |    93.06 |   96.42 |      94 |
```

**本里程碑变更与新增用例（净增 +42）**

| 套件 | 用例数（净增） | 覆盖点 |
|---|---|---|
| `lib/__tests__/api.test.ts` | 62（+17，另整合既有 422 用例） | SFW 视频引擎链路 describe：`submitLtx25T2V` POST `/api/ltx25/t2v`（请求体序列化、长超时档 30s 不中止/180s 到点人话）；视频提交 422（FastAPI detail 数组）展开首条 msg、detail 字符串透传（对齐 Web `_postLtx25/_postWan`）；`submitLtx25I2V`（image/worker/strength）；`submitWanAnimate`（image/video/worker）；`submitWanVace`（images 数组 + 第一张落点 worker）；`uploadVideo` POST `/api/upload?kind=wan_animate&worker=<钉点>`（字段名固定 image、三段式直传不手设 Content-Type、无钉点 qs 仅 kind、fileName 缺失按 mimeType 推扩展名 quicktime→mov、413 >200MB 透传后端人话）；`uploadImage` 第三参 pinWorker（wan-vace 第 2-4 张钉第一张落点、缺省不带 worker M8 行为不变）；`uploadKindForEngine` it.each ×5（wan-animate→wan_animate / wan-vace→wan_vace / ltx25-i2v→ltx_i2v / img2img→img2img / txt2img→img2img 兜底，对齐 Web GenerateView uploadKind 映射） |
| `features/generate/__tests__/generate-screen.test.tsx` | 44（+26） | M9.2 纯逻辑 describe ×16：`buildLtx25T2VRequest`（schema 默认值全量、空 negative/seed 省略、编辑中 `''` 回落 default、seed 文本转整数）；`buildLtx25I2VRequest`（无参考图 null、有参考图携 image/worker + strength 默认 0.7 可覆盖）；`buildWanAnimateRequest`（缺参考图或缺驱动视频 null、image/video 互钉 worker 取参考图落点、wan 数值键全量、视频钉别 worker 构建期不纠由联动清理负责）；`buildWanVaceRequest`（空数组 null、images filename 数组 + 第一张落点 worker）；`buildEngineSubmit` 路由（四引擎分发、缺素材返回本地校验文案、未知引擎不兜底）；`syncVideoWithRefImage`（参考图换 worker 强制清空已钉视频、同 worker 保留）。M9.3 UI describe ×9：4 个 SFW 视频引擎芯片可选、h3-t2v 未接入禁用态点击不切换选中；wan-animate 完整链路（参考图 + 驱动视频 → submitWanAnimate 携互钉句柄）；wan-vace 多图上传钉点；ltx25-i2v 参考图缺失本地校验。既有「引擎过滤」用例改造为「列表放开 + 禁用态」 |
| `features/generate/__tests__/ref-image-field.test.tsx` | 12（+0，适配改造） | mockUploadImage 调用断言补第三参 undefined（pinWorker 缺省），行为不变 |

**架构决策（防回归记录）**

1. 引擎列表过滤从 `kind==='image'` 放开为「图像 + 移动端已接入视频引擎白名单」（ltx25-t2v / ltx25-i2v / wan-animate / wan-vace）；h3-t2v / longcat 等未接入引擎渲染禁用态芯片（降透明度 + 点按不切换选中 + 触觉不触发），与 Web 端「未接入置灰」语义对齐。
2. 提交路由集中纯函数 `buildEngineSubmit(engine, values, positive)`：按引擎 id switch 分发到四个 `build*Request`；缺必填素材（i2v 参考图 / wan-animate 参考图+驱动视频 / wan-vace 多图）构建器返回 null，路由层转 `{ok:false, error:'请先上传…'}` 走 M8 既有 `formError` 本地校验通道（Warning 触觉），不发请求。
3. 互钉约束与 Web 同源：wan-animate 驱动视频上传钉参考图落点 worker（`ParamSheet` 由参考图值派生 `videoPinWorker` 传入 `RefVideoField`）；wan-vace 第 2-4 张图钉第一张落点（`RefImagesField` 内部 `pin = values[0]?.worker`）；参考图换 worker 后 `syncVideoWithRefImage` 强制清空已钉视频（构建期不纠，联动在 UI 层清理）。
4. `uploadVideo` 复用 M8 `apiFetch formData` 通道：RN FormData 三段式 `{uri,name,type}`，字段名沿用 `image`（后端 `upload.py` 单一字段名），**不手设 Content-Type**；200MB 移动网络走 `long: true` 超时（180s），四个视频提交端点同档。
5. `apiFetch` 422 解析扩展：FastAPI 校验错误 `detail` 为数组时展开首条 `msg`（对齐 Web `_postLtx25/_postWan` 行为），字符串 detail 透传不变——既有 422 用例随之整合到本链路 describe。
6. Expo v57 视频选择：`ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'] })`（数组语法），asset 携 `uri/fileName/fileSize(字节)/duration(毫秒)/width/height/mimeType`；`RefVideoField` 客户端先验扩展名白名单 mp4/mov/webm + ≤200MB（与后端 `upload.py` 同源），`RefImagesField` 多选 `allowsMultipleSelection + selectionLimit = max - 已选数`。
7. `uploadKindForEngine` 单一映射源：wan-animate→wan_animate / wan-vace→wan_vace / ltx25-i2v→ltx_i2v / 其余兜底 img2img（与 Web GenerateView 逐键对齐，it.each 全量锁定）；`ParamSheet` 按当前引擎派生 `uploadKind`，`images` 型参数 `max>1` 走 `RefImagesField`、单图走 `RefImageField`、`video` 型走 `RefVideoField`。

**已知噪音（非失败）**：同 M4–M8——TanStack Query notifyManager 的 batch 定时器在用例结束后触发 act 提示并使 worker 延迟退出（LibraryScreen 用例）；用例全部通过，后续可引入全局 fake-timers 或 unmount 收尾消除。

---

## 2026-08-12 · M8 真机验证收口（EAS Build preview）

**关键修复**

- `eas login` 后成功关联 Expo 账号 `wineryz`，执行 `npx eas init` 创建并关联项目 `@wineryz/Mobile`（ID: `de011fd1-f9ae-4a30-86cb-6485c2f0f809`）。
- 修复 EAS Build 重复失败的 **Install dependencies** 阶段：
  1. 添加 `.npmrc`：`legacy-peer-deps=true`（云端 `npm ci` 因 peer dependency 冲突退出）。
  2. 降级 `react-native-nitro-modules`：`^0.36.5` → `0.35.9`，与 `react-native-mmkv@4.3.2` 的 devDependencies 对齐，避免 Nitro 版本不匹配。
  3. `eas.json` 增加 `cli.version: 21.8.0` 与全 profile 的 `node: 22.14.0`，锁定构建环境。
  4. `app.json` 补全 `ios.bundleIdentifier` 与 `android.package`（`com.toiv.mobile`），修复 `ios.icon` 指向目录 `./assets/expo.icon` 的问题（改为 `./assets/images/icon.png`）。
- 前两次构建失败在 Install dependencies；第三次构建成功通过依赖安装并进入 native 编译，最终生成 Android internal distribution APK。

**构建结果**

```
$ npx eas build --profile preview --platform android --non-interactive
...
✔ Build finished
🤖 Open this link on your Android devices (or scan the QR code) to install the app:
https://expo.dev/accounts/wineryz/projects/Mobile/builds/2ac13ea2-3aad-4c10-8405-9c109d032630
```

**回归（构建配置改动后）**

- `tsc --noEmit` 0 错误 · `expo lint` 0 警告
- `jest --coverage`：18 套件 / 177 用例全通过

---

## 2026-08-12 · M8 里程碑回归（img2img 参考图上传）

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 18 passed, 18 total
Tests:       177 passed, 177 total（较 M7 口径 152 净增 +25）

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   95.08 |    93.47 |   94.54 |   95.87 |
  api.ts      |    94.5 |    95.06 |   95.23 |    94.8 |
```

**本里程碑变更与新增用例（净增 +25）**

| 套件 | 用例数（净增） | 覆盖点 |
|---|---|---|
| `lib/__tests__/api.test.ts` | 43（+7） | 图生图链路 describe：`uploadImage` POST `/api/upload?kind=img2img`（FormData 直传不手设 Content-Type、RN 文件三段式 `{uri,name,type}` 挂 `image` 字段、fileName 缺失按 mimeType 推扩展名、kind 自定义经 encodeURIComponent、415 三重白名单透传后端 detail）；`submitImg2Img` POST `/api/generate/img2img`（image/worker/denoise/steps 序列化、503 指定 worker 缺模型走 5xx 兜底人话） |
| `features/generate/__tests__/ref-image-field.test.tsx` | 12（新套件） | 无值渲染上传按钮+hint、有值渲染缩略图+文件名+移除按钮、移除回调 onChange(null)、点按调系统相册（`launchImageLibraryAsync({mediaTypes:['images'],quality:1})`）、相册取消不上传、扩展名先验拒 gif、体积先验拒 >20MB、上传成功 onChange 携 `{filename,worker,previewUri,name}`、上传失败透传后端人话、上传中 loading 态禁重复点击（accessibilityState.busy/disabled）、fileName 缺失按 mimeType 兜底、相册打开异常兜底人话 |
| `features/generate/__tests__/generate-screen.test.tsx` | 18（+6） | img2img describe：img2img 引擎出现在列表、选中后参数抽屉渲染 `images` 参考图上传区域、无 width/height 参数时画幅比例预设隐藏；`buildImg2ImgRequest` 纯函数（参考图句柄 image/worker + denoise/steps/cfg/seed/negative 序列化）；`buildTxt2ImgRequest` 纯函数（width/height/steps/cfg/batch_size 全量提交、空字符串省略）；未上传参考图提交 → 本地校验「请先上传参考图」+ Warning 触觉 |

**架构决策（防回归记录）**

1. 参考图链路对齐 Web `RefImageUpload`「选中即传」：系统相册选图（Expo v57 `launchImageLibraryAsync`，启动无需运行时权限）→ 客户端先验（扩展名白名单 jpg/jpeg/png/webp + ≤20MB，与后端 `upload.py` 三重白名单同源）→ `POST /api/upload` 拿 `{filename, worker}` 句柄 → 本地 uri 预览。提交时 `buildImg2ImgRequest` 消费句柄（生成与参考图必须同 worker，`generate.py resolve_worker`）。
2. `apiFetch` 新增 `formData` 选项：multipart 直传 FormData，**不手设 Content-Type**（边界由运行时生成，否则后端 `UploadFile` 解不出字段），与 `body` 互斥且优先；20MB 移动网络走 `long: true` 超时（180s）。
3. `isSubmittableImageEngine` 过滤从「排除 images 参数引擎」放开为「仅排除 audio 参数引擎」——images 型由 `engineNeedsRefImage` 分流走 img2img 提交链路；`ParamSheet` 画幅比例预设仅在 schema 含 `width/height` 时显示（img2img 引擎无尺寸参数，输出尺寸随参考图）。
4. 本地校验错误与服务端错误分流：`formError` 状态承载客户端先验文案（「请先上传参考图」），与 mutation 的 ApiError 人话横幅共存；触发时附 Warning 触觉反馈。
5. RN FormData 文件上传用三段式 `{uri, name, type}`（运行时不读 Blob）；jest 下断言用 `jest.spyOn(FormData.prototype, 'append')`——`FormData.getParts` 在 RN FormData polyfill 不存在。

**已知噪音（非失败）**：同 M4–M7——TanStack Query notifyManager 的 batch 定时器在用例结束后触发 act 提示，用例全部通过；worker 进程延迟退出警告同上。

---

## 2026-08-12 · M7 里程碑回归（版本链精确重生 + 引擎参数动态表单）

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 17 passed, 17 total
Tests:       152 passed, 152 total（较 M6 口径 135 净增 +17）

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   96.26 |     94.4 |   94.23 |   97.28 |
```

**本里程碑变更与新增用例**

| 套件 | 用例数（净增） | 覆盖点 |
|---|---|---|
| `lib/__tests__/api.test.ts` | 36（+5） | 版本链 API describe：`rerunJob` POST `/api/jobs/{key}/rerun`（key 经 encodeURIComponent、默认空体 keep 语义、seed_mode/seed/overrides 序列化、400 无快照/类型不支持透传后端 detail）；`fetchVersions` GET `/api/jobs/{key}/versions`（原样返回、404 人话） |
| `features/library/__tests__/artifact-detail.test.tsx` | 15（+5） | 版本链 >1 渲染横向条带、点按他版本回调 `onSelectVersion`、当前版本不重复触发；`has_params=false` 不显示重新生成入口；RerunSheet 选随机种子确认 → `rerunJob` 提交 → 成功关闭并跳作业屏；失败人话入抽屉 |
| `features/generate/__tests__/generate-screen.test.tsx` | 12（+6） | 动态表单 describe：schema 渲染齐备（select chips/number/text/textarea）且 width/height 由画幅预设承载不重复渲染；select 底模+seed 文本转整数进请求体；number 越界失焦 clamp 上限、清空回落 default；切换引擎表单重置为新引擎默认值；seed 非法文本省略；作品库复用草稿 focus 回填（一次性消费） |

**架构决策（防回归记录）**

1. `ParamSheet` 自 M7.4 起由 `EngineInfo.params` 驱动：`text/textarea/number/select/switch` 五型渲染器，`images/audio/loras` 不渲染（此类引擎已被 `isSubmittableImageEngine` 过滤）；`width/height` 由画幅预设 chips 承载（`PRESET_KEYS` 跳过），避免双入口。
2. 表单序列化集中在导出纯函数 `buildTxt2ImgRequest`：number 键（width/height/steps/cfg/batch_size）所见即所送（`''` 回落 `param.default`）；字符串键（negative/ckpt_name/sampler/scheduler/style_preset）空串省略（`''` 语义 = 平台默认，交后端）；seed（text 型）仅非负整数提交，其余省略 = 随机。
3. 引擎切换表单重置用 React 19 渲染期间状态调整（`if (selectedEngine.id !== formEngineId) setFormValues(defaultParamValues(...))`），与 M5 `ArtifactDetail` 同一模式，不引入 effect。
4. 草稿回填消费接通：作品库「复用」`setDraft` 后跳 `/`，创作屏 `useFocusEffect` 消费（tab 常驻挂载，focus 时机正确；一次性 consume 即焚）。此前只有生产端无消费端，属功能缺口，本里程碑补齐。
5. `NumberField` 编辑中允许暂存 `''`（受控原文），失焦 `onEndEditing` 统一 clamp 到 `[min,max]` 并把空串回落 `param.default`——提交路径永远拿到合法数值。

**已知噪音（非失败）**：同 M4/M5/M6——TanStack Query notifyManager 的 batch 定时器在用例结束后触发 act 提示，用例全部通过；worker 进程延迟退出警告同上。

---

## 2026-08-12 · M6 里程碑回归（视频内嵌播放 + 作品库提量虚拟化）

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 17 passed, 17 total
Tests:       135 passed, 135 total（净增 +5）

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   96.22 |    94.35 |      94 |   97.25 |
```

**本里程碑变更与新增用例（净增 +5）**

| 套件 | 用例变化 | 覆盖点 |
|---|---|---|
| `features/library/__tests__/artifact-detail.test.tsx` | 10（含 M6 新增 2） | 视频 kind → `VideoStage` 内嵌 `VideoView`（`useVideoPlayer` source 拼 token、`nativeControls`、不渲染 Image/占位图标）；音频/3D → 图标占位不渲染播放器 |
| `features/jobs/__tests__/job-tracker.test.tsx` | 10（净增 +3） | done 态视频作业：类型图标占位（不渲染位图预览）+「查看详情」入口保留；done 态音频作业：同样回退图标占位 |
| `features/library/__tests__/library-screen.test.tsx` | 10（净增 +2） | `listJobs` 以 `{ limit: 200 }` 调用（`LIBRARY_LIST_LIMIT` 常量断言）；FlatList 虚拟化参数就位（initialNumToRender=12 / maxToRenderPerBatch=12 / windowSize=7 / removeClippedSubviews） |

**架构决策（防回归记录）**

1. `ArtifactDetail` 视频舞台为独立子组件 `VideoStage`：`useVideoPlayer` 是 hook，仅视频类产物挂载该子组件，避免为空 source 建 player 且保持 hook 数量恒定。jest 下 `expo-video` mock 为「`useVideoPlayer` 返回 `{ source }` 透传 + `VideoView` 透传 props 的 View」，断言 `player.source` 即拼 token URL。
2. `JobTracker` done 态预览分流：图像类位图预览；视频/音频/3D 回退类型图标占位 + 「已完成，点下方按钮查看与播放」引导——追踪模态只做轻量终态确认，完整播放/下载/删除进 `ArtifactDetail`，避免在追踪模态重复一套播放器。
3. 作品库提量 200 的依据：`apps/api/app/routes/jobs.py` `list_jobs` 源码 `limit: int = Query(default=50, ge=1, le=200)`，无 offset/cursor。一次拉满上限 + FlatList 虚拟化承载；后端若加分页再改 `useInfiniteQuery`（代码注释已标注）。
4. 作品库 queryKey 为 `['jobs', 'library']`，与作业屏 `['jobs']`（limit 50）隔离；删除失效走前缀 `['jobs']` 模糊匹配，两屏同时刷新。

**已知噪音（非失败）**：同 M4/M5——TanStack Query notifyManager 的 batch 定时器在用例结束后触发 act 提示（LibraryScreen），用例全部通过。

---

## 2026-08-12 · M5 里程碑回归（作品库 + 产物详情 + 作业详情追踪）

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 17 passed, 17 total
Tests:       130 passed, 130 total

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   96.22 |    94.35 |      94 |   97.25 |
```

**本里程碑新增测试套件（5）**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| `lib/__tests__/media.test.ts` | 3 | 下载成功+权限已授→保存相册（剥 query 文件名）、下载失败→「下载失败」人话、权限拒绝→「需要相册权限」且不写相册 |
| `stores/__tests__/generation-draft.test.ts` | — | 初始 null、setDraft→consumeDraft 一次性取出并清空、覆盖语义 |
| `features/library/__tests__/library-utils.test.ts` | — | kindToFilter 五分类映射（含未识别 kind→null）、kindLabel 中文映射、FILTERS 定义完整 |
| `features/library/__tests__/library-screen.test.tsx` | 8 | columnCount 断点（390→2 / 431→3 / 768→4）、collectArtifacts 只收 done+有产物、载态 spinner、空态语义、网格渲染+mediaUrl 拼 token、过滤 chips 计数与切换、分类空态、点卡开详情 |
| `features/library/__tests__/artifact-detail.test.tsx` | 8 | prompt/seed/类型徽章/大图、多产物缩略条切换、非图像图标占位、复用提示词（草稿 store + 跳创作屏）、下载成功拼 token URL、下载失败人话、删除二次确认+onDeleted 回调、删除失败对话框内错误 |
| `features/jobs/__tests__/job-tracker.test.tsx` | 8 | null/未知 id 不渲染、queued/running/error 三态舞台、done 产物预览拼 token、「查看详情」onRequestDetail 接管、关闭回调 |
| `features/jobs/__tests__/jobs-screen.test.tsx` | 7（净增 +2） | 点按 running 卡片→追踪模态；点按 done 卡片→直开产物详情 |

**架构决策（防回归记录）**

1. 后端无 `GET /jobs/{id}` 单作业端点（已读 `apps/api/app/routes/jobs.py` 源码确认：仅 list/delete/rerun/versions/events）。`JobTracker` 用 `useQuery({ queryKey: ['jobs'], enabled: false })` 读共享缓存派生单作业状态——作业屏 2s 轮询天然驱动详情实时刷新，零额外请求。
2. 作业屏复用作品库 `ArtifactDetail`（跨 feature 导入）：done 态点卡直开；非终态进 `JobTracker`，done 后「查看详情」接管到 `ArtifactDetail`（复用/下载/删除全能力）。
3. `ArtifactDetail` 保活与换作业重置从 `useEffect` 改为**渲染期间调整状态**（`if (job && job.id !== lastJob?.id) { setLastJob(job); ... }`）——React 19 官方推荐模式，修复 `react-hooks/set-state-in-effect` lint 错误。

**本里程碑修复的测试基建问题（防回归记录）**

1. `job-card.test.tsx` 经 `hasActiveJobs` 间接引入 `jobs-screen → ArtifactDetail → expo-router`（ESM 不可解析）：补 `expo-router` / `@/lib/media` 替身 mock。教训：**feature 屏互相复用组件后，所有间接依赖该屏的测试都需补齐下游 mock**。
2. 追踪模态打开后卡片仍在树下：同名文本（「生成中」/prompt）出现两处，断言用 `getAllByText(...).length >= 2` 而非 `getByText`。

---

## 2026-08-12 · M4 里程碑回归（创作主流程收口）

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 11 passed, 11 total
Tests:       89 passed, 89 total

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |    95.6 |    94.49 |   93.33 |   96.83 |
  api.ts      |   97.46 |    97.01 |   93.75 |   98.46 |
  config.ts   |     100 |      100 |     100 |     100 |
  mmkv.ts     |      80 |      100 |   66.66 |      80 |
  poll.ts     |   88.88 |    73.33 |   85.71 |   93.75 |
  auth.ts     |   97.14 |      100 |     100 |   96.77 |
  settings.ts |     100 |      100 |     100 |     100 |
```

**本里程碑新增测试套件（2）与扩展**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| `features/generate/__tests__/generate-screen.test.tsx` | 6 | 引擎过滤（仅可提交图像引擎）、空提示词禁发、默认 1:1 提交体（trim + negative undefined）、成功清空+横幅跳作业、ApiError 人话横幅、参数抽屉 3:4+负向词随提交体 |
| `features/jobs/__tests__/jobs-screen.test.tsx` | 5 | 空态、卡片流（徽章/prompt/相对时间）、done 缩略图（mediaUrl 拼 token）+数量角标、失败重试（同 prompt 重提交+失效刷新）、非失败无重试 |
| `features/jobs/__tests__/job-card.test.tsx` | 10 | formatRelativeTime 五档（刚刚/N分钟/N小时/M-D/非法）、hasActiveJobs 轮询开关（queued/running 活跃，done/error/空/undefined 不活跃）、JOB_STATUS_META 四态全覆盖、error 无 onRetry 不渲染动作、done 无产物回退占位 |
| `lib/__tests__/api.test.ts` | 30（净增 +11） | 新增「mediaUrl 拼 token」（相对/绝对/已有 qs/未登录/空路径）与「生成主流程」两 describe：fetchEngines 容错回落、submitTxt2Img POST 体、listJobs qs 拼接（limit/status 编码）、deleteJob 路径编码与 404 人话 |
| `components/ui/Icon.tsx` | — | 注册表新增 ArrowUp/CircleCheck（创作屏反馈横幅） |

**本里程碑修复的测试基建问题（防回归记录）**

1. TanStack Query v5 `mutationFn` 会被透传第二参 `{ client, meta, mutationKey }`：业务侧显式包装 `mutationFn: (params) => submitTxt2Img(params)`，防止 API 函数收到契约外参数，且让 mock 断言只验证纯请求体。
2. 跨模块 `instanceof` 不可靠（`jest.mock('@/lib/api')` 的替身类与 `jest.requireActual` 构造的实例不相交）：错误判别改 `name === 'ApiError'` 鸭式判定，与 mock 替身兼容。
3. RNTL v14 `render` 是 async（内部 act，`setRenderResult` 在 await 之后才执行）：任何渲染辅助函数必须 `await`，否则全局 `screen` 报 `` `render` function has not been called ``。
4. `expo-image` 原生组件在 jest 下 source 不可断言：测试内 mock 为透传 props 的 View 替身（与 lucide 替身同理）。
5. 文本断言优先 `getByText`（RNTL 拼接 JSX 子节点），不断言 `props.children` 结构（`{'×'}{2}` 会被拆成 `['×', 2]`）。

**已知噪音（非失败）**：TanStack Query notifyManager 的 batch 定时器在用例结束后触发 console.error/act 提示并使 worker 延迟退出；用例全部通过，后续可引入全局 fake-timers 或 unmount 收尾消除。

---

## 2026-08-12 · M3 里程碑回归（应用骨架收口）

**命令输出（截取）**

```
$ npx tsc --noEmit
（无输出，0 错误）

$ npx expo lint
（无输出，0 错误 0 警告）

$ npx jest --coverage
Test Suites: 8 passed, 8 total
Tests:       54 passed, 54 total

File          | % Stmts | % Branch | % Funcs | % Lines |
--------------|---------|----------|---------|---------|
All files     |   95.18 |    93.47 |    92.5 |   96.52 |
  api.ts      |   96.82 |       96 |    90.9 |   98.03 |
  config.ts   |     100 |      100 |     100 |     100 |
  mmkv.ts     |      80 |      100 |   66.66 |      80 |
  poll.ts     |   88.88 |    73.33 |   85.71 |   93.75 |
  auth.ts     |   97.14 |      100 |     100 |   96.77 |
  settings.ts |     100 |      100 |     100 |     100 |
```

**测试套件清单（8）**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| `lib/__tests__/api.test.ts` | 7 + 12 | 登录 token 字段映射、Bearer 注入、X-NSFW 头、401/403/404/429/500/未知状态人话、非 JSON 错误体、204、绝对 URL、无 token 无 Authorization、POST 序列化、nsfw 单次覆盖、内部超时 vs 外部取消 |
| `lib/__tests__/config.test.ts` | 6 | 基址优先级（覆盖 > extra > 默认）、trim/空白清除、生产回环防呆（localhost/127.0.0.1/真实域名/dev 放行） |
| `lib/__tests__/poll.test.ts` | — | 指数退避、中止（PollAbortedError）、onUpdate 成功/失败回填 |
| `stores/__tests__/settings.test.ts` | — | 色板/深浅模持久化、apiBase/nsfw 桥接 lib 模块态、水合副作用 |
| `stores/__tests__/auth.test.ts` | — | 无 token → signedOut、me 校验成功 → signedIn、401 清理踢出、弱网缓存兜底 |
| `components/ui/__tests__/Icon.test.tsx` | 4 | 注册表渲染、主题色回落、默认描边 1.75、可访问性标签 |
| `features/profile/__tests__/profile-screen.test.tsx` | 5 | 用户卡片、五色板勾选态、换肤写 store、模式切换、退出登录清会话 |
| `test/__tests__/rntl-probe.test.tsx` | — | RNTL v14 异步 render 探针 |

**本里程碑修复的测试基建问题（防回归记录）**

1. `jest.mock` 工厂内禁用 TS 参数属性（`constructor(public x)`）——babel-jest-hoist 作用域检查会报 `Invalid variable access`。改写为先声明字段再赋值。
2. tsconfig 显式 `"types": ["jest", "react"]`——expo/tsconfig.base 未声明 types 时 jest 全局（describe/it/expect/jest 值）未注入。
3. 测试文件中的 `global.fetch` 统一改 `globalThis.fetch`（无 @types/node 环境下类型安全）。
4. `tabBarIcon` 回调的 `color` 在 RN 0.86 类型为 `ColorValue`，与 Icon 的 `string` 边界处显式 `as string`。
5. lint 口径统一：`readonly T[]` 替代 `ReadonlyArray<T>`、空 catch 绑定制止未用变量、测试文件 imports 置顶（jest.mock 由 babel 提升，语义不变）。

**已知噪音（非失败）**：ProfileScreen「退出登录」用例中 zustand 异步 set 触发 React `act(...)` console.error 提示；用 `waitFor` 断言终态，不影响结果，后续可在 RNTL 升级后消除。
