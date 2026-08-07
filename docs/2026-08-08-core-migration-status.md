# ToIV/DRT 迁移 core 状态与收尾方案(2026-08-08)

> 目标(用户任务 5):ToIV/DRT 业务完整迁移 core;Workstation 回归纯算力角色。
> 本文盘点当前真实状态、已完成项、剩余项与责任方。

## 一、当前真实状态

### core(192.168.71.47)—— 已是 ToIV 生产业务主机

| 组件 | 状态 |
|---|---|
| toiv-api(:8090) | ✅ 运行最新代码(deploy.sh 全量部署,本轮 19 视图回归通过) |
| toiv-web(:3100) | ✅ 同上 |
| PostgreSQL 18 / Redis | ✅ 真机运行 |
| ToIV 源码 /home/merlin/toiv(api/web/deploy/drama/scripts) | ✅ deploy.sh rsync 同步 |
| DRT 代码 | ❌ 未推送(待项目负责人) |

### Workstation(192.168.71.127)—— 算力角色已基本成立

- 所有 toiv-* 存活服务均为**算力服务**,且不引用 /home/merlin/toiv:
  - toiv-tts → /home/merlin/index-tts(GPU0)
  - toiv-comfyui-h3 → /home/merlin/ComfyUI-h3-eval(GPU0+GPU2)
  - toiv-liveact → /home/merlin/liveact(GPU1)
  - toiv-audio-sep → /home/merlin/toiv-scripts(GPU2,2026-08-08 迁入)
- **残留业务代码**:`/home/merlin/toiv`(37GB,git 停在 952490d 旧版本,无任何存活服务引用)、`/home/merlin/drt`(17GB,负责人项目)

## 二、剩余项清单

| # | 事项 | 责任方 | 说明 |
|---|---|---|---|
| 1 | DRT 推送 core 并起服务 | **项目负责人** | core 已有 PG/Redis;备份在 workstation /var/tmp(drt_pg_dump.sql / drt_redis_dump.rdb / drt_env_backup) |
| 2 | cloud 反代切换指向 core | 设备管家(待 1 完成后) | AGENTS.md 待办;需选低峰窗口,先 HTTPS 验证再切 |
| 3 | 清理 workstation 残留 /home/merlin/toiv(37G) | ~~设备管家~~ ✅ 2026-08-08 已完成 | 已归档 NAS `workstation-backup-20260808/toiv-code-37g.tar.gz`(27G,gzip -t 校验通过)后删除,释放 37G |
| 4 | DRT 目录(17G)处置 | 项目负责人决定 | 迁 core 后归档或删除 |

## 三、Workstation「纯算力」最终形态(目标态)

- 保留:ComfyUI 全家(gpu0/h3/longcat/LB)、IndexTTS2、Qwen3-Embedding、AI-Omni ASR、LiveAct、FlashTalk、OpenTalking、demucs、模型库(/home/merlin/models)
- 移除:一切业务代码 checkout 与业务进程(toiv/drt 源码、backend.pid/frontend.pid 残留)
- 网络面:core 经 LAN 直连 workstation 各算力端口(现状已如此)

## 四、执行建议

1. 本项目(ToIV)侧迁移**事实上已完成**(core 为唯一生产部署点,workstation 只剩算力服务)——可将 AGENTS.md 待办「项目负责人推送 ToIV 到 core」标记为 ToIV 部分已完成,仅剩 DRT
2. 用户确认后执行残留清理(事项 3);DRT 两项(1/4)推动项目负责人排期
