"""SVML-lite 词锚定脚本解析器 + 短剧导入端点测试。

覆盖:
  · 拍切分(||)/词锚(@{}…@{}/)/说话人前缀解析
  · XML 形态与行式形态双支持
  · 锚语法错误(未闭合/多余闭合)ValueError
  · 字数估时夹值与显式 duration 优先
  · POST /api/drama/projects/{pid}/import-svml 端到端:落库/角色自动建/归属校验
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import DramaCharacter, DramaProject, DramaShot, Tenant, User
from app.security import create_token, hash_password
from app.services.svml_lite import (
    estimate_duration,
    parse_beats,
    parse_svml_script,
    strip_anchors,
    drafts_to_coerced,
)


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="d")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(email="d@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
        tenant2 = Tenant(name="d2")
        s.add(tenant2)
        s.commit()
        s.refresh(tenant2)
        user2 = User(email="d2@toiv.ai", hashed_password=hash_password("p"), tenant_id=tenant2.id)
        s.add(user2)
        s.commit()
        s.refresh(user2)
        uid2 = user2.id
    yield TestClient(app), create_token(uid), create_token(uid2)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ───────────────────────────── 解析器单测 ─────────────────────────────


def test_parse_beats_splits_and_anchors():
    beats = parse_beats("别跟着我。||我说了,@{回头}猛地回头@{/回头}别跟着我。")
    assert len(beats) == 2
    assert beats[0].text == "别跟着我。"
    assert beats[0].cues == []
    assert beats[1].text == "我说了,猛地回头别跟着我。"
    assert beats[1].cues == ["回头"]
    assert beats[1].anchor_words == "猛地回头"


def test_parse_beats_anchor_spans_beats():
    # hypit 原语义:锚跨拍,两拍都记 cue;text 含锚内词(要念的),anchor_words 标锚内部分
    beats = parse_beats("她看了过去@{回眸}眼神一冷 || 雨水落下@{/回眸}转身离开。")
    assert [b.text for b in beats] == ["她看了过去眼神一冷", "雨水落下转身离开。"]
    assert beats[0].cues == ["回眸"] and beats[0].anchor_words == "眼神一冷"
    assert beats[1].cues == ["回眸"] and beats[1].anchor_words == "雨水落下"


def test_strip_anchors_keeps_inner_text():
    assert strip_anchors("a@{x}b@{/x}c") == "abc"
    assert strip_anchors("没有锚") == "没有锚"


def test_anchor_errors_raise():
    with pytest.raises(ValueError, match="未闭合"):
        parse_svml_script("@{a}未闭合")
    with pytest.raises(ValueError, match="多余"):
        parse_svml_script("abc@{/a}")


def test_line_form_basic():
    script = """[scene:雨夜巷口][mood:紧张][beat:开场]
<林夏> 别跟着我。||我说了,别跟着我。
镜头缓推 || 霓虹闪烁

[scene:天台]
<阿凯> 你还是来了。
两人对峙"""
    drafts = parse_svml_script(script)
    assert len(drafts) == 2
    d0 = drafts[0]
    assert d0.scene == "雨夜巷口"
    assert d0.mood == "紧张"
    assert d0.beat == "开场"
    assert d0.dialogue == "别跟着我。 我说了,别跟着我。"
    assert d0.characters == ["林夏"]
    assert d0.speaker == "林夏"
    assert "镜头缓推" in d0.prompt
    assert d0.duration_auto is True
    assert d0.duration_sec >= 2
    d1 = drafts[1]
    assert d1.scene == "天台"
    assert d1.characters == ["阿凯"]
    assert "两人对峙" in d1.prompt


def test_xml_form_basic():
    script = """<?svml?>
<svml>
  <shot scene="雨夜巷口" mood="紧张" duration="8">
    <v>镜头缓推 || 霓虹闪烁</v>
    <林夏>别跟着我。</林夏>
  </shot>
  <shot scene="天台">
    <阿凯|calm>你还是来了。</阿凯>
  </shot>
