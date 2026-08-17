# ToIV 项目收尾工作计划

> 日期：2026-08-15（2026-08-17 更新）
> 范围：Mobile（React Native/Expo）+ MiniProgram（UniApp）+ API/Web
> 状态：M1-M30 / MP1-MP32 全部开发完成；P2 外部阻塞已解除 2/3；SKILLS-SEAM 遗留已清零（2026-08-16 收尾轮，见 TEST_LOG.md CLOSEOUT-R51）；fixpack「longcat/wan/avatar 秒数化」+ 移动端 duration 断链已清零（2026-08-17 收尾轮，见 TEST_LOG.md CLOSEOUT-R54）；生产 toiv-web 500 事故已修复（2026-08-17，陈旧 .next 缓存污染→干净重建+重新部署，双服务 200，见 TEST_LOG.md CLOSEOUT-R55）；裁切链窗口期「未裁原片闪现」已根治（2026-08-17，post_status 全端接线，见 TEST_LOG.md CLOSEOUT-R58）

---

## 一、待办项全景

### P0 — 本期收尾（AI 执行，当日完成）

| # | 任务 | 负责方 | 验收标准 | 状态 |
|---|------|--------|---------|------|
| P0-1 | 制定收尾计划（本文档） | AI | 文档落盘 | ✅ 完成 |
| P0-2 | 代码质量优化：清理残留调试日志/未用引用/死代码 | AI | eslint 0 警 + tsc 0 错 + 测试绿 | ✅ 完成（console 清零；wechatLogin 保留备查有引用） |
| P0-3 | 性能优化：包体积/渲染/网络最后审查 | AI | 无过度工程，关键路径无回归 | ✅ 完成（mp-weixin 816K / RN 6.9-7.1MB；轮询取消已优化） |
| P0-4 | UX 优化：交互一致性/错误提示/加载态审查 | AI | 走查全绿 | ✅ 完成（friendlyMessage 体系统一；111+30 走查全绿） |
| P0-5 | 全量回归验证 + STATE/TEST_LOG 落账 | AI | 双端全绿 + 文档更新 | ✅ 完成（见下方数字） |

**P0-5 最终回归数字（2026-08-15）**

| 端 | 类型检查 | 代码检查 | 单元测试 | 走查 | 构建 |
|----|---------|---------|---------|------|------|
| 小程序 | vue-tsc 0 错 | eslint 0 警 | vitest 26 套件 **565/565** | H5 **111/111** + 微信 **30/30** | 四端全 DONE |
| 移动端 | tsc 0 错 | expo lint 0 警 | jest 41 套件 **798/798**（覆盖率 95.00/89.33/97.01/95.54） | — | expo export 三端 + 17 路由 |

**2026-08-16 复跑（MP32 + R3.2 四期后）**：小程序 565/565、H5 111/111、微信 30/30、四端构建全 DONE；Web 234/234、tsc 0 错；后端 pytest 1670 passed（2 个 test_redis_integration 预存 flaky，已实证无关）。

### P1 — 真机走查（用户手动，需设备）

| # | 任务 | 负责方 | 前置条件 | 状态 |
|---|------|--------|---------|------|
| P1-1 | MP9 Round 2 微信真机走查 | 用户 | 微信开发者工具 + dist/build/mp-weixin | 🔄 模拟器段 30/30 复验通过(2026-08-16 晚);dist 已重建含 R54 秒数化改造(2026-08-17,真实基址无 mock 残留);真机段待用户 |
| P1-2 | M18 Android 真机走查 | 用户 | EAS APK 已重建（含 R54 修复，build 3d933ea9） | ⏳ 待执行（**请用新 APK**，旧包 fe05ac5f 不含 duration 修复，见下） |

**P1-2 APK 下载（2026-08-17 重建，build 3d933ea9 FINISHED，含 R54 duration 断链修复）**：
https://expo.dev/artifacts/eas/UCobGR1SfeWVkcr3gtvy7eC_i_rg36ASQxUuSVrYmgE.apk

~~旧包 fe05ac5f（2026-08-16）~~：不含 R54 修复，走查 SFW h3/ltx25 时长会命中已修复 bug，勿用。

