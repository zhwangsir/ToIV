# MiniMax H3 视频模型真机评测(2026-08-03)

> 评测性质:开源权重本地可行性验证,非生产接入。评测实例为独立克隆的 ComfyUI,未触碰生产实例(/opt/ComfyUI 及 :8188-8191)与任何生产服务。
> 许可:MiniMax H3 Community License。

## 一、评测环境

| 项 | 配置 |
|---|---|
| 设备 | workstation (192.168.71.127) |
| ComfyUI | 0.30.0(全新克隆 `/home/merlin/ComfyUI-h3-eval`,独立 venv,无生产 custom_nodes) |
| torch | 2.13.0+cu130(复用生产 venv site-packages 拷贝安装,与生产一致) |
| GPU | 评测实际用 **GPU1**(RTX PRO 6000 96GB)。计划用 GPU0,但当日生产 ComfyUI worker :8189 在 GPU0 预留了 86G 显存,GPU0 仅剩 ~2.3G 不可用;GPU1 空闲最多(~34G) |
| 端口 | 8195(127.0.0.1),CUDA_VISIBLE_DEVICES=1 |
| 模型路径 | NAS `toiv/comfyui-models/h3/`(extra_model_paths 挂载,SMB 直读) |

注意:ComfyUI 官方要求 **≥0.30.0**;生产为 0.27/0.28,不支持 H3 节点。

## 二、权重清单(均已 sha256 校验,与 HF LFS oid 一致)

| 文件 | NAS 路径 | 大小 | 说明 |
|---|---|---|---|
| minimax_h3_fl2va_pruned_int8_convrot.safetensors | `h3/diffusion_models/` | 20,970,379,616 B (19.5 GiB) | 文/图生视频主权重,pruned+int8 convrot(最小幅值档) |
| qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors | `h3/text_encoders/` | 15,687,142,551 B (14.6 GiB) | 文本编码器最小档(官方教程默认即此档;另有 int8 27.1G / bf16 51.5G 未下) |
| minimax_h3_video_vae_fp16.safetensors | `h3/vae/` | 5,207,808,496 B (4.9 GiB) | 视频 VAE |
| minimax_h3_audio_vae_fp32.safetensors | `h3/vae/` | 605,254,808 B (577 MiB) | **音频 VAE,漏下会无声** |

ref2va(参考图生视频)本轮未下,第二轮再评。来源:`Comfy-Org/MiniMax-H3`(hf-mirror 下载)。

下载坑位记录:hf-mirror 回源 xet-bridge CDN 按连接限速(单连接可掉到 33KiB/s),aria2c 16 线程也会被整体拖慢;重启 aria2 换新签名 URL 可恢复 30-80MiB/s 突发。注意 aria2 默认 `--auto-file-renaming=true`,续传脚本反复重启会生成 `.1/.2` 重复文件,必须用 `-c --auto-file-renaming=false`,并以下载后 sha256 校验为准(本次第一个文件就因中途 kill 导致 3% 空洞、校验不匹配,重下后通过)。

## 三、节点实况(/object_info 实测)

- `MiniMaxH3ImageToVideo`:输入 clip/vae/prompt/width/height/length + 可选 first_frame/last_frame;**输出只有 [CONDITIONING, LATENT]**,MODEL 需从 UNETLoader 直连 BasicGuider(模板子图内即如此)。length 为 17k+5 帧网格 @24fps(124≈5.2s,提示训练范围 ~124-362 帧,即最长约 15s)
- `CLIPLoader` type 新增 `"minimax"`;server 启动日志显示 native ops: `int8_tensorwise, nvfp4, convrot_w4a4, float8_*`(Blackwell 原生 nvfp4/convrot 内核生效)
- 采样链:UNETLoader → BasicScheduler(simple, 20 steps)+ KSamplerSelect(res_multistep)→ SamplerCustomAdvanced → VAEDecode + VAEDecodeAudio → CreateVideo(fps=24)→ SaveVideo
- workflow 模板在 venv `comfyui_workflow_templates_json/templates/video_minimax_h3_{t2v,i2v,r2v}.json`;本次 API prompt 存档于 workstation `/home/merlin/ComfyUI-h3-eval/{t2v,i2v}_prompt.json`

## 四、生成实测

### T2V(中文短剧风格,带对白/环境音)

- prompt:现实主义都市短剧,夜晚老居民楼楼道,中年女人提菜篮上楼停在 602 门口;含两句中文对白 + 楼道环境音描述
- 参数:1344×768(0.98MP,16:9),124 帧(5.17s),24fps,20 steps,seed 42
- **端到端 370.6s(冷启动,含 SMB 加载全部权重);其中采样 20 步仅 173s**
- 产物:h264 1344×768 24fps 5.167s + **AAC 32000Hz 立体声** 5.167s;音频非静音(mean -27.3dB / max -7.2dB)
- GPU1 显存峰值 94,312 MiB(基线 63.8G,实例增量 ≈29.8 GiB)

