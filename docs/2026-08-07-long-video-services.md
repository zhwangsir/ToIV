# ToIV 长视频服务文档(末帧续写 + LongCat-Video)

> **日期**:2026-08-07
> **范围**:5 分钟级长视频生成能力建设 —— ① drama studio 末帧续写模式(已上线路线);② LongCat-Video 原生长视频引擎(新增服务)
> **背景**:Workstation(4×RTX PRO 6000 96GB)负载持续走高,新增服务必须附带负载规划

---

## 一、现状负载盘点(2026-08-07 18:04 实测)

| GPU | 常驻服务 | 实测显存 | 实测利用率 | 余量判断 |
|-----|---------|---------|-----------|---------|
| GPU0 | ComfyUI#1 + IndexTTS2 + H3(UNet 分片) | 67.2/97.9 GB | 100%(生成期) | **已饱和**,不可再加 |
| GPU1 | LiveAct 58G + Qwen3-Embedding 8.4G + demucs | 78.2/97.9 GB | 0%(空闲期) | 显存近满,不可再加 |
| GPU2 | AI-Omni ASR 5.3G(+H3 CLIP/VAE 突发 ~48G) | 5.3/97.9 GB | 0% | **唯一空闲卡**,常态余 ~90G |
| GPU3 | FlashTalk 55G + OpenTalking 1.5G | 57.9/97.9 GB | 0% | 余 ~40G,但数字人是低延迟交互业务,不宜叠加 |

- 系统:load avg 3.68(32 核),内存 88/183 GB,NAS 39TB 可用
- 结论:**新增长视频服务只能落 GPU2**,与 H3 突发共享(H3 生成时 CLIP/VAE 占 48G,需错峰或互斥调度)

---

## 二、服务一:drama studio 末帧续写模式

### 2.1 定位

不引入新模型,用现有 LTX/H3 i2v 能力实现「一镜到底」长镜头:上一段视频的**最后一帧**作为下一段 i2v 的**首帧**,逐段延续,与既有「分镜拼接」互补(拼接适合多镜头叙事,续写适合单镜头长时连续画面)。

### 2.2 API

