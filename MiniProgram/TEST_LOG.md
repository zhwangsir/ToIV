# TEST_LOG.md — MiniProgram

- 2026-08-27 library buckets a95e174
- image: qwen_edit drama_grid_storyboard drama_scene_layout drama_char_reference_*
- video: h3_multishot video_upscale transition video_edit keyframe_chain drama_shot_video* drama_shot_lipsync
- audio: manju_voice
- 3d: threed_material threed_render threed_texture cad_*
- still other: chromakey i2l motion_brush wan_animate wan_animate2
- tests 590 passed, typecheck pass; Mobile archived; ACE-Step not on remote

- 2026-08-27 创作页引擎追上现役注册表（main `f261f45`）：新增 qwen-image-edit / h3-multishot / wan-transition / keyframe-chain / vace-edit / wan-animate-2 / wan-nsfw-i2v；移除 ltx25-*。vitest 580 passed。作品库新 kind 仍进「其他」。Expo Mobile 仍是归档，不是在维护的客户端。

- 2026-08-27 移动端合并：本目录成为 ToIV 唯一客户端；Expo Mobile 归档到 `../.archive/mobile-expo-20260827/`。能力以现有 MP1–MP32 为准，未宣称微信真机走查完成。

- 2026-08-27 项目管家文档治理：根目录收敛为 5 件套。

# ToIV MiniProgram 测试日志

> 技术栈：UniApp 3.0 (vite5) + Vue3 `<script setup lang="ts">` + TS strict + Pinia + vitest
> 质量门：`npm run typecheck` / `npm run lint`（--max-warnings=0）/ `npm run test` / `npm run build:mp-weixin` / `npm run build:h5`

---

## 2026-08-16 · MP32 登录页原生 button 重写 + 微信登录恢复

**目的**：绕开 MP31 回退根因（uni 编译器对自定义组件 `<Button @click>` 的 prop 事件映射在微信渲染层不可靠，按钮无响应），恢复微信一键登录。

**实现**

- `src/pages/login/login.vue`：提交钮/微信 CTA 全部改用原生 `<button @tap>`（内建组件直绑原生触摸事件，不经 prop 映射）；微信 CTA `#ifdef MP-WEIXIN` 条件编译仅微信端渲染（链路 uni.login→code→/auth/wechat→store.signInWithWechat）；样式复位（`::after` 描边清除）+ hover-class 按压态 + 设计令牌对齐 ui-btn primary block。

**走查脚本同步**

- H5 `ux-walkthrough-h5.mjs`：C1/R18 登录选择器 `.login__form .ui-btn` → `.login__form .login__submit`（2 处）。
- 微信 `mp-walkthrough-weixin.cjs`：W1 改原生按钮 `page.$('.login__submit').tap()`；W1.1 断言新增微信 CTA 在册（wechat=true）。

**数字（全绿）**

- `vue-tsc --noEmit`：0 错误；`eslint --max-warnings=0`：0 警告；`vitest run`：26 套件 **565 用例**全绿
- 四端构建：h5 + mp-weixin + mp-alipay + mp-toutiao 全 DONE；H5 产物 grep 无「微信一键登录」（条件编译剔除），mp-weixin wxml 含 login__wechat/login__submit
- H5 走查：**111/111**（C1 登录原生 button 提交通过）
- 微信走查：**30/30**（W1.1 微信 CTA/邮箱/密码/登录钮直渲全在册，W1.2 原生 button tap → reLaunch 创作页通过；mock 定向包验证后恢复真实基址 192.168.71.47:8090，grep 核验无 mock 残留）

---

## 2026-08-15 · 交付前全量回归（MP1-MP31 收口）

**目的**：交付前最终验证 + 代码优化（清理调试日志）。

**代码优化**

- `src/stores/auth.ts`：删除 `signInWithWechat` 内调试 `console.log/console.error`（MP31 回退后残留的 3 条），恢复与 `signIn` 逐行对齐的干净实现。

**数字（全绿）**

- `vue-tsc --noEmit`：0 错误
- `eslint --max-warnings=0`：0 警告
- `vitest run`：26 套件 **565 用例**全绿
- 四端构建：h5 + mp-weixin + mp-alipay + mp-toutiao 全 DONE
- H5 走查：**111/111**
- 微信端走查：**30/30**（mock 定向包；走查后恢复真实基址 192.168.71.47:8090，grep 核验无 mock 残留）

**文档交付**

- `docs/UAT.md`：47 项用户验收用例 100% 通过
- `docs/DELIVERY.md`：交付清单（功能模块/质量指标/部署说明/后续项）

---

## 2026-08-15 · MP31 回退（微信登录 → 纯账密登录）

**回退原因**

微信登录链路（`wx.login` → code → `POST /api/auth/wechat` → 200 token）经自动化通道实测**完全通畅**（生产后端 192.168.71.47:8090 返回 200），但**渲染层按钮事件绑定不可靠**：`uni` 编译器把 `<Button @click>` 映射为 `onClick` prop，在开发者工具 webview 渲染层点击无响应（Console 无日志、网络无请求）。`uni.login` 在 touristappid 下能拿 code、后端端点正常，但用户点按钮没反应——UX 效果差，不可用。

**回退内容**

- `src/pages/login/login.vue`：恢复 MP2 纯账密登录（zod 校验/密码可见/提交态原逻辑不动，无折叠直渲）；移除微信登录 CTA、折叠切换、`handleWechatLogin`、相关 console 日志。
- `src/utils/wechat-login.ts`：删除（流程封装文件）。
- `src/stores/auth.ts`：`signInWithWechat` action 保留备查（后端端点仍在，未来若修编译器事件映射可快速恢复）。
- `src/api/index.ts`：`wechatLogin` 保留备查。
- `tests/wechat-login.test.ts`：删除（8 用例）。
- `tests/api-index.test.ts`：删除 `wechatLogin` describe 块（3 用例）。
- `tests/stores.test.ts`：删除 `signInWithWechat` 2 用例。
- `scripts/mock-server.mjs`：删除 `POST /api/auth/wechat` 端点。
- `scripts/ux-walkthrough-h5.mjs`：C1 改回直接填表（无折叠展开）；删除 C34.1-C34.3 微信降级 3 检查点；R18 重登选择器同步适配。
- `scripts/mp-walkthrough-weixin.cjs`：W1 改回纯账密直渲断言（无折叠展开）。

**回归数字（全绿）**

- `vue-tsc --noEmit`：0 错误
- `eslint --max-warnings=0`：0 警告
- vitest：26 套件 **565/565**（较回退前 578 净减 13，全部为微信登录相关用例移除）
- H5 走查：**111/111**（较回退前 114 净减 3，全部为 C34 微信降级检查点移除）
- 微信走查：**30/30**（W1 纯账密直渲断言通过）
- 四端构建：h5 + mp-weixin + mp-alipay + mp-toutiao 全 DONE；dist 已恢复真实后端基址 192.168.71.47:8090（grep 核验无 mock 残留）

**保留备查**

后端 `POST /api/auth/wechat` 端点（dev bypass 已部署 core）、`store.signInWithWechat`、`api.wechatLogin` 均保留。未来若 uni 修复 `<Button @click>` prop 事件映射或改用原生 `button` 组件重写登录页，可快速恢复微信登录。

---

## 2026-08-15 · MP31 里程碑（微信登录改造·前端侧：微信登录主 CTA + 账密折叠兜底）

**背景**

登录页此前仅账密表单（MP2）。小程序主战场是微信，账密登录对微信用户心智过重。后端新端点 `POST /api/auth/wechat` 并行开发中（契约已定：请求 `{code, nickname?}`，响应与 `/auth/login` 完全同形 `{token, user}`；dev 过渡 `TOIV_WECHAT_DEV_BYPASS=1` 时 code 直通，openid=`dev-{code}`；微信侧 `wx.login` 在 touristappid 下开发者工具模拟器也能返回 code）。本里程碑把登录页改造为「微信登录为主 + 账密折叠兜底」，前端侧全链路收口，待后端就绪后用户点一次微信登录即可冒烟。

**契约要点**

- 上行：`POST /api/auth/wechat` body `{code}`（code 来自 `uni.login({provider:'weixin'})`；nickname 可选本期不带）；响应 `{token, user}` 同形复用，`token` 落库方式逐行照抄 `login()`（缺 token 协议守卫 → ApiError(0)）。
- 错误：uni.login 失败/缺 code → 人话 reject；接口 401/502/503 由 apiFetch 人话体系透传（detail 首条展开）→ 页面表单级错误条（复用 `login__form-error`），不 crash。
- H5 等端拿不到微信 code，降级方案二选一取「按钮照渲染 + 点击 showModal 提示『H5 端请使用账号密码登录』+ 自动展开账密区」——比「H5 不渲染」更顺（用户得知原因且表单已就位），C34/单测双路钉死。

**改动清单**

- `src/types/api.ts`：`WechatLoginRequest{code,nickname?}`（对齐现有 DTO 风格）。
- `src/api/index.ts`：`wechatLogin(code)`（POST /api/auth/wechat + 协议守卫 + setToken，照抄 login）。
- `src/stores/auth.ts`：`signInWithWechat(code)`（wechatLogin → setJson 缓存 → 状态落定，与 signIn 逐行对齐；restore/signOut 不动）。
- `src/utils/wechat-login.ts`（新）：`requestWechatCode`（uni.login promise 化）/ `signInWithWechatFlow`（取 code → 换 token 调用序）/ `promptWechatUnsupported` + `WECHAT_LOGIN_UNSUPPORTED_HINT` 文案常量。
- `src/pages/login/login.vue`：微信主 CTA（accent 填充 block 大钮，icon=`message-square`——lucide 无微信品牌图标，复用白名单最贴近项，零新增 SVG）；账密区默认收起，居中文字链「使用账号密码登录」（text-secondary + chevron 翻转），展开后文案变「收起」，原账密表单（zod/密码可见/handleSubmit）零改动包进 `.login__password` 容器；错误条上移至折叠区外（双路径失败均可见）；`#ifdef MP-WEIXIN` 走 code 换 token → reLaunch 创作页，`#ifndef MP-WEIXIN` 走降级 modal + 自动展开。
- `tests/helpers/mock-uni.ts`：补 `login`（setLoginResult/setLoginError/allLoginCalls）与 `showModal`（allModals，默认确认）mock。
- `scripts/mock-server.mjs`：POST /api/auth/wechat（非空 code → 复用 login 的 `{token:'mock-token-ux',user}`；空 code 422「code 不能为空」）。
- `scripts/ux-walkthrough-h5.mjs`：C1/R18 重登适配折叠（先点 `.login__password-toggle`，提交钮收窄 `.login__password .ui-btn`）+ 新增 C34（独立未登录上下文）。
- `scripts/mp-walkthrough-weixin.cjs`：W1 适配（W1.1 微信主钮存在性 + 折叠展开后三件套，宿主 label 精确匹配防「登录」误中「微信登录」；W1.2 折叠区账密登录）。

**测试矩阵（vitest，TDD 先 RED 后 GREEN）**

- api-index +3：wechatLogin 请求体/URL/token 落库、缺 token 协议守卫、401 人话透传。
- stores +2：signInWithWechat 成功（状态/缓存/重启弱网兜底会话保持）、失败（状态不变 + 错误抛出 + token 未写）。
- wechat-login.test 新文件 +8：取 code 三态（成功 provider=weixin / fail 人话 / 缺 code 人话）、调用序（login → POST /api/auth/wechat，login 失败短路不发请求）、401 会话不落定、modal 文案/形态钉死。
- 全量：27 套件 578 用例全绿（较 MP30 口径 565 净增 +13）。

**走查结果（本轮实测）**

- H5：114/114 全绿（111 + C34.1 微信主 CTA 渲染+账密区默认收起 / C34.2 点击 → 降级 modal 文案+账密区自动展开 / C34.3 折叠区账密登录成功跳创作页；既有全数无回归）。
- 微信（mock 定向包 + 开发者工具 9420）：30/30 全绿（W1.1 微信主钮存在 + 折叠展开三件套 / W1.2 折叠区账密登录 reLaunch；模拟器 wx.login touristappid 行为不确定，自动轮按既定方案走账密兜底）。

**回归矩阵（本轮实测）**

- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警；vitest 27 套件 578 全绿。
- 四端构建 h5 / mp-weixin / mp-alipay / mp-toutiao 全 DONE；微信走查后 dist 已重建恢复真实基址 `192.168.71.47:8090`（grep 核验无 127.0.0.1:9800 残留）。

**踩坑记录**

1. **mock-server.mjs Edit 缓存失步第六次复发**：Edit 回执成功、Read 可见新内容，但磁盘无 `/api/auth/wechat`（grep exit=1 取证，wc/md5 与磁盘内容对不上）。按固化流程 node fs 补丁脚本直写 → wc -l（1334→1349）+ md5 + node --check + grep + curl 三态（非空 200 / 空串 422 / 缺字段 422）交叉验证 → 重启进程。
2. **「登录」是「微信登录」子串**：H5 `:has-text("登录")` 与 mp `findHost includes` 都会误中微信主钮——H5 收窄为 `.login__password .ui-btn` 容器选择器，mp 改宿主 label 精确匹配（`t === '登录'`）。
3. **vue-tsc 下条件编译双分支均参与类型检查**：`#ifdef`/`#ifndef` 对 tsc 只是注释，两分支都须可编译（uni.login/showModal 均有 @dcloudio/types 声明，通过）；eslint 同理按源码全量检查，无未使用告警。

**manual 残留**

真实后端冒烟：待后端 `/api/auth/wechat` 就绪（dev 过渡 TOIV_WECHAT_DEV_BYPASS=1），用户在开发者工具点一次「微信登录」，随后自动执行冒烟回归（成功进创作页 / 401·502 错误条 / 账密兜底回归）。

---

## 2026-08-15 · MP9 里程碑 Round 1（微信开发者工具自动化走查：mock 后端全自动轮）

**背景**

MP8 建立了 H5 侧 Playwright 全自动走查（现 111 检查点），微信端长期只有「导入 dist 人工点验」一条路，MP19-MP30 累积的大量功能（对话助手 SSE/文档挂载/确认门/计划编辑/批量管理等）在微信端缺乏回归手段。本轮以 miniprogram-automator（连开发者工具自动化端口 9420）建立微信侧全自动走查，mock 后端（9800）+ mock 定向包（`VITE_API_BASE=http://127.0.0.1:9800` CLI 覆盖 .env.production，不污染真实配置），W1-W9 共 30 检查点对齐 H5 走查语义。Round 2 真机人工走查（渲染差异/相册/会话文件权限链路）仍待用户执行。

**设施与改动清单**

- `scripts/mp-walkthrough-weixin.cjs`（新）：W1 登录 / W2 创作页 / W3 提交+作业进度 SSE / W4 产物详情 / W5 作品库 / W6 资产库 / W7 对话助手 / W8 Agent 团队（含确认门裁决）/ W9 我的页，30 检查点 + `docs/ux-walkthrough-weixin/` 18 张截图。
- `scripts/mock-server.mjs`：①SSE 回放过滤——run 过确认门（resume 裁决后 status 非 `awaiting_*`）时剔除历史 `confirm_required` 帧；②error 场景进度帧 2→6 加密（扩 mp IPC 采样窗口）。
- 产品代码零改动（走查适配全部落在脚本与 mock 侧）。

**平台差异适配（automator 0.12.1 缺陷绕行，全部探针实证）**

- 导航：`mini.reLaunch/navigateTo` 的 changeRoute 把 `{url}` 二次包装且 wx.navigateTo success/complete 回调在自动化通道被吞 → 统一 `evaluate` 直发 wx API + `waitRoute` 轮询路由落定。
- 页面栈竞态：devtools 响应竞态下 `currentPage()` 抛 page stack 错（导航已实际发生）→ `curPage` 重试封装 + `tapNav` 收纳该特定错；`mustPage` 页面就绪轮询（报错带路由上下文）。
- 自定义组件影子树：`findHost/findHosts` 以 `u-i` 属性定位宿主 + `tapInner` 影子树内点击；`textOf` 三级文本抽取（text()→影子树文本节点→wxml 剥离兜底）。
- 选择器引擎：不匹配 `data-*` 裸存在性选择器（`[data-run-status]`→null），必须带值（`[data-run-status="done"]`）或类选择器定位后 `attribute()` 读取。
- 原生层：showToast/showModal 不入 WXML 树——toast 不断言，modal 用 `mockWxMethod` 自动确认（W9.3 退出登录）。

**走查结果（30/30 全绿，mock :9800 + 开发者工具 :9420，本轮实测）**

```
PASS  W1.1 登录页渲染 / W1.2 登录 → reLaunch 创作页
PASS  W2.1 引擎列表+默认选中 / W2.2 引擎抽屉（SFW 无 R18 徽标 engines=12）/ W2.3 参数抽屉 4 维
PASS  W3.1 txt2img 提交 → 作业页 / W3.2 SSE 进度条 pct 30→50 单调 / W3.3 done 收口（徽章已完成+产物图）/ W3.4 error 帧失败收口+无凭据作业全程无进度条
PASS  W4.1 点卡进详情 / W4.2 eventChannel 数据+预览 / W4.3 版本链 v1/v2 / W4.4 操作四件
PASS  W5.1 过滤芯片+23 卡 / W5.2 音频过滤服务端整库 5 卡 / W5.3 全选「已选 5 项」
PASS  W6.1 资产库入口 / W6.2 种子资产卡 / W6.3 新建弹层
PASS  W7.1 助手页空态 / W7.2 流式回复+生成图内联 / W7.3 停止后发送键恢复
PASS  W8.1 运行列表 3 卡 / W8.2 待确认过滤 / W8.3 详情 SSE 接力（done+动态流 7+图/视频）/ W8.4a 计划抽屉 3 任务 / W8.4b 确认通过徽章跃迁执行中
PASS  W9.1 用户信息 / W9.2 区块+API 基址行 / W9.3 退出回登录页
```

**回归矩阵（本轮实测）**

- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警；vitest 26 套件 565 用例全绿。
- H5 走查 111/111 无回归（mock confirm_required 过滤对 H5 无副作用——过滤仅在 run 已非 awaiting_* 时剔除已消费帧，与 H5 语义一致）。
- 四端构建 h5 / mp-weixin / mp-alipay / mp-toutiao 全 DONE；dist 已恢复真实基址 `192.168.71.47:8090`（四端核验无 127.0.0.1:9800 残留）。

**踩坑记录**

1. **W8.4b 徽章打回待确认（mp 100% 复现，H5 永不现）**：mock SSE 历史回放含已被消费的 confirm_required 帧，前端 onSseEvent 照单把徽章打回 awaiting——与 mock 自身状态机矛盾。H5 因 waitForSelector 能捕到 transient running 未暴露；mp IPC 采样延迟下必现。修 mock 回放过滤（过门即剔帧），产品代码不动。**二次教训：修复落盘后必须重启 mock 进程**——首轮修复文件 mtime 13:51 而进程 13:22 启动，旧代码无过滤，白跑一轮 29/30 才定位。
2. **mock server 后台化**：`nohup ... &` 在受管 shell 退出时仍被回收（ECONNREFUSED），须以长驻终端进程方式启动。
3. **W5.2 过滤桶选择**：「视频」桶在 mp 端时序下偶发计数抖动，改「音频」桶（服务端整库 5 卡）与 H5 C19.4 逐值对齐后稳定。
4. **助手回复文本断言**：`findByText` 穿不透影子树文本节点，`findByInnerText` 才命中——文本类断言统一走 textOf/innerText 路径。

**manual 残留（Round 2，待用户执行）**

导入 `dist/build/mp-weixin` 真机/模拟器人工核对：渲染差异、相册下载与 chooseMessageFile 会话文件权限链路、R18 引擎可见性随 NSFW 开关切换，及 MP17-MP30 各真机体验点（细目见 STATE.json next 字段）。

---

## 2026-08-15 · MP30 里程碑（对话助手附图：用户上传图片随消息发送）

**背景**

对话助手此前仅支持文本 + 挂载文档（MP20）上行，创作类高频场景「照这张图改/编辑」无法表达。后端 `POST /api/agent/chat` 的 `ChatRequest` 已支持 `image={filename,worker}` 单图字段（apps/api 源码核实：runner 注入系统提示「用户上传了一张图片」并把 attachment 传给 edit_image/generate_3d 工具，从 worker input 目录读字节），上传走既有 `uploadImage(filePath,'img2img')`（pool worker input 目录，工具可达）。本里程碑在输入条新增「图片」钮：showActionSheet（拍照/相册）→ chooseImage 选 1 张 → 选图即传（chip 内转 loading）→ 成功得句柄 → 发送随消息上行 → user 气泡本地留痕。单图契约（后端仅一个 image 字段），已有 chip 再选 = 替换。

**契约要点**

- 上行：`ChatRequest.image={filename,worker}`（可选，与 `document_ids` 可同发）；句柄来自 `POST /api/upload?kind=img2img` 响应（上传落点 worker 须与后续工具调用同机，契约同 img2img 链路）。
- **已知限制（后端契约现状）**：后端用户消息落库**不含** attachment，会话回放时历史气泡无图——前端仅本会话内本地轮次以 `previewUri` 渲染留痕（`userMsg.image={previewUri}`），回放消息无图不视为缺陷。
- 选图封装：`uni.showActionSheet`（拍照/相册）+ `uni.chooseImage`（count 1，sizeType compressed）三件套——`uni.chooseMedia` 未入 uni-h5 导出清单（MP17 既有教训），全端一致禁用。
- 状态机：`uploading`（选图即传/替换语义直接覆盖）→ `ready`（句柄落盘按会话键持久化）/ 失败清 chip（toast 页面层补）；`imageEpoch` 世代号防竞态——上传中被替换/移除/切会话/发送，迟到回调直接丢弃。
- 发送门双律：页面 `canSend` 与 store `send` 同律 `canSendWithImage`——uploading 态禁发（取最小改动「禁用发送」，行为测试钉死）；发送后 chip 清空转移到 user 气泡，`lastImage` 快照供 retry 复用。
- 会话隔离：ready 句柄（filename/worker/previewUri）随会话键落盘（对齐 MP24 草稿键策略），切会话/新建按会话键恢复直接用不重复上传；uploading 瞬态不入草稿（tempFile 失效无恢复价值）。

**改动清单**

- `src/utils/assistant-image.ts`（新）：`AttachedImage` 类型 + `attachImageState`/`readyImageState`（previewUri 不匹配护栏）/`failImageState`/`canSendWithImage`/`buildChatImage`（ready→image 字段，其余→null）/`serializeImageDraft`/`parseImageDraft`（畸形 JSON/缺字段防御→null）/`chooseAssistantImage`（action sheet 取消/选图失败静默→null）。
- `src/types/api.ts`：新增 `AgentChatImage{filename,worker}`（含后端行为与回放无图限制注释）。
- `src/api/index.ts`：`agentChatStream` params 增 `image?: AgentChatImage`（有才带字段）。
- `src/stores/assistant.ts`：`attachedImage` 状态 + `imageEpoch` + `attachAndUploadImage`（uploadImage kind=img2img，成功落盘会话键，失败清 chip 抛错）+ `detachImage`（清 chip 清草稿键）+ `send` 转移（roundImage 快照/清 chip/清草稿键/userMsg.image 留痕）+ `newChat`/`openSession` 按会话键 `loadImageChip` 恢复 + `ChatMessage.image` 字段。
- `src/pages/assistant/assistant.vue`：图片钮（`.assistant__imgbtn` 复用 docbtn ghost 样式，有附图 accent 高亮，流式中 --disabled）；chips 行 `v-if` 扩展为 `attachedImage || attachedDocs.length > 0`；附图 chip = 缩略预览 aspectFill + uploading loading 遮罩（loader-circle 旋转）+ X 移除；user 气泡 `.assistant__msg-image`（v-if=msg.image 本地渲染）；`canSend` 并入 `canSendWithImage`；Icon 白名单 image/x/loader-circle 复用零新增。
- `tests/helpers/mock-uni.ts`：扩展 `showActionSheet`/`chooseImage` 行为捕获与预设（`mockActionSheetTap`/`mockChooseImageResult` 等）。
- `scripts/mock-server.mjs`：`lastChatBody` 内存态（`/__reset` 复位）+ `/api/agent/chat` 每次记录请求体 + `GET /__lastChatBody` 调试端点（走查断言 image/document_ids 上行）。
- `scripts/ux-walkthrough-h5.mjs`：C33.1-C33.3 三检查点 + 头部注释补 C33；C23 文档钮选择器收窄（见踩坑 2）。
- `tests/assistant-image.test.ts`（新，12）/ `tests/api-agent.test.ts`（+2）/ `tests/assistant-store.test.ts`（+11）。

