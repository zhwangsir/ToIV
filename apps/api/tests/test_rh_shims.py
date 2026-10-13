"""W8 批D-3:RH 云节点本地 shim 的单测。

shim 跑在 workstation 的 ComfyUI 里,本仓库无法真起 ComfyUI;但模块刻意把 torch/PIL
延迟导入到 image_to_data_url 内部,故纯 stdlib 部分(配置解析/请求体拼装/响应解析/
重试与 4xx 不重试/降级语义/签名形状)都能在这里断言。

签名本身的正确性靠另一条证据链:生产库 8142 张 rh-acc 图的 jsonb 聚合(见模块 docstring),
不是靠这里的测试。这里守的是「实现别偏离已实证的签名」。
"""
from __future__ import annotations

import importlib.util
import io
import json
import urllib.error
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
_SHIM = ROOT / "deploy" / "comfy-extensions" / "toiv_rh_shims" / "__init__.py"

_spec = importlib.util.spec_from_file_location("toiv_rh_shims", _SHIM)
shim = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shim)


# ── 注册表:类名必须与生产图里实证的 class_type 逐字一致(差一个空格就缺节点) ──
EXPECTED_CLASSES = {
    "RH_Captioner", "RH_Translator", "RH_Prompter", "RH_LLMAPI_Pro_Node",
    "RH_LLMAPI_NODE", "RH_Captioner_Pro", "Runninghub Captioner",
    "RunningHub Deepcleaner", "RH_GetAudioDuration", "RHHiddenNodes",
}


def test_node_class_mappings_cover_the_evidenced_class_types():
    assert set(shim.NODE_CLASS_MAPPINGS) == EXPECTED_CLASSES
    # 显示名可以有措辞,但键必须与类名一一对应,否则 ComfyUI 前端显示空名
    assert set(shim.NODE_DISPLAY_NAME_MAPPINGS) == EXPECTED_CLASSES


@pytest.mark.parametrize("cls", list(shim.NODE_CLASS_MAPPINGS.values()))
def test_every_node_declares_the_comfyui_contract(cls):
    assert callable(cls.INPUT_TYPES)
    spec = cls.INPUT_TYPES()
    assert isinstance(spec, dict)
    assert isinstance(cls.RETURN_TYPES, tuple) and cls.RETURN_TYPES
    assert len(cls.RETURN_NAMES) == len(cls.RETURN_TYPES)
    assert isinstance(cls.FUNCTION, str) and hasattr(cls, cls.FUNCTION)
    assert cls.CATEGORY == "RH"


# ── 配置 ──
def test_cfg_defaults_point_at_the_verified_local_services(monkeypatch):
    monkeypatch.delenv("TOIV_SHIM_VLM_MODEL", raising=False)
    monkeypatch.delenv("TOIV_SHIM_LLM_MODEL", raising=False)
    # served id 是 2026-10-13 在 workstation 上实测 /v1/models 得到的,写错会 404
    assert shim.cfg("VLM_MODEL") == "toiv-vlm"
    assert shim.cfg("LLM_MODEL") == "deepseek-v4-flash-dspark"
    assert "9311" in shim.cfg("VLM_BASE")
    assert "192.168.71.84:8000" in shim.cfg("LLM_BASE")


def test_cfg_env_override_wins(monkeypatch):
    monkeypatch.setenv("TOIV_SHIM_LLM_MODEL", "glm-5.3-flash")
    assert shim.cfg("LLM_MODEL") == "glm-5.3-flash"


def test_num_falls_back_on_garbage_env(monkeypatch):
    monkeypatch.setenv("TOIV_SHIM_TIMEOUT", "not-a-number")
    assert shim._num("TIMEOUT", 300) == 300


# ── 请求体拼装 ──
def test_payload_plain_text_has_no_image_blocks():
    p = shim.build_chat_payload("m", "sys", "hello")
    assert p["model"] == "m" and p["stream"] is False
    assert p["messages"] == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hello"},
    ]
    # 未显式给的采样参数不得出现:RH 图里的 temperature=0 直透会把本地模型压成贪心解码
    assert "temperature" not in p and "top_p" not in p and "max_tokens" not in p and "seed" not in p


def test_payload_without_system_omits_the_system_message():
    p = shim.build_chat_payload("m", "", "hello")
    assert [m["role"] for m in p["messages"]] == ["user"]


