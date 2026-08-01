"""短剧成片根目录运行时解析测试(P3):app.storage.drama_output_root。

修复前三处(drama_analytics/drama_studio/assembly)在模块 import 时一次性解析,
NAS 恢复后不重启不回切;现为每次调用解析(60s 缓存),失败立即降本地。
"""
from __future__ import annotations

import pytest

from app import storage


@pytest.fixture(autouse=True)
def _reset_cache(monkeypatch):
    """每个用例前后清空 60s 缓存,避免相互污染。"""
    monkeypatch.setattr(storage, "_drama_root_cache", None)
    yield
    storage._drama_root_cache = None


def test_env_dir_preferred(tmp_path, monkeypatch):
    """TOIV_DRAMA_VIDEO_DIR 指向的 NAS 目录存在 → 直接使用。"""
    monkeypatch.setenv("TOIV_DRAMA_VIDEO_DIR", str(tmp_path))
    assert storage.drama_output_root() == tmp_path


def test_env_missing_falls_back_to_local(tmp_path, monkeypatch):
    """NAS 目录不存在 → 降级本地候选(drama/output/final),不抛异常。"""
    missing = tmp_path / "nas-not-mounted"
    monkeypatch.setenv("TOIV_DRAMA_VIDEO_DIR", str(missing))
    root = storage.drama_output_root()
    assert root != missing
    assert str(root).endswith(("drama/output/final", "/app/drama/output/final"))


def test_env_oserror_falls_back_to_local(tmp_path, monkeypatch):
    """NAS 路径访问抛 OSError(掉线/超时)→ warning + 降级本地。"""
    from pathlib import Path

    nas_dir = tmp_path / "nas"
    nas_dir.mkdir()
    monkeypatch.setenv("TOIV_DRAMA_VIDEO_DIR", str(nas_dir))
    real_is_dir = Path.is_dir

    def _flaky(self):
        if self == Path(str(nas_dir)):
            raise OSError("Host is down")
        return real_is_dir(self)

    monkeypatch.setattr(Path, "is_dir", _flaky)
    root = storage.drama_output_root()
    assert root != nas_dir


def test_nas_recovery_switches_back_without_restart(tmp_path, monkeypatch):
    """NAS 恢复后(缓存过期)无需重启自动回切到 NAS 目录。"""
    nas_dir = tmp_path / "nas"
    monkeypatch.setenv("TOIV_DRAMA_VIDEO_DIR", str(nas_dir))

    # NAS 未挂载:降本地
    local_root = storage.drama_output_root()
    assert local_root != nas_dir

    # NAS 恢复(目录出现),缓存过期后重新解析 → 回切 NAS
    nas_dir.mkdir()
    monkeypatch.setattr(storage, "_drama_root_cache", None)  # 模拟 TTL 过期
    assert storage.drama_output_root() == nas_dir


def test_result_cached_within_ttl(tmp_path, monkeypatch):
    """TTL 内复用缓存:NAS 目录被删仍返回缓存结果;缓存过期才重新解析。"""
    nas_dir = tmp_path / "nas"
    nas_dir.mkdir()
    monkeypatch.setenv("TOIV_DRAMA_VIDEO_DIR", str(nas_dir))
    assert storage.drama_output_root() == nas_dir

    nas_dir.rmdir()
    assert storage.drama_output_root() == nas_dir  # TTL 内:缓存值

    monkeypatch.setattr(storage, "_drama_root_cache", None)  # 模拟 TTL 过期
    assert storage.drama_output_root() != nas_dir