**测试矩阵**

- vitest 26 套件 565 用例全绿（较 MP29 口径 540 净增 +25）：
  - assistant-image 12（attach 替换语义/ready 竞态护栏/迟到回调不改写/fail 清 chip、canSendWithImage 发送门、buildChatImage ready→句柄/其余→null、草稿序列化往返/仅 ready 可落盘/畸形 JSON·缺字段→null、chooseAssistantImage 取消/拍照 sourceType=camera/相册 album/chooseImage 失败→null）。
  - api-agent +2（附图上行 `image={filename,worker}` 与 document_ids 同发断言 / 无附图请求体不带 image 字段）。
  - assistant-store「对话助手附图（MP30）」describe +11（选图即传 chip uploading→ready 落句柄落盘/替换覆盖/移除清键/失败清 chip 抛错、发送体含 image 且 chip 清空转移 user 气泡、上传中禁发双律、retry 复用 lastImage、newChat/openSession 按会话键恢复与隔离、世代号迟到回调丢弃）。
- `vue-tsc --noEmit` 0 错；`npm run lint`（--max-warnings=0）0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。

**走查结果（111/111 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C33.1 图片钮 → 选图即传 → chip 出现（缩略图可见 + ready 可发）  — chip=true ready=true thumb=true
PASS  C33.2 发送 → image 上行 + 回复流正常 + user 气泡留痕 + chip 清空  — reply=true image={"filename":"walkthrough-c33.png","worker":"w1"} bubbleImg=1 chips=0
PASS  C33.3 chip X 移除后发送 → 请求体无 image 字段 + 流式正常收口  — chipGone=true started=true done=true hasImage=false
```

既有 108 检查点（C1-C32 含作业进度 SSE C32、产物存资产 C31、资产库批量 C30、设置页 C29、作品库批量 C28、分叉/预览/草稿 C27、计划编辑 C26、确认门 C25、Agent 监控 C24）全数通过，无回归。

**踩坑记录**

1. **Edit 工具对 mock-server.mjs 缓存不同步复发且更隐蔽**：三处补丁 Edit 报成功且返回的 `cat -n` 快照显示已改，但磁盘 md5/行数纹丝不动（`wc -l` 1303 不变、`md5` 不变、Grep 查无 `lastChatBody`）——工具在陈旧缓存视图上「假写」。改 Python 直写（精确串替换 + count==1 断言）后 `wc -l` 1303→1313、md5 变更、`node --check` 过、Grep 6 处命中四重交叉验证生效（沿袭并强化 MP29 踩坑 3 的处置律：mock-server 修改一律 wc -l + md5 + Grep 验证落盘，工具回执不足信）。
2. **新增图片钮复用 docbtn 类导致 C23 选择器 strict 冲突**：`.assistant__imgbtn` 与文档钮共用 `assistant__docbtn` 基类样式，Playwright `locator('.assistant__docbtn').click()` 命中 2 元素（strict mode violation）走查中断于 C23.1——走查侧收窄为 `.assistant__docbtn:not(.assistant__imgbtn)`（C23.1/C23.5 两处），产品代码不动（样式复用是刻意的 ghost 对齐）。
3. **C33.3 流式收口断言防早判**：发送键「停止态出现→消失」两段等待（先证流式真的启动，再证收口），避免在第一轮静止窗口误判 done；`/__lastChatBody` 在请求到达时即记录，断言不受流式时序影响。
4. **回放无图为后端契约现状而非缺陷**：后端用户消息落库不含 attachment（apps/api agent runner 源码核实），`openSession` 回放的历史 user 气泡无 `.assistant__msg-image` 属预期；前端仅本地轮次留痕，测试与走查均按此语义钉死（C33.2 断言的是本会话内刚发送的气泡）。

---

## 2026-08-15 · MP29 里程碑（作业进度 SSE 化·会话内：实时进度/质量预警 + 轮询兜底不回退）

**背景**

作业进度此前完全依赖 2s 间隔轮询（MP1 use-poll），活跃作业要等下一个轮询 tick 才反映状态变化，且轮询响应不含进度百分比/质量信号。后端已提供 `GET /api/jobs/{prompt_id}/events?client_id=&worker=` SSE 事件流（progress/done/error/quality_warning 四类事件），但 `client_id`/`worker` 只存在于提交回包 `GenerateResponse`、`JobItem` 不持久化这两个字段——因此 SSE 天然只能覆盖「本次会话内刚提交」的作业，重启/离开页面后的历史作业必须仍走既有轮询，行为不得回退。本里程碑在轮询之上叠加 SSE 实时加速层：提交回包凭据会话内登记 → 作业页对「活跃 + 有凭据」作业起流 → 进度条/质量预警实时上屏 → 终态收口立即刷新列表取产物；无凭据作业全程零感知。

**契约要点**

- 端点：`GET /api/jobs/{prompt_id}/events?client_id=&worker=`，三段参数各自 `encodeURIComponent`；请求头 `Accept: text/event-stream` + `Authorization: Bearer` 同源注入（buildRequestHeaders 复用）。
- 事件帧：`event: progress|done|error|quality_warning` + `data: <JSON>`；progress 载荷 `{value,max}` 派生 `pct = round(value/max*100)` 钳制 0-100，缺字段事件忽略；quality_warning 只提示不阻塞（卡片预警图标 + 一次性 toast）；done/error 为终态帧。
- 会话内限制：凭据存纯内存 Map（`job-sse-registry.ts`，容量 32，重登记刷新位次、超容摘最旧 LRU 淘汰），不落地 storage——页面重载后凭据即失，历史作业自动回轮询，与「SSE 仅限会话内」约束一致。uni-h5 `reLaunch` 经核实为 SPA `router.replace`（uni-h5.es.js `navigate()` 实现），提交后跳作业页模块态 Map 存活。
- 跟踪 FSM（`job-tracker.ts`）：60s 看门狗无事件软重连（abort 旧流起新流）；重连退避 1s→2s→4s 封顶 8s；500ms 快照窗去重（软重连后重复事件抑制防 UI 抖动）；401/403 鉴权失败 → `onFallback` 永久回退轮询不再重试（既有轮询一直在跑，静默收口行为不回退）；done/error 终态自闭环不再重连，迟到帧忽略；abort 幂等。
- 起停编排（`planJobSseSync` 纯函数）：列表刷新后对「status∈{queued,running} + 有会话凭据 + 未跟踪」起流（toStart），对「跟踪中转终态或从列表消失」停流（toStop）；终态/回退收口即清凭据，后续列表刷新不再尝试起流。
- 传输复用：`uni.request` `enableChunked` 分块 + `src/utils/sse.ts` 自研增量 UTF-8 跨块解码器（MP19 起既有，不依赖 TextDecoder，小程序端兼容）。

**改动清单**

- `src/types/api.ts`：新增 `JobSseEventType`（'progress'|'done'|'error'|'quality_warning'）/ `JobSseEvent{type,data}`。
- `src/utils/job-sse-registry.ts`（新）：`JobSseCredentials{clientId,worker}`；`registerJobSseCredentials(GenerateResponse)`（驼峰映射 + LRU 容量 32）/ `getJobSseCredentials` / `unregisterJobSseCredentials` / `clearJobSseRegistry` / `jobSseRegistrySize`。
- `src/api/index.ts`：`streamJobEvents(promptId, creds, onEvent, onOpen?)` 返回 `JobEventsHandle{promise,abort}`；非 2xx/网络错误 reject 人话 ApiError；abort 幂等静默。
- `src/utils/job-tracker.ts`（新）：`trackJobSse` FSM（看门狗/退避/快照窗/401-403 回退）+ `planJobSseSync` 起停编排纯函数 + `JobTrackHandle`。
- `src/pages/index/index.vue`：handleSubmit 统一收口点 `if (submitted) registerJobSseCredentials(submitted)`（20 个 submit 分支一处汇入）。
- `src/pages/jobs/jobs.vue`：ssePct/sseWarned 响应式 + trackers Map；`startSseTracker`（onProgress 写 pct / onQualityWarning 置位 + toast「质量预警：产物可能低于预期」/ onDone·onError 终态收口刷新取产物 / onFallback 静默）；`finalizeSseTracker`（abort + 清凭据 + 清状态，终态立即 refreshAndPoll）；`syncSseTrackers` 挂轮询 onUpdate 与删除后；`stopAllSseTrackers` 挂 onUnload/onHide；handleRetry 重试成功亦登记凭据。
- `src/components/business/job-card.vue`：新增 `progressPct`(0-100|null) / `qualityWarning` props——进度条仅活跃态渲染（8rpx 圆角轨道 var(--color-border)、accent 填充 240ms ease-out 宽度过渡、pct 文本 accent 色），预警图标 `circle-alert` 28rpx `var(--color-warning)` 入状态行（Icon 白名单既有零新增）。
- `scripts/mock-server.mjs`：sseJobs 内存态（__reset 复位）+ `/__seed` 扩展 `sseJobs:[{prompt_id,scenario?}]` 种子 + `GET /api/jobs/:id/events` 路由（未登记 404 对齐会话内约束；success=progress×5→done、warning=中段插 quality_warning 再 done、error=中段 error；300ms 帧间隔；终态帧写出前翻转 libraryJobs 内存态，紧随的列表刷新即见终态/产物）。
- `scripts/ux-walkthrough-h5.mjs`：C32.1-C32.3 三检查点 + 头部注释补 C32；辅助 `submitTxt2ImgForSse`（创作页提交 txt2img 固定回包 p-new-1）/ `cardState`（按提示词定位卡片原子读进度条/徽章/产物图）。
- `tests/job-sse-registry.test.ts`（新，7）/ `tests/api-jobs-events.test.ts`（新，13）/ `tests/job-tracker.test.ts`（新，23）。

**测试矩阵**

- vitest 25 套件 540 用例全绿（较 MP28 口径 497 净增 +43）：
  - job-sse-registry 7（登记读取驼峰映射 / 重登记覆盖刷新位次 / 删除 / 清除 / 容量 32 淘汰最旧 / 未登记 undefined / 多键隔离）。
  - api-jobs-events 13（请求构造 method/url 三段编码/Accept 头/Bearer 同源注入、progress·done·error·quality_warning 事件分派、跨块多字节 UTF-8 切片重组、多行 data 帧、onOpen 时机、401/403/500 reject 人话、abort 后迟到帧忽略、空流正常结束）。
  - job-tracker 23（pct 派生/>100 钳制/缺字段忽略、预警流内去重、done/error 终态自闭环、看门狗 60s 软重连、退避 1s→2s→4s 序列、500ms 快照窗去重、401/403 onFallback 不再重试、abort 幂等、终态后迟到帧忽略、planJobSseSync 起停六态）。
- `vue-tsc --noEmit` 0 错；`npm run lint`（--max-warnings=0）0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。

**走查结果（108/108 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C32.1 会话内作业 SSE：进度条出现 + pct 单调增长 → done 收口（进度条消失/徽章已完成/产物图）  — bar=true pct=10→30 done=true
PASS  C32.2 quality_warning：卡片预警图标 + toast「质量预警」→ done 收口（只提示不阻塞）  — warn=true toast="质量预警：产物可能低于预期" done=true
PASS  C32.3 error 帧 → 徽章「失败」收口 + 无凭据作业全程无进度条（轮询兜底不回退）  — sseBar=true failed=true noCreds early=false late=false
```

既有 105 检查点（C1-C31 含产物存资产 C31、资产库批量 C30、设置页 C29、作品库批量 C28、分叉/预览/草稿 C27、计划编辑 C26、确认门 C25、Agent 监控 C24）全数通过，无回归。

**踩坑记录**

1. **uni-h5 reLaunch 是否整页刷新决定凭据存活**：若 reLaunch 触发浏览器整页 reload，模块态凭据 Map 会被清空、SSE 永远起不来。核实 `node_modules/@dcloudio/uni-h5/dist/uni-h5.es.js` 的 `reLaunch` 实现为 `removeAllPages() + navigate()` → `router.replace`（SPA，无 reload），凭据链路成立；走查 C32.1 实证（提交后进度条出现且 pct 增长）。
2. **mock 终态帧必须先翻转列表内存态再写帧**：trackJobSse 收到 done 立即 `refreshAndPoll`，若 mock 先写 done 帧再改内存态，紧随的列表响应会拍到 running 旧态、终态断言抖动——mock 在写终态帧前先翻转 `libraryJobs` 状态/产物，保证「SSE 终态 → 列表立见终态」时序确定。
3. **mock-server.mjs 的 Read 工具缓存滞后**：补丁落盘后 Read 读到旧版（__seed 响应缺 sseJobs 字段），以 `sed -n` + Grep 交叉验证实际落盘内容为准（沿袭既有教训），curl 实测 `/__seed` 回包含 `sseJobs:1` + 事件流三帧确认生效。
4. **无凭据兜底断言需双采样**：C32.3 对「未会话内提交的 running 作业」在 SSE 卡进度条出现期间（early）与 error 收口后（late）各采一次 `hasProgress===false`，确证轮询兜底路径全程零感知、行为不回退。

---

## 2026-08-15 · MP28 里程碑（作品库↔资产库联动：产物一键存为资产）

**背景**

作品库的产物（image）此前只能下载到相册或删除，想复用为 img2img/参考图资产需手动保存再进资产库新建上传，链路断点多。本里程碑打通产物 → 资产单向联动：产物详情页操作区新增「存为资产」入口（仅 image 类产物渲染），点击后下载产物字节 → 上传 pool worker 得句柄 → 携 prefill query 跳资产库页，资产页 onLoad 解析后自动打开新建弹层并预填表单（预览/建议名/nsfw），用户改名/选类别/补图后走既有 createAsset 保存。反向联动（资产 → 创作）已由 MP13 资产选择器覆盖，不在本里程碑范围。

**契约要点**

- 下载链路复用详情页既有「下载到相册」的 `uni.downloadFile` 模式：URL 走 `mediaUrl(path)`（token 自动拼参），`statusCode===200` 取 `tempFilePath`，网络失败/非 200 均为失败路径 toast 停留原页。
- 上传链路复用 `uploadImage(tempFilePath, 'img2img')`（src/api/index.ts，MP1 契约），得 `{filename, worker}` 句柄——与资产页手动选图上传同一端点，pool worker 语义一致。
- 跳转契约：`uni.navigateTo` 到 `/pages/assets/index?prefill=<encodeURIComponent(JSON)>`，JSON 形状 `{"images":[{"filename","worker","preview":"<产物 mediaUrl>"}],"name":"<建议名>","nsfw":<job.nsfw>}`。preview 用产物 mediaUrl 而非 assetImageUrl——资产未创建前无资产 id，assetImageUrl 不可用。
- 建议名规则：作业 prompt 去全部空白字符后取前 12 字（`Array.from` 按码点切，防emoji截半），空串/纯空白兜底「作品资产」。
- 入口渲染谓词 `canSaveArtifactAsAsset`：`kindToFilter(job.kind)==='image'` 且当前 index 产物路径非视频扩展名（防御同作业混入视频产物），index 越界钳到最后一张；video/audio/3D 类作业整体不渲染入口。
- 资产页 onLoad 防御解析：`parseAssetPrefill` 先直 `JSON.parse`（uni onLoad query 已解码场景）失败再 `decodeURIComponent` 重试，畸形 JSON/非对象/images 非数组/全缺句柄 → null 静默忽略；部分图片缺句柄过滤保留合法项。与 MP27 多选态无冲突：prefill 开弹层前如在选择模式先 `exitSelecting`。

**改动清单**

