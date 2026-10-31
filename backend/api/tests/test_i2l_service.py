"""i2L 风格 LoRA 服务(deploy/i2l-service/server.py)单测。

deploy/ 下的独立 HTTP agent,用 importlib 动态加载。不 import 真实
torch/diffsynth(服务内惰性 import),导出函数用 monkeypatch 替换为 fake。
"""
from __future__ import annotations

import importlib.util
import json
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SERVER_SCRIPT = _REPO_ROOT / "deploy" / "i2l-service" / "server.py"

_I2L_ENV_VARS = (
    "ZIMAGE_DIFFUSERS_DIR",
    "ZIMAGE_I2L_DIR",
    "I2L_LORAS_DIR",
    "I2L_UPLOAD_DIR",
)

_PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"fake" * 8


def _load_i2l():
    """从 deploy/i2l-service/ 动态加载 server.py(每次全新加载,路径常量随 env 重算)。"""
    spec = importlib.util.spec_from_file_location("i2l_service", _SERVER_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def _clean_i2l_env(monkeypatch):
    for var in _I2L_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)


@pytest.fixture
def i2l(tmp_path, monkeypatch):
    """加载服务模块并把 LoRA/上传目录指到临时路径。"""
    module = _load_i2l()
    monkeypatch.setattr(module, "LORAS_DIR", str(tmp_path / "loras"))
    monkeypatch.setattr(module, "UPLOAD_DIR", str(tmp_path / "uploads"))
    return module


@pytest.fixture
def running(i2l):
    """拉起真实 HTTP 服务(随机端口),返回 (module, base_url)。"""
    server = i2l.ThreadingHTTPServer(("127.0.0.1", 0), i2l.I2LHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        yield i2l, f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()


def _multipart(fields: dict, files: list, boundary: str = "----i2ltest"):
    """构造最小 multipart/form-data body;files=[(filename, bytes), ...]。"""
    body = b""
    for name, value in fields.items():
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n"
        ).encode()
    for filename, data in files:
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="files[]"; '
            f'filename="{filename}"\r\nContent-Type: image/png\r\n\r\n'
        ).encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def _post(url: str, body: bytes, content_type: str):
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": content_type}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _post_i2l(base_url: str, fields: dict, files: list):
    body, ctype = _multipart(fields, files)
    return _post(f"{base_url}/i2l", body, ctype)


def _fake_export(image_paths, out_path, demo_prompt=""):
    """假导出:写一个确定大小的 lora 文件;demo_prompt 非空附出 demo 图。"""
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_bytes(b"\x00" * 4096)
    if demo_prompt:
        demo = os.path.splitext(out_path)[0] + "_demo.png"
        Path(demo).write_bytes(_PNG_BYTES)
        return demo
    return None


# ---------------------------------------------------------------------------
# /health 契约
# ---------------------------------------------------------------------------


def test_health_contract(running):
    _, base_url = running
    with urllib.request.urlopen(f"{base_url}/health", timeout=10) as resp:
        assert resp.status == 200
        data = json.loads(resp.read())
    assert data["ok"] is True
    assert data["busy"] is False
    assert data["gpu"] == ""
    assert data["models"] == {"z_image": False, "i2l": False}


def test_health_gpu_and_models(i2l, monkeypatch, tmp_path):
    """gpu 取 CUDA_VISIBLE_DEVICES;models 为启动时权重目录探测结果。"""
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "2")
    zdir = tmp_path / "zimage_diffusers"
    (zdir / "z-image").mkdir(parents=True)
    (zdir / "z-image-turbo").mkdir(parents=True)
    i2l_dir = tmp_path / "zimage_i2l"
    i2l_dir.mkdir()
    monkeypatch.setenv("ZIMAGE_DIFFUSERS_DIR", str(zdir))
    monkeypatch.setenv("ZIMAGE_I2L_DIR", str(i2l_dir))
    module = _load_i2l()
    assert module.MODELS_STATUS == {"z_image": True, "i2l": True}

    server = module.ThreadingHTTPServer(("127.0.0.1", 0), module.I2LHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=10) as resp:
            data = json.loads(resp.read())
        assert data["gpu"] == "2"
        assert data["models"] == {"z_image": True, "i2l": True}
    finally:
        server.shutdown()
        server.server_close()


def test_health_models_partial(i2l, monkeypatch, tmp_path):
    """只有 i2l 目录、缺 z-image-turbo 时 z_image=False。"""
    zdir = tmp_path / "zimage_diffusers"
    (zdir / "z-image").mkdir(parents=True)
    monkeypatch.setenv("ZIMAGE_DIFFUSERS_DIR", str(zdir))
    monkeypatch.setenv("ZIMAGE_I2L_DIR", str(tmp_path / "zimage_i2l"))
    (tmp_path / "zimage_i2l").mkdir()
    module = _load_i2l()
    assert module.MODELS_STATUS == {"z_image": False, "i2l": True}


