"""H3 FL2VA RH 名直传(2026-10-11 W2.0 复盘)。

10-10 的别名把 RH 合规名改写成 NAS pruned 名,结果 RH 节点的 converter 命名
分区校验拒绝 NAS 名(实弹烟测 fail: "carries no partition proof")。设备侧权重根
已有同名合规软链,RH 名必须原样透传——本测试锁死"不再映射"防回潮。
"""
from app.routes.apps import _normalize_model_file_aliases


def test_h3_fl2va_rh_names_pass_through():
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
            "inputs": {"transformer_path": "MiniMax-H3-FL2VA-int8-convrot.safetensors"},
        },
    }
    _normalize_model_file_aliases(g)
    # RH 合规名原样透传(权重根同名软链承载,分区证据在文件名)
    assert (
        g["1"]["inputs"]["transformer_path"]
        == "MiniMax-H3-FL2VA-int8_convrot.safetensors"
    )
    assert g["1"]["inputs"]["model_root"] == "MiniMax-H3"
    assert g["2"]["inputs"]["audio_vae_path"] == "MiniMax-H3-audio_vae.safetensors"
    assert g["2"]["inputs"]["video_vae_path"] == "MiniMax-H3-video_vae.safetensors"
    assert (
        g["3"]["inputs"]["transformer_path"]
        == "MiniMax-H3-FL2VA-int8-convrot.safetensors"
    )
    assert g["4"]["inputs"]["unet_name"] == "keep_me.safetensors"
    assert (
        g["5"]["inputs"]["transformer_path"]
        == "MiniMax-H3-FL2VA-int8-convrot.safetensors"
    )
