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
