# ToIV Bug 总登记册（BUG REGISTRY）

> **维护规则**：所有渠道发现的问题统一登记于此，按 P0/P1/P2 分级；修复后状态改 FIXED 并注明验证方式；每周检视。
> **分级**：P0=阻断用户核心路径 / P1=功能缺陷或错误结果 / P2=体验、性能、技术债
> **来源标记**：[TEST]=测试发现 [E2E]=生产扫描 [WAVE]=E2E 矩阵 [DRIFT]=环境漂移 [STEWARD]=管家包 [USER]=用户反馈
> **创建**：2026-09-13「全面测试找 bug」行动
> **2026-09-13 第二轮（全面修复）**：设备/下载/产品三包自执行完成——:8195 3829 节点、权重 6 项落盘+hf-mirror 治本、stale 媒体 5/11+QwenEdit 11/12 翻盘、use_case 1622+featured 26、前端灰度已部署；api 3181/0、web 985/0；wave17 steward 复测跑中（inflight=1，H3 宿主 RAM 门防 OOM 瞬态拒绝为已知现象）。
> **2026-09-13 首轮结果**：api 3176 pass/0 fail（22 预存全清：1 真回归=list_apps 空结果已修复；21 测试过期重断言）；web 984/984 全绿；e2e 扫描 31/35 步过（4 个 FAIL 均为脚本误报复核排除）、无 P0 阻断、核心链路全通；新发现已修 P1×1（引擎探测误报 5/35→35/35）；待决策 P2×2（featured 补标/use_case 扩面）。

---

## P0 — 阻断用户核心路径

| # | 问题 | 来源 | 状态 | 责任 | 修复方案 |
|---|---|---|---|---|---|
| P0-1 | api 22 个预存测试失败（语义漂移债） | [TEST] | **FIXED**：3176 pass/0 fail（21 测试过期重断言 + 1 真回归修复已部署） | 产品 | tools_gen.py list_apps 显式传参；详见 `.regen_tmp/app_test_matrix_p0/preexisting_fixes_20260913.md` |
| P0-2 | **助手 list_apps 工具返回空**（09-12 策展层加 use_case/featured 参数后，tools_gen 直调未传参→truthy Query() 默认值过滤全部应用）——所有对话 agent 选应用路径全坏 | [TEST] | **FIXED+deployed**：tools_gen.py:1010 显式 `use_case=None, featured=False`，冒烟 `/api/apps` 2172 条 | 产品 | 已修（本批唯一真回归） |

## P1 — 功能缺陷

