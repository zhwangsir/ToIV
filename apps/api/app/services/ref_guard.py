"""参考 URL 安全守卫(C1b 逆向安全)。

口径(与 deps.resolve_worker 的白名单思路一致,不新造全局私网放行):
- 裸文件路径一律拒绝(历史上 `Path(u).is_file()` 可读任意本地文件);
- 站内 `/api/studio/files/{name}` 只允许受控根目录直读(拒绝路径分隔/点文件);
- `/api/images?worker=…` 的 worker 必须经 `deps.resolve_worker` 白名单校验
  (调用方负责,本模块不构造 ComfyUIClient);
- 公网 http(s) 媒体是正当远程参考用途,予以保留,但默认拒绝私网/环回/链路本地/
  保留/未指定地址,且拒绝 URL userinfo;主机名先解析再判定(防 DNS 指向内网),
  仅 `Settings.ref_fetch_allowed_hosts` 显式配置的主机可放行内网目标。
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from pathlib import Path
from urllib.parse import urlsplit


class RefUrlError(ValueError):
    """参考 URL 未通过安全校验。"""


def studio_ref_roots() -> list[Path]:
    """站内参考文件受控根目录(与 pipeline_c_render 原口径一致)。"""
    import os

    from app.storage import drama_output_root

    return [
        drama_output_root() / "studio",
        Path(os.environ.get("TOIV_DRAMA_VIDEO_DIR", "")) / "studio",
        Path("/mnt/toiv-nas/toiv/outputs/drama/final/studio"),
        Path("/home/merlin/toiv/tmp/h3_long_exp/assets"),
    ]


def read_studio_ref_file(name: str) -> bytes | None:
    """站内 `/api/studio/files/{name}` 直读磁盘;非法名/不存在返回 None。

    兼容样片原名(无 sample_ 前缀)。拒绝任何含路径分隔或点开头的名字。
    """
    name = (name or "").strip()
    if not name or name.startswith(".") or "/" in name or "\\" in name:
        return None
    roots = studio_ref_roots()
    for root in roots:
        try:
            path = root / name
        except Exception:
            continue
        if path.is_file():
            data = path.read_bytes()
            if data:
                return data
    alt = name.replace("sample_", "", 1) if name.startswith("sample_") else ""
    if alt:
        for root in roots:
            path = root / alt
            if path.is_file():
                data = path.read_bytes()
                if data:
                    return data
    return None


def _configured_allowed_hosts() -> set[str]:
    from app.config import get_settings

    raw = getattr(get_settings(), "ref_fetch_allowed_hosts", "") or ""
    return {h.strip().lower() for h in raw.replace(";", ",").split(",") if h.strip()}


def _reject_non_global(ip: "ipaddress.IPv4Address | ipaddress.IPv6Address", host: str) -> None:
    if not ip.is_global:
        raise RefUrlError(f"参考地址目标为私网/保留地址:{host}")


async def guard_public_http_url(u: str) -> str:
    """校验 http(s) 远程参考地址,通过则原样返回;否则抛 RefUrlError。

    拒绝:非 http(s) scheme、URL userinfo、无法解析的主机名、以及解析结果含
    私网/环回/链路本地/保留/未指定地址(任一命中即拒)。配置主机例外见
    Settings.ref_fetch_allowed_hosts。
    """
    parts = urlsplit(u)
    if parts.scheme not in ("http", "https"):
        raise RefUrlError("仅允许 http(s) 远程参考地址")
    if parts.username is not None or parts.password is not None:
        raise RefUrlError("参考地址不允许 userinfo")
    host = parts.hostname
    if not host:
        raise RefUrlError("参考地址缺少主机名")
    if host.lower() in _configured_allowed_hosts():
        return u
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        _reject_non_global(ip, host)
        return u
    # 主机名先解析再判定:公网名解析到内网(DNS 指向私网)同样拒绝
    try:
        infos = await asyncio.to_thread(
            socket.getaddrinfo, host, parts.port or 443, type=socket.SOCK_STREAM
        )
    except OSError as e:
        raise RefUrlError(f"参考地址主机无法解析:{host}") from e
    if not infos:
        raise RefUrlError(f"参考地址主机无法解析:{host}")
    for info in infos:
        _reject_non_global(ipaddress.ip_address(info[4][0]), host)
    return u
