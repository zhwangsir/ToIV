"""toiv-trainer agent(deploy/toiv-trainer.py)单测:family 映射 + 路径 env 覆盖 + 不支持族 400。

deploy/ 下的独立 HTTP agent(文件名带连字符不能常规 import),用 importlib 动态加载。
不 import 真实 torch/transformers(打标函数内惰性 import,本文件不触发)。
"""
from __future__ import annotations

import importlib.util
import io
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
    "TOIV_TRAINER_H3_MODELS_PATH",
    "TOIV_TRAINER_H3_LORAS_DIR",
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
    config_path, _warning = trainer._make_ai_toolkit_config(_base_params(family))
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
# 参数默认值与必填校验(2026-08-27 冒烟 KeyError: batch_size 教训)
# ---------------------------------------------------------------------------


def test_optional_params_defaults_applied(tmp_path, monkeypatch):
    """只给必填参数(job_id/dataset_dir/base_ckpt)时按默认值生成 YAML,不炸 KeyError。"""
    trainer = _load_trainer()
    monkeypatch.setattr(trainer, "LORAS_DIR", str(tmp_path))
    minimal = {
        "job_id": "job12345678",
        "family": "z_image",
        "dataset_dir": "job12345678",
        "base_ckpt": "test.safetensors",
    }
    config_path, warning = trainer._make_ai_toolkit_config(minimal)
    text = Path(config_path).read_text(encoding="utf-8")
    assert "batch_size: 1" in text
    assert "steps: 1000" in text
    assert "lr: 0.0001" in text
    assert "linear: 16" in text
    assert warning == ""


@pytest.mark.parametrize("family", ["z_image", "flux2", "flux", "sdxl", "h3"])
def test_yaml_device_always_cuda0(tmp_path, monkeypatch, family):
    """YAML device 恒为 cuda:0 —— 物理卡由 subprocess CUDA_VISIBLE_DEVICES 单卡视图指定
    (2026-08-27 冒烟:cuda:2 + 单卡视图回退物理 GPU0 致 OOM 教训)。"""
    trainer = _load_trainer()
    monkeypatch.setattr(trainer, "LORAS_DIR", str(tmp_path))
    monkeypatch.setattr(trainer, "H3_LORAS_DIR", str(tmp_path))
    config_path, _ = trainer._make_ai_toolkit_config(_base_params(family))
    text = Path(config_path).read_text(encoding="utf-8")
    assert "device: cuda:0" in text
    assert "device: cuda:2" not in text


@pytest.mark.parametrize("family", ["z_image", "h3"])
def test_training_folder_per_job_isolation(tmp_path, monkeypatch, family):
    """training_folder 每作业独立(含 lora_name)——共享 loras 根会被 ai-toolkit resume
    发现机制误捡其他 LoRA 的 optimizer.pt 致 torch.load 崩溃(2026-08-27 实证)。"""
    trainer = _load_trainer()
    monkeypatch.setattr(trainer, "LORAS_DIR", str(tmp_path / "loras"))
    monkeypatch.setattr(trainer, "H3_LORAS_DIR", str(tmp_path / "h3_loras"))
    config_path, _ = trainer._make_ai_toolkit_config(_base_params(family))
    text = Path(config_path).read_text(encoding="utf-8")
    line = next(l for l in text.splitlines() if "training_folder:" in l)
    assert "test_lora" in line  # 每作业独立目录
    base = "h3_loras" if family == "h3" else "loras"
    assert base in line


