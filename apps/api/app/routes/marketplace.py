"""模型市场代理 —— 服务端转发 Civitai / HuggingFace 搜索(避免 CORS,密钥留服务端)。

下载落地经 worker 上的 ComfyUI-Manager:api 容器可达 .100,故在请求时运行时探测
其安装端点(版本不同 → 逐个回退),据响应判定是否受理,绝不静默吞错。
"""
from __future__ import annotations

import os
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.comfy.pool import WorkerPool
from app.deps import get_current_user, get_pool
from app.models import User

router = APIRouter()

# Civitai 走可达镜像 civitai.red(civitai.com 在 CN 被墙);可用 env 覆盖。
# NSFW/成人模型需 API key 鉴权才能搜到/下载;key 走 env(TOIV_CIVITAI_API_KEY),不入仓库。
_CIVITAI = os.environ.get("TOIV_CIVITAI_API_BASE", "https://civitai.red/api/v1/models")
_CIVITAI_WEB = os.environ.get("TOIV_CIVITAI_WEB_BASE", "https://civitai.red")
_CIVITAI_KEY = os.environ.get("TOIV_CIVITAI_API_KEY", "")
_HF = "https://huggingface.co/api/models"
_HEADERS = {"User-Agent": "ToIV/0.1 (+https://github.com/zhwangsir/ToIV)"}


async def _get_json(url: str, params: dict, headers: dict | None = None):
    h = {**_HEADERS, **(headers or {})}
    async with httpx.AsyncClient(timeout=20.0, headers=h) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()


def _civitai_item(it: dict) -> dict:
    thumb = None
    for version in it.get("modelVersions") or []:
        for img in version.get("images") or []:
            if img.get("url") and img.get("type", "image") == "image":
                thumb = img["url"]
                break
        if thumb:
            break
    return {
        "id": str(it.get("id")),
        "name": it.get("name"),
        "type": it.get("type"),
        "creator": (it.get("creator") or {}).get("username"),
        "thumbnail": thumb,
        "downloads": (it.get("stats") or {}).get("downloadCount"),
        "url": f"{_CIVITAI_WEB}/models/{it.get('id')}",
        "source": "civitai",
    }


def _hf_item(it: dict) -> dict:
    repo = it.get("id") or it.get("modelId") or ""
    return {
        "id": repo,
        "name": repo,
        "type": it.get("pipeline_tag") or "model",
        "creator": it.get("author") or (repo.split("/")[0] if "/" in repo else None),
        "thumbnail": None,
        "downloads": it.get("downloads"),
        "url": f"https://huggingface.co/{repo}",
        "source": "huggingface",
    }


@router.get("/marketplace/search")
async def search(
    source: str = Query(default="civitai"),
    query: str = "",
    type: str | None = None,
    nsfw: str = Query(default="false"),
    user: User = Depends(get_current_user),
) -> dict:
    # R18 软门槛:nsfw 参数仅当用户已开 R18 时才生效,否则服务端强制 "false"。
    effective_nsfw = nsfw if user.nsfw_enabled else "false"
    try:
        if source == "civitai":
            params: dict = {"limit": 24, "sort": "Most Downloaded", "nsfw": effective_nsfw}
            if query:
                params["query"] = query
            if type:
                params["types"] = type
            headers = {"Authorization": f"Bearer {_CIVITAI_KEY}"} if _CIVITAI_KEY else None
            data = await _get_json(_CIVITAI, params, headers)
            items = [_civitai_item(i) for i in data.get("items", [])]
        elif source == "huggingface":
            params = {"limit": 24, "sort": "downloads", "direction": -1}
            if query:
                params["search"] = query
            data = await _get_json(_HF, params)
            rows = data if isinstance(data, list) else []
            items = [_hf_item(i) for i in rows]
        else:
            raise HTTPException(status_code=400, detail="未知模型来源")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"模型市场请求失败: {e}") from e
    return {"items": items, "source": source}


# --------------------------------------------------------------------------- #
# 模型安装落地 —— 经 worker 上的 ComfyUI-Manager
# --------------------------------------------------------------------------- #