def test_payload_with_images_uses_multimodal_content_blocks():
    p = shim.build_chat_payload("m", "", "desc", images=["data:image/png;base64,AAA"])
    content = p["messages"][-1]["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "desc"}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"] == "data:image/png;base64,AAA"


def test_payload_coerces_numeric_params_and_drops_zero_max_tokens():
    p = shim.build_chat_payload("m", "", "x", temperature=0.7, top_p=0.9, max_tokens=128.0, seed=42.0)
    assert p["temperature"] == 0.7 and p["top_p"] == 0.9
    assert p["max_tokens"] == 128 and isinstance(p["max_tokens"], int)
    assert p["seed"] == 42 and isinstance(p["seed"], int)


# ── 响应解析 ──
def _completion(text):
    return {"choices": [{"message": {"content": text}}]}


def test_extract_text_returns_content():
    assert shim.extract_text(_completion("ok")) == "ok"


def test_extract_text_joins_segmented_content():
    body = {"choices": [{"message": {"content": [{"text": "a"}, {"text": "b"}, {"type": "x"}]}}]}
    assert shim.extract_text(body) == "ab"


@pytest.mark.parametrize("body", [{}, {"choices": []}, {"choices": [{}]}, None])
def test_extract_text_raises_instead_of_returning_empty(body):
    # 返回空串会让下游静默生成空提示词——比抛错难查得多
    with pytest.raises(RuntimeError):
        shim.extract_text(body)


def test_extract_text_raises_on_blank_content():
    with pytest.raises(RuntimeError):
        shim.extract_text(_completion("   "))


# ── 重试语义 ──
class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()
        return False


def _resp(payload):
    return _Resp(json.dumps(payload).encode())


def test_post_chat_returns_text_on_success(monkeypatch):
    monkeypatch.setattr(shim.urllib.request, "urlopen", lambda *a, **k: _resp(_completion("hi")))
    assert shim.post_chat("http://x/v1", {"model": "m"}) == "hi"


def test_post_chat_retries_on_5xx_then_succeeds(monkeypatch):
    calls = {"n": 0}

    def fake(*a, **k):
        calls["n"] += 1
        if calls["n"] < 3:
            raise urllib.error.HTTPError("u", 503, "busy", {}, _Resp(b""))
        return _resp(_completion("ok"))

    monkeypatch.setattr(shim.urllib.request, "urlopen", fake)
    assert shim.post_chat("http://x/v1", {}) == "ok"
    assert calls["n"] == 3


def test_post_chat_does_not_retry_4xx(monkeypatch):
    calls = {"n": 0}

    def fake(*a, **k):
        calls["n"] += 1
        raise urllib.error.HTTPError("u", 404, "no model", {}, _Resp(b'{"error":"model not found"}'))

    monkeypatch.setattr(shim.urllib.request, "urlopen", fake)
    with pytest.raises(RuntimeError) as ei:
        shim.post_chat("http://x/v1", {})
    assert calls["n"] == 1, "4xx 是请求本身的问题,重试只是浪费时间"
    assert "404" in str(ei.value) and "model not found" in str(ei.value)


def test_post_chat_exhausts_retries_and_reports_upstream(monkeypatch):
    calls = {"n": 0}

    def fake(*a, **k):
        calls["n"] += 1
        raise urllib.error.URLError("conn refused")

    monkeypatch.setattr(shim.urllib.request, "urlopen", fake)
    with pytest.raises(RuntimeError) as ei:
        shim.post_chat("http://x/v1", {})
    assert calls["n"] == 3  # 1 + RETRIES(2)
    assert "conn refused" in str(ei.value)


# ── 输入归一与降级 ──
@pytest.mark.parametrize("raw,expected", [(None, ""), ("s", "s"), (12, "12"), (True, "True")])
def test_text_or_none(raw, expected):
    assert shim._text_or_none(raw) == expected


def test_fail_or_fallback_returns_input_when_skip_error():
    assert shim._fail_or_fallback(True, "orig", RuntimeError("boom")) == "orig"


def test_fail_or_fallback_reraises_when_not_skip_error():
    with pytest.raises(RuntimeError):
        shim._fail_or_fallback(False, "orig", RuntimeError("boom"))


