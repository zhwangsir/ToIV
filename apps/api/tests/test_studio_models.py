"""Studio 模块数据模型测试:三表字段与默认值。"""
from __future__ import annotations

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import StudioCharacter, StudioProject, StudioShot


def _session() -> Session:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_project_defaults():
    with _session() as s:
        p = StudioProject(tenant_id="t1", user_id="u1", title="测试剧")
        s.add(p)
        s.commit()
        s.refresh(p)
        assert p.id and p.status == "draft" and p.render_mode_default == "video"
        assert p.final_url == ""


def test_character_fields():
    with _session() as s:
        c = StudioCharacter(project_id="p1", name="楚生", visual_prompt="1boy, black hair")
        s.add(c)
        s.commit()
        s.refresh(c)
        assert c.reference_images == "[]" and c.voice_ref_url == ""


def test_shot_render_mode_and_status():
    with _session() as s:
        shot = StudioShot(project_id="p1", idx=0, scene="开场")
        s.add(shot)
        s.commit()
        s.refresh(shot)
        assert shot.render_mode == "video"
        assert shot.status == "draft"
        assert shot.characters == "[]"
        # 图像运镜模式
        shot2 = StudioShot(project_id="p1", idx=1, render_mode="image_motion")
        s.add(shot2)
        s.commit()
        rows = s.exec(select(StudioShot).where(StudioShot.project_id == "p1")).all()
        assert len(rows) == 2