# 允许的下载来源主机白名单(防 SSRF / 任意写):仅这些域名的直链可下载。
# civitai.red 是 civitai.com 的可达镜像;hf-mirror 是 huggingface 的国内镜像。
_ALLOWED_DOWNLOAD_HOSTS: frozenset[str] = frozenset(
    {
        "civitai.com",
        "civitai.red",
        "huggingface.co",
        "hf-mirror.com",
    }
)

# 允许的模型类型(枚举),同时映射到 ComfyUI 默认子目录名。
# ComfyUI-Manager 的 save_path 用 "default" 时由其按 type 自行落到对应目录。
_MODEL_TYPE_SUBDIR: dict[str, str] = {
    "checkpoint": "checkpoints",
    "checkpoints": "checkpoints",
    "lora": "loras",
    "loras": "loras",
    "vae": "vae",
    "controlnet": "controlnet",
    "upscale": "upscale_models",
    "upscale_models": "upscale_models",
    "embedding": "embeddings",
    "embeddings": "embeddings",
    "clip": "clip",
    "clip_vision": "clip_vision",
    "unet": "unet",
    "diffusion_model": "diffusion_models",
    "diffusion_models": "diffusion_models",
    "ipadapter": "ipadapter",
    "ipadapter_models": "ipadapter",
}

# ComfyUI-Manager 各版本的安装端点,按优先级探测;命中即用,端点缺失则回退下一个。
# 现代版:install_model(入队)+ start(开始处理);老版:单步 model/install。
_INSTALL_ENDPOINTS: tuple[str, ...] = (
    "/model/install",
    "/manager/queue/install",
    "/externalmodel/install",
    "/manager/queue/install_model",
)
# 端点不存在的状态码:据此回退到下一个候选(而非把它当真正的失败)。
_ENDPOINT_ABSENT = frozenset({404, 405, 501})
_INSTALL_TIMEOUT = 30.0


class InstallRequest(BaseModel):
    """模型安装入参。url 与 (source,id) 二选一;type 必填且限枚举。"""

    type: str
    url: str | None = None
    source: str | None = None
    id: str | None = None
    name: str | None = None
    filename: str | None = None
    base: str | None = None


def _validate_download_url(url: str) -> str:
    """校验直链:必须是 http(s) 且主机在白名单内(防 SSRF / 任意写)。返回规整后的 url。"""
    parsed = urlsplit(url.strip())
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="模型下载链接必须是 http(s)")
    host = (parsed.hostname or "").lower()
    if not host:
        raise HTTPException(status_code=400, detail="模型下载链接缺少主机名")
    # 命中白名单主机或其子域(如 cdn.civitai.com)才放行。
    allowed = any(
        host == h or host.endswith(f".{h}") for h in _ALLOWED_DOWNLOAD_HOSTS
    )
    if not allowed:
        raise HTTPException(
            status_code=400,
            detail=f"下载来源 {host} 不在白名单内(仅允许 Civitai / HuggingFace 及其镜像)",
        )
    return parsed.geturl()


