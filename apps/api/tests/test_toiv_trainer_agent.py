"""toiv-trainer agent(deploy/toiv-trainer.py)单测:family 映射 + 路径 env 覆盖 + 不支持族 400。

deploy/ 下的独立 HTTP agent(文件名带连字符不能常规 import),用 importlib 动态加载。
不 import 真实 torch/transformers(打标函数内惰性 import,本文件不触发)。
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
_TRAINER_SCRIPT = _REPO_ROOT / "deploy" / "toiv-trainer.py"

_TRAINER_ENV_VARS = (
    "TOIV_TRAINER_MODELS_ROOT",
    "TOIV_TRAINER_DATASETS_DIR",
    "TOIV_TRAINER_AI_TOOLKIT_DIR",
    "TOIV_TRAINER_VENV_PYTHON",
    "TOIV_TRAINER_LORAS_DIR",
    "TOIV_TRAINER_CHECKPOINTS_DIR",
)


def _load_trainer():
    """从 deploy/ 动态加载 toiv-trainer.py(每次全新加载,路径常量随当前 env 重算)。"""
    spec = importlib.util.spec_from_file_location("toiv_trainer_agent", _TRAINER_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def _clean_trainer_env(monkeypatch):
    """清掉宿主环境可能注入的 TOIV_TRAINER_* 变量,保证用例隔离。"""
    for var in _TRAINER_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


def _base_params(family: str) -> dict:
    return {
        "job_id": "job12345678",
        "family": family,
        "lora_name": "test_lora",
        "dataset_dir": "job12345678",
        "base_ckpt": "test.safetensors",
        "cuda_device": 0,
        "trigger_words": "tok",
        "network_dim": 16,
        "network_alpha": 16,
        "resolution": 1024,
        "batch_size": 1,
        "steps": 100,
        "lr": 1e-4,
    }


def _gen_config(trainer, tmp_path, monkeypatch, family: str) -> str:
    """生成 YAML 配置并返回文本(LORAS_DIR 指到临时目录,不碰真实路径)。"""
    monkeypatch.setattr(trainer, "LORAS_DIR", str(tmp_path))
    config_path = trainer._make_ai_toolkit_config(_base_params(family))
    return Path(config_path).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# family → arch 映射
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "family,arch",
    [
        ("z_image", "zimage"),        # ZImageModel(无下划线,workstation 实测)
        ("z_image_base", "zimage"),   # 非蒸馏底座与 z_image 同路
        ("qwen", "qwen_image"),       # QwenImageModel
        ("qwen_image", "qwen_image"), # 次世代 qwen_image 与 qwen 同路
    ],
)
def test_qwen_zimage_family_arch(tmp_path, monkeypatch, family, arch):
    trainer = _load_trainer()
    text = _gen_config(trainer, tmp_path, monkeypatch, family)
    assert f"arch: {arch}" in text
    assert "is_sdxl" not in text  # 不得落进 sdxl 模板
    assert "is_flux" not in text  # 扩展 arch 不带内置 flux 标记(见 H3 实证模板)


@pytest.mark.parametrize(
    "family,arch",
    [
        ("flux2", "flux2"),            # Flux2Model
        ("klein", "flux2_klein_9b"),   # Flux2Klein9BModel
    ],
)
def test_flux_ext_family_arch(tmp_path, monkeypatch, family, arch):
    """flux2/klein 是扩展 arch(diffusion_models 扩展),不带 is_flux 内置标记。"""
    trainer = _load_trainer()
    text = _gen_config(trainer, tmp_path, monkeypatch, family)
    assert f"arch: {arch}" in text
    assert "is_flux" not in text


@pytest.mark.parametrize(
    "family,arch",
    [
        ("flux", "flux"),   # 通用 flux → FLUX.1 dev 内置 arch
        ("flux1", "flux"),  # FLUX.1 dev 内置 arch(ModelArch Literal 'flux')
    ],
)
def test_flux_builtin_family_arch(tmp_path, monkeypatch, family, arch):
    trainer = _load_trainer()
    text = _gen_config(trainer, tmp_path, monkeypatch, family)
    assert f"arch: {arch}" in text
    assert "is_flux: true" in text


@pytest.mark.parametrize("family", ["sdxl", "sdxl_anime"])
def test_sdxl_family_uses_sdxl_template(tmp_path, monkeypatch, family):
    trainer = _load_trainer()
    text = _gen_config(trainer, tmp_path, monkeypatch, family)
    assert "is_sdxl: true" in text


# ---------------------------------------------------------------------------
# 不支持族拒绝
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("family", ["10eros", "ltx", "pony", "sd15", "h3", "unknown_xyz"])
def test_unsupported_family_raises(tmp_path, monkeypatch, family):
    trainer = _load_trainer()
    monkeypatch.setattr(trainer, "LORAS_DIR", str(tmp_path))
    with pytest.raises(trainer.UnsupportedFamilyError) as exc_info:
        trainer._make_ai_toolkit_config(_base_params(family))
    msg = str(exc_info.value)
    assert family in msg
    for supported in trainer.SUPPORTED_FAMILIES:
        assert supported in msg
    # 拒绝前不得产出输出目录
    assert not (tmp_path / "test_lora").exists()


def test_train_endpoint_rejects_unsupported_family(tmp_path, monkeypatch):
    """POST /train 对不支持族返回 400,body 含支持列表(不静默套错模板)。"""
    trainer = _load_trainer()
    monkeypatch.setattr(trainer, "LORAS_DIR", str(tmp_path))
    monkeypatch.setattr(trainer, "DATASETS_DIR", str(tmp_path / "datasets"))

    server = trainer.ThreadingHTTPServer(("127.0.0.1", 0), trainer.TrainerHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        payload = json.dumps(_base_params("10eros")).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/train",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(req, timeout=10)
        assert exc_info.value.code == 400
        body = json.loads(exc_info.value.read())
        assert "10eros" in body["error"]
        for supported in (
            "flux2", "flux1", "klein", "flux",
            "qwen_image", "qwen", "z_image", "z_image_base",
            "sdxl", "sdxl_anime",
        ):
            assert supported in body["error"]
        assert body["supported_families"] == list(trainer.SUPPORTED_FAMILIES)
    finally:
        server.shutdown()
        server.server_close()


# ---------------------------------------------------------------------------
# 路径环境变量覆盖
# ---------------------------------------------------------------------------


def test_models_root_env_override(monkeypatch):
    monkeypatch.setenv("TOIV_TRAINER_MODELS_ROOT", "/home/merlin/models")
    trainer = _load_trainer()
    assert trainer.MODELS_ROOT == "/home/merlin/models"
    assert trainer.CHECKPOINTS_DIR == os.path.join("/home/merlin/models", "checkpoints")
    assert trainer.LORAS_DIR == os.path.join("/home/merlin/models", "loras")


def test_loras_checkpoints_dir_independent_override(monkeypatch):
    """LORAS_DIR/CHECKPOINTS_DIR 可脱离 MODELS_ROOT 独立覆盖。"""
    monkeypatch.setenv("TOIV_TRAINER_MODELS_ROOT", "/ignored/models")
    monkeypatch.setenv("TOIV_TRAINER_LORAS_DIR", "/custom/loras")
    monkeypatch.setenv("TOIV_TRAINER_CHECKPOINTS_DIR", "/custom/ckpts")
    trainer = _load_trainer()
    assert trainer.LORAS_DIR == "/custom/loras"
    assert trainer.CHECKPOINTS_DIR == "/custom/ckpts"


def test_other_path_env_overrides(monkeypatch):
    monkeypatch.setenv("TOIV_TRAINER_DATASETS_DIR", "/home/merlin/toiv-trainer/datasets")
    monkeypatch.setenv("TOIV_TRAINER_AI_TOOLKIT_DIR", "/home/merlin/ai-toolkit")
    monkeypatch.setenv("TOIV_TRAINER_VENV_PYTHON", "/home/merlin/ai-toolkit/.venv/bin/python")
    trainer = _load_trainer()
    assert trainer.DATASETS_DIR == "/home/merlin/toiv-trainer/datasets"
    assert trainer.AI_TOOLKIT_DIR == "/home/merlin/ai-toolkit"
    assert trainer.TRAINER_VENV_PYTHON == "/home/merlin/ai-toolkit/.venv/bin/python"


def test_defaults_windows_backward_compat():
    """不设环境变量时默认值保持 Windows F:\\ 布局(向后兼容)。"""
    trainer = _load_trainer()
    assert trainer.MODELS_ROOT == r"F:\ComfyUIModel\models"
    assert trainer.DATASETS_DIR == r"F:\toiv-trainer\datasets"
    assert trainer.AI_TOOLKIT_DIR == r"F:\toiv-trainer\ai-toolkit"
    assert trainer.TRAINER_VENV_PYTHON == r"F:\toiv-trainer\.venv\Scripts\python.exe"
    assert trainer.LORAS_DIR == os.path.join(trainer.MODELS_ROOT, "loras")
    assert trainer.CHECKPOINTS_DIR == os.path.join(trainer.MODELS_ROOT, "checkpoints")
