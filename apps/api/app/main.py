"""FastAPI 应用装配。"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import bootstrap_admin, init_db
from app.routes import (
    admin,
    agent,
    audio,
    auth,
    generate,
    images,
    jobs,
    marketplace,
    models,
    threed,
    upload,
    video,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    bootstrap_admin()
    yield


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
        admin,
        models,
        marketplace,
        generate,
        video,
        threed,
        audio,
        agent,
        upload,
        jobs,
        images,
    ):
        app.include_router(module.router, prefix="/api")

    return app


app = create_app()
