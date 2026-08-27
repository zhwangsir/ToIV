# ToIV Mobile

> **已归档（2026-08-27）**：这不是在维护的子项目。原 Expo `ToIV/Mobile/` 已 `git mv` 到本目录。ToIV 唯一移动端是 [`../../MiniProgram/`](../../MiniProgram/)（uni-app，微信为主）。不要在此树继续开发。集群仍只看 [`../../AGENTS.md`](../../AGENTS.md)。


ToIV 的 iOS / Android 客户端。历史路径曾是 `ALLProject/ToIV/Mobile/`，现已归档到 `ALLProject/ToIV/.archive/mobile-expo-20260827/`（在 ToIV 主仓内，没有独立远程）。对接同一套 ToIV API。

最后更新：2026-08-27。

## 这是什么 / 能做什么

Expo SDK 57 + React Native 0.86 + expo-router + TypeScript。底栏四个 Tab：**创作 / 作业 / 作品库 / 我的**。另外还有对话助手、Agent 团队运行、参考资产库等独立路由。

已落地（STATE.json 里程碑 M1–M30，均为 done）：

- 登录与 token；创作页引擎选择、参数表单、参考图、提示词反推 / 优化
- 作业列表与进度推送；作品库分页、类型过滤、批量管理、存为资产
- 视频 / 音频播放；数字人 avatar-talk 引擎入口
- 对话助手（流式对话、会话、文档挂载、附图上传）
- Agent 团队监控（列表 / 事件流 / 确认门 / 计划编辑）
- 设置（API 基址覆盖、关于、清缓存、导出诊断）

尚未由用户完成、不写成已上架：

- Android 真机全链路走查（EAS preview 包已打过）
- iOS 真机（需要 Apple Developer 账号与设备 UDID）
- Agent 后续 upload/reprompt（后端仍返回 501 时客户端不能假装可用）

## 访问的后端

默认 API：`http://192.168.71.47:8090`（core 生产，见 `src/lib/config.ts`）。设置页可以覆盖基址。生产 web 是 core `:3100`，本 App 不自己起 Next。

集群、GPU、引擎端口只在 [`../../AGENTS.md`](../../AGENTS.md)。

## 技术栈与布局

| 项 | 值 |
|----|-----|
| 运行时 | Expo SDK 57 / React Native 0.86 / React 19 |
| 路由 | expo-router（`src/app/`） |
| 状态 | zustand + tanstack-query |
| UI | NativeWind / Tailwind、lucide-react-native |
| 包名 | `com.toiv.mobile` |
| EAS | owner wineryz，preview 构建走 EAS |

目录：`src/app/`（tabs 与 assistant / assets / agent-runs）、`src/features/`、`src/lib/`、`app.json`、`eas.json`。

## 本地开发

在 `Mobile/` 安装依赖后，用 `package.json` 里的 start / ios / android / web 脚本启动 Expo。部分原生模块在 Expo Go 里不可用，真机能力以 EAS preview 为准。

质量门见 STATE.json：TypeScript 检查、lint、jest 覆盖率。

## 文档五件套

- [README.md](README.md) — 本文件
- [AGENTS.md](AGENTS.md) — 本子项目规则（集群仍读 ToIV/AGENTS.md）
- [DEVELOPMENT.md](DEVELOPMENT.md) — 归档索引
- [STATE.json](STATE.json) — 里程碑快照
- [TEST_LOG.md](TEST_LOG.md) — 测试日志

主产品说明见 [`../README.md`](../README.md)。

## 远程

与 ToIV 主仓相同，不是单独的仓库：

- origin → https://gitee.com/Winery_z/ToIV.git
- github → https://github.com/zhwangsir/ToIV.git
