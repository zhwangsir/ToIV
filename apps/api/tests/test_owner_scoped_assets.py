"""多租户最小切片:产物/状态强制 owner。

覆盖:
- /api/images 无 sig:同租户非本人 404;本人/admin/合法 sig 200
- dub 状态接口:跨用户 404;本人/admin 200
- /api/dub/output:非属主 404;属主 200
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.images as images_mod
from app.comfy.tracker import image_url
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password

_DATA = b"PNGFAKE" * 32
_WORKER = "http://192.168.71.127:8189"


class _FakeWorker:
    base_url = _WORKER

    async def get_image_bytes(self, filename, subfolder, type_):
        return _DATA, "image/png"


@pytest.fixture
def ctx(monkeypatch, tmp_path):
    from types import SimpleNamespace

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    fake_worker = _FakeWorker()
    app.dependency_overrides[get_pool] = lambda: SimpleNamespace(clients=[fake_worker])
    monkeypatch.setattr(images_mod, "resolve_worker", lambda w: fake_worker)

    # dub output 目录
    import app.routes.dub as dub_mod
    monkeypatch.setattr(dub_mod, "_DUB_DIR", tmp_path)

    with Session(engine) as s:
        t1 = Tenant(name="t1")
        t2 = Tenant(name="t2")
        s.add_all([t1, t2])
        s.commit()
        s.refresh(t1)
        s.refresh(t2)
        owner = User(email="owner", hashed_password=hash_password("x"), tenant_id=t1.id)
        mate = User(email="mate", hashed_password=hash_password("x"), tenant_id=t1.id)
        outsider = User(email="outsider", hashed_password=hash_password("x"), tenant_id=t2.id)
        admin = User(
            email="admin", hashed_password=hash_password("x"), tenant_id=t2.id, role="admin"
        )
        s.add_all([owner, mate, outsider, admin])
        s.commit()
        for u in (owner, mate, outsider, admin):
            s.refresh(u)

        s.add(
            Job(
                tenant_id=t1.id,
                user_id=owner.id,
                prompt_id="p-own",
                worker=_WORKER,
                kind="txt2img",
                status="done",
                prompt="x",
                seed=1,
                result=f'["/api/images?filename=own.png&subfolder=&type=output&worker={_WORKER}"]',
            )
        )
        # dub lipsync job owned by owner
        out_name = "dubsync-" + "a" * 32 + ".mp4"
        dub_job = {
            "id": "dubjob1",
            "status": "done",
            "stage": "完成",
            "total": 1,
            "completed": 1,
            "fallbacks": 0,
            "gpu_seconds": 1.0,
            "url": f"/api/dub/output/{out_name}",
            "error": None,
            "source_duration": 1.0,
            "elapsed": 1.0,
        }
        s.add(
            Job(
                tenant_id=t1.id,
                user_id=owner.id,
                prompt_id="dubjob1",
                worker="",
                kind="dub_lipsync_long",
                status="done",
                prompt="长视频对口型",
                result=json.dumps(dub_job, ensure_ascii=False),
            )
        )
        # transcribe job
        tr_job = {
            "id": "trjob1",
            "status": "done",
            "stage": "完成",
            "count": 1,
            "segments": [{"index": 0, "start": 0.0, "end": 1.0, "text": "hi"}],
            "error": None,
            "progress": 100,
            "elapsed": 1.0,
        }
        s.add(
            Job(
                tenant_id=t1.id,
                user_id=owner.id,
                prompt_id="trjob1",
                worker="",
                kind="transcribe",
                status="done",
                prompt="视频听写",
                result=json.dumps(tr_job, ensure_ascii=False),
            )
        )
        # voice track
        voice_job = {
            "id": "vjob1",
            "status": "done",
            "stage": "完成",
            "total": 1,
            "completed": 1,
            "failed": 0,
            "progress": 100,
            "result": None,
            "error": None,
            "elapsed": 1.0,
        }
        s.add(
            Job(
                tenant_id=t1.id,
                user_id=owner.id,
                prompt_id="vjob1",
                worker="",
                kind="voice_track",
                status="done",
                prompt="配音轨合成",
                result=json.dumps(voice_job, ensure_ascii=False),
            )
        )
        # anime
        anime_job = {
            "id": "ajob1",
            "status": "done",
            "stage": "完成",
            "progress": 100,
            "frames": 10,
            "faces_detected": 1,
            "url": None,
            "error": None,
            "elapsed": 1.0,
        }
        s.add(
            Job(
                tenant_id=t1.id,
                user_id=owner.id,
                prompt_id="ajob1",
                worker="",
                kind="anime_lipsync",
                status="done",
                prompt="动漫对口型",
                result=json.dumps(anime_job, ensure_ascii=False),
            )
        )
        s.commit()
        # write fake output file matching regex
        out_path = tmp_path / out_name
        out_path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
        tokens = {
            "owner": create_token(owner.id),
            "mate": create_token(mate.id),
            "outsider": create_token(outsider.id),
            "admin": create_token(admin.id),
        }
        ids = {"out_name": out_name}
    yield TestClient(app), tokens, ids
    app.dependency_overrides.clear()


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _unsigned_url(filename: str) -> str:
    return f"/api/images?filename={filename}&subfolder=&type=output&worker={_WORKER}"


class TestImagesOwnerScoped:
    def test_unsigned_mate_404(self, ctx):
        client, tokens, _ = ctx
        r = client.get(_unsigned_url("own.png"), headers=_h(tokens["mate"]))
        assert r.status_code == 404

    def test_unsigned_outsider_404(self, ctx):
        client, tokens, _ = ctx
        r = client.get(_unsigned_url("own.png"), headers=_h(tokens["outsider"]))
        assert r.status_code == 404

    def test_unsigned_owner_200(self, ctx):
        client, tokens, _ = ctx
        r = client.get(_unsigned_url("own.png"), headers=_h(tokens["owner"]))
        assert r.status_code == 200

    def test_unsigned_admin_200(self, ctx):
        client, tokens, _ = ctx
        r = client.get(_unsigned_url("own.png"), headers=_h(tokens["admin"]))
        assert r.status_code == 200

    def test_signed_outsider_200(self, ctx):
        client, tokens, _ = ctx
        url = image_url(_WORKER, {"filename": "any.png", "subfolder": "", "type": "output"})
        r = client.get(url, headers=_h(tokens["outsider"]))
        assert r.status_code == 200


class TestDubStatusOwnerScoped:
    @pytest.mark.parametrize(
        "path",
        [
            "/api/dub/lipsync-long/dubjob1",
            "/api/dub/transcribe/trjob1",
            "/api/dub/voice-track-status/vjob1",
            "/api/dub/anime-lipsync/ajob1",
        ],
    )
    def test_cross_user_404(self, ctx, path):
        client, tokens, _ = ctx
        for who in ("mate", "outsider"):
            r = client.get(path, headers=_h(tokens[who]))
            assert r.status_code == 404, (who, path, r.text)

    @pytest.mark.parametrize(
        "path",
        [
            "/api/dub/lipsync-long/dubjob1",
            "/api/dub/transcribe/trjob1",
            "/api/dub/voice-track-status/vjob1",
            "/api/dub/anime-lipsync/ajob1",
        ],
    )
    def test_owner_and_admin_200(self, ctx, path):
        client, tokens, _ = ctx
        for who in ("owner", "admin"):
            r = client.get(path, headers=_h(tokens[who]))
            assert r.status_code == 200, (who, path, r.text)
            assert r.json().get("status") == "done"


class TestDubOutputOwnerScoped:
    def test_owner_200(self, ctx):
        client, tokens, ids = ctx
        r = client.get(f"/api/dub/output/{ids['out_name']}", headers=_h(tokens["owner"]))
        assert r.status_code == 200

    def test_mate_404(self, ctx):
        client, tokens, ids = ctx
        r = client.get(f"/api/dub/output/{ids['out_name']}", headers=_h(tokens["mate"]))
        assert r.status_code == 404

    def test_admin_200(self, ctx):
        client, tokens, ids = ctx
        r = client.get(f"/api/dub/output/{ids['out_name']}", headers=_h(tokens["admin"]))
        assert r.status_code == 200
