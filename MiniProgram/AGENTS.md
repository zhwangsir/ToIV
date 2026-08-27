# AGENTS.md — MiniProgram

> **最后更新**：2026-08-27（项目管家文档治理）
> **集群真相源**：`../AGENTS.md`（禁止把设备清单/凭据复制进本文件）
> **文档五件套**：README.md / AGENTS.md / DEVELOPMENT.md / STATE.json / TEST_LOG.md

## 本项目

ToIV 唯一移动端（uni-app，微信为主）。

路径：`ALLProject/ToIV/MiniProgram`（ToIV 唯一移动端；Expo 已归档到 `ToIV/.archive/mobile-expo-20260827/`）

## 硬性规则

1. 状态、端口、GPU、挂载、模型占用必须 SSH 真机验证，以 ToIV/AGENTS.md + 真机为准。
2. 禁止跨项目改代码。共享基础设施不耦合。
3. 未要求不要主动 git commit / push。
4. 旧文档已归档到 `ALLProject/.archive/docs-legacy-20260827/`，不要在项目根再堆副本。
