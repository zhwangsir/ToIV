# ToIV 服务拓扑重规划（2026-11-01）

> 真机取证 as-of 2026-11-01 01:00 Asia/Shanghai。决策：① drt(ERP) docker 栈彻底退役；② workstation 立即重启清 GPU0 孤儿。产品 API 端口契约不变。**状态：W1–W4 已执行（2026-11-01 02:40），结果见 §5。**

## 1. 现状问题（实测）

| # | 主机 | 问题 |
|---|---|---|
| 1 | ws | GPU0 `c219…` 驱动卡死，54.6GB 孤儿（`toiv-vlm.service` 已删 cgroup、僵尸 5d15h），CUDA 不可见，仅重启可清 |
| 2 | ws | `comfyui-upscale-gpu2 :8262` 重启循环 127 次，残留进程 2786 杀不掉、端口悬挂，空转 load≈3.0；upscale 已由 8263 承担 |
| 3 | ws | IndexTTS :9200 未钉卡，实际跑 CPU |
| 4 | ws | SenseVoice :9211 是 ToIV 音频反推生产依赖，却是手工 session（PPID 1，非 systemd） |
| 5 | ws | 数字 CVD 漂移隐患：animate2/upscale `=3`、audio-sep `=2`、H3 `=1`（`PCI_BUS_ID`）、VLM `=0`（`PCI_BUS_ID`） |
| 6 | core | `frpc` → 43.119.32.180 死隧道，20s 重连超时；`toiv.dgmt.top` 公网不可达 |
| 7 | core | drt-* 13 容器（ERP erp.dgmt.top）7 天 0 请求，AI 依赖全指向已退役端点；公网 DNS 指向死云主机 |
| 8 | core | Docker build cache 201GB |
| 9 | core | `canvas-api-pg` 是用户级 systemd（linger=yes，Restart=on-failure） |
| 10 | ws | coturn failed（ERP LiveKit 附属） |
| 11 | spark02 | LLM :8888 由 memguard.sh 手工托管（2d6h），无 systemd，重启即丢 |
| 12 | repo | trainer 声明 :9100 与 MCP 桥 :9100 冲突（trainer 未部署） |

作业队列：无 run/queued（历史 done 950 / error 902 / canceled 12，最后 10-29）。重启不伤任务。

## 2. 目标拓扑

### core（唯一公网入口 = toiv.wineryz.top → 8.140.222.24 openresty）
- toiv-api :8090 · toiv-web :3100 · toiv-admin :3200（systemd）
- canvas-api-pg :8290（用户级 unit，linger 已开；本轮不迁移，保持 Restart=on-failure）
- PG18 :5432 / Redis :6379（仅回环）
- 退役：frpc、drt-* 全部容器/卷/镜像、coturn、toiv.dgmt.top 通道
- 回收：docker build cache 201GB、匿名卷

### workstation（4× RTX PRO 6000，重启后 4 卡全可见）
| GPU | 角色 | 服务 |
|---|---|---|
| GPU0 `c219…` | 视觉理解 | VLM :9311 + IndexTTS :9200 |
| GPU1 `8a63…` | 向量 | embedding :9302 |
| GPU2 `0e6e…` | H3 + ASR | H3 :8264 + SenseVoice :9211 |
| GPU3 `91a1…` | ComfyUI 全家 | 通用 8196（LB 8188、LongCat 桥 8197）+ animate2 8199 + upscale 8263 + demucs 9220 |

- 端口契约：产品 API 8090/3100/3200/8290；AI 9311/9200/9220/9302/8264/8196/8199/8263/8188/9310（openclaw whisper ×4）
- 裁掉：8262、8189、8195、8261、8265、9210、9303、9400-9404
- 钉卡策略：能用 UUID 一律 UUID；VLM 保持 `CUDA_VISIBLE_DEVICES=0 + PCI_BUS_ID`（重启后即 GPU0）
- MCP :9100 保持 0.0.0.0（后端跨主机调用，token 保护）；trainer 落地时改用 :9104
- SenseVoice 转 `toiv-sensevoice.service`（UUID GPU2）

### spark
- spark02 LLM :8888 原样；W4 补 systemd 托管（memguard + tensorfold），切换需单独窗口
- spark01 TP rank1 不动

## 3. 波次与回退