```
POST /api/drama/shots/{sid}/continue-video
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| segments | int 1–5 | 1 | 续写段数,超出 422 |
| engine | `""`/`ltx`/`h3` | `""` | 空 = 沿用 shot.video_model(非 ltx/h3 回落 ltx) |
| auto_concat | bool | false | true 时完成后 ffmpeg concat 源视频+各段成一条 |
| length | int 9–362 | 空 | 每段帧数;空 = fps×duration_sec 向下对齐网格;显式值严格校验(LTX 8k+1 ≤241 / H3 17k+5),违规 422 |
| fps | int 4–30 | 项目 fps | 仅 LTX;H3 固定 24 |
| steps / cfg / seed / prompt_override | — | 20 / 1.0 / 空 / 空 | seed 按 `_next_seeds` 逐段派生 |

- 响应:`{shot_id, segments, engine, length, fps, auto_concat, status:"continuing"}`,fire-and-forget
- 轮询:项目详情里该 shot 的 `continue_status`(continuing→done/error),产物在 `continue_urls[]` 和 `continue_concat_url`
- 前置校验:无已完成视频 422、续写进行中 409
- 时长估算:LTX 97 帧@16fps ≈ 6s/段,5 段 ≈ 30s 单镜头;H3 362 帧@24fps ≈ 15s/段,5 段 ≈ 75s

### 2.3 实现要点(已上线 core)

- 链路:`shot.video_url` 取视频 → `ffmpeg -sseof -0.1 -frames:v 1` 抽末帧 → 上传 worker → LTX 走 `build_ltx_i2v_graph` + `pool.pick`;H3 走 `submit_h3_job`(自带显存预检)→ 每段登记 Job + 落盘 `drama_output_root()`(NAS 优先)→ 下一段从本段末帧继续 → auto_concat 复用 `assembly._concat_parts`
- 抽帧/拼接在 core 本机执行(轻负载);段产物 URL 形式 `/api/drama/output/<name>.mp4`
- PG 迁移(生产 PostgreSQL 需手动,已执行):`ALTER TABLE dramashot ADD COLUMN continue_status/continue_urls/continue_concat_url/continue_error`
- 测试:`apps/api/tests/test_drama_continue.py` 12 用例,全量 984 passed;commit `3f9a680`

### 2.4 已知限制

- 续写超过 3–5 段会出现画面漂移(色调/细节偏移),`segments` 硬上限 5
- 每段耗时 ≈ 单段 i2v(实测 LTX 97 帧档 ~230s),5 段 ≈ 20 分钟,为后台异步任务
- 抽帧依赖 core 上的 ffmpeg(与 assembly 同环境,无新增依赖)

---

## 三、服务二:LongCat-Video 原生长视频引擎

### 3.1 模型概况

| 项 | 值 |
|---|---|
| 模型 | meituan-longcat/LongCat-Video(美团开源,MIT 协议) |
| 参数 | 13.6B DiT + UMT5 文本编码器,总权重 **83.3GB**(bf16) |
| 能力 | 文生视频 / 图生视频 / **视频续写** 统一架构;Block Sparse Attention 原生分钟级 720p@30fps |
| 关键参数 | num_frames 17–961(961@30fps ≈ 32s);分辨率 480p/720p;steps 8–50 |
| ComfyUI 接入 | kijai **ComfyUI-WanVideoWrapper** 已支持(README 明示 LongCat-Video 兼容其代码库) |

### 3.2 模型落位

- 权重已下载至 NAS:`NAS/toiv/comfyui-models/LongCat-Video/`(dit/ text_encoder/ vae/ lora/ 完整 diffusers 布局)
- Workstation 经 `/home/merlin/nas_mount` 挂载读取;PC01/PC02 经 Z: 盘(32GB 显存跑不动 13.6B bf16,仅作备份存储)

### 3.3 部署方案(GPU2 独立 ComfyUI 实例,已落地)

**不并入生产 ComfyUI-LB 后端**(避免 WanVideoWrapper 插件影响现有 805 节点生产稳定性),参照 FlashTalk/OpenTalking 的独立服务惯例:

| 项 | 值 |
|---|---|
| 实例目录 | `/home/merlin/ComfyUI-longcat`(独立浅克隆,与生产 /opt/ComfyUI 隔离) |
| systemd | `comfyui-longcat.service`(Restart=always,已 daemon-reload) |
| 端口 | :8197,`CUDA_VISIBLE_DEVICES=2`,复用 /opt/ComfyUI/venv(补装 accelerate/peft/pyloudnorm/gguf) |
| custom_nodes | ComfyUI-WanVideoWrapper + ComfyUI-KJNodes(Set/GetNode、ImageBatchExtendWithOverlap)+ ComfyUI-VideoHelperSuite(视频合成) |
| 模型路径 | `extra_model_paths.yaml` → NAS `toiv/comfyui-models`(diffusion_models/text_encoders/vae/loras) |
| 状态 | ✅ 服务已启动,974 节点(含 112 个 WanVideo/LongCat 节点),sageattention 未装(可选加速,用 sdpa 替代) |

**权重(Kijai 单文件 ComfyUI 版)**:
- `diffusion_models/LongCat/LongCat_TI2V_comfy_fp8_e4m3fn_scaled_KJ.safetensors` 15.5GB(fp8,常驻 ~16GB)
- `loras/LongCat_distill_lora_alpha64_bf16.safetensors` 1.26GB(蒸馏加速,8 步出片)+ `LongCat_refinement_lora_rank128_bf16.safetensors` 2.47GB(精修)
- `text_encoders/umt5-xxl-enc-fp8_e4m3fn.safetensors` 6.73GB、`vae/Wan2_1_VAE_bf16.safetensors` 0.25GB
- 官方 bf16 diffusers 版 83.3GB 已存 NAS 备用(`LongCat-Video/` 目录)
- 参考工作流:插件自带 `example_workflows/LongCat_TI2V_example_01.json`(scheduler 用 longcat_distill_euler)

- 显存预算:fp8 DiT 16GB + umt5 fp8 7GB + VAE,Block Swap(10 块)——**实测峰值 21GB**(480×832×49 帧);GPU2 常态余 90GB,**与 H3 突发 48GB 可共存**(21+48+5.3 ≈ 75GB < 98GB);若换 bf16(54GB)则必须与 H3 互斥

### 3.4 冒烟与压测实测(脚本 `scripts/longcat_smoke.py`)

| 场景 | 参数 | 耗时 | GPU2 峰值 | 结果 |
|---|---|---|---|---|
| 冒烟 2026-08-07 19:14 | 480×832×49 帧 steps=10 | **73s**(含 NAS 冷载 ~40s) | 21GB / 100% util | ✅ 画质达标 |
| 压测 2026-08-07 20:51 | **1280×720×961 帧(60s 单镜头)** steps=10,块交换 30,上下文窗口 81/overlap 16 | **65 分钟** | **29GB**(采样期恒定 21.7GB,解码期 29GB)/ 100% util | ✅ 60s 全程画质连贯无漂移 |

⚠️ 关键经验:
1. **WanVideoSampler 必须设 `rope_function="comfy"`**——LongCat 的 qk norm 是 per-head(128 维),只有 comfy rope 路径会走 is_longcat 分支;缺省路径按全维度 4096 归一化,报 `The size of tensor a (4096) must match the size of tensor b (128)`。接入 engine_registry 时必须写死该参数。
2. **长帧数必须开上下文窗口**(WanVideoContextOptions,81 帧/overlap 16)+ 加大块交换(10→30):961 帧不开窗口直接 OOM(66GB+13GB 请求),开窗后显存恒定 21.7GB,代价是耗时(61s/帧外推≈4s/帧)。
3. 480p 短片(≤121 帧)不用开窗口,10 块交换即可,出片约 2-4 分钟。

### 3.5 接入 core API(二期,✅ 已落地)

`longcat-t2v` 已按 engine_registry 模式注册并接入 core(commit 57fd39c + df1f9ef):`POST /api/longcat/t2v`,worker 指向 `http://192.168.71.127:8197`,参数:num_frames(17–961,默认 121)、resolution(320–1280,默认 832×480 自动 16 对齐)、steps(1–50,默认 10)、fps(8–30,默认 16)、seed。e2e 已通(121 帧作业 → done → 产物代理下载 200)。`longcat-i2v` / `longcat-continue` 留待 P2b。

