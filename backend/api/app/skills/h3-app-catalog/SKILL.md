---
name: h3-app-catalog
description: MiniMax H3 市场应用速查。用户要做 H3 视频、文生视频、图生视频、首尾帧、多参考、15 秒加速或声音克隆时使用;优先 list_apps / run_app,不要先 submit_generation。
kind: template
triggers: [MiniMax H3, H3视频, 海螺, 文生视频, 图生视频, 首尾帧, 多参考, Ref2VA, 15秒加速]
inputs: {}
outputs: ["选中的 H3 应用 id 与必填参数"]
version: 1.0.0
author: dgmt
---

# H3 市场应用目录(优先 run_app)

用户面向的 H3/视频任务:**先 `list_apps(category=video)` 再 `run_app`**。`submit_generation(engine_id=h3-*)` 只是进阶兜底。

提示词质量规则见技能 **h3-prompt-writer**(此处不重复展开):只写一个运镜;负向约束折进正文(全正向);i2v 描述相对首帧的运动,不要重画第一帧。

## 核心四件套

| id | 场景 | 必填 |
| --- | --- | --- |
| `h3-t2v` | 文生视频。场景+对白+音频一段提示词,默认约 5s(124 帧@24fps)、20 步 | `positive` |
| `h3-i2v` | 图生视频。上传首帧后续写动作/对白 | `images`(1 张)、`positive` |
| `h3-fl2v` | 首尾帧转场。第 1 张=首帧、第 2 张=尾帧,两图之间插值。**不是** 9 参考 | `images`、`last_frame`、`positive` |
| `h3-r2v` | 全能参考 Ref2VA。1-9 图、0-3 视频、0-3 音频(至少一种)。提示词用 1-based 标签 `<Picture 1>` / `<Video 1>` / `<Audio 1>` | `images`(可与视频/音频组合)、`positive` |

R18 孪生:`h3-nsfw-t2v` / `h3-nsfw-i2v` / `h3-nsfw-fl2v` / `h3-nsfw-r2v`(仅 `/nsfw` 专区,`list_apps` 自动隐藏)。

## 8 步加速预设(已存在,优先于手改 steps)

同一张核心图,只把默认改成 362 帧≈15s、8 步,降低学习成本:

- `h3-t2v-15s-fast` / `h3-i2v-15s-fast`(须首帧)
- R18:`h3-nsfw-t2v-15s-fast` / `h3-nsfw-i2v-15s-fast`

不要伪造「20 秒一镜到底」应用:H3 原生单段上限 15s,更长是末帧 i2v 分段续写。

## 声音参考

- `h3-r2v-voice`(及 `h3-nsfw-r2v-voice`):Ref2VA 声音克隆,**必须配图或视频,不能纯音频**;提示词 `<Audio 1>`。

## 填值备忘

- 画幅默认 1344×768(横),竖屏 768×1344;宽高 32 对齐。
- `length` 走 17k+5 网格(124≈5.2s,362≈15s)。
- 跑应用前用 `optimize_prompt(kind=video, engine=h3-t2v|h3-i2v|…)`。
- 媒体槽填本轮上传文件名;用户已上传图时 `run_app` 会回填缺省 `images`。

## RunningHub 社区预制(约 1166)

搜索页 H3 卡已按能力落到同一套核心图上,id 以 `rh-` 开头:
文生/图生/首尾帧/全能参考/声音/换人(wan-animate-2)/洗视频(r2v 视频槽)/时间静止(i2v 提示词前缀)/场景预制。
**不要**一次 `list_apps` 把它们全列出来;用 `q` 搜用户说的场景名。
单段上限 15s;标了 20s/一分钟的卡会在简介里写明需首尾帧接片。
原生分辨率约 1344×768,不是 928P。
