# 动态分镜(Animatic)使用手册

> 功能上线:2026-07-30 · 后端 `POST /api/animatic` · 前端视图「动态分镜」(tools 组)
> 2026-07-30 升级:新增「AI 解析生成完整短剧」模式(`POST /api/drama/projects/from-image`)

## 两种模式

页面顶部切换:

- **AI 解析生成完整短剧**(默认):上传 1-9 张参考图/分镜图,VLM(Nemotron omni)
  解析图片内容并扩写成完整短剧,自动建短剧项目+分镜,随后后台自动跑完整管线
  (逐镜 LTX 视频 → IndexTTS2 配音 → ffmpeg 合成成片)。成功后点
  「前往短剧工作室查看生成进度」跳转,进度在项目过程时间线(step=autorun)实时可见。
- **快速拼接预览**:即下文原有的静帧串接 MP4,只验证节奏,不做 AI 生成。

## 这是什么(快速拼接预览)

**动态分镜(animatic)** 是影视/短剧前期制作的标准中间件:把一组静态分镜图(storyboard)
按每镜设定的时长串成一条带时间轴的 MP4,用于在正式生成视频之前——

- 验证叙事节奏与镜头时长分配;
- 给配音/配乐提供精确的对齐底稿;
- 低成本预览整部短剧的「骨架」。

ToIV 的实现全本地:图片上传后落在 NAS,ffmpeg 在 workstation(192.168.71.127)执行
(core 只跑应用层,不跑算力,见 AGENTS.md 第七节),成片回写 NAS,无需 GPU。

## 准备分镜图

从分镜表/分镜软件裁出每镜一张图:

- **命名建议**:按镜头号命名,如 `015.jpg` / `016.jpg` / `017.jpg`,便于回溯分镜表;
- **格式**:jpg / png / webp;
- **尺寸**:建议 1920×1080 以内,单张 ≤ 20MB;比例任意(见「常见问题」黑边说明);
- **数量**:1–20 张。

## 网页版使用步骤

1. 打开 ToIV 工作台,Dynamic Island 导航 → tools 组 → **动态分镜**(场记板图标);
2. 点击上传区,一次多选分镜图;选择后显示缩略图列表,**顺序即播放顺序**;
3. 每张图下方的时长输入框默认 **3.0 秒**(0.5–30),逐镜调整;
4. 需要调顺序时用每张卡片上的 **上移 / 下移** 小按钮;点 × 移除;
5. 底部设置 **帧率**(默认 24fps,12–60)与 **分辨率**(1080p / 720p);
6. 点 **生成动态分镜**,等待「上传并生成中…」完成;
7. 成功后页面下方出现播放器,直接在线播放成片。

顶栏角标实时显示「N / 20 镜 · 共 X.Xs」,方便控制总时长。

## API 用法(AI 解析生成完整短剧)

```bash
TOKEN=<登录 token>

curl -X POST http://192.168.71.47:8090/api/drama/projects/from-image \
  -H "Authorization: Bearer $TOKEN" \
  -F "images=@storyboard.jpg" \
  -F "hint=赛博朋克都市,赏金猎人追捕叛逃仿生人" \
  -F "num_shots=8" \
  -F "auto=true"
```

响应:

```json
{
  "project": {"id": "...", "title": "...", "premise": "..."},
  "shots": [{"id": "...", "idx": 0, "scene": "..."}],
  "autorun_task_id": "a1b2c3d4e5f6"
}
```

| 参数 | 默认 | 范围 | 说明 |
|------|------|------|------|
| `images` | 必填 | 1–9 张,单张 ≤ 20MB | jpg/png/webp;第 1 张会作为第 1 镜的 i2v 首帧 |
| `hint` | 空 | — | 用户故事方向(可选,VLM 据此扩写) |
| `style` | 空 | — | 整体风格 |
| `num_shots` | 8 | 4–16 | 分镜数量 |
| `width`/`height` | 1920×1080 | 宽 256–1920 / 高 256–1080 | 复用短剧项目约束 |
| `fps` | 16 | 4–30 | 短剧管线固定建议 16(LTX 原生帧率) |
| `auto` | true | — | 是否后台自动跑完整管线(视频→配音→合成) |

