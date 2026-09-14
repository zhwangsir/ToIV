# 公开应用 100% 可用 — Hard-blocked Whitepaper（终版 2026-09-14）

> 口径：550 公开应用真实提交→产物 PASS 计数；本册登记「100% 的诚实例外」——逐项附根因与证据。
> 中间产物与修复过程见 `.regen_tmp/lane_b_whitepaper_20260914.md`（过程稿，勿 stage）。

本轮 = 最终深修轮（时间盒 2h）：产品规则 6 条 + 设备修复 5 项 + 时序残差核销 19 条，
剩余按 A/B/C/D 分组交 Lane A（设备/下载）与后续产品波次。
真机复测统一等 wave21（部分设备修复需 ComfyUI 重启后生效，本轮按铁律未重启）。

## 本轮修复清单（已部署 core，api 3198 pass/0 fail = 基线 3192 + 新 6 测试）

### 产品规则（`apps/api/app/routes/apps.py` `_build_graph`）

| 规则 | 受益 app | 根因 |
|---|---|---|
| `_normalize_nunchaku_sm120_fp4`（int4→fp4 表，binding 后二跑） | 5790522369 / 8643189762 / 1432848386（3） | nunchaku `is_compatible`：SM120 只支持 fp4（fp4_e2m1_all），int4 SVDQ 直接 raise「Please use fp4 quantization for Blackwell GPUs」；fp4 对应文件已落 NAS toiv diffusion_models |
| `_normalize_node_class_aliases`（GIMM-VFI Interpolate→GIMMVFI_interpolate / String to Int→StringToInt / Depth Anything V2→DepthAnything_V2） | 7881019393 / 7233807361 / 7333005313（3，防 RH 再导入复发） | RH 导出带显示名/旧包名，fleet 现网 class_name 不同 |
| `_MISSING_REQUIRED_DEFAULTS` += WanVideoVACEEncode{vace_start_percent:0.0, vace_end_percent:1.0} | 0388281345 / 7510702081 / 1152197633（3） | 节点新版 required，RH 图未带 → required_input_missing 判死保存链 |
| `_normalize_ltxv_img2video_num_images`（flat/dot strength_N 最大序号回填，post-binding 跑在 dynamiccombo 之后） | 7810908162（1） | LTXVImgToVideoInplaceKJ 缺 num_images 选择器 → execute() missing positional |
| `_normalize_wan_video_decode_tiles`（stride>tile 时压到 tile 尺寸） | 5219795969（1） | WanVideoDecode custom validation「Tile height must be larger than the tile stride height」(tile_y=272/stride_y=400) |
| `_normalize_upscale_model_aliases`（2xNomosUni .pth→.safetensors） | 6186996738（1） | HF 只有 safetensors 发行（Phips/2xNomosUni_span_multijpg_ldl，8.9MB 已落盘 upscale_models） |

新测试：`test_apps_run.py` +6（nunchaku_fp4 / node_class_aliases / vace_backfill /
ltxv_num_images / decode_tiles / upscale_alias），build_graph 组 33 全绿。

### 设备修复（workstation 真机执行）

| 动作 | 受益 app | 备注 |
|---|---|---|
| :8196 venv kernels 0.16.1→0.15.2（+kernels-data） | 5263472642 / 9923136513 | finegrained-fp8 kernel 上限 <0.16.0；**重启 :8196 后生效** |
| :8196 ComfyUI-DepthAnythingV2 补全克隆（原目录只有模型代码缺 nodes.py，ghfast.top 重装） | 7333005313 | **重启后生效** |
| NAS toiv diffusion_models 落盘 svdq-fp4_r32 qwen-image-edit-lightningv1.0-4steps + qwen-image-lightningv1.1-8steps（各 11.9GB，hf-mirror aria2 实测 127MB/s） | 5790522369 / 8643189762 / 1432848386 | 与产品 remap 表配对 |
| :8196 upscale_models 落盘 2xNomosUni_span_multijpg_ldl.safetensors（8.9MB） | 6186996738 | — |
| :8196 LLM 下载中 Qwen3-VL-4B-Instruct-FP8（~5GB）+ Qwen3-VL-8B-Instruct（~16GB，curl 直拉 hf-mirror resolve；hf CLI 走 xet 会被 401，勿用） | 6367781890 / 3948937217 | 后台运行，wave21 前应就绪 |