# ---------------------------------------------------------------------------
# multipart 解析
# ---------------------------------------------------------------------------


def test_parse_multipart_fields_and_files(i2l):
    body, ctype = _multipart(
        {"lora_name": "flatvector", "demo_prompt": "a cat"},
        [("a.png", _PNG_BYTES), ("b.jpg", b"\xff\xd8\xff" + b"jpeg" * 8)],
    )
    fields, files = i2l._parse_multipart(body, ctype)
    assert fields == {"lora_name": "flatvector", "demo_prompt": "a cat"}
    assert [f[0] for f in files] == ["a.png", "b.jpg"]
    assert files[0][1] == _PNG_BYTES
    assert files[1][1].startswith(b"\xff\xd8\xff")


def test_parse_multipart_quoted_boundary(i2l):
    body, _ = _multipart({"lora_name": "x"}, [("a.png", _PNG_BYTES)], boundary="abc123")
    fields, files = i2l._parse_multipart(body, 'multipart/form-data; boundary="abc123"')
    assert fields["lora_name"] == "x"
    assert len(files) == 1


def test_parse_multipart_missing_boundary_raises(i2l):
    with pytest.raises(ValueError):
        i2l._parse_multipart(b"whatever", "multipart/form-data")


# ---------------------------------------------------------------------------
# lora_name 清洗与校验
# ---------------------------------------------------------------------------


def test_lora_name_sanitized(running, monkeypatch):
    module, base_url = running
    monkeypatch.setattr(module, "_export_lora", _fake_export)
    status, data = _post_i2l(
        base_url, {"lora_name": "My Style-01 !中文"}, [("a.png", _PNG_BYTES)]
    )
    assert status == 200
    assert data["lora_name"] == "MyStyle-01.safetensors"
    assert Path(data["lora_path"]).name == "MyStyle-01.safetensors"


@pytest.mark.parametrize("bad", ["!!!", "中文名字", "   ", "..."])
def test_lora_name_invalid_400(running, bad):
    _, base_url = running
    status, data = _post_i2l(base_url, {"lora_name": bad}, [("a.png", _PNG_BYTES)])
    assert status == 400
    assert "lora_name" in data["error"]


def test_lora_name_missing_400(running):
    _, base_url = running
    status, data = _post_i2l(base_url, {}, [("a.png", _PNG_BYTES)])
    assert status == 400
    assert "lora_name" in data["error"]


# ---------------------------------------------------------------------------
# files 校验
# ---------------------------------------------------------------------------


def test_no_files_400(running):
    _, base_url = running
    status, data = _post_i2l(base_url, {"lora_name": "ok_name"}, [])
    assert status == 400
    assert "files" in data["error"]


def test_too_many_files_400(running):
    _, base_url = running
    files = [(f"s{i}.png", _PNG_BYTES) for i in range(9)]
    status, data = _post_i2l(base_url, {"lora_name": "ok_name"}, files)
    assert status == 400
    assert "8" in data["error"]


def test_bad_ext_400(running):
    _, base_url = running
    status, data = _post_i2l(
        base_url, {"lora_name": "ok_name"}, [("a.gif", b"GIF89a")]
    )
    assert status == 400
    assert "a.gif" in data["error"]


# ---------------------------------------------------------------------------
# busy 409 / 同名 400 / overwrite
# ---------------------------------------------------------------------------


def test_busy_409(running, monkeypatch):
    module, base_url = running
    monkeypatch.setattr(module, "_export_lora", _fake_export)
    assert module._busy_lock.acquire(blocking=False)
    try:
        status, data = _post_i2l(
            base_url, {"lora_name": "busy_case"}, [("a.png", _PNG_BYTES)]
        )
        assert status == 409
        assert data == {"error": "busy"}
    finally:
        module._busy_lock.release()


def test_same_name_reject_400(running, monkeypatch):
    module, base_url = running
    monkeypatch.setattr(module, "_export_lora", _fake_export)
    files = [("a.png", _PNG_BYTES)]
    status, _ = _post_i2l(base_url, {"lora_name": "dup"}, files)
    assert status == 200
    status, data = _post_i2l(base_url, {"lora_name": "dup"}, files)
    assert status == 400
    assert "dup.safetensors" in data["error"]