| # | 问题 | 来源 | 状态 | 责任 | 修复方案 |
|---|---|---|---|---|---|
| P1-1 | 11 例 stale RH 媒体引用 | [WAVE] | **FIXED**：`_normalize_stale_rh_media` 规范化器部署（哈希 Load* 死节点剥离+级联），**5/11 翻 PASS**；残留 6 例分流（4 缺 fl2va 系权重/1 RH partition 布局/1 瞬态） | 产品 | 残留转下载/设备包 |
| P1-2 | QwenEdit 12 例 queued_timeout | [WAVE] | **FIXED 11/12**：真凶=19.5G 模型逐作业重载 ~5min（runner stall/timeout 放宽）；剩 1 例需 fp4 量化权重（Blackwell） | 产品 | fp4 权重转下载管家 |
| P1-3 | Preview-only 中「部分校验失败但仍有存活保存分支」的图会零产出 | [WAVE] | 待修 | 产品 | _doomed_save_nodes 的 fail-fast 已覆盖全判死；部分判死场景下一批处理 |
| P1-4 | 引擎注册表/Covers/Seed 等测试语义与实现漂移（详见 P0-1 分组） | [TEST] | 修复中 | 产品 | 同 P0-1 |
| P1-5 | toiv-comfy-mcp `COMFYUI_URL` 指向已退役 :8189 | [DRIFT] | **FIXED**：drop-in 改 :8196，active，/mcp 401(认证态) | 设备 | 已修 |
| P1-6 | comfyui-longcat 钉卡口径矛盾 | [DRIFT] | **FIXED**：统一 UUID 钉卡（实测物理 GPU0），主 unit 注释已改 | 设备 | 已修 |
| P1-7 | LB backends.json 现网 2 后端（pc02 下线），core 兜底 env 与文档口径漂移 | [DRIFT] | **FIXED**（2026-09-14）：core deploy/.env `TOIV_COMFY_WORKERS` 同步为 :8196+:8188 双后端，api 重启后 /api/health 实测双 worker | 设备 | 已修（.env.bak-p17-20260914 备份） |
| P1-8 | :8195 等实例节点缺口 | [STEWARD] | **FIXED+回归验证**：:8195 3829 节点缺失 0、原生作业 PASS；:8188 4306/:8198 4652；:8198 补 RH 包（官方权重+配置树）；**wave17+18 复测：70 app 翻 32 PASS（46%）**（wave17 5.7%→修复内存门后 wave18 47%）；剩 32 失败=20 缺模型值（内容缺口清单见 P1-13）+5 缺节点+6 产品 | 设备 | 已修 |
| P1-9 | 模型权重缺口 | [STEWARD] | **大部分 FIXED**：sd3/t5xxl_fp16、Qwen3-VL-4B-FP8、SeedVR2（根因=旧文件 sha 损坏已重下）、DepthAnythingV2、segformer 全落盘；**hf-mirror drop-in×4 unit 治本**；blocked=Qwen3-VL-8B（>16G 阈值）；**2026-09-14 wave22 前置再落盘一批**：qwen_image_depth_diffsynth_controlnet（model_patches）、SeC-4B-fp16（sams）、Wan21_Uni3C_controlnet_fp16（controlnet）、Florence-2-large-PromptGen-v2.0（:8197 LLM）、Wan2.2-VACE-Fun-A14B low/high（各 32.3G，diffusion_models/VACE/）、svdq-fp4_r128-qwen-image-edit-lightningv1.0-4steps（r128 变体，Windows 库 diffusion_models 供 :8188） | 下载 | 增量已入 MODEL_SOURCES（811 条） |
| P1-10 | web appsApi featured 排序 2 个预存失败（R18 孪生并入 SFW 后测试语义漂移） | [TEST] | **FIXED**：984 pass/0 fail 全绿（仅改测试断言） | 产品 | 已修 |
| P1-11 | **引擎工作台可用性探测误报**（_PROBE_HARD_TIMEOUT 2s 把 object_info 2.24s/14.1s 的实例全判超时，22-30 引擎恒置灰，主入口瘫痪） | [E2E] | **FIXED+deployed**：两级探测（liveness 0.8s 快探+节点集合单飞缓存 TTL10min），engines 5/35→35/35，热路径 1.5s→0.048s | 产品 | 已修（单飞设计防自家并发风暴） |
| P1-12 | **:8195 主机内存膨胀致 H3 RAM 门大面积拒单**（无缓存上限，多应用模型/LoRA 卸载缓存累积，进程 RSS 94G/峰值 113.8G，可用压到 12G，生产 H3 受影响） | [E2E] | **FIXED**：unit 加 `--cache-lru 5`（核心三件+2 LoRA 槽，RSS 上限 ~70G，作业间可回落到 ~1G），restart+节点回归全过 | 设备 | 已修；wave17 的 40 例误伤经 wave18 复测大部分翻盘 |

| P1-13 | 缺模型值残差 20 例（app 存储的模型名在所有 worker 下拉不存在：Z-Image-Turbo-Fun-Controlnet-Union、fl2va 非 pruned 变体、finegrained-fp8 kernel 缺失等） | [WAVE] | 待办 | 下载/内容 | 逐一下载或产品侧 remap 到现有权重；清单从 wave18 top_blockers 提取 |

## P2 — 体验 / 性能 / 技术债

