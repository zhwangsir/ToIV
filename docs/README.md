# docs/

本目录**不再堆方案文**。可读产品文档只在仓库根五件套；这里只留索引与非 md 数据。

## 指向根五件套

| 文件 | 用途 |
|---|---|
| [`../README.md`](../README.md) | 入口 |
| [`../AGENTS.md`](../AGENTS.md) | 会话规则 + **集群真源**（原 `docs/ops/CLUSTER_TRUTH.md` 已并入） |
| [`../DEVELOPMENT.md`](../DEVELOPMENT.md) | 开发长文 + 现行设置/模型/图谱摘要 |
| [`../TEST_LOG.md`](../TEST_LOG.md) | 测试近窗（完整历史见归档） |
| [`../STATE.json`](../STATE.json) | 机读状态 |

## 归档与找回

2026-10-26 文档瘦身：原 `docs/**/*.md`（约 102 份，含 ops/ux/research/_archive）已镜像迁至：

```
/Users/wangzhenyu/Desktop/ALLProject/.archive/toiv-docs-20261026/
```

按原相对路径存放（例如旧 `docs/ops/CLUSTER_TRUTH.md` → 归档内 `docs/ops/CLUSTER_TRUTH.md`）。  
`TEST_LOG` 2026-10-20 之前正文 → 同目录 `TEST_LOG_history_before_20261020.md`。

找回：直接打开归档路径对应文件；勿再把长文拷回 `docs/`。

## 仍留在 docs/ 的非 md 数据（保留）

| 路径 | 说明 |
|---|---|
| `MODEL_SOURCES.json` | 模型来源账本（现行） |
| `MODEL_SOURCES.json.bak.*` | 账本备份（可择机清） |
| `NAS_MODEL_PICKER.json` | NAS 盘扫缓存 |
| `ops/*.json` / `ops/*.csv` / `ops/_card_cache_*` | 调研卡页缓存与草稿数据 |
| `ops/*.bak*` 等 | 备份碎片 |

这些不是给人读的方案文；维护来源清单时改 JSON，不要新增 md。
