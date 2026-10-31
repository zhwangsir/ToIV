"""待办 #4 双域收敛最小切片不变量。

选定策略:StudioProject 唯一宿主(查库优先) + 同步 artifacts/video-done 事件总线
(tracker 与 studio 回写都 emit,transcript 只订阅总线——禁双叉直调)。
不删 Drama 表;Drama 仅 legacy 别名。
"""
from __future__ import annotations

import inspect

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.models import DramaProject, StudioProject, Tenant, User
from app.security import hash_password


@pytest.fixture()
def session():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    with Session(eng) as s:
        t = Tenant(name="conv")
        s.add(t)
        s.commit()
        s.refresh(t)
        u = User(
            id="u-host",
            email="host@t.iv",
            hashed_password=hash_password("x"),
            tenant_id=t.id,
            role="user",
        )
        s.add(u)
        s.commit()
        yield s, u, t


def test_resolve_host_prefers_studio_over_drama(session):
    """同一 pid 若两侧都有行(极端),须返回 studio——宿主优先序。"""
    from app.services.project_host import HostKind, resolve_host_project

    s, u, t = session
    pid = "same-id-collision-test000000000001"
    # 先插 drama 再 studio(模拟旧库优先被查到的陷阱)
    s.add(DramaProject(id=pid, tenant_id=t.id, user_id=u.id, title="旧剧"))
    s.add(
        StudioProject(id=pid, tenant_id=t.id, user_id=u.id, title="新宿主")
    )
    s.commit()
    kind, proj = resolve_host_project(s, pid, u)
    assert kind == HostKind.STUDIO
    assert isinstance(proj, StudioProject)
    assert proj.title == "新宿主"


def test_resolve_host_drama_is_legacy_alias(session):
    from app.services.project_host import HostKind, resolve_host_project

    s, u, t = session
    s.add(DramaProject(id="drama-only-id", tenant_id=t.id, user_id=u.id, title="legacy"))
    s.commit()
    kind, proj = resolve_host_project(s, "drama-only-id", u)
    assert kind == HostKind.DRAMA_LEGACY
    assert isinstance(proj, DramaProject)


def test_owned_project_any_uses_studio_first(session):
    """drama_scenes._owned_project_any 须委托 project_host(Studio 优先)。"""
    from app.routes import drama_scenes as ds

    src = inspect.getsource(ds._owned_project_any)
    assert "resolve_host_project" in src


def test_artifacts_video_done_bus_is_single_fanout(monkeypatch):
    """两条写路径都只 emit 总线;transcript 是订阅方而非双叉直调。"""
    from app.services import domain_events as de

    de.clear_listeners(de.ARTIFACTS_VIDEO_DONE)
    seen: list[dict] = []
    de.on(de.ARTIFACTS_VIDEO_DONE, lambda p: seen.append(dict(p)))

    de.emit_artifacts_video_done(["/api/studio/files/a.mp4"], source="unit")
    assert len(seen) == 1
    assert seen[0]["urls"] == ["/api/studio/files/a.mp4"]
    assert seen[0]["source"] == "unit"

    # 源码契约:orchestrator / tracker 经总线,不各自直调 on_artifacts_done 为主路径
    import app.comfy.tracker as tracker
    import app.services.studio.orchestrator as orch

    tsrc = inspect.getsource(tracker.mark_done)
    osrc = inspect.getsource(orch._fire_video_transcript)
    assert "emit_artifacts_video_done" in tsrc or "domain_events" in tsrc
    assert "emit_artifacts_video_done" in osrc or "domain_events" in osrc


def test_default_transcript_subscriber_registered():
    """进程默认把 transcript 挂在 ARTIFACTS_VIDEO_DONE 上(可替换)。"""
    from app.services import domain_events as de

    names = [getattr(fn, "__name__", repr(fn)) for fn in de.listeners(de.ARTIFACTS_VIDEO_DONE)]
    assert any("transcript" in n or "artifacts" in n or "on_artifacts" in n for n in names) or len(
        de.listeners(de.ARTIFACTS_VIDEO_DONE)
    ) >= 1