`auto=true` 时后台逐镜串行执行,进度写入项目 `process_data`(step=`autorun`,
status: pending/running/assembling/done/error),轮询 `GET /api/drama/projects/{pid}`
即可。单镜失败不中断整体;全部视频失败则不合成并标 error。成片回写
`project.video_url`(`/api/drama/output/drama-{hex}.mp4`)。

## API 用法(快速拼接预览)

```bash
TOKEN=<登录 token>

curl -X POST http://192.168.71.47:8090/api/animatic \
  -H "Authorization: Bearer $TOKEN" \
  -F "images=@015.jpg" \
  -F "images=@016.png" \
  -F "images=@017.jpg" \
  -F 'durations=[3.0, 2.5, 4.0]' \
  -F "fps=24" \
  -F "width=1920" -F "height=1080"
```

响应:

```json
{
  "job_id": "a1b2c3d4e5f6",
  "url": "/api/animatic/output/a1b2c3d4e5f6.mp4",
  "count": 3,
  "duration": 9.5,
  "fps": 24,
  "width": 1920,
  "height": 1080
}
```

下载成片(`<video>`/curl 无法带 header 时用 `?token=` 查询参数):

```bash
curl -OJ "http://192.168.71.47:8090/api/animatic/output/a1b2c3d4e5f6.mp4?token=$TOKEN"
```

## 参数说明

| 参数 | 默认 | 范围 | 说明 |
|------|------|------|------|
| `images` | 必填 | 1–20 张,单张 ≤ 20MB | jpg/png/webp,**上传顺序即播放顺序** |
| `durations` | 必填 | JSON 数组,与图片等长,每项 0.5–30 | 每镜时长(秒),支持小数 |
| `fps` | 24 | 12–60 | 输出帧率 |
| `width`/`height` | 1920×1080 | 256–4096 | 输出分辨率;奇数自动向下取偶(h264/yuv420p 要求) |

## 输出在哪

- 前端:生成成功后页内 `<video>` 播放器直接看;
- API:`GET /api/animatic/output/{job_id}.mp4`;
- NAS:`toiv/outputs/animatic/{job_id}.mp4`(core 视角 `/mnt/toiv-nas/...`,
  workstation 视角 `/home/merlin/nas_mount/...`);
- 上传的分镜原图保留在 `toiv/imports/animatic/{job_id}/001.jpg…`(按上传顺序编号)。

## 常见问题

- **图片比例不一致会怎样?**
  每镜先按比例缩放到输出尺寸以内(scale,不裁切),不足部分补黑边居中(pad)。
  竖屏图在 1080p 横屏输出下两侧会有黑边,属预期行为。
- **需要 GPU 吗?**
  不需要。静帧串接是纯 CPU ffmpeg 工作,在 workstation 执行,秒级完成。
- **为什么有数量/大小限制?**
  单图 ≤ 20MB、≤ 20 张是 v1 的保守上限,覆盖短剧单场景分镜规模;ffmpeg 单次
  执行超时上限 300 秒,超限返回 502。
- **上传失败 422?**
  检查:图片格式(jpg/png/webp)、张数(1–20)、durations 数量与图片一致、
  时长在 0.5–30 之间。文件名含 `..` 或路径分隔符会被拒绝(防穿越)。
- **502 ffmpeg 执行失败?**
  detail 里带 ffmpeg stderr 末尾 500 字符;常见原因是 NAS 挂载断开
  (workstation 侧 `/home/merlin/nas_mount` 不可写)。

## 后续规划

- **真动态**:✅ 2026-07-30 已由「AI 解析生成完整短剧」模式覆盖(逐镜 LTX i2v/t2v
  + 配音 + 合成成片,见上文);
- **配音轨(拼接预览)**:对齐译制管线的逐句配音,合成带对白的完整 animatic;
- **自动 lipsync**:autorun 当前止步于配音+合成,后续可自动接 LatentSync 对口型;
- **拖拽排序**:v1 用上移/下移按钮,后续换拖拽;
- **分镜表直导**:直接从短剧工作室分镜表一键生成 animatic,免手动裁图。
