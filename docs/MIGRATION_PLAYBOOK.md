# ToIV 服务迁移手册（MIGRATION PLAYBOOK）

> **用途**：集群整体搬迁 / 换机房 / 云化时的执行手册与日常「可移植性」维护规范
> **维护者**：项目管家 + 设备管家
> **创建**：2026-09-13（用户提问「所有服务后续如果要移植该怎么办」）
> **配套**：服务清单 `docs/SERVICE_INVENTORY.md`（落地后维护）；模型清单 `docs/MODEL_SOURCES.json`（已有 800+ 条目）

---

## 一、先看清现状：我们有什么、痛在哪

### 资产六层

| 层 | 内容 | 位置 | 有状态数据 |
|---|---|---|---|
| 业务网关 | toiv-api :8090 / toiv-web :3100 / PG 18 / Redis / frpc | core (71.47, Ubuntu, systemd) | **PG 库（业务全量）、Redis、/data（作品/封面上传）、docker 卷（DRT 的 PG/Redis/MinIO/Loki）** |
| 算力服务 | 12 个 systemd unit（LB/H3/LongCat/Animate2/超分×3/Embedding/音频分离/MCP/fan_guard） | workstation (71.127, 4×PRO 6000) | ComfyUI outputs、用户上传缓存（小） |
| Windows 算力 | StartComfyUI(:8188) / StartComfyUI-H3(:8198) / RamDiskHotSync | pc01 (71.116, 5090) | outputs（小） |
| LLM 算力 | DSv4 容器（TP2 跨双机，手工脚本拉起） | spark01/02 (GB10) | 无状态（权重在 ~/models） |
| 存储 | SMB 模型库 800G+ + 业务文件 | NAS (71.7) | **一切模型与素材（最大头）** |
| 网络 | cloud frps + beijing OpenResty/frps + Tailscale | cloud / 阿里云 | ACME 证书 |
| 辅助 | OpenClaw×4（ soon ASR:9310 / JoyCaption:9305） | openclaw01-04 (M4 Mac) | 无状态 |

### 五大移植痛点（按严重度）

1. **🔴 IP 硬编码遍布全栈**：core `.env` 十几个 `TOIV_*_BASE_URL` 裸 IP、`/opt/comfyui-lb/backends.json`、systemd unit 里的 GPU UUID 与环境变量、`extra_model_paths.yaml` 的 NAS 路径、PC01 的 ps1、frp 配置、E2E runner 脚本。
2. **🔴 产品树 dirty**：大量「已部署未 commit」的代码（含 H3 双池/加速/策展/说明卡）——**不 commit 就无法在新环境复现，这是当前最大迁移负债**。
3. **🟡 有状态数据分散**：PG、Redis、/data、DRT docker 卷、NAS 800G+ 权重、各 ComfyUI output 目录。
4. **🟡 环境异构**：systemd（Linux）/ 计划任务（Windows）/ launchd（Mac）/ 手工 docker（Spark）四种托管方式。
5. **🟢 依赖未锁定**：venv 无 requirements 锁定、docker 镜像按 tag 尚可、模型=文件本身（清单已有 MODEL_SOURCES）。

---

## 二、三条可移植性原则（日常就要遵守）

### 原则 1：Git 即真相（Commit Discipline）
- **所有**部署到生产的代码/配置必须 commit 并打 tag（部署记录 = git tag + BUILD_ID）。
- systemd unit、ps1、plist、backends.json、extra_model_paths.yaml 等**基础设施配置必须入仓**（建议目录：`deploy/infra/<host>/`）。
- dirty 树只允许短命存在（<1 周），到期必须「commit 或回滚」二选一。
- *当前行动项：把 09-08 以来累计的 dirty 改动分批 commit（按功能：策展层/说明卡/加速/双池/H3 归一化），这是迁移前的第一优先级。*

### 原则 2：主机名抽象（Name, not IP）
- 内部服务一律用**主机名**通信，不用裸 IP。实现选项（任选其一，全栈统一）：
  - **方案 A（推荐，零基建）**：各主机 `/etc/hosts` + Windows `hosts` 统一维护，如 `ws.lan / core.lan / nas.lan / pc01.lan / spark02.lan`；配合 Tailscale MagicDNS（已有 `*.ts.net` 名字可推广到 LAN 配置）。
  - 方案 B：路由器静态 DNS（小米路由 AP 模式不可用，需主网关支持）。
  - 方案 C：自建 CoreDNS/unbound（重，仅多机房时需要）。
- 迁移时**只需改 hosts/DNS，一行切换全栈**。
- *当前行动项：新配置一律用主机名；存量裸 IP 在每次触碰到相关文件时顺手替换（渐进，不搞大爆炸重写）。*

### 原则 3：配置外置化（Single Source of Env）
- 每个服务的「环境差异」只许存在于一个 `.env`（或等价文件），仓库里只留 `.env.example` 模板。
- core 已符合（`deploy/.env` + `config.py` 默认值）；**待补齐**：WS 的 unit 文件内嵌参数、PC01 ps1 内嵌参数 → 改为读各自 `.env`。