| # | 问题 | 来源 | 状态 | 责任 | 修复方案 |
|---|---|---|---|---|---|
| P2-1 | workstation legacy units 未清理 | [DRIFT] | **FIXED**：34 unit+3 drop-in → /home/merlin/systemd-archive/（37 文件），daemon-reload | 设备 | 已修 |
| P2-2 | pc01 三个 2026/7 残留旧计划任务 | [DRIFT] | **FIXED**：已删，XML 备份 C:\toiv-backup-schtasks\ | 设备 | 已修 |
| P2-3 | SoftPerfect RAM disk 30 天试用 ~2026-10-13 到期 | [USER] | **FIXED**（2026-09-14 用户拍板换 ImDisk）：ImDisk Toolkit 20250206 安装+切换+重启测试全 PASS，SoftPerfect 已卸载；R: 60G 预分配；两 ComfyUI 任务转 SYSTEM（修复重启后无人登录不启动）；详见 deploy/infra/pc01/README.md | 设备 | 已修 |
| P2-4 | MacMini 服务无鉴权（内网隔离，公网暴露前需 token） | [E2E] | 记录 | 产品 | 加 Bearer token 中间件（接 TS 后再做） |
| P2-5 | openclaw02-04 github 直连超时根因未查（出口策略差异） | [DRIFT] | 记录 | 设备 | 需要时查路由器出口策略；近期走 01 中转 |
| P2-6 | DRT 栈 12 容器去留未拍板 + spark02 LiveKit | [USER] | 待用户决策 | DRT 负责人 | 决策点保留 F 组 |
| P2-7 | whisper SRT 尾段时间轴虚高（mlx 30s 窗口 padding） | [E2E] | 记录 | 产品 | 换 VAD 后处理或分段重叠拼接 |
| P2-8 | 前端选择器不感知 recommended 灰度 | [USER] | **FIXED+deployed**：option disabled+「暂不可用」hint，BUILD_ID 20260913-062011 | 产品 | 已修 |
| P2-9 | 产品 dirty 树（迁移第一负债） | [USER] | 方案就绪待批 | 用户+产品 | docs/COMMIT_BATCH_PLAN.md 六批次 |
| P2-10 | :8198 无 T8 之外的加速调优（已补节点，未跑基准） | [USER] | 已补节点 | 产品 | 抽空跑三档基准对齐 :8195 数据 |
| P2-11 | 精选（featured）合集恒空 | [E2E] | **FIXED**：补标 26 个（usage top20+每类 top1），`?featured=true` 实测 26，前端精选位数据齐 | 产品 | 已修 |
| P2-12 | use_case 只覆盖 550/2172 | [E2E] | **FIXED**：1622/1622 RH 应用打完（0 fallback，两轮抽检 10/10、9/10 ≥85%） | 产品 | 已修 |

---

## 2026-09-17 主动猎错扫描（新增 + 当日收口）

| # | 问题 | 来源 | 状态 | 责任 | 备注 |
|---|---|---|---|---|---|
| N1 | /api/apps 市场列表回归:2MB/4-14s(曾 0.8s),limit 参数不生效;封面批并发时事件循环争用加剧 | [E2E] | **FIXED**:45s TTL 响应缓存(写操作 bump 失效)+GZip(2MB→246KB),命中跳过全表查询+2195 行构造+pydantic 序列化 | 产品 | apps_list_cache.py;agent tools_gen 兼容 Response 命中 |
| N2 | pc01:8198 H3 二实例反复挂(24h×3),计划任务仅 AtLogOn 崩后无人拉 | [E2E] | **FIXED**:Watchdog-ComfyUI-H3 计划任务(SYSTEM/5min),探端口不通即 /run StartComfyUI-H3 | 设备 | C:\toiv\watchdog-8198.ps1 |
| N3 | core :3389 gnome-remote-desktop --system 绑全部网卡 | [E2E] | **FIXED**:system+user 两级 disable,端口已释放 | 设备 | Ubuntu 自带 RDP,非业务依赖 |
| N4 | SeCVideoSegmentation 节点/模型不可用(387721 设备包尾项) | [STEWARD] | **FIXED**:Comfyui-SecNodes 克隆注册;sams 目录软链 NAS(fp16+bf16 已在 9/14 落盘),loader 枚举 ✓ | 设备 | 零下载 |
| N5 | :8195 GIMM-VFI/SDPose-OOD/LayerStyle 三包导入失败(cupy/mmcv/blend_modes 缺失),影响 18 个包内应用 | [STEWARD] | **FIXED**:依赖补齐+重启,类全部注册;10 抽样应用 class_type 对照 object_info 缺失=0 | 设备 | 终审以真实 workflow_json class_type 为准 |

---

## 防再犯机制（后续问题治理）

1. **fail-fast 已上线**：提交前校验保存节点必死场景（422 透传+取消作业），不再白烧 GPU。
2. **测试基线纪律**：全量 0 真实失败为合入门槛；xfail 必须带原因注释。
3. **E2E 回归建议**：本册 P0 清零后，把 e2e_sweep 脚本收敛为每日定时冒烟（候选入 CI/定时任务）。
4. **登记纪律**：任何渠道发现的问题 24h 内入册，修完标 FIXED+验证方式。
