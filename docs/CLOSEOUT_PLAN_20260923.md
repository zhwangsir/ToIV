# ToIV 完整优化与收口计划（2026-09-23）

> **状态**：计划稿（`plan_only`）——**未经用户确认前不改生产、不停封面闸、不跑全量真跑、不双推产品。**  
> **作者**：ToIV 开发  
> **用户授权（确认计划后生效）**：可呼叫 设备管家 / ToIV 模型下载 / ToIV 能力缺口；收口后产品分支可双推 `main`（Gitee+GitHub）。  
> **用户未授权本轮**：暂停封面 autorefire / 清闸（需另拍板，否则长链与多数 R18 真跑仍会被挤占）。

---

## 1. 完成定义（可证伪）

用户验收前，以下谓词必须为真：

1. **公开可用集**：每一张计入 DoD 的公开市场卡，真机 **提交 → 出片/出图/出音** PASS。  
   - **计入**：能力扫描认定可本地化、且未 soft-hide 的公开卡（含内置双模引擎卡）。  
   - **不计入**：soft-hide 的硬阻/付费云端专用卡（白皮书登记例外）。  
2. **R18 / NSFW 完整**：  
   - 双能力卡封面 **SFW+NSFW** 双徽标；应用内可切换内容模式。  
   - NSFW 路径使用 **匹配 NSFW 底模/LoRA**（禁止 SFW 底模硬扛 R18）。  
   - 双模卡与高流量 NSFW 变体抽样真跑 PASS；质量回归清单全绿。  
3. **产品面**：助手、作业库、Admin（模型资产/测试矩阵/观测/封面闸）、Comfy save-back 等已交付路径可点可用。  
4. **证据**：公开集分波真跑清单 + 失败分流表（产品 / 设备 / 下载）+ tip 入账；用户再上手测试。

历史锁定口径（记忆）：*all apps usable = every public-market card PASS submit→出片；soft-hidden hard-blocked 不计入。*

---

## 2. 基线快照（2026-09-23 ≈04:00–05:00 CST，core via TS）

| 项 | 值 | 含义 |
|---|---|---|
| 产品分支 | `feat/app-guides-admin-cms` @ `b7935c5`（docs tip；产品父 tip 曾记 `b30806d`） | 比远端 `main` 超前；确认后可双推 |
| 远端 `main` | 双推后 tip 曾为 `a56a3e1`（docs cherry-pick） | 产品码尚未整支合入 |
| `cover_gate` | `gated=true`，depth **13** > guard **12**，pending **≈4461**，autorefire running；pending 整夜几乎不动 | **闲窗未开**；疑似封面批卡住，非稳步 drain |
| 业务队列 | queued/running **0** | 闸的是封面批，不是用户作业队列 |
| `/api/apps` 粗算 | total 6729；`is_public` 5106（non-variant 4617）；smoke pass/fail/timeout/empty 混杂 | 与 09-14「公开 ≈550」口径不一致——**开干第一件事是重划 DoD 公开集**（能力扫描 + soft-hide 策略复核），避免对 5000+ 卡盲目真跑 |
| 双模 `content_modes=['sfw','nsfw']` | **仅 9 张**（H3 族 + Flux2 txt2img/img2img），smoke 均为 pass | R18 合并仍浅；`r18_merge` 残 `ltx_nsfw` / `wan_nsfw` 未并 |
| `nsfw_variant_id` / variant_count | 公开侧大量变体字段 | 变体与双模策略需统一，避免「有 NSFW 变体但无双标/无切换」 |
| model_sources | ok478 / blocked336 / total815，core 已 live | 下载清单有底；blocked 与真跑 missing_model 应对齐 |
| 09-14 冲刺 | 497/550 = 90.4%；残差白皮书 `docs/HARDBLOCKED_WHITEPAPER.md` | 本轮以白皮书 + 新扫描为残差真源，不从零发明清单 |
| 992313 | 缺陷链已根治；闲窗终测挂起；轮询例程每 15 分钟 | 闸不松则终测不启 |

**公开集 smoke（non-variant public，粗）**：empty 最多；已测 fail+timeout 主因：`missing_model` / `timeout` / `missing_node` / `transport` / `product`。

---

## 3. 工作流（确认后执行；风险未知优先）

### P0 — 定界与腾空（1 个门禁）

| 步骤 | 谁 | 产出 | 门禁 |
|---|---|---|---|
| P0.1 能力扫描 vN | **能力缺口** | 可本地化 keep 集 / soft-hide 建议 / 缺模 basename / 缺节点 class | keep 集数量与名单写入本计划附录 |
| P0.2 对齐公开集 | **开发** | Admin soft-hide/上架与 keep 一致；DoD 分母锁定（目标回到「可测公开集」，预估数百级而非 5000+） | `DoD_denominator` 写入 tip |
| P0.3 封面闸 | **设备管家**（需用户另授权暂停/清闸） | autorefire pause 或 pending drain；`gated=false` 且 depth≤guard | **无此门禁则 P3/P4 长链与 R18 真跑降级为抽样+登记 defer** |
| P0.4 992313 | **开发**（例程已挂） | 闸松后自动烟测；结果入账 | PASS 或可解释 timeout（非产品） |