def _build_model_item(req: InstallRequest) -> dict:
    """据入参组装 ComfyUI-Manager 期望的模型条目;同时完成 type/url/source 校验。"""
    model_type = req.type.strip().lower()
    if model_type not in _MODEL_TYPE_SUBDIR:
        allowed = ", ".join(sorted(set(_MODEL_TYPE_SUBDIR))) or "(无)"
        raise HTTPException(
            status_code=400, detail=f"未知模型类型 {req.type!r};允许:{allowed}"
        )

    if req.source is not None:
        if req.source not in ("civitai", "huggingface"):
            raise HTTPException(status_code=400, detail="未知模型来源")

    download_url: str
    if req.url:
        download_url = _validate_download_url(req.url)
    elif req.source == "huggingface" and req.id:
        # HuggingFace 仓库 → 走 hf 域;具体文件名由 filename 指定。
        if not req.filename:
            raise HTTPException(
                status_code=400, detail="HuggingFace 安装需提供 filename(仓库内文件名)"
            )
        repo = req.id.strip().strip("/")
        download_url = _validate_download_url(
            f"https://huggingface.co/{repo}/resolve/main/{req.filename}"
        )
    else:
        raise HTTPException(
            status_code=400, detail="缺少安装目标:需提供 url,或 (source=huggingface, id, filename)"
        )

    filename = (req.filename or os.path.basename(urlsplit(download_url).path) or "").strip()
    if not filename:
        raise HTTPException(status_code=400, detail="无法确定模型文件名,请显式提供 filename")
    name = (req.name or filename).strip()
    base = (req.base or "").strip()

    # ComfyUI-Manager 模型条目结构(install_model / model/install 通用键)。
    return {
        "name": name,
        "type": model_type,
        "base": base,
        # 用 type 对应的相对子目录(取自固定枚举、非用户绝对路径 → 仍防任意写),
        # 比 "default" 对 ipadapter 等非常规类型路由更可靠。
        "save_path": _MODEL_TYPE_SUBDIR[model_type],
        "filename": filename,
        "url": download_url,
        "description": f"installed via ToIV marketplace ({req.source or 'direct'})",
        "reference": req.url or download_url,
    }


def _is_accepted(resp: httpx.Response) -> bool:
    """判定 Manager 是否受理安装(2xx 视为受理;响应体里显式 false 视为拒绝)。"""
    if resp.status_code >= 300:
        return False
    try:
        body = resp.json()
    except ValueError:
        return True  # 非 JSON 的 2xx(如纯文本 "ok")也算受理
    if isinstance(body, dict):
        result = body.get("result")
        if result is False or body.get("success") is False:
            return False
    return True


async def _try_install(client: httpx.AsyncClient, base_url: str, item: dict) -> dict:
    """对一台 worker 逐个探测安装端点;命中受理即返回结果,绝不静默吞错。"""
    errors: list[str] = []
    for path in _INSTALL_ENDPOINTS:
        try:
            resp = await client.post(f"{base_url}{path}", json=item)
        except httpx.HTTPError as e:
            errors.append(f"{path}: 连接失败 {e}")
            continue
        if _is_accepted(resp):
            # 受理成功;现代版入队后需显式 start 触发处理(老版单步端点无 start,失败可忽略)。
            await _maybe_start_queue(client, base_url, path)
            return {
                "accepted": True,
                "endpoint": path,
                "worker": base_url,
                "status_code": resp.status_code,
                "message": _response_detail(resp),
            }
        # 端点不存在(404/405/501)或服务器内部错(5xx)→ 换下一个端点试。
        # (不同 Manager 版本可用端点不同;某端点 500/404 不代表其它端点也不行。)
        if resp.status_code in _ENDPOINT_ABSENT or resp.status_code >= 500:
            errors.append(f"{path} → {resp.status_code}: {_response_detail(resp)}")
            continue
        # 其它(4xx 明确拒绝,如 403 安全级别 / 400)→ 定性拒绝,透传真因,不再回退掩盖。
        raise HTTPException(
            status_code=502,
            detail=f"ComfyUI-Manager 拒绝安装({path} → {resp.status_code}): {_response_detail(resp)}",
        )
    raise HTTPException(
        status_code=502,
        detail="ComfyUI-Manager 未提供可用安装端点;探测记录:" + " | ".join(errors),
    )


async def _maybe_start_queue(client: httpx.AsyncClient, base_url: str, path: str) -> None:
    """队列式端点(install_model / queue/install)入队后需 start 才开始处理;尽力而为。"""
    if "queue" not in path:
        return
    try:
        await client.post(f"{base_url}/manager/queue/start")
    except httpx.HTTPError:
        pass  # start 失败不影响"已受理"的事实,状态可经 /status 查询


def _response_detail(resp: httpx.Response) -> str:
    """从 worker 响应提取人类可读信息(JSON 优先,回退原文本,截断防刷屏)。"""
    try:
        body = resp.json()
        text = str(body)
    except ValueError:
        text = resp.text
    text = (text or "").strip()
    return text[:500] if text else f"HTTP {resp.status_code}"


