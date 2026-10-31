"""IPAdapter 角色一致性工作流构造器测试(纯图断言,ComfyUI 不可达也能跑)。

覆盖:
- 图含 IPAdapterUnifiedLoader + IPAdapterAdvanced;
- 参考图(LoadImage)接到 IPAdapterAdvanced.image;
- IPAdapter 输出的 MODEL 接到 KSampler.model;
- preset/weight 等参数透传;
- LoRA / v-pred 与 IPAdapter 在 model 线上正确串联;
- 端点层无 character_ref 时回退普通 txt2img。
"""
from app.workflows.ipadapter import (
    DEFAULT_PRESET,
    MAX_SEED,
    IPAdapterTxt2ImgParams,
    build_ipadapter_txt2img_graph,
)
from app.workflows.lora import LoraSpec
from app.routes.manju import ShotRenderRequest, _build_shot_graph


def _g(**kw):
    base = dict(positive="hero portrait", ref_image="char.png")
    base.update(kw)
    return build_ipadapter_txt2img_graph(IPAdapterTxt2ImgParams(**base))


def test_graph_contains_ipadapter_nodes():
    g = _g()
    classes = {n["class_type"] for n in g.values()}
    assert "IPAdapterUnifiedLoader" in classes
    assert "IPAdapterAdvanced" in classes
    # 标准 txt2img 节点仍在
    assert {"KSampler", "CheckpointLoaderSimple", "EmptyLatentImage", "CLIPTextEncode",
            "VAEDecode", "SaveImage"}.issubset(classes)


def test_unified_loader_uses_preset_and_model_from_checkpoint():
    g = _g()
    loader = g["200"]
    assert loader["class_type"] == "IPAdapterUnifiedLoader"
    assert loader["inputs"]["preset"] == DEFAULT_PRESET
    # 无 LoRA 时 UnifiedLoader 直引 checkpoint 的 model
    assert loader["inputs"]["model"] == ["4", 0]


def test_ref_image_wired_into_ipadapter_advanced():
    g = _g(ref_image="myhero.png")
    # 参考图节点
    assert g["202"]["class_type"] == "LoadImage"
    assert g["202"]["inputs"]["image"] == "myhero.png"
    # Advanced 的 image 接 LoadImage 输出
    adv = g["201"]
    assert adv["class_type"] == "IPAdapterAdvanced"
    assert adv["inputs"]["image"] == ["202", 0]
    # ipadapter / model 接 UnifiedLoader 的两个输出
    assert adv["inputs"]["model"] == ["200", 0]
    assert adv["inputs"]["ipadapter"] == ["200", 1]


def test_ipadapter_model_feeds_ksampler():
    g = _g()
    # KSampler 的 model 取 IPAdapterAdvanced 输出(角色条件化后的 MODEL)
    assert g["3"]["inputs"]["model"] == ["201", 0]


def test_ipadapter_params_passthrough():
    g = _g(weight=0.55, weight_type="ease in-out", start_at=0.1, end_at=0.9,
           preset="PLUS (high strength)")
    adv = g["201"]["inputs"]
    assert adv["weight"] == 0.55
    assert adv["weight_type"] == "ease in-out"
    assert adv["start_at"] == 0.1
    assert adv["end_at"] == 0.9
    assert g["200"]["inputs"]["preset"] == "PLUS (high strength)"


def test_ipadapter_advanced_has_required_embed_inputs():
    """combine_embeds / embeds_scaling 是 worker 必填项,缺失会被 ComfyUI 拒为 400。
    默认须落到节点合法枚举首项;自定义值须透传。"""
    g = _g()
    adv = g["201"]["inputs"]
    assert adv["combine_embeds"] == "concat"
    assert adv["embeds_scaling"] == "V only"
    g2 = _g(combine_embeds="average", embeds_scaling="K+V")
    adv2 = g2["201"]["inputs"]
    assert adv2["combine_embeds"] == "average"
    assert adv2["embeds_scaling"] == "K+V"


