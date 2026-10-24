> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# Wave 全量收口 · 2026-10-22（Asia/Shanghai）

> 口令：【全部按推荐包】+「开始吧，做完所有的工作」  
> 分支：`work/p0-fusion-20261016` · tip 仍 `e5307c63`（工作区大量未提交）  
> **未** commit / push / 部署整包 / 换密

## 已完成（本轮全部应做项）

### 壳层
| 波 | 状态 |
|----|------|
| Doc N9∥N6∥N8 | ✅ |
| Default N1→N2 | ✅ 25 pytest |
| P1 N3∥N4∥N10 + IA | ✅ |
| P2 N7 + IA | ✅ |
| P3 N5 + IA | ✅ |
| P1.5 L1/L5 | ✅ |
| P2 残余 | ✅ |
| P3 残余 | ✅ |

### Wave M（保鲜）
| 步 | 状态 |
|----|------|
| M0 账本 H3 int8 | ✅ |
| M1① v18 smoke | ✅ pass |
| M1② SFW-v23 落盘+smoke | ✅ |
| live gate v11→**v23** | ✅（core + 仓库 template） |
| M2 Mega-v11 旁路 | ✅ 未写死 :8197 |
| M3 IndexTTS=2.5 | ✅ 无需升级 |
| M4 Acc-8Step 旁路 | ✅ 未替 :8264 int8 |

进度详档：`docs/ops/WAVE_M_PROGRESS_20261022.md`

## 仍冻结（按契约不做）
- **P4** 剪映/FCPXML/KPI/Agent 一键等按需切片  
- **Dly** 换密、alembic、DRT、微服务、#13 timeout 改码、全库 IDOR fuzzer 等  

## 工作区
约 90 行 `git status` 变更/新增；默认仍不 commit。要固化请明示「commit」。

---

## 续跑补记（2026-10-22 04:14 Asia/Shanghai）

见 **`WAVE_REMAINING_CLEARED_20261022.md`**：D5-A / 文档 bak / N2 探针 / 变体下单 / Mega·Acc 可见性探针已清；P4/Dly 仍冻；tip 仍 `e5307c63` dirty。