def test_same_name_overwrite_true_200(running, monkeypatch):
    module, base_url = running
    monkeypatch.setattr(module, "_export_lora", _fake_export)
    files = [("a.png", _PNG_BYTES)]
    assert _post_i2l(base_url, {"lora_name": "dup2"}, files)[0] == 200
    status, data = _post_i2l(
        base_url, {"lora_name": "dup2", "overwrite": "true"}, files
    )
    assert status == 200
    assert data["ok"] is True


# ---------------------------------------------------------------------------
# 成功 / 失败契约
# ---------------------------------------------------------------------------


def test_success_contract(running, monkeypatch):
    module, base_url = running
    monkeypatch.setattr(module, "_export_lora", _fake_export)
    status, data = _post_i2l(
        base_url,
        {"lora_name": "flatvector_smoke"},
        [("s1.png", _PNG_BYTES), ("s2.webp", b"RIFF" + b"w" * 32)],
    )
    assert status == 200
    assert data["ok"] is True
    assert data["lora_name"] == "flatvector_smoke.safetensors"
    assert os.path.isabs(data["lora_path"])
    assert Path(data["lora_path"]).is_file()
    assert data["size_mb"] == round(4096 / (1024 * 1024), 2)
    assert data["demo_png"] is None
    # 上传图落 UPLOAD_DIR/<uuid>/ 且两张都在
    uploads = list(Path(module.UPLOAD_DIR).glob("*/style-*"))
    assert len(uploads) == 2


def test_success_with_demo_prompt(running, monkeypatch):
    module, base_url = running
    monkeypatch.setattr(module, "_export_lora", _fake_export)
    status, data = _post_i2l(
        base_url,
        {"lora_name": "demo_case", "demo_prompt": "a cat on a stone"},
        [("s1.png", _PNG_BYTES)],
    )
    assert status == 200
    assert data["demo_png"] is not None
    assert data["demo_png"].endswith("demo_case_demo.png")
    assert Path(data["demo_png"]).is_file()


def test_export_failure_500_and_unlock(running, monkeypatch):
    module, base_url = running

    def _boom(image_paths, out_path, demo_prompt=""):
        raise RuntimeError("cuda boom tail-marker")

    monkeypatch.setattr(module, "_export_lora", _boom)
    status, data = _post_i2l(base_url, {"lora_name": "fail_case"}, [("a.png", _PNG_BYTES)])
    assert status == 500
    assert "tail-marker" in data["error"]
    # 失败后 busy 已解锁,/health 可见
    with urllib.request.urlopen(f"{base_url}/health", timeout=10) as resp:
        health = json.loads(resp.read())
    assert health["busy"] is False
    # 解锁后同名(未产出文件)可重试成功
    monkeypatch.setattr(module, "_export_lora", _fake_export)
    status, _ = _post_i2l(base_url, {"lora_name": "fail_case"}, [("a.png", _PNG_BYTES)])
    assert status == 200


def test_wrong_content_type_400(running):
    _, base_url = running
    status, data = _post(
        f"{base_url}/i2l", json.dumps({"lora_name": "x"}).encode(), "application/json"
    )
    assert status == 400
    assert "multipart" in data["error"]


# ---------------------------------------------------------------------------
# 路径 env 覆盖
# ---------------------------------------------------------------------------


def test_env_overrides(monkeypatch):
    monkeypatch.setenv("ZIMAGE_DIFFUSERS_DIR", "/custom/zimage")
    monkeypatch.setenv("ZIMAGE_I2L_DIR", "/custom/i2l")
    monkeypatch.setenv("I2L_LORAS_DIR", "/custom/loras")
    monkeypatch.setenv("I2L_UPLOAD_DIR", "/custom/uploads")
    module = _load_i2l()
    assert module.ZIMAGE_DIFFUSERS_DIR == "/custom/zimage"
    assert module.ZIMAGE_I2L_DIR == "/custom/i2l"
    assert module.LORAS_DIR == "/custom/loras"
    assert module.UPLOAD_DIR == "/custom/uploads"


def test_env_defaults():
    module = _load_i2l()
    assert module.ZIMAGE_DIFFUSERS_DIR == "/home/merlin/nas_mount/toiv/zimage_diffusers"
    assert module.ZIMAGE_I2L_DIR == "/home/merlin/nas_mount/toiv/comfyui-models/zimage_i2l"
    assert module.LORAS_DIR == "/home/merlin/nas_mount/toiv/comfyui-models/loras"
    assert module.UPLOAD_DIR == "/home/merlin/i2l-service/uploads"


def test_diffsynth_skip_download_set():
    module = _load_i2l()
    assert os.environ.get("DIFFSYNTH_SKIP_DOWNLOAD") == "true"
    assert module.HOST == "0.0.0.0"
    assert module.PORT == 9101