**P1-1 验收清单**（微信开发者工具导入 `MiniProgram/dist/build/mp-weixin`）：
- [x] 渲染差异核对（与 H5 走查截图对比）— 模拟器 30/30 通过
- [x] 登录页微信 CTA 渲染（MP32 原生 button，W1.1 wechat=true）— 模拟器通过
- [ ] 微信一键登录真机链路（uni.login → code → /auth/wechat；模拟器 code 无法过 code2session，需真机）
- [ ] 相册下载/保存（chooseImage → saveImageToPhotosAlbum 权限链路）
- [ ] chooseMessageFile 会话文件选择/上传
- [ ] R18 引擎可见性随 NSFW 开关切换
- [ ] MP19 对话助手 SSE enableChunked 真机分块渲染/停止 abort
- [ ] MP24 分叉会话双入口/视频全屏覆盖层/草稿持久化
- [ ] MP25 批量管理多选/批量删除/批量保存相册
- [ ] MP30 附图 chooseImage 双通道/chip 会话隔离

**P1-2 验收清单**（安装 EAS APK）：
- [ ] 登录 → 创作 → 提交 → 作业 SSE 进度 → 作品落库全链路
- [ ] 对话助手附图选图/上传/发送/会话切换恢复
- [ ] 作品库/资产库批量管理
- [ ] 设置页关于/清理缓存/导出诊断

### P2 — 外部阻塞（依赖第三方/框架）

| # | 任务 | 阻塞原因 | 解除条件 | 状态 |
|---|------|---------|---------|------|
| P2-1 | Agent 四期 upload/reprompt | 后端 501，待 R3.2 提供 | 后端实现 | ✅ 完成（2026-08-16：action=upload{url} + action=reprompt + multipart 直传端点；Web 卡片两按钮解禁接线；pytest 1670/web 234 全绿，详见 TEST_LOG.md AGENT-R32 章节） |
| P2-2 | iOS 真机验证 | 需 Apple Developer 账号 + 设备 UDID | 用户提供 | 📋 指引就绪（见下方「P2-2 操作指引」） |
| P2-3 | 微信登录恢复 | uni 编译器 `<Button @click>` prop 事件映射不可靠 | uni 框架修复或原生 button 重写 | ✅ 完成（2026-08-16 MP32：登录页原生 `<button @tap>` 重写，微信 CTA 条件编译恢复；微信走查 30/30 + H5 111/111 验证） |

---

## 二、P2-2 操作指引（iOS 真机验证）

前置（用户）：Apple Developer 账号（付费 $99/年）+ 测试设备 UDID（设置 → 通用 → 关于本机，或接 Mac 访达查看）。

```bash
cd Mobile
# 1. 登录 Expo 账号（已与 Android 构建同账号 wineryz）
npx eas login
# 2. 关联 Apple Developer 账号并登记设备 UDID（交互式，按提示扫码/输账号）
npx eas device:create
# 3. iOS preview 构建（internal distribution，与 Android preview 同 profile）
npx eas build --platform ios --profile preview --non-interactive
# 4. 构建完成后扫码或点链接安装（TestFlight 之外的 ad-hoc 通道）
npx eas build:list --limit 1
```

验收清单同 P1-2（登录→创作→提交→SSE→落库全链路 + 对话助手附图 + 批量管理 + 设置页）。

---

## 三、进度跟踪机制

- **每日收口**：P0 任务当日完成，TEST_LOG.md 追加条目
- **真机走查**：用户执行后反馈结果，AI 根据问题清单修复并回归
- **外部阻塞**：P2-1/P2-3 已解除；P2-2 待用户提供 Apple 账号后按指引执行

---

## 四、质量门禁（收尾阶段）

| 门禁 | 标准 |
|------|------|
| 类型检查 | vue-tsc / tsc 0 错误 |
| 代码检查 | eslint / expo lint 0 警告 |
| 单元测试 | vitest / jest / pytest / web 全绿 |
| 走查 | H5 111/111 + 微信 30/30 |
| 构建 | 四端（h5/mp-weixin/mp-alipay/mp-toutiao）+ expo export 全过 |
| 覆盖率 | 核心模块 ≥80% |

---

## 五、完成定义（Done）

P0 全部完成 + 全量回归绿 + 文档落账 → **收尾阶段完成**，项目进入维护模式。
P1/P2 由用户/外部条件触发后单独推进（P2-1/P2-3 已于 2026-08-16 提前解除）。

