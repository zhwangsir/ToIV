# ComfyUI 工作流配方(API 格式)

## 文生图标准图(可直接用 run_workflow 提交,改 text/宽高/seed 即可)
```json
{
  "3": {"class_type": "KSampler", "inputs": {"seed": 12345, "steps": 20, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
  "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "DreamShaper_8_pruned.safetensors"}},
  "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
  "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cute corgi, cartoon, high quality", "clip": ["4", 1]}},
  "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry, lowres, deformed, watermark", "clip": ["4", 1]}},
  "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
  "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "ToIV", "images": ["8", 0]}}
}
```
要批量出图改 `EmptyLatentImage.batch_size`;换模型改 `ckpt_name`;换画幅改 width/height(SD1.5 推荐 512 的倍数,如 512×768)。

## 叠加 LoRA(在 model 链上插一个节点)
在 CheckpointLoaderSimple(4)之后、KSampler 之前插:
```json
"10": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["4", 0], "lora_name": "某lora.safetensors", "strength_model": 0.8}}
```
然后把 KSampler 的 `"model": ["4", 0]` 改成 `"model": ["10", 0]`。

## 图生图(img2img,需先有 input 图)
把 EmptyLatentImage 换成 LoadImage→VAEEncode,并把 KSampler 的 denoise 调到 0.4-0.8:
```json
"5": {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["4", 2]}},
"11": {"class_type": "LoadImage", "inputs": {"image": "输入图文件名.png"}}
```
KSampler 的 `denoise` 设 0.6 左右(越高改动越大),`latent_image` 接 `["5", 0]`。

## run_workflow 使用须知
- 只接收 API 格式(节点 id → {class_type, inputs}),不是 UI 导出的带 links 的格式。
- 所用模型文件名必须真实存在于某个 worker(可先用 list_models 查 checkpoint;不确定的节点/参数先 search_knowledge 查)。
- 产物按扩展名识别:png/jpg/webp=图(webp 可能是动图),mp4=视频,mp3/flac/wav=音频,glb/obj=3D。
- 适合"标准工具满足不了"的定制需求(指定 seed/批量/特定模型/特殊节点组合)。常规需求优先用 generate_image/generate_video/generate_music。
