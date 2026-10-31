"""_fetch_class_specs 的重试与诚实归因(2026-10-14)。

背景:实例装载 19.5GB 级模型时 ComfyUI 的 HTTP 服务与执行共用一个事件循环,会被阻塞几十秒
(实测 `/object_info/SeedVR2` 在 :8196 上依次 35s 无响应 → 8.7s → 6ms)。旧代码把每次抓取
包在 `except Exception: pass` 里,于是装载窗口内的探测失败被吞成"这个类没有规格",
`combo_repair` 补不了缺失的必填输入,应用被记成自己的 validation 失败(P-11 同型)。
"""
from __future__ import annotations

from app.services.app_smoke import (
    _fetch_class_specs,
    _spec_incomplete_note,
    classify_failure,
    combo_repair,
)


class FlakyClient:
    """前 fail_times 次抛错,之后正常返回。记录每个类被问了几次。"""

    def __init__(self, spec: dict, fail_times: int = 0):
        self.spec = spec
        self.fail_times = fail_times
        self.calls: dict[str, int] = {}

    async def object_info(self, class_type: str):
        self.calls[class_type] = self.calls.get(class_type, 0) + 1
        if self.calls[class_type] <= self.fail_times:
            raise TimeoutError("event loop blocked by 19.5GB staging")
        return {class_type: self.spec[class_type]}


GRAPH = {
    "1": {"class_type": "SeedVR2", "inputs": {"images": ["0", 0]}},
    "2": {"class_type": "SaveImage", "inputs": {}},
}
SPEC = {
    "SeedVR2": {"input": {"required": {
        "images": ["IMAGE"],
        "input_noise_scale": ["FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0}],
        "color_correction": [["wavelet", "adain", "none"], {"default": "wavelet"}],
    }}},
    "SaveImage": {"input": {"required": {"images": ["IMAGE"]}}},
}


async def test_transient_failure_is_retried_and_spec_survives():
    client = FlakyClient(SPEC, fail_times=1)
    specs, failed = await _fetch_class_specs(client, GRAPH)
    assert failed == []
    assert "SeedVR2" in specs and "SaveImage" in specs
    assert client.calls["SeedVR2"] == 2  # 失败一次后确实重试了


async def test_permanent_failure_is_reported_not_swallowed():
    client = FlakyClient(SPEC, fail_times=99)
    specs, failed = await _fetch_class_specs(client, GRAPH, tries=2)
    assert sorted(failed) == ["SaveImage", "SeedVR2"]
    assert specs == {}
    assert client.calls["SeedVR2"] == 2  # 重试到 tries 上限就停,不无限打实例


async def test_retry_lets_combo_repair_inject_the_falsy_default():
    """0.0 是合法默认值:抓到规格就该补上(旧代码在探测失败时补不了)。"""
    ok = FlakyClient(SPEC, fail_times=1)
    specs, failed = await _fetch_class_specs(ok, GRAPH)
    graph = {"1": {"class_type": "SeedVR2", "inputs": {"images": ["0", 0]}}}
    edits: list = []
    fixes = combo_repair(graph, specs, edits)
    assert failed == []
    assert graph["1"]["inputs"]["input_noise_scale"] == 0.0
    assert graph["1"]["inputs"]["color_correction"] == "wavelet"
    assert any("input_noise_scale" in f for f in fixes)
    assert [e[1] for e in edits].count("input_missing") == 2


async def test_missing_spec_means_no_injection_and_a_note():
    """抓不到规格时不许瞎补,但要把"没取到"写进归因。"""
    bad = FlakyClient(SPEC, fail_times=99)
    specs, failed = await _fetch_class_specs(bad, GRAPH, tries=1)
    graph = {"1": {"class_type": "SeedVR2", "inputs": {"images": ["0", 0]}}}
    fixes = combo_repair(graph, specs)
    assert fixes == []
    assert "input_noise_scale" not in graph["1"]["inputs"]
    note = _spec_incomplete_note(failed)
    assert "SeedVR2" in note and "repair_incomplete" in note


def test_note_wording_cannot_flip_the_classification():
    """标注自己不能成为新的误判源:加上它以后 cls 必须不变。

    措辞里刻意不出现 classify_failure 的关键词(缺模型/缺节点/超时/required input is missing…)。
    """
    base = ("请求 /prompt 失败 (400): {'error': {'type': 'prompt_outputs_failed_validation', "
            "'message': 'Prompt outputs failed validation: SeedVR2: Required input is missing "
            "input_noise_scale'}}")
    note = _spec_incomplete_note(["SeedVR2", "KSampler"])
    before = classify_failure(base, {})
    after = classify_failure(f"{base} [{note}]", {})
    assert before["cls"] == after["cls"] == "validation"
    for word in ("缺模型", "缺节点", "超时", "timeout", "out of memory", "missing_node_type"):
        assert word not in note.lower()