async def _pick_install_worker(pool: WorkerPool) -> str:
    """在 worker 池里选一台可达 worker 返回其 base_url;全不可达则 502。"""
    try:
        client = await pool.pick()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"没有可用的 worker: {e}") from e
    base_url = getattr(client, "base_url", None)
    if not base_url:
        raise HTTPException(status_code=502, detail="worker 缺少 base_url,无法安装")
    return base_url


async def _match_catalog_entry(
    client: httpx.AsyncClient, base_url: str, req: InstallRequest
) -> dict | None:
    """在 worker 的 ComfyUI-Manager 策展目录里按文件名匹配模型条目。

    关键:V3.x 的 install_model 有白名单校验(check_whitelist_for_model),只接受
    其策展目录(model-list)里的条目。任意构造的条目会被 400 拒绝。故先查目录、
    按文件名匹配,命中则用**目录原条目**(save_path/base/url 都对)→ 过白名单。
    """
    target = (req.filename or "").strip()
    if not target and req.url:
        target = req.url
    target = os.path.basename(urlsplit(target).path if "://" in target else target).strip().lower()
    if not target:
        return None
    for mode in ("cache", "local"):
        try:
            resp = await client.get(f"{base_url}/externalmodel/getlist?mode={mode}")
            if resp.status_code >= 300:
                continue
            data = resp.json()
        except (httpx.HTTPError, ValueError):
            continue
        models = data.get("models") if isinstance(data, dict) else data
        for m in models or []:
            if not isinstance(m, dict):
                continue
            fn = os.path.basename(str(m.get("filename") or m.get("url") or "")).strip().lower()
            if fn and fn == target:
                return {
                    k: m.get(k, "")
                    for k in ("name", "type", "base", "save_path", "filename", "url", "reference", "description")
                }
    return None


@router.post("/marketplace/install")
async def install(
    req: InstallRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
) -> dict:
    """把搜到的模型经某台 worker 的 ComfyUI-Manager 装到 ComfyUI 集群。

    入参 url 与 (source,id[,filename]) 二选一;type 限枚举。来源主机走白名单防 SSRF。
    逻辑:挑一台可达 worker →(先匹配 Manager 策展目录原条目,过白名单)→ 逐个探测
    安装端点(版本不同 → 回退)→ 据响应判定受理。
    """
    item = _build_model_item(req)  # 校验入参(type 枚举 / url 白名单)
    base_url = await _pick_install_worker(pool)
    async with httpx.AsyncClient(timeout=_INSTALL_TIMEOUT, headers=_HEADERS) as client:
        catalog = await _match_catalog_entry(client, base_url, req)
        install_item = catalog or item
        try:
            result = await _try_install(client, base_url, install_item)
        except HTTPException as e:
            if catalog is None:
                raise HTTPException(
                    status_code=e.status_code,
                    detail=f"{e.detail}(注:该模型未匹配到 ComfyUI-Manager 策展目录;"
                    "非目录模型需直接下载到 worker 的 models 目录,见 deploy/download-model.py)",
                ) from e
            raise
    return {**result, "model": install_item, "from_catalog": catalog is not None}


@router.get("/marketplace/install/status")
async def install_status(
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
) -> dict:
    """转发 ComfyUI-Manager 的安装队列进度(若 worker 提供该端点)。"""
    base_url = await _pick_install_worker(pool)
    async with httpx.AsyncClient(timeout=_INSTALL_TIMEOUT, headers=_HEADERS) as client:
        try:
            resp = await client.get(f"{base_url}/manager/queue/status")
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"查询安装进度失败: {e}") from e
        if resp.status_code in _ENDPOINT_ABSENT:
            raise HTTPException(
                status_code=501, detail="该 worker 的 ComfyUI-Manager 不支持进度查询端点"
            )
        if resp.status_code >= 300:
            raise HTTPException(
                status_code=502,
                detail=f"查询安装进度失败({resp.status_code}): {_response_detail(resp)}",
            )
        try:
            body = resp.json()
        except ValueError:
            body = {"raw": resp.text}
    return {"worker": base_url, "status": body}
