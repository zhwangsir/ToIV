"""FastAPI 应用装配。"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routes import generate, images, jobs, models


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="ToIV API", version="0.0.1")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict:
        return {"status": "ok", "workers": settings.worker_urls}

    for module in (models, generate, jobs, images):
        app.include_router(module.router, prefix="/api")

    return app


app = create_app()
