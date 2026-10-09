from app.routes.apps import _normalize_model_file_aliases


def test_h3_fl2va_rh_names_map_to_nas_pruned():
    g = {
        "1": {
            "class_type": "RHMiniMaxH3FL2VAModelLoader",
            "inputs": {
                "transformer_path": "MiniMax-H3-FL2VA-int8_convrot.safetensors",
                "model_root": "MiniMax-H3",
                "dtype": "auto",
            },
        },
        "2": {
            "class_type": "RHMiniMaxH3FL2VAVAELoader",
            "inputs": {
                "audio_vae_path": "MiniMax-H3-audio_vae.safetensors",
                "video_vae_path": "MiniMax-H3-video_vae.safetensors",
                "model_root": "MiniMax-H3",
            },
        },
        "3": {
            "class_type": "RHMiniMaxH3FL2VAModelLoader",
            "inputs": {
                "transformer_path": "MiniMax-H3-FL2VA-int8-convrot.safetensors",
                "model_root": "MiniMax-H3",
            },
        },
        "4": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": "keep_me.safetensors"},
        },
        "5": {
            "class_type": "SomeOtherNode",
            "inputs": {"transformer_path": "MiniMax-H3-FL2VA-int8_convrot.safetensors"},
        },
    }
    _normalize_model_file_aliases(g)
    assert (
        g["1"]["inputs"]["transformer_path"]
        == "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
    )
    assert g["1"]["inputs"]["model_root"] == "MiniMax-H3"
    assert g["2"]["inputs"]["audio_vae_path"] == "minimax_h3_audio_vae_fp32.safetensors"
    assert g["2"]["inputs"]["video_vae_path"] == "minimax_h3_video_vae_fp16.safetensors"
    assert g["2"]["inputs"]["model_root"] == "MiniMax-H3"
    assert (
        g["3"]["inputs"]["transformer_path"]
        == "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
    )
    assert g["4"]["inputs"]["unet_name"] == "keep_me.safetensors"
    # unregistered class_type: leave literal alone
    assert (
        g["5"]["inputs"]["transformer_path"]
        == "MiniMax-H3-FL2VA-int8_convrot.safetensors"
    )
