from app.workflows.ace_step import AceStepParams, build_ace_step_graph


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