- `src/utils/asset-prefill.ts`（新）：`AssetPrefill`/`AssetPrefillImage` 类型；纯函数 `suggestAssetName` / `canSaveArtifactAsAsset` / `buildAssetPrefillQuery` / `parseAssetPrefill` / `assetPrefillToForm`；流程函数 `saveArtifactAsAsset`（showLoading「准备中…」→ downloadFile → uploadImage → hideLoading → navigateTo prefill；三类失败 → hideLoading + toast 人话错误返回 false，upload 可注入便于单测，默认走 uploadImage kind=img2img）。
- `src/pages-sub/artifact/artifact.vue`：操作区新增「存为资产」图标钮（`image-plus`，`data-action="save-asset"`，`v-if="canSaveAsset"`，与下载/删除同排，最小改动不重构页面）；`canSaveAsset` computed 随 job/index 联动（多产物 job 每张 image 产物各自独立可存）；`saveAsAsset` 复用 `acting` 防重入。
- `src/pages/assets/index.vue`：`onLoad` 解析 prefill query → 退出选择态 → `editing=null` + formKind=character + formDesc 空 + `assetPrefillToForm` 预填 formName/formNsfw/formImages → `editorVisible=true` 自动开新建弹层；保存走既有 createAsset 零改动。
- `tests/helpers/mock-uni.ts`：扩展 `downloadFile`（结果/错误注入 + 调用记录）/`showLoading`/`hideLoading`/`showToast`/`navigateTo` 记录与断言辅助（allDownloads/allToasts/lastToast/allLoadings/hideLoadingCount/allNavigations 等）。
- `tests/asset-prefill.test.ts`（新）：24 用例（见测试矩阵）。
- `scripts/ux-walkthrough-h5.mjs`：C31.1-C31.3 三检查点；头部检查点注释补 C31。mock-server 零改动（/api/upload 回显 MP10 已有、/api/assets POST 真建内存 MP13 已有、/outputs/* 静态图已有）。

**测试矩阵**

- vitest 22 套件 497 用例全绿（较 MP27 口径 473 净增 +24，全部来自 asset-prefill.test.ts 新文件）：
  - suggestAssetName 3（空串/纯空白兜底 / 去空白不足 12 字原样 / 超 12 字截断）。
  - canSaveArtifactAsAsset 6（image+图片 true / null job / video·audio·3D 类 false / 无产物 false / index 越界钳制+多产物各自可存 / image 类但当前产物视频扩展名防御 false）。
  - buildAssetPrefillQuery 2（形状：句柄+preview+建议名+nsfw 透传 / 返回值已 URL 编码可直接拼 query）。
  - parseAssetPrefill 7（build→parse 往返 / 直接吃未编码 JSON / 空入参 / 畸形 JSON·非对象 / images 缺失·非数组·全缺句柄 / 部分缺句柄过滤保留 / name 空白兜底+nsfw 缺省 false+preview 缺省空串）。
  - assetPrefillToForm 1（previewUri←产物 preview、name←filename、名称/nsfw 透传）。
  - saveArtifactAsAsset 5（成功全链路：loading→downloadFile URL 命中 mediaUrl→upload 收到 tempFilePath→navigateTo prefill 可解析往返 / 默认上传链路 kind=img2img / downloadFile 网络失败 toast 停留 / 非 200 toast 重试文案停留 / uploadImage 失败 toast 透传人话停留）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。

**走查结果（105/105 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C31.1 image 作业详情「存为资产」入口可见  — entries=1
PASS  C31.2 存为资产 → 跳资产页 + 新建弹层自动打开（预览/建议名已预填）  — nav=true name="走查存资产：雨夜霓虹街区" previews=1 previewOk=true
PASS  C31.3 保存 → toast 已创建 + 列表资产数 +1 + 缩略图可见  — toast="已创建" before=1 after=2 thumb=true
```

既有 102 检查点（C1-C30 含资产库批量管理 C30、设置页完善 C29、作品库批量管理 C28、分叉/预览/草稿 C27、Agent 监控 C24、确认门 C25、计划编辑 C26）全数通过，无回归。

**踩坑记录**

1. **uni onLoad query 解码时机不确定**：H5 端 hash 路由 query 到手可能是已解码也可能是原始编码串，两端小程序行为亦有差异。`parseAssetPrefill` 采用先直 `JSON.parse`、失败再 `decodeURIComponent` 重试的双通道防御，测试同时覆盖编码/未编码两种入参，避免平台差异导致的静默失败。
2. **preview 不能用 assetImageUrl**：资产记录尚未创建时无资产 id，`assetImageUrl(assetId, filename)` 无从拼起——prefill 的 preview 直接透传产物 mediaUrl（带 token），弹层预览图直显产物原图，保存后资产卡缩略图才切换为 assetImageUrl 链路（既有逻辑零改动）。
3. **H5 端 downloadFile 返回 blob: 临时路径**：uni-h5 的 `downloadFile` 对同源静态图返回 `blob:` URL 而非真实临时文件路径，后续 `uploadFile`/`uploadImage` 内部经 urlToFile 转 FormData 正常上行（MP10 已有该链路），mock-server /api/upload 回显无需改动；真机端返回真实临时路径，同一代码路径兼容。
4. **与 MP27 多选态冲突预防**：资产页处于批量选择模式时若带 prefill 进入，新建弹层与底部批量操作条会同屏叠层——onLoad 处理 prefill 前先 `exitSelecting` 退出选择模式，保证弹层独占交互（走查 C31.2 在无选择态路径验证，选择态冲突路径由 onLoad 顺序保证）。

---

## 2026-08-15 · MP27 里程碑（资产库批量管理：多选模式 + 批量删除）

**背景**

MP13 落地资产库管理页（kind chips 过滤 + 双列卡片网格 + 弹层新建/编辑 + 单删）后，批量清理废资产仍需逐件进编辑弹层点删除，体验断点与 MP25 之前的作品库一致。后端契约侧**无批量端点**（`DELETE /api/assets/:id` 单删，MP13 已接入），批量 = 客户端并发限速循环单删 + 部分失败汇总。本里程碑对齐 MP25 作品库批量管理体验移植到资产库：多选模式（长按卡片 / 顶行「选择」钮双入口，编辑弹层打开守卫）、批量删除（二次确认 → 并发限速≤3 → 部分失败保留勾选停留）。**「批量打标」不做**：已读后端 ReferenceAsset 模型确认仅 `kind/name/description/images/nsfw` 五字段，无 `tags` 字段，无可写入载体（详见约束说明）。

**契约要点**

- `DELETE /api/assets/:id`：单个删除（MP13 已有，mock-server 真删内存）。无批量端点——批量由 `runBatch`（复用 `utils/library-batch.ts`，MP25 已抽并发限速≤3 执行器）循环单删，单项失败不中断其余，`summarizeBatch` 汇总成败。
- 与作品库批量管理的结构差异：资产列表**非分页**（一次拉全量 + kind 本地过滤），删除成功后 `removeDeletedAssets` 本地移除成功项即可，无需重置游标重拉（作品库 MP25 因服务端流缩短旧 offset 跳项必须重拉）。
- 选择集 = 当前可见项语义：切 kind 过滤桶 `watch(kindFilter)` 清空并退出选择模式——跨桶残留不可见勾选会误删（对齐 MP25 作品库 filter watch 模式）。
- 删除语义：资产删除仅删库记录，worker 上的图片文件保留——二次确认 modal 文案明示「删除 N 件资产后不可恢复（worker 上的图片文件保留）」。
- 汇总文案复用 `deleteSummaryText` 三态（已删除 N 项 / 成功 X 失败 Y，失败项已保留勾选 / 全败「删除失败，请稍后重试」），与作品库口径一致。

**改动清单**

- `src/utils/assets-batch.ts`（新）：`AssetSelectState`（selecting + ReadonlySet selected）/ `AssetSelectGuard`（editorOpen + acting 双守卫）；`canEnterAssetSelecting`（编辑弹层打开 → 长按让位编辑；批量执行中 → 防重入）/ `assetSelectIdle` / `enterAssetSelecting`（已在选择态幂等返回原态不清空）/ `longPressAssetCard`（未在选择态 = 进入并选中该卡；已在选择态 = toggle 该卡，支持长按加选）/ `tapAssetCard`（选择态 toggle、非选择态返回 null 让位 `openEdit`）/ `selectAllAssets`（按当前过滤可见项全量 id）/ `exitAssetSelecting`（清空回 idle）/ `applyAssetBatchDelete`（复用 summarizeBatch + deleteSummaryText：全成 → 退出 + 清空 + removedIds 全量；部分失败 → 失败 id 保留勾选停留选择态）/ `removeDeletedAssets`（本地移除成功项保持剩余顺序，空移除幂等）。全部不可变语义，不改入参。
- `src/pages/assets/index.vue`：
  - 多选模式：顶行 chips 右侧「选择」入口（`data-action="enter-select"`，选择态让位隐藏）；卡片 `@longpress` 进选择 + `@tap` 选择态 toggle / 非选择态开编辑；`longPressGuard` 350ms 窗口吞咽长按松开后合成的尾随 tap（见踩坑 1）；选择态卡片左上选择圈（未选 = 空心圈 / 已选 = accent 实心 + check 图标，`data-selected` 断言钩子）+ 已选卡 accent 描边；编辑/删除小钮 `v-if` 隐藏；`assets__footer` 新建入口让位。
  - 底部批量操作条：fixed + safe-area-inset-bottom，z-index 50 低于编辑 Sheet；计数「已选 N 项」/ 执行中转进度态「删除中 x/N」；全选（`select-all`，acting 禁用）/ 删除（`batch-delete`，danger，N=0 或 acting 禁用）/ 取消（`exit-select`，acting 禁用）。
  - 批量删除：`uni.showModal` 二次确认（数量 + 不可恢复 + 文件保留）→ `runBatch` 限速 3 循环 `deleteAsset` → `onProgress` 进度态 → `applyAssetBatchDelete` 落地（失败保留勾选停留待重试 / 全成退出）→ `removeDeletedAssets` 本地移除成功项 → 汇总 toast。
  - 本页无震动反馈，与作品库一致（MP25 亦未接 vibrateShort）。
- `scripts/mock-server.mjs`：`/__seed` 扩展 `assets` 种子（默认 kind=character + 1 张 seed.png 图片句柄，id 可指定，返回 `seededAssets`；`/__reset` 恢复空库），走查首屏 ≥3 件可见。
- `scripts/ux-walkthrough-h5.mjs`：C30.1-C30.3 三检查点；头部检查点注释补 C30。

**测试矩阵**

- vitest 21 套件 473 用例全绿（较 MP26 口径 453 净增 +20，全部来自 assets-batch.test.ts 新文件）：
  - canEnterAssetSelecting 3（编辑弹层打开拦截 / 批量执行中拦截 / 空闲放行）。
  - enterAssetSelecting 3（进入空选集 / 弹层打开返回 null / 已在选择态幂等不清空）。
  - longPressAssetCard 5（未在选择态进入并选中该卡 / 已在选择态 toggle 加选取消 / 弹层打开守卫 null / 执行中守卫 null / 不可变语义不改入参）。
  - tapAssetCard 2（选择态 toggle 双向 / 非选择态返回 null 让位 openEdit）。
  - selectAllAssets / exitAssetSelecting 2（全选可见项全量 id / 取消清空回 idle）。
  - applyAssetBatchDelete 3（全成：退出 + 清空 + removedIds 全量 + 「已删除 2 项」/ 部分失败：失败保留勾选停留 + removedIds 仅成功项 + 汇总文案 / 全败：全部保留停留 + removedIds 空 + 全败文案）。
  - removeDeletedAssets 2（移除成功项保持剩余顺序 / 空移除幂等）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。

**走查结果（102/102 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C30.1 选择钮进入多选：卡片选择圈渲染 + 编辑/删除小钮隐藏 + 操作条接管底栏  — circles=3 checked=0 actionsHidden=true footerGone=true
PASS  C30.2 勾选 2 件 → 计数「已选 2 项」→ 删除确认弹窗（数量/不可恢复/文件保留）  — count="已选 2 项" checked=2 modal="删除2件资产？删除2件资产后不可恢复（worker上的图片文件保留）取消删除"
PASS  C30.3 批量删除全成功：汇总 toast + 列表减项 + 退出选择态  — toast="已删除 2 项" gone=true keep=true barGone=true cards=1
```

既有 99 检查点（C1-C29 含作品库批量管理 C28、设置页完善 C29、分叉/预览/草稿 C27、Agent 监控 C24、确认门 C25、计划编辑 C26）全数通过，无回归。

**约束说明**

- **「批量打标」不可行，不做**：已读后端 ReferenceAsset 模型确认字段仅 `kind/name/description/images/nsfw`，无 `tags` 字段——客户端无可写入载体，伪造本地标签会在重拉后丢失造成数据假象。若后续后端补 `tags` 字段，可在 `assets-batch.ts` 基础上加批量打标执行器（复用 runBatch 限速 + 汇总模式）。

**踩坑记录**

1. **长按松开后合成 tap（微信/uni-h5 同病）**：`onCardLongPress` 进入选择模式并选中该卡后，松开手指仍会合成一次 tap 落到同一卡片——刚选中的卡被 `tapAssetCard` toggle 取消。修复：`longPressGuard` 置位 + `setTimeout(350ms)` 复位，`onCardTap` 起手守卫吞咽这一次尾随 tap。
2. **编辑弹层打开时长按误入选择模式**：资产卡片的编辑入口在弹层之上，弹层打开时长按背后卡片若不守卫会进入选择模式（与弹层表单态冲突）。修复：长按/选择钮双入口统一过 `canEnterAssetSelecting`（`editorOpen` + `acting` 双守卫），测试覆盖两守卫分支。
3. **mock-server.mjs 落盘失步前科**：本次扩展 `/__seed` assets 种子后按既有规程 `wc -l` + `md5` + Grep 交叉验证落盘再重启服务（Read 工具有缓存失步前科，仅作参考）；走查 C30 依赖 `DELETE /api/assets/:id` 真删内存（MP13 已有），无需额外 mock 改动。
4. **选择集 = 当前可见项语义**：资产页 kind 为本地过滤，切桶后若残留上一桶的不可见勾选，批量删除会误删不可见项——`watch(kindFilter)` 清空并退出选择模式（对齐 MP25 作品库 filter watch 模式），测试覆盖切桶语义由页面层 watch 承担（纯函数层 selectAll 只收当前可见列表）。

---

## 2026-08-15 · MP26 里程碑（设置页完善：关于 + 清理缓存 + 导出诊断）

**背景**

设置页（我的页）此前只有账号/外观/资产/高级区，缺三块运营期刚需：① 关于信息（版本号无处可查，问题反馈无法对齐构建）；② 缓存清理（uni storage 只增不减，但 `clearStorageSync` 全清会误伤 token/设置/助手草稿——白名单保护是硬约束）；③ 诊断导出（远程排障需要版本/平台/存储快照，且必须脱敏——token 本体不出设备）。本里程碑三块全部落在设置页新增「关于」分组（高级区后、退出登录前），纯函数下沉 `utils/maintenance.ts` 保证可单测。

**契约要点**

- 无后端契约，纯客户端里程碑。存储键白名单与落盘侧对齐：`toiv_token`（api/client）/ `toiv.cachedUser`（auth store）/ `toiv.settings`（settings store，主题色板在其中）精确保护 + `assistant_draft:` 前缀保护（MP24 草稿属用户数据）。
- 版本注入：`import manifest from '@/manifest.json'`（`resolveJsonModule` 继承自 @vue/tsconfig，vite/vitest 原生支持 JSON 导入），关于区与检查更新行同源自 `versionName`。
- 产品定位文案对齐主站：`apps/web/components/settings/SettingsView.tsx` 关于区「ToIV — AI 创作平台 / 私有化部署 · 本地推理集群」。
- uni-h5 行为实证：`getStorageInfoSync` 枚举 localStorage 原生键（排除内部 STORAGE_KEYS），大小口径 `key.length + value.length` 与页面逐键估算一致；`setClipboardData` 先 `navigator.clipboard.writeText` 失败后兜底 `#clipboard` textarea + `execCommand("Copy")`（成功才 resolve）。

**改动清单**

- `src/utils/maintenance.ts`（新）：`formatBytes`（1024 进制 B/KB/MB/GB，非整数一位小数去尾零，非有限/非正 → `0 B`）/ `planCacheClear(keys, whitelist?)`（精确键 + 前缀双通道，`toRemove`/`toKeep` 双列表保持输入顺序；默认 `CACHE_WHITELIST`）/ `buildDiagnostics(input)`（app/env/apiBase/session/features/storage/generatedAt 形状；storage 合计 `totalSize` + `totalSizeText`；脱敏由输入侧结构保证——只收键名+大小与登录态布尔）。
- `src/utils/platform.ts`：`platformName()`（编译期常量原文，诊断 env.platform 用；`.vue` 文件不吃 @typescript-eslint 对 `no-undef` 的 `*.ts` 豁免，`process.env.UNI_PLATFORM` 必须留在 `.ts` 层）。
- `src/pages/profile/profile.vue`：「关于」分组四行（`data-action` 断言钩子）——「关于 ToIV」行内展开（版本/定位/© 版权）；「检查更新」（副标题当前版本；小程序端 `getUpdateManager` 监听单绑一次：无更新 toast / 就绪重启 modal / 失败 toast；H5 降级「H5 端自动保持最新」）；「清理缓存」（副标题估算占用 → 二次确认 modal 明示保留项 → 白名单外逐项 `removeStorageSync` → toast「已清理 N」；空缓存短路「暂无缓存可清理」）；「导出诊断信息」（`buildDiagnostics` ← manifest 版本 + `getSystemInfoSync` + effective API 基址 + 登录态布尔 + NSFW + 键清单 → `setClipboardData` → toast「诊断信息已复制」）。
- `scripts/ux-walkthrough-h5.mjs`：C29.1-C29.3 三检查点；主 context 增 `clipboard-read/write` 权限（C29.3 剪贴板断言）；头部检查点注释补 C29。
- `scripts/gen-icons.mjs`：无变更（`trash-2` 原已登记，见踩坑 1）。

**测试矩阵**

- vitest 20 套件 453 用例全绿（较 MP25 口径 439 净增 +14，全部来自 maintenance.test.ts 新文件）：
  - formatBytes 4（0/负数/NaN 兜底 / 字节级原样 / KB 整数去尾零+一位小数 / MB 级同理）。
  - planCacheClear 6（默认白名单保留 token/设置/缓存用户 / 草稿前缀保留 / 双列表保持输入顺序 / 空输入 / 白名单可注入 / 出厂白名单覆盖全部受保护键）。
  - buildDiagnostics 4（形状完整 / storage 合计+格式化文本 / 脱敏：序列化含 `toiv_token` 键名不含 token 值且键项无 `value` 字段 / 空存储）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。

**走查结果（99/99 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C29.1 关于区渲染：版本号副标题 + 关于行展开（定位/版权）+ H5 检查更新降级  — ver=1.0.0 update="当前版本 v1.0.0" toast="H5 端自动保持最新"
PASS  C29.2 清理缓存：确认弹窗 → 汇总 toast → 白名单（token/设置/草稿）保留、垃圾键删除  — toast="已清理 2.6 KB" token=true settings=true draft=走查草稿种子
PASS  C29.3 导出诊断：剪贴板 JSON 形状（版本/平台/键清单）+ 脱敏（不含 token 值）  — toast="诊断信息已复制" keys=5 total=267
```

既有 96 检查点（C1-C28 含作品库批量管理 C28、分叉/预览/草稿 C27、Agent 监控 C24、确认门 C25、计划编辑 C26）全数通过，无回归。

**踩坑记录**

1. **图标白名单重复登记（TS1117）**：`trash-2` 原已在 gen-icons.mjs 白名单第 31 行（Grep 输出跳行未显），重复添加导致 `icons.generated.ts` 同名键 vue-tsc 报 `TS1117: An object literal cannot have multiple properties with the same name`。**加图标前先 Grep 生成物（icons.generated.ts）确认未登记，勿只信白名单清单扫读。**
2. **`.vue` 文件不享受 `no-undef` 豁免**：`plugin:@typescript-eslint/recommended` 经 eslint-recommended 仅对 `*.ts` 关掉 `no-undef`——`profile.vue` 直接写 `process.env.UNI_PLATFORM` 报 `'process' is not defined`；按既有约定收敛 `platformName()` 进 `utils/platform.ts`（编译期常量摇树友好语义保留在 .ts 层）。
3. **uni-h5 剪贴板断言双通道**：`setClipboardData` 优先 `navigator.clipboard.writeText`（需 context 授 `clipboard-write`），失败兜底 `#clipboard` textarea + `execCommand("Copy")`——走查读取同样双通道（授权 `clipboard-read` → `readText()`，catch 后读 `#clipboard` textarea 残值），注意该元素 id 字面含 `#`，只能 `getElementById` 不能 querySelector。
4. **清理缓存不能用 `uni.clearStorageSync`**：全清会误伤 token/设置/助手草稿（MP24 起草稿属用户数据）——必须 `planCacheClear` 计划后逐项 `removeStorageSync`；modal 文案同步明示保留项，避免用户预期错位。

---

## 2026-08-15 · MP25 里程碑（作品库批量管理：多选模式 + 批量删除 + 批量保存相册）

**背景**

MP15/MP16 完成作品库类型过滤桶与无限分页后，单件管理（详情页预览/复用/下载/删除）已通，但批量清理废稿、批量保存成片到相册仍需逐件进详情页操作。后端契约侧**无批量端点**（已读 apps/api/app/routes/jobs.py 确认仅 `DELETE /api/jobs/{job_id}` 单删）——批量 = 客户端循环单删，需并发限速（≤3）+ 部分失败汇总。本里程碑落地：多选模式（长按卡片或页头「选择」钮进入，选择集跨无限分页保持）、批量删除（二次确认 → 限速循环 → 部分失败保留勾选）、批量保存相册（仅 image/video 可保存，audio/3D 跳过计入汇总）。

**契约要点（已读 apps/api/app/routes/jobs.py 源码确认）**

- `DELETE /api/jobs/{job_id}`：单个删除，204 无 body。无批量端点——批量由客户端并发限速 3（`BATCH_CONCURRENCY`）循环单删，单项失败不中断其余，成败由前端 `summarizeBatch` 汇总。
- `GET /api/jobs`：kind/status/limit/offset 过滤分页（MP15/MP16 已接入无限滚动 + 服务端 kind 过滤）。**删除后服务端流缩短，旧 offset 会跳项**——批量删除完成必须重置分页游标重拉第一页。
- 保存相册无后端契约：纯客户端链路 `downloadFile → saveImage/saveVideoToPhotosAlbum`；仅 `kindToFilter` 判定 image/video 桶的 kind 可保存，audio/3D/未知 kind 跳过计入汇总文案。
- H5 端无相册 API：uni-h5 的 `save*ToPhotosAlbum` 为 unsupported 实现（必走 fail），前端以人话错误汇总降级，走查环境断言 downloadFile 调用次数与汇总逻辑，真机同链路正常 success。

**改动清单**

- `src/utils/library-batch.ts`（新）：`toggleSelect`（不可变 Set 语义，不改入参）/ `selectAll`（当前已加载项全量 id 集合）/ `splitSavable`（image·video 进可保存、audio/3d/未知进跳过，保持相对顺序）/ `summarizeBatch`（成败计数 + `failedIds` 按输入序收集）/ `deleteSummaryText` 三态（已删除 N 项 / 成功 N 失败 M，失败项已保留勾选 / 全败「删除失败，请稍后重试」不报「成功 0」）/ `saveSummaryText` 六态（全成±跳过±失败组合 / 全败「保存失败，请检查相册权限」/ 全跳过「仅图像与视频支持保存相册」）/ `runBatch` 并发限速执行器（lane 模式，结果与输入同序，逐项 `onProgress` 回调，单项失败不中断）。
- `src/pages/library/library.vue`：
  - 多选模式：`selecting` / `selected: Set<id>` / `acting`（防重复点）/ `progress`（进度态）。进入=长按卡片（`onCardLongPress`）或顶栏「选择」钮（`data-action="enter-select"`，作品为空不出入口）；退出=操作条「取消」或操作完成；`watch(filter)` / `onPullDownRefresh` 清空选择并退出。
  - 选择态视觉：卡片右上选择圈（未选=空心圈边框 token / 已选=accent 实心 + check 图标，`data-selected` 断言钩子）+ 已选卡 accent 细边框（克制动效守设计规范）；`onCardTap` 选择态 toggle、非选择态 `openDetail`。
  - 底部批量操作条：固定底部 + safe-area 适配；计数「已选 N 项」/ 进度态「删除中 x/N」「保存中 x/N」；全选当前已加载（`select-all`）/ 保存（`batch-save`）/ 删除（`batch-delete`）/ 取消（`exit-select`）。
  - 批量删除：`uni.showModal` 二次确认（「删除 N 项作品？删除后不可恢复」）→ `runBatch` 限速 3 循环 `deleteJob` → 进度态 → 汇总：全成清空退出 / 部分失败 `selected=Set(failedIds)` 保留勾选停留选择模式待重试 → toast 汇总 → `refresh()` 重置游标重拉。
  - 批量保存相册：`splitSavable` 分流（savable 空直接 toast 不进执行器）；`saveJobToAlbum` 复用 artifact.vue 下载链路（`mediaUrl` → `downloadFile` → `isVideoPath` 分 saveVideo/saveImageToPhotosAlbum；save 非函数 reject「当前平台不支持」，下载/保存 fail 转人话）；完成后 `exitSelecting`。
- `scripts/mock-server.mjs`：`libraryJobs` 可变（`defaultLibraryJobs` 工厂，`/__reset` 恢复默认 52 件）；`DELETE /api/jobs/:id` 真删内存（走查断言列表减项）+ magic id 含 `'fail'` 注入 500「mock 注入删除失败」（部分失败分支）；`/__seed` 扩展 `jobs` 种子（unshift 置顶，走查首屏可见）。
- `scripts/ux-walkthrough-h5.mjs`：C28.1-C28.5 五检查点；新增 `waitToastText`（可见性判定 toast 全文原子读取）。

**测试矩阵**

- vitest 19 套件 439 用例全绿（较 MP24 口径 416 净增 +23，全部来自 library-batch.test.ts 新文件）：
  - toggleSelect 3（未选加入且不改入参不可变语义 / 已选再 toggle 移除 / 空集合出单项）。
  - selectAll 2（已加载项全量 id / 空数组空集合）。
  - splitSavable 2（image/video 进可保存、audio/3d/未知进跳过保持相对顺序 / 全不可保存 savable 为空）。
  - summarizeBatch 2（全成 failedIds 空 / 部分失败 failedIds 按输入序收集）。
  - deleteSummaryText 3（全成 / 部分失败保留勾选文案 / 全败不报「成功 0」）。
  - saveSummaryText 6（全成无跳过 / 有跳过 / 有失败 / 跳过+失败组合 / 全败检查相册权限 / 全跳过仅图像视频支持）。
  - runBatch 5（全成同序+进度回调 1..N / 部分失败 ok:false 带错误文案且 failedIds 可收集 / **并发限速峰值在途数 ≤3**（门控放行实测）/ 默认并发即 BATCH_CONCURRENCY ≤3 / 空输入空结果无回调）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。

**走查结果（96/96 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C28.1 选择钮进入多选：选 2 项计数/选中圈 → 全选已加载 24 → 取消退出  — count="已选 2 项" sel=2 all="已选 24 项" barGone=true
PASS  C28.2 批量删除全成功：确认弹窗 → 列表减项 + 汇总 toast + 退出选择  — toast="已删除 2 项" gone=true barGone=true
PASS  C28.3 批量删除部分失败：失败项保留勾选（已选 1 项）+ 成功项移除 + 汇总文案  — toast="成功 1 失败 1，失败项已保留勾选" okGone=true failKept=true count="已选 1 项"
PASS  C28.4 批量保存：仅 image/video 触发下载（audio/3D 跳过）+ H5 降级汇总文案 + 退出选择  — downloads=["/outputs/seed-6.mp4","/outputs/seed-5.png"] toast="保存失败，请检查相册权限" barGone=true
PASS  C28.5 选择集跨分页保持：两页各选 1 → 已选 2 项；切过滤桶退出选择并清空  — first=c28-save-3d page2=lib-job-18 count="已选 2 项" barGone=true selGone=true
```

既有 91 检查点（C1-C27 含作品库分页 C19、对话助手 C22、文档挂载 C23、Agent 监控 C24、确认门裁决 C25、计划编辑 C26、分叉/预览/草稿 C27）全数通过，无回归。

**踩坑记录**

1. **longpress 松开后合成 tap（微信/uni-h5 同病）**：长按卡片触发 `longpress` 进入选择模式并选中该卡后，松开手指仍会合成一次 `tap` 落到同一卡片——若无守卫，刚选中的卡立刻被 `toggleSelect` 取消。`longPressGuard` 350ms 窗口吞咽这一次 tap（`onCardTap` 首行拦截）；选择模式内的后续长按同理（先 toggle 再守卫，防连击误回退）。
2. **toast 文本断言串扰（C28.2 实证）**：uni-h5 的 `icon:none` toast 渲染为 `.uni-simple-toast__text`，**隐藏态元素残留 DOM**（vShow 不卸载）——`waitForSelector + first()` 会读到历史 toast 文本（实测串到 C27.3 的「已创建分叉会话」）。`waitToastText` 用 `getBoundingClientRect` 宽高判可见（fixed 定位下 offsetParent 恒 null 不可用）+ `waitForFunction` 原子取全文。**走查断言 toast 一律走可见性判定，勿用 first() 读残留。**
3. **并发限速用例的 no-constant-condition**：runBatch 限速断言需持续放行挂起的 lane 直至 Promise settle，`while (true)` 触发 eslint `no-constant-condition`；改有界 for（200×5~10ms 足够 10 项跑完）+ `Promise.race` 探 settle 提前跳出，断言峰值在途数 ≤3 与结果全 ok。
4. **H5 相册 API 降级路径**：uni-h5 的 `saveImage/saveVideoToPhotosAlbum` 存在但是 unsupported 实现（必走 fail 回调）——`saveJobToAlbum` 以 `typeof save !== 'function'` 守卫 + fail 转人话 reject，`runBatch` 汇总成「保存失败，请检查相册权限」；C28.4 以 `downloadFile` 请求计数（`["/outputs/seed-6.mp4","/outputs/seed-5.png"]`）证实仅 image/video 触发下载、audio/3D 分流跳过，真机为同一链路正常 success 分支。
5. **批量删除后必须重置分页游标**：删除使服务端流缩短，沿用旧 offset 续拉会跳过未删项（offset 语义基于删除前位次）——`runBatchDelete` 完成后 `refresh()` 归零游标重拉第一页；C28.2 断言列表减项即覆盖此路径。
6. **mock-server.mjs 落盘失步第九次复发（MP12/13/16/17/18/19/21/23/24 同因）**：IDE 层 Edit 显示成功但盘上未同步，按固化流程改脚本直写文件系统 + `wc -l` + md5 + Grep 交叉验证落盘后重启 curl 验证（DELETE 真删 / fail 注入 500 / __reset 恢复 52 件）。**mock-server.mjs 验证一律以 Grep/RunCommand 读盘为准。**

---

## 2026-08-15 · MP24 里程碑（对话助手三期：分叉会话 fork + 媒体产物预览 + 输入草稿持久化）

**背景**

MP19/MP20 完成对话助手流式对话与文档挂载后，三个体验缺口待补：① 想基于某轮结果换方向重聊只能整会话重来（对齐 Web/Mobile M24 的分叉会话）；② 媒体产物只能在气泡内看小图，图片无整组预览、视频内联 `<video>` 在小程序端是原生组件层级最高会穿透抽屉/遮罩；③ 输入到一半切会话或退页面草稿即丢。本里程碑落地：分叉会话（列表 copy 全量 + 气泡长按「从此分叉」消息级截断）、图片 `uni.previewImage` 整组预览 / 视频封面卡 + 全屏覆盖层播放、输入草稿按会话持久化（防抖 300ms，切换/重进回填，发送即清）。

**契约要点（已读 apps/api/app/routes/agent.py fork_agent_session 源码确认）**

- `POST /api/agent/sessions/{sid}/fork`：body 可空；空 = 全量复制；`{at_message_id}` = 截断到该消息（含，`id <= at`）。
- 404 双人话：`at_message_id` 不在源会话 →「消息不存在」；会话缺失/非本人 →「会话不存在」。
- 响应 = `_session_dict` 摘要（`id/title/nsfw/created_at/updated_at/message_count`，无 messages）；新会话继承源 `title/nsfw`，消息逐行复制（新行新 id）。
- 前端定位约定：回放映射时 user/assistant 气泡 `backendId` 取行 id；tool 媒体并入前一条 assistant 气泡时 `backendId` 取 **tool 行 id**（截断含这条媒体消息）——仅回放消息（backendId 非空）出「从此分叉」入口，本地流式轮次不出。

**改动清单**

- `src/api/index.ts`：`forkAgentSession(sid, atMessageId?)`（sid 路径编码；无 atMessageId 时 body 为 undefined 不带 Content-Type）；非 2xx 走 friendlyMessage 人话体系。
- `src/stores/assistant.ts`：`ChatMessage.backendId: number | null`；`forkSession(sid, atMessageId?)`（fork 插列表头 + openSession 跳新会话；sending 中拒入）；草稿四件套 `loadDraft/saveDraft/clearDraft/flushDraft`（存储键 `assistant_draft:{sid}`，新会话 `__new__`；saveDraft 防抖 300ms **Map 按键攒批**——修复单槽 pending 在防抖窗口内丢失异键先写的设计缺陷；clearDraft 取消待写防旧文本回魂；send 即清当前键）。
- `src/utils/assistant.ts`（新）：`previewUrls(media, resolve)` 整组解析 / `firstPreviewUrl(media, resolve)` 首张（空组 null）。
- `src/pages/assistant/assistant.vue`：
  - 会话列表项 copy 分叉钮（`@tap.stop="forkSessionCopy"` 全量 fork）；气泡 `@longpress="offerForkFrom(msg)"`（action sheet「从此分叉」截断 fork；`forking` 防重复提交，成功 toast + 跳新会话并回填其草稿）。
  - 视频产物改封面卡（480×270，播放钮 +「视频 · 点击播放」；小程序原生 video 层级最高故不内联）→ 点击开全屏覆盖层（`z-index: 100` 高于 inputbar 50 / ui-sheet 90；backdrop 点击 / 右上 X 关闭；内嵌 `video controls autoplay`）；图片点击 `uni.previewImage` 整组预览（current 定位点按张）。
  - 草稿接线：`watch(draft)→saveDraft` / `onShow→restoreDraft` / `onHide→flushDraft`；`pickSession`·`newChat`·`runFork` 均先 flush 后 restore（防 <300ms 快速切走丢稿）。
- `scripts/mock-server.mjs`：`POST /api/agent/sessions/:sid/fork`（空 body 全量 / at_message_id 截断含；404 双人话对齐后端；fork 消息重排 id 从 1 起对齐 chat 落库编号）+ `/__seed` 扩展 `agentSessions:[{title?,nsfw?,messages:[{role,content?,media?}]}]`（消息 id 升序）。
- `scripts/ux-walkthrough-h5.mjs`：C27.1-C27.4 四检查点。

**测试矩阵**

- vitest 18 套件 416 用例全绿（较 MP23 口径 398 净增 +18）：
  - api-agent.test.ts +3（全量 fork 空 body 不带 Content-Type / 截断 fork body `{at_message_id}` + sid 路径编码 / at 不在会话 404 人话透传）。
  - assistant-store.test.ts +11（分叉 4：全量空 body 上行 + 新会话插列表头并打开回放 / 截断 atMessageId 上行 / 失败人话抛错列表不污染 / sending 中拒入不发请求；backendId 映射 2；草稿 5：防抖落盘+读取+清除 / 按会话隔离 s1/s2/__new__ 互不污染 / clearDraft 取消待写防回魂 / send 即清当前会话键 / flushDraft 强制落盘）。
  - assistant.test.ts 新文件 +4（previewUrls 整组解析 / 空组 / firstPreviewUrl 首张 / 空组 null）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。
- mock 端点 curl 六态验证：seed 会话（图+视频媒体）/ 全量 fork（message_count 4 继承标题）/ 截断 fork at=2（2 条）/ at=999 → 404「消息不存在」/ sess-x → 404「会话不存在」/ 截断叉详情消息重排 id 媒体保留。

**走查结果（91/91 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C27.1 图片点击 → previewImage 预览层开关  — open=true closed=true
PASS  C27.2 视频封面卡 → 全屏覆盖层播放（src 命中）→ X 关闭  — open=true src=true closed=true
PASS  C27.3 气泡长按截断分叉（2 气泡）+ 列表 copy 全量分叉（4 气泡）  — sheet=true trunc=true full=true
PASS  C27.4 草稿按会话持久化：输入 → 切会话清空 → 切回回填  — away="" back="草稿：霓虹调色"
```

既有 87 检查点（C1-C26 含对话助手 C22、文档挂载 C23、Agent 监控 C24、确认门裁决 C25、计划编辑 C26）全数通过，无回归。

**踩坑记录**

1. **uni-h5 longpress 走查模拟**：`@longpress` 由 uni-h5 window 级 touchstart 监听 + 350ms 定时器实现（`initLongPress`，受编译期 `__UNI_FEATURE_LONGPRESS__` 门控，模板含 longpress 即开启），到时向 target 派发 `longpress` CustomEvent。Playwright 侧用 `new Touch` + `TouchEvent('touchstart')` 派发到气泡元素 → 等 500ms → `touchend`，走真实定时器路径触发 action sheet，无需注入假 CustomEvent。
2. **previewImage H5 DOM 结构**：`uni.previewImage` 在 H5 渲染为 z-999 固定层（root div onClick 关闭，mousedown/up 位移 >20px 豁免）内嵌 `uni-swiper`；断言 `uni-swiper` 出现/消失即可，`page.mouse.click` 同点位点击触发关闭（ESC 亦可，useKeyboard 监听）。
3. **C27.4 走查竞态**：`pickSession` 链路 `openSession(await 网络) → restoreDraft` 是异步链，首轮走查点击会话后立即读 textarea 拿到的是**切换前的旧草稿**（away 应为 "" 实测带出旧文本）FAIL；修为等气泡数收敛到目标会话消息数（openSession 落地信号）再读输入框后通过。**异步切会话后断言 UI 值，必须先等渲染落地信号，不能立即读。**
4. **mock-server.mjs 落盘失步第八次复发（MP12/13/16/17/18/19/21/23 同因）**：IDE 层 Edit 显示成功但 Grep 交叉验证盘上无内容（curl 行为亦为旧码）；按固化流程改 node fs 补丁脚本直写（1119→1179 行，md5 变更）+ Grep 交叉验证后重启 curl 六态全过。**mock-server.mjs 验证一律以 Grep/RunCommand 读盘为准。**
5. **草稿攒批设计缺陷（开发中自捕获）**：saveDraft 初版单槽 `draftPending` 对象，防抖窗口内先写 s1 再写 s2 会把 s1 的待写覆盖丢稿；改 `Map<key,text>` 攒批 drain 全量落盘，并有 vitest「按会话隔离」用例锁死。

---

## 2026-08-15 · MP23 里程碑（Agent 团队三期：计划编辑 POST /plan + 成片结果 GET /result）

**背景**

MP22 完成确认门裁决与卡片干预后，计划门在小程序端仍是只读清单——改标题/文案、删任务、加任务需回主站 PlanPanel 操作；run 完成后成片也要回主站看。本里程碑对齐 Web 端三期能力：`POST /api/agent-runs/{id}/plan` 计划编辑（update/remove/add 三态 ops）+ `GET /api/agent-runs/{id}/result` 成片结果，计划门抽屉升级为可编辑面板，done 后详情页直接内联播放成片并支持保存相册。

**契约要点（已读 apps/api/app/routes/agent_team.py edit_plan/run_result 源码确认）**

- `POST /api/agent-runs/{run_id}/plan`：body `{tasks: AgentPlanEditOp[]}`，op `{id, action:'update'|'remove'|'add', title?, input?}`；仅 `awaiting_confirm` 可改（其余 409「仅待确认状态可编辑计划」）。
  - `update`：title 非空覆盖标题；input 按**键合并**进任务 input（不整体替换）。
  - `remove`：删卡并清理其余任务 depends_on 里对该 id 的悬挂引用。
  - `add`：从 input 提取 `kind`（缺省 video）与 `depends_on`（缺省 []）后落新卡，剩余键为任务 input。
  - 返回 `{run_id, plan:{tasks: 简报[]}}`，简报五字段 `id/kind/title/depends_on/status`（对齐后端 `_task_brief`）。
- `GET /api/agent-runs/{run_id}/result`：`done` 外 409「任务尚未完成」；`final_url` 取 assemble done 卡 `output.url`，`duration_sec` 合计 video/image 卡 `input.duration_sec`，tasks 带全卡 output。
- **两段式确认语义**：resume plan 门 `modify` 仅记录裁决、run 保持挂起态（不变 running）——故编辑确认 = 先 `POST /plan` 落库再 `resume('plan','modify')`（徽章仍「待确认计划」，计划已上屏）；二次确认无改动 = 直接 `resume('plan','approve')` 图启动（徽章「执行中」）。

**改动清单**

- `src/types/api.ts`：`AgentPlanEditOp` / `AgentRunTaskBrief` / `AgentRunPlanResult` / `AgentRunResultTask` / `AgentRunResult`（snake_case 原样）。
- `src/api/index.ts`：`updateAgentRunPlan(runId, ops)`（POST /plan，body `{tasks: ops}`，runId 路径编码）/ `getAgentRunResult(runId)`（GET /result）；非 2xx 走 friendlyMessage 人话体系。
- `src/utils/agent-run.ts`：`PlanDraft{edits, removed, added}` / `emptyPlanDraft()` / `buildPlanOps(tasks, draft)`（对齐 Web buildOps 语义：removed 优先且跳过同 id edit 留痕；update 的 input 为 `{...t.input, [inputKey ?? primaryInputText 主键]: inputText}` **合并保留未提交键**（如 duration_sec）；仅标题/仅文案留痕各带对应字段；add 追加末尾、空标题兜底「新任务」、input 固定 `{prompt}`；未改动任务不产生 op）/ `planDirty(ops)`（空 ops→false）。
- `src/pages/agent-runs/detail.vue`：
  - 计划门抽屉升级为可编辑面板（对齐 Web PlanPanel）：任务行 = 序号 + kind 中文名 + 标题 input + 删除钮（本地 removed 标记行内隐藏）+ 主文案 textarea（预填 primaryInputText）+ depends_on 非空显示「依赖 第 N 步」；底部「加任务」新增临时行（new-N，标题/文案可填、可移除该行）。
  - 确认执行：buildPlanOps → planDirty 则先 updateAgentRunPlan 再 resumeAgentRun('plan','modify')（计划落库上屏徽章仍待确认），无改动直 resume('plan','approve')；失败错误内联抽屉不关闭；打回路径保持 MP22 行为（reject+feedback）；合成门只读时间线行为不变。
  - done 成片卡：`detail.status==='done'` 拉 getAgentRunResult（409 静默忽略不渲染）；final_url 非空渲染 video 内联 controls（src 走 resolveUrl 解析）+「合计时长 ≈ Ns · 产物 N 项」+「保存」钮（复用 artifact.vue 下载链路 downloadFile → saveVideoToPhotosAlbum，resultSaving 防重复）。
  - 走查断言钩子：`data-action="plan-confirm" / "plan-add" / "plan-remove:{id}"`、`data-plan-dirty`、`data-field="plan-title:{id}" / "plan-input:{id}"`、`data-result="final"`。
- `scripts/mock-server.mjs`：POST /api/agent-runs/:id/plan（awaiting_confirm 白名单 409 + update/remove/add 三态落内存 + 清理悬挂 depends_on + 返回 {run_id,plan:{tasks:简报}}）+ GET /:id/result（done 外 409「任务尚未完成」；final_url 取 assemble done 卡 output.url，duration_sec 合计 video/image input.duration_sec）。
- `scripts/ux-walkthrough-h5.mjs`：C26.1/C26.1b/C26.2/C26.3/C26.4 五检查点。

**测试矩阵**

- vitest 17 套件 398 用例全绿（较 MP22 口径 382 净增 +16）：
  - agent-run.test.ts +9（buildPlanOps：空草稿→空数组含不存在任务留痕不产生 op / update 标题+文案留痕 input 合并保留 duration_sec / update inputKey 缺省回退 primaryInputText 主键（text 键）/ 仅标题不带 input、仅文案不带 title / remove 优先跳过同 id edit / add 空标题兜底「新任务」input 固定 {prompt} / 混合 remove+update 按 plan 数组序、add 追加末尾；planDirty：空 ops false / 非空 true）。
  - api-agent-runs.test.ts +7（updateAgentRunPlan：POST /plan URL/方法/body {tasks:ops} 契约 / runId 路径编码 / 409 非待确认人话透传 / 404 走 404 硬映射人话；getAgentRunResult：GET /result URL+返回形状原样 / runId 路径编码 / 409「任务尚未完成」人话透传）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。
- mock 端点 curl 验证：不存在 run 的 /plan 与 /result 均 404「运行不存在或已被清理」（路由可达性 + 白名单前置校验）。

**走查结果（87/87 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C26.1 计划门编辑：改标题+改文案 → 确认执行 → POST /plan（update×2）+ resume(modify) → 计划落库上屏  — dirty=1 updates=2 t1=改写标题 t2in=改写后的分镜文案 resume=modify merged=true
PASS  C26.1b 计划门二次确认（无改动）→ resume(approve) → 徽章执行中  — action=approve running=true
PASS  C26.2 删任务+加任务 → 确认 → /plan ops 含 remove+add → resume(modify)  — remove=t3 add=new-1/追加镜头 resume=modify
PASS  C26.3 无改动确认 → 不调 /plan 直 resume(approve) → 徽章执行中  — dirty=0 planCalled=false action=approve running=true
PASS  C26.4 done run 成片卡渲染（video[data-result=final] + 合计时长 ≈7s + 产物 2 项）  — video=true text=合计时长 ≈ 7s · 产物 2 项
```

既有 82 检查点（C1-C25 含资产库 C17、avatar-talk C18、反推 C20、优化 C21、对话助手 C22、文档挂载 C23、Agent 监控 C24、确认门裁决 C25）全数通过，无回归。

**踩坑记录**

1. **404 人话断言与 friendlyMessage 硬映射**：updateAgentRunPlan 404 用例最初期望后端 detail「任务不存在：t9」原样透传，实测 friendlyMessage 对 404 有状态码硬映射「资源不存在或已被清理」——人话体系**状态码硬映射优先于 detail 透传**，detail 透传仅适用无硬映射的状态码（如 409）。用例改为断言硬映射人话。**教训：写 API 层错误断言前先读 friendlyMessage 全表，勿凭既有用例模式推断。**
2. **两段式确认语义踩点**：最初按直觉认为 resume('plan','modify') 会推进 run 态，走查首轮断言「徽章执行中」FAIL；读 agent_team.py resume_run 源码确认 plan 门 modify「仅记录裁决，run 保持挂起态」，正确链路为编辑确认两段式（/plan + modify 落库上屏 → 二次无改动 approve 才启动图）。走查拆 C26.1（落库上屏徽章仍待确认）+ C26.1b（二次确认 approve 徽章执行中）双检查点分别断言。**契约行为一律以后端源码为准，UI 语义围绕源码设计。**
3. **mock-server.mjs 落盘失步第七次复发（MP12/13/16/17/18/19/21 同因）**：IDE 层 Edit 后磁盘内容未同步，按固化流程改用脚本直写文件系统 + Grep 交叉验证落盘内容。**mock-server.mjs 验证一律以 Grep/RunCommand 读盘为准。**
4. **mock-server 进程随会话终止**：前台起的 mock 进程在工具会话结束时被回收，走查 connection refused；改 `lsof -ti:9800 | xargs kill` 后 `nohup node scripts/mock-server.mjs &` 后台常驻解决。

---

## 2026-08-15 · MP22 里程碑（Agent 团队监控二期：确认门裁决 + 卡片干预）

**背景**

MP21 完成只读监控 + 取消后，确认门（计划门 awaiting_confirm / 合成门 awaiting_assembly）仍需回主站裁决，任务卡也无法在小程序端干预。本里程碑对齐 Web 端二期能力：`POST /api/agent-runs/{id}/resume` 确认门裁决（approve/reject + 方向性批注）与 `POST /api/agent-runs/{id}/tasks/{tid}/action` 卡片干预（改文案/重生成/通过），小程序端全程无需回主站。

**契约要点（已读 apps/api/app/routes/agent_team.py resume_run/task_action 源码确认）**

- `POST /api/agent-runs/{run_id}/resume`：body `{gate:'plan'|'assembly', action:'approve'|'modify'|'reject', feedback?}`；plan 门仅 `awaiting_confirm`/`planning` 可投（其余 409），approve→running、reject→planning + feedback 落 error；assembly 门仅 `awaiting_assembly` 可投（其余 409），approve/reject 均回 running。
- `POST /api/agent-runs/{run_id}/tasks/{task_id}/action`：body `{action:'edit'|'regenerate'|'approve', payload?}`，**返回任务卡片顶层字段（无包装）**，前端用返回卡局部替换不重拉详情。
  - `edit`：`payload={input:{...}}` 合并进任务 input，卡片回 `pending` 待重跑。
  - `regenerate`：仅 `done`/`error` 可投（其余 409）；`attempt≥3` 400（已达最大重试次数）；`assemble` 卡 400（请走合成确认门）；`payload.guidance` 拼进主文案（prompt/dialogue 键），attempt+1 回 pending；run 处于 error/done/awaiting_assembly 时回 running。
  - `approve`：无 payload，卡片置 `approved`。

**改动清单**

- `src/types/api.ts`：`AgentResumeBody` / `AgentTaskActionBody`。
- `src/api/index.ts`：`resumeAgentRun(runId, body)` / `agentTaskAction(runId, taskId, body)`（双段路径 encodeURIComponent，body 原样透传，非 2xx 走人话体系）。
- `src/pages/agent-runs/detail.vue`：
  - 确认门横幅（`awaiting_confirm`→计划门 layers 图标「计划待确认」；`awaiting_assembly`→合成门 film 图标「合成前确认」；accent 边框 + 「去裁决」CTA；`data-gate` / `data-action="open-gate"` 供走查断言）。
  - Sheet 底部抽屉裁决：计划门=任务清单逐项 + approve/reject + reject 方向性批注输入；合成门=时间线时长列（taskDurationSec）+ 合计时长 ≈ Ns。resume 成功抽屉/横幅关闭并刷新详情续接 SSE；裁决失败错误内联抽屉不关闭。
  - 卡片操作行（本地纯函数 `taskActionable`：非 running/queued 且非 assemble 且 run 非终态；`taskRegenerable`：done/error）：改文案（pencil，抽屉预填 primaryInputText 主文案，保存 `edit payload={input:{...}}`）/ 重生成（refresh-cw，抽屉引导词透传 `payload.guidance`，空引导词不带 payload）/ 通过（check，success 色直提 approve）；成功用返回卡局部替换（attempt 递增上屏「第 N 次」）；`data-action="task-edit/task-regen/task-approve:{id}"` 供走查断言。
- `scripts/mock-server.mjs`：resume 端点（双门白名单 409 + 状态迁移）+ task action 端点（approve 直返卡 / edit 合并回 pending / regenerate 409·400 全分支 + guidance 拼文案 attempt+1）。
- `scripts/ux-walkthrough-h5.mjs`：C25.1-C25.7 七检查点。

**测试矩阵**

- vitest 17 套件 382 用例全绿（较 MP21 口径 374 净增 +8）：api-agent-runs.test M22 块——resume（POST URL + gate/action/feedback 契约字段 / feedback 缺省 body 不含该字段 + runId 路径编码 / 409 状态不符人话透传）+ agentTaskAction（runId/taskId 双段路径编码 + body 透传 / edit payload={input:{...}} 原样透传返回卡顶层无包装 / approve 无 payload 字段 / 409 非 done·error 重生成人话 / 400 合成卡走合成门人话）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。
- mock 端点 curl 验证：resume 双门 approve/reject 状态迁移 + 409 白名单；task action 六分支（approve/edit/regenerate/409/400 合成卡/400 attempt≥3）。

**走查结果（82/82 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C25.1 计划门横幅 → 去裁决 → 抽屉计划清单 3 项  — banner=true sheet=true items=3
PASS  C25.2 计划门 approve → 徽章执行中 + 横幅/抽屉关闭  — running=true banner=0 sheet=0
PASS  C25.3 合成门抽屉：时间线时长列 + 合计 ≈ 7s  — banner=true durs=3 total=合计时长 ≈ 7s
PASS  C25.4 合成门 reject（带批注）→ 回执行中 + 横幅消失  — running=true banner=0
PASS  C25.5 卡片改文案：预填主文案 → 保存 → 卡回排队中 + 抽屉关闭  — prefill=科技感开场旁白 pending=true sheet=0
PASS  C25.6 卡片重生成：引导词透传 → 卡回排队中 + 第 2 次尝试
PASS  C25.7 卡片通过 → 状态徽章「已通过」
```

既有 75 检查点（C1-C24 含资产库 C17、avatar-talk C18、反推 C20、优化 C21、对话助手 C22、文档挂载 C23、Agent 监控 C24）全数通过，无回归。

**踩坑记录**

1. **C25.1 找不到目标 run**：C24.9 把列表过滤停在「已终止」桶，C25 进列表后需先点 `[data-filter="all"]` 重置回「全部」再点卡，否则种子 run 不在当前桶内导致点卡超时。
2. **走查与单测断言一致性**：改文案抽屉预填值取 `primaryInputText`（prompt/dialogue 首非空键），走查种子卡 input.prompt='科技感开场旁白' 与断言 `prefill=科技感开场旁白` 对齐；重生成引导词拼主文案后 attempt+1，徽章文案「第 2 次」由 attempt=2 驱动，两处断言均依赖 mock-server 端点与后端 task_action 行为逐行对齐。

---

## 2026-08-15 · MP21 里程碑（Agent 团队监控一期：只读监控 + 取消）

**背景**

主站 Agent 团队（多任务拆解执行：剧本→分镜→图像→视频→合成）在 Web 端有完整监控面板，MiniProgram 端缺失该能力。本里程碑实现一期只读监控 + 取消：运行列表（状态过滤/进度/轮询）、运行详情（SSE 实时事件流/任务卡片/产物渲染/取消）、作业页 Agent 入口，复用 MP19 SSE 增量解析器与 MP20 组件层。

**契约要点（已读 apps/api/app/routes/agent_team.py + services/agent_team_exec.py 源码确认）**

- `GET /api/agent-runs?status=`：单值精确过滤（不支持逗号多值），列表按 created_at 倒序，approved 计入 done；返回 AgentRunSummary[]（id/level/goal/status/created_at/task_counts{total,done,error}）。
- `GET /api/agent-runs/{run_id}`：AgentRunDetail（id/goal/level/status/error/plan[AgentRunTask]/created_at/updated_at）。
- `POST /api/agent-runs/{run_id}/cancel`：409 白名单（planning/awaiting_confirm/running/awaiting_assembly），成功置 canceled。
- `GET /api/agent-runs/{run_id}/events?after=N`：SSE 事件流，帧 `event: task_status\ndata: {...}\n\n`；业务事件类型 task_status/plan/done/error/confirm_required/blocked/decision_required/ack/verdict；cancel 事件载荷 {run_id,status:'canceled'} 无 task_id。
- 任务状态：pending/queued/running/verifying/rejected/approved/done/error；任务 kind：script/storyboard/image/video/audio/subtitle/verify/assemble。
- 终态集：done/error/canceled；确认门状态：awaiting_confirm（计划门）/awaiting_assembly（合成门）。

**改动清单**

- `src/types/api.ts`：`AgentRunStatus` / `AgentRunTaskCounts` / `AgentRunSummary` / `AgentRunTask` / `AgentRunDetail` / `AgentRunSseEvent`（snake_case 原样）。
- `src/utils/agent-run.ts`（新）：`RUN_STATUS_META`/`TASK_STATUS_META`（徽章文案+tone 对齐 Web agentRunMeta.ts 五态）；`RUN_TERMINAL` 终态集；`hasActiveRuns`/`inRunFilter`/`runCancellable`；`RUN_FILTERS` 语义桶（后端仅单值过滤，语义桶客户端分桶）；`taskKindLabel`/`taskKindIcon`；`extractTaskMedia`（产物防御式提取：url/video_url/image_url/audio_url/urls[]/text，扩展名粗判媒体类型）；`primaryInputText`/`verdictText`/`taskDurationSec`；`mergeTaskStatus`（task_status 事件增量合并，cancel 载荷无 task_id 原样返回）；`mergePlanTasks`（plan 事件双包法容错 {tasks:[...]}/{plan:{tasks:[...]}}，按 id 更新保留已有 input/output/verdict）；`agentRunEventText`（SSE 事件→动态流条目：ack/plan/task_status/verdict/confirm_required/blocked/decision_required/done/error）。
- `src/api/index.ts`：`listAgentRuns`/`getAgentRun`/`cancelAgentRun`/`watchAgentRunEvents`（复用 MP19 `createSseParser` 增量解析器，uni.request 常规读取非 enableChunked；abort→「已停止监听」；非 2xx 走人话体系；DEFAULT 30s 超时档）。
- `src/pages/agent-runs/agent-runs.vue`（新）：横向 chips 过滤（全部/进行中/待确认/已完成/已终止，带计数）；run 卡片流（goal/level/进度/时间/状态 Tag）；空态引导（主站发起）；页面原生滚动保下拉刷新；轮询语义对齐 jobs 页（有非终态 2s 轮询，全终态即停）。
- `src/pages/agent-runs/detail.vue`（新）：NavBar 右侧「取消」（runCancellable 白名单可见，showModal 二次确认，成功后本地置 canceled 并断开）；首屏 GET 详情（plan 全任务卡片：kind 图标/标题/状态 Tag/输入摘要/产物渲染（视频内联 controls/图像点按预览/音频占位/文本截断）/验收意见）；非终态订阅 SSE 事件流（task_status→mergeTaskStatus 合并/plan→mergePlanTasks 合并/done→置终态/error→置 error+message/confirm_required→置 awaiting_*）；事件动态流倒序 ≤50 条（agentRunEventText 逐事件上屏+语义色图标）；SSE 断线降级 2s 轮询直至终态；代际令牌 generation 防旧通道回调污染新状态；`data-run-status`/`data-feed-count`/`data-task-id` 供走查断言。
- `src/pages/jobs/jobs.vue`：NavBar 右侧 Agent 入口（zap 图标 + accent 边框 + 文字 Agent）→ navigateTo agent-runs；`data-action="open-agent-runs"`。
- `src/pages.json`：注册 pages/agent-runs/agent-runs（原生导航+下拉刷新）与 pages/agent-runs/detail（custom 导航）。
- `scripts/mock-server.mjs`：agent-runs 四端点（GET 列表 status 过滤+approved 计入 done / GET 详情 / POST cancel 409 白名单 / GET events SSE 三场景：success=task_status×6+done 接力 / gate=history 回放 / pending=仅排队）；`/__seed` 支持 agentRuns 种子（goal/status/level/scenario/plan/history）；`/__reset` 清空 agentRuns/agentRunSeq。
- `scripts/ux-walkthrough-h5.mjs`：C24.1-C24.9 九个检查点。

**测试矩阵**

- vitest 17 套件 374 用例全绿（313+61）：agent-run.test.ts 47（RUN_STATUS_META/TASK_STATUS_META 文案+tone/RUN_TERMINAL/hasActiveRuns 三态/inRunFilter 五桶/runCancellable 白名单/taskKindLabel/taskKindIcon/extractTaskMedia 五产物+urls 回退+扩展名粗判/primaryInputText/verdictText 已知键取首个非空/taskDurationSec/mergeTaskStatus 增量合并+cancel 无 task_id 原样/mergePlanTasks 双包法+保留 input/output/agentRunEventText 七事件+未知类型 null）+ api-agent-runs.test.ts 14（listAgentRuns 无参/带 status qs/getAgentRun 路径编码/cancel 409 透传/watchAgentRunEvents 事件逐帧上抛含 done/abort 停流/非 2xx 人话/畸形 JSON 跳过/未知事件类型忽略）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。
- mock 端点 curl 六态验证：`/__seed` 三 run / GET 列表 status 过滤+approved 计入 done / GET 详情 / POST cancel 200 / POST cancel 重复 409 / SSE success 场景 7 帧接力后内存态推进 done。

**走查结果（75/75 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C24.1 作业页 Agent 入口 → 运行列表页  — http://localhost:9810/#/pages/agent-runs/agent-runs
PASS  C24.2 列表渲染 3 卡（执行中/待确认计划/规划中徽章）  — cards=3
PASS  C24.3 过滤「待确认」桶 → 仅确认门 run  — cards=1
PASS  C24.4 列表点卡 → 详情页（goal + 3 任务卡）  — nav=true tasks=3
PASS  C24.5 SSE 接力 → run 徽章跃迁 done + 动态流上屏 + 图/视频产物渲染  — done=true feed=7 video=1 image=1
PASS  C24.6 终态后取消按钮隐藏  — cancel=0
PASS  C24.7 确认门 run：徽章「待确认计划」+ 动态流含确认门事件  — 计划确认门已打开，请到主站确认已拆成 3 步
PASS  C24.8 取消（二次确认）→ 徽章「已取消」+ 按钮消失  — canceled=true cancel=0
PASS  C24.9 列表「已终止」桶含刚取消的 run  — cards=1
```

既有 66 检查点（C1-C23 含资产库 C17、avatar-talk C18、反推 C20、优化 C21、对话助手 C22、文档挂载 C23）全数通过，无回归。

**踩坑记录**

1. **mock-server 编辑失步第六次复发（MP12/13/16/17/18/19 同因）**：Read 工具对 mock-server.mjs 读取结果与 Grep 行号不一致（Read 显示 834 行旧版，Grep 显示 934 行含 agent-runs 端点），按固化流程 `wc -l` + `md5` + Grep 全文交叉验证确认磁盘新版正确，Read 缓存失步为 IDE 层现象。**教训再固化：mock-server.mjs 验证一律以 Grep/RunCommand 读盘为准，Read 仅作参考。**
2. **C24.7 走查时序竞态**：gate 场景 history 回放两帧（ack+confirm_required）120ms 间隔到达，走查在首帧后即读 `.detail__feed` 文案导致 confirm_required 未上屏 FAIL。修复：走查增加 `waitForFunction` 等 `data-feed-count>=2` 再断言文案。**教训：SSE 逐帧回放场景的走查断言必须等帧计数到位，不能 waitForSelector 首帧即读。**
3. **列表页 chips 文字换行**：横向 scroll-view 内 flex 子项默认 `flex-shrink:1`，视口不足时 chips 被压缩导致「全部」「进行中」等两字/三字标签换行。修复：`.runs__chip` 加 `flex-shrink: 0`（与 assistant.vue/job-card.vue 既有约定一致），H5 复建后视觉正常。**约定：横向滚动 chips/标签行一律显式 flex-shrink: 0。**
4. **pageerror 噪音**：`BodyStreamBuffer was aborted` 为 uni-h5 fetch abort 停止 SSE 流时的内部 console noise（C22.3/C24.5/C24.7 均出现），fail 回调已正常处理「已停止监听」，非功能缺陷，微信端无此路径。

---

## 2026-08-14 · MP20 里程碑（对话助手二期·文档挂载：/api/docs + chips 挂载 + document_ids 上行）

**背景**

Web 端对话助手支持文档挂载（上传 pdf/docx/txt/md → 后端切块 embedding 索引 → 对话时随消息携带 document_ids，助手引用文档内容回答）。本里程碑把该能力落到 MiniProgram 对话页：文档面板（上传/挂载切换/删除）+ 输入栏上方挂载 chips（≤8，X 可移除）+ 发送时 document_ids 随 `/api/agent/chat` 上行 + user 气泡文档留痕 + 错误重试复用上轮挂载，语义对齐 Web 端。

**契约要点（已读 apps/api/app/routes/documents.py / services/docs.py 源码确认）**

- `POST /api/docs/upload`：multipart 字段名 `file`（非 `image`，与 `/api/upload` 区分）；扩展名白名单 `_KINDS={pdf,docx,txt,md}`（不符 400）；单文件 ≤50MB（`MAX_FILE_BYTES`）；201 返回 DocItem。
- DocItem：`{id, filename, kind, size, chunk_count, status, created_at}`；status 三态 `ready`（已索引）/ `partial`（超长截断）/ `no_embed`（向量服务不可用）。
- `GET /api/docs` 列表 / `DELETE /api/docs/{doc_id}` 删除（连同索引）。
- `POST /api/agent/chat` 入参增 `document_ids?: string[]`，与 messages/session_id 并列；文档内容检索注入由后端 runner 完成，SSE 事件类型零变更。

**改动清单**

- `src/types/api.ts`：`DocItem`（status 三态 + string 兜底前向兼容）。
- `src/utils/doc.ts`（新）：`DOC_EXTS` / `DOC_MAX_BYTES`（50MB）/ `docStatusLabel`（三态人话映射对齐 Web/Mobile 文案，未知状态原样透传）/ `formatDocSize`（B/KB/MB）/ `validateDocFile`（扩展名大小写不敏感 + 尺寸先验，人话拒绝）。
- `src/api/index.ts`：`listDocs` / `uploadDoc`（apiUpload 字段名 `file`）/ `deleteDoc`；`agentChatStream` 增 `documentIds?` 可选参（非空才序列化 `document_ids`，空不带字段保 MP19 调用兼容）。
- `src/stores/assistant.ts`：`docList/docListLoading/docListError/docUploading/attachedDocs` 五态 + `ATTACHED_DOCS_MAX=8`；`loadDocs`（失败入 docListError 不阻塞对话）/ `toggleAttachDoc`（再点卸载、上限截停）/ `detachDoc` / `uploadAndAttach`（201 插列表头 + 未满自动挂载）/ `removeDoc`（列表与挂载同步移除）；`send` 挂载快照 → chips 清空 → user 气泡 `docs` 留痕（{id,filename}）→ document_ids 上行；`retry` 复用上轮挂载（模块级 `lastDocIds` 快照）；`newChat` 清空挂载与快照。
- `src/pages/assistant/assistant.vue`：输入栏左侧 paperclip ghost 钮（面板开或有挂载时 accent 高亮）开文档 Sheet 面板（上限提示 + 上传入口 + 空态/错误态 + 文档行：图标/名称/状态·尺寸·段数 meta/挂载 check/trash-2 删除 `@tap.stop` 防穿透）；输入栏上方 chips 横滑行（X 移除）；user 气泡 docs 留痕行；`chooseDoc` 跨平台（`#ifdef MP-WEIXIN` chooseMessageFile 会话文件 / `#ifndef` chooseFile，同 ref-audio-field 模式）+ 客户端先验 + toast 反馈；删除 showModal 二次确认。
- `scripts/gen-icons.mjs`：白名单 +paperclip/file-text（check/trash-2/upload/loader-circle/x 既有），重跑生成 icons.generated.ts。
- `scripts/mock-server.mjs`：文档三端点（upload 首部 8KB 前缀解析 filename + binary→utf8 解码防中文名乱码 + 白名单 400 兜底；docs 内存态 /__reset 清空，unshift 保 created_at 倒序）+ chat 端点 document_ids 回显（「已挂载 N 份文档：名称」供走查断言上行到达）。
- `scripts/ux-walkthrough-h5.mjs`：C23.1-C23.5 五个检查点。

**测试矩阵**

- vitest 15 套件 313 用例全绿（287+26）：doc.test.ts 11（状态映射/尺寸换算/先验三态）+ api-index +5（列表原样/字段名 file 201/400 detail 透传/DELETE 路径编码/404 人话）+ assistant-store +10（loadDocs 成败/挂载切换上限/detach/send 上行+清空+留痕/无挂载不带字段/retry 复用+非错误不重试/uploadAndAttach 成败/removeDoc 同步/newChat 清空）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。
- mock 端点 curl 五态验证：txt 上传 201 中文名不乱码 / exe 400 白名单兜底 / 列表 created_at 倒序 / chat document_ids 回显「已挂载 1 份文档：需求笔记.txt」/ 删除 200 列表清空。

**走查结果（66/66 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C23.1 文档面板打开 → 空态渲染  — 还没有文档，先上传一份吧
PASS  C23.2 上传两份文档 → 列表渲染 + 双双自动挂载  — rows=2 checks=2 names=接口约定.md|需求笔记.txt
PASS  C23.3 chips 行 ×2 → chip X 卸载首枚剩「接口约定.md」  — before=2 remain=接口约定.md
PASS  C23.4 发送 → document_ids 上行回显 + chips 清空 + user 气泡留痕  — echo=true chips=0 ref=接口约定.md
PASS  C23.5 面板删除文档（二次确认）→ 列表减一  — 2→1
```

既有 61 检查点（C1-C22 含资产库 C17、avatar-talk C18、反推 C20、优化 C21、对话助手 C22）全数通过，无回归。

**踩坑记录**

1. **mock multipart 中文文件名乱码**：upload 端点按 binary 累积首部前缀解析 `filename="..."`，curl 上传「需求笔记.txt」回显乱码——binary 编码下多字节 UTF-8 被逐字节截断。修复：命中文件名后 `Buffer.from(name,'binary').toString('utf8')` 二次解码，curl 复验中文名原样。**教训：mock 解析 multipart 头部时，文件名等用户可控文本必须按 utf8 还原，不能直接消费 binary 串。**
2. **文档面板模板嵌套错位不渲染**：首版把文档 Sheet 写进会话 Sheet 内部（visible 互斥导致永不渲染），走查 C23.1 超时取证发现 DOM 无 `.assistant__docs-*`；移出同级平铺后通过。**教训：多个 Sheet 弹层必须同级平铺，嵌套会被父级 visible 门控。**
3. **eslint 缩进告警**：assistant.vue 新增模板块缩进与既有风格不一致（2 空格/4 空格混用），`eslint --fix` 自动归位，回归 0 警。

---

## 2026-08-14 · MP19 里程碑（对话助手一期：SSE 流式对话 + 会话管理 + 对话页）

**背景**

主站智能体对话（POST /api/agent/chat，SSE 流式：文本/工具调用/媒体结果）是创作入口的对称形态——描述意图由助手直接调引擎出图/视频。本里程碑把该能力落到 MiniProgram：自研 SSE 增量解析器（不依赖 TextDecoder，微信真机可能无）+ uni.request enableChunked 分块渲染 + 会话管理 + 对话页 UI，创作页 NavBar 加助手入口。

**契约要点（已读 apps/api/app/routes/agent.py / agent/runner.py 源码确认）**

- `POST /api/agent/chat`：入参 `{messages:[{role,content}], session_id?}`（content ≤8000）；SSE 帧 `event: msg\ndata: {AgentEvent JSON}\n\n`，结束帧 `event: done\ndata: {}`；AgentEvent 七型 `text/tool/image/video/audio/model3d/error`（tool 带 name，媒体带 urls+worker）。
- 会话 id 经响应头 `X-Agent-Session-Id` 立即返回（新会话=后端新建；SSE 事件类型零变更）。
- 会话管理：`GET /api/agent/sessions`（updated_at 倒序 summary）/ `GET /api/agent/sessions/{sid}`（messages id 升序，tool 消息 media 挂产物）/ `DELETE` 连同消息；归属校验 404 不泄露；nsfw 会话仅 X-NSFW 上下文可见。
- runner 主循环：user/assistant/tool 消息逐条落库（model-visible means logged），错误事件不落库。

**改动清单**

- `src/types/api.ts`：AgentEvent/AgentChatMessage/AgentSessionSummary/AgentSessionMedia/AgentSessionMessage/AgentSessionDetail。
- `src/utils/sse.ts`（新）：`createSseParser`——跨块二进制拼接 + 自实现 UTF-8 增量解码（多字节跨块挂起、残缺字节 U+FFFD 容错不中断流）；空行分帧（容错 \r\n）、多行 data \n 拼接、comment/未知字段忽略、空 data 帧不派发、尾部不完整帧丢弃；ArrayBuffer/带偏移 View 双入参。
- `src/api/client.ts`：导出 `friendlyMessage`；新增 `buildRequestHeaders`（apiFetch 同源头部子集：Bearer + X-NSFW + Accept/Content-Type）。
- `src/api/index.ts`：`agentChatStream({messages, sessionId?}, onEvent)`——uni.request enableChunked，onHeadersReceived 取 statusCode + X-Agent-Session-Id（大小写不敏感），onChunkReceived 喂解析器；msg 帧 JSON.parse 上抛、done/未知帧忽略、畸形 JSON 跳过不中断；abort→「已停止生成」、非 2xx 走人话体系、LONG 180s 超时档；`listAgentSessions`/`getAgentSession`/`deleteAgentSession`。
- `src/stores/assistant.ts`（新，非持久化）：ChatMessage UI 模型（text/media/toolActivity/error/streaming）；send 压缩历史为 {role,content}（纯媒体占位空文本不上行）+ 本地先落双气泡再启动流；text 追加/tool 活动条/媒体落块/error 内联；完成回填 sessionId + 静默刷新会话列表；停止保留部分内容、空内容气泡移除；openSession 回放 tool 媒体并入前条 assistant 气泡；流句柄模块级持有防 Proxy 包裹。
- `src/pages/assistant/assistant.vue`（新）：NavBar（返回 + 新对话 plus + 历史 history）；user 右 accent 气泡/assistant 左 surface 气泡；工具活动条（loader 旋转 + 人话映射）+ 三点思考动画；媒体内联（图网格点击 previewImage / video 播放 / audio·model3d 芯片占位）；错误内联（circle-alert + 文案）；底部输入栏（auto-height textarea、Enter 发送、流式中变 danger 停止键）；会话 Sheet（标题/相对时间/条数、点击回放、trash 二次确认删除）。
- `src/pages.json`：注册 pages/assistant/assistant（custom 导航）；`src/pages/index/index.vue`：NavBar 右侧助手入口（message-square）；`scripts/gen-icons.mjs`：白名单 +square/message-square（重跑生成 47 枚）。
- `tests/helpers/mock-uni.ts`：enableChunked 分块任务 mock（onHeadersReceived→逐块 onChunkReceived→success 异步派发；abort 停流 + fail('request:fail abort')；setChunkedError 注错）；`allRequests()` 全量调用记录。
- `scripts/mock-server.mjs`：agent 端点（chat SSE 五帧 150ms 间隔流 + X-Agent-Session-Id + `Access-Control-Expose-Headers`；会话内存 CRUD + /__reset 复位）。
- `scripts/ux-walkthrough-h5.mjs`：C22.1-C22.6 六个检查点。

**测试矩阵**

- vitest 14 套件 287 用例全绿（276+11）：sse.test.ts 17（帧解析/跨块/UTF-8 容错/双入参形状）+ api-agent.test.ts 16（请求构造/事件流/异常路径/会话端点）+ assistant-store.test.ts 11（发送流程/流式事件/停止/会话管理/工具映射）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功；mp-weixin 产物 `pages/assistant/` 四件套在册、app.json 路由含 assistant。
- mock 端点 curl 六态验证：新会话 SSE 五帧 + 双响应头 / 续聊 session_id 复用同 id / 列表（message_count=6 两轮）/ 回放（user/assistant/tool 媒体）/ 删除 / 未知 id 404。

**走查结果（61/61 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C22.1 创作页助手入口 → 助手页空态渲染
PASS  C22.2 发送 → 流式回复 + 生成图内联渲染 + 输入清空  — reply=true image=true draft=""
PASS  C22.3 流式中停止 → 中断后发送键恢复
PASS  C22.4 历史抽屉列出会话（标题回填）  — 画一只胶片风的猫
PASS  C22.5 打开历史会话 → 消息+媒体回放
PASS  C22.6 删除会话 → 抽屉空 + 主区回空态
```

既有 55 检查点（C1-C21 含资产库 C17、avatar-talk C18、反推 C20、优化 C21）全数通过，无回归。

**踩坑记录**

1. **mock-server 编辑失步第五次复发（MP12/13/16/17/18 同因）**：Edit 回执成功且 Read 可见新内容，但 Edit 二次修改报「String not found」、Grep/node 读磁盘均无 MP19 痕迹、mtime 停留旧版——IDE 覆盖层与磁盘失步。按固化流程一次性 patch 脚本直写磁盘 + 落盘断言 + `node --check` 语法验证生效（patch 脚本用后删除）。**教训再固化：mock-server.mjs 改动一律脚本直写，Edit 后必须 node 读盘断言，双服务重启再取证。**
2. **助手页输入栏 z-index 压过抽屉遮罩（MP13 资产页 footer 同因复发）**：`assistant__inputbar` 定 z-index:100 高于 ui-sheet 遮罩 90，C22.5 点会话条目被输入栏 textarea 拦截 pointer events（Playwright 58 次重试超时）。降 z-index:50 并注释层叠约定（页面级 fixed 栏必须 < 遮罩 90），复测通过。**约定升级：新增 fixed 定位元素时显式声明 z-index ≤50。**
3. **H5 fetch 跨域读自定义响应头**：`X-Agent-Session-Id` 在 uni-h5（fetch）下必须服务端 `Access-Control-Expose-Headers` 显式暴露才能读到，否则 sessionId 恒 null（新会话无法续聊）；微信原生 wx.request 无此限制。mock 已加暴露头，真后端 FastAPI CORSMiddleware 需核对 expose_headers 配置。
4. **C22.3 pageerror 噪音**：`BodyStreamBuffer was aborted` 为 uni-h5 fetch abort 停止流时的内部 console noise（fail 回调已正常处理「已停止生成」），非功能缺陷，微信端无此路径。
5. **sse.ts 注释与实现不一致（自审发现）**：注释称「data 为空的帧按 SSE 规范不派发」但实现 `if (!hasData) return` 对空 data 帧仍派发空串；修为实现对齐规范（`data === ''` 不派发）+ 补测试用例锁定。

---

## 2026-08-14 · MP18 里程碑（创作页优化提示词：口语输入 → /api/optimize → LLM 扩写回填）

**背景**

Web 端创作页早有 OptimizeButton（口语化输入 → LLM 按题材扩写专业英文 prompt 回填）。本里程碑把该能力补齐到 MiniProgram 创作页，与反推钮组成 prompt 卡右下角 ghost 钮组，主站创作链路交互全量对齐。

**契约要点（已读 apps/api/app/routes/optimize.py 源码确认）**

- `POST /api/optimize`：JSON 入参 `{prompt, kind}`；`kind` 直通后端按题材切系统提示（image/image_edit/video/audio）。
- `optimized` 恒有值；`negative` 仅 image/image_edit/video 类返回（audio 等单段类无），解析失败时后端启发式兜底。
- `model`/`style`/`agent_id`/`style_hint` 为 Web 高阶入参（模型族方言/智能体人格），移动端本期走后端默认。
- 502 优化失败 / 503 LLM 不可达，由 apiFetch 透传人话。

**改动清单**

- `src/types/api.ts`：`OptimizeResult{optimized, negative: string|null}`。
- `src/api/index.ts`：`optimizePrompt({prompt, kind})` POST /api/optimize，negative 缺省归一化为 null。
- `src/pages/index/index.vue`：prompt 卡右下角 ghost 钮组（优化 sparkles + 反推 wand-sparkles 并排，对齐 Web ob-btn 语言）；`handleOptimize` 空 prompt 禁用 + optimizing/reversing/submitting 三态防重复 → prompt 覆盖回填 + negative 有值展开填入 + toast；失败人话进 formError 不覆盖已有 prompt。
- `scripts/mock-server.mjs`：`POST /api/optimize`（image/video 带 negative / audio negative=null / 空 prompt 422）。
- `scripts/ux-walkthrough-h5.mjs`：C21.1-C21.2 两个检查点。

**测试矩阵**

- vitest 11 套件 243 用例全绿（238+5：请求形状 / audio 无 negative 归一化 / video 带 negative / 502 / 503）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。

**走查结果（55/55 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C21.1 创作页优化按钮渲染  — 优化
PASS  C21.2 优化 → prompt 扩写 + 负向框展开填入  — prompt=true negative=blurry, watermark, deformed, bad anatomy
```

既有 53 检查点（C1-C20 含资产库 C17、avatar-talk C18、反推 C20）全数通过，无回归。

**踩坑记录**

1. **mock-server 编辑失步第四次复发（MP12/13/16/17 同因）**：Edit 回执成功但磁盘旧版无 /api/optimize 路由，curl 取证 404。按既有教训 python 直接落盘 + grep/md5 断言 + 重启进程后恢复。**教训已固化流程：Edit 后立即 shell grep 断言落盘。**
2. **引擎选择随 pinia 持久化致走查断言漂移**：C21 首跑时持久化状态选中视频引擎（kind=video），mock 返回无前缀断言的 `masterpiece` 开头文案，C21.2 FAIL。修复：走查脚本 C21 前置 `clickEngine('SDXL 文生图')` 切回图像引擎，保证 kind=image 确定性。**教训：走查断言依赖全局态时，前置显式置态，不信持久化默认值。**

---

## 2026-08-14 · MP17 里程碑（创作页反推提示词：选图/视频 → /api/reverse → VLM 回填）

**背景**

Web 端创作页早有 ReverseButton（上传图/视频 → VLM 反推英文 prompt 回填）。本里程碑把该能力补齐到 MiniProgram 创作页，覆盖主站创作链路最后一个缺失交互；并在 H5 走查中取证修复一个跨平台死路缺陷。

**契约要点（已读 apps/api/app/routes/reverse.py 源码确认）**

- `POST /api/reverse`：multipart 字段名 `file`（非 `image`，与 `/api/upload` 区分）；`kind` 按 content-type 前缀判定、判定不了退回扩展名；`negative` 仅图像反推可能返回（视频/音频无）。
- 体积上限：image 20MB / video 50MB / audio 20MB（`reverse_max_*_mb`），超限 413；VLM 不可达/非 200/空 → 502。
- `X-NSFW` 头触发 NSFW 图像走 JoyCaption 专线（`joycaption_base_url`），视频一律走 Qwen3-VL。

**改动清单**

- `src/types/api.ts`：`ReverseResult{kind, prompt, negative: string|null}`。
- `src/api/client.ts`：`apiUpload` 注入 `X-NSFW`（nsfwIntent 开启时）。
- `src/api/index.ts`：`reversePrompt(filePath)` = `apiUpload('/api/reverse', filePath, 'file')`，negative 缺省/null 归一化为 null。
- `src/pages/index/index.vue`：prompt 卡右下角 ghost 反推钮（wand-sparkles）；`handleReverse` → `runReverse` → prompt 覆盖回填 + negative 有值展开填入 + toast；失败进 formError 不覆盖已有 prompt。
- `scripts/mock-server.mjs`：`POST /api/reverse`（multipart 头解析 filename/Content-Type 定 kind；图片带 negative / 视频 null / 未识别 400）。
- `scripts/ux-walkthrough-h5.mjs`：C20.1-C20.4 四个检查点。

**测试矩阵**

- vitest 11 套件 238 用例全绿（232+6：字段名 file / Authorization / X-NSFW 开关 / negative 归一化 / 413 / 502）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。

**走查结果（53/53 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C20.1 创作页反推按钮渲染  — 反推
PASS  C20.2 点反推 → action sheet 渲染（图片/视频/取消）  — 3 项
PASS  C20.3 视频反推 → prompt 回填；无 negative 不展开负向框  — prompt=true toggle=1
PASS  C20.4 图片反推 → prompt 覆盖 + 负向框展开填入 mock negative  — prompt=true negative=blurry, watermark, deformed, cartoon
```

既有 49 检查点（C1-C19 含资产库 C17、avatar-talk C18、R18 C14-C16）全数通过，无回归。

**踩坑记录**

1. **uni.chooseMedia 是 H5 死路（本里程碑核心缺陷）**：MP17 初版用 `uni.chooseMedia({mediaType:['image','video']})` 实现图/视频合一选择器——该 API 仅微信小程序系实现，grep `node_modules/@dcloudio/uni-h5/dist/uni-h5.es.js` 导出清单无 chooseMedia（chooseImage/chooseVideo/showActionSheet 均在册），H5 端点按直接无响应。修复：`showActionSheet(图片/视频)` + `chooseImage`/`chooseVideo` 全端三件套，与 ref-image-field/ref-video-field 同构。**教训：uni API 选型先 grep uni-h5 dist 导出清单验证平台支持，不信文档/直觉。**
2. **mock-server 编辑失步第三次复发（MP12/13/16 同因）**：Edit 工具回执成功且 Read 可见新内容，但 shell grep 磁盘为 0、mtime 停留在编辑前——IDE 覆盖层与磁盘失步，mock 进程读到旧盘报「mock 未覆盖」。按既有教训 python 直接落盘 + grep 断言 + 重启进程后恢复。**教训再强化：Edit 后立即 shell grep 断言落盘，不等运行时矛盾再查。**
3. **uni-h5 的 class 落在外壳**：C20.4 首轮 FAIL（negative 读空）——`.create__negative-input` class 落在 `uni-textarea` 自定义元素上，原生 `<textarea>` 在内层，Playwright `inputValue()` 对非表单元素抛错。截图取证确认 UI 行为完全正确（prompt 覆盖 + 负向框展开填入 + toast），改选择器为 `.create__negative-input textarea`（同 `.field__input input` 既有模式）后通过。**教训：走查失败先截图/DOM 取证区分产品缺陷与测试选择器缺陷。**

---

## 2026-08-14 · MP16 里程碑（作品库服务端 kind 过滤）

**背景**

MP15 实现无限分页时，类型过滤采用「作用于已加载流 + 可视不足自动续拉填补」的客户端方案——过滤桶只能覆盖已加载的作品子集，稀疏类型（如音频 5 件散布全库）在已加载流中可能 0 命中，用户看到的结果不完整。本里程碑由后端开放 `kind` 查询参数，双端作品库切换过滤桶时整库生效。

**契约要点（已读 apps/api/app/routes/jobs.py 源码确认）**

- `GET /api/jobs?limit&offset&status&kind` → `JobItem[]`；`kind` 逗号分隔多值（如 `txt2img,wan_t2v`），逐值 `strip()` 去空白，空值/纯空白=全部；与 `limit/offset/status` 叠加生效，SQLModel `Job.kind.in_(kinds)`。
- 响应仍无 total；分页 hasMore 启发式（本页返回数===页大小）在过滤后同样适用——kind 过滤与 offset 分页正交。

**改动清单**

- 后端 `apps/api/app/routes/jobs.py`：`list_jobs` 新增 `kind: str = Query(default="")`，非空时 `split(",")` + strip + 滤空 → `stmt.where(Job.kind.in_(kinds))`。
- 后端 `apps/api/tests/test_jobs.py`：新增 `test_jobs_kind_multi_values`（4 断言：多值命中任一 / 带空白 / 空值等价全部 / 纯空白等价全部）。
- `src/api/index.ts`：`listJobs` 增 `kind?: string`（非空才 `encodeURIComponent` 序列化；qs 拼接顺序 limit→offset→status→kind）。
- `src/pages/library/library.vue`：`filterToKind`（过滤桶→`FILTERS.kinds.join(',')`，all→空串）；`refresh`/`loadMore` 均携带 kind；`watch(filter)` 重置游标（offset=0/hasMore=true/loading=true）后重新拉取；MP15 的 maybeFill/needsAutoFill 客户端填补链路退役。

**测试矩阵**

- 后端 pytest `tests/test_jobs.py` 16/16 全绿（含新增 kind 多值用例）。
- vitest 11 套件 232 用例全绿（api-index 39 含 kind 序列化断言）。
- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。

**走查结果（49/49 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C19.4 过滤「音频」服务端整库生效（5 卡无重复，不满页即结尾态）  — 5 卡 footer=没有更多了
PASS  C19.5 稀疏类型跨页命中：第一页仅 2 件音频时点「音频」→ 整库 5 卡（MP16 修复场景）  — 5 卡
PASS  C19.6 切回「全部」分页随 kind 重置 → 第一页 24 卡  — 24 卡
```

既有 46 检查点（C1-C19.3/C19.7 含资产库 C17、avatar-talk C18、R18 C14-C16）全数通过，无回归。C19.4-C19.6 由 MP15 客户端过滤语义重写为服务端过滤语义（走查脚本与 mock-server `/api/jobs` kind 过滤同步落地）。

**踩坑记录**

1. **后端全量 pytest 193 failed / 48 errors 取证**：全量跑 `pytest tests/` 出现大面积失败，逐条核对失败签名均为 `Failed: async def functions are not natively supported`——`pytest_asyncio` 未安装导致 async 用例无法收集，是 test_agent_team_graph/test_assembly 等模块的历史遗留环境问题，与本次 kind 过滤改动无关（本次改动文件 test_jobs.py 16/16 全绿）。**教训：全量回归出现大面积失败时先看失败签名是否同根因，区分历史遗留与本次改动引入。**
2. **小程序构建脚本名核对**：`package.json` 仅注册 `build:h5`/`build:mp-weixin`，mp-alipay/mp-toutiao 需直接 `npx uni build -p <platform>`——沿用 MP13 起的方式，四端构建产物齐全。
3. **mock-server 编辑失步复发（MP12/13 同因）**：Edit 工具回执成功后，curl 验证 kind 过滤仍返回未过滤 50 条——`grep -c MP16` 磁盘文件为 0，确认 IDE 覆盖层与磁盘失步；python 直接落盘 + grep 断言后恢复。教训同前：**工具回执与运行时行为矛盾时立即 shell 交叉验证磁盘真貌**。
4. **后台服务进程随 shell 退出被回收**：`nohup node mock-server.mjs &` 在短命令 shell 中启动后 curl 验证通过，但后续走查 fetch ECONNREFUSED——进程已随 shell 退出。改用 web_server 类型长驻命令启动 mock/h5 双服务后走查稳定。
5. **MP16 编辑引入 library.vue 缩进警告 18 处**：footer 分页反馈区模板缩进错位（vue/html-indent），`eslint --fix` 自动修复后重建 h5 复跑走查 49/49 全绿，确认纯格式修复无逻辑影响。

---

## 2026-08-14 · MP15 里程碑（作品库无限分页）

**背景**

作品库此前一次性 `listJobs({limit:50})` 拉全量，作品增长后首屏变慢且 50 条上限截断。后端 `jobs.py` 的 `list_jobs` 早已支持 `limit/offset` 服务端切片（无 total 字段），本里程碑在 MiniProgram 端接入无限分页：触底续拉 + 下拉重置 + 客户端过滤与服务端分页协同（过滤只作用于已加载流，可视不足自动续拉填补，不阻断滚动加载）。

**契约要点（已读 apps/api/app/routes/jobs.py 源码确认）**

- `GET /api/jobs?limit&offset` → `JobItem[]`（按 created_at 倒序）；`limit` 1-200 默认 50，`offset` ≥0 默认 0，越界返回 `[]`；**响应无 total**——`hasMore` 用「本页返回数 === 页大小」启发式判定。
- 新完成的作业插入流顶部，会造成页间重叠：游标 offset 必须按**服务端原始返回数**推进，与去重后的可见长度解耦（否则游标回退 → 重拉死循环）；追加时按 id 去重。

**改动清单**

- `src/api/index.ts`：`listJobs` 增 `offset?: number`（>0 才序列化进 qs，缺省/0 不拼，既有调用方零影响）。
- `src/utils/pagination.ts`（新，纯逻辑）：`PageCursor{offset,hasMore}` / `INITIAL_CURSOR` / `appendPage`（按 id 去重保留先出现者，不改入参）/ `cursorAfterFirst` / `cursorAfterNext` / `needsAutoFill`（hasMore 且可视数 < 最小可视 → 续拉）。
- `src/utils/library.ts`：`LIBRARY_PAGE_SIZE = 24`（2/3/4 列公倍数，任意断点满页整行填满；在契约 1-200 内）。
- `src/pages/library/library.vue`：分页状态机 `loading`（首屏）/`refreshing`（下拉）/`loadingMore`（触底）/`hasMore`/`error` + `loadMoreError`（底部失败分层，不顶替首屏错误态）；代际令牌 `generation`——refresh 重置后使在途 loadMore 结果作废（防旧页追加污染游标）；`refresh()`（onShow/下拉）重置 offset=0 拉第一页（新完成作业回顶部语义）；`onReachBottom` 触底 `loadMore()`（四态防重入）；过滤 chips 切换不重置已加载数据，`maybeFill()` 在可视不足一屏（列数×4 行）且 hasMore 时自动续拉（链长上限 5，防极端稀疏过滤顺序打满全库）；空态语义分层（filter=all 流空=真无作品；过滤桶空但 hasMore=正在填补，不亮空态）；底部反馈条：spinner /「加载失败，点击重试」/「没有更多了」/「上拉加载更多」（可点按兜底，短内容无法触底时逃生）。
- `scripts/mock-server.mjs`：52 件 done 作品分页数据集（doneJob + 51 件 `makeLibraryJob`：i%9==8→ace_audio 共 5 件 / i%5==4→wan_t2v / 余 txt2img，created_at 逐小时递减；24+24+4 三页）；`/api/jobs` 实现 limit/offset 切片（clamp 对齐后端）；保留 `jobsCalls<=6` 含 runningJob 的轮询演示语义。
- `scripts/ux-walkthrough-h5.mjs`：新增 C19.1-C19.7 检查点（截图 19a-19e）。
- 测试：`tests/pagination.test.ts`（新，12 用例，TDD 先 RED）、`tests/api-index.test.ts`（+2）、`tests/library.test.ts`（+2）。

**测试矩阵（vitest 232 = 216 + 16 新增）**

- pagination 12：INITIAL_CURSOR 初态；appendPage（顺序/按 id 去重保先出现者/空页不改入参）；cursorAfterFirst（满页 hasMore / 不足页 false / 空页 offset=0）；cursorAfterNext（offset 按原始返回数推进与去重解耦 / 越界空页 offset 不变 / 尾页收齐）；needsAutoFill（可视不足+hasMore → 填补 / 够一屏或无更多 → 不补）。
- api-index 39（+2）：listJobs offset=48 序列化 `offset=48`；缺省与显式 0 均不拼 offset（既有调用方兼容）。
- library 12（+2）：LIBRARY_PAGE_SIZE 为 2/3/4 公倍数；落在后端契约 1-200 区间。

**走查结果（49/49 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C19.1 首屏渲染第一页（24 卡）  — 24 卡
PASS  C19.2 触底追加第二页（48 卡且 id 无重复）  — 48 卡 去重后 48
PASS  C19.3 尾页收齐（共 52 卡无重复）+ 结尾态「没有更多了」  — 52 卡 footer=没有更多了
PASS  C19.4 过滤「音频」作用于已加载流（5 卡，不重置数据）  — 5 卡
PASS  C19.5 过滤后可视不足 → 自动续拉填补（音频全量 5 卡无重复，未被过滤阻断）  — 5 卡 footer=没有更多了
PASS  C19.6 切回「全部」已加载 52 卡原样在（过滤不重置数据）  — 52 卡
PASS  C19.7 下拉刷新重置 → 回第一页 24 卡  — onShow 重进（同 refresh 路径）
```

既有 42 检查点（C1-C18 含资产库 C17、avatar-talk C18）全数通过，无回归。

**回归全绿**

- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- `vitest run` 11 套件 232 用例全绿。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。

**踩坑记录**

1. **uni-h5 onReachBottom 在 hash 跳转 ≥3 次后静默丢失（走查环境缺陷，探针取证）**：C19 初版直挂主流程后触底不续拉。探针（/tmp/probe-c19.mjs）沿 `.library` 组件 `__vueParentComponent` parent 链取证：页钩 `onReachBottom` 数组注册在、滚动事件在派发，但 uni-h5 页栈滚动监听不再把事件送进页钩——纯导航次数触发，与访问哪个页面无关（hash 跳转累计 ≥3 次必现）。微信小程序/真机走原生 onReachBottom 无此问题。规避：走查脚本在 C19 起始整页 `reload` 重进作品库（token 在 localStorage 持久，作品库成为入口页=零导航态），触底链路恢复。**教训：uni-h5 页栈钩子可信性随导航次数衰减，H5 走查的滚动类断言前置 reload 归零导航态。**
2. **C19.5 等待 24 卡超时（filter 跨 onShow 持久）**：过滤选择在页面实例上持久（产品语义：切换过滤不重置数据，重进也不复位）。C19.4 停在「音频」后，C19.5 重进作品库时首屏 24 件里音频仅 2 件，`waitForFunction(===24)` 恒超时中断走查。修复：C19.5 导航前先点「全部」复位再重进，首屏 24 卡恢复可数。**教训：走查用例间共享页面实例状态，跨用例断言前先复位交互态。**
3. **9800/9810 端口被旧进程占用 + mock 磁盘失步复发（MP12/13 同因）**：修改 mock-server 分页切片后 curl 仍返回旧数据（2 条、忽略 offset），取证为旧 node 进程未死 + 文件系统覆盖层失步；`lsof` 定位 kill 旧进程、python 落盘 + grep 断言后重启双服务恢复。教训同前：**工具回执与运行时行为矛盾时，立即用 shell 交叉验证磁盘真貌与进程启动时间。**

---

## 2026-08-14 · MP14 里程碑（avatar-talk LongCat-Avatar 数字人引擎接入）

**背景**

主站引擎全景中唯一剩余未接入的引擎 avatar-talk（SFW，音频驱动数字人：人像首帧 + 说话音频 → 口型同步视频）。本里程碑完成接入后，MiniProgram 引擎栅格与主站工作台 100% 对齐，「即将支持」禁用态清零。注册表 audio 参数为 text 占位（Web 端走独立面板），本端按引擎 id 特判渲染为上传字段，与 ltx-nsfw-lipsync 共用「参考图 + 驱动音频互钉同 worker」链路。

**契约要点（已读 apps/api/app/routes/avatar_studio.py 源码确认）**

- `POST /api/avatar/talk` → `GenerateResponse{prompt_id, client_id, worker, seed}`；请求体 `AvatarTalkRequest{image, audio, worker, positive, negative?, width?, height?, num_frames?, fps?, steps?, shift?, cfg?, dmd_lora_strength?, seed?}`。
- `image`/`audio` 为上传句柄文件名（`Field(min_length=1, max_length=512)` + 防路径穿越 validator）；`worker` 防 SSRF，图/音须在同一 worker（上传时互钉，提交层再校验一次）。
- 宽/高非 16 对齐时后端向下取整（同 longcat_studio）；上传到 pool worker（kind=`avatar`），提交时由后端转运到 LongCat 实例 input 目录（LoadAudio 从 input 读音频）。
- 注册表参数：`images`（max 1，label「人像首帧」）+ `audio`（text 占位）+ `negative`/`width`(480)/`height`(832)/`num_frames`(93)/`fps`(25)/`steps`(12)/`seed`；`shift`/`cfg`/`dmd_lora_strength` 注册表未外露，出现即透传、缺省后端补默认。

**改动清单**

- `src/types/api.ts`：`AvatarTalkRequest`（snake_case 原样，与后端 BaseModel 同范围）。
- `src/api/index.ts`：`submitAvatarTalk(params)`（POST /api/avatar/talk，LONG 180s 超时档）。
- `src/utils/build-request.ts`：① `SUPPORTED_ENGINE_IDS` 放行 `avatar-talk`（`isEngineSupported` → true，栅格解除「即将支持」禁用）；② `uploadKindForEngine('avatar-talk') → 'avatar'`；③ `engineNeedsAudio` 追加识别 text 占位 audio 键（`engine.id === 'avatar-talk' && params.some(key==='audio')`）；④ 新增 `engineSheetParams`（抽屉剔除 avatar-talk 的 text 占位 audio 键，其余引擎原样透传）；⑤ `buildAvatarTalkRequest`（positive trim + image/audio 句柄 + **worker 取人像落点** + VIDEO_STRING_KEYS 字符串白名单 + AVATAR_TALK_NUMBER_KEYS 8 数值白名单强转 + seed 透传；values.audio 文本占位不进请求体）。
- `src/pages/index/index.vue`：`refImageLabel` computed（单图字段标签取注册表 images 参数 label「人像首帧」，缺省「参考图」）；`sheetParams` 改走 `engineSheetParams`；模板 `RefImageField :label="refImageLabel"`；提交分支 `case 'avatar-talk'`：缺人像首帧 →「请先上传人像首帧」/ 缺驱动音频 →「请先上传驱动音频」/ 互钉失配 →「人像与音频未落在同一 worker，请移除后重新上传」，三层表单拦截后 `submitAvatarTalk(buildAvatarTalkRequest(...))`。
- 音频组件零改动：MP12 `ref-audio-field.vue` 的 `kind`/`pinWorker` 泛化直接复用（kind=avatar 钉人像 worker，`:key` 绑引擎 id 防串状态）。
- `scripts/mock-server.mjs`：avatar-talk 占位定义替换为注册表全量对齐版（images max1「人像首帧」+ text 占位 audio + 7 个普通参数）+ `POST /api/avatar/talk` 端点。
- `scripts/ux-walkthrough-h5.mjs`：新增 C18.1-C18.6 检查点（每步截图 docs/ux-walkthrough/）。

**测试矩阵（vitest 216 = 204 + 12 新增）**

- build-request 87（+10）：SUPPORTED 白名单放行 avatar-talk、uploadKind → avatar、engineNeedsAudio（text 占位识别 / 同名前缀不误判 / 空参数 false）、engineSheetParams（剔除 audio 占位其余保留 / 非 avatar-talk 原样）、buildAvatarTalkRequest ×4（全字段透传 + worker 取人像落点 / 未外露键出现即透传 / 缺省省略 + values.audio 不进体 / 数值只强转边界交由后端 422）。
- api-index 37（+2）：submitAvatarTalk POST URL/body 序列化/LONG 超时断言；SFW 引擎主站上下文（无 X-NSFW 头）直接放行。

**走查结果（42/42 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C18.1 avatar-talk 人像首帧 + 驱动音频字段渲染  — imgLabel=人像首帧 audio=1
PASS  C18.2 参数抽屉剔除 text 占位 audio 键（其余参数在册）  — params=7 audioText=0
PASS  C18.3 缺人像/音频时生成钮禁用
PASS  C18.4 人像首帧上传就绪（缺音频仍禁用）
PASS  C18.5 驱动音频上传就绪 → 生成钮放行
PASS  C18.6 avatar-talk 提交成功 → 跳作业页  — http://localhost:9810/#/pages/jobs/jobs
```

既有 36 检查点（C1-C17 含 R18 C14-C16）全数通过，无回归。

**回归全绿**

- `vue-tsc --noEmit` 0 错；`eslint --max-warnings=0` 0 警。
- `vitest run` 10 套件 216 用例全绿。
- 四端构建：`build:h5` / `build:mp-weixin` / `uni build -p mp-alipay` / `uni build -p mp-toutiao` 全部成功。

**踩坑记录**

1. **走查环境端口被旧版进程占用**：本轮启动走查前，9800（mock）/9810（h5 serve）仍挂着 MP13 轮次启动的旧进程（PID 27278/22914），新端点 `POST /api/avatar/talk` 返回「mock 未覆盖」、h5 产物为旧构建。curl 探针取证（`/api/avatar/talk` 404 + 进程命令行确认）后 kill 双进程 → 重新 `build:h5` → 重启双服务，走查一次全绿。**教训：走查前置检查清单加一条「探针新端点 + 核对进程启动时间」，不再假设端口占用者就是最新代码。**
2. **注册表 audio 为 text 占位的兼容策略**：avatar-talk 注册表 `audio` 参数 type=text（Web 端独立面板提交后回填句柄），与 MP12 `audio` 媒体类型不同。本端不新增参数类型，按引擎 id 特判：`engineNeedsAudio` 识别该 text 键渲染上传字段，`engineSheetParams` 把它从抽屉剔除（避免同时出现上传字段 + 文本输入双入口），`buildAvatarTalkRequest` 白名单不含 audio 键、文本值不进请求体——三处收口保证 text 占位绝不漏到请求体。
3. **num_frames 与音频时长联动不做**：Web 端按音频时长 × fps 预填 num_frames，但跨端无统一音频元数据探测 API（微信小程序 chooseMessageFile 无 duration，H5 需 new Audio 异步加载），本地预填价值低且引入平台分叉；缺省 93 帧由后端 `pad_with_start` 兜底填充，已注记于 buildAvatarTalkRequest 头注释。

---

## 2026-08-14 · MP13 里程碑（参考资产库接入：管理页 CRUD + 创作页引用）

**背景**

后端参考资产库契约已实现并测试通过（apps/api/app/routes/reference_assets.py，23/23 pytest）。本里程碑在 MiniProgram 端接入：资产管理页全量 CRUD + 创作页参考图字段「从资产库选择」入口——选中资产图直接回填 `{filename, worker}` 句柄**不重新上传**（资产库的核心价值：句柄复用，已带 worker 视为已上传完成态）。

**契约要点（已读 apps/api/app/routes/reference_assets.py 源码确认）**

- `GET /api/assets?kind=character|scene|prop|style`（可选过滤）→ `AssetOut[]`；`POST /api/assets {kind, name(1-100), description(≤2000), images: {filename,worker}[1-4], nsfw}` → `AssetOut`；`GET /api/assets/{id}`（他人/nsfw 在 SFW 上下文 404）；`PATCH /api/assets/{id}` 部分更新（仅非 null 字段生效）；`DELETE /api/assets/{id}` → `{ok, id}`。
- `GET /api/assets/{id}/images/{index}` → 图片字节（worker input 目录代理）；前端 `<image>` src 用 `mediaUrl('/api/assets/${id}/images/${idx}')`，token query 由 mediaUrl 自动拼。
- `AssetOut = { id, kind, name, description, images: {filename, worker}[], nsfw, created_at, updated_at }`。

**改动清单**

- `src/types/api.ts`：`AssetKind`（character/scene/prop/style）、`AssetImage{filename,worker}`、`AssetItem`、`AssetCreateBody`、`AssetPatchBody`。
- `src/api/index.ts`：`listAssets(kind?)` / `createAsset` / `getAsset` / `updateAsset(id, patch)`（PATCH）/ `deleteAsset` / `assetImageUrl(id, index)`（内部走 client mediaUrl），全部走 apiFetch 封装（token / X-NSFW / 人话错误自动注入）。
- `src/api/client.ts`：`@dcloudio/types` 的 method 联合类型不含 PATCH，显式断言解决类型报错。
- `src/utils/assets.ts`（新）：`ASSET_KINDS` / `assetKindLabel` / `filterAssetsByKind` / `assetToDraft`（编辑回显映射）/ `buildAssetPatch`（差量，对齐后端仅非 null 生效）/ `validateAssetDraft`（名称非空 + 图片 1-4 张本地先验）/ `appendAssetImage<T>`（泛型追加上限截停）+ 常量（名称/描述上限、图片上限）。
- `src/pages/assets/index.vue`（新，pages.json 注册标题「参考资产库」）：kind 过滤 chips（全部/角色/场景/道具/风格，一次拉全量本地过滤）+ 卡片网格（首图缩略 assetImageUrl(id,0)/名称/kind 徽标/N 张/nsfw R18 徽标对齐引擎芯片实现）+ 空态文案新建引导 + 下拉刷新；同页 Sheet 弹层新建/编辑（chooseImage + uploadImage，第 2-4 张钉第 1 张 worker 同机——复用 ref-images-field 互钉逻辑；可移除已选图；编辑态回显 + buildAssetPatch 差量 PATCH）；NSFW 开关仅 settings.nsfwIntent 渲染；删除二次确认 → 本地移除 + toast；创建/编辑成功刷新列表。
- `src/pages/profile/profile.vue`：「参考资产库」入口项（folder 图标）。
- `src/components/business/asset-picker-sheet.vue`（新）：kind 过滤 + 资产卡片列表 → 选中展开 1-4 张图网格（缩略图同走 assetImageUrl）→ 点选回填句柄；多图模式达上限截停（`capped` 拦截）。
- `src/components/business/ref-image-field.vue`：「从资产库选择」入口（与上传并列、样式次级；单图替换语义常显、多图达上限隐藏）；选中句柄直接回填/追加，与「上传即钉 worker」兼容。
- `src/utils/build-request.ts`：`validateRefImage` 对 H5 `blob:` 对象 URL 跳过扩展名校验（uni-h5 chooseImage 返回无扩展名 blob URL；MIME 由 input accept 约束 + 后端魔数嗅探 415 兜底），20MB 大小上限仍生效。
- `scripts/mock-server.mjs`：资产内存 CRUD（`GET/POST /api/assets`、`GET/PATCH/DELETE /api/assets/{id}`、`GET /api/assets/{id}/images/{index}` 返回 1x1 png）、`/__reset` 清空资产态、CORS 放行 PATCH。
- `scripts/ux-walkthrough-h5.mjs`：新增 C17.1-C17.9 检查点（每步截图 docs/ux-walkthrough/）。
- `scripts/gen-icons.mjs`：白名单 +folder/pencil 等，重跑生成 icons.generated.ts。
- 测试：`tests/api-assets.test.ts`（新，10 用例）、`tests/assets.test.ts`（新，18 用例）、`tests/build-request.test.ts`（+2 blob 用例）。

**测试矩阵（vitest 204 = 174 + 30 新增）**

- api-assets 10：listAssets（全量/kind qs 过滤）、createAsset（body 序列化）、getAsset/updateAsset（PATCH 差量）/deleteAsset（URL+method）、assetImageUrl（mediaUrl token 拼参）、错误透传（401/404 人话）。
- assets 18：filterAssetsByKind（all/单类/空）、assetKindLabel 四映射、assetToDraft 回显、buildAssetPatch（差量/未变剔除/全字段）、validateAssetDraft（名称空/超 100/描述超 2000/图片 0 张/超 4 张）、appendAssetImage（追加/上限截停/泛型保持）。
- build-request 77（+2）：H5 blob: URL 跳过扩展名校验放行、blob: URL 仍守 20MB 上限。

**走查结果（36/36 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C17.1 我的页入口 → 资产库页  — http://localhost:9810/#/pages/assets/index
PASS  C17.2 空态文案 + 新建引导渲染
PASS  C17.3 创建角色资产（mock 上传）→ 卡片渲染  — 胶片主角卡 | 角色1 张
PASS  C17.4 创作页打开资产选择器（列表含新建资产）  — 胶片主角卡角色 · 1 张
PASS  C17.5 点选资产图回填 → 多图计数 1/4
PASS  C17.6 回填预览走资产图代理（句柄复用，未重新上传）  — preview=1 proxy=true
PASS  C17.7 编辑弹层回显（名称 + 图片句柄原样保留）  — name=胶片主角卡 images=1
PASS  C17.8 改名保存（PATCH 差量）→ 列表名称更新  — 主角三视图
PASS  C17.9 二次确认删除 → 列表回空态
PASS  C1-C16 既有 27 点全绿（登录/引擎/提交/作业/详情/作品库/深浅切换/R18 上下文）
```

**踩坑记录**

- **资产页 footer z-index 压过弹层（走查取证修复）**：`assets__footer` 复制 tab-bar 的 `z-index:100`，高于 `ui-sheet` 的 90——H5 端弹层打开后底栏「新建资产」按钮浮在遮罩之上，拦截「创建」按钮点击（Playwright 报 `.assets__footer` 子树 `ui-btn--pressed` 拦截 pointer events，57 次重试超时）。修复：footer 降 `z-index:50` 并注释层叠约定（遮罩 90 必须盖住页面级 fixed 栏）。C17.3 复测通过。
- **C17.2 空态断言时序**：导航后立即 `locator.count()` 断言空态，但列表 `onShow → load` 异步未完成，loading 窗口期误判 false。改 `waitForSelector('text=还没有参考资产')` 等待后再断言。
- **`mock-server.mjs` IDE 覆盖层与磁盘失步复发（MP12 同因）**：资产路由编辑工具回执成功、Read 回读见新内容，但磁盘实为旧版（`wc -l` 461 vs Read 516，mtime 不变），运行进程返回「mock 未覆盖」。按 MP12 教训改走 shell（python 精确替换 4 处 + `node --check` + grep/md5 落盘断言）根治，重启进程后 curl 全端点实测通过。教训再次验证：**工具回执与运行时行为矛盾时，立即用 shell 交叉验证磁盘真貌**。
- `@dcloudio/types` 的 uni.request method 联合类型不含 PATCH：client.ts 内 method 显式断言（运行时 uni.request 原生支持 PATCH，仅类型定义滞后）。
- H5 `uni.chooseImage` 返回 `blob:` 对象 URL（无扩展名）——`validateRefImage` 扩展名先验对 blob: 跳过（MIME 由 `accept="image/*"` 约束 + 后端魔数嗅探兜底），大小上限保留；与 MP12 音频「按原始文件名先验」并列为 H5 文件选择两大形态差异。

**回归输出（截取）**

```
$ npm run typecheck && npm run lint && npm run test
vue-tsc 0 错误 / eslint 0 错误 0 警告
 Test Files  10 passed (10)   Tests  204 passed (204)

$ npm run build:h5 && npm run build:mp-weixin && npx uni build -p mp-alipay && npx uni build -p mp-toutiao
DONE  Build complete.（四平台成功）
```

**遗留**：MP9 微信真机走查（导入 dist/build/mp-weixin）仍待用户执行——除既有核对项（渲染差异/相册下载/会话文件权限/R18 引擎可见性随开关切换）外，新增核对资产库页 CRUD 与资产选择器在小程序端的弹层层叠、chooseImage 临时路径扩展名先验链路。

---

## 2026-08-14 · MP12 里程碑（R18 视频引擎接入：ltx-nsfw-t2v / ltx-nsfw-i2v / ltx-nsfw-lipsync / h3-nsfw-t2v / h3-nsfw-i2v）

**背景**

MP10/MP11 完成全部 14 个 SFW 引擎接入后，仅余 5 个 R18 引擎与 avatar-talk 禁用。本里程碑接入 5 个 R18 引擎，`SUPPORTED_ENGINE_IDS` 扩至 19，与主站工作台引擎全景 100% 对齐（avatar-talk 主工作台也未接入，保持禁用）。R18 可见性由后端 `list_engines` 按 X-NSFW 头过滤（`nsfw_allowed` 上下文）；客户端 settings.nsfw 开关 MP5.4 已就绪、api client 自动注入 `X-NSFW: 1`——前端无额外门控，只支持参数形态与提交路由。

**契约要点（已读 apps/api 源码确认：services/engine_registry.py / routes/video.py / routes/h3_studio.py）**

- 提交端点：`POST /api/generate/ltx-t2v|ltx-i2v|ltx-lipsync` → `GenerateResponse {prompt_id, client_id, worker, seed}`，LONG 180s；h3-nsfw-t2v/i2v 与 SFW 同一 `POST /api/h3/t2v|i2v` 链路（专区内自带 X-NSFW 头，后端打标进 R18 库、R18 LoRA 门控放行）。
- 预设换算（注册表 select → 请求数值）：resolution 字符串 `WxH` 解析为 width/height；ltx 时长 secs×fps→round→≥9→吸附 8k+1 网格→钳 241 上限；h3 时长静态映射 6/10/15s→141/243/362（固定 24fps，17k+5 网格）。
- 上传：ltx-nsfw-i2v→`ltx_i2v`；ltx-nsfw-lipsync 图/音同 kind `ltx_lipsync` 互钉同 worker（口型同步图/音必须同机）；h3-nsfw-i2v→`h3_i2v`；音频扩展名 wav/mp3/m4a/ogg/flac、≤20MB，multipart 字段名同为 `image`。
- lipsync 专属参数：`id_lora`（text，trim 后空串省略）/ `id_lora_strength`（0-2，默认 0.8）。

**改动清单**

- `src/types/api.ts`：`EngineParamType` 增加 `'audio'`；`UploadedRefAudio{filename,worker,name}`；`LtxNsfwT2V/I2V/LipsyncRequest`（snake_case 原样）。
- `src/api/index.ts`：`submitLtxNsfwT2V/I2V/Lipsync`（/api/generate/ltx-*，LONG 档）；`uploadAudio(filePath, kind, pinWorker?)`。
- `src/utils/build-request.ts`：`SUPPORTED_ENGINE_IDS` 扩至 19；`engineNeedsAudio`；uploadKind 三映射；`parseResolution` / `ltxNsfwLength` / `H3_NSFW_DURATION_FRAMES`；5 个 builder（白名单透传 + 预设换算 + 互钉句柄 + id_lora trim 省略）；`validateRefAudio`；`defaultParamValues` 跳过 audio。
- `src/components/business/ref-audio-field.vue`（新）：选文件（条件编译：MP-WEIXIN chooseMessageFile / 其他平台 chooseFile）→ 按原始文件名先验 → 钉参考图 worker 上传 → 预览/移除；图标复用白名单（music/loader-circle/x/circle-alert），未新增 SVG。
- `src/components/business/param-sheet.vue`：audio 与 images/video 同列「创作页直渲」，不落入「不支持」提示。
- `src/pages/index/index.vue`：引擎卡片 R18 徽标（`item.nsfw`）；提交路由新增 5 分支（lipsync 缺图/缺音分层拦截）；`needsAudio` watch 清态；单图变更互钉失配自动清音频。
- `scripts/mock-server.mjs`：5 个 R18 引擎定义（参数逐字段对齐注册表 `_ltx_nsfw_video_params`/`_h3_nsfw_video_params`）；`/api/models/engines` 按 `X-NSFW === '1'` 过滤（SFW 12 / R18 17，curl 双侧实测）；3 个 R18 LTX 提交端点；`/api/upload` 从 multipart 头回显真实文件名（lipsync 图/音句柄区分）。
- `scripts/ux-walkthrough-h5.mjs`：新增 C8.2 / C14.1-3 / C15.1-2 / C16.1；R18 用第二浏览器上下文注入 `toiv.settings.nsfwIntent:true`。

**测试矩阵（vitest 174 = 142 + 32 新增）**

- build-request 75（+26）：engineNeedsAudio、validateRefAudio（扩展名大小写不敏感 / 20MB 边界）、parseResolution、ltxNsfwLength（6s@16fps→89 / 10s@24fps→233 / 超长钳 241）、H3 帧映射、5 个 builder（预设换算 / 白名单透传 / 互钉句柄 / id_lora trim 空省略）、白名单 19 在册。
- api-index 35（+6）：3 个 R18 submit 的 URL/body/LONG 超时契约；uploadAudio 的 kind/worker query 与字段名 image。

**走查结果（27/27 全绿，mock :9800 + h5 静态 :9810，本轮实测）**

```
PASS  C8.2 SFW 上下文无 R18 引擎（X-NSFW 过滤生效）— 0 枚徽标
PASS  C14.1 R18 上下文引擎列表含 5 枚 R18 徽标
PASS  C14.2 ltx-nsfw-t2v 参数区渲染（无参考媒体字段）
PASS  C14.3 ltx-nsfw-t2v 提交成功 → 跳作业页
PASS  C15.1 ltx-nsfw-lipsync 参考图 + 驱动音频字段渲染 — image=1 audio=1
PASS  C15.2 缺参考图/音频时生成钮禁用
PASS  C16.1 h3-nsfw-t2v 提交成功（复用 /api/h3/t2v）→ 跳作业页
PASS  C1-C13 既有 20 点全绿（含 C8.1 avatar-talk 保持禁用态）
```

**踩坑记录**

- **`scripts/mock-server.mjs` IDE 覆盖层与磁盘失步（重大）**：该文件在 IDE 中残留旧会话编辑缓冲，Edit 工具写入被旧缓冲回盖——工具回执显示成功、Read 回读也见新内容，但磁盘实为旧版（mtime 保留旧时刻），sed/grep/curl 三通道各见不同版本。探针实验定位：shell 追加标记行可持久、Edit 写入不落盘 → 该文件改走 shell（python 精确替换 + 落盘回读断言）后根治；同目录 ux-walkthrough-h5.mjs 不受影响。本轮两轮「消失的修改」（上午的 R18 端点/上传回显、下午的 R18 引擎定义）同因。教训：**凡工具回执与运行时行为矛盾，立即用 shell md5/grep 交叉验证磁盘真貌**。
- H5 `uni.chooseFile` 返回 blob: URL（无扩展名），wx 临时路径也不保证带扩展名——音频扩展名先验必须按**原始文件名**（选择器回包的 name），不能按临时路径，否则 H5 端全部误杀。
- R18 走查上下文：localStorage 注入 `toiv.settings.nsfwIntent:true` → settings store restore 桥接 `setNsfwIntent(true)` → client 自动带 `X-NSFW: 1`，与真机链路一致；浏览器上下文 storage 独立，需重新登录拿 token。

**回归输出（截取）**

```
$ npm run typecheck && npm run lint && npm run test
vue-tsc 0 错误 / eslint 0 错误 0 警告
 Test Files  8 passed (8)   Tests  174 passed (174)

$ npm run build:h5 && npm run build:mp-weixin
DONE  Build complete.（双平台成功）
```

**遗留**：H5 的 uni.chooseImage/chooseVideo/chooseFile 在 Playwright 下无法触发系统文件选择器（同 MP10/MP11 结论，由 vitest 契约用例覆盖）；MP9 微信真机走查（导入 dist/build/mp-weixin，核对渲染差异与相册/下载/会话文件选择权限链路，重点核 R18 引擎可见性随 NSFW 开关切换、chooseMessageFile 音频选取）仍待用户执行。

---

## 2026-08-14 · MP11 里程碑（剩余 SFW 引擎接入：h3-t2v / h3-i2v / longcat-t2v / longcat-i2v / longcat-continue / ace-music + 两个现役缺陷修复）

**背景**

MP10 后创作页已按引擎 id 显式路由，但 `SUPPORTED_ENGINE_IDS` 仅 8 个，后端已上线的 h3/longcat/ace 六引擎在栅格中灰化「即将支持」。本里程碑把这 6 个 SFW 引擎全量接入（类型 → API → builder → UI → 走查），使白名单扩至 14，仅余 avatar-talk（数字人，Web 端走独立 AvatarGenPanel）与 R18 引擎（ltx-nsfw-*/h3-nsfw-*）保持禁用。走查过程中顺带取证并修复了两个现役缺陷：① 参数抽屉 H5 端滚动失效；② paramValues `const reactive` 直接 `v-model` 导致抽屉所有参数编辑静默丢失（MP3 起潜伏）。

