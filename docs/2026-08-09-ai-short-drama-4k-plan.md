# AI 短剧自动生成 + 4K 画质生成实施计划

> **计划状态**: Plan Mode 待审批  
> **创建时间**: 2026-08-09  
> **默认决策**（因用户跳过澄清）:
> 1. 4K 路径采用「先生成低分辨率视频，再超分到 4K」。
> 2. AI 短剧自动化与 4K 画质测试并行推进。

---

## 1. Summary

在现有 ToIV 集群基础上，实现：
1. **AI 短剧自动生成 V2**：用户导入小说/长文本后，系统自动完成「小说→剧本→分镜→角色定妆→视频片段→配音→剪辑成片」全流程，中间保留人工+视觉监控质量节点。
2. **4K 画质生成链路**：利用现有 H3 / LongCat / LTX 引擎先生成高画质但非 4K 的片段，再通过视频超分/增强链路输出 3840×2160 成片。

---

## 2. Current State Analysis

### 2.1 现有视频生成引擎上限（真机已确认）

| 引擎 | 最大分辨率 | 最大时长 | 当前 API | 位置 |
|------|-----------|---------|---------|------|
| MiniMax H3 | 1344×768（32 对齐） | 362 帧 ≈15s @24fps | `POST /api/h3/t2v` / `i2v` | workstation :8195 |
| LongCat-Video | 1280×1280（16 对齐） | 961 帧 ≈60s @16fps | `POST /api/longcat/t2v` / `i2v` / `continue` | workstation :8197 |
| LTX2.3 | 768×384 原生，可 2× 上采样到 1536×768 | 97 帧 ≈6s @16fps | `POST /api/generate/ltx-*` | WorkerPool |

**结论**：当前没有任何本地引擎支持原生 4K 视频生成。4K 必须通过「低分辨率生成 + 后处理超分」实现。

### 2.2 已有短剧基础

- `drama/scripts/generate_v1.py`：已实现 LTX t2v → 裁剪 → TTS → ffmpeg 拼接 + 字幕的最小闭环。
- `drama/scripts/config.py`：含 16 镜分镜配置、角色视觉 token、旁白台词。
- `drama/output/ai_pipeline_design.md`：V1 技术管线设计文档，角色一致性方案、镜头规划、配音方案均已设计。
- LLM 长文本能力：spark02 `qwen3.6-uncensored` 32K 窗口，大海捞针 100% 召回，可承担小说→剧本任务。

### 2.3 缺失能力

1. **4K 超分链路**：没有现成 ComfyUI 视频超分工作流或脚本，需要调研/验证可用方案。
2. **小说→剧本→分镜自动化**：当前分镜和台词是硬编码的 `config.py`，缺少 LLM 驱动的解析。
3. **角色一致性与定妆关键帧**：V1 用 LTX t2v 直出，角色脸会漂移；需要用 FLUX 关键帧 + IPAdapter/LoRA 锚定。
4. **质量监控节点**：缺少 VLM/规则化自动质检与人工审核点。

---

## 3. Goals & Scope

### 3.1 目标

- **M1（4K 链路）**：跑通一条从 H3 1344×768 或 LongCat 1280×720 生成 → 4K 超分的完整链路，输出可播放的 3840×2160 MP4，并记录耗时/显存/质量。
- **M2（文本→分镜）**：实现 2000 字小说输入 → 结构化分镜脚本（JSON），含镜头描述、台词、角色、时长。
- **M3（角色一致性）**：为短剧主要角色生成定妆关键帧，并在视频生成时通过 i2v 首帧锁死外貌。
- **M4（完整管线）**：将 M1–M3 串成 `drama/scripts/generate_v2.py`，实现「小说导入 → 分镜 → 关键帧 → 视频 → 配音 → 4K 超分 → 成片」全自动流程。

### 3.2 不在本次范围

- 训练新的角色 LoRA（若需要，单独立项）。
- 购买/部署外部商用 4K 模型（如可灵、Sora）。
- 重新设计前端 UI（本次只产出后端管线和脚本）。

---

## 4. Milestones & Implementation Steps

### M1: 4K 超分链路真机验证

#### M1.1 调研可用 4K 超分方案

