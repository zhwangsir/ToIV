from app.workflows.img2img import Img2ImgParams, build_img2img_graph


def test_graph_loads_image_and_encodes():
    g = build_img2img_graph(Img2ImgParams(positive="x", image="photo.png"))
    assert g["10"]["class_type"] == "LoadImage"
    assert g["10"]["inputs"]["image"] == "photo.png"
    assert g["11"]["class_type"] == "VAEEncode"
    assert g["11"]["inputs"]["pixels"] == ["10", 0]
    assert g["11"]["inputs"]["vae"] == ["4", 2]


def test_ksampler_uses_encoded_latent_and_denoise():
    g = build_img2img_graph(Img2ImgParams(positive="x", image="p.png", denoise=0.45))
    ks = g["3"]["inputs"]
    assert ks["latent_image"] == ["11", 0]
    assert ks["denoise"] == 0.45


def test_full_chain_present():
    g = build_img2img_graph(Img2ImgParams(positive="x", image="p.png"))
    assert {n["class_type"] for n in g.values()} == {
        "KSampler",
        "CheckpointLoaderSimple",
        "CLIPTextEncode",
        "LoadImage",
        "VAEEncode",
        "VAEDecode",
        "SaveImage",
    }
    assert g["8"]["inputs"]["samples"] == ["3", 0]
    assert g["9"]["inputs"]["images"] == ["8", 0]
