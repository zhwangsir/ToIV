> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行主机 / 端口 / 权重 / DOWN 口 → [`docs/ops/CLUSTER_TRUTH.md`](CLUSTER_TRUTH.md)。正文仅作考古，禁止盲抄配置。

# Wave M 进度 — 2026-10-22

时区：Asia/Shanghai（UTC+8）。执行器：模型保鲜 → 接棒工程师 Gate 验收。**未** commit/push；**未**擅自重启生产。

**当前 live gate（2026-10-22 03:50 起）**：`checkpoints/Qwen-Rapid-AIO-SFW-v23.safetensors`（仓库模板 + Core live 已同步；旧 v11 权重保留）。

基线：`docs/ops/MODEL_FRESHNESS_BASELINE_20261022.md`（扫描当时仍记 v11；以本节「当前」与文末 Gate 切换验收为准）

## 总览

| 步骤 | 状态 | 备注 |
|------|------|------|
| M1① 出图 smoke v11 vs v18 | **done / pass** | :8196 同参双轨成功 |
| M1② 拉 SFW-v23 + 轻量评测 | **done** | 已落 NAS；v23 smoke pass；**gate 已切 v23**（见文末验收） |
| M2 Wan Mega-v11 双轨 | **done** | 已落 NAS checkpoints；不写死默认 |
| M3 IndexTTS 核验 | **done** | 已是 2.5，无需升级 |
| M4 Kijai Acc-8Step 旁路 | **done** | Ref2VA/FL2VA pruned LoRA；未动 :8264 int8 |

账本 `MODEL_SOURCES`：ok **493** / blocked 337 / total **831**（本波新增 v23 + Mega-v11 + 2×Acc-8Step；含此前 M0 的 2 条 H3 int8）

## 磁盘

- NAS `/home/merlin/nas_mount`：44T 总量，约 **34T 可用**

---

## M3 — IndexTTS（只读，先完成）

- `checkpoints/gpt.pth` size=**3259599833**（对齐 2.5）
- `:9200/health` → `engine=indextts2` `version=2.5` `model_loaded=true`
- **判定：无需升级**；未停 :9200

---

## M1① — 出图 smoke（**pass**）

- Worker：`http://127.0.0.1:8196`
- 文件：
  - `checkpoints/Qwen-Rapid-AIO-SFW-v11.safetensors` size=28431829223
  - `checkpoints/Qwen-AIO-SFW-v18.safetensors` size=28431844111
- 对照：seed=20261022，768×768，steps=8，cfg=1.0，euler / sgm_uniform（复用 history Rapid AIO v5 成功档）
- 结果：

| ckpt | ok | 耗时 | 产物 | 字节 |
|------|----|------|------|------|
| Qwen-Rapid-AIO-SFW-v11 | ✔ | 168.5s | WaveM_M1_v11_00001_.png | 595832 |
| Qwen-AIO-SFW-v18 | ✔ | 120.56s | WaveM_M1_v18_00001_.png | 695483 |

- 证据：`workstation:/home/merlin/tmp/wave_m_smoke_20261022/m1_smoke_report.json`

---

## M1② — SFW-v23 双轨下载 + 轻量评测（**done**；gate 已于同日切 v23）

- URL：`hf-mirror.com/.../v23/Qwen-Rapid-AIO-SFW-v23.safetensors`
- 落盘：`/home/merlin/nas_mount/toiv/comfyui-models/checkpoints/Qwen-Rapid-AIO-SFW-v23.safetensors`
- size=**28431840023**（与上游 Content-Length 一致）；**未覆盖** v11
- 账本：已加 status=ok（batch `wave_m1_20261022`）
- 轻量 smoke（同参）：prompt_id `ec0b5bdf-25df-4bdf-a472-e10f9248bc91` → success；产物 `WaveM_M1_v23_00001_.png` **724803** bytes
- 证据：`.../m1_v23_smoke_report.json`

### 历史：当时提案（已采纳，见文末「Gate 切换验收」）

