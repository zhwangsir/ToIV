"""脸部修复工作流构造器单测。"""
from __future__ import annotations

from app.workflows.facedetailer import FaceDetailerParams, build_facedetailer_graph


def _classes(g: dict) -> set[str]:
    return {n["class_type"] for n in g.values()}


def test_graph_has_core_facedetailer_nodes():
    g = build_facedetailer_graph(FaceDetailerParams(image="a.png"))
    cls = _classes(g)
    assert {"FaceDetailer", "UltralyticsDetectorProvider", "SAMLoader", "SaveImage"} <= cls


def test_facedetailer_wiring():
    g = build_facedetailer_graph(FaceDetailerParams(image="hero.png"))
    fd = g["22"]["inputs"]
    assert g["11"]["inputs"]["image"] == "hero.png"
    assert fd["image"] == ["11", 0]
    assert fd["bbox_detector"] == ["20", 0]
    assert fd["sam_model_opt"] == ["21", 0]
    assert fd["positive"] == ["6", 0]
    assert fd["negative"] == ["7", 0]
    assert fd["vae"] == ["4", 2]


def test_required_tuning_inputs_present():
    """worker 必填项必须齐全(缺则 ComfyUI 校验 400)。"""
    fd = build_facedetailer_graph(FaceDetailerParams(image="a.png"))["22"]["inputs"]
    for k in (
        "guide_size", "guide_size_for", "max_size", "noise_mask", "force_inpaint",
        "bbox_threshold", "bbox_dilation", "bbox_crop_factor", "sam_detection_hint",
        "sam_dilation", "sam_threshold", "sam_bbox_expansion", "sam_mask_hint_threshold",
        "sam_mask_hint_use_negative", "drop_size", "wildcard", "cycle",
    ):
        assert k in fd, f"缺少必填项 {k}"


def test_non_vpred_has_no_model_sampling():
    g = build_facedetailer_graph(FaceDetailerParams(image="a.png", ckpt_name="DreamShaper_8_pruned.safetensors"))
    assert "ModelSamplingDiscrete" not in _classes(g)
    assert g["22"]["inputs"]["model"] == ["4", 0]


def test_vpred_inserts_model_sampling_before_facedetailer():
    g = build_facedetailer_graph(FaceDetailerParams(image="a.png", ckpt_name="noobaiXL_vpred10.safetensors"))
    assert "ModelSamplingDiscrete" in _classes(g)
    # FaceDetailer.model 不再直引 checkpoint,而是取 ModelSamplingDiscrete 输出
    assert g["22"]["inputs"]["model"] != ["4", 0]
