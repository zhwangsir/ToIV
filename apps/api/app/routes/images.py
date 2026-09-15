"""GET /api/images —— 代理 ComfyUI /view。

取图韧性:产物由"生成它的那个 worker"写在本机输出目录,而同机(同 host)的其它
worker 共享同一目录。因此主 worker 掉线时,自动回退到同机存活的 worker 代取,
避免"worker 一死、已生成的图/视频就取不回"(此前的 502)。
"""
from __future__ import annotations

import hmac
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlmodel import Session, select

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import image_sig
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.pathsafe import PathTraversalError, validate_path_component

router = APIRouter()

# 音频/3D 产物扩展名 → content-type:ComfyUI /view 对非图片可能回落默认 image/png,
# 浏览器 <audio> 拿到 image/* 会拒播,GLB 需要 model/* 才能被预览器/下载器正确识别。
_EXTRA_CONTENT_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".glb": "model/gltf-binary",
}


def _host(url: str) -> str:
    return urlsplit(url).hostname or url


def _ranged_response(content: bytes, content_type: str, range_header: str | None) -> Response:
    """按 HTTP Range 返回。视频 <video> 必须拿 206 Partial + Accept-Ranges 才能播/拖动;
    裸 200 无 Accept-Ranges 会让浏览器媒体元素报 error 4(SRC_NOT_SUPPORTED)。
    产物已整段在内存,这里切片返回即可(体积不大);始终带 Accept-Ranges 声明支持 range。"""
    total = len(content)
    # private:产物有归属(签名/归属校验通过才到这里),public 语义会让共享缓存越权复用
    base = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400"}
    if range_header and range_header.strip().startswith("bytes="):
        first = range_header.strip()[6:].split(",", 1)[0].strip()
        start_s, _, end_s = first.partition("-")
        try:
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else total - 1
        except ValueError:
            start, end = 0, total - 1
        start = max(0, start)
        end = min(end, total - 1)
        if start > end or start >= total:
            return Response(status_code=416, headers={**base, "Content-Range": f"bytes */{total}"})
        chunk = content[start : end + 1]
        return Response(
            content=chunk,
            status_code=206,
            media_type=content_type,
            headers={**base, "Content-Range": f"bytes {start}-{end}/{total}"},
        )
    return Response(content=content, media_type=content_type, headers=base)