### I2V(首帧=T2V 成片 4.5s 帧,剧情连续)

- prompt:门从里打开、暖光洒出、老人出现、两人拥抱;对白延续
- **端到端 209.9s(权重已缓存,热启动)**
- 产物:h264 1344×768 24fps 5.167s + AAC 32kHz 立体声(mean -20.6dB / max -4.4dB)
- GPU1 显存峰值 97,216 MiB / 97,887 MiB(增量 ≈32.6 GiB;与 LiveAct+embedding 同居一卡时**逼近 OOM 红线**,未触发)

成片备份:NAS `toiv/outputs/videos/h3-eval/{t2v,i2v}_768p_5s_00001_.mp4`;workstation `/home/merlin/ComfyUI-h3-eval/output/h3eval/`。

## 五、标称 vs 实测

| 标称 | 实测 | 结论 |
|---|---|---|
| 768px 短边原生(768×1344 上限,32 对齐) | 1344×768 精确输出 | ✅ |
| 24fps | 24/1 fps | ✅ |
| 4-15s(17k+5 帧网格) | 124 帧 → 5.167s | ✅(15s=362 帧未试) |
| 原生 32kHz 立体声,音画同发 | AAC 32kHz 2ch,与视频同长,非静音 | ✅(主观听感未逐项比对台词) |
| 最小档总占用 42.5GB | 同居卡增量峰值 ~30-33 GiB(动态卸载) | ✅ 与标称吻合 |
| FL2VA 支持 t2v/首帧/首尾帧 | t2v + first_frame i2v 均通 | ✅(last_frame、首尾帧未试) |

## 六、质量印象

- **画面**:现实主义短剧质感出色——斑驳墙面、声控灯昏黄渐暗、铁艺楼梯、"602"门牌均按 prompt 呈现,电影感光影;两镜之间场景/人物/道具(菜篮)连续性极好(I2V 首帧无缝衔接)
- **指令跟随**:镜头运动(仰拍推近)、情节(开门/拥抱)、氛围均准确;中文 prompt 理解到位
- **音频**:确认有实际音轨内容(音量包络正常),含对白段落;台词清晰度/口型同步未做主观逐项核验,建议后续人工听审
- **速度远超预期**:768p×5s 采样仅 ~3 分钟(20 步),热启动端到端 ~3.5 分钟/镜。对比 LiveAct 14B 单镜耗时,H3 在短剧分镜场景有数量级优势,且自带配音/音效/配乐

## 七、接入 ToIV 可行性结论与建议

**结论:高度可行,建议作为短剧管线下一代分镜引擎候选,优先级高于继续加码 LiveAct。**

1. **生产接入前置条件**:生产 ComfyUI 需升级至 ≥0.30.0(当前 0.27/0.28 无 H3 节点)。升级有回归风险,建议先在某一 worker(如 pc01/pc02 远端 worker)升 0.30 验证存量 workflow 兼容,再滚动升级
2. **显存调度**:整档(TE+diffusion+双 VAE)总占用 ~42.5GB,动态卸载下峰值 ~30-33 GiB;但我们 4 卡均有常驻租户,与 LiveAct(37G)同卡时峰值已到 97.2/97.9G 红线。生产接入时建议:固定调度到 LiveAct 空闲时段,或将 LiveAct 与 H3 分卡;不要盲目与 embedding/LiveAct 挤同一卡
3. **性能**:5s/768p 镜头热启动 ~3.5 分钟,一条 10 镜短剧约 35 分钟(不含排队),可接受;如需提速可按官方教程加 SageAttention(--use-sage-attention,约 2 倍速)
4. **音频是一步到位的卖点**:原生中文对白+环境音 32kHz 立体声,可省掉 IndexTTS2 配音+对口型环节(或作为 LiveAct 全身镜头之外的半身/空镜补充)
5. **后续评测清单(第二轮)**:ref2va 角色一致性(配合 PuLID 路线对比)、last_frame/首尾帧、15s 长镜头、中文台词清晰度与口型同步人工听审、SageAttention 提速比、2K(H3-Regenerate-2K 仍是云端,本地 2K 待验证)
6. **合规**:MiniMax H3 Community License,接入前过一遍条款

## 八、评测资产位置

- 评测实例(保留未删,进程已停):workstation `/home/merlin/ComfyUI-h3-eval/`(`start.sh` 一键重启,端口 8195,GPU1)
- 权重:NAS `toiv/comfyui-models/h3/`(42.5GB,sha256 已校验)
- 成片:NAS `toiv/outputs/videos/h3-eval/`
- API prompt 存档:`/home/merlin/ComfyUI-h3-eval/{t2v,i2v}_prompt.json`
