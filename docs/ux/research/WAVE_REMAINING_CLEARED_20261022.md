> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# Wave remaining cleared — 2026-10-22 接棒续跑总收口

- **时间**：2026-10-22 04:14 Asia/Shanghai
- **分支**：`work/p0-fusion-20261016`
- **git tip**：`e5307c63`（工作区 **dirty**；**未** commit / push / 部署 / 重启）

## 本续跑已清

| 项 | 状态 | 证据 / 落点 |
|----|------|-------------|
| **D5-A 剧组协助** | ✅ | 顶栏 Switch · localStorage · 人闸轻提示 · `crew-assist-mode` 测 5 pass |
| **gate 文档 / bak** | ✅ | WAVE_M / DEVICE_MODELS / FRESHNESS → **当前 SFW-v23**；bak → `/tmp/toiv-bak-20261022/` |
| **N2 CosyVoice/ASR 探针** | ✅ | 9201–9211 LAN **Connection refused** → `probe=none` 摘分母；9200 对照 200 |
| **角色资产变体下单 UI** | ✅ | 设定卡抽屉「下单变体」· sheet 两档可下单 · 扩展四档标 API 缺口 |
| **Mega-v11 可选 smoke** | ✅ 可见性 | :8197 up + ckpt 列表含 v11；**出片跳过**（队列忙 + 避免长作业） |
| **Acc-8Step 可选 smoke** | ✅ 可见性 | :8264 up + 两 Acc LoRA 可见 + 生产 int8 仍在；**出片跳过** |

## 仍冻结（契约）

- **P4**：导出切片 / BGM / KPI / Agent 一键成片 等
- **Dly**：换密 / alembic / DRT / 微服务 / #13 等

## 仍可选 / 带外

- 雨夜 **dogfood 一镜**（重；无 &lt;2min 一键）
- Mega-v11 / Acc-8Step **出片**对照（需空窗 + 用户明示）
- 扩展画风（realistic/ink_wash/…）**产品化下单 API**
- 用户说「commit」后再固化工作区

## 关键未提交触点（摘要）

- `fleet_registry.py` / `test_fleet.py`
- `drama-workspace.tsx` · `crew-assist-mode.ts` · `character-style-variants.ts` · `client.ts`
- `docs/ops/WAVE_M_PROGRESS_20261022.md` 等 ops 对齐文
- `TEST_LOG.md` · 本收口文

## 对用户一句话

壳层与 Wave M / N2 / D5-A / 变体下单本窗能做的非冻结项已收口；生产 gate 指针已是 **SFW-v23**；CosyVoice 等已从在线率分母摘掉并记探针；Mega/Acc **权重对 worker 可见**但未跑出片。代码仍在工作区，**等你说 commit**。

---

## CONTINUE（2026-10-22 05:05 Asia/Shanghai · 用户「继续」）

### 本窗推进
| 项 | 结果 |
|----|------|
| 产品壳 dogfood D5-A | ✅ 雨夜项目顶栏开关 + localStorage + 人闸文案 |
| 产品壳 dogfood 变体下单区 | ✅ 设定卡内面板与「下单变体：古风写实」可见（未触发生成） |
| fleet/brief · deps-status | ❌ 生产 API 未部署工作区改动 → 404（预期） |
| Mega/Acc **出片** | ⏭ 跳过（无短脚本；队列可空但作业过重） |
| 雨夜真机一镜 | ⏭ 仍可选空窗（定妆×4 / 不续写 / tip=ref2va） |

### 仍冻 / 仍可选
- 冻：P4、Dly、commit/push/deploy/restart
- 可选：雨夜一镜、Acc/Mega 出片、扩展画风 API、用户说 commit

### tip
仍 `e5307c63` dirty。临时 dogfood 配置：`apps/canvas/web/vite.dogfood.config.ts`（未提交）。

---

## CONTINUE IMAGE_SMOKE（2026-10-22 05:11 Asia/Shanghai）

- ✅ **gate SFW-v23 静帧冒烟** @ `:8196` — prompt_id `9c642d81-87e5-4188-a258-1a8001cb65fa` · **114s** · 产物 `test-results/Continue_IMAGE_SFWv23_00001_.png`（682209 B）
- 标签明确：**IMAGE_SMOKE**，不是 Acc/Mega 全视频对照
- ⏭ 仍开：Acc-8Step / Mega **视频**出片、雨夜一镜、扩展画风 API、commit

