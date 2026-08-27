from app.workflows.ace_step import (
    ACE_STEP_15_BASE_UNET,
    ACE_STEP_15_CLIP_G,
    ACE_STEP_15_CLIP_L,
    ACE_STEP_15_TURBO_AIO,
    ACE_STEP_15_VAE,
    AceStep15Params,
    AceStepParams,
    ace_step_15_required_models,
    build_ace_step_15_graph,
    build_ace_step_graph,
)


def test_checkpoint_and_text_wiring():
    g = build_ace_step_graph(AceStepParams(tags="lofi, piano"))
    assert g["1"]["class_type"] == "CheckpointLoaderSimple"
    assert g["3"]["inputs"]["clip"] == ["1", 1]
    assert g["3"]["inputs"]["tags"] == "lofi, piano"


def test_negative_is_zeroed_positive():
    g = build_ace_step_graph(AceStepParams(tags="x"))
    assert g["4"]["class_type"] == "ConditioningZeroOut"
    assert g["4"]["inputs"]["conditioning"] == ["3", 0]
    ks = g["5"]["inputs"]
    assert ks["positive"] == ["3", 0]
    assert ks["negative"] == ["4", 0]
    assert ks["latent_image"] == ["2", 0]


def test_seconds_and_audio_decode_save():
    g = build_ace_step_graph(AceStepParams(tags="x", seconds=45.0))
    assert g["2"]["inputs"]["seconds"] == 45.0
    assert g["6"]["class_type"] == "VAEDecodeAudio"
    assert g["6"]["inputs"]["vae"] == ["1", 2]
    assert g["7"]["class_type"] == "SaveAudioMP3"
    assert g["7"]["inputs"]["audio"] == ["6", 0]


# ---------------------------------------------------------------------------
# ACE-Step 1.5(ComfyUI 原生节点;Turbo AIO 草稿 / split base 成品双档)
# ---------------------------------------------------------------------------


def test_ace15_turbo_aio_graph_structure():
    g = build_ace_step_15_graph(AceStep15Params(tags="lofi, piano"))
    assert g["1"]["class_type"] == "CheckpointLoaderSimple"
    assert g["1"]["inputs"]["ckpt_name"] == ACE_STEP_15_TURBO_AIO
    assert g["2"]["class_type"] == "ModelSamplingAuraFlow"
    assert g["2"]["inputs"]["model"] == ["1", 0]
    assert g["2"]["inputs"]["shift"] == 3.0
    enc = g["3"]
    assert enc["class_type"] == "TextEncodeAceStepAudio1.5"
    assert enc["inputs"]["clip"] == ["1", 1]
    assert enc["inputs"]["tags"] == "lofi, piano"


def test_ace15_turbo_defaults_eight_steps_cfg1():
    g = build_ace_step_15_graph(AceStep15Params(tags="x"))
    ks = g["6"]["inputs"]
    assert ks["steps"] == 8
    assert ks["cfg"] == 1.0
    assert ks["model"] == ["2", 0]
    assert ks["positive"] == ["3", 0]
    assert ks["negative"] == ["4", 0]
    assert ks["latent_image"] == ["5", 0]
    assert g["4"]["class_type"] == "ConditioningZeroOut"
    assert g["4"]["inputs"]["conditioning"] == ["3", 0]


def test_ace15_seed_shared_between_encoder_and_sampler():
    g = build_ace_step_15_graph(AceStep15Params(tags="x", seed=42))
    assert g["3"]["inputs"]["seed"] == 42
    assert g["6"]["inputs"]["seed"] == 42


def test_ace15_seconds_passthrough_and_audio_tail():
    g = build_ace_step_15_graph(AceStep15Params(tags="x", seconds=95.0))
    assert g["3"]["inputs"]["duration"] == 95.0
    assert g["5"]["class_type"] == "EmptyAceStep1.5LatentAudio"
    assert g["5"]["inputs"]["seconds"] == 95.0
    assert g["7"]["class_type"] == "VAEDecodeAudio"
    assert g["7"]["inputs"]["samples"] == ["6", 0]
    assert g["7"]["inputs"]["vae"] == ["1", 2]
    assert g["8"]["class_type"] == "SaveAudioMP3"
    assert g["8"]["inputs"]["audio"] == ["7", 0]


