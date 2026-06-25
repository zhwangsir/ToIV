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
    auth,
    generate,
    images,
    jobs,
    manju,
    marketplace,
    models,
    optimize,
    system,
    threed,
    upload,
    video,
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
        video,
        threed,
        audio,
        agent,
        optimize,
        manju,
        assembly,
        system,
        upload,
        jobs,
        images,
    ):
        app.include_router(module.router, prefix="/api")

    return app


app = create_app()
