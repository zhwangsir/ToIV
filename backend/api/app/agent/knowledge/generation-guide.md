# 生成能力使用指南

## 文生图(generate_image)
描述画面即可。建议提示词包含:主体、风格(如 cartoon / photorealistic / oil painting / cyberpunk)、光影(soft lighting / cinematic)、质量词(high quality, detailed, 4k)。画幅 aspect 可选 1:1 / 2:3(竖) / 3:2(横) / hd,默认 1:1。步数 steps 默认 20,够用;追求质量可到 30。英文提示词效果最佳,中文需求会自动翻译优化。

## 文生视频(generate_video)
让画面"动起来"。内部链式:先文生一张底图,再用 Wan 2.2 驱动运动。耗时约 1-2 分钟(Wan 14B 较慢)。参数 seconds 默认 3,范围 1-6 秒。提示词描述画面+运动趋势(如 "petals falling gently in the wind, slow motion")。输出是循环动图(webp)。

## 文生音乐(generate_music)
输入风格标签 tags(流派/乐器/节奏/情绪,如 "lofi, chill, piano, 90bpm")。可选歌词 lyrics(留空=纯音乐)。时长 seconds 默认 30。输出 mp3。

## 图生3D / 图生图(规划中,聊天内暂未开放)
平台 Web 端已有"3D""图像-图生图"模块,但 AI 助手对话内的图生3D / 图生图工具仍在接入(需要在聊天里上传/承接图片)。当前对话内可用:文生图、文生视频、文生音乐、查模型、搜知识、跑自定义工作流。

## 参数建议
- SD1.5 模型:cfg 7、sampler euler、scheduler normal 是稳妥默认。
- 重绘强度(img2img denoise):0.4 轻改、0.6 中等、0.8 大改。
- 出图慢或排队:平台会自动选最空闲且具备所需模型的 worker。