</svml>"""
    drafts = parse_svml_script(script)
    assert len(drafts) == 2
    assert drafts[0].scene == "雨夜巷口"
    assert drafts[0].duration_sec == 8
    assert drafts[0].duration_auto is False
    assert drafts[1].characters == ["阿凯"]
    assert drafts[1].speaker == "阿凯"


def test_narrator_not_a_character():
    script = "<narrator> 深夜的城,无人入睡。\n<林夏> 走。"
    drafts = parse_svml_script(script)
    assert drafts[0].characters == ["林夏"]


def test_duration_estimate_clamped():
    assert estimate_duration("") == 6
    # 1 字 → 2s 下限
    assert estimate_duration("走") == 2
    # 200 字 → 上限 15s
    assert estimate_duration("字" * 200) == 15
    # 42 字 / 4.2 = 10s
    assert estimate_duration("字" * 42) == 10


def test_mixed_forms_and_separator_lines():
    script = """<shot scene="A">
  <v>推进</v>
</shot>
---
[scene:B]
<李> 好。
===
[scene:C]
<王> 走。"""
    drafts = parse_svml_script(script)
    assert [d.scene for d in drafts] == ["A", "B", "C"]


def test_drafts_to_coerced_shape():
    script = "[scene:巷口]\n<林夏> 走。"
    coerced = drafts_to_coerced(parse_svml_script(script))
    assert coerced[0]["scene"] == "巷口"
    assert coerced[0]["characters"] == ["林夏"]
    assert coerced[0]["speaker"] == "林夏"
    assert coerced[0]["duration_sec"] >= 2
    assert set(("prompt", "dialogue", "mood", "beat")) <= set(coerced[0])


def test_empty_and_junk_raise():
    with pytest.raises(ValueError, match="为空"):
        parse_svml_script("   ")
    with pytest.raises(ValueError, match="未解析出任何分镜"):
        parse_svml_script("<?svml?>")


# ───────────────────────────── 端点集成 ─────────────────────────────


def test_import_svml_endpoint(ctx):
    client, tok, tok2 = ctx
    pid = client.post("/api/drama/projects", headers=_h(tok), json={"title": "SVML 导入"}).json()["id"]
    script = """[scene:雨夜巷口][mood:紧张][beat:开场]
<林夏> 别跟着我。||我说了,别跟着我。
镜头缓推 || 霓虹闪烁

[scene:天台]
<阿凯> 你还是来了。
两人对峙"""
    r = client.post(f"/api/drama/projects/{pid}/import-svml", headers=_h(tok), json={"script": script})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["count"] == 2
    shots = data["shots"]
    assert shots[0]["scene"] == "雨夜巷口"
    assert shots[0]["mood"] == "紧张"
    assert shots[0]["beat"] == "开场"
    assert shots[0]["speaker"] == "林夏"
    assert shots[0]["duration_sec"] >= 2
    assert "镜头缓推" in shots[0]["prompt"]
    # 角色自动建库
    chars = client.get(f"/api/drama/projects/{pid}/characters", headers=_h(tok)).json()
    names = {c["name"] for c in chars}
    assert {"林夏", "阿凯"} <= names
    # 项目 script 留底 + status=storyboard
    detail = client.get(f"/api/drama/projects/{pid}", headers=_h(tok)).json()
    assert "[scene:雨夜巷口]" in detail["script"]
    assert detail["status"] == "storyboard"
    # 二次导入清旧重建
    r2 = client.post(
        f"/api/drama/projects/{pid}/import-svml",
        headers=_h(tok),
        json={"script": "[scene:独镜]\n<林夏> 只剩一镜。", "auto_duration": False},
    )
    assert r2.json()["count"] == 1
    assert r2.json()["shots"][0]["duration_sec"] == 6  # auto_duration=False 回默认
    detail2 = client.get(f"/api/drama/projects/{pid}", headers=_h(tok)).json()
    assert len(detail2["shots"]) == 1


def test_import_svml_rejects_bad_syntax_and_foreign_user(ctx):
    client, tok, tok2 = ctx
    pid = client.post("/api/drama/projects", headers=_h(tok), json={"title": "x"}).json()["id"]
    # 语法错误 422
    r = client.post(
        f"/api/drama/projects/{pid}/import-svml", headers=_h(tok), json={"script": "@{a}未闭合"}
    )
    assert r.status_code == 422
    assert "SVML 解析失败" in r.json()["detail"]
    # 他人项目 404(归属校验)
    r2 = client.post(
        f"/api/drama/projects/{pid}/import-svml", headers=_h(tok2), json={"script": "[scene:a]\n<b> c。"}
    )
    assert r2.status_code in (403, 404)
