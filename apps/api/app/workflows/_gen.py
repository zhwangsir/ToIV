"""生成 ComfyUI UI 格式工作流 JSON(节点位置 + 连接)。"""
import json
from pathlib import Path

OUT = Path(__file__).parent


def node(
    nid: int,
    typ: str,
    pos: tuple[float, float],
    size: tuple[float, float],
    inputs: list | None = None,
    outputs: list | None = None,
    widgets: list | None = None,
    order: int = 0,
):
    # 输出槽位索引必须与列表顺序一致,否则 ComfyUI 渲染时连线会错位
    outs = outputs or []
    for idx, o in enumerate(outs):
        if isinstance(o, dict):
            o.setdefault("slot_index", idx)
    return {
        "id": nid,
        "type": typ,
        "pos": list(pos),
        "size": {"0": size[0], "1": size[1]},
        "flags": {},
        "order": order,
        "mode": 0,
        "inputs": inputs or [],
        "outputs": outs,
        "properties": {"Node name for S&R": typ},
        "widgets_values": widgets or [],
    }


def output(name: str, typ: str, slot: int = 0, links: list | None = None):
    return {"name": name, "type": typ, "links": links or [], "shape": 3, "slot_index": slot}


def input_(name: str, typ: str, link: int | None = None):
    return {"name": name, "type": typ, "link": link}


def make_link(link_id: int, from_node: int, from_slot: int, to_node: int, to_slot: int, typ: str):
    return [link_id, from_node, from_slot, to_node, to_slot, typ]


