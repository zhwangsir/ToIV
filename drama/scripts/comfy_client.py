"""ComfyUI 客户端:提交 prompt、轮询、下载输出。"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

import requests

from config import COMFY_ENDPOINT, LTX_UNET, LTX_VAE, LTX_GEMMA


class ComfyClient:
    def __init__(self, base_url: str = COMFY_ENDPOINT, timeout: int = 60):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()

    def _post(self, path: str, **kwargs) -> dict | Any:
        r = self.session.post(f"{self.base_url}{path}", timeout=self.timeout, **kwargs)
        r.raise_for_status()
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else r.content

    def _get(self, path: str, stream: bool = False) -> Any:
        r = self.session.get(f"{self.base_url}{path}", timeout=self.timeout, stream=stream)
        r.raise_for_status()
        return r

    def submit(self, prompt_graph: dict) -> str:
        payload = {"prompt": prompt_graph, "client_id": str(uuid.uuid4())}
        data = self._post("/prompt", json=payload)
        return data["prompt_id"]

    def wait(self, prompt_id: str, poll_interval: float = 2.0, max_wait: float = 900.0) -> dict:
        elapsed = 0.0
        while elapsed < max_wait:
            data = self._get(f"/history/{prompt_id}").json()
            if data and prompt_id in data:
                return data[prompt_id]
            time.sleep(poll_interval)
            elapsed += poll_interval
        raise TimeoutError(f"prompt {prompt_id} not completed in {max_wait}s")

    def get_outputs(self, history: dict) -> list[dict]:
        outputs = history.get("outputs", {})
        files = []
        for node_id, node_out in outputs.items():
            for key in ("videos", "gifs", "images"):
                for item in node_out.get(key, []):
                    files.append({
                        "node_id": node_id,
                        "type": key,
                        "filename": item["filename"],
                        "subfolder": item.get("subfolder", ""),
                        "format": item.get("format", ""),
                    })
        return files

    def download(self, filename: str, subfolder: str, dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        params = {"filename": filename, "subfolder": subfolder, "type": "output"}
        r = self._get(f"/view?{requests.compat.urlencode(params)}", stream=True)
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        return dest


def build_ltx_t2v_graph(prompt: str, negative: str, width: int = 768, height: int = 384,
                        length: int = 97, fps: int = 16, seed: int | None = None) -> dict:
    """构建 LTX 2.3 text-to-video 工作流,使用 UNETLoader + LTXVGemmaCLIPModelLoader。"""
    seed = seed if seed is not None else int(time.time()) % 2**32
    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": LTX_UNET, "weight_dtype": "fp8_e4m3fn"}},
        "2": {"class_type": "LTXVGemmaCLIPModelLoader", "inputs": {"gemma_path": LTX_GEMMA, "ltxv_path": LTX_UNET, "max_length": 1024}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": LTX_VAE}},
        "4": {"class_type": "EmptyLTXVLatentVideo", "inputs": {
            "width": width, "height": height, "length": length, "batch_size": 1,
        }},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": negative}},
        "7": {"class_type": "SamplerEulerAncestral", "inputs": {"eta": 1.0, "s_noise": 1.0}},
        "8": {
            "class_type": "LTXVScheduler",
            "inputs": {
                "steps": 30,
                "max_shift": 1.05,
                "base_shift": 0.95,
                "stretch": True,
                "terminal": 0.1,
                "latent": ["4", 0],
            },
        },
        "9": {
            "class_type": "SamplerCustom",
            "inputs": {
                "model": ["1", 0],
                "add_noise": True,
                "noise_seed": seed,
                "cfg": 1.0,
                "positive": ["12", 0],
                "negative": ["12", 1],
                "sampler": ["7", 0],
                "sigmas": ["8", 0],
                "latent_image": ["4", 0],
            },
        },
        "10": {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
        # LTXVConditioning:LTX-2 必需节点,注入 frame_rate 元数据到正负向条件
        # (官方 LTX-2.3_T2V_I2V_Single_Stage_Distilled_Full 链路:CLIPTextEncode → LTXVConditioning → Guider)。
        "12": {
            "class_type": "LTXVConditioning",
            "inputs": {"positive": ["5", 0], "negative": ["6", 0], "frame_rate": float(fps)},
        },
        "11": {"class_type": "VHS_VideoCombine", "inputs": {
            "frame_rate": fps,
            "loop_count": 0,
            "filename_prefix": "drama_shot",
            "format": "video/h264-mp4",
            "pingpong": False,
            "save_output": True,
            "images": ["10", 0],
        }},
    }
    return graph


def build_ltx_i2v_graph(image_path: str, prompt: str, negative: str, width: int = 768, height: int = 384,
                        length: int = 97, fps: int = 16, seed: int | None = None) -> dict:
    """构建 LTX 2.3 image-to-video 工作流。"""
    seed = seed if seed is not None else int(time.time()) % 2**32
    upload_image_to_comfy(image_path)
    img_name = Path(image_path).name
    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": LTX_UNET, "weight_dtype": "fp8_e4m3fn"}},
        "2": {"class_type": "LTXVGemmaCLIPModelLoader", "inputs": {"gemma_path": LTX_GEMMA, "ltxv_path": LTX_UNET, "max_length": 1024}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": LTX_VAE}},
        "4": {"class_type": "LoadImage", "inputs": {"image": img_name}},
        "5": {"class_type": "LTXVImgToVideo", "inputs": {
            "width": width, "height": height, "length": length, "batch_size": 1,
            "image": ["4", 0], "vae": ["3", 0], "positive": ["", 0], "negative": ["", 0],
        }},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": negative}},
        "8": {"class_type": "SamplerEulerAncestral", "inputs": {"eta": 1.0, "s_noise": 1.0}},
        "9": {
            "class_type": "LTXVScheduler",
            "inputs": {
                "steps": 30,
                "max_shift": 1.05,
                "base_shift": 0.95,
                "stretch": True,
                "terminal": 0.1,
                "latent": ["5", 0],
            },
        },
        "10": {
            "class_type": "SamplerCustom",
            "inputs": {
                "model": ["1", 0],
                "add_noise": True,
                "noise_seed": seed,
                "cfg": 1.0,
                "positive": ["6", 0],
                "negative": ["7", 0],
                "sampler": ["8", 0],
                "sigmas": ["9", 0],
                "latent_image": ["5", 0],
            },
        },
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["3", 0]}},
        "12": {"class_type": "VHS_VideoCombine", "inputs": {
            "frame_rate": fps,
            "loop_count": 0,
            "filename_prefix": "drama_shot",
            "format": "video/h264-mp4",
            "pingpong": False,
            "save_output": True,
            "images": ["11", 0],
        }},
    }
    return graph


def upload_image_to_comfy(local_path: str):
    url = f"{COMFY_ENDPOINT}/upload/image"
    with open(local_path, "rb") as f:
        r = requests.post(url, files={"image": (Path(local_path).name, f, "image/png")}, timeout=60)
    r.raise_for_status()


if __name__ == "__main__":
    c = ComfyClient()
    print("ComfyUI endpoint:", c.base_url)