**契约要点（已读 apps/api 源码确认）**

- 提交端点：`POST /api/h3/t2v|i2v`、`POST /api/longcat/t2v|i2v|continue`、`POST /api/generate/audio` → `GenerateResponse {prompt_id, client_id, worker, seed}`；统一 LONG 180s 超时档。
- 上传：h3-i2v→`h3_i2v`；capabilities.py 无 longcat 专用 kind，longcat-i2v→`ltx_i2v`（对齐 Web GenerateView fallback）。
- LoRA（H3 专属）：`loras: [{name, strength}]` 数组；strength 缺省/非有限数 → 0.6，越界钳 0.5-1.0；UI 层多选上限 3。
- H3 的 fps/cfg 在模板内锁定，**不传**；longcat 蒸馏链路无 cfg/sampler，**不传**。
- longcat-continue：`video` 为源视频产物 URL（`/api/images?path=...`），取自参数面板文本输入而非上传；width/height/fps 空值**显式省略** = 后端向源视频实测对齐。
- ace-music：请求键为 `tags`（由 positive 映射）/ `lyrics` / `seconds` / `steps` / `cfg` / `seed`；lyrics 空串省略（后端默认纯音乐）。

**改动清单**

- `src/types/api.ts`：新增 `LoraValue{name,strength}`、`H3T2V/H3I2VRequest`（loras 数组）、`LongCatT2V/I2V/ContinueRequest`（snake_case 原样）、`AceMusicRequest`；`EngineParamType` 增加 `'loras'`，`EngineParam.options?` 增 nsfw 标记位。
- `src/api/index.ts`：`submitH3T2V/H3I2V`（/api/h3/*）、`submitLongCatT2V/I2V/Continue`（/api/longcat/*）、`submitAceMusic`（/api/generate/audio），GenerateResponse 形状，LONG 档。
- `src/utils/build-request.ts`：`SUPPORTED_ENGINE_IDS` 扩至 14；uploadKind 增 h3-i2v→h3_i2v、longcat-i2v→ltx_i2v；`parseLoraValues`（默认 0.6 / 钳 0.5-1.0 / 非数组与缺 name 项兜底剔除）；6 个 builder 白名单键透传（continue 空 width/height/fps 显式省略；ace-music positive→tags）。
- `src/components/business/loras-field.vue`（新）：LoRA 多选 ≤3 + 单项强度滑杆（min/max/step 取注册表）+ R18 角标 + 达上限未选项截停灰化 + options 空显式提示；图标复用白名单（check），未新增 SVG。
- `src/components/business/param-sheet.vue`：支持 `loras` 类型渲染。
- `src/pages/index/index.vue`：提交路由新增 6 分支；h3-i2v/longcat-i2v 缺参考图、longcat-continue 缺源视频 URL 均表单层拦截（人话文案）。
- **缺陷修复①**：`src/components/ui/sheet.vue` H5 滚动失效——panel 靠 max-height 钳制时 uni scroll-view 内层两层 div 的 `height:100%` 百分比参照链 indefinite 断裂，内层被内容撑高不可滚动；`.ui-sheet__body` 改全 flex 链（`flex:1; min-height:0` + `:deep` 贯穿两层 uni-scroll-view），小程序原生组件无此 DOM 无副作用。
- **缺陷修复②**：`index.vue` 的 `paramValues` 为 `const reactive` 却直接 `v-model`——Vue 编译为对 const 的重新赋值，运行时被错误吞掉，抽屉参数编辑静默丢失；改显式 `:model-value` + `@update:model-value`（清空后合并，保 reactive 引用）。
- `scripts/mock-server.mjs`：补 6 引擎定义（h3-t2v loras 4 选项含 R18 样例 / longcat-continue video 文本参数 / ace-music kind=audio）+ 6 个提交端点。
- `scripts/ux-walkthrough-h5.mjs`：新增 C11（h3-t2v LoRA 渲染 4 行 / 选中出滑杆+计数 1/3 / 提交跳作业页）、C12（longcat-continue 空源视频拦截 / 填 URL 提交成功）、C13（ace-music 无参考媒体字段 / 提交成功）。

**测试矩阵（vitest 142 = 121 + 21 新增）**

- build-request 49（+15）：parseLoraValues 5（非数组/逐项透传/缺省 0.6/越界钳/缺 name 剔除）、H3 t2v 2 + i2v 1（loras 归一/fps·cfg 不传）、longcat t2v 1 + i2v 1 + continue 3（空值省略/脏值兜底）、ace 2（tags 映射/lyrics 空串省略）、白名单 14 在册 + avatar-talk/R18 禁用。
- api-index 29（+6）：6 个 submit 的 URL/body/LONG 超时契约。

**走查结果（20/20 全绿，mock :9800 + h5 静态 :9810，本轮实测复核）**

```
PASS  C11.1 h3-t2v 参数抽屉 LoRA 选项渲染 — 4 行
PASS  C11.2 选中 LoRA → 强度滑杆 + 计数 1/3
PASS  C11.3 h3-t2v 提交成功 → 跳作业页
PASS  C12.1 longcat-continue 空源视频拦截提示 — 请先在参数面板填写源视频产物 URL
PASS  C12.2 longcat-continue 填源视频后提交成功 → 跳作业页
PASS  C13.1 ace-music 参数区渲染（无参考媒体字段）
PASS  C13.2 ace-music 提交成功 → 跳作业页
PASS  C1-C10、C3-C7 既有 13 点全绿（含 C8.1 avatar-talk 保持禁用态）
```

**踩坑记录**

- JSDoc 注释内出现 `/*` 会把块注释提前截断引发语法错误——build-request.ts 头部注释中的通配写法改用「系」字规避。
- mock 服务旧进程不重启会一直发旧版引擎列表（新端点 404 / 新引擎缺失）：走查前 `lsof -nP -i :9800` 确认占用者并换新进程。
- H5 端底部 tab-bar 会 hit-test 拦截靠近屏底的引擎项点击：先 `scrollIntoView({block:'center'})` 再 `dispatchEvent('click')`（uni-h5 @tap 编译为 DOM click 监听，不校验 isTrusted）；抽屉遮罩层点击关闭在 Playwright 下不稳定，走查一律点头部关闭钮。
- 缺陷②取证要点：`v-model` 用在 `const reactive` 对象上**编译期不报错、运行期静默丢更新**（赋值被错误吞掉），是 MP3 抽屉落地即潜伏的隐性 bug；reactive 对象做 v-model 必须拆 `:model-value` + `@update:model-value` 手动合并。

**回归输出（截取）**

```
$ npm run typecheck && npm run lint && npm run test
vue-tsc 0 错误 / eslint 0 错误 0 警告
 Test Files  8 passed (8)   Tests  142 passed (142)

$ npm run build:h5 && npm run build:mp-weixin
DONE  Build complete.（双平台成功）
```

**遗留**：H5 的 uni.chooseImage/chooseVideo 在 Playwright 下无法触发系统文件选择器（同 MP10 结论，由 vitest 契约用例覆盖）；MP9 微信真机走查（导入 dist/build/mp-weixin 核对渲染差异与相册/下载权限链路）仍待用户执行。

---

## 2026-08-14 · MP10 里程碑（SFW 视频引擎接入：ltx25-t2v / ltx25-i2v / wan-animate / wan-vace）

**背景（修复的现役缺陷）**

创作页此前只按 `engineNeedsRefImage` 二分 txt2img/img2img——选中后端已上线的 4 个 SFW 视频引擎会**错误地提交 txt2img**。本里程碑按引擎 id 显式路由，并用 `SUPPORTED_ENGINE_IDS` 白名单把未接入引擎（h3-*/longcat-*/ace-music/ltx-nsfw-*/h3-nsfw-* 等）降为禁用态（灰化 +「即将支持」），杜绝错误路由。

