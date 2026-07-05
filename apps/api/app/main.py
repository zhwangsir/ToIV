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
    assembly,
    audio,
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
    upload,
    video,
    voice,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    bootstrap_admin()
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
    app = FastAPI(title="ToIV API", version="0.0.1", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
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
    ):
        app.include_router(module.router, prefix="/api")

    return app


app = create_app()
