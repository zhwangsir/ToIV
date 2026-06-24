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
    assert hi["model"] == ["3", 0]
    assert lo["model"] == ["4", 0]
    assert hi["start_at_step"] == 0 and hi["end_at_step"] == 2
    assert lo["start_at_step"] == 2 and lo["end_at_step"] == 4
    assert lo["latent_image"] == ["11", 0]  # 低噪接高噪输出
    assert hi["add_noise"] == "enable" and lo["add_noise"] == "disable"


def test_decode_and_save_video():
    g = build_wan_i2v_graph(WanI2VParams(positive="x", image="a.png", fps=20))
    assert g["13"]["inputs"]["samples"] == ["12", 0]
    # 输出真 mp4(h264),供分享/下载/自动剪辑拼接
    assert g["14"]["class_type"] == "VHS_VideoCombine"
    assert g["14"]["inputs"]["format"] == "video/h264-mp4"
    assert g["14"]["inputs"]["frame_rate"] == 20.0
