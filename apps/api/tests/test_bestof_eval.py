"""B 评测管线测试:best-of-n 批次分组 / 启发式评分 / VLM 降级 / winner 标记。

全部 mock HTTP(httpx.MockTransport / 注入假 probe / 假 submit),不依赖真机。
"""
from __future__ import annotations

import json

import httpx
import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.services.bestof as bestof
from app.models import EvalBatch, EvalScore, Job, User
from app.routes.h3_studio import H3T2VRequest
from app.services.eval_scorers import (
    HeuristicScorer,
    ScorerError,
    VariantContext,
    VLMScorer,
)


@pytest.fixture
def db(monkeypatch):
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    monkeypatch.setattr(bestof, "engine", eng)
    return eng


@pytest.fixture
def user():
    return User(id="u-eval", email="e", hashed_password="x", tenant_id="t-eval")


def _make_req() -> H3T2VRequest:
    return H3T2VRequest(positive="a cat walking in rain", duration_sec=5.0, seed=1000)


def _fake_submit(eng, statuses, user):
    """假 submit_h3_job:仿真行为落 Job 行,返回同形状 dict。statuses 供后续改写终态。"""
    counter = {"i": 0}

    async def _submit(graph, *, kind, positive, seed, req, user, session, client=None, nsfw=False):
        counter["i"] += 1
        pid = f"pid-{seed}"
        job = Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=pid,
            worker="http://h3",
            kind=kind,
            status="queued",
            prompt=positive,
            seed=seed,
            nsfw=nsfw,
            params=json.dumps(req.model_dump()),
        )
        session.add(job)
        session.commit()
        statuses[job.id] = "queued"
        return {"prompt_id": pid, "client_id": "c", "worker": "http://h3", "seed": seed, "queued_behind": 0}

    return _submit


def _finish_jobs(eng, statuses, batch: EvalBatch):
    """把批次内 Job 按 statuses dict 置终态;done 的补 result。"""
    with Session(eng) as s:
        for job_id in json.loads(batch.job_ids):
            job = s.get(Job, job_id)
            job.status = statuses[job_id]
            if job.status == "done":
                job.result = json.dumps([f"/api/images?filename={job.prompt_id}.mp4&worker=http://h3"])
            s.add(job)
        s.commit()


# ---------------------------------------------------------------------------
# 1. 批次提交分组
# ---------------------------------------------------------------------------


async def test_submit_groups_variants_into_batch(db, user, monkeypatch):
    """n=3 变体 seed 递增、各走 submit 路径落 Job,批次分组字段齐全。"""
    monkeypatch.setattr(bestof.h3_service, "submit_h3_job", _fake_submit(db, {}, user))
    monkeypatch.setattr(bestof, "spawn_batch_watcher", lambda batch_id: None)

    with Session(db) as s:
        resp = await bestof.submit_h3_best_of_n(_make_req(), n=3, scorer="heuristic", user=user, session=s)
        assert resp["seeds"] == [1000, 1001, 1002]
        assert len(resp["job_ids"]) == 3
        batch = s.get(EvalBatch, resp["batch_id"])
        assert batch is not None
        assert batch.status == "generating"
        assert batch.n == 3
        assert batch.scorer == "heuristic"
        assert json.loads(batch.job_ids) == resp["job_ids"]
        assert json.loads(batch.seeds) == [1000, 1001, 1002]
        jobs = [s.get(Job, jid) for jid in resp["job_ids"]]
        assert [j.seed for j in jobs] == [1000, 1001, 1002]
        assert all(j.kind == "h3_t2v" for j in jobs)


async def test_submit_seed_unspecified_generates_incrementing(db, user, monkeypatch):
    """未指定 seed 时随机基础 seed,变体仍严格递增。"""
    monkeypatch.setattr(bestof.h3_service, "submit_h3_job", _fake_submit(db, {}, user))
    monkeypatch.setattr(bestof, "spawn_batch_watcher", lambda batch_id: None)
    req = _make_req()
    req.seed = None
    with Session(db) as s:
        resp = await bestof.submit_h3_best_of_n(req, n=2, scorer="auto", user=user, session=s)
    seeds = resp["seeds"]
    assert seeds[1] == seeds[0] + 1


# ---------------------------------------------------------------------------
# 2. 启发式评分正确性
# ---------------------------------------------------------------------------


def _ctx(**over):
    base = dict(
        job_id="j1",
        prompt="a cat",
        kind="h3_t2v",
        params={"width": 1344, "height": 768, "duration_sec": 5.0},
        result_urls=["/api/images?filename=a.mp4&worker=http://h3"],
        seed=1,
    )
    base.update(over)
    return VariantContext(**base)