**契约要点（已读 apps/api 源码确认）**

- 提交端点：`POST /api/ltx25/t2v|i2v`、`POST /api/wan/animate|vace` → `GenerateResponse {prompt_id, client_id, worker, seed}`；422 为 FastAPI detail 数组，文案取 `detail[0].msg`（对齐 Web `_postLtx25/_postWan`）。
- 上传：`POST /api/upload?kind=<kind>[&worker=<pin>]`，multipart **字段名固定 `image`**（视频同）；uploadKind 映射 ltx25-i2v→`ltx_i2v` / wan-animate→`wan_animate` / wan-vace→`wan_vace` / img2img→`img2img`。
- 互钉：wan-animate 先传参考图（不钉），驱动视频带 `worker=<图落点>`；wan-vace 第 1 张不钉，第 2-4 张钉第 1 张；ltx25-i2v 单图不钉。提交时 wan-animate/vace 的 `worker` 均取第一张参考图落点。
- 参数边界：ltx25 width 960(256-1920,step32)/height 544/length 121(8k+1)/fps 24/steps 8；wan width 832(320-1280,step16)/height 480/num_frames 121(animate,4k+1)·81(vace)/steps 6·20/fps 16。wan 的 cfg/shift/relight_lora、vace 的 start_image/end_image 后端默认/未暴露，**不传**。

