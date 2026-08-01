"""PuLID-Flux 角色一致性工作流构造器测试(纯图断言 + pool 探测,ComfyUI 不可达也能跑)。

覆盖:
- 图含 PuLID 四节点(PulidFluxModelLoader/InsightFaceLoader/EvaClipLoader/ApplyPulidFlux);
- ckpt / pulid 权重文件名正确进图;
- ApplyPulidFlux 在采样链上游(KSampler.model 取 ApplyPulidFlux 输出);
- 参考图(LoadImage)接到 ApplyPulidFlux.image;
- FluxGuidance 串在正向编码与 KSampler.positive 之间;
- weight/start_at/end_at/guidance 等参数透传;
- is_available:pool 有/无 PuLID 能力两路。
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock

from app.comfy.client import ComfyUIError
from app.workflows.pulid import (
    DEFAULT_CKPT,
    DEFAULT_PULID_FILE,
    REQUIRED_NODES,
    PulidTxt2ImgParams,
    build_pulid_txt2img_graph,
    is_available,
)


def _g(**kw):
    base = dict(positive="hero portrait", ref_image="char.png")
    base.update(kw)
    return build_pulid_txt2img_graph(PulidTxt2ImgParams(**base))


def test_graph_contains_pulid_nodes():
    g = _g()
    classes = {n["class_type"] for n in g.values()}
    assert REQUIRED_NODES.issubset(classes)
    # 标准 txt2img 节点仍在
    assert {"KSampler", "CheckpointLoaderSimple", "EmptyLatentImage", "CLIPTextEncode",
            "VAEDecode", "SaveImage", "LoadImage", "FluxGuidance"}.issubset(classes)


def test_ckpt_and_pulid_weights_in_graph():
    g = _g()
    ckpt = g["4"]
    assert ckpt["class_type"] == "CheckpointLoaderSimple"
    assert ckpt["inputs"]["ckpt_name"] == DEFAULT_CKPT
    assert ckpt["inputs"]["ckpt_name"] == "flux1-dev-fp8.safetensors"
    loader = g["300"]
    assert loader["class_type"] == "PulidFluxModelLoader"
    assert loader["inputs"]["pulid_file"] == DEFAULT_PULID_FILE
    assert loader["inputs"]["pulid_file"] == "pulid_flux_v0.9.1.safetensors"


def test_apply_pulid_upstream_of_sampler():
    g = _g()
    apply = g["303"]
    assert apply["class_type"] == "ApplyPulidFlux"
    # ApplyPulidFlux 的 model 直引 checkpoint,三个加载器各就各位
    assert apply["inputs"]["model"] == ["4", 0]
    assert apply["inputs"]["pulid_flux"] == ["300", 0]
    assert apply["inputs"]["face_analysis"] == ["301", 0]
    assert apply["inputs"]["eva_clip"] == ["302", 0]
    # KSampler.model 取 ApplyPulidFlux 输出(角色条件化后的 MODEL)
    assert g["3"]["inputs"]["model"] == ["303", 0]


def test_ref_image_wired_into_apply():
    g = _g(ref_image="myhero.png")
    assert g["304"]["class_type"] == "LoadImage"
    assert g["304"]["inputs"]["image"] == "myhero.png"
    assert g["303"]["inputs"]["image"] == ["304", 0]


def test_flux_guidance_between_positive_and_sampler():
    g = _g(guidance=4.0)
    guidance = g["305"]
    assert guidance["class_type"] == "FluxGuidance"
    assert guidance["inputs"]["conditioning"] == ["6", 0]
    assert guidance["inputs"]["guidance"] == 4.0
    assert g["3"]["inputs"]["positive"] == ["305", 0]
    # clip 线不受 PuLID 影响,直引 checkpoint
    assert g["6"]["inputs"]["clip"] == ["4", 1]
    assert g["7"]["inputs"]["clip"] == ["4", 1]


def test_flux_sampling_defaults():
    """采样档对齐 flux 族:cfg=1.0 / euler / simple(flux 为 guidance 蒸馏模型)。"""
    g = _g()
    ks = g["3"]["inputs"]
    assert ks["cfg"] == 1.0
    assert ks["sampler_name"] == "euler"
    assert ks["scheduler"] == "simple"


def test_pulid_params_passthrough():
    g = _g(weight=0.7, start_at=0.1, end_at=0.8, steps=28, ckpt_name="other.safetensors")
    apply = g["303"]["inputs"]
    assert apply["weight"] == 0.7
    assert apply["start_at"] == 0.1
    assert apply["end_at"] == 0.8
    assert g["3"]["inputs"]["steps"] == 28
    assert g["4"]["inputs"]["ckpt_name"] == "other.safetensors"


def test_graph_is_fresh_dict_each_call():
    g1 = _g()
    g2 = _g()
    assert g1 is not g2
    g1["303"]["inputs"]["weight"] = 9.9
    assert g2["303"]["inputs"]["weight"] == 1.0


# ---------------------------------------------------------------------------
# is_available(pool) 探测
# ---------------------------------------------------------------------------
def test_is_available_true_when_pool_has_pulid():
    pool = MagicMock()
    pool.pick = AsyncMock(return_value=MagicMock())
    assert asyncio.run(is_available(pool, "flux1-dev-fp8.safetensors")) is True
    kw = pool.pick.call_args.kwargs
    assert kw["required"] == {"flux1-dev-fp8.safetensors"}
    assert kw["required_nodes"] == REQUIRED_NODES


def test_is_available_false_when_pool_lacks_pulid():
    pool = MagicMock()
    pool.pick = AsyncMock(side_effect=ComfyUIError("没有具备所需模型且可用的 worker"))
    assert asyncio.run(is_available(pool, "flux1-dev-fp8.safetensors")) is False