### P1 — 缺口填充

| 步骤 | 谁 | 产出 |
|---|---|---|
| P1.1 缺模下载 | **模型下载** | NAS 落盘 + `MODEL_SOURCES` 追加；优先 DoD 集 ∩ smoke `missing_model` ∩ 白皮书 A 组 |
| P1.2 缺节点/环境 | **设备管家** | 节点包、kernels、HF_ENDPOINT drop-in、worker 可见性；SeC 等上游硬边界只登记不硬扛 |
| P1.3 产品映射 | **开发** | `_build_graph` / Preview-only / 字段默认 / transport；单测 + core deploy |

### P2 — R18 / NSFW 质量专项（显式优先）

| 步骤 | 内容 | 验收 |
|---|---|---|
| P2.1 双模盘点 | 现有 9 双模 + `nsfw_variant` 图谱；补齐 LTX/Wan NSFW 合并（相对 09-08 残项） | 每张双模：双标 + 应用内切换 + twin 不重复占公开位 |
| P2.2 底模审计 | NSFW 模式是否加载 NSFW UNET/LoRA（对照 live Comfy history，不只看表单） | 错模 = 产品缺陷，必修 |
| P2.3 权重 | NSFW 底模/LoRA 在 keep 集路径上 ok（模型下载） | 无「有开关无权重」 |
| P2.4 抽样真跑 | 双模 9 全跑 NSFW 侧；再按类抽 RH NSFW 变体（图/视频） | 出片 + 人工抽检清单（无未成年；仅成人内容） |
| P2.5 回归 | 切换 SFW↔NSFW 不串模、不串封面、不丢 schema | e2e/烟测记录 |

### P3 — 公开集分波真跑

- 波次：先内置双模与 Top 流量，再 RH keep 集；失败即时分流（产品 / 设备 / 下载）。  
- 超时类：仅在闲窗（P0.3）重试；禁止与封面批硬刚。  
- 每波更新矩阵快照 → core `app_test_matrix/`（随 api 树）。

### P4 — 收口与交付

| 步骤 | 谁 |
|---|---|
| 产品 commit（忌 `.regen_tmp`） | 开发 |
| core 部署（web/admin **core 本机构建**；api `deploy.sh --skip-web`） | 开发 |
| 双推 `main`（Gitee+GitHub） | 开发（已授权） |
| AGENTS/STATE/TEST_LOG tip | **项目管家**（开发只报事实） |
| 用户验收包 | 开发：DoD 分母、PASS 率、R18 清单、已知例外白皮书 |

---

## 4. 角色与并行（确认计划后 fan-out）

| 角色 | 包 |
|---|---|
| **ToIV 开发** | 公开集对齐、产品修补、R18 双模/错模、部署、双推、真跑编排、例程 992313 |
| **ToIV 能力缺口** | 全量/公开 keep 扫描；缺模/缺节点清单 |
| **ToIV 模型下载** | 按清单下载到 NAS；`MODEL_SOURCES` |
| **设备管家** | 节点/kernels/闸/worker；**封面闸暂停需用户另令** |
| **项目管家** | tip 五件套；不写业务代码 |

跨机 TP（WS×Spark）不做；脑模型换代不在本收口范围（另题）。

---

## 5. 明确不做 / 延后

- 未确认前：**不**动生产、**不**双推、**不**全量烟测、**不**擅自停封面闸。  
- 现场项（openclaw02–04 / cloud `tailscaled`、core BIOS 来电自启、pc01 kernels）：不挡软件收口，用户稍后现场。  
- SeC×torch2.13/sm_120 等上游硬边界：白皮书例外，不删可本地化卡以外的滥砍。  
- 付费云端专用权重：不追。

---

## 6. 建议时间盒（确认后）

| 阶段 | 预估 | 依赖 |
|---|---|---|
| P0 定界 | 0.5–1 日 | 能力缺口扫描 |
| P0.3 闸 | 小时～日 | **用户授权** + 设备管家 |
| P1 填充 | 1–3 日 | 下载体积与节点安装 |
| P2 R18 | 1 日（与 P1 后半重叠） | NSFW 权重 + 闲窗 |
| P3 真跑 | 1–3 日 | 闲窗质量 |
| P4 交付 | 0.5 日 | — |

---

## 7. 确认清单（用户点头开干）

请确认或修改后回复「按此计划开干」：

