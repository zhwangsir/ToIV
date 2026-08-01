"""NAS(绿联 DXP8800 Pro)SFTP 存储 —— 模型/生成内容集中到 NAS。

凭据经 config(环境变量 TOIV_NAS_*),不入仓库。SFTP 根 = /NAS(= NAS shell 的
/volume1/NAS);模型库 = /NAS/Windows/ComfyUI/ComfyUIModel/models,worker 从此读。
"""
from __future__ import annotations

import posixpath
import socket
from collections.abc import Callable

try:
    import paramiko
except ImportError:
    paramiko = None  # type: ignore[assignment]


from app.config import get_settings

# SFTP 连接/握手/认证超时(秒):NAS 掉线时快速失败,避免请求线程无限挂起
_CONNECT_TIMEOUT = 15.0

# 模型类型 → NAS models 子目录(与 ComfyUI 目录约定一致)
_TYPE_SUBDIR: dict[str, str] = {
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
    "diffusion_models": "diffusion_models",
    "ipadapter": "ipadapter",
    "text_encoders": "text_encoders",
    "llm": "LLM",
}


def subdir_for(model_type: str) -> str:
    """类型 → models 子目录名(未知类型原样用作子目录)。"""
    return _TYPE_SUBDIR.get(model_type.strip().lower(), model_type.strip() or "checkpoints")


def _connect() -> tuple[paramiko.SFTPClient, paramiko.Transport]:
    s = get_settings()
    if not s.nas_enabled:
        raise RuntimeError("NAS 未配置(TOIV_NAS_HOST / TOIV_NAS_PASSWORD)")
    if paramiko is None:
        raise RuntimeError("NAS 依赖 paramiko 未安装")
    host = s.nas_host.strip()
    # paramiko.Transport((host, port)) 自建 socket 且无超时,NAS 掉线时会无限挂起;
    # 这里先 socket.create_connection 带 connect timeout,再显式设 banner/auth 超时。
    try:
        sock = socket.create_connection((host, s.nas_port), timeout=_CONNECT_TIMEOUT)
    except OSError as e:
        raise RuntimeError(f"NAS 连接失败或超时({host}:{s.nas_port}): {e}") from e
    transport = paramiko.Transport(sock)
    transport.banner_timeout = _CONNECT_TIMEOUT
    transport.auth_timeout = _CONNECT_TIMEOUT
    try:
        transport.connect(username=s.nas_user, password=s.nas_password)
    except Exception as e:
        transport.close()
        raise RuntimeError(f"NAS 握手/认证失败或超时({host}:{s.nas_port}): {e}") from e
    sftp = paramiko.SFTPClient.from_transport(transport)
    if sftp is None:
        transport.close()
        raise RuntimeError("NAS SFTP 建立失败")
    return sftp, transport


def _ensure_dir(sftp: paramiko.SFTPClient, remote_dir: str) -> None:
    """mkdir -p:逐级建目录(已存在则跳过)。"""
    parts = [p for p in remote_dir.strip("/").split("/") if p]
    cur = "/"
    for p in parts:
        cur = posixpath.join(cur, p)
        try:
            sftp.stat(cur)
        except IOError:
            sftp.mkdir(cur)


def model_exists(model_type: str, filename: str) -> bool:
    """NAS models/<子目录>/<filename> 是否已存在。"""
    s = get_settings()
    remote = posixpath.join(s.nas_model_root, subdir_for(model_type), filename)
    sftp, transport = _connect()
    try:
        sftp.stat(remote)
        return True
    except IOError:
        return False
    finally:
        sftp.close()
        transport.close()


def upload_model(
    local_path: str,
    model_type: str,
    filename: str,
    on_progress: Callable[[int, int], None] | None = None,
) -> str:
    """把本地已下载的模型文件 SFTP 上传到 NAS models/<子目录>/<filename>,返回远端路径。
    先写 .part 再原子改名,避免 ComfyUI 读到半成品。"""
    s = get_settings()
    remote_dir = posixpath.join(s.nas_model_root, subdir_for(model_type))
    remote = posixpath.join(remote_dir, filename)
    remote_part = remote + ".part"
    sftp, transport = _connect()
    try:
        _ensure_dir(sftp, remote_dir)
        sftp.put(local_path, remote_part, callback=on_progress)
        try:
            sftp.remove(remote)  # 覆盖旧文件(改名不覆盖时先删)
        except IOError:
            pass
        sftp.rename(remote_part, remote)
    finally:
        sftp.close()
        transport.close()
    return remote


def check_connection() -> dict[str, object]:
    """健康检查:能否连上 + 列出 models 子目录数。"""
    s = get_settings()
    sftp, transport = _connect()
    try:
        subs = sftp.listdir(s.nas_model_root)
        return {"ok": True, "model_root": s.nas_model_root, "subdirs": len(subs)}
    finally:
        sftp.close()
        transport.close()
