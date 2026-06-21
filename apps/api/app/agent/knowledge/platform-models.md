# ToIV 平台已装模型

## 图像大模型(checkpoint)
- `DreamShaper_8_pruned.safetensors`:SD1.5 通用,平台默认出图模型,泛用、稳。
- GhostMix V2、majicMIX realistic v7:SD1.5,majicMIX 偏写实人像。
- v1-5 基础模型:SD1.5 原版。
- Qwen-Image(fp8):新架构,中文文字渲染能力强,适合带中文字的海报。
- Flux.2 Klein 4B、Z-Image Turbo:新架构,Z-Image Turbo 出图极快。
平台文生图默认用 DreamShaper_8;英文提示词效果最好。

## 视频模型
- Wan 2.2 图生视频(i2v)14B:high/low noise 双扩散 + lightx2v 4 步加速 LoRA,640×480、约 3 秒/49 帧、16fps,输出 animated webp。ToIV 的"文生视频"是先文生底图再用 Wan 驱动其运动。

## 3D 模型
- Hunyuan3D DiT v2.0(`hunyuan3d-dit-v2-0-fp16.safetensors`):图生 3D,输入一张图,输出 3D 网格(glb)。

## 音频模型
- ACE-Step v1 3.5B(`ace_step_v1_3.5b.safetensors`):文生音乐,输入风格标签(可选歌词),输出 mp3(44.1kHz 立体声)。

## 辅助
- ControlNet:Qwen-Image InstantX Union(构图控制)。
- 深度:lotus-depth。
- LoRA:lightx2v 4 步加速(视频提速)。
- 部分 checkpoint/LoRA 为成人内容(NSFW),按需使用。