**改动清单**

- `src/types/api.ts`：`EngineParamType` 增加 `'video'`；`EngineInfo.source?`（M9 透传）；新增 `Ltx25T2VRequest/Ltx25I2VRequest/WanAnimateRequest/WanVaceRequest`（snake_case 原样）与 `UploadedRefVideo`。
- `src/api/client.ts`：错误 detail 提取兼容 FastAPI 422 数组（展开首条 msg），字符串 detail 行为不变。
- `src/api/index.ts`：`submitLtx25T2V/I2V`、`submitWanAnimate/Vace`（统一 LONG 180s 超时档）；`uploadVideo(filePath, kind, pinWorker?)`；`uploadImage` 加可选 `pinWorker`（不破坏既有调用）。
- `src/utils/build-request.ts`：`SUPPORTED_ENGINE_IDS`/`isEngineSupported`、`engineNeedsVideo`、`engineImagesMax`/`engineNeedsMultiImage`、`uploadKindForEngine`；`buildLtx25T2V/I2V/WanAnimate/WanVaceRequest` 白名单键透传；`validateRefVideo`（mp4/webm/mov 扩展名先验 + ≤200MB）；`defaultParamValues` 跳过 video 类型。txt2img/img2img 既有行为不变。
- `src/pages/index/index.vue`：引擎栅格禁用态（`!available || !isEngineSupported` → 灰化 +「即将支持」，自动选择只在可选集合内）；提交按引擎 id switch 路由；校验文案「请先上传参考图」/「请先上传驱动视频」；参考图/驱动视频字段按引擎渲染，`:key` 绑引擎 id 重建防串状态；wan-animate 参考图变更后驱动视频互钉失配自动清除重传。
- `src/components/business/ref-image-field.vue`：`kind`/`max` props；max>1 多图模式（计数、逐张移除、第 2 张起钉第 1 张 worker）；单图模式行为不变。
- `src/components/business/ref-video-field.vue`（新）：chooseVideo → validateRefVideo → uploadVideo（钉 worker）→ 预览卡片（film 图标/名称/时长）→ 可移除；上传中/失败态。图标全部复用白名单（film/loader-circle/x/circle-alert），未新增 SVG。
- `src/components/business/param-sheet.vue`：video 类型与 images 同列「创作页直渲」，不再落入「不支持」提示。
- `scripts/mock-server.mjs`：6 引擎（txt2img + 4 视频 + h3-t2v 未接入样例），新增 4 个视频提交端点与 `/api/upload`（worker 互钉透传回显）；jobs 轮询演示阈值 2→6（走查新增一次作业页访问）。
- `scripts/ux-walkthrough-h5.mjs`：新增 C8（未接入引擎禁用态）/ C9（ltx25-t2v 无参考媒体字段 + 提交成功跳作业页）/ C10（wan-vace 多图字段渲染计数 0/4）。

