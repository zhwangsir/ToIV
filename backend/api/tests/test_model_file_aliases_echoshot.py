from app.routes.apps import _normalize_model_file_aliases


def test_echoshot_mps_reward_lora_maps_to_comfy_variant():
    g = {
        "101": {"class_type": "WanVideoLoraSelect", "inputs": {"lora": "Wan2.1-Fun-1.3B-InP-MPS_reward_lora.safetensors", "strength": 1.0}},
        "75": {"class_type": "WanVideoLoraSelect", "inputs": {"lora": "Wan2_1_self_forcing_dmd_1_3B_lora_rank_32_fp16.safetensors"}},
    }
    _normalize_model_file_aliases(g)
    assert g["101"]["inputs"]["lora"] == "Wan2.1-Fun-1.3B-InP-MPS_reward_lora_comfy.safetensors"
    assert g["75"]["inputs"]["lora"] == "Wan2_1_self_forcing_dmd_1_3B_lora_rank_32_fp16.safetensors"