# ── 节点行为:空输入不得白花一次 LLM 调用 ──
@pytest.mark.parametrize("cls,arg", [
    (shim._RHTranslator, {"prompt": "  "}),
    (shim._RHPrompter, {"prompt": ""}),
    (shim._RHDeepcleaner, {"bridge_input": None}),
])
def test_empty_input_short_circuits_without_network(cls, arg, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("空输入不该调用 LLM")

    monkeypatch.setattr(shim, "post_chat", boom)
    # 按节点自己声明的 FUNCTION 派发(Translator 叫 translate,其余叫 run)
    fn = getattr(cls(), cls.FUNCTION)
    assert fn(**arg) == ("",)


def test_translator_returns_translated_text(monkeypatch):
    monkeypatch.setattr(shim, "post_chat", lambda base, payload: "  a red dress  ")
    out = shim._RHTranslator().translate(prompt="红色裙子", seed=7)
    assert out == ("a red dress",)


def test_translator_propagates_failure_rather_than_silently_passing_through(monkeypatch):
    # RH_Translator 无 skip_error 字段 → 失败必须抛,否则 smoke 会 pass 但产出的是原文,
    # 用户拿到一张「翻译没生效」的图却看不到任何错误
    def boom(*a, **k):
        raise RuntimeError("upstream down")

    monkeypatch.setattr(shim, "post_chat", boom)
    with pytest.raises(RuntimeError):
        shim._RHTranslator().translate(prompt="x")


def test_llmapi_rewrites_rh_model_name_to_local_served_id(monkeypatch):
    seen = {}

    def fake(base, payload):
        seen.update(payload)
        seen["base"] = base
        return "out"

    monkeypatch.setattr(shim, "post_chat", fake)
    monkeypatch.setenv("TOIV_SHIM_LLM_MODEL", "deepseek-v4-flash-dspark")
    assert shim._RHLLMAPIPro().run(model="gpt-4o", prompt="hi") == ("out",)
    assert seen["model"] == "deepseek-v4-flash-dspark", "RH 云端模型名必须改写成本地 served id"


def test_llmapi_skip_error_falls_back_to_input(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("upstream down")

    monkeypatch.setattr(shim, "post_chat", boom)
    assert shim._RHLLMAPIPro().run(model="gpt-4o", prompt="keepme", skip_error=True) == ("keepme",)
    with pytest.raises(RuntimeError):
        shim._RHLLMAPIPro().run(model="gpt-4o", prompt="keepme", skip_error=False)


# ── RH_GetAudioDuration:纯本地计算 ──
class _FakeWave:
    def __init__(self, frames):
        self.shape = (1, 2, frames)


def test_audio_duration_computes_seconds_from_frames_and_rate():
    out = shim._RHGetAudioDuration().run({"waveform": _FakeWave(48000), "sample_rate": 24000})
    assert out == (2.0,)


def test_audio_duration_rejects_non_dict():
    with pytest.raises(RuntimeError):
        shim._RHGetAudioDuration().run(object())


def test_audio_duration_rejects_missing_sample_rate():
    with pytest.raises(RuntimeError):
        shim._RHGetAudioDuration().run({"waveform": _FakeWave(10), "sample_rate": 0})


# ── RHHiddenNodes:09-15 版的 required image_1 是真图从不传的键 ──
def test_hidden_nodes_no_longer_requires_image_1():
    spec = shim._RHHiddenNodes.INPUT_TYPES()
    assert "required" not in spec or not spec.get("required"), (
        "image_1 设为 required 会让所有真实 RH 图报 "
        "「Required input is missing image_1」——真实图传的是 images_1/var_4_4 一类随图而变的名字"
    )
    assert "image_1" in spec["optional"]


def test_hidden_nodes_passes_through_first_available_image():
    sentinel = object()
    assert shim._RHHiddenNodes().passthrough(image_1=None, image_2=sentinel) == (sentinel,)


def test_hidden_nodes_raises_an_honest_error_when_it_has_nothing():
    with pytest.raises(RuntimeError) as ei:
        shim._RHHiddenNodes().passthrough(pwd="x")
    msg = str(ei.value)
    assert "不可本地部署" in msg and "RHHiddenNodes" in msg


# ── 图像编码(需 numpy/PIL/torch,缺则跳过) ──
def test_image_to_data_url_roundtrips_a_chw_tensor():
    np = pytest.importorskip("numpy")
    pytest.importorskip("PIL")
    pytest.importorskip("torch")
    import torch

    arr = np.zeros((1, 4, 6, 3), dtype="float32")
    arr[0, :, :, 0] = 1.0  # 纯红
    url = shim.image_to_data_url(torch.from_numpy(arr))
    assert url.startswith("data:image/png;base64,")
    import base64
    from PIL import Image

    img = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
    assert img.size == (6, 4)
    assert img.convert("RGB").getpixel((0, 0)) == (255, 0, 0)


def test_image_to_data_url_rejects_uninterpretable_shape():
    pytest.importorskip("numpy")
    pytest.importorskip("PIL")
    pytest.importorskip("torch")
    import numpy as np
    import torch

    with pytest.raises(RuntimeError):
        shim.image_to_data_url(torch.from_numpy(np.zeros((5, 5), dtype="float32")))


# ── RH_LLMAPI_NODE:实测 662 张图在用,是 RH 云 LLM 的主力入口(比 Pro 版 148 多得多) ──
def test_llmapi_node_signature_matches_production_evidence():
    """字段来自生产库 jsonb 聚合:temperature/api_baseurl/model/api_key 各 731/731/731/727 次,
    seed 689、prompt 640(连线)+91(字面量)、ref_image 516、role 412+319、ref_image1..3。"""
    spec = shim._RHLLMAPINode.INPUT_TYPES()
    assert set(spec["required"]) == {"model", "prompt"}
    opt = set(spec["optional"])
    for k in ("api_baseurl", "api_key", "role", "temperature", "seed",
              "ref_image", "ref_image1", "ref_image2", "ref_image3"):
        assert k in opt, f"生产图在用 {k},签名里必须有"
    assert shim._RHLLMAPINode.RETURN_TYPES == ("STRING",), (
        "输出槽 0 实测全部流向文本字段(ProcessString.input_string 260 / ShowText.text 114 / "
        "CLIPTextEncode.text 67 / WanVideoTextEncode.positive_prompt 21)")


def test_llmapi_node_ignores_rh_cloud_endpoint_and_key(monkeypatch):
    """api_baseurl/api_key 指向 RH 云,必须忽略并改用本地后端;密钥不得进请求体。"""
    seen = {}

    def fake(base, payload):
        seen["base"] = base
        seen["payload"] = payload
        return "out"

    monkeypatch.setattr(shim, "post_chat", fake)
    assert shim._RHLLMAPINode().run(
        model="gpt-4o", prompt="hi",
        api_baseurl="https://api.runninghub.ai/v1", api_key="sk-SECRET-DO-NOT-LEAK",
    ) == ("out",)
    blob = json.dumps(seen["payload"])
    assert "sk-SECRET-DO-NOT-LEAK" not in blob and "runninghub" not in blob
    assert "192.168.71.84:8000" in seen["base"], "无图 → 走本地 DSv4"


def test_llmapi_node_routes_to_vlm_when_ref_image_present(monkeypatch):
    seen = {}

    def fake(base, payload):
        seen["base"] = base
        seen["payload"] = payload
        return "cap"

    monkeypatch.setattr(shim, "post_chat", fake)
    pytest.importorskip("numpy"); pytest.importorskip("PIL"); pytest.importorskip("torch")
    import numpy as np
    import torch

    img = torch.from_numpy(np.zeros((1, 4, 4, 3), dtype="float32"))
    assert shim._RHLLMAPINode().run(model="gpt-4o", prompt="describe", ref_image=img) == ("cap",)
    assert "9311" in seen["base"], "带图 → 走本地 Qwen3-VL"
    assert any(b.get("type") == "image_url" for b in seen["payload"]["messages"][-1]["content"])


def test_llmapi_node_failure_raises_because_it_has_no_skip_error(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("upstream down")

    monkeypatch.setattr(shim, "post_chat", boom)
    with pytest.raises(RuntimeError):
        shim._RHLLMAPINode().run(model="m", prompt="x")


def test_captioner_pro_and_runninghub_captioner_aliases_are_registered():
    """同一语义的多种拼写:漏一个就是一批应用在烟测里报 missing_node_type。
    'Runninghub Captioner' 是真机烟测炸出来才发现的——只聚合 RH_Captioner 会漏。"""
    assert shim.NODE_CLASS_MAPPINGS["RH_Captioner_Pro"] is shim._RHLLMAPIPro
    assert shim.NODE_CLASS_MAPPINGS["Runninghub Captioner"] is shim._RHCaptioner
    # Pro 版的 optional 里必须有 image1(RH_Captioner_Pro 实测用 image1)
    assert "image1" in shim._RHLLMAPIPro.INPUT_TYPES()["optional"]