def save(name: str, workflow: dict):
    (OUT / name).write_text(json.dumps(workflow, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"saved {OUT / name}")


def _finalize(nodes: list[dict], links: list[list]) -> dict:
    """组装成 ComfyUI UI 可识别的完整工作流对象。"""
    return {
        "last_node_id": max(n["id"] for n in nodes),
        "last_link_id": max(l[0] for l in links) if links else 0,
        "nodes": nodes,
        "links": links,
        "groups": [],
        "config": {},
        "extra": {},
        "version": 0.4,
    }


def txt2img():
    """基础文生图: Checkpoint + CLIP×2 + EmptyLatent + KSampler + VAE + SaveImage。"""
    n1 = node(1, "CheckpointLoaderSimple", (30, 30), (320, 100), outputs=[output("MODEL", "MODEL"), output("CLIP", "CLIP"), output("VAE", "VAE")], widgets=["flux2_dev_fp8mixed.safetensors"], order=0)
    n2 = node(2, "CLIPTextEncode", (30, 180), (400, 120), inputs=[input_("clip", "CLIP", 1)], outputs=[output("CONDITIONING", "CONDITIONING")], widgets=["1girl, best quality, highly detailed"], order=1)
    n3 = node(3, "CLIPTextEncode", (30, 340), (400, 120), inputs=[input_("clip", "CLIP", 2)], outputs=[output("CONDITIONING", "CONDITIONING")], widgets=["low quality, blurry, watermark, text, bad anatomy"], order=2)
    n4 = node(4, "EmptyLatentImage", (480, 30), (320, 110), outputs=[output("LATENT", "LATENT")], widgets=[1024, 1024, 1], order=3)
    n5 = node(5, "KSampler", (860, 160), (320, 474), inputs=[input_("model", "MODEL", 3), input_("positive", "CONDITIONING", 4), input_("negative", "CONDITIONING", 5), input_("latent_image", "LATENT", 6)], outputs=[output("LATENT", "LATENT")], widgets=[123456789, "randomize", 20, 1.0, "euler", "normal", 1.0], order=4)
    n6 = node(6, "VAEDecode", (1220, 200), (210, 46), inputs=[input_("samples", "LATENT", 7), input_("vae", "VAE", 8)], outputs=[output("IMAGE", "IMAGE")], order=5)
    n7 = node(7, "SaveImage", (1480, 200), (320, 270), inputs=[input_("images", "IMAGE", 9)], outputs=[], widgets=["ToIV_txt2img"], order=6)
    links = [
        make_link(1, 1, 1, 2, 0, "CLIP"),
        make_link(2, 1, 1, 3, 0, "CLIP"),
        make_link(3, 1, 0, 5, 0, "MODEL"),
        make_link(4, 2, 0, 5, 1, "CONDITIONING"),
        make_link(5, 3, 0, 5, 2, "CONDITIONING"),
        make_link(6, 4, 0, 5, 3, "LATENT"),
        make_link(7, 5, 0, 6, 0, "LATENT"),
        make_link(8, 1, 2, 6, 1, "VAE"),
        make_link(9, 6, 0, 7, 0, "IMAGE"),
    ]
    return _finalize([n1, n2, n3, n4, n5, n6, n7], links)


def img2img():
    """基础图生图: Checkpoint + LoadImage + CLIP×2 + KSampler(denoise 0.75) + VAE + SaveImage。"""
    n1 = node(1, "CheckpointLoaderSimple", (30, 30), (320, 100), outputs=[output("MODEL", "MODEL"), output("CLIP", "CLIP"), output("VAE", "VAE")], widgets=["flux2_dev_fp8mixed.safetensors"], order=0)
    n2 = node(2, "LoadImage", (30, 180), (320, 280), outputs=[output("IMAGE", "IMAGE"), output("MASK", "MASK")], widgets=["example.png", "image"], order=1)
    n3 = node(3, "CLIPTextEncode", (400, 30), (400, 120), inputs=[input_("clip", "CLIP", 1)], outputs=[output("CONDITIONING", "CONDITIONING")], widgets=["1girl, best quality, highly detailed"], order=2)
    n4 = node(4, "CLIPTextEncode", (400, 190), (400, 120), inputs=[input_("clip", "CLIP", 2)], outputs=[output("CONDITIONING", "CONDITIONING")], widgets=["low quality, blurry, watermark, text, bad anatomy"], order=3)
    n5 = node(5, "VAEEncode", (400, 350), (210, 46), inputs=[input_("pixels", "IMAGE", 3), input_("vae", "VAE", 4)], outputs=[output("LATENT", "LATENT")], order=4)
    n6 = node(6, "KSampler", (860, 160), (320, 474), inputs=[input_("model", "MODEL", 5), input_("positive", "CONDITIONING", 6), input_("negative", "CONDITIONING", 7), input_("latent_image", "LATENT", 8)], outputs=[output("LATENT", "LATENT")], widgets=[123456789, "randomize", 20, 1.0, "euler", "normal", 0.75], order=5)
    n7 = node(7, "VAEDecode", (1220, 200), (210, 46), inputs=[input_("samples", "LATENT", 9), input_("vae", "VAE", 10)], outputs=[output("IMAGE", "IMAGE")], order=6)
    n8 = node(8, "SaveImage", (1480, 200), (320, 270), inputs=[input_("images", "IMAGE", 11)], outputs=[], widgets=["ToIV_img2img"], order=7)
    links = [
        make_link(1, 1, 1, 3, 0, "CLIP"),
        make_link(2, 1, 1, 4, 0, "CLIP"),
        make_link(3, 2, 0, 5, 0, "IMAGE"),
        make_link(4, 1, 2, 5, 1, "VAE"),
        make_link(5, 1, 0, 6, 0, "MODEL"),
        make_link(6, 3, 0, 6, 1, "CONDITIONING"),
        make_link(7, 4, 0, 6, 2, "CONDITIONING"),
        make_link(8, 5, 0, 6, 3, "LATENT"),
        make_link(9, 6, 0, 7, 0, "LATENT"),
        make_link(10, 1, 2, 7, 1, "VAE"),
        make_link(11, 7, 0, 8, 0, "IMAGE"),
    ]
    return _finalize([n1, n2, n3, n4, n5, n6, n7, n8], links)


def ltx_txt2video():
    """LTX Video 文生视频(NSFW): 使用 10eros + Gemma 3 12B + ltx_vae。"""
    n1 = node(1, "UNETLoader", (30, 30), (340, 80), outputs=[output("MODEL", "MODEL")], widgets=["10eros_v14.safetensors", "default"], order=0)
    n2 = node(2, "LTXVGemmaCLIPModelLoader", (30, 150), (380, 100), outputs=[output("CLIP", "CLIP")], widgets=["gemma3_12b_it/model.safetensors", "10eros_v14.safetensors", 1024], order=1)
    n3 = node(3, "VAELoader", (30, 290), (320, 80), outputs=[output("VAE", "VAE")], widgets=["ltx_vae.safetensors"], order=2)
    n4 = node(4, "CLIPTextEncode", (450, 30), (420, 130), inputs=[input_("clip", "CLIP", 1)], outputs=[output("CONDITIONING", "CONDITIONING")], widgets=["Medium close-up, cinematic lighting, a young woman in a sunlit room, subtle movement, film grain"], order=3)
    n5 = node(5, "CLIPTextEncode", (450, 200), (420, 130), inputs=[input_("clip", "CLIP", 2)], outputs=[output("CONDITIONING", "CONDITIONING")], widgets=["low quality, blurry, distorted anatomy, watermark, text, cartoon, 3d render"], order=4)
    n6 = node(6, "LTXVConditioning", (920, 120), (340, 100), inputs=[input_("positive", "CONDITIONING", 3), input_("negative", "CONDITIONING", 4)], outputs=[output("CONDITIONING", "CONDITIONING"), output("CONDITIONING", "CONDITIONING")], widgets=[16.0], order=5)
    n7 = node(7, "EmptyLTXVLatentVideo", (920, 30), (320, 130), outputs=[output("LATENT", "LATENT")], widgets=[768, 384, 97, 1], order=6)
    n8 = node(8, "KSampler", (1300, 120), (320, 474), inputs=[input_("model", "MODEL", 5), input_("positive", "CONDITIONING", 6), input_("negative", "CONDITIONING", 7), input_("latent_image", "LATENT", 8)], outputs=[output("LATENT", "LATENT")], widgets=[1234567890, "randomize", 20, 1.0, "euler", "normal", 1.0], order=7)
    n9 = node(9, "VAEDecode", (1660, 160), (210, 46), inputs=[input_("samples", "LATENT", 9), input_("vae", "VAE", 10)], outputs=[output("IMAGE", "IMAGE")], order=8)
    n10 = node(10, "VHS_VideoCombine", (1920, 160), (320, 280), inputs=[input_("images", "IMAGE", 11)], outputs=[output("IMAGE", "IMAGE"), output("FLOAT", "FLOAT")], widgets=["video/h264-mp4", 16.0, 0, "ToIV_ltx_txt2video", False, True], order=9)
    links = [
        make_link(1, 2, 0, 4, 0, "CLIP"),
        make_link(2, 2, 0, 5, 0, "CLIP"),
        make_link(3, 1, 0, 8, 0, "MODEL"),
        make_link(4, 4, 0, 6, 0, "CONDITIONING"),
        make_link(5, 5, 0, 6, 1, "CONDITIONING"),
        make_link(6, 6, 0, 8, 1, "CONDITIONING"),
        make_link(7, 6, 1, 8, 2, "CONDITIONING"),
        make_link(8, 7, 0, 8, 3, "LATENT"),
        make_link(9, 8, 0, 9, 0, "LATENT"),
        make_link(10, 3, 0, 9, 1, "VAE"),
        make_link(11, 9, 0, 10, 0, "IMAGE"),
    ]
    return _finalize([n1, n2, n3, n4, n5, n6, n7, n8, n9, n10], links)


def ltx_img2video():
    """LTX Video 图生视频(NSFW): 首帧引导 + 10eros + Gemma 3 12B。"""
    n1 = node(1, "UNETLoader", (30, 30), (340, 80), outputs=[output("MODEL", "MODEL")], widgets=["10eros_v14.safetensors", "default"], order=0)
    n2 = node(2, "LTXVGemmaCLIPModelLoader", (30, 150), (380, 100), outputs=[output("CLIP", "CLIP")], widgets=["gemma3_12b_it/model.safetensors", "10eros_v14.safetensors", 1024], order=1)
    n3 = node(3, "VAELoader", (30, 290), (320, 80), outputs=[output("VAE", "VAE")], widgets=["ltx_vae.safetensors"], order=2)
    n4 = node(4, "CLIPTextEncode", (450, 30), (420, 130), inputs=[input_("clip", "CLIP", 1)], outputs=[output("CONDITIONING", "CONDITIONING")], widgets=["Medium close-up, a young woman gently turns her head, soft natural light, subtle smile, film grain"], order=3)
    n5 = node(5, "CLIPTextEncode", (450, 200), (420, 130), inputs=[input_("clip", "CLIP", 2)], outputs=[output("CONDITIONING", "CONDITIONING")], widgets=["low quality, blurry, distorted anatomy, watermark, text, cartoon, 3d render"], order=4)
    n6 = node(6, "LoadImage", (450, 340), (320, 280), outputs=[output("IMAGE", "IMAGE"), output("MASK", "MASK")], widgets=["example.png", "image"], order=5)
    n7 = node(7, "LTXVImgToVideo", (920, 120), (360, 140), inputs=[input_("positive", "CONDITIONING", 3), input_("negative", "CONDITIONING", 4), input_("vae", "VAE", 12), input_("image", "IMAGE", 13)], outputs=[output("CONDITIONING", "CONDITIONING"), output("CONDITIONING", "CONDITIONING"), output("LATENT", "LATENT")], widgets=[768, 384, 97, 1, 1.0], order=6)
    n8 = node(8, "KSampler", (1340, 120), (320, 474), inputs=[input_("model", "MODEL", 5), input_("positive", "CONDITIONING", 14), input_("negative", "CONDITIONING", 15), input_("latent_image", "LATENT", 16)], outputs=[output("LATENT", "LATENT")], widgets=[1234567890, "randomize", 20, 1.0, "euler", "normal", 1.0], order=7)
    n9 = node(9, "VAEDecode", (1700, 160), (210, 46), inputs=[input_("samples", "LATENT", 17), input_("vae", "VAE", 18)], outputs=[output("IMAGE", "IMAGE")], order=8)
    n10 = node(10, "VHS_VideoCombine", (1960, 160), (320, 280), inputs=[input_("images", "IMAGE", 19)], outputs=[output("IMAGE", "IMAGE"), output("FLOAT", "FLOAT")], widgets=["video/h264-mp4", 16.0, 0, "ToIV_ltx_img2video", False, True], order=9)
    links = [
        make_link(1, 2, 0, 4, 0, "CLIP"),
        make_link(2, 2, 0, 5, 0, "CLIP"),
        make_link(3, 1, 0, 8, 0, "MODEL"),
        make_link(4, 4, 0, 7, 0, "CONDITIONING"),
        make_link(5, 5, 0, 7, 1, "CONDITIONING"),
        make_link(6, 3, 0, 7, 2, "VAE"),
        make_link(7, 6, 0, 7, 3, "IMAGE"),
        make_link(8, 7, 0, 8, 1, "CONDITIONING"),
        make_link(9, 7, 1, 8, 2, "CONDITIONING"),
        make_link(10, 7, 2, 8, 3, "LATENT"),
        make_link(11, 8, 0, 9, 0, "LATENT"),
        make_link(12, 3, 0, 9, 1, "VAE"),
        make_link(13, 9, 0, 10, 0, "IMAGE"),
    ]
    return _finalize([n1, n2, n3, n4, n5, n6, n7, n8, n9, n10], links)


def ltx_lipsync():
    """LTX Video 口型同步(NSFW): 图生视频 + 参考音频驱动。"""
    n1 = node(1, "UNETLoader", (30, 30), (340, 80), outputs=[output("MODEL", "MODEL")], widgets=["10eros_v14.safetensors", "default"], order=0)
    n2 = node(2, "LTXVGemmaCLIPModelLoader", (30, 150), (380, 100), outputs=[output("CLIP", "CLIP")], widgets=["gemma3_12b_it/model.safetensors", "10eros_v14.safetensors", 1024], order=1)
    n3 = node(3, "VAELoader", (30, 290), (320, 80), outputs=[output("VAE", "VAE")], widgets=["ltx_vae.safetensors"], order=2)
    n4 = node(4, "CLIPTextEncode", (450, 30), (420, 130), inputs=[input_("clip", "CLIP", 1)], outputs=[output("CONDITIONING", "CONDITIONING")], widgets=["Close-up portrait speaking, natural lip movement, soft studio light, film grain"], order=3)
    n5 = node(5, "CLIPTextEncode", (450, 200), (420, 130), inputs=[input_("clip", "CLIP", 2)], outputs=[output("CONDITIONING", "CONDITIONING")], widgets=["low quality, blurry, distorted face, watermark, text, cartoon"], order=4)
    n6 = node(6, "LoadImage", (450, 340), (320, 280), outputs=[output("IMAGE", "IMAGE"), output("MASK", "MASK")], widgets=["example.png", "image"], order=5)
    n11 = node(11, "LoadAudio", (450, 640), (320, 80), outputs=[output("AUDIO", "AUDIO")], widgets=["example.wav"], order=6)
    n12 = node(12, "LTXVAudioVAELoader", (450, 750), (340, 80), outputs=[output("AUDIO_VAE", "AUDIO_VAE")], widgets=["mmaudio_large_44k_nsfw_gold_8.5k_final_fp16.safetensors"], order=7)
    n7 = node(7, "LTXVImgToVideo", (920, 120), (360, 140), inputs=[input_("positive", "CONDITIONING", 3), input_("negative", "CONDITIONING", 4), input_("vae", "VAE", 13), input_("image", "IMAGE", 14)], outputs=[output("CONDITIONING", "CONDITIONING"), output("CONDITIONING", "CONDITIONING"), output("LATENT", "LATENT")], widgets=[768, 384, 97, 1, 1.0], order=8)
    n13 = node(13, "LTXVReferenceAudio", (1380, 120), (360, 140), inputs=[input_("model", "MODEL", 5), input_("positive", "CONDITIONING", 20), input_("negative", "CONDITIONING", 21), input_("reference_audio", "AUDIO", 15), input_("audio_vae", "AUDIO_VAE", 16)], outputs=[output("MODEL", "MODEL"), output("CONDITIONING", "CONDITIONING"), output("CONDITIONING", "CONDITIONING")], widgets=[0.5, 0.0, 1.0], order=9)
    n8 = node(8, "KSampler", (1800, 120), (320, 474), inputs=[input_("model", "MODEL", 22), input_("positive", "CONDITIONING", 23), input_("negative", "CONDITIONING", 24), input_("latent_image", "LATENT", 25)], outputs=[output("LATENT", "LATENT")], widgets=[1234567890, "randomize", 20, 1.0, "euler", "normal", 1.0], order=10)
    n9 = node(9, "VAEDecode", (2160, 160), (210, 46), inputs=[input_("samples", "LATENT", 26), input_("vae", "VAE", 27)], outputs=[output("IMAGE", "IMAGE")], order=11)
    n10 = node(10, "VHS_VideoCombine", (2420, 160), (320, 280), inputs=[input_("images", "IMAGE", 28)], outputs=[output("IMAGE", "IMAGE"), output("FLOAT", "FLOAT")], widgets=["video/h264-mp4", 16.0, 0, "ToIV_ltx_lipsync", False, True], order=12)
    links = [
        make_link(1, 2, 0, 4, 0, "CLIP"),
        make_link(2, 2, 0, 5, 0, "CLIP"),
        make_link(3, 1, 0, 13, 0, "MODEL"),
        make_link(4, 4, 0, 7, 0, "CONDITIONING"),
        make_link(5, 5, 0, 7, 1, "CONDITIONING"),
        make_link(6, 3, 0, 7, 2, "VAE"),
        make_link(7, 6, 0, 7, 3, "IMAGE"),
        make_link(8, 7, 0, 13, 1, "CONDITIONING"),
        make_link(9, 7, 1, 13, 2, "CONDITIONING"),
        make_link(10, 11, 0, 13, 3, "AUDIO"),
        make_link(11, 12, 0, 13, 4, "AUDIO_VAE"),
        make_link(12, 7, 2, 8, 3, "LATENT"),
        make_link(13, 13, 0, 8, 0, "MODEL"),
        make_link(14, 13, 1, 8, 1, "CONDITIONING"),
        make_link(15, 13, 2, 8, 2, "CONDITIONING"),
        make_link(16, 3, 0, 9, 1, "VAE"),
        make_link(17, 8, 0, 9, 0, "LATENT"),
        make_link(18, 9, 0, 10, 0, "IMAGE"),
    ]
    return _finalize([n1, n2, n3, n4, n5, n6, n11, n12, n7, n13, n8, n9, n10], links)


if __name__ == "__main__":
    save("txt2img_basic.json", txt2img())
    save("img2img_basic.json", img2img())
    save("ltx_txt2video.json", ltx_txt2video())
    save("ltx_img2video.json", ltx_img2video())
    save("ltx_lipsync.json", ltx_lipsync())
