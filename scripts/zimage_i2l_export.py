#!/usr/bin/env python3
"""Z-Image i2L(风格图 → LoRA)冒烟导出脚本 —— 在 workstation 上运行。

用法(workstation,GPU 任选,显存需求 ~26G bf16):
    /home/merlin/diffsynth-venv/bin/python scripts/zimage_i2l_export.py \
        --images /path/style1.png /path/style2.png [/path/style3.png ...] \
        --out /path/to/lora.safetensors \
        [--demo-prompt "a cat sitting on a stone"] [--gpu 0]

流程:
  1. ZImagePipeline 加载 Z-Image base(diffusers 格式 transformer)+ Turbo 的 TE/VAE/tokenizer
     (全部本地路径,不走网络;base 与 turbo 的 TE/VAE 完全共用,与 ComfyUI 侧一致);
  2. TemplatePipeline 加载 DiffSynth-Studio ZImage-i2L-v2 元模型(NAS zimage_i2l/);
  3. 风格图经元模型一次前向产出 LoRA 权重(DiffSynth 键名格式);
  4. 键名转换为 ComfyUI LoraLoaderModelOnly 兼容格式
     (layers.*.lora_A.default.weight → diffusion_model.layers.*.lora_A.weight,
      对照实测可加载的 pixel_art_style_z_image_turbo.safetensors);
  5. 可选:用同一 pipe + 刚导出的 LoRA 出一张 demo 图验证风格生效。

产物:lora.safetensors(ComfyUI 兼容)+ demo.png(可选)。
依赖:DiffSynth-Studio(/home/merlin/DiffSynth-Studio,pip install -e . 于 diffsynth-venv)。
"""
from __future__ import annotations

import argparse
import glob
import os
import sys


def parse_args():
    ap = argparse.ArgumentParser(description="Z-Image i2L 风格 LoRA 导出冒烟")
    ap.add_argument("--images", nargs="+", required=True, help="2-4 张同风格图路径")
    ap.add_argument("--out", required=True, help="输出 lora.safetensors 路径")
    ap.add_argument("--demo-prompt", default="", help="非空则用导出的 LoRA 出一张 demo 图")
    ap.add_argument("--gpu", default="0", help="CUDA 卡号(默认 0)")
    ap.add_argument("--steps", type=int, default=50, help="demo 图采样步数(官方 i2L 示例 50)")
    ap.add_argument("--cfg", type=float, default=4.0, help="demo 图 CFG(官方 i2L 示例 4)")
    # 权重路径默认指向 NAS(workstation 挂载点);可用环境变量覆盖
    ap.add_argument("--z-image-dir", default=os.environ.get(
        "ZIMAGE_DIFFUSERS_DIR", "/home/merlin/nas_mount/toiv/zimage_diffusers"))
    ap.add_argument("--i2l-dir", default=os.environ.get(
        "ZIMAGE_I2L_DIR", "/home/merlin/nas_mount/toiv/comfyui-models/zimage_i2l"))
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    os.environ["CUDA_VISIBLE_DEVICES"] = args.gpu
    os.environ.setdefault("DIFFSYNTH_SKIP_DOWNLOAD", "true")  # 全本地路径,禁止联网下载

    import torch
    from PIL import Image
    from safetensors.torch import save_file

    from diffsynth.diffusion.template import TemplatePipeline
    from diffsynth.pipelines.z_image import ModelConfig, ZImagePipeline

    zdir, tdir = args.z_image_dir, args.i2l_dir
    base, turbo = os.path.join(zdir, "z-image"), os.path.join(zdir, "z-image-turbo")

    def files(*parts: str) -> list[str]:
        hits = sorted(glob.glob(os.path.join(*parts)))
        if not hits:
            raise FileNotFoundError(os.path.join(*parts))
        return hits

    print("[1/4] 加载 ZImagePipeline(base transformer + turbo TE/VAE/tokenizer)...", flush=True)
    pipe = ZImagePipeline.from_pretrained(
        torch_dtype=torch.bfloat16,
        device="cuda",
        model_configs=[
            ModelConfig(path=files(base, "transformer", "*.safetensors")),
            ModelConfig(path=files(turbo, "text_encoder", "*.safetensors")),
            ModelConfig(path=files(turbo, "vae", "diffusion_pytorch_model.safetensors")),
        ],
        tokenizer_config=ModelConfig(path=os.path.join(turbo, "tokenizer")),
    )
    pipe.enable_lora_hot_loading(pipe.dit)

    print("[2/4] 加载 i2L 元模型(DiffSynth-Studio/ZImage-i2L-v2)...", flush=True)
    template = TemplatePipeline.from_pretrained(
        torch_dtype=torch.bfloat16,
        device="cuda",
        model_configs=[ModelConfig(path=tdir)],
    )

    images = [Image.open(p).convert("RGB") for p in args.images]
    print(f"[3/4] {len(images)} 张风格图 → LoRA 权重...", flush=True)
    cache = template.call_single_side(pipe=pipe, inputs=[{"image": images}])
    lora = cache.get("lora")
    if not lora:
        print("!! template_cache 中无 lora 键,i2L 模型未产出 LoRA", file=sys.stderr)
        return 1

    # DiffSynth 键名 → ComfyUI LoraLoaderModelOnly 兼容键名
    converted = {}
    for k, v in lora.items():
        nk = "diffusion_model." + k.replace(".lora_A.default.weight", ".lora_A.weight") \
                                   .replace(".lora_B.default.weight", ".lora_B.weight")
        converted[nk] = v.contiguous().to(torch.bfloat16).cpu()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    save_file(converted, args.out)
    print(f"    导出 {len(converted)} 个张量 → {args.out}", flush=True)

    if args.demo_prompt:
        import numpy as np
        print("[4/4] 用导出的 LoRA 出 demo 图...", flush=True)
        image = template(
            pipe,
            prompt=args.demo_prompt,
            seed=0, cfg_scale=args.cfg, num_inference_steps=args.steps,
            template_inputs=[{"image": images}],
            negative_template_inputs=[{
                "image": [Image.fromarray(np.zeros_like(np.array(i)) + 128) for i in images],
            }],
        )
        demo_path = os.path.splitext(args.out)[0] + "_demo.png"
        image.save(demo_path)
        print(f"    demo 图 → {demo_path}", flush=True)
    print("OK", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
