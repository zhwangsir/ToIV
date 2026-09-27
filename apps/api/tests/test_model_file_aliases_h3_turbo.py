from app.routes.apps import _normalize_model_file_aliases


def test_h3_turbo_converted_lora_maps_to_official_comfy():
    g = {
        "249": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "lora_name": "minimax_h3_turbo_4step-convertedByAIEverything.safetensors",
                "strength_model": 0.68,
                "model": ["1", 0],
            },
        },
        "250": {"class_type": "LoraLoader", "inputs": {"lora_name": "keep_me.safetensors"}},
    }
    _normalize_model_file_aliases(g)
    assert g["249"]["inputs"]["lora_name"] == "MiniMax-H3-Turbo-4step-Lora_ema_comfy.safetensors"
    assert g["249"]["inputs"]["model"] == ["1", 0]
    assert g["250"]["inputs"]["lora_name"] == "keep_me.safetensors"