### 时序残差核销（修复/落盘早于记录运行，wave21 自然过，19 条）

| app | 证据（真机核实 2026-09-14） |
|---|---|
| 3038288898 | `wan_2.1_vae.safetensors` 已在 :8196 VAELoader 29 项列表 |
| 4672855042 / 0341958658 | `wan2.2_t2v_high/low_noise_14B_fp8_scaled` 已在 WanVideoModelLoader 152 项列表 |
| 3472811009 | scheduler `beta57→beta` remap 已部署（binding 后二跑） |
| 3019615234 | RMBG `white→Color+#FFFFFF` remap 已部署 |
| 5606988802 / 9454613506 | sam3.pt 09-14 01:01 已落 :8196 models/sam3；PainterFluxImageEdit 缺参 backfill 已部署 |
| 3294852097 | :8195 diffusion_models 已有 `minimax_h3_fl2va_int8_convrot.safetensors`（精确版）+ loras MiniMax-H3-Turbo-4step 软链 |
| 9875421185 / 1706775554 / 1943495682 / 3933802498 / 1026501633 / 8233943041 | 同上，mat1/mat2 shape 族根因=精确 int8 缺失，已落盘 |
| 3782161410 / 1709145089 | 同上（校验层 not-in-list，同一根因） |
| 9943753729 / 5641927681 / 1181571072 | clip_vision_h.safetensors + clip_vision_h_Comfy-Org.safetensors 双文件已在 :8196 clip_vision 目录 |

### wave21 复测清单（排队/超时/瞬态/规则已覆盖待确认，23 条）

- queued_timeout×8：qwen-image-edit / 8206083073 / 7943490562 / 2340297729 / 7404027905 / 3644825601 / 1225532417 / 2218056705（排队耐心，无 app 重复 3 次）
- fail_timeout×5：7563294721（Flux2 Klein 9B 大生成）/ 4851323905 / 0117231618 / 8075737089 / 1636329473（480s poll，设备慢非产品）
- worker 重启丢失×2：5895702530 / 6900618241（tracker 已回收，重提）
- 7303255042（H3 RAM 门瞬态）/ 8731127809（No frames，VHS skip 修复已部署）/ 2236595201（/prompt 瞬态）
- 规则已覆盖待确认×5：8938444801（DB 图已用 fleet 在列的 SDPoseOODLoader）/ 9897735169（LTXVConditioning 三 required 齐）/ 8846564353（VHS hash mp4 已被 stale 规则覆盖）/ 7974787073（node 208 hash LoadImage，同上）/ 6771985410（JjkText :8196 在列）
- 1880220673 InsightFace no-face：测试 fixture 无正脸，换带脸图复测
- 0394349569-8e5196：生产复测曾 PASS@:8196（542s 出片），wave21 须钉上传 :8196 + kind=avatar（upload kind 门按图内 loader 判定是产品候选，未做）

## A. 缺模型权重（剩余 6 条，Lane A 下载/落盘）

| app | 缺什么 | 备注 |
|---|---|---|
| 4531347458（+145828） | SeedVR2 gguf（Q8_0/Q4_K_M）+ ema_vae_fp16 | 节点自有路径须手动放置；设备包已含 |
| 9771643905 | flux2_dev_fp8mixed + mistral_3_small_flux2_fp8 | 全 fleet 无 |
| 5689931777 | qwen_image_depth_diffsynth_controlnet + Z-Image-Turbo-Fun-Controlnet-Union | :8196 controlnet 目录无（union ~?GB） |
| 2372477953 | Wan21_Uni3C_controlnet_fp16 | combo=[] |
| 0394349569 | gemma_3_12B_it_fp8_e4m3fn（LTXAVTextEncoderLoader 用） | 三实例 LLM 均无；**先跑 wave21 钉 :8196 复测**（该 app 曾真实出片），确缺再下（~13GB） |
| 1880220673 | InsightFace LoRA 名未回显 | 若复测仍败按 history 定位 |

