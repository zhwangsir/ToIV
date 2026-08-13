"""FastAPI 应用装配。"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import bootstrap_admin, init_db
from app.logging_config import setup_logging
from app.routes import (
    account,
    admin,
    agent,
    agents,
    animatic,
    assembly,
    audio,
    audio_tools,
    avatar_studio,
    backlot,
    cad,
    drama_analytics,
    dub,
    dub_anime,
    dub_text,
    dub_voice,
    drama_studio,
    drama_skills,
    documents,
    nas_models,
    auth,
    forge,
    generate,
    h3_studio,
    images,
    jobs,
    lipsync,
    longcat_studio,
    ltx_studio,
    manju,
    manju_project,
    marketplace,
    models,
    optimize,
    reference_assets,
    reverse,
    score,
    studio,
    system,
    threed,
    train,
    upload,
    video,
    video_edit,
    voice,
    wan_studio,
    workflows,
    opentalking,
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
    # 短剧后台任务收口:generating 分镜重挂/标 error、中断的 autorun/批量精修标 interrupted
    drama_studio.reconcile_interrupted()
    # GPU 生成链路每日冒烟(txt2img 小图 + LTX 短视频),失败经 webhook 报警
    from app.config import get_settings as _gs
    from app.services.gpu_smoke import daily_smoke_loop, smoke_report_dir

    _settings = _gs()
    smoke_task = (
        asyncio.create_task(
            daily_smoke_loop(
                hour=_settings.gpu_smoke_hour,
                report_dir=smoke_report_dir(),
                webhook_url=_settings.smoke_alert_webhook,
            )
        )
        if _settings.gpu_smoke_enabled
        else None
    )
    try:
        yield
    finally:
        reconcile_task.cancel()
        if smoke_task is not None:
            smoke_task.cancel()
        # 统一关闭 ComfyUI HTTP 连接池缓存的 AsyncClient
        from app.comfy.client import close_clients

        await close_clients()


def create_app() -> FastAPI:
    settings = get_settings()

    # 统一日志配置必须在一切 app 日志之前:此前 root 无 handler,
    # 35 个模块的 INFO 日志在生产被静默丢弃(2026-08-12 真机证实)。
    setup_logging(settings.log_level)

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

    # API 文档按环境门控(QA-FULL-2026-08-11 P2):生产暴露 /docs /redoc /openapi.json
    # 等于公开完整攻击面地图;本地开发在 .env 置 TOIV_EXPOSE_API_DOCS=true 开启。
    app = FastAPI(
        title="ToIV API",
        version="0.0.1",
        lifespan=lifespan,
        docs_url="/docs" if settings.expose_api_docs else None,
        redoc_url="/redoc" if settings.expose_api_docs else None,
        openapi_url="/openapi.json" if settings.expose_api_docs else None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,  # 前端需带 Cookie/JWT 跨域;CORS 规范要求 credentials=True 时 origins 必须是精确域名，禁止 "*"
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 安全响应头(QA-FULL-2026-08-11 P2,六项):API 只产 JSON/文件,统一最严白名单。
    # 页面侧(前端 :3100)播放产物走的是 <video>/fetch 子资源加载,受页面自身 CSP 约束,
    # 资源响应上的 CSP 不影响;直开产物 URL 的浏览器内置播放器也不受其管辖。
    # HSTS 仅在 https(反代终结 TLS 后带 X-Forwarded-Proto)时下发,避免污染本地 http 开发。
    @app.middleware("http")
    async def _security_headers_mw(request, call_next):
        response = await call_next(request)
        h = response.headers
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("X-Frame-Options", "DENY")
        h.setdefault("Referrer-Policy", "no-referrer")
        h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        h.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        if request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https":
            h.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response

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

    # 全局未处理异常兜底:带请求上下文(method+path)落 ERROR 日志,
    # 返回统一 500 JSON(不泄露内部细节)。HTTPException 走自身 handler 不受影响;
    # ServerErrorMiddleware 处理后仍会 re-raise,uvicorn.error 的 traceback 保留。
    @app.exception_handler(Exception)
    async def _unhandled_exc_handler(request: Request, exc: Exception) -> JSONResponse:
        logging.getLogger("toiv.unhandled").exception(
            "未处理异常 %s %s", request.method, request.url.path
        )
        return JSONResponse(status_code=500, content={"detail": "服务器内部错误"})

    for module in (
        auth,
        account,
        admin,
        models,
        marketplace,
        generate,
        score,
        video,
        video_edit,
        threed,
        audio,
        audio_tools,
        agent,
        agents,
        optimize,
        reference_assets,
        reverse,
        animatic,
        manju,
        manju_project,
        assembly,
        voice,
        lipsync,
        dub,
        dub_anime,
        dub_text,
        dub_voice,
        drama_studio,
        drama_skills,
        documents,
        nas_models,
        cad,
        drama_analytics,
        forge,
        system,
        studio,
        upload,
        jobs,
        images,
        train,
        backlot,
        workflows,
        opentalking,
        ltx_studio,
        h3_studio,
        longcat_studio,
        avatar_studio,
        wan_studio,
    ):
        app.include_router(module.router, prefix="/api")

    return app


app = create_app()