| 文件 | 旧 | 新（现已生效） |
|------|----|----|
| `apps/canvas/backend/cmd/desktop/toivgate/model-config.template.json` | `Qwen-Rapid-AIO-SFW-v11.safetensors` | `Qwen-Rapid-AIO-SFW-v23.safetensors` |
| `apps/canvas/deploy/toiv-staging/gate/model-config.template.json` | 同上 | 同上 |
| `publicAlias` / `displayName` | 含 v11 | v23 |
| `docs/NAS_MODEL_PICKER.md` 默认生图名 | v11 | v23 |

**当前 live gate = SFW-v23**（2026-10-22 03:50 Asia/Shanghai 起）。以下「未改」条目为提案当时快照，勿再当作现状。

---

## M2 — Wan Mega-v11 双轨（**done**）

- 落盘：`checkpoints/wan2.2-rapid-mega-aio-v11.safetensors` size=**24334498767**
- 用途：供 `:8197` 评测；**未**写死替换任何默认名
- 账本：ok（batch `wave_m2_20261022`）

---

## M4 — Kijai Acc-8Step 实验旁路（**done**）

- 下载：
  - `loras/MiniMax-H3-Ref2VA-Acc-8Step_pruned_comfy.safetensors` (1725921392)
  - `loras/MiniMax-H3-FL2VA-Acc-8Step_pruned_comfy.safetensors` (1725921392)
- 旁路：NAS 不支持 symlink；已 **hardlink** 到 `h3/loras/` 同名
- **禁止/未做**：替换 `:8264` 生产 pruned_int8
- 账本：ok（batch `wave_m4_20261022`）

---

## 未做 / 边界

- 未 commit / push / 部署
- 未重启 api / Comfy / systemd（smoke 仅 `/free` unload；v23 加载时 HTTP 短暂卡住后自恢复；**gate 模板已改，进程侧仍可能需窗内 reload 才吃到新默认**）
- ~~未改 live gate~~ → **已改 v23**（见文末）
- Mega-v11 / Acc-8Step：**可见性探针已做**（见「可选轻量核验」）；**出片**仍可选后续空窗

## 工件目录

`workstation:/home/merlin/tmp/wave_m_smoke_20261022/`


## Gate 切换验收（2026-10-22 03:50 Asia/Shanghai）

接棒工程师确认后已改 live gate：**v11 → v23**。未 commit/push、未重启整机。

### 仓库
- `apps/canvas/deploy/toiv-staging/gate/model-config.template.json` (+ `.example.json`)
- `apps/canvas/backend/cmd/desktop/toivgate/model-config.template.json` (+ `.example.json`)
- `apps/canvas/web/src/lib/local-model-defaults.ts`
- `apps/canvas/backend/internal/nasmodels/inventory.go`
- `apps/canvas/web/test/local-model-config-template.test.ts`
- `docs/NAS_MODEL_PICKER.md`

### Core live
- `/home/merlin/beeftv-prod/gate/model-config.template.json` → `toivNasWeight=checkpoints/Qwen-Rapid-AIO-SFW-v23.safetensors`
- beeftv-staging / toiv-studio：本轮无 SFW-v11 字符串（未改）

旧 v11 权重文件保留不删。备份后缀 `.bak_gate_v23_*`。

## 可选轻量核验（2026-10-22 接棒 · 2026-10-22 04:14 Asia/Shanghai）

**纪律**：未 commit/push；未重启；未提交 GPU 出片作业（`:8197` 当时 `queue_running=1`）。

### Mega-v11 @ :8197 — **visibility smoke pass**（非出片）

| 项 | 结果 |
|----|------|
| host | `192.168.71.127:8197`（LAN / fleet probe_host） |
| TCP / `/` / `/system_stats` / `/queue` | **up**；ComfyUI **0.30.0**；探针时 queue_running=**1** pending=0 |
| 权重可见 | `CheckpointLoaderSimple.ckpt_name` 含 **`wan2.2-rapid-mega-aio-v11.safetensors`**（与 v1 双轨并列） |
| 出片 | **跳过** — 避免抢队列；`scripts/e2e/longcat_smoke.py` 为分钟级 t2v，本窗不跑 |

### Acc-8Step H3 旁路 @ :8264 — **visibility smoke pass**（非出片）