- **候选 A：Real-ESRGAN 视频版 / ESRGAN 帧级超分**
  - 复用现有 `apps/api/app/workflows/upscale.py` 的图片超分能力，对视频逐帧 upscale。
  - 模型：`RealESRGAN_x2plus.pth`（已在 worker），或 `4x-UltraSharp.pth`。
  - 路径：将 H3/LongCat 输出视频抽帧 → 逐帧 4× 超分 → 重新编码为 4K 视频。
  - 优点：显存可控，已有模型。
  - 缺点：时序一致性一般，可能有闪烁。

- **候选 B：LTXVLatentUpsampler（latent 2× 上采样）**
  - LTX 已内置 `LTXVLatentUpsampler`，`ltx_video.py` 的 `_append_postprocess` 已使用图片版 `ImageUpscaleWithModel`。
  - 对 H3/LongCat 无效（不是 LTX  latent）。

- **候选 C：Topaz Video AI / ffmpeg AI 滤镜（外部工具）**
  - 不作为主链路，可作为备选/人工精修。

**默认决策**：先用候选 A（帧级 Real-ESRGAN）跑通，同时评估时序稳定性；若闪烁严重，再调研时序一致的视频超分（如 BasicVSR++、VideoSR）。

#### M1.2 实现 4K 超分测试脚本

创建 `scripts/video_4k_upscale.py`：

```python
# 主要功能
1. 输入：H3/LongCat/LTX 生成的 MP4 路径
2. ffmpeg 抽帧到临时目录（PNG）
3. 调用 ComfyUI UpscaleModelLoader + ImageUpscaleWithModel 逐帧 4× 超分
   - 1344×768 → 5376×3072，再 lanczos 缩放到 3840×2160
   - 或 1280×720 → 5120×2880，再缩放到 3840×2160
4. ffmpeg 将超分后帧序列重新编码为 4K MP4（H.264/HEVC，CRF 18）
5. 输出：耗时、峰值显存、输出文件大小、ffprobe 元数据
```

#### M1.3 真机测试

- 测试源视频：
  - H3: 1344×768 @24fps，124 帧与 362 帧各 1 条
  - LongCat: 832×480 @16fps，121 帧与 961 帧各 1 条
- 记录：
  - 超分 1 帧耗时、整片耗时
  - GPU 显存峰值
  - 输出画质（主观 + VLM 评分）
- 产物：
  - `/tmp/4k_upscale_report.md`
  - 更新 `TEST_LOG.md` 与 `STATE.json`

### M2: 小说 → 剧本 → 分镜自动化

#### M2.1 LLM 提示工程

- 模型：`spark02:8000` 的 `qwen3.6-35b-a3b-uncensored-heretic`（32K 窗口）。
- 输入：用户上传的小说文本（2000 字起步）。
- 输出格式：结构化 JSON，包含：
  - `title`: 短剧标题
  - `characters`: 角色列表（名称、外貌描述、音色标签）
  - `shots`: 分镜数组
    - `id`, `act`, `duration`, `type`(scene/action/dialogue), `description`, `prompt`(英文视觉描述), `motion_prompt`(英文动作描述), `characters`[], `dialogue`{speaker, text}
  - `narration`: 旁白/对白时间轴

#### M2.2 实现小说解析服务/脚本

创建 `drama/scripts/novel_to_storyboard.py`：

```python
async def novel_to_storyboard(novel_text: str, max_shots: int = 20) -> dict:
    """调用 spark02 LLM 将小说文本转换为结构化分镜。"""
    ...
```

- 支持超长文本自动分段（按 2000 字/段）。
- 输出保存为 `drama/output/storyboard_<timestamp>.json`。

#### M2.3 与现有 config.py 兼容

- 将硬编码的 `SHOTS` / `NARRATION` 改为从 JSON 分镜文件加载。
- `config.py` 保留默认示例数据作为 fallback。

### M3: 角色一致性与关键帧生成

#### M3.1 角色定妆关键帧

- 使用 FLUX.2 dev（通过 `apps/api/app/workflows/txt2img.py` 或 `/api/generate/images`）为每个角色生成：
  - 正面肖像 `portrait_front.png`
  - 3/4 侧面 `portrait_34.png`
  - 标志性动作 `action_pose.png`