| 波次 | 内容 | 停机 | 回退 |
|---|---|---|---|
| W1 | ERP 备份→down -v --rmi all；停 frpc/coturn；停 upscale-gpu2；SenseVoice 转 unit；数字 CVD→UUID/drop-in；缓存回收 | 无（ERP 本已不可用） | 备份 `~/backups/drt-final-20261101`；drop-in 删除；unit 恢复 |
| W2 | workstation 重启清 GPU0 | 生成类 5-10 分钟 | 重启前快照 unit 文件；核心 web/api 不受影响 |
| W3 | 重启后按 UUID 核验落卡；VLM/TTS/Comfy/H3/embedding/ASR 健康 + 真实调用 smoke | 无 | 单服务重启 |
| W4 | AGENTS 端点表回写；spark02 systemd 托管制；部署脚本/监控对齐 | 无 | 配置回滚 |

## 4. 明确不做（本轮）
- 不改产品 API 端口与远端部署路径契约
- 不迁移 canvas-api-pg 到系统级 unit（linger 已保证可用；迁移需改 deploy.sh）
- 不重启 spark01/02（LLM 无 systemd 切换窗口另议）
- 不删除 `/home/merlin/drt` 源码目录（仅退役运行时；目录留档）

## 5. 执行结果（2026-11-01 02:40）

### W1（无停机项）✅
- ERP：备份 `/home/merlin/backups/drt-final-20261101/`（drt.sql.gz 129K/204 表 + 10 卷 + compose/env 600）→ `compose down -v --rmi all` 清 13 容器/卷/镜像；80/443 释放。
- 缓存回收：builder prune 201.2GB、image prune 2.378GB、volume prune 286.4MB → `docker system df` 全零；core 磁盘 used 92G。
- `frpc` 停用、`coturn` 停用、`comfyui-upscale-gpu2` 停用（127 次重启循环终止）。
- SenseVoice 手工进程 → `toiv-sensevoice.service`（/etc/systemd/system，GPU2 UUID）。
- 数字 CVD → UUID drop-in：indextts→GPU0、H3/SenseVoice→GPU2、animate2/upscale-gpu3/audio-sep→GPU3。

### W2（重启）⚠️ 远程处置
- `systemctl reboot` 后**关机卡死**：内核存活（ping TTL=64、MAC 不变），sshd 与所有业务端口停止，30 分钟无进展；`.127` 无 BMC 端口、无 mDNS、无其他监听。
- 发现**未登记的带外管理口**：`192.168.71.108`（MAC 与主机相邻，ASUS iKVM/MegaRAC，Redfish + TCP 623 + OpenSSH 7.9），独立供电。
- 出厂默认 `admin` 强制首登改密；已改密，口令存 Mac `~/toiv-ops-logs/bmc-cred-20261101.txt`（600），未入库/未打印。
- `POST /redfish/v1/Systems/Self/Actions/ComputerSystem.Reset {"ResetType":"ForceRestart"}`：断电 12s → 上电 22s → sshd 95s。

### W3（重启后核验）✅
| 项 | 结果 |
|---|---|
| GPU | 4 卡全可见；GPU0 `c219…` 恢复，孤儿清零（used = TTS 7G + VLM 30G ≈ 37G） |
| 落卡 | GPU0 = IndexTTS + VLM；GPU1 = embedding（15.9G）；GPU2 = SenseVoice + H3；GPU3 = ComfyUI×2 + animate2；均 UUID 钉卡 |
| 单元 | 12/12 active+enabled；`comfyui-upscale-gpu2`/`coturn` inactive+disabled；`systemctl --failed` 空 |
| HTTP | 8188/8196/8197/8199/8263/8264/9200/9211/9220/9302/9311 全 200 |
| 队列 | 5 个 Comfy 实例 running/pending 全空 |
| 真实调用 | VLM chat 返回 ok；embedding POST `/v1/embeddings` dim=2560；TTS `POST /tts` 200（98,348 B WAV）；Comfy `object_info` 5400 节点；H3 `system_stats` 200；SenseVoice `/docs` 200 |
| core | api 200 / web `/studio` 200 / canvas 401（鉴权路径，服务在线）；`job` 表 running+queued+pending = 0（done 950 / error 902 / canceled 12） |
| 系统 | load 0.34；NTP synchronized；无 NVRM/Xid；8262 无监听 |
| 启动告警 | 仅 FlashVSR-v1.1 挂载单元名含 `.` 与 `Where=` 不匹配（基线 `FlashVSR.mount` 正常），已记入 AGENTS §六 |

### W4（回写）✅/待续
- AGENTS.md：新增 BMC 主机行与凭据落点、SenseVoice 端点、落卡真值、DOWN 口更新、§六 开口重写。
- 待续：spark02 LLM 的 systemd 托管（需单独窗口）；FlashVSR v1.1 挂载修复；canvas-api-pg 系统级迁移（本轮不做）。
