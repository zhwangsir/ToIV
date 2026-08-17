from app.workflows.wan_i2v import WanI2VParams, build_wan_i2v_graph


def test_dual_model_loaders_with_lightx2v_loras():
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png"))
    assert g["1"]["class_type"] == "UNETLoader"
    assert g["2"]["class_type"] == "UNETLoader"
    assert "high_noise" in g["1"]["inputs"]["unet_name"]
    assert "low_noise" in g["2"]["inputs"]["unet_name"]
    # 加速 LoRA 各挂一个模型
    assert g["3"]["inputs"]["model"] == ["1", 0]
    assert g["4"]["inputs"]["model"] == ["2", 0]


def test_wan_clip_and_image_wiring():
    g = build_wan_i2v_graph(WanI2VParams(positive="hello", image="src.png"))
    assert g["5"]["inputs"]["type"] == "wan"
    assert g["7"]["inputs"]["text"] == "hello"
    assert g["9"]["inputs"]["image"] == "src.png"
    wi = g["10"]["inputs"]
    assert wi["start_image"] == ["9", 0]
    assert wi["positive"] == ["7", 0]
    assert wi["vae"] == ["6", 0]


def test_high_low_sampler_split():
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png", steps=4))
    hi, lo = g["11"]["inputs"], g["12"]["inputs"]
    # 采样器经 ModelSamplingSD3(15/16),而非直连 LoRA
    assert hi["model"] == ["15", 0]
    assert lo["model"] == ["16", 0]
    assert hi["start_at_step"] == 0 and hi["end_at_step"] == 2
    assert lo["start_at_step"] == 2 and lo["end_at_step"] == 4
    assert lo["latent_image"] == ["11", 0]  # 低噪接高噪输出
    assert hi["add_noise"] == "enable" and lo["add_noise"] == "disable"


def test_modelsampling_shift_inserted():
    """四硬伤修复:每个专家后必有 ModelSamplingSD3(shift),否则 Wan 动作/质量崩。"""
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png", shift=5.0))
    assert g["15"]["class_type"] == "ModelSamplingSD3"
    assert g["16"]["class_type"] == "ModelSamplingSD3"
    assert g["15"]["inputs"]["shift"] == 5.0
    # 加速档:ModelSamplingSD3 接在 LoRA 之后
    assert g["15"]["inputs"]["model"] == ["3", 0]
    assert g["16"]["inputs"]["model"] == ["4", 0]


def test_cfg_split_high_low():
    """cfg 不再写死 1.0:high 段拉回引导(动作),low 段细化。"""
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png", high_cfg=3.0, low_cfg=1.0))
    assert g["11"]["inputs"]["cfg"] == 3.0
    assert g["12"]["inputs"]["cfg"] == 1.0


def test_quality_mode_drops_accel_lora():
    """满血档(use_accel_lora=False):不挂加速 LoRA,ModelSamplingSD3 直接接 UNET。"""
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png", use_accel_lora=False))
    assert "3" not in g and "4" not in g
    assert g["15"]["inputs"]["model"] == ["1", 0]
    assert g["16"]["inputs"]["model"] == ["2", 0]


def test_training_sweetspot_defaults():
    """默认分辨率/帧数回到 Wan 训练甜点档(832×480/81),非旧 640×480/49。"""
    p = WanI2VParams(positive="x", image="a.png")
    assert (p.width, p.height, p.length) == (832, 480, 81)


def test_decode_and_save_video():
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png", fps=20))
    assert g["13"]["inputs"]["samples"] == ["12", 0]
    # 输出真 mp4(h264),供分享/下载/自动剪辑拼接
    assert g["14"]["class_type"] == "VHS_VideoCombine"
    assert g["14"]["inputs"]["format"] == "video/h264-mp4"
    assert g["14"]["inputs"]["frame_rate"] == 20.0


# --------------------------------------------------------------------------- #
# NSFW LoRA 叠加链(2026-08-16 Civitai 配方复刻;路由层按 WAN_I2V_NSFW_LORAS 分侧)
# --------------------------------------------------------------------------- #

_V1030 = "Wan_2_2_I2V_A14B_HIGH_lightx2v_4step_lora_v1030_rank_64_bf16.safetensors"


def _lora_nodes(g: dict) -> dict[str, dict]:
    return {nid: n for nid, n in g.items() if n["class_type"] == "LoraLoaderModelOnly"}