- 保存到 `drama/output/characters/<role>/`。

#### M3.2 首帧锁死视频生成

- 对每个动作/对战镜头：
  1. 用 FLUX 生成该镜头关键帧（含角色描述 + 场景描述）。
  2. 上传到 pool worker（`/api/upload`）。
  3. 调用 H3 i2v 或 LongCat i2v，以关键帧为首帧生成视频。
- 这样避免文生视频随机换脸，保证角色外貌一致。

#### M3.3 一致性加固（可选 P1）

- 若 worker 已安装 IPAdapter 节点，在 FLUX 工作流中挂载 `IPAdapterAdvanced`，用定妆图生成 face embedding，权重 0.6–0.8。
- 若未来训练角色 LoRA，可直接在 `txt2img` 的 `LoraSpec` 中挂载。

### M4: 完整短剧自动化管线集成

#### M4.1 创建 `drama/scripts/generate_v2.py`

主控流程：

```python
async def main(novel_path: Path, output_dir: Path, target_4k: bool = False):
    # 1. 小说 → 分镜
    storyboard = await novel_to_storyboard(novel_path.read_text())
    save_storyboard(storyboard, output_dir)

    # 2. 角色定妆
    for char in storyboard["characters"]:
        await generate_character_keyframes(char, output_dir)

    # 3. 逐镜生成
    for shot in storyboard["shots"]:
        keyframe = await generate_keyframe(shot, output_dir)
        video = await generate_video_i2v(shot, keyframe, output_dir)
        if target_4k:
            video = await upscale_to_4k(video, output_dir)
        shot["video_file"] = str(video)

    # 4. 配音
    voice_urls = await synthesize_voices(storyboard["narration"])
    voice_track = await build_voice_track(voice_urls, storyboard["narration"])

    # 5. 剪辑成片
    final = await assemble_final(storyboard, voice_track, output_dir)
    return final
```

#### M4.2 质量监控节点

在每个生成阶段后自动验证，失败则重跑或人工标记：

| 阶段 | 检查项 | 工具 | 失败处理 |
|------|-------|------|---------|
| 分镜 JSON | 字段完整、镜头数合理 | Pydantic schema | 返回 LLM 重生成 |
| 关键帧 | 非空、尺寸 ≥1024、无全黑 | PIL + ffprobe | 重跑 1 次，换 seed |
| 视频片段 | 存在、可播放、帧数符合 | ffprobe | 重跑，降低 motion prompt |
| 4K 超分 | 输出 3840×2160、可播放 | ffprobe | 回退到 1080p 成片 |
| 配音 | WAV 头、24kHz、时长 >0 | wave + ffprobe | 重跑，退默认音色 |
| 成片 | 时长符合、无黑帧、音画同步 | ffprobe + VLM 抽检 | 定位问题镜重跑 |

#### M4.3 人工+视觉监控界面

- 每镜生成后输出 `drama/output/<project>/review.json`，包含：
  - 镜头缩略图路径
  - 视频路径
  - VLM 评分（若启用 `/api/score/video`）
  - 人工审核状态（`pending`/`approved`/`rejected`）
- 只有全部镜头 `approved` 后才进入最终剪辑。

---

## 5. Files to Create / Modify

### 新建文件

| 文件 | 说明 |
|------|------|
| `scripts/video_4k_upscale.py` | 4K 超分测试脚本：抽帧 → ComfyUI 超分 → 编码 |
| `drama/scripts/novel_to_storyboard.py` | 小说 → 结构化分镜 JSON |
| `drama/scripts/generate_v2.py` | 短剧自动化 V2 主控脚本 |
| `drama/output/characters/.gitkeep` | 角色定妆输出目录占位 |
| `drama/output/projects/.gitkeep` | 项目输出目录占位 |
| `docs/2026-08-09-ai-short-drama-4k-plan.md` | 本计划副本（便于非 Plan Mode 查阅） |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `drama/scripts/config.py` | 支持从 JSON 加载分镜；保留默认示例 |
| `drama/scripts/generate_v1.py` | 标记为 deprecated，或在 v2 中复用其 ffmpeg 工具函数 |
| `apps/api/app/workflows/upscale.py` | 若需要，暴露批量视频帧超分的辅助函数 |
| `TEST_LOG.md` | 记录 4K 超分测试结果与短剧 V2 冒烟结果 |
| `STATE.json` | 新增 M1–M4 里程碑条目 |
| `AGENTS.md` | 若发现新的硬件/服务约束，追加易错点 |

