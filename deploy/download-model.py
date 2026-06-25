"""ToIV 模型下载器(在 .100 上运行)—— 按类型自动归类到 ComfyUI 对应子目录。

用法:
  # 直链下载,显式指定类型(最可靠)
  python download-model.py --url <URL> --type lora [--name 文件名.safetensors]
  # HuggingFace(走 hf-mirror 镜像),仓库 + 文件
  python download-model.py --hf <repo> --file <path/in/repo.safetensors> --type vae
  # 只测分类不下载
  python download-model.py --name some_model.safetensors --type "" --dry-run

特性:
- 按 显式类型 > 文件名启发式 选目标子目录(checkpoints/loras/vae/diffusion_models/
  text_encoders/clip_vision/controlnet/upscale_models/embeddings…)
- 原子下载:先写 <file>.part,完成后再重命名 → 失败不会留下 ComfyUI 误读的半成品
- 只用 requests(ComfyUI venv 已自带)
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import requests

# 模型落盘根目录:默认 NAS(所有模型归一到 NAS);可用 TOIV_MODELS_BASE 覆盖。
# 指向 NAS UNC 时,会先 net use 认证(凭据走 TOIV_NAS_PASS,不入仓库)。
MODELS_BASE = os.environ.get(
    "TOIV_MODELS_BASE", r"\\100.80.237.96\NAS\Windows\ComfyUI\ComfyUIModel\models"
)
HF_MIRROR = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com")


def _ensure_nas_auth() -> None:
    """落盘到 NAS UNC 前先认证(同会话内才能写 UNC)。"""
    if not MODELS_BASE.startswith(r"\\"):
        return
    import subprocess

    host = MODELS_BASE.lstrip("\\").split("\\")[0]  # 100.80.237.96
    pw = os.environ.get("TOIV_NAS_PASS", "")
    if pw:
        share = rf"\\{host}\NAS"
        # 先清掉可能冲突的旧会话(同一服务器只允许一组凭据),再认证
        subprocess.run(["net", "use", share, "/delete", "/y"], capture_output=True, text=True)
        subprocess.run(
            ["net", "use", share, f"/user:dgmt-nas", pw, "/persistent:no"],
            capture_output=True, text=True,
        )

# 显式类型(含 Civitai 的 type)→ 子目录
TYPE_DIR = {
    "checkpoint": "checkpoints", "checkpoints": "checkpoints", "base": "checkpoints",
    "lora": "loras", "loras": "loras", "lycoris": "loras", "locon": "loras",
    "vae": "vae",
    "controlnet": "controlnet", "control": "controlnet",
    "upscale": "upscale_models", "upscaler": "upscale_models", "esrgan": "upscale_models",
    "embedding": "embeddings", "embeddings": "embeddings", "textualinversion": "embeddings",
    "clip": "text_encoders", "text_encoder": "text_encoders", "text_encoders": "text_encoders",
    "clip_vision": "clip_vision", "clipvision": "clip_vision",
    "unet": "diffusion_models", "diffusion": "diffusion_models", "diffusion_models": "diffusion_models",
    "vae_approx": "vae_approx",
    "ipadapter": "ipadapter", "ip_adapter": "ipadapter", "ip-adapter": "ipadapter",
}


def categorize(explicit_type: str, filename: str, repo: str = "") -> str:
    """显式类型优先;否则按文件名/仓库名启发式判断子目录。"""
    if explicit_type:
        t = explicit_type.strip().lower()
        if t in TYPE_DIR:
            return TYPE_DIR[t]
    name = f"{filename} {repo}".lower()
    if "ip-adapter" in name or "ipadapter" in name:
        return "ipadapter"
    if "clip_vision" in name or "clipvision" in name:
        return "clip_vision"
    if "controlnet" in name or "control_net" in name or "t2i-adapter" in name:
        return "controlnet"
    if any(k in name for k in ("upscal", "esrgan", "realesr", "swinir", "4x-", "4x_", "8x-", "nmkd")):
        return "upscale_models"
    if "lora" in name or "lycoris" in name or "locon" in name:
        return "loras"
    if "vae" in name and "vae_approx" not in name:
        return "vae"
    if any(k in name for k in ("umt5", "t5xxl", "t5_", "text_encoder", "clip_l", "clip_g",
                               "clip-vit", "qwen_3", "gemma", "mistral")):
        return "text_encoders"
    if any(k in name for k in ("flux", "wan2", "unet", "diffusion", "ltx", "hunyuan_video",
                               "cogvideo", "z_image", "qwen_image")):
        return "diffusion_models"
    if "embedding" in name or "textual" in name:
        return "embeddings"
    return "checkpoints"  # 兜底:大模型默认 checkpoint


def download(url: str, dest: str, token: str | None = None, retries: int = 4) -> None:
    """原子流式下载:写 .part,完成后重命名。带重试 + 完整性校验(应对 CDN 流式中断)。"""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    part = dest + ".part"
    last_err: Exception | None = None
    # (连接超时, 读超时):某次读卡住 >120s 视为断流 → 清残留重试
    for attempt in range(1, retries + 1):
        try:
            with requests.get(url, headers=headers, stream=True, timeout=(30, 120)) as r:
                r.raise_for_status()
                total = int(r.headers.get("content-length", 0))
                done = 0
                with open(part, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        if not chunk:
                            continue
                        f.write(chunk)
                        done += len(chunk)
                        if total:
                            pct = done * 100 // total
                            print(f"\r  [{attempt}/{retries}] {pct}%  {done >> 20}/{total >> 20} MB",
                                  end="", file=sys.stderr)
            print("", file=sys.stderr)
            if total and os.path.getsize(part) < total * 0.999:
                raise OSError(f"下载不完整 {os.path.getsize(part)}/{total}")
            os.replace(part, dest)  # 原子重命名
            return
        except (requests.RequestException, OSError) as e:
            last_err = e
            print(f"\n  尝试 {attempt}/{retries} 失败: {str(e)[:90]}", file=sys.stderr)
            try:
                if os.path.exists(part):
                    os.remove(part)
            except OSError:
                pass
    raise last_err or RuntimeError("下载失败")


def _hf_download(repo: str, file_in_repo: str, dest: str, token: str | None) -> None:
    """用 huggingface_hub 下载(原生支持 HF Xet 后端 + 断点续传 + hf-mirror)。
    先下到本地临时盘(快),再移到目标(可跨盘到 NAS)。"""
    import shutil
    import tempfile

    os.environ.setdefault("HF_ENDPOINT", HF_MIRROR)
    from huggingface_hub import hf_hub_download

    with tempfile.TemporaryDirectory() as tmp:
        path = hf_hub_download(repo_id=repo, filename=file_in_repo, local_dir=tmp, token=token or None)
        shutil.move(path, dest)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="直链下载地址")
    ap.add_argument("--hf", help="HuggingFace 仓库,如 author/repo")
    ap.add_argument("--file", help="HF 仓库内文件路径")
    ap.add_argument("--type", default="", help="显式模型类型(checkpoint/lora/vae/...);留空则按文件名判断")
    ap.add_argument("--name", help="保存的文件名(默认取 URL/文件名)")
    ap.add_argument("--token", default="", help="HF/Civitai 令牌(可选)")
    ap.add_argument("--dry-run", action="store_true", help="只判断分类不下载")
    args = ap.parse_args()

    if args.hf:
        file_in_repo = args.file or ""
        url = f"{HF_MIRROR}/{args.hf}/resolve/main/{file_in_repo}"
        filename = args.name or os.path.basename(file_in_repo)
        repo = args.hf
    elif args.url:
        url = args.url
        filename = args.name or os.path.basename(url.split("?")[0]) or "model.safetensors"
        repo = ""
    elif args.dry_run:
        url = ""
        filename = args.name or ""
        repo = ""
    else:
        print(json.dumps({"ok": False, "error": "需要 --url 或 --hf/--file"}, ensure_ascii=False))
        return 2

    category = categorize(args.type, filename, repo)
    target_dir = os.path.join(MODELS_BASE, category)
    dest = os.path.join(target_dir, filename) if filename else ""

    if args.dry_run:
        print(json.dumps({"ok": True, "category": category, "filename": filename,
                          "dest": dest}, ensure_ascii=False))
        return 0

    _ensure_nas_auth()
    os.makedirs(target_dir, exist_ok=True)
    if os.path.exists(dest):
        print(json.dumps({"ok": True, "skipped": "exists", "category": category, "dest": dest},
                         ensure_ascii=False))
        return 0
    try:
        if args.hf:
            _hf_download(args.hf, file_in_repo, dest, args.token or None)
        else:
            download(url, dest, args.token or None)
    except Exception as e:  # noqa: BLE001
        # 清掉可能残留的 .part
        try:
            if os.path.exists(dest + ".part"):
                os.remove(dest + ".part")
        except OSError:
            pass
        print(json.dumps({"ok": False, "error": str(e)[:300], "category": category},
                         ensure_ascii=False))
        return 1
    size = os.path.getsize(dest) >> 20
    print(json.dumps({"ok": True, "category": category, "filename": filename,
                      "dest": dest, "size_mb": size}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
