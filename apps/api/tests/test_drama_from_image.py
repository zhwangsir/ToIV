"""from-image 一键管线单测。

覆盖:
  · 上传校验:0/10 张、非法扩展名、路径穿越文件名、空文件、num_shots 越界 → 422
  · 成功路径:mock VLM 解析,验证建项目/分镜/角色/autorun task 启动
  · VLM 失败 → 502
  · _run_autorun:mock 视频/配音/合成,验证阶段顺序、done 计数、状态流转、单镜失败不中断
  · drama_image 纯函数:_build_payload 结构 / _parse_json_obj 解析

不覆盖(依赖外部 VLM/ComfyUI/TTS/ffmpeg,留集成测试):
  · analyze_storyboard_images 实际 HTTP 调用、_submit_shot_video/_do_assemble 实际执行
"""
from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.drama_studio as ds
from app.db import get_session
from app.main import app
from app.models import DramaCharacter, DramaProject, DramaShot, Tenant, User
from app.security import create_token, hash_password
from app.services import drama_image

_JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 32

_FAKE_OBJ = {
    "title": "雨夜便利店",
    "premise": "深夜便利店里的偶遇",
    "script": "阿明深夜走进便利店……",
    "shots": [
        {
            "scene": "便利店门口,雨夜",
            "prompt": "1boy, black hair, rain, convenience store, medium shot, cinematic",
            "characters": ["阿明"],
            "dialogue": "又下雨了。",
            "speaker": "阿明",
            "duration_sec": 5,
        },
        {
            "scene": "店内,暖光",
            "prompt": "1girl, apron, behind counter, close-up, cinematic",
            "characters": ["小晴"],
            "dialogue": "欢迎光临。",
            "speaker": "小晴",
            "duration_sec": 4,
        },
        {
            "scene": "货架间",
            "prompt": "1boy, reaching for umbrella, wide shot, cinematic",
            "characters": ["阿明"],
            "dialogue": "",
            "speaker": "",
            "duration_sec": 6,
        },
        {
            "scene": "门口告别",
            "prompt": "1boy 1girl, waving goodbye, medium shot, cinematic",
            "characters": ["阿明", "小晴"],
            "dialogue": "明天见。",
            "speaker": "小晴",
            "duration_sec": 5,
        },
    ],
}


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    # 后台任务(autorun/writeback)用 `from app.db import engine` 取独立 Session,
    # 需 patch app.db.engine 指向测试 engine,否则后台 Session 看不到内存表
    with patch.object(__import__("app.db", fromlist=["engine"]), "engine", engine):
        with Session(engine) as s:
            tenant = Tenant(name="fi")
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            user = User(
                email="fi@toiv.ai",
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
            s.add(user)
            s.commit()
            s.refresh(user)
            uid = user.id
        # 首图落盘/配音产物统一打到 tmp_path,不污染真实成片目录
        monkeypatch.setattr(ds, "_DRAMA_DIR", tmp_path / "drama")
        yield TestClient(app), create_token(uid), engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _files(n: int, name: str = "a.jpg", content: bytes = _JPG) -> list:
    return [("images", (f"{i}{name}" if n > 1 else name, content, "image/jpeg")) for i in range(n)]


def _post(ctx_client, token, **kwargs):
    return ctx_client.post("/api/drama/projects/from-image", headers=_h(token), **kwargs)


# ────────────────────────────────
# 上传 / 参数校验
# ────────────────────────────────

def test_no_images_422(ctx):
    client, token, _ = ctx
    r = _post(client, token, data={"num_shots": "4"})
    assert r.status_code == 422


def test_too_many_images_422(ctx):
    client, token, _ = ctx
    r = _post(client, token, files=_files(10), data={"num_shots": "4"})
    assert r.status_code == 422


def test_bad_extension_422(ctx):
    client, token, _ = ctx
    files = [("images", ("a.gif", _JPG, "image/gif"))]
    r = _post(client, token, files=files, data={"num_shots": "4"})
    assert r.status_code == 422


def test_path_traversal_filename_422(ctx):
    client, token, _ = ctx
    files = [("images", ("../evil.jpg", _JPG, "image/jpeg"))]
    r = _post(client, token, files=files, data={"num_shots": "4"})
    assert r.status_code == 422


def test_empty_file_422(ctx):
    client, token, _ = ctx
    files = [("images", ("a.jpg", b"", "image/jpeg"))]
    r = _post(client, token, files=files, data={"num_shots": "4"})
    assert r.status_code == 422


def test_num_shots_out_of_range_422(ctx):
    client, token, _ = ctx
    assert _post(client, token, files=_files(1), data={"num_shots": "3"}).status_code == 422
    assert _post(client, token, files=_files(1), data={"num_shots": "17"}).status_code == 422


# ────────────────────────────────
# 成功路径 / VLM 失败
# ────────────────────────────────

def test_success_auto_creates_project_shots_chars(ctx, monkeypatch):
    client, token, engine = ctx
    monkeypatch.setattr(
        ds, "analyze_storyboard_images", AsyncMock(return_value=dict(_FAKE_OBJ))
    )
    autorun_calls: list[tuple] = []

    async def _fake_autorun(pid, task_id, first_image):
        autorun_calls.append((pid, task_id, first_image))

    monkeypatch.setattr(ds, "_run_autorun", _fake_autorun)

    r = _post(
        client, token,
        files=_files(2),
        data={"hint": "雨夜爱情", "num_shots": "4", "auto": "true"},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # 项目字段来自 VLM 解析
    assert body["project"]["title"] == "雨夜便利店"
    assert body["project"]["script"] == "阿明深夜走进便利店……"
    assert body["project"]["status"] == "storyboard"
    # 分镜按 idx 顺序,数量 = num_shots
    shots = body["shots"]
    assert [s["idx"] for s in shots] == [0, 1, 2, 3]
    assert shots[0]["prompt"].startswith("1boy")
    # autorun 已启动,首图字节透传
    assert body["autorun_task_id"]
    assert len(autorun_calls) == 1
    assert autorun_calls[0][0] == body["project"]["id"]
    assert autorun_calls[0][2] == _JPG

    # 角色自动创建
    with Session(engine) as s:
        chars = s.exec(select(DramaCharacter)).all()
        assert {c.name for c in chars} == {"阿明", "小晴"}
        # process_data 含 autorun 记录
        p = s.get(DramaProject, body["project"]["id"])
        steps = json.loads(p.process_data)
        rec = next(st for st in steps if st.get("step") == "autorun")
        assert rec["status"] == "pending" and rec["total"] == 4

    # 首图落盘(best-effort)
    import pathlib
    saved = list((pathlib.Path(ds._DRAMA_DIR)).glob("fromimg-*.jpg"))
    assert len(saved) == 1 and saved[0].read_bytes() == _JPG


def test_success_auto_false_no_autorun(ctx, monkeypatch):
    client, token, _ = ctx
    monkeypatch.setattr(
        ds, "analyze_storyboard_images", AsyncMock(return_value=dict(_FAKE_OBJ))
    )

    async def _fake_autorun(*a):  # pragma: no cover - 不应被调用
        raise AssertionError("auto=false 不应启动 autorun")

    monkeypatch.setattr(ds, "_run_autorun", _fake_autorun)
    r = _post(client, token, files=_files(1), data={"num_shots": "4", "auto": "false"})
    assert r.status_code == 200, r.text
    assert r.json()["autorun_task_id"] is None


def test_vlm_failure_502(ctx, monkeypatch):
    client, token, _ = ctx
    monkeypatch.setattr(
        ds,
        "analyze_storyboard_images",
        AsyncMock(side_effect=HTTPException(status_code=502, detail="VLM 服务不可达")),
    )
    r = _post(client, token, files=_files(1), data={"num_shots": "4"})
    assert r.status_code == 502


# ────────────────────────────────
# _run_autorun 编排
# ────────────────────────────────

def _seed_project(engine) -> tuple[str, list[str]]:
    """直接落库:1 用户 + 1 项目 + 3 分镜(2 个有台词) + autorun 记录。

    autorun 会按 project.user_id 反查 User 行(Job 落库需要),这里建真实用户。
    返回 (pid, shot_ids)。
    """
    with Session(engine) as s:
        tenant = Tenant(name="ar")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="ar@toiv.ai",
            hashed_password=hash_password("p"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        p = DramaProject(tenant_id=tenant.id, user_id=user.id, title="t", script="s")
        s.add(p)
        s.commit()
        s.refresh(p)
        shot_ids = []
        for i, dlg in enumerate(["台词一", "", "台词三"]):
            shot = DramaShot(
                project_id=p.id, idx=i, scene=f"场景{i}",
                prompt=f"prompt {i}", dialogue=dlg,
                speaker="阿明" if dlg else "", duration_sec=5,
            )
            s.add(shot)
            s.commit()
            s.refresh(shot)
            shot_ids.append(shot.id)
        ds._append_autorun_task(p, "task-1", total=3)
        s.add(p)
        s.commit()
        return p.id, shot_ids


def _autorun_record(engine, pid: str) -> dict:
    with Session(engine) as s:
        p = s.get(DramaProject, pid)
        steps = json.loads(p.process_data)
        return next(st for st in steps if st.get("step") == "autorun")


def test_run_autorun_happy_path(ctx, monkeypatch):
    _, _, engine = ctx
    pid, shot_ids = _seed_project(engine)
    events: list[str] = []

    async def _fake_submit_video(shot, project, **kw):
        events.append(f"video:{shot.idx}")
        assert kw["session"] is not None and kw["user"] is not None
        # 首镜应收到 first_image,其余为 None
        assert (kw["first_image_bytes"] == b"img") == (shot.idx == 0)
        return f"prompt-{shot.idx}", "cid", "worker", 1

    async def _fake_writeback(sid, prompt_id):
        events.append(f"wb:{prompt_id}")
        from app.db import engine as eng
        with Session(eng) as s:
            shot = s.get(DramaShot, sid)
            shot.video_status = "done"
            shot.video_url = f"/api/images?f={sid}"
            s.add(shot)
            s.commit()
        return True

    async def _fake_voice(shot, session, settings):
        events.append(f"voice:{shot.idx}")
        return f"/api/drama/voice/voice-{shot.idx}.wav"

    async def _fake_assemble(p, body, pool, session):
        events.append("assemble")
        return {"url": "/api/drama/output/x.mp4", "name": "x.mp4", "duration_sec": 15.0}

    monkeypatch.setattr(ds, "_submit_shot_video", _fake_submit_video)
    monkeypatch.setattr(ds, "_await_shot_video_writeback", _fake_writeback)
    monkeypatch.setattr(ds, "_submit_shot_voice", _fake_voice)
    monkeypatch.setattr(ds, "_do_assemble", _fake_assemble)

    asyncio.run(ds._run_autorun(pid, "task-1", b"img"))

    # 阶段顺序:全部视频(含回写) → 有台词镜配音 → 合成
    assert events == [
        "video:0", "wb:prompt-0",
        "video:1", "wb:prompt-1",
        "video:2", "wb:prompt-2",
        "voice:0", "voice:2",
        "assemble",
    ]
    rec = _autorun_record(engine, pid)
    assert rec["status"] == "done"
    assert rec["done"] == 3


def test_run_autorun_one_shot_failure_continues(ctx, monkeypatch):
    _, _, engine = ctx
    pid, shot_ids = _seed_project(engine)
    events: list[str] = []

    async def _fake_submit_video(shot, project, **kw):
        if shot.idx == 1:
            raise HTTPException(status_code=503, detail="无可用 worker")
        events.append(f"video:{shot.idx}")
        return f"prompt-{shot.idx}", "cid", "worker", 1

    async def _fake_writeback(sid, prompt_id):
        from app.db import engine as eng
        with Session(eng) as s:
            shot = s.get(DramaShot, sid)
            shot.video_status = "done"
            shot.video_url = f"/api/images?f={sid}"
            s.add(shot)
            s.commit()
        return True

    async def _fake_voice(shot, session, settings):
        events.append(f"voice:{shot.idx}")
        return "ok"

    async def _fake_assemble(p, body, pool, session):
        events.append("assemble")
        return {"url": "u", "name": "n", "duration_sec": 10.0}

    monkeypatch.setattr(ds, "_submit_shot_video", _fake_submit_video)
    monkeypatch.setattr(ds, "_await_shot_video_writeback", _fake_writeback)
    monkeypatch.setattr(ds, "_submit_shot_voice", _fake_voice)
    monkeypatch.setattr(ds, "_do_assemble", _fake_assemble)

    asyncio.run(ds._run_autorun(pid, "task-1", b"img"))

    # 分镜 1 失败不中断:其余镜继续,配音与合成照常(≥1 镜完成)
    assert "video:0" in events and "video:2" in events
    assert events[-1] == "assemble"
    rec = _autorun_record(engine, pid)
    assert rec["status"] == "done"
    assert rec["done"] == 3
    # 失败镜被标 error
    with Session(engine) as s:
        shot1 = s.get(DramaShot, shot_ids[1])
        assert shot1.video_status == "error"


def test_run_autorun_all_videos_failed_marks_error(ctx, monkeypatch):
    _, _, engine = ctx
    pid, _ = _seed_project(engine)

    async def _fake_submit_video(shot, project, **kw):
        raise HTTPException(status_code=503, detail="无可用 worker")

    async def _fake_voice(shot, session, settings):
        return "ok"

    async def _fake_assemble(p, body, pool, session):  # pragma: no cover
        raise AssertionError("无完成镜不应合成")

    monkeypatch.setattr(ds, "_submit_shot_video", _fake_submit_video)
    monkeypatch.setattr(ds, "_submit_shot_voice", _fake_voice)
    monkeypatch.setattr(ds, "_do_assemble", _fake_assemble)

    asyncio.run(ds._run_autorun(pid, "task-1", b"img"))

    rec = _autorun_record(engine, pid)
    assert rec["status"] == "error"
    assert "无已完成分镜视频" in rec["error"]


# ────────────────────────────────
# _run_autorun 并发边界
# ────────────────────────────────

def _patch_autorun_deps(monkeypatch, events, *, submit_video=None, voice=None):
    """autorun 测试通用 mock:回写标 done、合成记录事件。返回 None。"""

    async def _fake_writeback(sid, prompt_id):
        from app.db import engine as eng
        with Session(eng) as s:
            shot = s.get(DramaShot, sid)
            shot.video_status = "done"
            shot.video_url = f"/api/images?f={sid}"
            s.add(shot)
            s.commit()
        return True

    async def _fake_voice(shot, session, settings):
        events.append(f"voice:{shot.idx}")
        return f"/api/drama/voice/voice-{shot.idx}.wav"

    async def _fake_assemble(p, body, pool, session):
        events.append("assemble")
        return {"url": "u", "name": "n", "duration_sec": 10.0}

    monkeypatch.setattr(ds, "_submit_shot_video", submit_video)
    monkeypatch.setattr(ds, "_await_shot_video_writeback", _fake_writeback)
    monkeypatch.setattr(ds, "_submit_shot_voice", voice or _fake_voice)
    monkeypatch.setattr(ds, "_do_assemble", _fake_assemble)


def test_run_autorun_video_concurrency_bounded(ctx, monkeypatch):
    """视频阶段有界并发:3 镜 + 上限 2 → 同时在飞数恰好 2(>1 且 ≤ Semaphore)。"""
    _, _, engine = ctx
    pid, _ = _seed_project(engine)
    monkeypatch.setattr(ds.get_settings(), "drama_autorun_video_concurrency", 2)
    inflight = {"cur": 0, "max": 0}
    events: list[str] = []

    async def _fake_submit_video(shot, project, **kw):
        inflight["cur"] += 1
        inflight["max"] = max(inflight["max"], inflight["cur"])
        await asyncio.sleep(0.02)  # 让出事件循环,逼出真并发
        inflight["cur"] -= 1
        return f"prompt-{shot.idx}", "cid", "worker", 1

    _patch_autorun_deps(monkeypatch, events, submit_video=_fake_submit_video)
    asyncio.run(ds._run_autorun(pid, "task-1", b"img"))

    assert 1 < inflight["max"] <= 2
    rec = _autorun_record(engine, pid)
    assert rec["status"] == "done"
    assert rec["done"] == 3
    assert events[-1] == "assemble"


def test_run_autorun_voice_concurrency_bounded(ctx, monkeypatch):
    """配音阶段有界并发:2 个有台词镜 + 上限 2 → 同时在飞数恰好 2。"""
    _, _, engine = ctx
    pid, _ = _seed_project(engine)
    monkeypatch.setattr(ds.get_settings(), "drama_autorun_voice_concurrency", 2)
    inflight = {"cur": 0, "max": 0}
    events: list[str] = []

    async def _fake_submit_video(shot, project, **kw):
        return f"prompt-{shot.idx}", "cid", "worker", 1

    async def _fake_voice(shot, session, settings):
        inflight["cur"] += 1
        inflight["max"] = max(inflight["max"], inflight["cur"])
        await asyncio.sleep(0.02)
        inflight["cur"] -= 1
        return f"/api/drama/voice/voice-{shot.idx}.wav"

    _patch_autorun_deps(monkeypatch, events, submit_video=_fake_submit_video, voice=_fake_voice)
    asyncio.run(ds._run_autorun(pid, "task-1", b"img"))

    assert 1 < inflight["max"] <= 2
    rec = _autorun_record(engine, pid)
    assert rec["status"] == "done"


# ────────────────────────────────
# drama_image 纯函数
# ────────────────────────────────

def test_build_payload_structure():
    payload = drama_image._build_payload(
        [(b"\x01\x02", "image/jpeg"), (b"\x03", "image/png")],
        hint="雨夜爱情", style="日系", num_shots=6,
    )
    msgs = payload["messages"]
    assert msgs[0]["role"] == "system"
    content = msgs[1]["content"]
    # 两张图在前,文本收尾
    assert content[0]["type"] == "image_url"
    assert content[0]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert content[-1]["type"] == "text"
    assert "雨夜爱情" in content[-1]["text"] and "日系" in content[-1]["text"]
    assert "镜头数量:6" in content[-1]["text"]
    # 思考型模型双通道抑制
    assert payload["enable_thinking"] is False
    assert payload["chat_template_kwargs"] == {"enable_thinking": False}
    assert payload["max_tokens"] == 8192


def test_parse_json_obj_plain():
    obj = drama_image._parse_json_obj('{"title":"t","shots":[{"prompt":"p"}]}')
    assert obj is not None and obj["title"] == "t" and len(obj["shots"]) == 1


def test_parse_json_obj_think_wrapped():
    raw = '<think>我先分析图片,{"shots": 这是示例不是输出}</think>{"title":"t","shots":[{"prompt":"p"}]}'
    obj = drama_image._parse_json_obj(raw)
    assert obj is not None and obj["title"] == "t"


def test_parse_json_obj_markdown_fenced():
    raw = '```json\n{"title":"t","shots":[{"prompt":"p"}]}\n```'
    obj = drama_image._parse_json_obj(raw)
    assert obj is not None and obj["title"] == "t"


def test_parse_json_obj_invalid():
    assert drama_image._parse_json_obj("没有 JSON") is None


# ────────────────────────────────
# VLM 输出字段级校验(drama_image.validate_storyboard_shots)
# ────────────────────────────────

def test_validate_shots_mixed_good_bad():
    """好/坏混合:坏 shot 剔除、duration 越界钳制、告警记录。"""
    shots_raw = [
        {"prompt": "1boy, rain, cinematic", "duration_sec": 5, "scene": "雨夜"},
        {"prompt": "", "duration_sec": 5},                      # 坏:prompt 空
        {"prompt": "1girl, close-up", "duration_sec": 99},      # 越界 → 钳 15
        {"prompt": "1boy, wide shot", "duration_sec": 1},       # 越界 → 钳 2
        "not-a-dict",                                           # 坏:非对象
    ]
    good, warnings = drama_image.validate_storyboard_shots(shots_raw)
    assert len(good) == 3
    assert good[1]["duration_sec"] == 15
    assert good[2]["duration_sec"] == 2
    # 2 条剔除 + 2 条钳制告警
    assert len(warnings) == 4
    assert any("剔除" in w for w in warnings)
    assert any("钳制" in w for w in warnings)


def test_validate_shots_bad_field_types():
    """字段类型错:duration 非数值判坏;scene/characters 类型错只忽略字段。"""
    shots_raw = [
        {"prompt": "1boy, x", "duration_sec": "six"},           # 坏:duration 非数值
        {"prompt": "1girl, y", "duration_sec": "6"},            # 数字字符串 → 可转
        {"prompt": "1boy, z", "scene": 123, "characters": "阿明"},  # 字段类型错 → 忽略字段
    ]
    good, warnings = drama_image.validate_storyboard_shots(shots_raw)
    assert len(good) == 2
    assert good[0]["duration_sec"] == 6.0
    # scene/characters 被剔除出 dict(交由下游 coerce 兜底默认)
    assert "scene" not in good[1] and "characters" not in good[1]
    assert any("非数值" in w for w in warnings)
    assert any("类型错误" in w for w in warnings)
    assert any("非数组" in w for w in warnings)


def test_strip_montage_clauses():
    """LTX 铁律静态检查:蒙太奇标志词所在句被剥离,其余保留。"""
    prompt = "1boy, black hair, standing in rain, cut to wide shot, cinematic"
    cleaned, stripped = drama_image._strip_montage_clauses(prompt)
    assert "cut to" not in cleaned
    assert "standing in rain" in cleaned and "cinematic" in cleaned
    assert stripped == ["cut to wide shot"]

    cleaned2, stripped2 = drama_image._strip_montage_clauses("1girl, 蒙太奇闪过回忆, close-up")
    assert "蒙太奇" not in cleaned2 and stripped2


def test_validate_shots_montage_stripped_not_dropped():
    """含蒙太奇词的 shot 不判坏,剥离后继续;剥离为空才判坏。"""
    shots_raw = [
        {"prompt": "1boy, running, montage of memories, cinematic", "duration_sec": 5},
        {"prompt": "蒙太奇", "duration_sec": 5},  # 剥离后为空 → 判坏
    ]
    good, warnings = drama_image.validate_storyboard_shots(shots_raw)
    assert len(good) == 1
    assert good[0]["prompt"] == "1boy, running, cinematic"
    assert any("多镜头标志词" in w for w in warnings)
    assert any("剥离后为空" in w for w in warnings)


# ────────────────────────────────
# analyze_storyboard_images:重试与 422(mock httpx)
# ────────────────────────────────

def _vlm_resp(obj: dict) -> dict:
    return {"choices": [{"message": {"content": json.dumps(obj, ensure_ascii=False)}}]}


class _FakeResp:
    def __init__(self, payload: dict, status: int = 200):
        self.status_code = status
        self._payload = payload
        self.text = json.dumps(payload, ensure_ascii=False)

    def json(self) -> dict:
        return self._payload


class _FakeVLMClient:
    """按队列依次返回响应的 httpx.AsyncClient 替身;记录每次 post 的 payload。"""

    calls: list[dict] = []
    queue: list[dict] = []

    def __init__(self, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json=None, headers=None):
        type(self).calls.append(json)
        return _FakeResp(type(self).queue.pop(0))


def _patch_vlm(monkeypatch, responses: list[dict]):
    _FakeVLMClient.calls = []
    _FakeVLMClient.queue = list(responses)
    monkeypatch.setattr(drama_image.httpx, "AsyncClient", _FakeVLMClient)


_ALL_BAD_OBJ = {
    "title": "t",
    "shots": [{"prompt": "", "duration_sec": 5}, {"scene": "x"}],  # 全坏:prompt 均空
}
_GOOD_OBJ = {
    "title": "雨夜",
    "premise": "p",
    "script": "s",
    "shots": [{"prompt": "1boy, rain, cinematic", "duration_sec": 5}],
}
_IMGS = [(b"\x01\x02", "image/jpeg")]


def test_analyze_partial_bad_filtered(monkeypatch):
    """坏 shot ≤ 一半:剔除坏 shot 继续,告警进返回 meta,不重试。"""
    obj = {
        "title": "t",
        "shots": [
            {"prompt": "1boy, a, cinematic", "duration_sec": 5},
            {"prompt": "1girl, b, cinematic", "duration_sec": 6},
            {"prompt": "1boy, c, cinematic", "duration_sec": 4},
            {"prompt": "", "duration_sec": 5},  # 坏(1/4 ≤ 一半)
        ],
    }
    _patch_vlm(monkeypatch, [_vlm_resp(obj)])
    result = asyncio.run(
        drama_image.analyze_storyboard_images(_IMGS, "", "", 4)
    )
    assert len(result["shots"]) == 3
    assert len(_FakeVLMClient.calls) == 1  # 未重试
    assert any("剔除" in w for w in result["warnings"])


def test_analyze_all_bad_retries_then_422(monkeypatch):
    """全坏:触发一次重试(降 temperature + 修正指令),重试仍全坏 → 422。"""
    _patch_vlm(monkeypatch, [_vlm_resp(_ALL_BAD_OBJ), _vlm_resp(_ALL_BAD_OBJ)])
    with pytest.raises(HTTPException) as exc:
        asyncio.run(drama_image.analyze_storyboard_images(_IMGS, "", "", 4))
    assert exc.value.status_code == 422
    assert len(_FakeVLMClient.calls) == 2
    retry_payload = _FakeVLMClient.calls[1]
    assert retry_payload["temperature"] == 0.2
    assert "修正要求" in retry_payload["messages"][1]["content"][-1]["text"]


def test_analyze_all_bad_retry_recovers(monkeypatch):
    """全坏重试后恢复:返回重试得到的 shots。"""
    _patch_vlm(monkeypatch, [_vlm_resp(_ALL_BAD_OBJ), _vlm_resp(_GOOD_OBJ)])
    result = asyncio.run(
        drama_image.analyze_storyboard_images(_IMGS, "", "", 4)
    )
    assert len(_FakeVLMClient.calls) == 2
    assert result["title"] == "雨夜"
    assert len(result["shots"]) == 1


# ────────────────────────────────
# 配音时长对齐(_fit_voice_to_slot)
# ────────────────────────────────

def _patch_voice_fit(monkeypatch, durations: dict, ffmpeg_cmds: list):
    """mock assembly 的 _probe_duration(按文件名查表)与 _run_ffmpeg(记录命令)。

    atempo 产物:在目标路径写非空字节,产物时长按 tempo 折算。
    """
    import app.routes.assembly as asm

    async def _fake_probe(path):
        return durations[path.name]

    async def _fake_ffmpeg(cmd, timeout=None):
        ffmpeg_cmds.append(cmd)
        import pathlib
        out = next(
            (a for a in cmd if pathlib.Path(a).name.startswith("voice-fit-")), None
        )
        assert out is not None
        # 从 filter 里取 tempo 折算产物时长
        filt = cmd[cmd.index("-filter:a") + 1]
        tempo = float(filt.split("atempo=")[1])
        src = cmd[cmd.index("-i") + 1]
        pathlib.Path(out).write_bytes(b"wav")
        durations[pathlib.Path(out).name] = durations[pathlib.Path(src).name] / tempo

    monkeypatch.setattr(asm, "_probe_duration", _fake_probe)
    monkeypatch.setattr(asm, "_run_ffmpeg", _fake_ffmpeg)


def test_fit_voice_within_tolerance_untouched(tmp_path, monkeypatch):
    """配音 ≤ 镜时长 + 0.3s 容差:不处理。"""
    src = tmp_path / "voice-000.wav"
    src.write_bytes(b"wav")
    cmds: list = []
    _patch_voice_fit(monkeypatch, {src.name: 5.2}, cmds)  # slot 5.0,超 0.2 ≤ 0.3

    out, rec = asyncio.run(ds._fit_voice_to_slot(src, 5.0, tmp_path, 0))
    assert out == src
    assert rec["action"] == "unchanged"
    assert rec["src_duration"] == 5.2
    assert cmds == []  # 未调 ffmpeg


def test_fit_voice_over_tolerance_compresses(tmp_path, monkeypatch):
    """配音超长且压缩比 ≤1.3:atempo 压回时槽。"""
    src = tmp_path / "voice-001.wav"
    src.write_bytes(b"wav")
    cmds: list = []
    _patch_voice_fit(monkeypatch, {src.name: 6.0}, cmds)  # slot 5.0 → tempo 1.2

    out, rec = asyncio.run(ds._fit_voice_to_slot(src, 5.0, tmp_path, 1))
    assert out.name == "voice-fit-001.wav"
    assert rec["action"] == "compressed"
    assert rec["tempo"] == 1.2
    assert rec["final_duration"] == 5.0
    assert len(cmds) == 1
    assert "atempo=1.200" in cmds[0][cmds[0].index("-filter:a") + 1]


def test_fit_voice_ratio_over_max_skipped(tmp_path, monkeypatch):
    """压缩比 >1.3:不压,保留原样并记 skipped。"""
    src = tmp_path / "voice-002.wav"
    src.write_bytes(b"wav")
    cmds: list = []
    _patch_voice_fit(monkeypatch, {src.name: 8.0}, cmds)  # slot 5.0 → tempo 1.6 > 1.3

    out, rec = asyncio.run(ds._fit_voice_to_slot(src, 5.0, tmp_path, 2))
    assert out == src
    assert rec["action"] == "skipped"
    assert rec["tempo"] == 1.6
    assert cmds == []


def test_atempo_filter_chain():
    """atempo 串联链:单段 ≤2.0。"""
    assert ds._atempo_filter(1.2) == "atempo=1.200"
    chain = ds._atempo_filter(5.0)
    assert chain == "atempo=2.000,atempo=2.000,atempo=1.250"