def test_ace15_metadata_params():
    g = build_ace_step_15_graph(
        AceStep15Params(tags="x", bpm=90, language="zh", keyscale="A minor", timesignature="3")
    )
    enc = g["3"]["inputs"]
    assert enc["bpm"] == 90
    assert enc["language"] == "zh"
    assert enc["keyscale"] == "A minor"
    assert enc["timesignature"] == "3"
    assert enc["generate_audio_codes"] is True


def test_ace15_encode_includes_lm_sampling_advanced_inputs():
    # TextEncodeAceStepAudio1.5 的 advanced 输入在 API 校验下同样必填(生产 400 实证)
    g = build_ace_step_15_graph(AceStep15Params(tags="x"))
    enc = g["3"]["inputs"]
    for key, default in [("cfg_scale", 2.0), ("temperature", 0.85), ("top_p", 0.9), ("top_k", 0), ("min_p", 0.0)]:
        assert enc[key] == default, f"{key} 缺失或非默认值"
    gq = build_ace_step_15_graph(AceStep15Params(tags="x", quality="quality"))
    for key in ("cfg_scale", "temperature", "top_p", "top_k", "min_p"):
        assert key in gq["5"]["inputs"], f"quality 档 {key} 缺失"


def test_ace15_quality_split_graph():
    g = build_ace_step_15_graph(AceStep15Params(tags="x", quality="quality"))
    assert g["1"]["class_type"] == "UNETLoader"
    assert g["1"]["inputs"]["unet_name"] == ACE_STEP_15_BASE_UNET
    assert g["2"]["class_type"] == "DualCLIPLoader"
    assert g["2"]["inputs"]["clip_name1"] == ACE_STEP_15_CLIP_L
    assert g["2"]["inputs"]["clip_name2"] == ACE_STEP_15_CLIP_G
    assert g["2"]["inputs"]["type"] == "ace"
    assert g["3"]["class_type"] == "VAELoader"
    assert g["3"]["inputs"]["vae_name"] == ACE_STEP_15_VAE
    assert g["4"]["class_type"] == "ModelSamplingAuraFlow"
    assert g["4"]["inputs"]["model"] == ["1", 0]
    ks = g["8"]["inputs"]
    assert ks["steps"] == 50
    assert ks["cfg"] == 5.0
    assert ks["model"] == ["4", 0]
    assert ks["positive"] == ["5", 0]
    assert ks["negative"] == ["6", 0]
    assert ks["latent_image"] == ["7", 0]
    assert g["9"]["class_type"] == "VAEDecodeAudio"
    assert g["9"]["inputs"]["vae"] == ["3", 0]
    assert g["10"]["class_type"] == "SaveAudioMP3"


def test_ace15_explicit_steps_cfg_override():
    g = build_ace_step_15_graph(AceStep15Params(tags="x", steps=12, cfg=2.5))
    assert g["6"]["inputs"]["steps"] == 12
    assert g["6"]["inputs"]["cfg"] == 2.5


def test_ace15_required_models_by_quality():
    assert ace_step_15_required_models(AceStep15Params(tags="x")) == {ACE_STEP_15_TURBO_AIO}
    assert ace_step_15_required_models(AceStep15Params(tags="x", quality="quality")) == {
        ACE_STEP_15_BASE_UNET,
        ACE_STEP_15_CLIP_L,
        ACE_STEP_15_CLIP_G,
        ACE_STEP_15_VAE,
    }


def test_ace15_rejects_unknown_quality():
    import pytest

    with pytest.raises(ValueError):
        build_ace_step_15_graph(AceStep15Params(tags="x", quality="ultra"))