**测试矩阵（vitest 121 = 91 + 30 新增）**

- build-request 34（+21）：SUPPORTED 白名单判定、needsVideo/imagesMax/needsMultiImage、uploadKind 映射、defaultParamValues 跳过 video、4 个 builder 白名单透传/脏字段剔除/不传后端默认键、validateRefVideo 扩展名/大小写/200MB 边界。
- api-index 23（+9）：4 个 submit 的 URL/body/LONG 超时、422 detail 数组展开首条 msg、非数组 detail 字符串直取、uploadImage/uploadVideo 的 kind/worker query 与字段名 image。

**走查结果（13/13 全绿，mock :9800 + h5 静态 :9810）**

```
PASS  C1 登录 → 创作页 / C2.1 引擎列表加载
PASS  C8.1 未接入引擎禁用态（灰化 + 即将支持）
PASS  C9.1 ltx25-t2v 无参考媒体字段 / C9.2 提交成功 → 作业页
PASS  C10.1 wan-vace 多参考图字段（计数 0/4）
PASS  C3.1-C7.1 既有 7 点（作业/详情/作品库/主题）全绿
```

**踩坑记录**

- 走查环境 9800/9810 端口被上次 MP8 遗留进程占用（EADDRINUSE）：`lsof -nP -i :<port>` 定位后 `kill -9` 再起，旧版 mock 不重启会导致新端点 404。
- `uni.chooseVideo` 的 `size` 单位随平台（字节/KB）不稳定，仅作客户端先验参考，200MB 硬上限由后端 413 兜底。
- 视频字段放创作页主视野（与 images 同理）而非参数抽屉：驱动视频是必填主输入，且互钉依赖参考图 worker，放抽屉要穿透两层状态——抽屉只渲染标量参数。

