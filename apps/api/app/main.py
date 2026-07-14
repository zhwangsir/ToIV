"""FastAPI 应用装配。"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import bootstrap_admin, init_db
from app.routes import (
    account,
    admin,
    agent,
    agents,
    assembly,
    audio,
    backlot,
    cad,
    dub,
    dub_anime,
    dub_text,
    dub_voice,
    nas_models,
    auth,
    forge,
    generate,
    images,
    jobs,
    lipsync,
    manju,
    manju_project,
    marketplace,
    models,
    optimize,
    score,
    system,
    threed,
    train,
    upload,
    video,
    voice,
    workflows,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    bootstrap_admin()
    # 内置提示词优化智能体幂等播种(已存在 id 跳过,不动用户改过的)
    from sqlmodel import Session

    from app.agents_seed import seed_builtin_agents
    from app.db import engine

    with Session(engine) as session:
        seed_builtin_agents(session)
    # 重启后重挂未终态作业的追踪(防长视频作业孤儿化停在 queued)+ 周期性自愈
    from app.comfy.tracker import reconcile_loop, reconcile_pending

    reconcile_pending()
    reconcile_task = asyncio.create_task(reconcile_loop())
    try:
        yield
    finally:
        reconcile_task.cancel()


def create_app() -> FastAPI:
    settings = get_settings()

    # Sentry 错误追踪:仅在配置了 DSN 时初始化。
    # 用 try/except ImportError 包裹 —— sentry-sdk 未装(如精简环境)时跳过,不阻断启动;
    # 装上 sentry-sdk[fastapi] 后自动生效。NSFW 场景务必 send_default_pii=False,绝不把用户 PII 上报。
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration

        if settings.sentry_dsn.strip():
            sentry_sdk.init(
                dsn=settings.sentry_dsn.strip(),
                integrations=[
                    FastApiIntegration(),
                    SqlalchemyIntegration(),
                ],
                traces_sample_rate=0.1,  # 10% 事务采样(性能追踪),平衡成本与可观测性
                environment=settings.environment,
                send_default_pii=False,  # NSFW 场景:不上报用户个人可识别信息
            )
    except ImportError:
        # sentry-sdk 未安装:仅留骨架,装上即生效
        pass

    app = FastAPI(title="ToIV API", version="0.0.1", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,  # 前端需带 Cookie/JWT 跨域;CORS 规范要求 credentials=True 时 origins 必须是精确域名，禁止 "*"
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 按请求 R18 放行标记(/nsfw 专页带 X-NSFW: 1)→ ContextVar;gate/模型列表据此放行,不动账户开关。
    @app.middleware("http")
    async def _nsfw_intent_mw(request, call_next):
        from app.nsfw_ctx import nsfw_intent_var

        token = nsfw_intent_var.set(request.headers.get("x-nsfw") == "1")
        try:
            return await call_next(request)
        finally:
            nsfw_intent_var.reset(token)

    # Prometheus 指标监控:自动暴露 /metrics endpoint(含 http_requests_total /
    # http_request_duration_seconds / http_requests_in_progress)。在路由注册前 instrument,
    # 以覆盖全部业务路由;excluded_handlers 排除 /metrics 自身避免自引用计数。
    # try/except 规避未装 prometheus-fastapi-instrumentator 的环境(骨架,装上即生效)。
    # /metrics 不加鉴权:本轮只暴露基础请求计数/时延,Prometheus scrape 需无鉴权访问;
    # endpoint 名会随路由结构暴露,部署时建议放内网/经反代隔离。
    try:
        from prometheus_fastapi_instrumentator import Instrumentator

        Instrumentator(
            should_group_status_codes=True,
            should_ignore_untemplated=True,
            should_respect_env_var=False,
            excluded_handlers=["/metrics"],
        ).instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)
    except ImportError:
        # prometheus-fastapi-instrumentator 未安装:仅留骨架,装上即生效
        pass

    @app.get("/api/health")
    async def health() -> dict:
        return {"status": "ok", "workers": settings.worker_urls}

    for module in (
        auth,
        account,
        admin,
        models,
        marketplace,
        generate,
        score,
        video,
        threed,
        audio,
        agent,
        agents,
        optimize,
        manju,
        manju_project,
        assembly,
        voice,
        lipsync,
        dub,
        dub_anime,
        dub_text,
        dub_voice,
        nas_models,
        cad,
        forge,
        system,
        upload,
        jobs,
        images,
        train,
        backlot,
        workflows,
    ):
        app.include_router(module.router, prefix="/api")

    return app


app = create_app()