## B. 设备/环境（剩余 4 条）

| app | 现象 | 归口 |
|---|---|---|
| flux1-nunchaku | integer overflow | nunchaku 1.3.0.dev20260828+cu13.0torch2.13（/home/merlin/nunchaku-src 本地构建）SM120 kernel bug；升级路径待评估 |
| 3366160386 | PortAudio PulseAudio 连不上 | WS 无音频宿主，音频节点应路由 MacMini/PC |
| 8316340225 | urlopen Errno 110（节点运行时外网下载） | hf-mirror 代理 drop-in 未覆盖该节点 |
| 3877213185 | SeCModelLoader model_file（combo 空） | SeC 分割模型未下（README 指引） |

已修待重启：kernels 0.15.2、DepthAnythingV2 补全（均挂 :8196 重启窗口）。

## C. 应用数据顽固（剩余 10 条）

| app | 现象 | 说明 |
|---|---|---|
| 6866908162 / 8653018114 | TrimAudioDuration 超音频长度 | 起止倒置已修；超长度需音频上下文，构建期无法 clamp |
| 5262675969 | Invalid value provided for INT | 绑定类型 coerce 产品候选（runner ensure_int 已兜） |
| 4834981890 | Image Rembg 缺 rembg_model 链接 | 需注入 Image Remove Background Model Loader 节点+接线 |
| 8874754048 | Text Load Line From File 缺 file | 文本文件输入未绑槽 |
| 4620144641 / 7663587330 / 1612537858 | 媒体转运读取图片失败（bound 槽源文件缺失） | stale 规则只剥**未绑定** Load*；bound 媒体源缺失会在转运期炸——产品候选：转运前 fail-fast 校验源文件存在 |
| 8846564353 / 7974787073（若 wave21 仍败落此） | VHS/LoadImage hash 媒体 | stale 规则覆盖后仍败=RH 原站媒体真缺失 |

## D. 产品深层（剩余 4 条）

| app | 现象 | 说明 |
|---|---|---|
| 2779725826（+6154418176 / 4269198338 旧） | CompressImages/SaveImage 缺 images（Preview-only 深层） | DB 图链接看似完整，提交图被剪；需逐单图核 |
| 6229361666 | division by zero | 节点/数据，repro 在 `.regen_tmp/app_test_matrix_p0/divzero_repro_20260913.json` |
| 2236595201（若 wave21 仍败落此） | 请求 /prompt 失败 | 记录为连接类瞬态，复核后定 |
| 0394349569 upload kind 门 | kind=ltx_i2v 门按 LtxT2V 参数集判，与口型链图不符会 503 误杀 | 产品候选：upload kind 门应按图内真实 loader 判定 |

## 关键机制教训（增补）

3. **nunchaku SM120 只支持 fp4 SVDQ**（is_compatible 硬检），int4 时代模型在 RTX PRO 6000
   上必须逐对找 fp4 对应文件 remap；HF `nunchaku-ai/nunchaku-qwen-image[-edit]` 两库
   lightning 各档位 fp4/int4 同名成对，表驱动即可。
4. **hf CLI（huggingface_hub 1.23）在 hf-mirror 下走 xet CAS 会被 401**；
   大文件下载用 curl/aria2 直拉 `hf-mirror.com/<repo>/resolve/main/<file>`（127MB/s 实测）。
5. **真机「缺模型/缺节点」类残差必须逐条对当前 object_info 复核**——本轮 80 条中
   19 条（24%）是下载/修复先于 census 运行的时序残差，无需改码。
