"""应用市场 M4:UI(LiteGraph)→ API 工作流转换测试(services/workflow_convert)。

覆盖:
  - txt2img_basic 全量转换(links 解析为 [节点,槽]、KSampler widgets 具名且
    control_after_generate 被跳过、SaveImage/EmptyLatentImage/CheckpointLoader)
  - LoadImage 的 UI 专属 upload 控件丢弃
  - LTX 系模板:VHS_VideoCombine(UI 保存序 format 在最前)/LTXVGemmaCLIPModelLoader/
    LTXVReferenceAudio/EmptyLTXVLatentVideo 的 widgets 映射
  - 悬空 link 报错 / 非 UI 格式报错 / mode=2 muted 节点剔除
  - strict 模式未知节点类抛错;宽松模式丢 widgets 保连线
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.workflow_convert import is_ui_format, ui_to_api

_TEMPLATES = Path(__file__).resolve().parents[1] / "app" / "workflows"


def _load(name: str) -> dict:
    with open(_TEMPLATES / name, encoding="utf-8") as f:
        return json.load(f)


def test_txt2img_basic_full_conversion():
    api = ui_to_api(_load("txt2img_basic.json"))
    assert set(api) == {"1", "2", "3", "4", "5", "6", "7"}
    # links 解析:源节点 id 字符串化 + 输出槽
    assert api["5"]["inputs"]["model"] == ["1", 0]
    assert api["5"]["inputs"]["positive"] == ["2", 0]
    assert api["5"]["inputs"]["negative"] == ["3", 0]
    assert api["5"]["inputs"]["latent_image"] == ["4", 0]
    assert api["6"]["inputs"] == {"samples": ["5", 0], "vae": ["1", 2]}
    assert api["7"]["inputs"] == {"images": ["6", 0], "filename_prefix": "ToIV_txt2img"}
    # KSampler widgets 具名;control_after_generate(UI 控件)不进 API 图
    ks = api["5"]["inputs"]
    assert ks["seed"] == 123456789
    assert ks["steps"] == 20 and ks["cfg"] == 1.0
    assert ks["sampler_name"] == "euler" and ks["scheduler"] == "normal"
    assert ks["denoise"] == 1.0
    assert "control_after_generate" not in ks
    # CheckpointLoaderSimple / EmptyLatentImage / CLIPTextEncode widgets
    assert api["1"]["inputs"] == {"ckpt_name": "flux2_dev_fp8mixed.safetensors"}
    assert api["4"]["inputs"] == {"width": 1024, "height": 1024, "batch_size": 1}
    assert api["2"]["inputs"]["text"].startswith("1girl")
    assert api["2"]["inputs"]["clip"] == ["1", 1]


def test_img2img_loadimage_extra_widget_dropped():
    api = ui_to_api(_load("img2img_basic.json"))
    # LoadImage widgets_values 第 2 项是 UI 上传方式控件,不进 API 图
    assert api["2"]["inputs"] == {"image": "example.png"}
    # VAEEncode 无 widgets,仅连线
    assert api["5"]["inputs"] == {"pixels": ["2", 0], "vae": ["1", 2]}
    # img2img 的 denoise 是 0.75(与 txt2img 的 1.0 区分)
    assert api["6"]["inputs"]["denoise"] == 0.75


def test_ltx_txt2video_widget_orders():
    api = ui_to_api(_load("ltx_txt2video.json"))
    # LTXVGemmaCLIPModelLoader:gemma/ltxv/max_length(字段名同 ltx_video.py 构造器)
    assert api["2"]["inputs"] == {
        "gemma_path": "gemma3_12b_it/model.safetensors",
        "ltxv_path": "10eros_v14.safetensors",
        "max_length": 1024,
    }
    # EmptyLTXVLatentVideo:width/height/length/batch_size
    assert api["7"]["inputs"] == {"width": 768, "height": 384, "length": 97, "batch_size": 1}
    # LTXVConditioning:frame_rate
    assert api["6"]["inputs"]["frame_rate"] == 16.0
    # VHS_VideoCombine:UI 保存序 format 在最前
    vhs = api["10"]["inputs"]
    assert vhs["format"] == "video/h264-mp4"
    assert vhs["frame_rate"] == 16.0
    assert vhs["loop_count"] == 0
    assert vhs["filename_prefix"] == "ToIV_ltx_txt2video"
    assert vhs["pingpong"] is False and vhs["save_output"] is True
    assert vhs["images"] == ["9", 0]


def test_ltx_lipsync_audio_chain():
    api = ui_to_api(_load("ltx_lipsync.json"))
    assert api["11"]["inputs"] == {"audio": "example.wav"}
    assert api["12"]["inputs"] == {"ckpt_name": "ltx-2.3-22b-distilled-1.1.safetensors"}
    ref = api["13"]["inputs"]
    assert ref["model"] == ["1", 0]
    assert ref["reference_audio"] == ["11", 0]
    assert ref["audio_vae"] == ["12", 0]
    assert ref["identity_guidance_scale"] == 0.5
    assert ref["start_percent"] == 0.0 and ref["end_percent"] == 1.0
    # KSampler 接 RefAudio 三路输出
    assert api["8"]["inputs"]["model"] == ["13", 0]
    assert api["8"]["inputs"]["positive"] == ["13", 1]


def test_dangling_link_raises():
    bad = {
        "nodes": [
            {"id": 1, "type": "SaveImage", "mode": 0,
             "inputs": [{"name": "images", "type": "IMAGE", "link": 99}],
             "widgets_values": ["x"]},
        ],
        "links": [],
    }
    with pytest.raises(ValueError, match="悬空 link"):
        ui_to_api(bad)


def test_non_ui_format_raises():
    with pytest.raises(ValueError, match="UI 格式"):
        ui_to_api({"3": {"class_type": "SaveImage", "inputs": {}}})
    assert is_ui_format({"nodes": []}) is True
    assert is_ui_format({"3": {}}) is False


def test_muted_node_skipped():
    ui = {
        "nodes": [
            {"id": 1, "type": "CheckpointLoaderSimple", "mode": 0,
             "inputs": [], "widgets_values": ["a.safetensors"]},
            {"id": 2, "type": "SaveImage", "mode": 2,  # muted:不进 prompt 图
             "inputs": [], "widgets_values": ["x"]},
        ],
        "links": [],
    }
    api = ui_to_api(ui)
    assert set(api) == {"1"}


def test_unknown_class_type_strict_vs_lenient():
    ui = {
        "nodes": [
            {"id": 1, "type": "SomeCustomNode", "mode": 0,
             "inputs": [], "widgets_values": [1, "x"]},
            {"id": 2, "type": "SaveImage", "mode": 0,
             "inputs": [{"name": "images", "type": "IMAGE", "link": 5}],
             "widgets_values": ["out"]},
        ],
        "links": [[5, 1, 0, 2, 0, "IMAGE"]],
    }
    with pytest.raises(ValueError, match="未覆盖的节点类型"):
        ui_to_api(ui, strict=True)
    # 宽松模式:未知类丢 widgets 保结构;已知类不受影响
    api = ui_to_api(ui)
    assert api["1"] == {"class_type": "SomeCustomNode", "inputs": {}}
    assert api["2"]["inputs"]["images"] == ["1", 0]
    assert api["2"]["inputs"]["filename_prefix"] == "out"
