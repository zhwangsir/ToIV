# NAS 模型选模清单（配置页）

来源：`docs/MODEL_SOURCES.json`（status=ok）派生，勿另造平行清单。

- NAS 根默认：`toiv/comfyui-models`（完整路径由 `TOIV_NAS_MODELS_ROOT` / 挂载决定）
- **H3**：仅 `h3[]`（11 条）→ 生产 worker **:8264**
- **main 出图**：用途含「出图」→ worker **:8196**（slice2；LB :8188）
- **main 出视频（非 H3）**：用途含「出视频」且 `rel_path` 不在 `h3/` → worker **:8197**（Wan/LongCat/VACE）；名含 `animate` → **:8199**（Wan Animate2）
- **对话**：不扫本清单 / 不扫 `LLM/` → Spark 别名 `deepseek-v4-flash-dspark`

换模：落盘后 refresh object_info 列表；仍不见再重启该 worker。
禁默认 :8195/:8205/:8261；不碰 cuda:3。

## 画布协议（slice Comfy）

- 生图渠道协议：`toiv-comfy-image` → `POST /api/generate/txt2img` → worker **:8196**（非 openai-images 占位）
- 出视频渠道协议：`toiv-comfy-video`
  - Wan `local-wan` → `POST /api/generate/txt2video` → **:8197**
  - LongCat `local-longcat` / 名含 longcat → `POST /api/longcat/t2v`（有图 → `/api/longcat/i2v`）→ **:8197**
  - VACE `local-vace` / 名含 vace → `POST /api/wan/vace` → **:8197**
  - Wan Animate `local-wan-animate` / 名含 animate → `POST /api/wan/animate2` → **:8199**
  - 延后：LongCat continue / Avatar；Wan Animate v1 `/api/wan/animate`
- H3 仍 `toiv-h3` → **:8264**；Spark 对话不变
