"""市场/助手可用性标签：timeout ≠ 不可用。"""
from types import SimpleNamespace

from app.agent.tools_gen import _smoke_label


def test_smoke_label_timeout_is_unverified_slow_not_failure():
    label = _smoke_label(SimpleNamespace(smoke_status="timeout"))
    assert label == "未验证（慢链）"
    assert "超时" not in label  # 避免「实测超时」失败感
    assert "失败" not in label


def test_smoke_label_pass_fail_unchanged():
    assert _smoke_label(SimpleNamespace(smoke_status="pass")) == "实测可用"
    assert _smoke_label(SimpleNamespace(smoke_status="fail")) == "实测失败"
    assert _smoke_label(SimpleNamespace(smoke_status="")) == "未实测"