---

## CONTINUE 扩展画风 API（2026-10-22 · 用户「继续」）

- ✅ **扩展画风产品化下单**：`realistic` / `ink_wash` / `cyberpunk` / `three_d` 挂入现有 sheet API（allowlist + prompt-pack + ckpt/theme）；UI 去「待 API」
- 测：`test_sheet_style_variants.py` + FE `character-style-variants.test.ts`
- 标记：`STYLE_VARIANT_API_DONE`
- ⏭ 仍开：Acc/Mega **视频**出片、雨夜定妆×4 / 一镜、commit（等用户明示）
- tip 仍 dirty（本窗无 commit）

---

## CONTINUE 收口（2026-10-22 · 用户「继续完成 / 继续」连击边界）

本段汇总自用户说「继续完成没有完成的内容」起、经多次「继续」至本窗的**自然收口**。  
**无** commit / push / deploy / restart；**无** P4 / Dly。

### 已完成

| 项 | 状态 | 落点 |
|----|------|------|
| D5-A 剧组协助 | ✅ | 顶栏 Switch · localStorage · 人闸轻提示 · 单测 |
| gate 文档 / bak | ✅ | WAVE_M / DEVICE / FRESHNESS → SFW-v23；bak → `/tmp/toiv-bak-20261022/` |
| N2 CosyVoice/ASR 探针 | ✅ | 9201–9211 `probe=none`；9200 对照 200 |
| 变体下单 UI | ✅ | 设定卡抽屉 · 初版两档 sheet |
| 产品壳 dogfood | ✅ | Vite `:3010` · 雨夜项目 D5-A + 变体区可见 |
| IMAGE_SMOKE SFW-v23 | ✅ | `:8196` prompt_id `9c642d81-…` · 114s · 682209 B |
| **STYLE_VARIANT 4/4** | ✅ | `realistic`/`ink_wash`/`cyberpunk`/`three_d` 挂入现有 sheet API；UI 去「待 API」 |
| Acc/Mega **可见性** | ✅ | LoRA/ckpt 列表（Wave M 已记） |
| Acc/Mega **VIDEO 出片** | ⏭ 诚实停 | 见下 |

### Acc/Mega VIDEO 本窗结论

探针时刻约 CONTINUE 收口窗 · LAN `192.168.71.127`
| 口 | TCP/HTTP | queue | 备注 |
|----|----------|-------|------|
| :8264 Acc/H3 | system_stats **200** · Comfy 0.34.0 | running=0 pending=0 | Acc LoRA 可见（既有） |
| :8197 Mega/LongCat | **200** · Comfy 0.30.0 | 0/0 | Mega-v11 ckpt 可见（既有） |
| :8196 gate | **200** · Comfy 0.27.0 | 0/0 | IMAGE_SMOKE 已过；非视频 |

- 队列空、口可达，但**没有**现成 &lt;15min Acc-8Step / Mega-v11 旁路工作流可改编。
- 既有：`h3_core_e2e`（H3 t2v≥22 帧，非 Acc）、`longcat_smoke`（默认长超时）、`rapid_sfw_v23_image_smoke`（静帧）。
- **未开** 30min+ FULL_VIDEO。落盘骨架：`scripts/e2e/acc_8step_min_frames_smoke.py`（探针 + `needs asset …` → exit 2）。

### 仍开 / 仍冻

| 类 | 项 |
|----|-----|
| 可选空窗 | 雨夜 **一镜**（定妆×4→Ref2VA）；Acc/Mega **FULL_VIDEO**（需资产 + 明示 GO；可续写骨架） |
| 冻结 | **P4** 导出/Agent 一键；**Dly** 换密/alembic/微服务等 |
| 门禁 | **commit / push / deploy / restart** — 等用户明示 |

### tip

`e5307c63` · 分支 `work/p0-fusion-20261016` · **dirty**（本连击未 commit）。

### 对用户一句话

「继续」连击里能安全做完的壳层 / 探针 / 静帧冒烟 / 扩展画风 API 已收口；Acc/Mega 视频只做到可达+空队列+骨架，**不出长片**。要固化代码请说 commit；要出片请明示 FULL_VIDEO 并备参考图。