@router.get("/images")
async def get_image(
    request: Request,
    filename: str,
    subfolder: str = "",
    type_: str = Query(default="output", alias="type"),
    worker: str = Query(...),
    sig: str = Query(default=""),
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    try:
        safe_filename = validate_path_component(filename, allow_subdirs=False)
        safe_subfolder = validate_path_component(subfolder, allow_subdirs=True) if subfolder else ""
    except PathTraversalError as e:
        raise HTTPException(status_code=400, detail=f"非法路径: {e}") from e

    if not safe_filename:
        raise HTTPException(status_code=400, detail="filename 不能为空")

    # 归属校验(IDOR 防护,顺序文件名可枚举他人产物):
    # - 有 sig:HMAC 覆盖全部定位参数,匹配即放行(签名即能力,无 DB 往返);
    # - 无 sig(旧库 URL):回退 DB 归属查询,本人/同租户 Job 的产物才放行;admin 直接放行。
    # 不通过统一 404,不泄露产物存在性。
    if sig:
        expected = image_sig(filename, subfolder, type_, worker)
        if not hmac.compare_digest(sig.encode(), expected.encode()):
            raise HTTPException(status_code=404, detail="产物不存在")
    elif user.role != "admin":
        owns = db.exec(
            select(Job.id)
            .where(Job.result.like(f"%filename={filename}%"))
            .where((Job.user_id == user.id) | (Job.tenant_id == user.tenant_id))
        ).first()
        if not owns:
            raise HTTPException(status_code=404, detail="产物不存在")

    primary = resolve_worker(worker)  # SSRF 白名单校验
    host = _host(primary.base_url)
    # 同机其它 worker 共享同一输出目录,可作为主 worker 掉线时的回退
    siblings = [
        c for c in pool.clients
        if _host(c.base_url) == host and c.base_url != primary.base_url
    ]
    last_err: Exception | None = None
    for client in [primary, *siblings]:
        try:
            content, content_type = await client.get_image_bytes(safe_filename, safe_subfolder, type_)
            # 音频/3D 产物按扩展名修正 content-type(/view 可能给默认 image/png)
            content_type = _EXTRA_CONTENT_TYPES.get(Path(safe_filename).suffix.lower(), content_type)
            # 视频/图片统一走 range 感知返回:视频靠 206+Accept-Ranges 才能播
            # (_ranged_response 自带 Cache-Control: private 1d)
            return _ranged_response(content, content_type, request.headers.get("range"))
        except ComfyUIError as e:
            last_err = e
    raise HTTPException(status_code=502, detail=f"产物暂不可取(同机 worker 均不可达): {last_err}")


# ── 缩略图(2026-09-15 作品库性能):同鉴权,原图取回后 Pillow 缩放,落盘缓存 ──
import asyncio  # noqa: E402
import hashlib  # noqa: E402
import io as _io  # noqa: E402
import os as _os  # noqa: E402

_THUMB_W = 360
_THUMB_DIR = Path(
    _os.environ.get("TOIV_THUMB_CACHE", str(Path(__file__).resolve().parents[2] / ".thumbcache"))
)
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v", ".mkv"}
_THUMB_CACHE_HEADERS = {"Cache-Control": "private, max-age=604800"}  # 7d:签名 URL 内容不可变


async def _video_poster(content: bytes, cache_path: Path) -> bytes | None:
    """视频海报:ffmpeg 抽 1s 处帧(避开首帧黑场),缩到 360px JPEG,落盘缓存。

    失败(无 ffmpeg/坏片/超时)返回 None,调用方回退原图,绝不 5xx。
    """
    import tempfile

    def _extract() -> bytes | None:
        with tempfile.TemporaryDirectory(prefix="vidthumb") as td:
            src = Path(td) / "in.bin"
            src.write_bytes(content)
            out = Path(td) / "poster.jpg"
            import subprocess

            for _try in range(2):  # 1s 处失败(超短片)退首帧
                proc = subprocess.run(
                    ["ffmpeg", "-y", "-loglevel", "error", "-ss", "1" if _try == 0 else "0",
                     "-i", str(src), "-frames:v", "1", "-vf", f"scale={_THUMB_W}:-2", "-q:v", "5",
                     str(out)],
                    capture_output=True, timeout=60,
                )
                if proc.returncode == 0 and out.exists() and out.stat().st_size > 0:
                    return out.read_bytes()
            return None

    try:
        if cache_path.exists():
            return cache_path.read_bytes()
        poster = await asyncio.to_thread(_extract)
        if poster is None:
            return None
        try:
            _THUMB_DIR.mkdir(parents=True, exist_ok=True)
            tmp = cache_path.with_suffix(".tmp")
            tmp.write_bytes(poster)
            tmp.replace(cache_path)
        except OSError:
            pass
        return poster
    except Exception:  # noqa: BLE001 — 海报失败不阻塞响应
        return None


@router.get("/images/thumb")
async def get_image_thumb(
    filename: str,
    subfolder: str = "",
    type_: str = Query(default="output", alias="type"),
    worker: str = Query(...),
    sig: str = Query(default=""),
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """作品库网格缩略图:360px WebP,磁盘缓存(键=内容 hash);非图片产物直接回原图。"""
    try:
        safe_filename = validate_path_component(filename, allow_subdirs=False)
        safe_subfolder = validate_path_component(subfolder, allow_subdirs=True) if subfolder else ""
    except PathTraversalError as e:
        raise HTTPException(status_code=400, detail=f"非法路径: {e}") from e
    if not safe_filename:
        raise HTTPException(status_code=400, detail="filename 不能为空")

    # 与 /images 完全同款的鉴权(sig 能力优先,DB 归属回退)
    if sig:
        expected = image_sig(filename, subfolder, type_, worker)
        if not hmac.compare_digest(sig.encode(), expected.encode()):
            raise HTTPException(status_code=404, detail="产物不存在")
    elif user.role != "admin":
        owns = db.exec(
            select(Job.id)
            .where(Job.result.like(f"%filename={filename}%"))
            .where((Job.user_id == user.id) | (Job.tenant_id == user.tenant_id))
        ).first()
        if not owns:
            raise HTTPException(status_code=404, detail="产物不存在")

    def _cache_path(content: bytes) -> Path:
        h = hashlib.sha256(f"{safe_filename}|{len(content)}".encode()).hexdigest()[:32]
        return _THUMB_DIR / f"{h}.webp"

    # 缓存命中则无需访问 worker(键含文件名字段但未含内容——同一 filename 重跑会覆盖,
    # 故退化为:命中即用,未命中才取原图。网格缩略图允许这一近似。)
    approx = _THUMB_DIR / (hashlib.sha256(f"t|{safe_filename}".encode()).hexdigest()[:32] + ".webp")
    if approx.exists():
        return Response(content=approx.read_bytes(), media_type="image/webp",
                        headers=_THUMB_CACHE_HEADERS)

    primary = resolve_worker(worker)
    host = _host(primary.base_url)
    siblings = [c for c in pool.clients if _host(c.base_url) == host and c.base_url != primary.base_url]
    content: bytes | None = None
    content_type = "image/png"
    last_err: Exception | None = None
    for client in [primary, *siblings]:
        try:
            content, content_type = await client.get_image_bytes(safe_filename, safe_subfolder, type_)
            break
        except ComfyUIError as e:
            last_err = e
    if content is None:
        raise HTTPException(status_code=502, detail=f"产物暂不可取(同机 worker 均不可达): {last_err}")

    if Path(safe_filename).suffix.lower() not in _IMAGE_EXTS:
        # 视频:ffmpeg 抽 1s 处帧做海报(网格只拉 15KB 小图,不再挂 <video> 拉原片);
        # 抽帧失败/音频/3D 回原图(旧行为兜底)
        if Path(safe_filename).suffix.lower() in _VIDEO_EXTS:
            vposter = _THUMB_DIR / (hashlib.sha256(f"tv|{safe_filename}".encode()).hexdigest()[:32] + ".jpg")
            poster = await _video_poster(content, vposter)
            if poster is not None:
                return Response(
                    content=poster, media_type="image/jpeg",
                    headers=_THUMB_CACHE_HEADERS,
                )
        return _ranged_response(content, content_type, None)

    def _make() -> bytes:
        from PIL import Image

        im = Image.open(_io.BytesIO(content))
        im = im.convert("RGB") if im.mode not in ("RGB", "L") else im
        w, h = im.size
        if w > _THUMB_W:
            im = im.resize((_THUMB_W, max(1, round(h * _THUMB_W / w))))
        buf = _io.BytesIO()
        im.save(buf, format="WEBP", quality=78, method=4)
        return buf.getvalue()

    webp = await asyncio.to_thread(_make)
    try:
        _THUMB_DIR.mkdir(parents=True, exist_ok=True)
        tmp = approx.with_suffix(".tmp")
        tmp.write_bytes(webp)
        tmp.replace(approx)
    except OSError:
        pass  # 缓存写失败不影响返回
    return Response(content=webp, media_type="image/webp", headers=_THUMB_CACHE_HEADERS)
