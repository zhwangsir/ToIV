"""Wan2.1-VACE 14B 工作流构建 —— 多参考图(+可选首尾帧)→ 视频。

节点结构/连线照搬官方示例 wanvideo_1_3B_VACE_examples_03.json(:8197 实例 /object_info 实测),
差异:官方示例为 1.3B 主模型 + WanVideoVACEModelSelect 独立模块;本链路用
Comfy-Org repackaged 完整 14B 权重(已含 vace_blocks,kijai loader 自动检测,
nodes_model_loading.py:1325),无需 VACEModelSelect。

关键约束(踩坑记录,勿改):
  · rope_function 必须 "comfy"(同 LongCat,否则 4096 vs 128 维度错);
  · base_precision="bf16"、load_device="offload_device"、attention_mode="sdpa"、
    quantization="fp8_e4m3fn"(fp16 权重运行时量化,等效 fp8 显存)—— GPU0 与 ComfyUI 池/LongCat 共卡;
  · num_frames 必须 4k+1(WanVideo 系时序网格);
  · 多参考图经 ImageConcatMulti(KJNodes,direction=right,match_image_size=True)合成 batch
    喂 WanVideoVACEEncode.ref_images;单张则直连,不走 concat(节点 inputcount≥2);
  · 首尾帧为可选支路:给了 start_image/end_image 才建 WanVideoVACEStartToEndFrame,
    其 images/masks 接 VACEEncode.input_frames/input_masks(官方示例连线)。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# 模型资产(实例 extra_model_paths 已指向 NAS;文件名按 :8197 /object_info 实测硬编码)
DEFAULT_MODEL = "wan2.1_vace_14B_fp16.safetensors"  # Comfy-Org repackaged 完整权重(含 VACE 模块)
DEFAULT_T5 = "umt5-xxl-enc-fp8_e4m3fn.safetensors"
DEFAULT_VAE = "Wan2_1_VAE_bf16.safetensors"

BLOCK_SWAP = 20  # 块交换(GPU2 共卡控制峰值)
MAX_REF_IMAGES = 4  # 多参考图上限(拼接 batch 喂 VACEEncode)

# 视频到视频编辑(Runway Aleph 式 in-context):编辑模式枚举 + 关键帧锚点上限
EDIT_MODES = ("object_replace", "object_remove", "style_transfer", "relight", "camera_change")
MAX_KEYFRAMES = 5  # 关键帧锚点上限(对标 Aleph 2.0 ≤5 关键帧)

# ── MagCache 加速档(2026-08-28 Phase 2B;NeurIPS 2025,Wan2.1-VACE 官方校准)──
# 节点用 WanVideoWrapper 内置 WanVideoMagCache(:8197 object_info 实证可用)——VACE 链路
# 是 wrapper 链(WanVideoModelLoader→WanVideoSampler),原生 ComfyUI-MagCache 节点只认
# 原生 MODEL 对象不通用;calibration mag_ratios 由 wrapper 按 model_variant 自动选
# (14B 数组与官方 wan2.1_vace_14B 完全一致,nodes_model_loading.py:1367)。
ACCEL_MODES = ("off", "magcache")
MAGCACHE_THRESH = 0.06   # 官方节点默认阈值(ComfyUI-MagCache INPUT_TYPES;纸面 2.68x 即此校准)
MAGCACHE_K = 2           # 官方默认最大连跳步数
MAGCACHE_RETENTION = 0.2  # 官方 retention_ratio:前 20% 步不缓存(构图保护)


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


def snap_frames_4k1(v: int) -> int:
    """WanVideo 系帧数网格 (T-1)%4==0:向上取整到 4k+1。"""
    return (max(1, v) - 1 + 3) // 4 * 4 + 1


@dataclass(frozen=True)
class WanVaceParams:
    """Wan2.1-VACE 多参考图视频参数。seed 缺省随机(与 longcat 同一惯例)。

    ref_images 为 :8197 实例 input 目录文件名列表(路由层负责从 pool worker 转运),
    1-4 张;start_image/end_image 可选(首尾帧约束)。num_frames 自动取整 4k+1。
    """

    positive: str
    ref_images: tuple[str, ...]
    negative: str = ""
    start_image: str = ""
    end_image: str = ""
    # Motion Brush 局部动效 mask(POST /api/motion-brush/mask 产物,:8197 input 目录文件名):
    # 灰度 0=静止/255=运动,接 VACEEncode.input_masks;与首尾帧支路同给时
    # 经 MaskComposite(add) 合并(官方示例 input_masks 只此一口,首尾帧 masks 优先保留)
    motion_mask: str = ""
    width: int = 832
    height: int = 480
    num_frames: int = 81    # 17-241,自动取整 4k+1;81 帧@16fps≈5s
    steps: int = 20         # 官方示例 20 步(unipc)
    cfg: float = 5.0        # 官方示例 4-5 区间取 5
    shift: float = 8.0      # 官方示例值
    strength: float = 1.0   # VACE 条件强度(官方示例 1.0)
    fps: int = 16
    # 加速档(2026-08-28 Phase 2B,沿用 wan_i2v accel 风格):off=满血(默认,零行为变化)
    # / magcache=MagCache 缓存加速(WanVideoMagCache 串在 model loader 与采样器之间)
    accel: str = "off"
    cache_thresh: float = MAGCACHE_THRESH  # 仅 magcache 档启用;官方 Wan2.1 校准默认
    cache_k: int = MAGCACHE_K
    seed: int = field(default_factory=_random_seed)
    model_name: str = DEFAULT_MODEL
    t5_name: str = DEFAULT_T5
    vae_name: str = DEFAULT_VAE
    filename_prefix: str = "ToIV_wan/vace"

    def __post_init__(self) -> None:
        object.__setattr__(self, "num_frames", snap_frames_4k1(self.num_frames))


def _ref_image_branch(graph: dict, p: WanVaceParams) -> list:
    """参考图支路:每张 LoadImage → ImageResizeKJv2(16 对齐 crop);
    多张经 ImageConcatMulti 合成 batch。返回喂 ref_images 的 [node, 0] 引用。"""
    resize_ids: list[str] = []
    for i, name in enumerate(p.ref_images):
        load_id = f"{20 + i * 2}"
        resize_id = f"{21 + i * 2}"
        graph[load_id] = {"class_type": "LoadImage", "inputs": {"image": name}}
        graph[resize_id] = {"class_type": "ImageResizeKJv2", "inputs": {
            "image": [load_id, 0], "width": p.width, "height": p.height,
            "upscale_method": "lanczos", "keep_proportion": "crop",
            "pad_color": "0, 0, 0", "crop_position": "center",
            "divisible_by": 16, "device": "cpu"}}
        resize_ids.append(resize_id)
    if len(resize_ids) == 1:
        return [resize_ids[0], 0]
    concat_inputs: dict = {
        "inputcount": len(resize_ids), "direction": "right", "match_image_size": True}
    for i, rid in enumerate(resize_ids, start=1):
        concat_inputs[f"image_{i}"] = [rid, 0]
    graph["30"] = {"class_type": "ImageConcatMulti", "inputs": concat_inputs}
    return ["30", 0]


def _apply_accel(graph: dict, p: WanVaceParams) -> None:
    """加速档接线:magcache 时建 WanVideoMagCache 节点,输出 CACHEARGS 接采样器 cache_args。

    节点语义(:8197 object_info 2026-08-28 实证):VACE 为 Wan2.1 非 MoE 单模型,只串一个
    cache 节点(与 wan_i2v 双专家 EasyCache×2 分流);start_step 是绝对步号,官方
    retention_ratio=0.2(前 20% 步不缓存,构图保护)按实际步数映射,下限 1(首步永不缓存);
    end_step=-1 到尾;cache_device=offload_device(与 block_swap 共卡策略一致)。
    """
    if p.accel == "off":
        return
    if p.accel != "magcache":
        raise ValueError(f"未知 VACE 加速档: {p.accel!r}(可选 {'/'.join(ACCEL_MODES)})")
    graph["17"] = {"class_type": "WanVideoMagCache", "inputs": {
        "magcache_thresh": p.cache_thresh, "magcache_K": p.cache_k,
        "start_step": max(1, round(p.steps * MAGCACHE_RETENTION)), "end_step": -1,
        "cache_device": "offload_device"}}
    graph["13"]["inputs"]["cache_args"] = ["17", 0]


def build_wan_vace_graph(p: WanVaceParams) -> dict:
    """参数 → ComfyUI API 格式图(节点语义对照官方示例 wanvideo_1_3B_VACE_examples_03)。"""
    if not p.ref_images:
        raise ValueError("VACE 链路至少需要 1 张参考图")
    if len(p.ref_images) > MAX_REF_IMAGES:
        raise ValueError(f"VACE 参考图最多 {MAX_REF_IMAGES} 张")

    graph: dict[str, dict] = {
        "1": {"class_type": "WanVideoModelLoader", "inputs": {
            "model": p.model_name,
            "base_precision": "bf16", "quantization": "fp8_e4m3fn",
            "load_device": "offload_device", "attention_mode": "sdpa",
            "block_swap_args": ["2", 0]}},
        "2": {"class_type": "WanVideoBlockSwap", "inputs": {
            "blocks_to_swap": BLOCK_SWAP, "offload_img_emb": True, "offload_txt_emb": True,
            # optional 缺省不会注入默认值 → vace_blocks_to_swap=None 会炸 TypeError
            # (同 wan_animate.py 踩坑,2026-08-13 冒烟实测);VACE 模型 vace_blocks 15 个,
            # 共卡给 8 个交换(官方 1.3B 示例全换 15)
            "use_non_blocking": True, "vace_blocks_to_swap": 8,
            "prefetch_blocks": 1, "block_swap_debug": False}},
        "3": {"class_type": "WanVideoVAELoader", "inputs": {
            "model_name": p.vae_name, "precision": "bf16"}},
        "4": {"class_type": "LoadWanVideoT5TextEncoder", "inputs": {
            "model_name": p.t5_name,
            "precision": "bf16", "load_device": "offload_device"}},
        "5": {"class_type": "WanVideoTextEncode", "inputs": {
            "positive_prompt": p.positive,
            "negative_prompt": p.negative,
            "t5": ["4", 0]}},
        "13": {"class_type": "WanVideoSampler", "inputs": {
            "model": ["1", 0], "text_embeds": ["5", 0], "image_embeds": ["10", 0],
            "steps": p.steps, "cfg": p.cfg, "shift": p.shift, "seed": p.seed,
            "force_offload": True, "scheduler": "unipc",
            "riflex_freq_index": 0, "rope_function": "comfy"}},
        "14": {"class_type": "WanVideoDecode", "inputs": {
            "vae": ["3", 0], "samples": ["13", 0], "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144, "tile_stride_y": 128}},
        "15": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["14", 0], "frame_rate": p.fps, "loop_count": 0,
            "filename_prefix": p.filename_prefix, "format": "video/h264-mp4",
            "pix_fmt": "yuv420p", "crf": 19, "save_metadata": True,
            "trim_to_audio": False, "pingpong": False, "save_output": True}},
    }

    # 参考图支路(节点 20/21/22/... + 可选 concat 30)
    vace_inputs: dict = {
        "vae": ["3", 0], "ref_images": _ref_image_branch(graph, p),
        "width": p.width, "height": p.height, "num_frames": p.num_frames,
        "strength": p.strength, "vace_start_percent": 0.0, "vace_end_percent": 1.0}

    # 可选首尾帧支路(官方示例:StartToEndFrame → input_frames/input_masks)
    if p.start_image or p.end_image:
        if p.start_image:
            graph["40"] = {"class_type": "LoadImage", "inputs": {"image": p.start_image}}
            graph["41"] = {"class_type": "ImageResizeKJv2", "inputs": {
                "image": ["40", 0], "width": p.width, "height": p.height,
                "upscale_method": "lanczos", "keep_proportion": "crop",
                "pad_color": "0, 0, 0", "crop_position": "center",
                "divisible_by": 16, "device": "cpu"}}
        if p.end_image:
            graph["42"] = {"class_type": "LoadImage", "inputs": {"image": p.end_image}}
            graph["43"] = {"class_type": "ImageResizeKJv2", "inputs": {
                "image": ["42", 0], "width": p.width, "height": p.height,
                "upscale_method": "lanczos", "keep_proportion": "crop",
                "pad_color": "0, 0, 0", "crop_position": "center",
                "divisible_by": 16, "device": "cpu"}}
        s2e_inputs: dict = {"num_frames": p.num_frames, "empty_frame_level": 0.5}
        if p.start_image:
            s2e_inputs["start_image"] = ["41", 0]
        if p.end_image:
            s2e_inputs["end_image"] = ["43", 0]
        graph["44"] = {"class_type": "WanVideoVACEStartToEndFrame", "inputs": s2e_inputs}
        vace_inputs["input_frames"] = ["44", 0]
        vace_inputs["input_masks"] = ["44", 1]

    # Motion Brush 局部动效 mask 支路(services/motion_brush 产物,:8197 input 目录):
    # LoadImage → ImageToMask(channel="red";alpha 通道是方向角编码,不可直接当 MASK)
    if p.motion_mask:
        graph["50"] = {"class_type": "LoadImage", "inputs": {"image": p.motion_mask}}
        graph["51"] = {"class_type": "ImageToMask", "inputs": {
            "image": ["50", 0], "channel": "red"}}
        if "input_masks" in vace_inputs:
            # 与首尾帧 masks 并存:input_masks 官方示例只此一口,MaskComposite multiply
            # 取交集(首尾帧保持区 × 动效区 → 仅标记区域可动,两约束同时生效)
            graph["52"] = {"class_type": "MaskComposite", "inputs": {
                "destination": vace_inputs["input_masks"], "source": ["51", 0],
                "x": 0, "y": 0, "operation": "multiply"}}
            vace_inputs["input_masks"] = ["52", 0]
        else:
            vace_inputs["input_masks"] = ["51", 0]

    graph["10"] = {"class_type": "WanVideoVACEEncode", "inputs": vace_inputs}
    _apply_accel(graph, p)
    return graph


# --------------------------------------------------------------------------- #
# 视频到视频编辑(Runway Aleph 式 in-context 编辑)
# --------------------------------------------------------------------------- #
#
# 原理(节点语义经 :8197 object_info + WanVideoWrapper nodes.py 源码双重实证,2026-08-26):
#   源视频帧序列喂 WanVideoVACEEncode.input_frames,input_masks 逐帧控制保留/重生成:
#     mask=0 → 该帧/区域作为不可变锚点保留(inactive 潜变量);
#     mask=1 → 该帧/区域由模型按 prompt 重生成(reactive 潜变量);
#   edit_prompt 描述编辑指令(只改你要求的),VACE 在潜空间做 in-context 编辑,
#   关键帧锚点的内容向全片传播(改一帧 → 全片传播)。
#   不传 input_masks 时 wrapper 默认全 1(整片按源帧上下文重生成,风格/打光/机位类编辑)。
#
# mask 批构建约束(:8197 object_info 2026-08-26 实证):
#   实例无 RepeatMaskBatch/MaskFromBatch,MASK 批只能经 IMAGE 批组装
#   (RepeatImageBatch/ImageBatch)→ ImageToMask(channel=red) 转换;
#   ImageBatch 拼接要求同尺寸,fill/锚点图像统一归一到 p.width×p.height
#   (preserve_mask 任意尺寸经 ImageScale nearest-exact 归一,ImageScale 已实证存在)。


@dataclass(frozen=True)
class WanVaceEditParams(WanVaceParams):
    """Wan2.1-VACE 视频到视频编辑参数(继承多参考图参数;ref_images 置空不走参考支路)。

    source_video 为 :8197 实例 input 目录文件名(路由层负责从 pool worker 转运);
    edit_prompt 为编辑指令(英文;置空回退 positive);keyframe_indices 为可选编辑锚点
    (0 基帧索引,≤5;锚点帧 mask=0 整帧保留,其余帧重生成);preserve_mask 为可选区域
    保留 mask(实例 input 目录图片文件名;白色区域保留不动,黑色区域重生成,
    与 Motion Brush 集成预留)。

    ⚠️ motion_mask 字段继承自父类但编辑图**不消费**(节点 50 已被源视频占用);
    编辑区域控制唯一通道是 preserve_mask。误传 motion_mask 会在 __post_init__ 拒绝。
    """

    source_video: str = ""
    edit_prompt: str = ""
    edit_mode: str = "style_transfer"
    keyframe_indices: tuple[int, ...] = ()
    preserve_mask: str = ""
    filename_prefix: str = "ToIV_wan/vace_edit"  # 编辑产物独立前缀(与多参考图产物分流)

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.motion_mask:
            raise ValueError(
                "视频编辑不支持 motion_mask(节点冲突);编辑区域控制请用 preserve_mask"
            )


def _edit_mask_branch(graph: dict, p: WanVaceEditParams) -> list:
    """构建 num_frames 长度的编辑 mask 批 → 喂 VACEEncode.input_masks 的 [node, 0] 引用。

    关键帧位=0(整帧保留锚点),其余帧=fill(全 1 重生成 / preserve_mask 区域控制)。
    """
    kfs = sorted(set(p.keyframe_indices))
    # fill(重生成)图像:有区域保留 mask → LoadImage→ImageToMask(red)→InvertMask(白=保留→0)
    # →MaskToImage→ImageScale 归一;否则 SolidMask(1.0) 全白(整帧重生成)
    if p.preserve_mask:
        graph["62"] = {"class_type": "LoadImage", "inputs": {"image": p.preserve_mask}}
        graph["63"] = {"class_type": "ImageToMask", "inputs": {
            "image": ["62", 0], "channel": "red"}}
        graph["64"] = {"class_type": "InvertMask", "inputs": {"mask": ["63", 0]}}
        graph["65"] = {"class_type": "MaskToImage", "inputs": {"mask": ["64", 0]}}
        graph["66"] = {"class_type": "ImageScale", "inputs": {
            "image": ["65", 0], "upscale_method": "nearest-exact",
            "width": p.width, "height": p.height, "crop": "disabled"}}
        fill_ref = "66"
    else:
        graph["62"] = {"class_type": "SolidMask", "inputs": {
            "value": 1.0, "width": p.width, "height": p.height}}
        graph["65"] = {"class_type": "MaskToImage", "inputs": {"mask": ["62", 0]}}
        fill_ref = "65"

    if not kfs:
        # 无关键帧:整条 fill(mask 全 1 / 区域控制)
        graph["70"] = {"class_type": "RepeatImageBatch", "inputs": {
            "image": [fill_ref, 0], "amount": p.num_frames}}
        graph["90"] = {"class_type": "ImageToMask", "inputs": {
            "image": ["70", 0], "channel": "red"}}
        return ["90", 0]

    # 关键帧锚点帧:SolidMask(0.0) 全黑(整帧保留)
    graph["60"] = {"class_type": "SolidMask", "inputs": {
        "value": 0.0, "width": p.width, "height": p.height}}
    graph["61"] = {"class_type": "MaskToImage", "inputs": {"mask": ["60", 0]}}

    # 段组装:fill 连续段 RepeatImageBatch + 锚点单帧,ImageBatch 链接
    segments: list[str] = []
    prev = 0
    nid = 70
    for k in kfs:
        if k - prev > 0:
            graph[str(nid)] = {"class_type": "RepeatImageBatch", "inputs": {
                "image": [fill_ref, 0], "amount": k - prev}}
            segments.append(str(nid))
            nid += 1
        segments.append("61")
        prev = k + 1
    if p.num_frames - prev > 0:
        graph[str(nid)] = {"class_type": "RepeatImageBatch", "inputs": {
            "image": [fill_ref, 0], "amount": p.num_frames - prev}}
        segments.append(str(nid))
        nid += 1
    cur = segments[0]
    for seg in segments[1:]:
        graph[str(nid)] = {"class_type": "ImageBatch", "inputs": {
            "image1": [cur, 0], "image2": [seg, 0]}}
        cur = str(nid)
        nid += 1
    graph["90"] = {"class_type": "ImageToMask", "inputs": {
        "image": [cur, 0], "channel": "red"}}
    return ["90", 0]


def build_wan_vace_edit_graph(p: WanVaceEditParams) -> dict:
    """VACE 视频到视频编辑图(与 build_wan_vace_graph 零冲突:独立函数,骨架节点同构)。

    骨架(模型/T5/VAE/采样/解码/打包)照搬多参考图链路;编辑支路:
      VHS_LoadVideo(源视频,帧数截断同步 num_frames)→ StartToEndFrame.control_images
      (灰帧补齐/截断到 num_frames,VACEEncode 帧数硬约束)→ VACEEncode.input_frames;
      有关键帧/区域 mask 时接 input_masks(全 1 缺省由 wrapper 兜底,不接);
      源视频原声回打包(audio=[50,2],转运层 ensure_audio_track 已兜底无音轨素材)。
    """
    if not p.source_video:
        raise ValueError("VACE 编辑链路需要源视频")
    if p.edit_mode not in EDIT_MODES:
        raise ValueError(f"未知编辑模式(支持 {'/'.join(EDIT_MODES)})")
    if len(p.keyframe_indices) > MAX_KEYFRAMES:
        raise ValueError(f"关键帧锚点最多 {MAX_KEYFRAMES} 个")
    if any(i < 0 or i >= p.num_frames for i in p.keyframe_indices):
        raise ValueError(f"关键帧索引须在 0-{p.num_frames - 1} 之间")
    prompt = p.edit_prompt.strip() or p.positive
    if not prompt:
        raise ValueError("编辑指令不能为空")

    graph: dict[str, dict] = {
        "1": {"class_type": "WanVideoModelLoader", "inputs": {
            "model": p.model_name,
            "base_precision": "bf16", "quantization": "fp8_e4m3fn",
            "load_device": "offload_device", "attention_mode": "sdpa",
            "block_swap_args": ["2", 0]}},
        "2": {"class_type": "WanVideoBlockSwap", "inputs": {
            "blocks_to_swap": BLOCK_SWAP, "offload_img_emb": True, "offload_txt_emb": True,
            # vace_blocks_to_swap 缺省会炸 TypeError(同 build_wan_vace_graph 踩坑)
            "use_non_blocking": True, "vace_blocks_to_swap": 8,
            "prefetch_blocks": 1, "block_swap_debug": False}},
        "3": {"class_type": "WanVideoVAELoader", "inputs": {
            "model_name": p.vae_name, "precision": "bf16"}},
        "4": {"class_type": "LoadWanVideoT5TextEncoder", "inputs": {
            "model_name": p.t5_name,
            "precision": "bf16", "load_device": "offload_device"}},
        "5": {"class_type": "WanVideoTextEncode", "inputs": {
            "positive_prompt": prompt,
            "negative_prompt": p.negative,
            "t5": ["4", 0]}},
        "13": {"class_type": "WanVideoSampler", "inputs": {
            "model": ["1", 0], "text_embeds": ["5", 0], "image_embeds": ["10", 0],
            "steps": p.steps, "cfg": p.cfg, "shift": p.shift, "seed": p.seed,
            "force_offload": True, "scheduler": "unipc",
            "riflex_freq_index": 0, "rope_function": "comfy"}},
        "14": {"class_type": "WanVideoDecode", "inputs": {
            "vae": ["3", 0], "samples": ["13", 0], "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144, "tile_stride_y": 128}},
        # audio=[50,2]:源视频原声回打包(编辑保留原声;无音轨素材转运层已补静音轨)
        "15": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["14", 0], "audio": ["50", 2], "frame_rate": p.fps, "loop_count": 0,
            "filename_prefix": p.filename_prefix, "format": "video/h264-mp4",
            "pix_fmt": "yuv420p", "crf": 19, "save_metadata": True,
            "trim_to_audio": False, "pingpong": False, "save_output": True}},
        # 源视频支路:VHS_LoadVideo(帧数截断与 num_frames 同步;force_rate 重采样到目标 fps;
        # custom_width/height 为 VHS 必填——2026-08-26 冒烟 /prompt 400 实证,同 wan_animate)
        "50": {"class_type": "VHS_LoadVideo", "inputs": {
            "video": p.source_video, "force_rate": p.fps,
            "custom_width": p.width, "custom_height": p.height,
            "frame_load_cap": p.num_frames, "skip_first_frames": 0,
            "select_every_nth": 1, "format": "AnimateDiff"}},
    }

    # 帧数对齐:VACEEncode 要求 input_frames 恰为 num_frames(2026-08-26 冒烟实证:
    # 源视频截断后 16 帧 vs num_frames 17 → vace_encode_frames zip 维度错 RuntimeError);
    # 经 StartToEndFrame control_images 支路(官方喂视频帧的口)灰帧补齐/截断到 num_frames,
    # 其 masks 输出(全 0)弃用,编辑 mask 由 _edit_mask_branch 独立供给
    graph["51"] = {"class_type": "WanVideoVACEStartToEndFrame", "inputs": {
        "num_frames": p.num_frames, "empty_frame_level": 0.5,
        "control_images": ["50", 0]}}

    vace_inputs: dict = {
        "vae": ["3", 0], "input_frames": ["51", 0],
        "width": p.width, "height": p.height, "num_frames": p.num_frames,
        "strength": p.strength, "vace_start_percent": 0.0, "vace_end_percent": 1.0}
    # mask 支路:关键帧锚点/区域保留任一给出才接 input_masks(全 1 由 wrapper 缺省兜底)
    if p.keyframe_indices or p.preserve_mask:
        vace_inputs["input_masks"] = _edit_mask_branch(graph, p)

    graph["10"] = {"class_type": "WanVideoVACEEncode", "inputs": vace_inputs}
    _apply_accel(graph, p)
    return graph