**回归输出（截取）**

```
$ npm run typecheck && npm run lint && npm run test
vue-tsc 0 错误 / eslint 0 错误 0 警告
 Test Files  8 passed (8)   Tests  121 passed (121)

$ npm run build:h5 && npm run build:mp-weixin
DONE  Build complete.（双平台成功）
```

**遗留**：H5 的 uni.chooseImage/chooseVideo 在 Playwright 下无法触发系统文件选择器，上传→提交全链路（互钉 query 实测）由 vitest 契约用例覆盖，真机/浏览器手工点验留待 MP9 真机走查一并执行。

---

## 2026-08-14 · MP8 里程碑（H5 自动化 UX 走查 + 组件事件契约根治）

**走查设施（可重复执行）**

- `scripts/mock-server.mjs`：零依赖 Mock API（:9800），端点逐条对齐 `src/api/index.ts` 契约（login/me/engines/txt2img/jobs 轮询演示/versions/delete/outputs 1px PNG），`/__reset` 归零轮询计数防跨运行污染。
- `scripts/ux-walkthrough-h5.mjs`：Playwright（全局安装，createRequire 引入）+ `addInitScript` 预注 `toiv.settings`（apiBaseOverride 指向 mock）；iPhone 14 视口；9 检查点 + `docs/ux-walkthrough/*.png` 截图；非零退出 = 有失败点。

**根治的缺陷：组件 tap 事件契约（H5 点击作业卡无响应根因）**

- **现象**：H5 端点击作业卡片无任何反应（mouse.click / touchscreen.tap / DOM dispatchEvent 三通道均无导航、无报错）。
- **取证**：编译产物 `pages-jobs-jobs.*.js` 中 `onRemove`/`onRetry` 俱在而 `onTap` 为 0；浏览器运行时组件实例链取证——`job-card` vnode.props = `[key, job, retrying, onClick, onRemove, onRetry]`。
- **根因**：uni-app 编译器将模板 `@tap` **统一映射为 `onClick` prop**；子组件声明 `emits: ['tap']` 并 `emit('tap')`，父级给的却是 `onClick`——事件名错配，父级处理器永远不会被调用。此前 Button 在登录页"能用"纯属 onClick 属性透传到根 uni-view 的巧合。
- **修复**：组件对外事件契约一律 `click`——[button.vue](src/components/ui/button.vue) / [job-card.vue](src/components/business/job-card.vue) 改 `emit('click')`；三处父级 [login.vue](src/pages/login/login.vue) / [index.vue](src/pages/index/index.vue) / [jobs.vue](src/pages/jobs/jobs.vue) 改 `@click`。原生 view 上的 `@tap` 不受影响（双端均正常），保留。
- **微信端契约核对**：`jobs.wxml` 编译为 `<job-card bindclick bindremove bindretry>`，组件 js `emits:["click","remove","retry"]`——`bindclick` + `triggerEvent('click')` 一致 ✓。

**走查结果（9/9 全绿）**

```
PASS  C1 登录提交 → 跳转创作页
PASS  C2.1 引擎列表加载（mock /models/engines）
PASS  C3.1 作业列表渲染 — 2 张卡片
PASS  C4.1 点击作业卡片 → 跳转详情页 — /#/pages-sub/artifact/artifact?id=job-done-1
PASS  C5.1 详情页 eventChannel 数据到达
PASS  C5.2 详情页预览区渲染 — 1 个媒体位
PASS  C5.3 详情页操作钮（复用/重新生成/下载/删除）— 3 个
PASS  C6.1 作品库过滤芯片渲染 — 2 个芯片
PASS  C7.1 深浅模式切换生效 — #FAF9F7 → #141312
```

**踩坑记录**

- uni-h5 首页路由规范化为 `#/`（非 `#/pages/index/index`），登录跳转断言需以页面内容判定。
- uni-h5 的 `<image>`/`<input>` 渲染为 `uni-image`/`uni-input` 外壳包裹，class 落外壳、原生控件在内层，选择器用 `.field__input input` / class 而非标签名。
- 主题变量经 `:style="themeVars"` 挂页面根容器，`document.body` 背景恒透明——深浅模式断言读根容器 `--color-bg`。
- 本机 5173/5174 已被 Mobile dev server 与 PulseHub 占用，H5 走查静态服务用 9810（python3 http.server）。

**回归输出（截取）**

```
$ npm run typecheck && npm run lint && npm run test
vue-tsc 0 错误 / eslint 0 错误 0 警告
 Test Files  8 passed (8)   Tests  91 passed (91)

$ npm run build:h5 && npm run build:mp-weixin
DONE  Build complete.（双平台成功）
```

**跨平台构建验证（MP8.4）**

```
$ npx uni build -p mp-alipay && npx uni build -p mp-toutiao
DONE  Build complete. ×2

# 事件契约核对（与微信端一致）
alipay : <job-card onClick="{{i}}" onRemove="{{j}}" onRetry="{{k}}">
toutiao: <job-card bindclick="{{i}}" bindremove="{{j}}" bindretry="{{k}}">
# tab-bar 四件套 / 5 主页 + pages-sub/artifact 子包：双端产物齐全
```

四平台（h5 / mp-weixin / mp-alipay / mp-toutiao）构建与组件事件契约全部一致收口。

**遗留**：微信开发者工具导入 `dist/build/mp-weixin` 的真机人工走查（MP9）仍待用户执行；H5 走查已覆盖同等流程，真机重点核对渲染差异与下载/相册权限链路。

---

## 2026-08-14 · MP7 里程碑（UX/一致性审计 + 跨平台收口）

**审计发现的致命缺陷（已修复）**

1. **底栏全平台不可用**：`src/custom-tab-bar/`（微信私有机制）被 uni-app 编译为**原始 .vue 文件拷贝**进 dist（`ls dist/build/mp-weixin/custom-tab-bar/` 仅 index.vue），微信端底栏根本不渲染；H5/支付宝/抖音等平台无 custom-tab-bar 机制，底栏完全缺失。静态构建验证未暴露，属「构建成功但功能缺失」陷阱。
   - **修复**：弃用原生 tabBar，改为共享组件 [tab-bar.vue](src/components/business/tab-bar.vue)（fixed 悬浮条 + 同高占位块，页面零额外样式）；四个 tab 页内嵌 `<TabBar :selected="N" />`；pages.json 移除整个 tabBar 块；全局 `uni.switchTab` → `uni.reLaunch`（6 处：tab-bar 组件 1 + artifact 2 + index 1 + jobs 1 + goCreate 1）。
2. **switch 强调色硬编码 `#B4532A`**（param-sheet.vue / profile.vue 各 1 处）：换肤到其他色板或深色模式时开关仍是 palette-01 浅色 accent，破坏「换肤零组件改动」Token 承诺。
   - **修复**：`:color="palette.accent"`（`useAppTheme` 已暴露 palette computed）。

**审计通过的项**

- `#FFFFFF` 媒体浮层白（视频 play 角标、多产物角标、CTA 文字 on-accent）：与 Mobile `library-screen.tsx:129` 内联白约定一致，主题无关，保留。
- 裸 rpx（16 文件 100 处）：均为组件专属尺寸（头像圆 112rpx、发丝边框 1rpx、色板格 40rpx），非间距刻度违规。
- 12 处导航调用与 pages.json 路由逐一核对：5 主包页 + `pages-sub/artifact` 子包全部命中。
- 死样式 `__bottom-gap` ×3（jobs/library/profile）随 TabBar 占位块接管而清除。

**回归输出（截取）**

```
$ npm run typecheck && npm run lint && npm run test
vue-tsc 0 错误 / eslint 0 错误 0 警告
 Test Files  8 passed (8)   Tests  91 passed (91)

$ npm run build:mp-weixin && ls dist/build/mp-weixin/
DONE  Build complete.   （无 custom-tab-bar 目录；app.json 无 tabBar 键；
                          components/business/tab-bar.{js,json,wxml,wxss} 四件套正常）

$ npm run build:h5
DONE  Build complete.
```

**遗留**：真机 UX 走查（用户流程/交互便捷性/响应速度）需微信开发者工具导入 `dist/build/mp-weixin` 人工验证，待用户执行。

---

## 2026-08-14 · MP6 里程碑回归（全量收口）

**命令输出（截取）**

```
$ npm run typecheck        # vue-tsc --noEmit
（无输出，0 错误）

$ npm run lint             # eslint . --ext .ts,.vue --max-warnings=0
（无输出，0 错误 0 警告）

$ npm run test             # vitest run
 ✓ tests/build-request.test.ts (13 tests)
 ✓ tests/library.test.ts (10 tests)
 ✓ tests/format.test.ts (12 tests)
 ✓ tests/poll.test.ts (5 tests)
 ✓ tests/tokens-icons.test.ts (7 tests)
 ✓ tests/api-index.test.ts (14 tests)
 ✓ tests/api-client.test.ts (19 tests)
 ✓ tests/stores.test.ts (11 tests)
 Test Files  8 passed (8)
      Tests  91 passed (91)

$ npm run build:mp-weixin
DONE  Build complete.
运行方式：打开 微信开发者工具, 导入 dist/build/mp-weixin 运行。
```

**构建产物核验**：5 主包页（index/jobs/library/profile/login）+ `pages-sub/artifact` 子包 + `custom-tab-bar` + 全量组件 wxml/wxss 齐全。

**本里程碑修复（防回归记录）**

1. `artifact.vue` 舞台区对音频/3D 产物原样渲染 `<image :src="音频URL">` 会破图，且 `isAudioOr3d` 计算属性定义未用触发 eslint `no-unused-vars`。修复：舞台分支前置 `isAudioOr3d` 判断，音频渲染 `music` 图标、3D 渲染 `box` 图标占位（与页面头注释「音频·3D 图标占位」设计对齐）。

**测试套件清单（8 套件 / 91 用例）**

| 套件 | 用例数 | 覆盖点 |
|---|---|---|
| `tests/api-client.test.ts` | 19 | token 存取/清除、基址解析（覆盖>默认、空白无效）、mediaUrl 拼 token、Bearer/Accept 注入、POST Content-Type、long 180s 超时、X-NSFW 全局+单次覆盖、401 人话、detail 兜底 |
| `tests/api-index.test.ts` | 14 | login/me/engines/txt2img/img2img/jobs 列表/versions/rerun/delete 契约路径与载荷 |
| `tests/build-request.test.ts` | 13 | zod 校验、引擎参数归一、img2img 参考图必填、负数 seed 拒收 |
| `tests/library.test.ts` | 10 | kindToFilter 五桶/未知 null、kindLabel 兜底「其他」、collectArtifacts 只留 done+有产物、countByFilter、断点列数（390→2/431→3/768→4）、卡边长均分、isVideoPath |
| `tests/format.test.ts` | 12 | 相对时间、jobStatusMeta 标签/tone、isTerminalStatus/isActiveStatus/hasActiveJobs |
| `tests/poll.test.ts` | 5 | 指数退避间隔、shouldStop 终态停轮、PollHandle 取消（PollAbortedError）、onUpdate 成功/失败回填 |
| `tests/tokens-icons.test.ts` | 7 | 5 色板 × light/dark 完整性、必填 token 键、icons.generated 白名单与页面引用一致 |
| `tests/stores.test.ts` | 11 | auth restore（无 token→signedOut / me 成功→signedIn / 401 清理踢出 / 弱网缓存兜底）、settings 持久化桥接、draft 一次性消费 |

**已知噪音（非失败）**：build 期 sass `legacy-js-api` deprecation 警告（@dcloudio/vite-plugin-uni 内部调用，上游未迁移 Dart Sass 新 API，不影响产物）；vitest 启动期 Vite CJS Node API deprecation 提示。

---

## 2026-08-13 · MP5 里程碑（作品库 + 我的页）

**交付**

- `src/utils/library.ts`：FILTERS 五桶（图像 8 kind / 视频 23 kind / 音频 5 kind / 3D 3 kind，逐值对齐 Mobile `library-utils.ts`）；`columnCount` 断点 431/768；`cardSizePx` 屏宽均分。
- `src/pages/library/library.vue`：过滤 chips 带计数、等宽网格（`windowWidth` 断点 2/3/4 列）、视频角标 `film`、图像缩略 `lazy-load`、下拉刷新 + onShow 重拉（详情页删除返回即更新）。
- `src/pages-sub/artifact/artifact.vue`：eventChannel 收 job 主路径 + `query.id` + listJobs 兜底（分享/重进）；舞台图像点按 `uni.previewMedia` / 视频内嵌 / 音频·3D 图标占位；多产物缩略条切换；版本链 `fetchVersions(root_id)` 横滑条带；操作四件——复用（draft.fill → switchTab 创作页）/ 重新生成（keep/random/explicit 三 seed 策略，explicit 走 `uni.showModal editable` 输入校验非负整数）/ 下载（downloadFile → saveImage/VideoToPhotosAlbum，权限失败人话）/ 删除（二次确认 → navigateBack）。
- `src/pages/profile/profile.vue`：账户卡片（邮箱+角色）、显示模式三段（sun/moon/sun-moon）、五色板换肤（swatch 随 isDark 切换深浅变体）、API 基址覆盖（`/^https?:\/\//` 校验，留空恢复默认）、NSFW 开关（开启需 18+ 二次确认）、退出登录（确认 → signOut → reLaunch 登录页）。
- `scripts/gen-icons.mjs` 白名单 +3：music / box / sun-moon。

**测试**：`tests/library.test.ts` 10 用例全新增，当次 vitest 全绿。

---

## 2026-08-13 · MP4 里程碑（作业页）

**交付**

- `src/utils/format.ts`：`isActiveStatus`（queued/running）/ `hasActiveJobs`（列表有活跃才续轮）。
- `src/components/business/job-card.vue`：缩略图（无产物 image 图标占位）、视频 play 角标、提示词摘要、状态 Tag + 相对时间、终态删除（showModal 确认）、error 重试按钮（`retrying` 防重复 + loader-circle 旋转态，`@tap.stop` 阻断卡片点按）。
- `src/pages/jobs/jobs.vue`：`pollUntil` intervals [2000] + `shouldStop: !hasActiveJobs`（全终态即停）；onShow 启动 / onHide·onUnload 双保险取消；页面原生滚动承载 `onPullDownRefresh`（不用 scroll-view 全包，否则不触发）；点按分派——done 跳详情（eventChannel 传 job 对象）/ error 提示可重试 / 活跃提示状态。

**测试**：`tests/format.test.ts` 增补活跃态判定用例，当次 vitest 全绿。

---

## 2026-08-13 · MP3 里程碑（创作页）

**交付**

- `src/utils/build-request.ts`：zod 校验的请求构建纯逻辑（引擎参数归一、img2img 参考图必填、seed 非负整数）。
- `src/components/business/param-sheet.vue`：参数抽屉（sheet 承载，尺寸/步数/CFG/seed 按引擎能力渲染）。
- `src/components/business/ref-image-field.vue`：参考图字段（chooseImage → tempFiles 归一化数组取 size → upload → 预览/移除）。
- `src/pages/index/index.vue`：PromptBar + 引擎栅格 + 提交 → switchTab 作业页；onShow 消费 draft store 一次性回填（作品详情「复用」回链）。

**测试**：`tests/build-request.test.ts` 13 用例全新增，当次 vitest 全绿。

**踩坑记录**

1. `uni.chooseImage` 成功回调 `tempFiles` 类型为单对象或数组的联合，TS 下不可直接 `[0]` 索引——先归一化 `Array.isArray` 再取。
2. `uni.request` method 类型不含 `PATCH`，`ApiFetchOptions` 与其对齐移除，避免重载不兼容。

---

## 2026-08-13 · MP2 里程碑（登录鉴权）

**交付**

- `src/stores/auth.ts`：restore（storage token → fetchMe 校验；401 → logout + 清缓存踢出；弱网/服务不可达且有缓存用户 → 保持 signedIn，状态诚实由页面表达）；signIn / signOut 同步维护 `toiv.cachedUser` 快照。
- `src/composables/use-auth-guard.ts`：`requireAuth()` 页面守卫，未登录 `reLaunch` 登录页。
- `src/pages/login/login.vue`：邮箱+密码（zod 校验）、ApiError 人话文案、成功回创作页。

**踩坑记录**：auth store 的 `getToken` 须从 `@/api/client` 导入（非 `@/api` 桶文件），否则运行时 undefined。

---

## 2026-08-13 · MP1 里程碑（脚手架 + 基础层）

**交付**

- UniApp vite 模板：TS strict、`<script setup lang="ts">`、pages.json 五页骨架（artifact 详情入 `pages-sub` 子包控制主包体积）、custom tabBar 四栏。
- `src/theme/tokens.ts`：移植 Mobile 5 色板 × light/dark 双变体逐值对齐；4pt 间距网格 ×2 换算 rpx；`use-app-theme` 注入 CSS vars（换肤零组件改动）。
- `src/api/client.ts`：uni.request 封装——Bearer 注入、X-NSFW 全局+单次覆盖、DEFAULT 30s / LONG 180s 超时、401/403/404/429/500 人话 ApiError、后端 detail 兜底；`config.ts` 基址解析（用户覆盖 > 默认）；`mediaUrl` 相对拼 base + token 拼参。
- `src/api/index.ts`：login / fetchMe / engines / submitTxt2Img / submitImg2Img / listJobs / fetchVersions / rerunJob / deleteJob / uploadImage 契约。
- `src/stores/settings.ts`：色板/深浅模/API 覆盖/NSFW 持久化（桥接 client 模块态）；`src/stores/draft.ts`：创作草稿一次性回填语义。
- `src/composables/use-poll.ts`：指数退避 + PollHandle 取消 + PollAbortedError。
- `scripts/gen-icons.mjs`：Lucide 白名单生成器（从 lucide-static 提取 SVG inner → `icons.generated.ts`，全项目唯一图标源，遵守 Lucide 硬性约束）；`components/ui/` 八件 + `components/business/job-card.vue`。

**踩坑记录**

1. lucide-static 实际文件名为 `circle-alert.svg` / `ellipsis.svg`（非 alert-circle / more-horizontal），白名单登记以文件名为准。
2. vitest 环境无 `process` 类型——`env.d.ts` 显式声明 `process.env`。
3. uni 开关组件事件载荷类型与 DOM Event 不兼容——handler 参数用 `any` + eslint-disable 单行豁免（边界处唯一 any）。
