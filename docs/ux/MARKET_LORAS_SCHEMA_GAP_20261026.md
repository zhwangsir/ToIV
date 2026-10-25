# 出图 / Qwen 市场 `loras` 字段 · 2026-10-26

## 结论（已接线出图；edit 仍未接）

| 引擎 / 应用族 | schema 是否有 `type=loras` | 说明 |
|---------------|---------------------------|------|
| MiniMax H3（`h3-*`） | **有** | `engine_registry._h3_loras_select` / `app_deep_knobs.h3_loras_param` |
| LTX（`ltx*`） | **有** | `_ltx_nsfw_loras_select` / `ltx_loras_param` |
| Wan NSFW 视频 | **有** | `_wan_nsfw_loras_select`（视频侧） |
| 本地出图（`txt2img` / `img2img` / `nsfw-txt2img` / `nsfw-img2img`） | **有（本波）** | `engine_registry._image_loras_select`；options 空，不发明文件名 |
| 市场出图（`txt2img-basic` / `img2img-basic`） | **有（本波）** | `app_deep_knobs.image_loras_param` + `apply_image_loras`（Checkpoint / nextgen UNET） |
| Qwen-Image-Edit（`qwen-image-edit`） | **无** | 编辑专用参数，未确认 LoraLoader；**本波仍不硬加** |

前端：

- `marketAppSupportsLoras(appId)`：`h3-*` / `ltx*` / 上表出图 app_id；**edit = false**
- `market-page`：`hasLorasParam` 为真才合并设置页钉选；edit 仍只校验、不假装注入
- `ensureMarketLorasParam` / `enrichMarketSchemaWithDeepParams` 对出图补参数壳

## 提交链路

1. **经典 generate**：`POST /api/generate/txt2img|img2img` 的 `Txt2ImgRequest.loras` → `build_txt2img_graph` / nextgen（已吃）
2. **市场 apps.run**：`apply_app_loras` → Checkpoint `LoraLoader` 链或 nextgen UNET+CLIP 链
3. **Forge 路径**：经典 generate 认 `weight`；市场表单认 `strength`（`parse_loras_value` 映射）。Forge/A1111 标签 `<lora:NAME:W>` 仍由 `parse_lora_tags` 剥离并入；**市场钉选不经 Forge UI**

## 本波未做

- `qwen-image-edit` schema / 注入
- 出图 options 枚举 NAS（防发明文件名）
- 出图策划 AI 选配（null 对出图 = 不改图）
