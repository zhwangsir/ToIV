"""Studio 域 SVML 导入端点测试(FU1-b):与 script/parse 同构、不落库、长度守卫。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import StudioProject, Tenant, User
from app.security import create_token, hash_password


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
    yield TestClient(app), create_token(uid), engine
    app.dependency_overrides.clear()
    engine.dispose()


def _h(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


def test_studio_import_svml_shape(ctx):
    client, tok, _ = ctx
    pid = client.post(
        "/api/studio/projects", headers=_h(tok), json={"title": "SVML"}
    ).json()["id"]
    script = """[scene:雨夜巷口][mood:紧张]
<林夏> 别跟着我。||我说了,别跟着我。
镜头缓推 || 霓虹闪烁

[scene:天台]
<阿凯> 你还是来了。"""
    r = client.post(f"/api/studio/projects/{pid}/import-svml", headers=_h(tok), json={"script": script})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["count"] == 2
    assert set(data["shots"][0]) >= {"scene", "prompt", "dialogue", "speaker", "duration_sec", "characters", "render_mode"}
    assert data["shots"][0]["speaker"] == "林夏"
    assert data["shots"][0]["characters"] == ["林夏"]
    assert data["shots"][0]["render_mode"] == "video"
    assert set(data["characters"]) == {"阿凯", "林夏"}
    # 不落库:项目 shots 仍空(save_shots 才写)
    detail = client.get(f"/api/studio/projects/{pid}", headers=_h(tok)).json()
    shots = detail.get("shots") or []
    assert shots == []


def test_studio_import_svml_guards(ctx):
    client, tok, _ = ctx
    pid = client.post(
        "/api/studio/projects", headers=_h(tok), json={"title": "G"}
    ).json()["id"]
    # 语法错 422
    r = client.post(
        f"/api/studio/projects/{pid}/import-svml", headers=_h(tok), json={"script": "@{a}未闭合"}
    )
    assert r.status_code == 422 and "SVML 解析失败" in r.json()["detail"]
    # 空/超长 422
    assert client.post(
        f"/api/studio/projects/{pid}/import-svml", headers=_h(tok), json={"script": "  "}
    ).status_code == 422
    assert client.post(
        f"/api/studio/projects/{pid}/import-svml", headers=_h(tok), json={"script": "字" * 50001}
    ).status_code == 422
    # 未登录
    assert client.post(
        f"/api/studio/projects/{pid}/import-svml", json={"script": "x"}
    ).status_code in (401, 403)


def test_studio_import_svml_carries_word_anchors(ctx):
    """词锚必须透传进 drafts(FU1 时间轴/改词重排的输入);跨拍锚叠加到经过的每一拍。"""
    client, tok, _ = ctx
    pid = client.post(
        "/api/studio/projects", headers=_h(tok), json={"title": "A"}
    ).json()["id"]
    script = "<林夏> 别跟着我。||我说了,@{回头}猛地回头@{/回头}别跟着我。||@{回头}站稳@{/回头}"
    r = client.post(f"/api/studio/projects/{pid}/import-svml", headers=_h(tok), json={"script": script})
    assert r.status_code == 200, r.text
    shot = r.json()["shots"][0]
    beats = shot["beats"]
    assert [b["cues"] for b in beats] == [[], ["回头"], ["回头"]]
    assert beats[1]["anchor_words"] == "猛地回头"
    assert beats[2]["anchor_words"] == "站稳"
    # 附加字段不破坏既有键集合(前端单一写路径依赖它们)
    assert set(shot) >= {
        "scene", "prompt", "dialogue", "speaker", "duration_sec",
        "characters", "render_mode", "beats",
    }


@pytest.mark.parametrize("script", [
    '<shot duration="60"><v>推近||@{光}亮起@{/光}</v><甲>旧词||旧尾</甲></shot>',
    '[duration:60]\n推近||@{光}亮起@{/光}\n<甲>旧词||旧尾',
])
def test_import_save_reflow_reload_keeps_declarations_and_generation_text(ctx, script):
    import json
    from datetime import datetime
    from app.models import StudioShot

    client, tok, engine = ctx
    headers = _h(tok)
    pid = client.post('/api/studio/projects', headers=headers, json={'title': 'roundtrip'}).json()['id']
    imported = client.post(f'/api/studio/projects/{pid}/import-svml', headers=headers, json={'script': script})
    assert imported.status_code == 200, imported.text
    draft = imported.json()['shots'][0]
    assert draft['duration_sec'] == 60
    assert [b['kind'] for b in draft['beats']] == ['v', 'v', 'd', 'd']
    saved = client.put(f'/api/studio/projects/{pid}/shots', headers=headers, json={'shots': [draft]})
    assert saved.status_code == 200, saved.text
    shot = saved.json()['shots'][0]
    sid = shot['id']
    read = lambda: client.get(f'/api/studio/projects/{pid}', headers=headers).json()['shots'][0]
    assert read()['beats'] == shot['beats']
    assert shot['beats'][-1]['end_sec'] == 60
    with Session(engine) as session:
        row = session.get(StudioShot, sid)
        row.updated_at = datetime(2020, 1, 1)
        session.add(row)
        session.commit()
        session.refresh(row)
        before = row.model_dump()
    edits = {'texts': ['拉远', '', '新对白', '新尾'], 'total_sec': 3}
    preview = client.post(f'/api/studio/shots/{sid}/reflow-beats', headers=headers, json={**edits, 'persist': False})
    assert preview.status_code == 200, preview.text
    assert preview.json()['dialogue'] == '新对白 新尾'
    assert preview.json()['prompt'] == '拉远'
    with Session(engine) as session:
        assert session.get(StudioShot, sid).model_dump() == before
    updated = client.post(f'/api/studio/shots/{sid}/reflow-beats', headers=headers, json=edits)
    assert updated.status_code == 200, updated.text
    result = updated.json()
    assert result['beats'] == preview.json()['beats'] == read()['beats']
    assert result['beats'][-1]['end_sec'] == result['duration_sec'] == 3
    assert result['dialogue'] == read()['dialogue'] == '新对白 新尾'
    assert result['prompt'] == '拉远'
    with Session(engine) as session:
        row = session.get(StudioShot, sid)
        declarations = json.loads(row.beats_json)
        assert len(declarations) == 4
        assert declarations[1]['anchor_words'] == '亮起'
        assert declarations[1]['cues'] == ['光']
        assert declarations[1]['text'] == ''
        assert all('start_sec' not in b and 'end_sec' not in b for b in declarations)
        assert row.dialogue == '新对白 新尾'
        assert row.updated_at > before['updated_at']
    # Omitted total retains the saved explicit target; blank beats are still editable.
    again = client.post(f'/api/studio/shots/{sid}/reflow-beats', headers=headers,
                        json={'texts': ['再拉远', '灯灭', '新对白', '']})
    assert again.status_code == 200, again.text
    assert again.json()['duration_sec'] == 3
    assert again.json()['dialogue'] == '新对白'
    assert again.json()['beats'] == read()['beats']


def test_import_and_reflow_reject_foreign_user_without_writes(ctx):
    from app.models import StudioShot

    client, tok, engine = ctx
    pid = client.post('/api/studio/projects', headers=_h(tok), json={'title': 'private'}).json()['id']
    draft = {'scene': 's', 'prompt': '', 'dialogue': '原词', 'beats': [{'text': '原词'}]}
    saved = client.put(f'/api/studio/projects/{pid}/shots', headers=_h(tok), json={'shots': [draft]})
    assert saved.status_code == 200, saved.text
    sid = saved.json()['shots'][0]['id']
    with Session(engine) as session:
        tenant = Tenant(name='other')
        session.add(tenant)
        session.commit()
        other = User(email='other@example.com', tenant_id=tenant.id, hashed_password='unused')
        session.add(other)
        session.commit()
        other_headers = _h(create_token(other.id))
        before = session.get(StudioShot, sid).model_dump()
    assert client.post(f'/api/studio/projects/{pid}/import-svml', headers=other_headers,
                       json={'script': '<甲>词'}).status_code == 404
    for persist in [True, False]:
        assert client.post(f'/api/studio/shots/{sid}/reflow-beats', headers=other_headers,
                           json={'texts': ['窜改'], 'persist': persist}).status_code == 404
    assert client.get(f'/api/studio/projects/{pid}', headers=other_headers).status_code == 404
    with Session(engine) as session:
        assert session.get(StudioShot, sid).model_dump() == before


@pytest.mark.parametrize('dialogue,prompt,status', [('旧词 旧尾', '视觉', 200), ('', '旧词 旧尾', 200), ('不匹配', '视觉', 422)])
def test_untyped_beats_require_unambiguous_generation_channel(ctx, dialogue, prompt, status):
    client, tok, engine = ctx
    pid = client.post('/api/studio/projects', headers=_h(tok), json={'title': 'untyped'}).json()['id']
    saved = client.put(f'/api/studio/projects/{pid}/shots', headers=_h(tok), json={'shots': [{
        'dialogue': dialogue, 'prompt': prompt, 'beats': [{'text': '旧词'}, {'text': '旧尾'}],
    }]})
    shot = saved.json()['shots'][0]
    result = client.post(f"/api/studio/shots/{shot['id']}/reflow-beats", headers=_h(tok), json={'texts': ['新词', '']})
    assert result.status_code == status, result.text
    if status == 200:
        assert result.json()['dialogue' if dialogue else 'prompt'] == '新词'
    else:
        from app.models import StudioShot
        with Session(engine) as session:
            row = session.get(StudioShot, shot['id'])
            assert row.dialogue == dialogue
            assert '新词' not in row.beats_json


def test_save_uses_declarations_not_stale_generation_fields(ctx):
    client, tok, engine = ctx
    pid = client.post('/api/studio/projects', headers=_h(tok), json={'title': 'source'}).json()['id']
    draft = client.post(f'/api/studio/projects/{pid}/import-svml', headers=_h(tok), json={
        'script': '镜头一||镜头二\n镜头三\n<甲>旧词||旧尾',
    }).json()['shots'][0]
    draft['duration_sec'] = 1
    draft['beats'][-1]['text'] = '新尾'
    saved = client.put(f'/api/studio/projects/{pid}/shots', headers=_h(tok), json={'shots': [draft]})
    assert saved.status_code == 200, saved.text
    shot = saved.json()['shots'][0]
    assert shot['dialogue'] == '旧词 新尾'
    assert shot['prompt'] == '镜头一 镜头二, 镜头三'
    from app.models import StudioShot
    with Session(engine) as session:
        row = session.get(StudioShot, shot['id'])
        assert row.duration_sec == shot['duration_sec'] == 3
        assert row.dialogue == '旧词 新尾'


@pytest.mark.parametrize('beat', [{'text': '原词', 'cues': '丢锚'}, {'text': '原词', 'kind': 'd', 'block': []}, {'text': '原词', 'kind': 'wrong'}])
def test_invalid_declaration_is_rejected_not_silently_normalized(ctx, beat):
    client, tok, _ = ctx
    pid = client.post('/api/studio/projects', headers=_h(tok), json={'title': 'invalid'}).json()['id']
    result = client.put(f'/api/studio/projects/{pid}/shots', headers=_h(tok), json={'shots': [{'beats': [beat]}]})
    assert result.status_code == 422, result.text
    assert client.get(f'/api/studio/projects/{pid}', headers=_h(tok)).json()['shots'] == []
