"""H3 harness profile 组合测试:三档 profile 插件集差异 + /api/system/harness 端点。

- full:llm + tool + engine + quality(全部内建插件)
- minimal:llm + tool + engine(基础图像/视频子集),无质量门
- headless:llm + tool + engine,无质量门无人格
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.deps import get_current_admin, get_current_user
from app.main import app
from app.models import User


@pytest.fixture()
def admin_user() -> User:
    return User(
        id="admin-1", email="admin@toiv.ai", hashed_password="x",
        tenant_id="t-1", role="admin",
    )


@pytest.fixture()
def normal_user() -> User:
    return User(id="u-1", email="user@toiv.ai", hashed_password="x", tenant_id="t-1")


@pytest.fixture()
def client_admin(admin_user):
    app.dependency_overrides[get_current_user] = lambda: admin_user
    app.dependency_overrides[get_current_admin] = lambda: admin_user
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture()
def client_user(normal_user):
    app.dependency_overrides[get_current_user] = lambda: normal_user
    yield TestClient(app)
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# /api/system/harness 端点
# ---------------------------------------------------------------------------


def test_harness_endpoint_admin_200(client_admin):
    """admin 可访问 /api/system/harness,返回 profile + 插件清单 + 停用引擎。"""
    res = client_admin.get("/api/system/harness")
    assert res.status_code == 200
    body = res.json()
    assert "profile" in body
    assert body["profile"] == "full"  # 默认 profile
    assert "plugins" in body
    assert "engines_disabled" in body
    assert isinstance(body["plugins"], list)
    assert isinstance(body["engines_disabled"], list)


def test_harness_endpoint_non_admin_403(client_user):
    """非 admin 访问 /api/system/harness → 403。"""
    res = client_user.get("/api/system/harness")
    assert res.status_code == 403


def test_harness_endpoint_full_profile_plugins(client_admin):
    """full profile 下 plugins 含 llm-seam/tool-seam/engine-seam/quality-seam。"""
    res = client_admin.get("/api/system/harness")
    assert res.status_code == 200
    names = [p["name"] for p in res.json()["plugins"]]
    assert "llm-seam" in names
    assert "tool-seam" in names
    assert "engine-seam" in names
    assert "quality-seam" in names


def test_harness_endpoint_full_profile_no_disabled_engines(client_admin):
    """full profile 下 engines_disabled 为空。"""
    res = client_admin.get("/api/system/harness")
    assert res.status_code == 200
    assert res.json()["engines_disabled"] == []


# ---------------------------------------------------------------------------
# profile 插件集差异(直接调 bootstrap_profile 单元测试)
# ---------------------------------------------------------------------------


def test_profile_plugin_sets_differ():
    """full/minimal/headless 三档插件集差异:full 多 quality,minimal/headless 少 quality。"""
    from app.harness.context import HarnessContext
    from app.harness.plugin import PluginRegistry
    from app.harness.profile import _PROFILES, _make_plugin

    for profile_name, spec in _PROFILES.items():
        ctx = HarnessContext()
        registry = PluginRegistry(ctx)
        for pname in spec["plugins"]:
            registry.use(_make_plugin(pname, spec["disabled_engines"]))
        names = registry.plugin_names
        if profile_name == "full":
            assert "quality-seam" in names
            assert len(names) == 4  # llm + tool + engine + quality
        else:
            assert "quality-seam" not in names
            assert len(names) == 3  # llm + tool + engine


def test_profile_minimal_disables_advanced_engines():
    """minimal profile 停用专用实例引擎(H3/LongCat 等),保留基础图像。"""
    from app.harness.profile import _PROFILES

    disabled = _PROFILES["minimal"]["disabled_engines"]
    assert "txt2img" not in disabled
    assert "img2img" not in disabled
    assert "ace-music" not in disabled
    for eid in ("h3-t2v", "longcat-t2v", "wan-animate", "avatar-talk"):
        assert eid in disabled, f"{eid} 应在 minimal 停用集"
    # NSFW 引擎也停用
    for eid in ("nsfw-txt2img", "h3-nsfw-t2v", "ltx-nsfw-t2v"):
        assert eid in disabled


def test_profile_headless_same_disabled_as_minimal():
    """headless 与 minimal 停用同一引擎集。"""
    from app.harness.profile import _PROFILES

    assert _PROFILES["headless"]["disabled_engines"] == _PROFILES["minimal"]["disabled_engines"]


def test_unknown_profile_falls_back_to_full():
    """未知 profile 回退 full,不抛异常。"""
    from unittest.mock import patch

    from app.config import get_settings
    from app.harness.context import HarnessContext
    from app.harness.plugin import PluginRegistry
    from app.harness.profile import bootstrap_profile

    mock_settings = get_settings()
    mock_settings.harness_profile = "nonexistent-profile"
    with patch("app.harness.profile.get_settings", return_value=mock_settings):
        ctx = HarnessContext()
        registry = PluginRegistry(ctx)
        bootstrap_profile(ctx, registry)
        names = registry.plugin_names
        assert "quality-seam" in names  # full profile 含质量门
        assert len(names) == 4