---

## 6. Assumptions & Decisions

| # | 决策 | 理由 |
|---|------|------|
| 1 | 4K 走「低分辨率生成 + 帧级超分」 | 当前本地引擎均不支持原生 4K |
| 2 | 视频超分先用 Real-ESRGAN/UltraSharp 帧级方案 | 已有模型、显存可控、最快跑通 |
| 3 | 短剧视频生成优先用 H3 i2v / LongCat i2v | H3 画质上限更高；LongCat 时长更长；i2v 可锁首帧 |
| 4 | 角色一致性先用 FLUX 关键帧 + i2v 首帧锁死 | 不依赖未训练的 LoRA，立即可行 |
| 5 | 小说解析用 spark02 qwen3.6-uncensored | 32K 窗口已验证大海捞针 100%，可处理 2000 字输入 |
| 6 | 质量监控加入 VLM 抽检 + 人工审核门 | 避免全自动产出低质量内容 |

---

## 7. Risk & Mitigation

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 帧级超分出现时序闪烁 | 4K 成片质量差 | 优先用 H3/LongCat 原片本身时序稳定；超分后用 VLM 抽检闪烁；严重时调研 VideoSR |
| 4K 超分耗时过长 | 单镜头 30s 视频超分可能需数十分钟 | 先测 1–2 个片段评估；可改为仅对成片超分，不对每个片段超分 |
| H3 长帧数温度熔断 | 5 分钟长视频无法单条生成 | 用 LongCat continue-video 分段生成；H3 用于高质量短镜头 |
| 小说→分镜 JSON 格式不稳定 | 解析失败 | 用 Pydantic + LLM retry + 少样本示例 prompt |
| 角色脸仍漂移 | 一致性不足 | 启用 IPAdapter；为关键角色训练 LoRA（后续迭代） |

---

## 8. Verification Steps

### M1 验证

- [ ] `scripts/video_4k_upscale.py` 能在本地/Workstation 成功运行。
- [ ] 输出文件 `ffprobe` 显示 `width=3840 height=2160`。
- [ ] 记录超分前后耗时、GPU 显存峰值到 `TEST_LOG.md`。
- [ ] 人工或 VLM 抽检 4K 成片，确认无明显闪烁/崩坏。

### M2 验证

- [ ] 输入 2000 字测试小说，`novel_to_storyboard.py` 输出合法 JSON。
- [ ] JSON 中包含 ≥10 个镜头、角色列表、台词时间轴。
- [ ] 分镜 prompt 可直接用于后续关键帧生成。

### M3 验证

- [ ] 为主要角色生成 3 张定妆关键帧。
- [ ] 用其中一张作为首帧，H3/LongCat i2v 生成视频，角色外貌与关键帧一致。

### M4 验证

- [ ] `generate_v2.py` 端到端跑通一个短剧项目（从小说到成片）。
- [ ] 成片时长与分镜总时长一致。
- [ ] 音画同步，字幕时间轴正确。
- [ ] 若开启 4K，成片分辨率为 3840×2160。

---

## 9. 里程碑时间线（估算）

| 里程碑 | 预计耗时 | 优先级 |
|--------|---------|--------|
| M1 4K 超分链路验证 | 1 天 | P0 |
| M2 小说→分镜自动化 | 0.5 天 | P0 |
| M3 角色一致性关键帧 | 0.5 天 | P1 |
| M4 完整管线集成 | 1 天 | P0 |
| 全量回归 + 文档更新 | 0.5 天 | P0 |

**总计约 3–4 天**（含真机验证与调参）。

---

## 10. 下一步行动

等待用户确认本计划后，立即执行：
1. 创建 M1 测试脚本 `scripts/video_4k_upscale.py`。
2. SSH 到 Workstation 核查当前 ComfyUI 可用超分模型与显存。
3. 运行首个 4K 超分冒烟测试。
