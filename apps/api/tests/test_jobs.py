import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.ratelimit import _MAX_PER_WINDOW, _hits, enforce_generation_rate_limit
# 深化后:_hits key 从 user.id 变为 (user.id, scope) 元组
_RATE_SCOPE = "generation"
from app.security import create_token, hash_password


@pytest.fixture
def ctx():
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

    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="j@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        s.add(
            Job(
                tenant_id=tenant.id,
                user_id=user.id,
                prompt_id="p1",
                worker="http://w",
                prompt="hello",
                seed=1,
            )
        )
        s.commit()
        uid = user.id

    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def test_jobs_requires_auth(ctx):
    client, _ = ctx
    assert client.get("/api/jobs").status_code == 401


def test_jobs_lists_user_jobs(ctx):
    client, token = ctx
    r = client.get("/api/jobs", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    jobs = r.json()
    assert len(jobs) == 1
    assert jobs[0]["prompt"] == "hello"
    assert jobs[0]["status"] == "queued"


def test_jobs_limit_param(ctx):
    client, token = ctx
    H = {"Authorization": f"Bearer {token}"}
    # 显式 limit=1 正常返回
    r = client.get("/api/jobs?limit=1", headers=H)
    assert r.status_code == 200
    assert len(r.json()) == 1
    # 越界 limit 被 422 拒绝(上限 200,下限 1)
    assert client.get("/api/jobs?limit=0", headers=H).status_code == 422
    assert client.get("/api/jobs?limit=201", headers=H).status_code == 422


def test_jobs_status_filter(ctx):
    client, token = ctx
    H = {"Authorization": f"Bearer {token}"}
    # fixture 里的 job 是 queued:按 status=queued 应命中,done 应为空
    r = client.get("/api/jobs?status=queued", headers=H)
    assert r.status_code == 200
    assert len(r.json()) == 1
    r = client.get("/api/jobs?status=done", headers=H)
    assert r.status_code == 200
    assert r.json() == []


def test_delete_job_removes_from_library(ctx):
    client, token = ctx
    H = {"Authorization": f"Bearer {token}"}
    job_id = client.get("/api/jobs", headers=H).json()[0]["id"]
    r = client.delete(f"/api/jobs/{job_id}", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    # 删后作品库为空
    assert client.get("/api/jobs", headers=H).json() == []


def test_delete_missing_job_404(ctx):
    client, token = ctx
    r = client.delete("/api/jobs/does-not-exist", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# offset 分页(作品库无限滚动)
# --------------------------------------------------------------------------- #
@pytest.fixture
def ctx_paged():
    """5 条作业(created_at 显式递增),验证 offset/limit 翻页不重叠不遗漏。"""
    from datetime import timedelta

    from app.models import _now

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

    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="paged@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        base = _now()
        for i in range(5):
            s.add(
                Job(
                    tenant_id=tenant.id,
                    user_id=user.id,
                    prompt_id=f"pg{i}",
                    worker="http://w",
                    prompt=f"job-{i}",
                    seed=i,
                    created_at=base + timedelta(minutes=i),  # job-4 最新
                )
            )
        s.commit()
        uid = user.id

    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def test_jobs_offset_pagination_flow(ctx_paged):
    """limit=2 翻页:2/2/1,最新在前,页间不重叠、合页不遗漏。"""
    client, token = ctx_paged
    H = {"Authorization": f"Bearer {token}"}
    pages = [
        client.get(f"/api/jobs?limit=2&offset={off}", headers=H).json()
        for off in (0, 2, 4)
    ]
    assert [len(p) for p in pages] == [2, 2, 1]
    prompts = [j["prompt"] for p in pages for j in p]
    assert prompts == ["job-4", "job-3", "job-2", "job-1", "job-0"]


def test_jobs_offset_beyond_returns_empty(ctx_paged):
    client, token = ctx_paged
    H = {"Authorization": f"Bearer {token}"}
    r = client.get("/api/jobs?limit=2&offset=99", headers=H)
    assert r.status_code == 200
    assert r.json() == []


def test_jobs_offset_negative_422(ctx_paged):
    client, token = ctx_paged
    H = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/jobs?offset=-1", headers=H).status_code == 422


def test_jobs_offset_with_status_filter(ctx_paged):
    """offset 与 status 过滤叠加:分页作用于过滤后的结果集。"""
    client, token = ctx_paged
    H = {"Authorization": f"Bearer {token}"}
    # 全部 5 条都是 queued
    r = client.get("/api/jobs?status=queued&limit=2&offset=4", headers=H)
    assert [j["prompt"] for j in r.json()] == ["job-0"]
    r_done = client.get("/api/jobs?status=done&limit=2&offset=0", headers=H)
    assert r_done.json() == []


# --------------------------------------------------------------------------- #
# kind 过滤(作品库服务端分类)
# --------------------------------------------------------------------------- #
@pytest.fixture
def ctx_kind():
    """不同 kind 的作业,验证 kind 过滤与分页叠加。"""
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

    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="kind@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        # 不同 kind:图像/视频/音频/3D
        s.add(
            Job(
                tenant_id=tenant.id,
                user_id=user.id,
                prompt_id="k1",
                worker="http://w",
                prompt="img-job",
                seed=1,
                kind="txt2img",
            )
        )
        s.add(
            Job(
                tenant_id=tenant.id,
                user_id=user.id,
                prompt_id="k2",
                worker="http://w",
                prompt="video-job",
                seed=2,
                kind="wan_t2v",
            )
        )
        s.add(
            Job(
                tenant_id=tenant.id,
                user_id=user.id,
                prompt_id="k3",
                worker="http://w",
                prompt="audio-job",
                seed=3,
                kind="ace_audio",
            )
        )
        s.add(
            Job(
                tenant_id=tenant.id,
                user_id=user.id,
                prompt_id="k4",
                worker="http://w",
                prompt="3d-job",
                seed=4,
                kind="hunyuan3d",
            )
        )
        s.commit()
        uid = user.id

    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def test_jobs_kind_filter(ctx_kind):
    """按 kind 过滤:各分类命中正确,空值返回全部。"""
    client, token = ctx_kind
    H = {"Authorization": f"Bearer {token}"}
    # 全部 4 条
    assert len(client.get("/api/jobs", headers=H).json()) == 4
    # 图像
    r = client.get("/api/jobs?kind=txt2img", headers=H)
    assert [j["prompt"] for j in r.json()] == ["img-job"]
    # 视频
    r = client.get("/api/jobs?kind=wan_t2v", headers=H)
    assert [j["prompt"] for j in r.json()] == ["video-job"]
    # 音频
    r = client.get("/api/jobs?kind=ace_audio", headers=H)
    assert [j["prompt"] for j in r.json()] == ["audio-job"]
    # 3D
    r = client.get("/api/jobs?kind=hunyuan3d", headers=H)
    assert [j["prompt"] for j in r.json()] == ["3d-job"]


def test_jobs_kind_multi_values(ctx_kind):
    """逗号分隔多值 kind:命中任一匹配,空值/空白忽略。"""
    client, token = ctx_kind
    H = {"Authorization": f"Bearer {token}"}
    # 图像+视频
    r = client.get("/api/jobs?kind=txt2img,wan_t2v", headers=H)
    assert sorted(j["prompt"] for j in r.json()) == ["img-job", "video-job"]
    # 带空白
    r = client.get("/api/jobs?kind= txt2img , ace_audio ", headers=H)
    assert sorted(j["prompt"] for j in r.json()) == ["audio-job", "img-job"]
    # 空值等价全部
    r = client.get("/api/jobs?kind=", headers=H)
    assert len(r.json()) == 4
    # 纯空白等价全部
    r = client.get("/api/jobs?kind= , ", headers=H)
    assert len(r.json()) == 4


def test_jobs_kind_with_pagination(ctx_kind):
    """kind 过滤与 offset/limit 叠加:分页作用于过滤后结果集。"""
    client, token = ctx_kind
    H = {"Authorization": f"Bearer {token}"}
    # kind=txt2img 只有 1 条,offset=0 返回它,offset=1 返回空
    r = client.get("/api/jobs?kind=txt2img&limit=1&offset=0", headers=H)
    assert [j["prompt"] for j in r.json()] == ["img-job"]
    r = client.get("/api/jobs?kind=txt2img&limit=1&offset=1", headers=H)
    assert r.json() == []


def test_jobs_kind_with_status(ctx_kind):
    """kind 与 status 叠加过滤。"""
    client, token = ctx_kind
    H = {"Authorization": f"Bearer {token}"}
    # 全部默认 queued,kind=txt2img + status=queued 命中
    r = client.get("/api/jobs?kind=txt2img&status=queued", headers=H)
    assert [j["prompt"] for j in r.json()] == ["img-job"]
    # kind=txt2img + status=done 为空
    r = client.get("/api/jobs?kind=txt2img&status=done", headers=H)
    assert r.json() == []


@pytest.fixture
def ctx_kind_prefix():
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

    with Session(engine) as s:
        tenant = Tenant(name="t-prefix")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="kind-prefix@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        for i, (prompt, kind) in enumerate(
            [
                ("img-job", "txt2img"),
                ("cad-job", "cad_front"),
                ("ref-job", "drama_char_reference_hero"),
                ("3d-job", "hunyuan3d"),
            ],
            start=1,
        ):
            s.add(
                Job(
                    tenant_id=tenant.id,
                    user_id=user.id,
                    prompt_id=f"pk{i}",
                    worker="http://w",
                    prompt=prompt,
                    seed=i,
                    kind=kind,
                )
            )
        s.commit()
        uid = user.id

    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def test_jobs_kind_prefix_matches_cad_and_drama_ref(ctx_kind_prefix):
    """cad_ / drama_char_reference_ 前缀命中动态 kind;精确值不受影响。"""
    client, token = ctx_kind_prefix
    H = {"Authorization": f"Bearer {token}"}
    assert len(client.get("/api/jobs", headers=H).json()) == 4
    cad = client.get("/api/jobs?kind=cad_", headers=H).json()
    assert [j["prompt"] for j in cad] == ["cad-job"]
    refs = client.get("/api/jobs?kind=drama_char_reference_", headers=H).json()
    assert [j["prompt"] for j in refs] == ["ref-job"]
    d3 = client.get("/api/jobs?kind=hunyuan3d,cad_", headers=H).json()
    assert sorted(j["prompt"] for j in d3) == ["3d-job", "cad-job"]
    img = client.get("/api/jobs?kind=txt2img,drama_char_reference_", headers=H).json()
    assert sorted(j["prompt"] for j in img) == ["img-job", "ref-job"]
    exact = client.get("/api/jobs?kind=hunyuan3d", headers=H).json()
    assert [j["prompt"] for j in exact] == ["3d-job"]


def test_delete_requires_auth(ctx):
    client, _ = ctx
    assert client.delete("/api/jobs/whatever").status_code == 401


def test_rate_limit_blocks_after_max():
    class _U:
        id = "ratelimit-test-user"

    user = _U()
    _hits.pop((user.id, _RATE_SCOPE), None)
    for _ in range(_MAX_PER_WINDOW):
        enforce_generation_rate_limit(user)  # 不应抛
    with pytest.raises(HTTPException) as exc:
        enforce_generation_rate_limit(user)
    assert exc.value.status_code == 429
