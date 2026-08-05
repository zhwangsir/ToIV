# ToIV 三大板块 + 融合应用 · 信息架构规划

> 2026-08-04 定稿。依据用户指令:音频/视频/图片三大板块各自独立成板块,
> 每板块含「生成 + 编辑」,生成提示词均可选 AI 优化;数字人/AI 短剧类归入融合应用区。
> 风格与组件纪律沿用 2026-08-03-ui-redesign-plan.md(Obsidian 深曜 + 8 入口 IA 演化)。

## 一、现状盘点(重构前)

| 能力 | 后端 | 前端 | 缺口 |
|---|---|---|---|
| 文生图 txt2img | ✅ 引擎注册表 | ✅ 统一生成工作台 | 提示词优化按钮未接入工作台 |
| 图生图 img2img | ✅ 引擎注册表 | ✅ 统一生成工作台 | 同上;编辑类只有重绘一种 |
| LTX2 t2v/i2v | ✅ 引擎注册表 | ✅ 统一生成工作台 | 同上 |
| H3 t2v/i2v | ✅ 引擎注册表 | ✅ 统一生成工作台 | 同上 |
| ACE-Step 文生音乐 | ✅ `POST /api/generate/audio` | ❌ 无入口 | 未注册引擎、无 UI |
| TTS 配音(IndexTTS2) | ✅ `POST /api/manju/voice`(含参考音克隆) | 仅漫剧内嵌 | 无独立入口 |
| ASR 听写(faster-whisper/AI-Omni) | ✅ `POST /api/dub/transcribe` | 仅译制内嵌 | 无独立入口 |
| 人声分离(Demucs) | ✅ services 内 `_separate_vocals`(译制前置内部调用) | ❌ | 无独立端点 |
| 提示词 AI 优化 | ✅ `POST /api/optimize`(image/image_edit/video/audio/threed 全 kind + 模型族方言 + 智能体 + LLM 分层) | ✅ OptimizeButton 组件 | **未接入生成工作台**,只在旧视图用 |
| AI 短剧/动态分镜 | ✅ drama_studio/animatic | ✅ | 散落一级导航 |
| 数字人 | ✅ avatartalk/liveact | ✅ | 散落一级导航 |
| 译制 | ✅ dub | ✅ | 散落一级导航 |

## 二、目标 IA:9 个一级入口

| # | 入口 | 承载 | 说明 |
|---|---|---|---|
| 1 | **对话** | AI 助手(agent + RAG) | 不变 |
| 2 | **图片** | 生成(文生图)+ 编辑(图生图/重绘) | 由原「生成」图像模式独立;提示词 AI 优化(kind=image/image_edit) |
| 3 | **视频** | 生成(LTX2/H3 文生视频)+ 编辑(图生视频 + 放大/补帧后处理) | 由原「生成」视频模式独立;提示词 AI 优化(kind=video) |
| 4 | **音频** | 生成(ACE 音乐 / TTS 配音)+ 编辑(ASR 听写 / 人声分离) | **新板块**;提示词 AI 优化(kind=audio) |
| 5 | **融合** | AI 短剧(含动态分镜)/ 数字人 / 译制 / 漫剧 | 聚合页:卡片式入口 + 各子应用内嵌(不重写子应用) |
| 6 | **画布** | 节点编排 | 不变 |
| 7 | **作品库** | 全部产物统一浏览(含音频产物类型) | 不变 + 补音频 |
| 8 | **资源** | 模型库/训练/看板/管理(二级 tab) | 不变 |
| 9 | **管理**(仅 admin) | 同现状,资源区二级 | 不变 |

> 「生成」旧入口退役:`/?view=generate` 按 kind 重定向到 图片/视频(LEGACY_VIEW_REDIRECTS 机制沿用,旧链接不 404)。

## 三、板块内部结构

### 3.1 图片板块(image)

```
┌ 模式段控:生成 | 编辑
├ 生成 = 引擎 txt2img(现有注册表项)
├ 编辑 = 引擎 img2img(现有注册表项)
├ 提示词区:Textarea + OptimizeButton(kind=image / image_edit,带模型族方言)
└ 参数/结果区:复用统一工作台引擎驱动渲染
```

后续扩展位:inpaint(蒙版重绘)、upscale(高清放大)——注册表加条目即接入,不开新视图。

### 3.2 视频板块(video)

```
┌ 模式段控:生成 | 编辑
├ 生成 = 引擎 ltx2-t2v / h3-t2v
├ 编辑 = 引擎 ltx2-i2v / h3-i2v(i2v 即"以图为首帧的视频编辑"第一层)
├ 提示词区:Textarea + OptimizeButton(kind=video)
└ 后处理开关已在引擎参数内(use_upscale / use_rife)
```

