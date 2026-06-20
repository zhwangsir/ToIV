from app.workflows.txt2img import MAX_SEED, Txt2ImgParams, build_txt2img_graph


def test_graph_has_all_nodes():
    g = build_txt2img_graph(Txt2ImgParams(positive="a cat"))
    assert set(g) == {"3", "4", "5", "6", "7", "8", "9"}
    assert {n["class_type"] for n in g.values()} == {
        "KSampler",
        "CheckpointLoaderSimple",
        "EmptyLatentImage",
        "CLIPTextEncode",
        "VAEDecode",
        "SaveImage",
    }


def test_prompt_text_wired_into_clip_encoders():
    g = build_txt2img_graph(Txt2ImgParams(positive="a corgi", negative="blurry"))
    assert g["6"]["inputs"]["text"] == "a corgi"
    assert g["7"]["inputs"]["text"] == "blurry"
    # 正负编码器都连到 checkpoint 的 CLIP 输出（slot 1）
    assert g["6"]["inputs"]["clip"] == ["4", 1]
    assert g["7"]["inputs"]["clip"] == ["4", 1]


def test_ksampler_links_and_params():
    g = build_txt2img_graph(Txt2ImgParams(positive="x", steps=12, cfg=6.5, seed=42))
    ks = g["3"]["inputs"]
    assert ks["model"] == ["4", 0]
    assert ks["positive"] == ["6", 0]
    assert ks["negative"] == ["7", 0]
    assert ks["latent_image"] == ["5", 0]
    assert ks["steps"] == 12
    assert ks["cfg"] == 6.5
    assert ks["seed"] == 42


def test_decode_and_save_chain():
    g = build_txt2img_graph(Txt2ImgParams(positive="x"))
    assert g["8"]["inputs"]["samples"] == ["3", 0]
    assert g["8"]["inputs"]["vae"] == ["4", 2]
    assert g["9"]["inputs"]["images"] == ["8", 0]
    assert g["9"]["inputs"]["filename_prefix"] == "ToIV"


def test_checkpoint_and_latent_dimensions():
    g = build_txt2img_graph(
        Txt2ImgParams(positive="x", ckpt_name="majicMIX.safetensors", width=768, height=1024)
    )
    assert g["4"]["inputs"]["ckpt_name"] == "majicMIX.safetensors"
    assert g["5"]["inputs"]["width"] == 768
    assert g["5"]["inputs"]["height"] == 1024


def test_returns_new_dict_each_call():
    p = Txt2ImgParams(positive="x", seed=1)
    assert build_txt2img_graph(p) is not build_txt2img_graph(p)


def test_random_seed_in_range_when_unspecified():
    p = Txt2ImgParams(positive="x")
    assert 0 <= p.seed <= MAX_SEED
