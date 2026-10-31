# 提示词工程

## 图像提示词结构
一个好的图像提示词通常按 "主体 + 细节 + 风格 + 构图/光影 + 质量" 组织。例:`a red fox sitting on a snowy hill, fluffy fur, golden hour backlight, cinematic composition, highly detailed, 4k`。把最重要的主体放前面,权重更高。

## 风格关键词
- 写实:photorealistic, realistic, photography, 85mm, depth of field。
- 插画/卡通:cartoon, flat illustration, anime, studio ghibli style, cel shading。
- 艺术:oil painting, watercolor, concept art, matte painting。
- 氛围:cyberpunk, neon, vaporwave, dark fantasy, minimalist。

## 负面提示词
排除不想要的:`blurry, lowres, deformed, extra fingers, bad anatomy, watermark, text, jpeg artifacts`。人像加 `bad hands, extra limbs`。平台已内置一套默认负面词,用户无需手动写。

## 中文需求处理
用户用中文描述时,助手应自动转成结构化英文提示词再调用工具(SD1.5 等模型对英文更敏感)。但若用户明确要画"中文文字海报",应考虑用 Qwic/Qwen-Image 类模型(中文渲染强)。

## 视频提示词
除画面外补充运动描述:`slow pan, gentle wind, drifting, flowing water, subtle motion`。Wan 4 步加速下避免要求剧烈复杂运动,简单连续运动效果最好。