### 3.6 姊妹模型储备(数字人方向)

**LongCat-Video-Avatar 1.5**(同一底座,音频驱动数字人):Whisper 驱动唇形同步、8 步蒸馏、支持分钟级口播视频。与现有 FlashTalk/OpenTalking 数字人链路互补,建议作为数字人长视频的下一代引擎评估,权重同源可复用 DiT。

---

## 四、负载规划与减负建议

### 4.1 新增负载全部落 GPU2

| 时段 | GPU2 占用 | 峰值估算 |
|------|----------|---------|
| 常态 | ASR 5.3G + LongCat(bf16,编码器卸载后)~55G | ~60G / 98G |
| H3 生成突发 | +48G(CLIP/VAE) | **与 LongCat 互斥**,单跑 ~53G |
| LongCat 生成时 | Block Swap 峰值 ~70G | 单跑安全,禁止与 H3 并发 |

### 4.2 减负措施(按优先级)

1. ~~**GPU0 减压**~~ ✅ 2026-08-08 已实施:comfyui-gpu0.service 加 `--cache-lru 8`(节点结果缓存上限),避免图像/LTX 模型常驻;重启后 txt2img 真机生成验证通过
2. ~~**GPU1 demucs 错峰**~~ ✅ 2026-08-08 已实施:toiv-audio-sep.service `CUDA_VISIBLE_DEVICES=0→2`,分离实测 200 返回 vocals,GPU1 留给 LiveAct 专职
3. **中期**:项目负责人把 ToIV/DRT 业务迁移到 core(AGENTS.md 待办),workstation 回归纯算力角色

---

## 五、运维手册

### 5.1 服务清单(新增)

| 服务 | systemd 单元 | 端口 | 设备 |
|------|-------------|------|------|
| LongCat ComfyUI worker | comfyui-longcat.service | :8197 | workstation GPU2 |
| 末帧续写 | 随 toiv-api(core) | :8090 | core |

### 5.2 常用命令

```bash
# LongCat worker
sudo systemctl start|stop|status comfyui-longcat
journalctl -u comfyui-longcat -f

# 健康检查
curl http://192.168.71.127:8197/system_stats

# 续写模式冒烟(在 core 上)
curl -X POST http://192.168.71.47:8090/api/drama/shots/{sid}/continue-video \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"segments":2,"auto_concat":true}'
```

### 5.3 故障处理

| 现象 | 排查 |
|------|------|
| LongCat 提交 503 | 查 :8197 存活;查 GPU2 显存是否被 H3 挤占 |
| 续写段间画面跳变 | segments 降到 ≤3;检查 i2v 参考图是否为末帧(抽帧日志) |
| NAS 读取慢导致模型加载超时 | 模型加载走 SMB(~400MB/s 实测),首载 ~3-5 分钟属正常;可考虑热数据回拷本地盘 |

---

## 六、实施路线图

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 | 末帧续写 API + 单元测试 + core 部署 + 真机验证(2 段+拼接,15.7s 成片) | ✅ 完成(commit 3f9a680/5b12fea) |
| P0 | LongCat-Video 权重下载至 NAS(官方 83GB + Kijai 单文件 26GB) | ✅ 完成 |
| P1 | WanVideoWrapper 安装 + fp8 权重 + GPU2 实例起服务(:8197,1263 节点) | ✅ 完成 |
| P1 | LongCat 冒烟:480×832×49 帧真机生成(73s,峰值 21GB,画质达标) | ✅ 完成 |
| P1b | LongCat 长视频压测:720p 961 帧(60s 单镜头,上下文窗口+块交换30) | ✅ 完成(65min/峰值 29GB,60s 全程连贯) |
| P2 | engine_registry 注册 longcat-t2v + `POST /api/longcat/t2v` 接入 core(commit 57fd39c,1006 tests) | ✅ 完成(rope_function=comfy 已写死 builder) |
| P2 | core e2e 全链路验证:121 帧竹林作业 → done → 产物代理下载 200(832×480×121 帧,3.6MB) | ✅ 完成;resolve_worker 补 LongCat 精确匹配修复产物代理 502(commit df1f9ef,1007 tests) |
| P2b | LongCat i2v / 视频续写端点(builder/路由已留扩展位);长帧数(>241 帧)自动开上下文窗口的 builder 支持 | 待办 |
| P3 | LongCat-Video-Avatar 数字人长视频评估 | 待办 |
