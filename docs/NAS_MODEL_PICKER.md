# NAS 模型选模清单（配置页）

来源：`docs/MODEL_SOURCES.json`（status=ok）派生，勿另造平行清单。

- NAS 根默认：`toiv/comfyui-models`（完整路径由 `TOIV_NAS_MODELS_ROOT` / 挂载决定）
- **H3**：仅 `h3[]`（11 条）→ 生产 worker **:8264**
- **main 出图**：用途含「出图」→ worker **:8196**（slice2；LB :8188）
- **main 出视频（非 H3）**：用途含「出视频」且 `rel_path` 不在 `h3/` → worker **:8197**（Wan/LongCat/VACE/Continue/Avatar）；名含 `animate` → **:8199**（Wan Animate2）
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
  - LongCat Continue `local-longcat-continue` / engine=continue → `POST /api/longcat/continue`（源视频产物 URL，不经 upload）→ **:8197**
  - LongCat Avatar `local-longcat-avatar` / engine=avatar → `POST /api/avatar/talk` → **:8197**
  - 延后：Wan Animate v1 `/api/wan/animate`
- H3 仍 `toiv-h3` → **:8264**；Spark 对话不变

## canvas-only 部署（必做）

`deploy/deploy.sh --canvas-only` 须同步本清单 `docs/NAS_MODEL_PICKER.json`，并在 `canvas-api.env` 设置 `TOIV_NAS_MODELS_ROOT=/mnt/toiv-nas/toiv/comfyui-models` 与 `TOIV_NAS_PICKER_PATH=<ToIV检出>/docs/NAS_MODEL_PICKER.json`。缺一则 Studio NAS 列表空。H3 产品默认：`minimax_h3_fl2va_pruned_int8_convrot` / `minimax_h3_ref2va_pruned_int8_convrot`；生图 `Qwen-Rapid-AIO-SFW-v11.safetensors`；对话 `deepseek-v4-flash-dspark`。