---

## 三、迁移执行手册（真到搬的那天）

### 阶段 0：准备（现在~迁移前，累计 1-2 天）
1. **资产清单落盘**（见 `docs/SERVICE_INVENTORY.md` 模板）：每服务一行 = 名称/托管方式/unit 文件位置/端口/配置位置/数据位置/依赖/启动顺序号/验收方法。
2. **依赖锁定**：`pip freeze` 导出全部 venv（`deploy/infra/pip-freezes/<host>-<venv>.txt`）；`docker images --digests` 导出镜像清单。
3. **数据基线备份**：`pg_dump` + Redis RDB + `/data` 快照 + DRT 卷导出（现有 drt-bundle 六件套流程可复用）。
4. **commit 干净树 + 打 tag**（`git tag pre-migration-2026xxxx`）。

### 阶段 1：新环境基建（新机房/新机器到位后，半天）
1. 装系统 → 配主机名（按原则 2 的命名表）→ 挂 Tailscale。
2. NAS 或等价存储就绪（新 NAS 就位 + SMB 共享结构保持一致 `Windows/ComfyUI/ComfyUIModel` + `toiv/comfyui-models`）。
3. 域名/frp 通道改指向（cloud + beijing 的 frp server 配置）。

### 阶段 2：数据搬运（大头，按带宽估时）
| 数据 | 量 | 方式 |
|---|---|---|
| NAS 模型库 | 800G+ | NAS→NAS `rsync -av`（或源 NAS 整体搬）；**可先搬热模型（MODEL_SOURCES ok 清单 top），长尾后台续传** |
| PG / Redis / /data | GB 级 | `pg_dump` + rsync，停写窗口 10 分钟 |
| DRT docker 卷 | 按 bundle 六件套 | 复用现有导出流程 |

### 阶段 3：按序拉起（启动编排，每步带验收门）

```
① NAS + hosts/DNS          → 验收：各主机 mountpoint/hosts 互 ping 通
② workstation 12 units     → 验收：逐 unit active + LB /admin/backends 全 healthy + txt2img 出图
③ pc01 计划任务            → 验收：:8188/:8198 system_stats 200 + object_info 模型数对上
④ spark DSv4               → 验收：:8000 /health + 出文冒烟（冷启动 20-45 分钟，提前拉起）
⑤ core 业务栈              → 验收：/api/health + web 200 + 登录 + 一个端到端生成
⑥ OpenClaw / 辅助          → 验收：:18789 200 + ASR/JoyCaption 冒烟
⑦ frp/域名切换             → 验收：双域名真机各跑一条生成
```

**回滚预案**：旧集群保持运行直到 ⑦ 验收通过；DNS/域名切换是唯一「不可逆点」，切换前冻结发布。

### 阶段 4：稳态观察（1 周）
- 监控面板对照（sysmetrics :9403）、E2E 冒烟子集（L0 550 清单可复用）、用户路径抽查。

---

## 四、各服务专项要点

- **core**：`deploy/deploy.sh` 已 rsync+restart，天然可搬；注意 PG 版本一致（18）、`.env` 全量迁移（含密钥，走加密通道）、frpc `loginFailExit=false`。
- **workstation**：unit 文件入仓后 `deploy/infra/ws/` 一键安装；**GPU UUID 钉卡在新硬件上必须重新核对**（H-6）；venv 用 pip-freezes 重建；LB 的 backends.json 按新主机名重写。
- **pc01**：ps1 入仓；`cmdkey` NAS 凭据 + Z: 挂载是 Windows 特有三坑（W-1/W-2），新机器按 `start_comfyui.ps1` 模板重建计划任务。
- **spark**：`~/dsv4-serve.sh` + 模型目录 rsync；RAIL 200GbE 互联若新环境没有 → 退单卡 TP1 或单 spark 跑（脚本支持）。
- **NAS**：型号无所谓，**目录结构必须原样**（所有 extra_model_paths.yaml 与软链按相对路径写死）。
- **网络**：frp 服务端（cloud/beijing）不动，只改客户端配置；ACME 证书随域名走。

---

## 五、现在就做的准备清单（不迁移也值得做）

1. ⬜ **dirty 树分批 commit**（迁移第一负债，最高优先）
2. ⬜ `docs/SERVICE_INVENTORY.md` 服务清单落盘（本手册配套模板）
3. ⬜ pip freeze 全 venv 锁定入仓
4. ⬜ 新配置用主机名（存量渐进替换）
5. ⬜ WS unit / PC01 ps1 参数外置到各自 `.env`
6. ⬜ core `.env` 全量备份进加密保管（含 Tailscale key、NAS 凭据引用）

> **一句话**：ToIV 的迁移难度不在「搬家」，而在「复现」——只要 **Git 干净 + 配置外置 + 主机名抽象 + 清单齐全**，换机房就是「装系统 → rsync → 按序拉起」的标准流程；反之，dirty 树 + 裸 IP 遍布意味着换机器 = 考古。