def test_clip_text_encoders_unaffected_by_ipadapter():
    """IPAdapter 只动 model 线;CLIP 仍直引 checkpoint。"""
    g = _g(positive="p", negative="n")
    assert g["6"]["inputs"]["text"] == "p"
    assert g["7"]["inputs"]["text"] == "n"
    assert g["6"]["inputs"]["clip"] == ["4", 1]
    assert g["7"]["inputs"]["clip"] == ["4", 1]


def test_lora_chain_feeds_ipadapter_loader():
    """有 LoRA 时:checkpoint → LoraLoader → IPAdapterUnifiedLoader。"""
    g = _g(loras=(LoraSpec("style.safetensors", 0.7),))
    assert g["100"]["class_type"] == "LoraLoader"
    # UnifiedLoader 的 model 取 LoRA 链末端,而非直引 checkpoint
    assert g["200"]["inputs"]["model"] == ["100", 0]
    # CLIP 仍走 LoRA 链末端
    assert g["6"]["inputs"]["clip"] == ["100", 1]


def test_vpred_inserts_model_sampling_after_ipadapter():
    """v-pred ckpt 时,ModelSamplingDiscrete 在 IPAdapter 之后、KSampler 之前。"""
    g = _g(ckpt_name="NoobAI-XL-Vpred-v1.0.safetensors")
    classes = {n["class_type"] for n in g.values()}
    assert "ModelSamplingDiscrete" in classes
    # KSampler 不再直接取 IPAdapterAdvanced,而是取 ModelSamplingDiscrete 的输出
    ks_model = g["3"]["inputs"]["model"]
    msd_id = ks_model[0]
    assert g[msd_id]["class_type"] == "ModelSamplingDiscrete"
    # ModelSamplingDiscrete 的输入来自 IPAdapterAdvanced
    assert g[msd_id]["inputs"]["model"] == ["201", 0]


def test_non_vpred_has_no_model_sampling():
    g = _g(ckpt_name="DreamShaper_8_pruned.safetensors")
    assert "ModelSamplingDiscrete" not in {n["class_type"] for n in g.values()}
    assert g["3"]["inputs"]["model"] == ["201", 0]


def test_returns_new_dict_each_call():
    p = IPAdapterTxt2ImgParams(positive="x", ref_image="r.png", seed=1)
    assert build_ipadapter_txt2img_graph(p) is not build_ipadapter_txt2img_graph(p)


def test_random_seed_in_range_when_unspecified():
    p = IPAdapterTxt2ImgParams(positive="x", ref_image="r.png")
    assert 0 <= p.seed <= MAX_SEED


# --- 端点层:character_ref 决定 IPAdapter vs txt2img 降级 -------------------


def test_shot_with_character_ref_builds_ipadapter_graph():
    req = ShotRenderRequest(positive="shot 1", worker="http://x", character_ref="hero.png")
    graph, mode = _build_shot_graph(req, "DreamShaper_8_pruned.safetensors")
    assert mode == "manju_shot_ipadapter"
    classes = {n["class_type"] for n in graph.values()}
    assert "IPAdapterUnifiedLoader" in classes
    assert "IPAdapterAdvanced" in classes
    assert graph["3"]["inputs"]["model"] == ["201", 0]


def test_shot_without_character_ref_falls_back_to_txt2img():
    req = ShotRenderRequest(positive="shot 2", worker="http://x", character_ref=None)
    graph, mode = _build_shot_graph(req, "DreamShaper_8_pruned.safetensors")
    assert mode == "manju_shot_txt2img"
    classes = {n["class_type"] for n in graph.values()}
    assert "IPAdapterUnifiedLoader" not in classes
    assert "IPAdapterAdvanced" not in classes
    # 普通 txt2img:KSampler 直引 checkpoint
    assert graph["3"]["inputs"]["model"] == ["4", 0]


def test_shot_empty_string_ref_also_falls_back():
    req = ShotRenderRequest(positive="shot 3", worker="http://x", character_ref="   ")
    _, mode = _build_shot_graph(req, "DreamShaper_8_pruned.safetensors")
    assert mode == "manju_shot_txt2img"