### 3.3 音频板块(audio)—— 新

```
┌ 模式段控:生成 | 编辑
├ 生成:
│   ├ ACE 文生音乐 → 注册进引擎表 kind="audio"(tags/lyrics/seconds/steps/cfg/seed)
│   └ TTS 配音 → 独立工具卡(文本 + 音色/参考音 → wav;复用 /api/manju/voice 契约)
├ 编辑:
│   ├ ASR 听写 → 工具卡(上传音频 → 转写文本;复用 whisper 链路)
│   └ 人声分离 → 工具卡(上传音频 → vocals wav;新增独立端点 /api/audio/separate)
├ 提示词区(音乐生成):Textarea + OptimizeButton(kind=audio)
└ 结果区:音频播放器 + 历史列表(产物落 NAS outputs/audio/)
```

### 3.4 融合应用区(fusion)

聚合页(不重写子应用):四张应用卡 + 状态点。
- AI 短剧 → 内嵌 DramaStudioView(含动态分镜页签)
- 数字人 → 内嵌 AvatarTalkView
- 译制 → 内嵌 DubView
- 漫剧 → 内嵌 Manju 入口(并入短剧或独立卡,按现有 manju 集成方式)

## 四、技术方案

1. **EngineKind 扩展**:`"image" | "video" | "audio"`(前端 lib/engines.ts + 后端注册表 kind 字段)。
2. **引擎注册表加音频引擎**:`ace-music`(kind=audio,params: lyrics/seconds/steps/cfg/seed;probe=pool.pick(ACE ckpt))。提交路由:`/api/generate/audio` 已存在,lib/engines.submitEngineGeneration 加分支。
3. **工作台泛化**:GenerateView 接受 `lockedKind` prop(图片/视频板块=锁定 kind 并隐藏模式段控;音频板块=kind=audio + 工具卡区)。三板块共用同一引擎驱动工作台,**不为板块各写一套参数渲染**。
4. **提示词 AI 优化贯通**:工作台提示词 Field 旁固定挂 OptimizeButton;
   kind 映射:txt2img→image、img2img→image_edit、*t2v/i2v→video、ace-music→audio;
   图像类把当前 checkpoint 传 model 参数吃模型族方言。优化结果回填 positive(+negative)。
5. **音频工具端点**:
   - TTS:复用现有 `/api/manju/voice`(契约已支持参考音克隆),前端工具卡直调。
   - ASR:复用 `/api/dub/transcribe` 后台作业链路。
   - 人声分离:新增 `POST /api/audio/separate`(multipart → 调 TOIV_AUDIO_SEP_URL Demucs → 返回 vocals wav 落 NAS),从 dub_voice._separate_vocals 提炼公共服务。
6. **产物落 NAS**:音频产物目录 `toiv/outputs/audio/`(AGENTS.md 已预留),复用 `_drama_root()` 降级模式加 `TOIV_AUDIO_DIR`。
7. **导航**:SIDEBAR_ITEMS 改 8 项(对话/图片/视频/音频/融合/画布/作品库/资源);BottomNav 主入口同步。`view=generate` 旧链接重定向 image。

## 五、里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 板块拆分 + 优化贯通 | EngineKind + audio;工作台泛化 lockedKind;三板块导航;OptimizeButton 接入工作台(全 kind);ACE 音乐引擎注册 + 提交链路 | pytest + tsc + build;三板块各生成一次真实产物 |
| M2 音频工具区 | TTS/ASR/人声分离工具卡 + separate 独立端点 + NAS 音频目录 | separate 端点单测;音频三工具真实产物 |
| M3 融合应用区 | 聚合页 + 四子应用内嵌/跳转 | 四卡可达,子应用功能回归 |
| M4 回归部署 | 全量 pytest/tsc/build + E2E + 部署 core + STATE/TEST_LOG | E2E 全绿 |

## 六、稳定性与质量纪律

- 所有新端点:路径沙箱校验、超时、降级(NAS 不可达 → 本地回退;分离服务不可达 → 503 清晰原因)。
- 引擎不可用 → 注册表 available=false + 原因,前端禁用而非报错。
- 提示词优化失败 → LLM 降级链(L3→L2→L1)+ 启发式兜底,不阻断生成。
- 每里程碑:pytest(新增端点/服务必有单测)+ `npx tsc --noEmit` + `npm run build` 三绿后才进下一里程碑。