def test_train_status_endpoint(tmp_path, monkeypatch):
    """GET /train/{id} 返回作业状态(飞轮轮询依赖);未知 id 404。"""
    trainer = _load_trainer()
    trainer._jobs["abc12345"] = {
        "status": "done",
        "progress": {"step": 30, "total": 30, "loss": 0.137, "recent_losses": []},
        "lora_path": "/nas/loras/x.safetensors",
        "error": "",
    }
    server = trainer.ThreadingHTTPServer(("127.0.0.1", 0), trainer.TrainerHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/train/abc12345", timeout=10) as resp:
            body = json.loads(resp.read())
        assert resp.status == 200
        assert body["status"] == "done"
        assert body["progress"]["step"] == 30
        assert body["lora_path"].endswith(".safetensors")
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/train/nonexistent", timeout=10)
        assert exc_info.value.code == 404
    finally:
        server.shutdown()
        server.server_close()


def test_find_lora_file_nested_discovery(tmp_path):
    """_find_lora_file 递归发现 ai-toolkit 双嵌套产物(output_dir/<name>/<name>.safetensors),
    并返回最新者(2026-08-27 冒烟:DONE 路径为空教训)。"""
    import os
    import time
    trainer = _load_trainer()
    nested = tmp_path / "run" / "my_lora"
    nested.mkdir(parents=True)
    old_f = tmp_path / "run" / "old.safetensors"
    old_f.write_bytes(b"old")
    new_f = nested / "my_lora.safetensors"
    new_f.write_bytes(b"new")
    # 确保 nested 的 mtime 更新
    now = time.time()
    os.utime(old_f, (now - 100, now - 100))
    os.utime(new_f, (now, now))
    assert trainer._find_lora_file(str(tmp_path / "run")) == str(new_f)
    assert trainer._find_lora_file(str(tmp_path / "nonexistent")) == ""


def test_missing_required_param_raises_value_error(tmp_path, monkeypatch):
    """缺必填参数(dataset_dir)抛 ValueError(端点映射 400,不断连)。"""
    trainer = _load_trainer()
    monkeypatch.setattr(trainer, "LORAS_DIR", str(tmp_path))
    with pytest.raises(ValueError, match="dataset_dir"):
        trainer._make_ai_toolkit_config(
            {"job_id": "job12345678", "family": "z_image", "base_ckpt": "x.safetensors"}
        )
    # 校验先于建目录
    assert not (tmp_path / "test_lora").exists()


# ---------------------------------------------------------------------------
# 不支持族拒绝
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("family", ["10eros", "ltx", "pony", "sd15", "unknown_xyz"])
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
            "sdxl", "sdxl_anime", "h3",
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


# ---------------------------------------------------------------------------
# H3(MiniMax-H3 视频 LoRA)族 —— arch=minimax_h3,模板按 scripts/h3 实证 example.yaml
# ---------------------------------------------------------------------------


def _h3_params(**overrides) -> dict:
    params = _base_params("h3")
    params["base_ckpt"] = "MiniMaxAI/MiniMax-H3"  # 仅取 tokenizer,不拼本地 checkpoints 路径
    params.update(overrides)
    return params


def test_h3_family_yaml(tmp_path, monkeypatch):
    """h3 生成 minimax_h3 模板:实证键齐全,不含 is_flux/is_sdxl,默认 num_frames 39。"""
    trainer = _load_trainer()
    monkeypatch.setattr(trainer, "LORAS_DIR", str(tmp_path))
    monkeypatch.setattr(trainer, "H3_LORAS_DIR", str(tmp_path))
    config_path, warning = trainer._make_ai_toolkit_config(_h3_params())
    text = Path(config_path).read_text(encoding="utf-8")
    assert warning == ""  # 未传 num_frames 时默认 39 恰好合法,无 warning
    assert "arch: minimax_h3" in text
    assert "num_frames: 39" in text
    assert "cache_text_embeddings: true" in text
    assert "partition: fl2va_pruned" in text
    assert 'name_or_path: "MiniMaxAI/MiniMax-H3"' in text
    assert "noise_scheduler: flowmatch" in text
    assert "timestep_type: linear" in text
    assert "weight_decay: 1e-4" in text
    assert "gradient_checkpointing: true" in text
    assert "quantize_te: false" in text
    assert "low_vram: true" in text  # 默认 true:多租户卡余量 ~41G,40G 模型须 CPU 换入(2026-08-27 OOM 实证)
    assert "sample_audio: false" in text
    assert "is_flux" not in text
    assert "is_sdxl" not in text
    assert "sample:" not in text  # 训练不需要采样段
    assert trainer.CHECKPOINTS_DIR not in text  # h3 跳过 _resolve_ckpt_path


def test_h3_num_frames_snap_up(tmp_path, monkeypatch):
    """num_frames=30 非法 → 向上吸附 39,YAML 写吸附值且 warning 非空。"""
    trainer = _load_trainer()
    monkeypatch.setattr(trainer, "H3_LORAS_DIR", str(tmp_path))
    config_path, warning = trainer._make_ai_toolkit_config(_h3_params(num_frames=30))
    text = Path(config_path).read_text(encoding="utf-8")
    assert "num_frames: 39" in text
    assert warning
    assert "30" in warning and "39" in warning


def test_h3_num_frames_exact_no_warning(tmp_path, monkeypatch):
    """num_frames=39 恰好合法 → 不吸附,warning 为空。"""
    trainer = _load_trainer()
    monkeypatch.setattr(trainer, "H3_LORAS_DIR", str(tmp_path))
    config_path, warning = trainer._make_ai_toolkit_config(_h3_params(num_frames=39))
    text = Path(config_path).read_text(encoding="utf-8")
    assert "num_frames: 39" in text
    assert warning == ""


def test_h3_frame_grid_snap_boundaries():
    """17n+5 网格吸附边界:合法值原样,非法值向上,超上限吸附到 56。"""
    trainer = _load_trainer()
    assert trainer._snap_h3_num_frames(5) == (5, "")
    assert trainer._snap_h3_num_frames(56) == (56, "")
    assert trainer._snap_h3_num_frames(6)[0] == 22
    assert trainer._snap_h3_num_frames(30)[0] == 39
    assert trainer._snap_h3_num_frames(57)[0] == 56
    assert trainer._snap_h3_num_frames(None)[0] == 39  # 无法解析回落默认


def test_h3_output_dir_uses_h3_loras_dir(tmp_path, monkeypatch):
    """h3 族 LoRA 输出走 H3_LORAS_DIR,不用全局 LORAS_DIR。"""
    trainer = _load_trainer()
    global_loras = tmp_path / "global_loras"
    h3_loras = tmp_path / "h3_loras"
    monkeypatch.setattr(trainer, "LORAS_DIR", str(global_loras))
    monkeypatch.setattr(trainer, "H3_LORAS_DIR", str(h3_loras))
    config_path, _ = trainer._make_ai_toolkit_config(_h3_params())
    assert Path(config_path).parent == h3_loras / "test_lora"
    text = Path(config_path).read_text(encoding="utf-8")
    assert str(h3_loras) in text
    assert not (global_loras / "test_lora").exists()


def test_h3_path_env_overrides(monkeypatch):
    """TOIV_TRAINER_H3_MODELS_PATH / TOIV_TRAINER_H3_LORAS_DIR 环境变量覆盖。"""
    monkeypatch.setenv("TOIV_TRAINER_H3_MODELS_PATH", "/custom/h3")
    trainer = _load_trainer()
    assert trainer.H3_MODELS_PATH == "/custom/h3"
    assert trainer.H3_LORAS_DIR == os.path.join("/custom/h3", "loras")
    monkeypatch.setenv("TOIV_TRAINER_H3_LORAS_DIR", "/custom/h3_loras")
    trainer = _load_trainer()
    assert trainer.H3_LORAS_DIR == "/custom/h3_loras"


def test_h3_path_defaults():
    """不设环境变量时 H3 路径默认指向 workstation NAS 挂载布局。"""
    trainer = _load_trainer()
    assert trainer.H3_MODELS_PATH == "/home/merlin/nas_mount/toiv/comfyui-models/h3"
    assert trainer.H3_LORAS_DIR == os.path.join(trainer.H3_MODELS_PATH, "loras")


def test_h3_train_endpoint_injects_models_path(tmp_path, monkeypatch):
    """POST /train(h3):subprocess env 注入 MODELS_PATH,响应带 num_frames 吸附 warning。"""
    trainer = _load_trainer()
    monkeypatch.setattr(trainer, "LORAS_DIR", str(tmp_path / "loras"))
    monkeypatch.setattr(trainer, "H3_LORAS_DIR", str(tmp_path / "h3_loras"))
    monkeypatch.setattr(trainer, "H3_MODELS_PATH", "/nas/h3")
    monkeypatch.setattr(trainer, "DATASETS_DIR", str(tmp_path / "datasets"))

    captured: dict = {}

    class _FakeProc:
        def __init__(self):
            self.stdout = io.StringIO("")
            self.returncode = 0

        def wait(self):
            return 0

        def poll(self):
            return 0

        def terminate(self):
            pass

    def _fake_popen(cmd, **kwargs):
        captured["env"] = kwargs.get("env", {})
        return _FakeProc()

    monkeypatch.setattr(trainer.subprocess, "Popen", _fake_popen)

    server = trainer.ThreadingHTTPServer(("127.0.0.1", 0), trainer.TrainerHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        payload = json.dumps(_h3_params(num_frames=30)).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/train",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            assert resp.status == 200
            body = json.loads(resp.read())
        assert body["trainer_job_id"]
        assert body["warning"]  # 30→39 吸附 warning 随响应透传
        assert captured["env"]["MODELS_PATH"] == "/nas/h3"
        assert captured["env"]["CUDA_VISIBLE_DEVICES"] == "0"
        # 产物目录落在 H3_LORAS_DIR 而非全局 LORAS_DIR
        assert (tmp_path / "h3_loras" / "test_lora").is_dir()
        assert not (tmp_path / "loras" / "test_lora").exists()
    finally:
        server.shutdown()
        server.server_close()
