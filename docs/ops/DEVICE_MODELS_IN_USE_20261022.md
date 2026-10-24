# 各设备在用模型 — 已迁出

> **DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai**  
> 本文件不再维护现场清单。**现行真源** → [`CLUSTER_TRUTH.md`](CLUSTER_TRUTH.md)。  
> 2026-10-22 01:09 盘点全文已归档：`docs/_archive/20261023/DEVICE_MODELS_IN_USE_20261022.md`（历史快照，非现行）。

## 一句话现行

| 能力 | 在哪 | 权重 / served |
|---|---|---|
| LLM | spark02 `:8000`（spark01=TP worker） | `dsv4-flash-dspark-abliterated` → `deepseek-v4-flash-dspark`（live 仍挂废弃别名 qwen*/glm*） |
| VLM | workstation `:9311` | `toiv-vlm` ← Qwen3-VL-8B-Instruct |
| H3 | ws `:8264` | minimax h3 ref2va/fl2va int8 |
| 出图 LB | ws `:8188` → 8196/8263/8265 | 产品 gate 默认见 core gate 模板（SFW-v23） |
| TTS / Embed / ASR | `:9200` / `:9302` / oc`:9310`×4 | IndexTTS2 / qwen3-embedding-4b / whisper-mlx |

复核命令与 DOWN 口见 CLUSTER_TRUTH。
