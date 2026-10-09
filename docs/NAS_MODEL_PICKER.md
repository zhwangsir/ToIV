# NAS 模型选模清单（配置页）

来源：`docs/MODEL_SOURCES.json`（status=ok）派生，勿另造平行清单。

- NAS 根默认：`toiv/comfyui-models`（完整路径由 `TOIV_NAS_MODELS_ROOT` / 挂载决定）
- **H3**：仅 `h3[]`（11 条）→ 生产 worker **:8264**
- **main**：按 `用途` 过滤（467 条）；出图口 :8196（slice2）
- **对话**：不扫本清单 / 不扫 `LLM/` → Spark 别名 `deepseek-v4-flash-dspark`

换模：落盘后 refresh object_info 列表；仍不见再重启该 worker。
