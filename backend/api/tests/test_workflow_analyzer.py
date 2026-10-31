"""应用市场 M5:工作流结构分析器测试(services/workflow_analyzer)。

覆盖:
  - 格式嗅探:UI nodes[] / API class_type / {"prompt": ...} 归档壳 / 垃圾输入
  - UI 输入先经 workflow_convert 归一化再分析
  - 输入透镜:CLIPTextEncode→prompt(被连线占用的 text 不算)、LoadImage→images、
    LoadAudio→audio、LoadVideo→video
  - 数值 widget 候选:steps/cfg/seed/width/height 等白名单字段,连线/字符串/布尔不收
  - 产物类型推断:SaveVideo 系→video / SaveImage→image / 无产物节点兜底 image
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.workflow_analyzer import analyze_workflow, sniff_format

_TEMPLATES = Path(__file__).resolve().parents[1] / "app" / "workflows"

_API_GRAPH = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
    "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat", "clip": ["1", 1]}},
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": ["9", 0]}},  # text 被连线占用
    "4": {"class_type": "KSampler", "inputs": {
        "seed": 42, "steps": 20, "cfg": 1.0, "sampler_name": "euler",
        "model": ["1", 0], "positive": ["2", 0], "denoise": True,  # bool 不收
    }},
    "5": {"class_type": "SaveImage", "inputs": {"images": ["4", 0]}},
}


def test_sniff_formats():
    assert sniff_format({"nodes": [], "links": []}) == "ui"
    assert sniff_format(_API_GRAPH) == "api"
    assert sniff_format({"prompt": _API_GRAPH}) == "api"  # 归档壳
    with pytest.raises(ValueError):
        sniff_format({"foo": "bar"})
    with pytest.raises(ValueError):
        sniff_format({"1": {"inputs": {}}})  # 缺 class_type


def test_analyze_api_prompt_lens_and_numeric():
    a = analyze_workflow(_API_GRAPH)
    assert a.format == "api"
    # 透镜:2 的 text 是标量 → 入选;3 的 text 被连线占用 → 不算入口
    assert [p["node"] for p in a.prompt_inputs] == ["2"]
    assert a.prompt_inputs[0]["field"] == "inputs.text"
    assert a.prompt_inputs[0]["role"] == "positive"
    # 数值候选:seed/steps/cfg 入选;sampler_name 是字符串、denoise 是 bool → 不收
    got = {(c["node"], c["field"]) for c in a.numeric_candidates}
    assert ("4", "inputs.seed") in got
    assert ("4", "inputs.steps") in got
    assert ("4", "inputs.cfg") in got
    assert all(c["field"] != "inputs.sampler_name" for c in a.numeric_candidates)
    assert all(c["field"] != "inputs.denoise" for c in a.numeric_candidates)
    assert a.output_kind == "image"
    assert set(a.class_types) == {
        "CheckpointLoaderSimple", "CLIPTextEncode", "KSampler", "SaveImage",
    }


def test_analyze_ui_goes_through_convert():
    with open(_TEMPLATES / "txt2img_basic.json", encoding="utf-8") as f:
        ui = json.load(f)
    a = analyze_workflow(ui)
    assert a.format == "ui"
    # 归一化后 KSampler 的 widgets 已具名,numeric 候选能找到 steps
    steps = [c for c in a.numeric_candidates if c["field"] == "inputs.steps"]
    assert steps and steps[0]["value"] == 20
    assert len(a.prompt_inputs) == 2  # 正/负向两个 CLIPTextEncode


def test_analyze_media_lenses():
    graph = {
        "1": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
        "2": {"class_type": "LoadVideo", "inputs": {"file": "b.mp4"}},
        "3": {"class_type": "LoadAudio", "inputs": {"audio": "c.wav"}},
        "9": {"class_type": "SaveVideo", "inputs": {"video": ["2", 0]}},
    }
    a = analyze_workflow(graph)
    assert a.image_inputs[0]["node"] == "1"
    assert a.video_inputs[0]["node"] == "2"
    assert a.audio_inputs[0]["node"] == "3"
    assert a.output_kind == "video"


def test_analyze_h3_wrapper_video_and_seed_candidate():
    with open(_TEMPLATES / "h3" / "t2v_prompt.json", encoding="utf-8") as f:
        wrapper = json.load(f)
    a = analyze_workflow(wrapper)
    assert a.format == "api"
    assert a.output_kind == "video"  # SaveVideo
    # noise_seed / width / height / steps 均在候选;CLIPTextEncode 不存在 → 无 prompt 透镜
    fields = {c["field"] for c in a.numeric_candidates}
    assert {"inputs.noise_seed", "inputs.width", "inputs.height", "inputs.steps"} <= fields
    assert a.prompt_inputs == []
