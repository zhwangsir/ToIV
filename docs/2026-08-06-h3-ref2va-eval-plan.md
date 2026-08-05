# MiniMax H3 ref2va(参考生视频)评测计划(2026-08-06)

> 来源:H3 第一轮评测(docs/2026-08-03-minimax-h3-eval.md)「后续评测清单(第二轮)」遗留项——ref2va 角色一致性(配合 PuLID 路线对比)。
> 性质:开源权重本地可行性验证,非生产接入。MiniMax H3 Community License。

## 一、任务目标

验证 H3 ref2va(Reference-to-Video)在**短剧角色一致性**场景的可用性,回答三个问题:

1. **角色锁定**:给 1-3 张角色参考图,生成视频中角色面部/服装一致性是否达到短剧生产标准(对比 PuLID-Flux 首帧路线)
2. **多模态参考**:参考视频(运镜/动作迁移)与参考音频(音色)是否实用
3. **生产代价**:参考 token 随采样步全程挂载,`ref_image_size=match/max` 两档的速度与显存代价

## 二、现状与前置条件(已就绪)

| 项 | 状态 |
|---|---|
| 权重 `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | ✅ 已在 NAS `toiv/comfyui-models/h3/diffusion_models/`(19.5GiB,2026-08-04 下载,sha256 校验中,期望 `9255f52b…9365779`) |
| TE `qwen3vl_32b_minimax_h3_nvfp4_awq` + 双 VAE | ✅ 与 fl2va 共用,已在 NAS |
| ComfyUI 实例 | 生产 `toiv-comfyui-h3.service`(workstation :8195,GPU0/GPU2 分摊);评测实例 `/home/merlin/ComfyUI-h3-eval`(备选) |
| 工作流模板 | `video_minimax_h3_r2v.json`(ComfyUI 0.30 自带);节点 `MiniMaxH3ReferenceToVideo` |
| 角色参考图素材 | 复用 PuLID-Flux 评测角色三视图 + 既有短剧项目角色卡 |

**节点能力**(模板实测):ref_images ≤9 / ref_videos ≤3(可带音轨)/ ref_audios ≤3;prompt 用 `<Picture 1>` `<Video 1>` `<Audio 1>` 按连接顺序引用;`ref_image_size` 两档(match 快 / max 保真,短边至多 2048px);调度器建议 beta 或 normal(参考密集时优于 simple)。

## 三、技术方案

### 评测矩阵(固定 seed 分组对照)

| 组 | 用例 | 参考输入 | 参数 |
|---|---|---|---|
| A1 | 单角色单图 → 新场景 | 角色正视图 ×1 | 1344×768,124 帧,24fps,20 steps,match |
| A2 | 同 A1,保真档 | 同 A1 | `ref_image_size=max` |
| B1 | 三视图锁角色 | 正/侧/背 ×3 | 同 A1 |
| C1 | 双角色对手戏 | 角色A+角色B 各1张 | prompt 含 `<Picture 1>` `<Picture 2>` 分工 |
| D1 | 运镜迁移 | 角色图 ×1 + 参考运镜视频 ×1 | `<Video 1>` 引用 |
| E1 | 音色参考(可选) | 角色图 ×1 + 台词音频 ×1 | `<Audio 1>` 引用 |
| F1 | 对照:PuLID-Flux 首帧 + fl2va i2v | 同角色 | 现有 PuLID 链路,同 prompt 同场景 |

### 评估维度

- **角色一致性**(主指标):抽帧(首/中/尾各 2 帧)与参考图并排对比;面部相似度用 InsightFace embedding 余弦距离量化(阈值参考:同一人 ≥0.5)
- **指令跟随/画面质感**:沿用第一轮清单(构图/布光/道具)
- **速度**:端到端耗时、采样 s/it;match vs max 差值
- **显存**:逐卡峰值(nvidia-smi 采样),对照 fl2va int8 基线(单卡增量 ~30-33GiB)
- **音画**:对白清晰度/口型(人工听审,沿用第一轮结论口径)

### 执行方式

- API prompt 由模板 r2v JSON 改造(参考第一轮 `{t2v,i2v}_prompt.json` 存档做法),存档至 `/home/merlin/ComfyUI-h3-eval/r2v_*_prompt.json`
- 提交走 ComfyUI /prompt API,轮询 history,产物落 NAS `toiv/outputs/videos/h3-eval/r2v/`
- 纪律:**不触碰生产 ComfyUI worker(:8189-8191)与其他生产服务**;:8195 H3 实例若被生产调用占用则排队等待,不并行压测

## 四、时间节点

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| P0 | 权重 sha256 校验 + r2v prompt 模板改造 | 校验匹配;A1 用例出片成功 |
| P1 | A/B/C 组角色一致性矩阵 | 6 组成片 + InsightFace 量化表 |
| P2 | D/E 组多模态参考 | 运镜/音色参考可用性结论 |
| P3 | F 组 PuLID 对照 + 报告 | 评测报告入账 docs/,给出生产接入建议 |

(不给绝对时间:A1 单镜热启动预计 ~4-6 分钟,参考 token 挂载会减速,以实测为准;全程可在 1 个会话内完成。)

## 五、交付标准

1. 评测报告 `docs/2026-08-XX-h3-ref2va-eval.md`:权重校验记录、评测矩阵结果、量化对比表、生产接入建议(是否能替代/补充 PuLID 首帧路线)
2. 成片与对比帧备份 NAS `toiv/outputs/videos/h3-eval/r2v/`
3. API prompt 存档 workstation,STATE.json/TEST_LOG.md 入账
4. 明确结论:ref2va 是否进 Studio 模块分镜引擎候选(是/否 + 条件)

## 六、风险与注意

- 下载坑位沿用第一轮记录(hf-mirror xet 限速 / aria2 `-c --auto-file-renaming=false` / 显式 `-o` 文件名);本轮权重已就位,仅校验
- GPU 纪律:遵守 AGENTS.md GPU 分配表;H3 实例与生产共卡,评测期间监控显存红线(第一轮 I2V 峰值 97.2G/97.9G 教训)
- `ref_image_size=max` 会显著拖慢采样(参考 token 每步挂载),D1 组参考视频帧数不宜过长