def test_nsfw_loras_chain_after_accel_lora_by_side():
    """NSFW LoRA 分侧串联:加速 LoRA 之后、ModelSamplingSD3 之前(加速贴底模,概念/动作后挂)。"""
    g = build_wan_i2v_graph(WanI2VParams(
        positive="x", image="a.png",
        high_loras=(("NSFW-22-H-e8.safetensors", 0.8),),
        low_loras=(("DR34ML4Y_I2V_14B_LOW_V2.safetensors", 0.7),),
    ))
    # 高噪链:1 → 3(加速) → 20(NSFW) → 15(shift)
    assert g["20"]["inputs"]["model"] == ["3", 0]
    assert g["20"]["inputs"]["lora_name"] == "NSFW-22-H-e8.safetensors"
    assert g["20"]["inputs"]["strength_model"] == 0.8
    assert g["15"]["inputs"]["model"] == ["20", 0]
    # 低噪链:2 → 4(加速) → 21(DR34ML4Y) → 16(shift)
    assert g["21"]["inputs"]["model"] == ["4", 0]
    assert g["21"]["inputs"]["lora_name"] == "DR34ML4Y_I2V_14B_LOW_V2.safetensors"
    assert g["21"]["inputs"]["strength_model"] == 0.7
    assert g["16"]["inputs"]["model"] == ["21", 0]


def test_nsfw_loras_multiple_same_side_chain_in_order():
    """同侧多个 LoRA 按给定顺序依次串联(高噪 2 个:3 → 20 → 21 → 15)。"""
    g = build_wan_i2v_graph(WanI2VParams(
        positive="x", image="a.png",
        high_loras=(("A.safetensors", 0.8), ("B.safetensors", 0.7)),
    ))
    assert g["20"]["inputs"]["model"] == ["3", 0]
    assert g["20"]["inputs"]["lora_name"] == "A.safetensors"
    assert g["21"]["inputs"]["model"] == ["20", 0]
    assert g["21"]["inputs"]["lora_name"] == "B.safetensors"
    assert g["15"]["inputs"]["model"] == ["21", 0]
    # 低噪侧无叠加:16 直接接加速 LoRA 4
    assert g["16"]["inputs"]["model"] == ["4", 0]


def test_v1030_replaces_default_accel_lora_not_stacked():
    """v1030 加速 LoRA(高噪链选中)替代默认 v1 加速 LoRA,不双重加速。"""
    g = build_wan_i2v_graph(WanI2VParams(
        positive="x", image="a.png", high_loras=((_V1030, 0.8),),
    ))
    assert g["3"]["inputs"]["lora_name"] == _V1030
    # v1030 不再出现在叠加链(节点 ≥20);低噪加速 LoRA 不变
    extra = [n["inputs"]["lora_name"] for nid, n in _lora_nodes(g).items() if int(nid) >= 20]
    assert _V1030 not in extra
    assert g["4"]["inputs"]["lora_name"] == "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"
    # 高噪链无其他叠加:15 直接接 3
    assert g["15"]["inputs"]["model"] == ["3", 0]


def test_v1030_ignored_in_full_quality_mode():
    """满血档(不挂加速 LoRA):v1030 被忽略,ModelSamplingSD3 直连 UNET。"""
    g = build_wan_i2v_graph(WanI2VParams(
        positive="x", image="a.png", use_accel_lora=False, high_loras=((_V1030, 0.8),),
    ))
    assert "3" not in g and "4" not in g
    assert _lora_nodes(g) == {}  # v1030 剔除后无 LoRA 节点
    assert g["15"]["inputs"]["model"] == ["1", 0]
    assert g["16"]["inputs"]["model"] == ["2", 0]


def test_nsfw_loras_chain_on_unet_in_full_quality_mode():
    """满血档 + NSFW LoRA:叠加链直接挂 UNET(1 → 20 → 15),加速节点不存在。"""
    g = build_wan_i2v_graph(WanI2VParams(
        positive="x", image="a.png", use_accel_lora=False,
        high_loras=(("NSFW-22-H-e8.safetensors", 0.8),),
    ))
    assert "3" not in g and "4" not in g
    assert g["20"]["inputs"]["model"] == ["1", 0]
    assert g["15"]["inputs"]["model"] == ["20", 0]
