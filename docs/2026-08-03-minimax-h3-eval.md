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

---

## 九、第二轮:bf16 满血 + 双卡分摊(2026-08-04 凌晨)

> 目标:验证 bf16 满血权重(单卡放不下的档位)经多卡分摊是否可跑,以及与 int8 档的质量差是否值得代价。实例、prompt、参数、seed 与第一轮完全一致(1344×768,124 帧,24fps,20 steps,seed 42,res_multistep/simple),仅 DiT 换 bf16。全程未触碰生产 ComfyUI(/opt/ComfyUI,:8188-8191)与任何生产服务。

### 9.1 权重下载与校验(均已 sha256 校验,与 HF LFS oid 一致)

| 文件 | NAS 路径 | 大小 | sha256 |
|---|---|---|---|
| minimax_h3_fl2va_bf16.safetensors | `h3/diffusion_models/` | 66,280,487,368 B (61.7 GiB) | `907d4add…fdd6182` |
| qwen3vl_32b_minimax_h3_bf16.safetensors | `h3/text_encoders/` | 51,506,295,256 B (48.0 GiB) | `600d567f…610607d` |

下载仍走 hf-mirror,本轮无断速(单连接未被限速),峰值 390-734 MiB/s,110GB 约 6 分钟下完。为防 xet 断速,本轮写了看门狗脚本(`workstation /home/merlin/downloads/h3/dl_watchdog.py`):每 60s 解析 aria2 进度行,连续 2 次 <10MiB/s 则 kill 重启换新签名 URL,`-c --auto-file-renaming=false` 断点续传。另注意:hf-mirror 302 到 xet-bridge 后 aria2 会按 URL 末段把文件存成 hash 名,必须显式 `-o` 指定文件名。

### 9.2 双卡方案:为什么必须、怎么实现

**为什么单卡不可行(运行时实测显存)**:GPU0 被生产 worker 缓存占 95.6G(仅剩 ~2G);GPU1 空闲 ~34G(nemotron 19G + 生产 worker 7.3G + LiveAct 37.5G);GPU2 空闲 ~29G(生产 worker 18.8G + opentalking 11.7G + LiveAct 34G);GPU3 Nemotron 92G 禁动。bf16 DiT 单文件 61.7G,**没有任何一张卡放得下**;GPU1+GPU2 合计空闲仅 ~63G,连 DiT 本体都勉强,必须叠加 DRAM 分摊。生产服务未停、未让任何生产模型让位。

**方案:ComfyUI-MultiGPU v2.6.4(pollockjj fork)**,仅装入评测实例 custom_nodes。调研结论:

- 其 loader 节点是对 core 类的包装(`override_class_clip(GLOBAL_NODE_CLASS_MAPPINGS["CLIPLoader"])` 等),**type 下拉继承原生定义,天然包含 `minimax`,与 H3 节点兼容**;`UNETLoaderDisTorch2MultiGPU` 支持 expert 字节串(如 `cuda:1,22gb;cuda:2,13gb;cpu,*`),按块确定性切分 safetensors 到多设备,donor 块在 forward 时交换到 compute 设备。
- 唯一兼容性问题:其 P2P 检测 `ctypes.CDLL("libcudart.so")` 在 torch 2.13+cu130 环境找不到未版本化 soname,导致 nvfp4 反序列化路径报 OSError。修复:在 venv `nvidia/cu13/lib/` 建 `libcudart.so → libcudart.so.13` 软链并在启动脚本加 `LD_LIBRARY_PATH`(`start_mgpu.sh`)。

**最终拓扑**(`bf16_{t2v,i2v}_prompt.json`):

| 组件 | 放置 |
|---|---|
| DiT bf16 61.7G | DisTorch2:cuda:1 22G + cuda:2 13G + CPU DRAM ~27G,compute=cuda:1,eject_models=false(不驱逐实例内其他模型) |
| TE nvfp4 14.6G(A/B 与第一轮同档) | CLIPLoaderMultiGPU → cuda:2 |
| 视频 VAE 4.9G + 音频 VAE 0.6G | VAELoaderMultiGPU → cuda:2 |

bf16 TE(48G)未用:一是 A/B 要求与第一轮同 TE 档;二是 GPU1/2 空闲已被 DiT+VAE 占满,无任何卡有 48G 富余——要全 bf16 需「暂停 LiveAct(37.5G+34G)」级别的让位,本轮按纪律未做。