1. DoD 与上文第 1 节一致（含 R18 质量条款）。  
2. 公开集以 **能力扫描 keep** 为分母（接受先 soft-hide 不可本地化，而不是对 5000+ `is_public` 蛮跑）。  
3. 是否 **追加授权**：暂停/清封面 autorefire（强烈建议，否则 P3/P4 长链与 R18 真跑无法诚实收口）。  
4. 确认后立即 fan-out 三专职 + 开发开干；收口后双推产品。

---

## 8. 附录 — 开干后第一批证据命令（备忘）

```bash
# 封面闸
GET /api/observability  → cover_gate.gated / queue_depth / pending

# 单卡烟测（闲窗）
POST /api/admin/apps/{app_id}/smoke

# 992313
POST /api/admin/apps/rh-acc-9923136513-48997d/smoke
```

登录：`email=admin`（见 core `.env` / AGENTS）。验证走 Tailscale `100.77.80.100`，**勿**打计量隧道做重测。

---

*本文仅计划。确认前唯一允许的动作：完善本文、向队友要「现状快照」供附录、保持 992313 轮询静默等待。*

---

## 附录 A — 能力缺口现状快照（2026-09-23，via ToIV 能力缺口；未开新扫）

| 项 | 口径 |
|---|---|
| **公开 keep** | 约 **550**（v23：live public 548 → 修正 unhide×2 → **550**） |
| **keep 定义** | main OK ∪ dedicated_aware（H3 ∪ animate2） |
| **soft-hide** | 能本地跑通保留公开；跑不通藏。硬阻/无源不追近名。dedicated_h3×8 历史 skip |
| **Animate GGUF** | 认 `/models/unet_gguf`（非 `/models/unet`） |
| **最新全量扫** | `.regen_tmp/capability_gap_scan_v23/`（2026-09-10，含 CLOSEOUT.md） |
| **收尾回执** | `.regen_tmp/capability_gap_closeout_20260910/` |
| **终态戳** | `.../v23/actionable/closeout_final_status.json`（public=550，hard_blocked=42） |
| **覆盖关系** | v22/v22b 为中间 unhide 波，已被 v23 覆盖 |
| **未并入正式扫** | 09-11 E2E wave1/2 失败备忘（Qwen3-VL / MelBand / LTX23 / Mixlab Text 等）— 开干后扫描需并入或单独对账 |

**对计划的修正**：第 2 节 API `is_public≈5106` 为库内脏公开位；**DoD 分母以 keep≈550 为准**（P0.2 soft-hide 对齐），不对 5000+ 蛮跑。


---

## 附录 B — 模型下载现状快照（2026-09-23，via ToIV 模型下载；未开新下）

| 项 | 值 |
|---|---|
| MODEL_SOURCES | ok **478** / blocked **336** / total **815**（updated_at **2026-09-18**） |
| NSFW / Wan / LTX 大包 | **无在途**下载任务 |
| NAS | 无 `.aria2` / `.part` 残留；本侧无下载进程 |
| 纪律 | plan_only：等能力缺口正式清单再动 |


---

## 附录 C — 封面闸诊（2026-09-23 ≈05:11 CST，via 设备管家；plan_only 未改闸）

### 结论
**消费死锁（假忙）**：真机 Comfy 各实例 queue 已 **0/0**，但 `cover_gate` 整夜 `gated=true`（depth **13** > guard **12**），pending≈4461 不动。

### 机制（设备管家）
1. `_run_batch` 在 `queue_depth > 12` 时 `sleep(30)` 空转；
2. `_fleet_queue_depth` 读 `pool.stats().last_queue_len`（**不强制刷新**）→ 真队列空仍卡 13；
3. `demo_running()` 因 `_DEMO_TASK` 未 done → autorefire 无法再 spawn；
4. journal 末条 `demo cover 80/120` @ 09-22 17:34 CST，之后无进度 → 与 done=87 后卡住吻合。
5. pending≈4461 = `plan_demo_targets` 待出封面应用数，**不是** Comfy 作业队列。

### 授权后推荐 pause/drain（设备执行；开发可并行修根因）
1. `TOIV_COVER_AUTOREFIRE=false` → `/home/merlin/toiv/deploy/.env`
2. `sudo systemctl restart toiv-api`（杀掉卡住 `_DEMO_TASK`，且不启 autorefire_loop）
3. 复核 observability：`autorefire_enabled=false`、`running=false`；Comfy queue 仍 0
4. 闸松开依赖 fleet depth≤12（重启后随下次探测通常回落）；**不必删 DB Job**
5. 闲窗测完若恢复封面：改回 `true` + restart，或小 `limit` POST `/api/admin/apps/covers/demo`

### 产品根修（开干后 · ToIV 开发）
- `_fleet_queue_depth`：**强制刷新探测**或勿用陈旧 `last_queue_len` 做闸；
- 死锁自愈：consumer 空转 N 轮且真 queue=0 时取消/重spawn `_DEMO_TASK`；
- 可选：admin 暴露 pause/cancel demo 封面批 HTTP（现无）。

