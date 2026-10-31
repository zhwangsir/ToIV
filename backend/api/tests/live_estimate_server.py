"""D0 浏览器联调专用 FastAPI 进程：临时 SQLite + 无 GPU 渲染替身。"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import tempfile
from pathlib import Path

import uvicorn
from sqlmodel import Session, SQLModel, create_engine

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from app.config import Settings

Settings.model_config["env_file"] = None

import app.db as db_mod
from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password
from app.services.studio import estimates
from app.services.studio import orchestrator as orch


async def main() -> None:
    with tempfile.TemporaryDirectory(
        prefix="toiv-d0-live-", dir=os.environ.get("TOIV_D0_TEST_TEMP_DIR")
    ) as temp_dir:
        database_path = Path(temp_dir) / "estimate.sqlite3"
        engine = create_engine(
            f"sqlite:///{database_path}", connect_args={"check_same_thread": False}
        )
        SQLModel.metadata.create_all(engine)

        def override_session():
            with Session(engine) as session:
                yield session

        app.dependency_overrides[get_session] = override_session
        db_mod.engine = engine
        settings = db_mod._settings
        settings.database_url = f"sqlite:///{database_path}"
        settings.environment = "test"
        settings.jwt_secret = "d0-live-test-only-jwt-secret"
        settings.studio_cost_rates_json = ""
        settings.studio_render_budget_limit = "0"
        estimates.get_settings = lambda: settings

        async def state_only_render(session, shot, pool=None, request=None, **kwargs):
            shot.status = "rendered"
            shot.video_url = f"/api/studio/files/{shot.id}-d0-live.mp4"
            shot.candidates_json = json.dumps([{
                "id": f"candidate-{shot.id}",
                "url": shot.video_url,
                "status": "done",
                "is_picked": True,
            }])
            session.add(shot)
            session.commit()
            return shot

        orch.render_shot = state_only_render

        with Session(engine) as session:
            tenant = Tenant(name="d0-live")
            session.add(tenant)
            session.commit()
            session.refresh(tenant)
            user = User(
                email="d0-live@example.test",
                hashed_password=hash_password("test-only-password"),
                tenant_id=tenant.id,
            )
            session.add(user)
            session.commit()
            session.refresh(user)
            token = create_token(user.id)

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        sock.listen(128)
        port = sock.getsockname()[1]
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            lifespan="off",
            log_level="warning",
            access_log=False,
        )
        server = uvicorn.Server(config)
        print(json.dumps({"url": f"http://127.0.0.1:{port}", "token": token}), flush=True)
        try:
            await server.serve(sockets=[sock])
        finally:
            app.dependency_overrides.clear()
            engine.dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