async def test_heuristic_full_match_scores_one():
    async def probe(url):
        return {"width": 1344, "height": 768, "duration_sec": 5.0, "has_audio": True, "size_bytes": 1024}

    res = await HeuristicScorer(probe).score_variant(_ctx())
    assert res.scorer == "heuristic"
    assert res.total == 1.0
    assert res.breakdown == {
        "file_integrity": 1.0,
        "resolution": 1.0,
        "duration": 1.0,
        "audio": 1.0,
    }


async def test_heuristic_penalizes_mismatch_and_missing_audio():
    async def probe(url):
        # 分辨率减半(面积 1/4)、时长 2.5/5.0、无音轨
        return {"width": 672, "height": 384, "duration_sec": 2.5, "has_audio": False, "size_bytes": 512}

    res = await HeuristicScorer(probe).score_variant(_ctx())
    assert res.breakdown["file_integrity"] == 1.0
    assert res.breakdown["resolution"] == pytest.approx(0.25)
    assert res.breakdown["duration"] == pytest.approx(0.5)
    assert res.breakdown["audio"] == 0.0
    assert res.total == pytest.approx((1.0 + 0.25 + 0.5 + 0.0) / 4)


async def test_heuristic_probe_unavailable_falls_back_to_integrity():
    """探测不可用:只评完整性维(产物 URL 存在 = 1),不误伤为 0。"""
    res = await HeuristicScorer(_none_probe).score_variant(_ctx())
    assert res.total == 1.0
    assert res.breakdown == {"file_integrity": 1.0}


async def test_heuristic_no_result_is_zero():
    res = await HeuristicScorer(None).score_variant(_ctx(result_urls=[]))
    assert res.total == 0.0
    assert res.degraded is True


async def test_heuristic_non_audio_kind_skips_audio_dim():
    async def probe(url):
        return {"width": 1344, "height": 768, "has_audio": False, "size_bytes": 10}

    res = await HeuristicScorer(probe).score_variant(_ctx(kind="txt2img"))
    assert "audio" not in res.breakdown
    assert "duration" not in res.breakdown  # params 无 duration_sec 时不评


# ---------------------------------------------------------------------------
# 3. VLM 评分与失败降级
# ---------------------------------------------------------------------------


def _vlm_transport(handler):
    return httpx.MockTransport(handler)


async def _fetch_bytes(url):
    return b"x" * 16


async def _none_probe(url):
    return None


async def test_vlm_scorer_parses_strict_json():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": '```json\n{"score":82,"breakdown":{"aesthetic":0.8},"critique":"构图稳"}\n```'}}
                ]
            },
        )

    scorer = VLMScorer(
        "http://vlm/v1", "m", fetch_bytes=_fetch_bytes,
        transport=_vlm_transport(handler),
    )
    res = await scorer.score_variant(_ctx())
    assert res.scorer == "vlm"
    assert res.total == pytest.approx(0.82)
    assert res.breakdown["aesthetic"] == pytest.approx(0.8)
    assert res.critique == "构图稳"


async def test_vlm_scorer_http_error_raises():
    scorer = VLMScorer(
        "http://vlm/v1", "m", fetch_bytes=_fetch_bytes,
        transport=_vlm_transport(lambda req: httpx.Response(500)),
    )
    with pytest.raises(ScorerError):
        await scorer.score_variant(_ctx())


async def test_vlm_scorer_bad_json_raises():
    scorer = VLMScorer(
        "http://vlm/v1", "m", fetch_bytes=_fetch_bytes,
        transport=_vlm_transport(
            lambda req: httpx.Response(200, json={"choices": [{"message": {"content": "无法评估"}}]})
        ),
    )
    with pytest.raises(ScorerError):
        await scorer.score_variant(_ctx())


async def test_finalize_vlm_failure_falls_back_to_heuristic(db, user):
    """批次内 VLM 逐变体失败 → 降级启发式,记录 scorer=heuristic + degraded,链路不炸。"""
    with Session(db) as s:
        jobs = [
            Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id=f"p{i}", worker="http://h3",
                kind="h3_t2v", status="done", prompt="a cat", seed=i,
                params=json.dumps({"width": 1344, "height": 768}),
                result=json.dumps([f"/api/images?filename=p{i}.mp4&worker=http://h3"]))
            for i in range(2)
        ]
        for j in jobs:
            s.add(j)
        batch = EvalBatch(
            tenant_id=user.tenant_id, user_id=user.id, engine="h3", kind="h3_t2v",
            prompt="a cat", n=2, scorer="vlm",
            seeds=json.dumps([0, 1]),
            job_ids=json.dumps([j.id for j in jobs]),
        )
        s.add(batch)
        s.commit()
        batch_id = batch.id

    class _Boom:
        name = "vlm"

        async def score_variant(self, ctx):
            raise ScorerError("VLM 不可达")

    async def probe(url):
        return {"width": 1344, "height": 768, "size_bytes": 100}

    batch = await bestof.finalize_batch(batch_id, scorer=_Boom(), fallback=HeuristicScorer(probe))
    assert batch.status == "done"
    with Session(db) as s:
        recs = s.exec(select(EvalScore).where(EvalScore.batch_id == batch_id)).all()
        assert len(recs) == 2
        assert all(r.scorer == "heuristic" for r in recs)
        assert all(r.degraded for r in recs)
        assert all(r.score > 0 for r in recs)


