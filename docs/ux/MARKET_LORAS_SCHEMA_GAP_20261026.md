# 出图 / Qwen 市场 `loras` 字段 · 2026-10-26

## 结论（出图 + edit 已接线）

| 引擎 / 应用族 | schema 是否有 `type=loras` | 说明 |
|---------------|---------------------------|------|
| MiniMax H3（`h3-*`） | **有** | `engine_registry._h3_loras_select` / `app_deep_knobs.h3_loras_param` |
| LTX（`ltx*`） | **有** | `_ltx_nsfw_loras_select` / `ltx_loras_param` |
| Wan NSFW 视频 | **有** | `_wan_nsfw_loras_select`（视频侧） |
| 本地出图（`txt2img` / `img2img` / `nsfw-*`） | **有** | `engine_registry._image_loras_select`；options 空 |
| 市场出图（`txt2img-basic` / `img2img-basic`） | **有** | `image_loras_param` + `apply_image_loras` |
| Qwen-Image-Edit（`qwen-image-edit`） | **有（本波）** | 证据：`apps/api/app/workflows/qwen_edit.py` 已用 `lora_chain`→`LoraLoader`（相机/Lightning）；市场 run 经 `apply_image_loras` 叠在链末端，并改写 `TextEncodeQwenImageEdit.clip` / `KSampler.model` |

前端：

- `marketAppSupportsLoras(appId)`：`h3-*` / `ltx*` / 上表出图 + **`qwen-image-edit`**
- `market-page`：`hasLorasParam` 为真才合并设置页钉选

## 提交链路

1. **经典 generate**：`POST /api/generate/txt2img|img2img` 的 `Txt2ImgRequest.loras` → Comfy 图
2. **市场 apps.run**：`apply_app_loras` → Checkpoint / nextgen / **edit LoraLoader 链**
3. **Forge 路径（本波）**：`forge.txt2img_payload(..., loras=)` 把结构化 loras 写成 prompt `<lora:NAME:W>`（A1111/Forge 原生）；`_submit_forge_txt2img` 传入 `req.loras`

## 本波未做 / 残留

- 出图 options 枚举 NAS（防发明文件名；仍空 options）
- 出图策划 AI 选配（null 对出图 = 不改图）
- `/api/generate/qwen-edit` 经典路由仍无 `loras` 字段（市场 schema / apps.run 已接；经典编辑靠相机内置 LoRA）
