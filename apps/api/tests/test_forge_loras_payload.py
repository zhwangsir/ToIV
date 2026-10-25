"""Forge txt2img_payload 须把结构化 loras 写入 prompt 的 <lora:> 标签。"""
from app.forge.engine import format_lora_prompt_tags, txt2img_payload


def test_format_lora_prompt_tags():
    assert format_lora_prompt_tags([]) == ""
    assert format_lora_prompt_tags([("a.safetensors", 0.7)]) == "<lora:a.safetensors:0.7>"
    assert (
        format_lora_prompt_tags([("a.safetensors", 0.6), ("b.safetensors", 1.0)])
        == "<lora:a.safetensors:0.6> <lora:b.safetensors:1>"
    )


def test_txt2img_payload_includes_loras_in_prompt():
    payload = txt2img_payload(
        positive="a cat",
        negative="blur",
        loras=[("style.safetensors", 0.8), ("detail.safetensors", 0.5)],
        ckpt="model.safetensors",
    )
    assert "<lora:style.safetensors:0.8>" in payload["prompt"]
    assert "<lora:detail.safetensors:0.5>" in payload["prompt"]
    assert payload["prompt"].startswith("a cat")
    assert payload["negative_prompt"] == "blur"
    assert payload["override_settings"]["sd_model_checkpoint"] == "model.safetensors"


def test_txt2img_payload_loras_only_prompt():
    payload = txt2img_payload(positive="", loras=[("solo.safetensors", 1)])
    assert payload["prompt"] == "<lora:solo.safetensors:1>"


def test_txt2img_payload_no_loras_unchanged():
    payload = txt2img_payload(positive="hello")
    assert payload["prompt"] == "hello"