# ---------------------------------------------------------------------------
# 4. winner 标记与排名(error 末位)
# ---------------------------------------------------------------------------


async def test_finalize_marks_winner_and_ranks_error_last(db, user):
    """3 变体:两个 done(分数有别) + 一个 error → error 0 分末位,最高分拿 winner。"""
    with Session(db) as s:
        specs = [
            ("good", "done", 10),
            ("mid", "done", 11),
            ("bad", "error", 12),
        ]
        job_ids = []
        for name, status, seed in specs:
            j = Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id=f"pid-{name}", worker="http://h3",
                    kind="h3_t2v", status=status, prompt="a cat", seed=seed,
                    params=json.dumps({"width": 1344, "height": 768}),
                    result=json.dumps([f"/api/images?filename={name}.mp4&worker=http://h3"]) if status == "done" else "")
            s.add(j)
            s.commit()
            job_ids.append(j.id)
        batch = EvalBatch(
            tenant_id=user.tenant_id, user_id=user.id, n=3, scorer="heuristic",
            seeds=json.dumps([10, 11, 12]), job_ids=json.dumps(job_ids),
        )
        s.add(batch)
        s.commit()
        batch_id = batch.id

    async def probe(url):
        # good 全匹配(1.0),mid 分辨率不匹配(部分分)
        if "good" in url:
            return {"width": 1344, "height": 768, "size_bytes": 100}
        return {"width": 672, "height": 384, "size_bytes": 100}

    batch = await bestof.finalize_batch(batch_id, scorer=HeuristicScorer(probe))
    assert batch.status == "done"
    good_id = job_ids[0]
    assert batch.winner_job_id == good_id

    view = bestof.get_batch_view(Session(db), batch_id, user)
    variants = view["variants"]
    assert variants[0]["job_id"] == good_id
    assert variants[0]["is_winner"] is True
    assert variants[0]["rank"] == 1
    # error 变体:0 分、末位、error 字段有值、无 winner
    last = variants[-1]
    assert last["job_id"] == job_ids[2]
    assert last["score"] == 0.0
    assert last["error"] == "error"
    assert last["is_winner"] is False
    assert sum(1 for v in variants if v["is_winner"]) == 1


async def test_finalize_all_failed_has_no_winner(db, user):
    with Session(db) as s:
        j = Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id="px", worker="http://h3",
                kind="h3_t2v", status="error", prompt="a cat", seed=1)
        s.add(j)
        s.commit()
        batch = EvalBatch(
            tenant_id=user.tenant_id, user_id=user.id, n=1, scorer="heuristic",
            seeds=json.dumps([1]), job_ids=json.dumps([j.id]),
        )
        s.add(batch)
        s.commit()
        batch_id = batch.id

    batch = await bestof.finalize_batch(batch_id, scorer=HeuristicScorer(None))
    assert batch.status == "done"
    assert batch.winner_job_id == ""


async def test_finalize_idempotent_on_done_batch(db, user):
    """已 done 的批次重复 finalize 直接返回,不产生新评分行。"""
    with Session(db) as s:
        j = Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id="pi", worker="http://h3",
                kind="h3_t2v", status="done", prompt="a", seed=1,
                result=json.dumps(["/api/images?filename=a.mp4&worker=http://h3"]))
        s.add(j)
        s.commit()
        batch = EvalBatch(
            tenant_id=user.tenant_id, user_id=user.id, n=1, scorer="heuristic",
            seeds=json.dumps([1]), job_ids=json.dumps([j.id]),
        )
        s.add(batch)
        s.commit()
        batch_id = batch.id

    await bestof.finalize_batch(batch_id, scorer=HeuristicScorer(None))
    await bestof.finalize_batch(batch_id, scorer=HeuristicScorer(None))
    with Session(db) as s:
        recs = s.exec(select(EvalScore).where(EvalScore.batch_id == batch_id)).all()
        assert len(recs) == 1
