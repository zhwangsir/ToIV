from app.services.app_smoke import smoke_limit


def test_light_image_graph_keeps_image_limit():
    g = {"1": {"class_type": "KSampler", "inputs": {}}, "2": {"class_type": "SaveImage", "inputs": {}}}
    assert smoke_limit(g, "image") == 480


def test_heavy_node_graph_gets_video_limit():
    g = {"1": {"class_type": "RIFEInterpolation", "inputs": {}}}
    assert smoke_limit(g, "image") == 1800
    g2 = {"1": {"class_type": "llama_cpp_model_loader", "inputs": {}}}
    assert smoke_limit(g2, "image") == 1800


def test_heavy_weight_name_gets_video_limit():
    g = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "Wan2.2_Remix_i2v_14b_high.safetensors"}}}
    assert smoke_limit(g, "image") == 1800


def test_video_kind_and_override():
    assert smoke_limit({}, "video") == 1800
    assert smoke_limit({}, "image", 1200) == 1200
    assert smoke_limit({}, "image", 99999) == 3600