### 9.3 生成实测(同 prompt/参数/seed)

| 项 | T2V(bf16) | I2V(bf16) | 第一轮 int8 对照 |
|---|---|---|---|
| 端到端 | **654s**(冷启动,模型 init 308s 含 SMB 加载+DisTorch 放置) | **269.5s**(热启动) | 370.6s 冷 / 209.9s 热 |
| 采样 | 稳态 ~10.9s/it(首步含 init 308s) | ~12.05s/it | 8.65s/it(173s/20 步) |
| 产物 | h264 1344×768@24,5.167s + AAC 32kHz 立体声 | 同左 | 同左 |
| 音频 | mean -24.4 / max -4.9 dB,-15.6 LUFS | mean -20.7 / max -5.2 dB,-17.2 LUFS | T2V -27.3/-7.2、-18.7 LUFS;I2V -20.6/-4.4、-17.1 LUFS |
| 显存峰值(逐卡) | **GPU1 97,242 / 97,887 MiB(99.3%,⚠️贴 OOM 红线;增量 ~33.4G)**;GPU2 91,863 MiB(增量 ~23.0G) | 同左(峰值出现在同次运行窗口) | GPU1 97,216(增量 ~32.6G,单卡) |

采样步速 bf16 比 int8 慢 ~26-39%(权重大 2.9 倍 + CPU donor 经 PCIe 逐层换入)。GPU1 99.3% 占用意味着与任何生产负载抖动同居一卡都有 OOM 风险,本轮未触发纯属余量恰好够。

成片备份:NAS `toiv/outputs/videos/h3-eval/bf16/{bf16_t2v,bf16_i2v}_768p_5s_00001_.mp4`;对比帧 `workstation /home/merlin/ComfyUI-h3-eval/ab_frames/`。

### 9.4 质量对比(bf16 vs int8,同 prompt 同 seed 抽帧)

- **I2V(同首帧+同 seed,变量最少)**:构图、布光、人物姿态、墙面斑驳分布几乎逐像素一致;原生分辨率裁切对比(人脸/门牌/栏杆),细节互有胜负——int8 墙面脱皮纹理对比度略高,bf16 略平滑,**无可感知的 bf16 质量优势**。音轨统计几乎一致(-17.1 vs -17.2 LUFS,LRA 0.9 vs 0.8)。
- **T2V**:同场景同情节同构图,但布光与运镜节奏有随机性差异(bf16 楼道更暗、推镜时机不同,属采样路径差异而非质量差);细节(菜篮编织、窗框、墙面)两档均清晰。bf16 音频整体响度略高(-15.6 vs -18.7 LUFS),LRA 相近。
- **结论:int8(pruned int8 convrot)档对短剧生产够用。** bf16 在本分辨率/时长下没有展现出值得 2.9 倍权重体积、双卡复杂度、26-39% 减速和 OOM 红线风险的质量提升。

### 9.5 生产接入建议(更新)

1. **维持第一轮结论:int8 档为生产候选**,单卡 ~30-33G 增量,与 LiveAct 分卡或错峰即可;bf16 双卡方案**不建议进生产**——GPU1 峰值 99.3% 贴红线,与生产服务同居一卡的任何显存抖动都会 OOM,且速度更慢、无可感知质量收益。
2. 若未来确需 bf16(如官方修复仅 bf16 可用的特性):前置条件是**独占一张 96G 卡**(DiT+nvfp4 TE+VAE 约 82G,需生产队列空窗)或**暂停 LiveAct 后双卡分摊**;两者都需管家审批的窗口期操作,不适合常驻管线。
3. ComfyUI-MultiGPU 仅保留在评测实例,不进生产 custom_nodes;若生产升级 0.30 后确需多卡,再评估其 mm monkeypatch 与生产 worker 的共存风险。
4. 评测实例已停,四卡显存已全部回到基线(0:95.6G / 1:63.8G / 2:68.9G / 3:93.0G,均为生产占用)。资产:权重 NAS `h3/`(int8+nvfp4+bf16 共 ~152GB),实例 `ComfyUI-h3-eval`(`start.sh` 单卡 / `start_mgpu.sh` 多卡),prompt 存档 `{t2v,i2v,bf16_t2v,bf16_i2v}_prompt.json`。
