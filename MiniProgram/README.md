# ToIV MiniProgram

ToIV **唯一移动端**（uni-app）。微信为主，必要时再出 App。路径是 `ALLProject/ToIV/MiniProgram/`（在 ToIV 主仓内，没有独立远程）。对接同一套 ToIV API。原 Expo `Mobile/` 已归档到 `../.archive/mobile-expo-20260827/`。

最后更新：2026-08-27。

## 这是什么 / 能做什么

UniApp 3（Vite 5）+ Vue 3 + Pinia + 自研 UI（Lucide 白名单图标）。页面见 `src/pages.json`：创作、作业、作品库、我的、登录、参考资产库、助手、Agent 团队。作品详情在分包 `pages-sub/artifact`。

STATE.json：MP1–MP32 均已标记 done（更新于 2026-08-16）。交付收口后仍待微信真机人工走查（相册 / 摄像头 / 文件权限）。不要把里程碑 done 写成已经上架微信。
创作页引擎 2026-08-27 已追上现役注册表（`f261f45`）：含 qwen-image-edit、h3-multishot、wan-transition、keyframe-chain、vace-edit、wan-animate-2、wan-nsfw-i2v；已去掉 ltx25-*。作品库里这些新 kind 暂时仍归「其他」。

| 页面 | 路径 |
|------|------|
| 创作 | pages/index |
| 作业 | pages/jobs |
| 作品库 | pages/library |
| 我的 | pages/profile |
| 登录 | pages/login |
| 参考资产库 | pages/assets |
| 助手 | pages/assistant |
| Agent 团队 | pages/agent-runs |

## 访问的后端

开发与生产环境文件当前都把 API 基址设为 core `http://192.168.71.47:8090`。本机只跑小程序 / H5，不在小程序里起 FastAPI。微信登录需要 core 侧 AppId；未配置时该接口不可用。不要把密钥写进本文件。集群见 [`../AGENTS.md`](../AGENTS.md)。

## 技术栈与布局

`src/pages/` 主包，`src/pages-sub/` 作品详情分包，`src/api/`、`src/stores/`（Pinia）、`src/components/`、`tests/`（vitest）。

## 本地开发

在 `MiniProgram/` 安装依赖后，用 `package.json` 脚本 `dev:h5`、`dev:mp-weixin`、`build:mp-weixin`。质量门：typecheck、lint、vitest。

## 文档五件套

- [README.md](README.md) — 本文件
- [AGENTS.md](AGENTS.md) — 本子项目规则（集群仍读 ToIV/AGENTS.md）
- [DEVELOPMENT.md](DEVELOPMENT.md) — 归档索引
- [STATE.json](STATE.json) — 里程碑快照（2026-08-16）
- [TEST_LOG.md](TEST_LOG.md) — 测试日志

主产品说明见 [`../README.md`](../README.md)。

## 远程

与 ToIV 主仓相同：

- origin → https://gitee.com/Winery_z/ToIV.git
- github → https://github.com/zhwangsir/ToIV.git
