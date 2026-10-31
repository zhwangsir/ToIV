"""音频工具端点 —— 音频板块「编辑」区(M2)。

POST /api/audio/separate       上传音频 → Demucs 人声分离 → vocals wav(落音频产物根目录)
GET  /api/audio/files/{name}   回读音频产物(分离结果下载/试听)

产物落位:优先 TOIV_AUDIO_DIR(NAS /mnt/toiv-nas/toiv/outputs/audio);
NAS 不可达/不可写时自动降级本地回退目录(storage.content_subdir("audio")),不 500。
Job 落库与作品库同一套:kind="audio_sep"、status 直接 done、
result = 产物下载 URL 列表(JSON),经 GET /api/jobs 回读。
"""
from __future__ import annotations

import json
import logging
import re
import uuid
import wave
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from fastapi.responses import Response
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user
from app.models import Job, User
from app.pathsafe import PathTraversalError, validate_path_component
from app.ratelimit import enforce_generation_rate_limit
from app.routes.images import _ranged_response
from app.services.audio_sep import separate_vocals
from app.storage import audio_output_root, content_subdir

logger = logging.getLogger(__name__)

router = APIRouter()

_ALLOWED_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}
_MAX_BYTES = 50 * 1024 * 1024  # 50MB
_OUT_NAME_RE = re.compile(r"^audiosep-[0-9a-f]{32}\.wav$")


def _wav_duration(path: Path) -> float | None:
    """读 wav 时长(秒);非可解析 wav 时返回 None(不阻断)。"""
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / float(w.getframerate() or 1), 3)
    except (wave.Error, OSError):
        return None


def _validate_upload_name(filename: str | None) -> str:
    """上传文件名沙箱校验:必须是纯文件名(禁路径/穿越)且扩展名受支持。"""
    if not filename:
        raise HTTPException(status_code=400, detail="缺少文件名")
    try:
        name = validate_path_component(filename)
    except PathTraversalError as e:
        raise HTTPException(status_code=400, detail=f"非法文件名:{e}") from e
    if name != filename:
        raise HTTPException(status_code=400, detail="非法文件名(含路径成分)")
    if Path(name).suffix.lower() not in _ALLOWED_EXTS:
        raise HTTPException(
            status_code=422,
            detail=f"不支持的音频格式(允许:{'/'.join(sorted(_ALLOWED_EXTS))})",
        )
    return name


def _write_output(vocals: bytes) -> tuple[Path, str]:
    """产物写音频产物根目录(NAS 优先);根目录不可建/不可写时降级本地回退目录。

    返回 (产物路径, 产物文件名)。降级只换目录,文件名与回读 URL 不变
    (GET /audio/files 按名字在两个目录依次找)。
    """
    name = f"audiosep-{uuid.uuid4().hex}.wav"
    root = audio_output_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
        out = root / name
        out.write_bytes(vocals)
        return out, name
    except OSError as e:
        logger.warning("音频产物根目录不可写(%s),降级本地回退目录:%s", root, e)
        fallback = content_subdir("audio")
        fallback.mkdir(parents=True, exist_ok=True)
        out = fallback / name
        out.write_bytes(vocals)
        return out, name


@router.post("/audio/separate")
async def audio_separate(
    file: UploadFile,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    request: Request = None  # FastAPI 注入;勿标 Optional 否则当 Pydantic 字段,
) -> dict[str, object]:
    """上传音频 → 人声分离 → vocals wav。同步返回产物 URL,并建 Job(kind=audio_sep)入作品库。

    降级纪律:分离服务未配置/不可达 → 503/502 带清晰原因(见 services.audio_sep);
    NAS 产物目录不可写 → 自动降级本地回退目录,不 500。
    """
    enforce_generation_rate_limit(user)
    src_name = _validate_upload_name(file.filename)
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")
    if len(content) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="音频过大(上限 50MB)")

    vocals = await separate_vocals(content, filename=src_name, request=request)
    out, out_name = _write_output(vocals)
    url = f"/api/audio/files/{out_name}"

    # Job 落库与 ACE/txt2img 同一套作品库回读机制:
    # status 直接 done(同步管线无后台态),result = 产物下载 URL 列表(JSON)。
    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=uuid.uuid4().hex,
            worker="",
            kind="audio_sep",
            status="done",
            prompt=src_name,
            params=json.dumps({"filename": src_name}, ensure_ascii=False),
            result=json.dumps([url], ensure_ascii=False),
        )
    )
    session.commit()

    return {"url": url, "duration_sec": _wav_duration(out)}


@router.get("/audio/files/{name}")
async def get_audio_file(
    name: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> Response:
    """回读音频产物(人声分离结果)。按名字在 NAS 根目录与本地回退目录依次找。

    手动 Range 支持:<audio> 试听/拖动必须 206 Partial + Accept-Ranges;
    产物上限 50MB,整段读入内存后切片返回(与 /api/images 同一套 _ranged_response)。
    """
    if not _OUT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    for root in (audio_output_root(), content_subdir("audio")):
        try:
            path = root / name
            if path.is_file():
                return _ranged_response(
                    path.read_bytes(), "audio/wav", request.headers.get("range")
                )
        except OSError as e:
            logger.warning("音频产物目录不可达(%s):%s", root, e)
    raise HTTPException(status_code=404, detail="音频产物不存在")