| 项 | 结果 |
|----|------|
| host | `192.168.71.127:8264` |
| TCP / system_stats / queue | **up**；ComfyUI **0.34.0**；queue 空 |
| LoRA 可见 | `LoraLoader` 含 `MiniMax-H3-Ref2VA-Acc-8Step_pruned_comfy.safetensors` + `…FL2VA-Acc-8Step…` |
| 生产 int8 | **仍在**：`minimax_h3_ref2va_pruned_int8_convrot` / `…fl2va…`（未替换） |
| 真机旁路出片 | **跳过** — 无 &lt;2min 安全旁路图；完整 H3+LoRA 为长 GPU 作业 |

### 仍可选 / 未做

- Mega-v11 / Acc-8Step **出片**对照（需空窗 + 显式允许）
- 雨夜 dogfood 一镜（重）

## 续跑 CONTINUE（2026-10-22 05:05 Asia/Shanghai）

### 产品壳 dogfood（新 UI · dirty 工作区）

- 本地 Vite `:3010` + 双代理（canvas bootstrap → core `:3100/studio`，ToIV API → `:8090`）
- 登录 `admin` / `admin123`；项目 **雨夜便利店·林夏** `16e33f8b…`
- **D5-A**：顶栏「剧组协助」Switch `false→true`，`localStorage toiv_crew_assist:<pid>=1`，人闸提示可见 — **PASS**
- **变体下单**：设定卡抽屉 `data-testid=character-variant-order` 可见；「下单变体：古风写实」按钮×1；扩展档徽标「待 API」— **PASS**（未点下单，避免 15–20min sheet）
- 证据：`/tmp/toiv_dogfood_rain2.json` · `/tmp/toiv_dogfood_rain2.png` · `/tmp/toiv_dogfood_final.json`
- 部署态缺口：core 仍无 `GET /api/fleet/brief`、`/api/studio/deps-status`（工作区未部署 → 404）；Admin fleet 分母仍 **8/25**（N2 `probe=none` 仅工作区）

### GPU 出片对照 / 雨夜一镜

- 队列（本窗复测）：`:8264` / `:8197` / `:8196` **均 up 且空闲**（running=0 pending=0）——仍因无短脚本未提交出片
- **未跑** Acc-8Step / Mega 出片：无 &lt;10min 旁路脚本；完整 H3+LoRA / LongCat t2v / 雨夜定妆×4→Ref2VA 一镜均超本窗预算
- 雨夜验收标准（产品方案 §8）：定妆参考×4、不续写、tip 默认 ref2va — **仍待真机一镜空窗**

## CONTINUE IMAGE_SMOKE — gate SFW-v23 @ :8196（2026-10-22 05:11 Asia/Shanghai）

| 项 | 值 |
|----|----|
| 标签 | **IMAGE_SMOKE**（非 FULL_VIDEO / 非 Acc-8Step 视频） |
| worker | `http://192.168.71.127:8196` |
| ckpt | `Qwen-Rapid-AIO-SFW-v23.safetensors`（当前 gate） |
| 图 | Wave M1② 成功 API 图：8 steps · 768² · euler/sgm_uniform · seed=`2026102205` |
| prompt_id | `9c642d81-87e5-4188-a258-1a8001cb65fa` |
| 状态 | **success** |
| 轮询耗时 | **114.23s**（提交 05:06:48 → 完成 05:11:10 Asia/Shanghai） |
| 产物 | `Continue_IMAGE_SFWv23_00001_.png` **682209** bytes → 仓库 `test-results/Continue_IMAGE_SFWv23_00001_.png` |
| 报告 | `test-results/continue_sfw_v23_image_smoke.json` |
| 脚本 | `scripts/e2e/rapid_sfw_v23_image_smoke.py` |

**未做**：Acc-8Step / Mega 视频出片（仍无短旁路）；雨夜定妆×4 一镜。


## F5 雨夜验收（2026-10-22）

- **PARTIAL（主闭环可见）**：生产 BUILD `20261021-221837-b94ae940`；项目 `16e33f8b…` tip=`ref2va`；定妆×4 在档；不续写；剧组协助/KPI/剪映 API 点验。
- 真设定卡三次提交均触门禁（设计说明 / 人脸 / 服装色）；anime soft-keep 警告卡；未本窗新提 H3 一镜。
- 详：`docs/ux/research/WAVE_F5_RAIN_ACCEPT_20261022.md`
