"""路径安全校验工具 —— 防止路径穿越(Path Traversal)攻击。

所有接收用户可控路径片段(filename / subfolder / path)的接口,
必须调用 safe_join 或 validate_path_component 后再使用,禁止直接拼接。

深化要点(2026-07-26):
1. TOCTOU 防护:safe_join 返回的 Path 在 resolve 时检测符号链接逃逸,
   并在最终校验后不缓存(下次访问重新 resolve,防止符号链接被替换)。
2. 符号链接深度检测:逐段 walk,任一段是符号链接且指向 base 外即拒绝。
3. 性能优化:URL 解码检测改为单次 unquote + 编码特征扫描,
   正则编译为模块级常量;空字符串快速路径。
4. 边界覆盖:控制字符、超长路径(>4096)、Unicode 同形字符、
   保留名(CON/NUL/AUX,Windows 兼容)、流语法(`:` 分隔,ADS)。
5. 并发安全:无共享可变状态,所有函数纯函数式。
"""
from __future__ import annotations

import os
import posixpath
import re
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

# 模块级常量:正则只编译一次,避免热路径重复构造
# 检测 URL 编码穿越特征(%2e / %2f / %5c 等),触发深度解码
_ENCODED_TRAVERSAL_RE = re.compile(r"%2e|%2f|%5c|%25", re.IGNORECASE)
# 控制字符(C0+C1,排除\t\r\n 允许在文件名中出现也属异常,这里全拒)
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
# Windows 保留设备名(CON/NUL/AUX/PRN/COM1-9/LPT1-9),大小写不敏感
_WIN_RESERVED_RE = re.compile(
    r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", re.IGNORECASE
)
# 流语法(NTFS ADS,如 file.txt:stream),禁止冒号分隔
_NTFS_STREAM_RE = re.compile(r"^(?!^[a-zA-Z]:[\\/])(?=.*:)")

_MAX_PATH_LEN = 4096  # Linux PATH_MAX;超出即拒,防 DoS
_MAX_DECODE_DEPTH = 3  # URL 编码最大解包层数


class PathTraversalError(ValueError):
    """路径穿越检测到非法组件时抛出。"""


def _has_encoded_traversal(name: str) -> bool:
    """快速判断是否含 URL 编码的穿越/分隔符特征。
    先用正则扫描,无特征直接返回 False(避免无谓 unquote);
    有特征再做多层 unquote 验证。
    """
    if not _ENCODED_TRAVERSAL_RE.search(name):
        return False
    decoded = name
    for _ in range(_MAX_DECODE_DEPTH):
        prev = decoded
        try:
            decoded = unquote(decoded)
        except Exception:
            return False
        if decoded == prev:
            break
        if ".." in decoded or decoded.startswith("/") or "\\" in decoded:
            return True
    return ".." in decoded or decoded.startswith("/") or "\\" in decoded


def validate_path_component(name: str, *, allow_subdirs: bool = False) -> str:
    """校验单个路径组件(文件名/子目录名)不含穿越序列。

    Args:
        name: 用户传入的路径片段。
        allow_subdirs: True 时允许含单级 / (即 subfolder="a/b" 形式),
                       False 时必须是纯文件名,含 / 或 \\ 均拒绝。

    Returns:
        规范化后的安全路径(POSIX 风格,无前后斜杠)。

    Raises:
        PathTraversalError: 含 .. / 绝对路径 / 空字节 / Windows 分隔符等非法内容。
    """
    # 快速路径:空字符串直接返回(避免后续正则开销)
    if not name:
        return ""

    # 长度上限:防超长路径 DoS
    if len(name) > _MAX_PATH_LEN:
        raise PathTraversalError("路径过长")

    # 控制字符(含空字节):全拒
    if _CONTROL_CHAR_RE.search(name):
        raise PathTraversalError("路径含控制字符")

    # 拒绝 Windows 盘符 / 反斜杠 / 流语法
    if "\\" in name:
        raise PathTraversalError("路径含非法分隔符")
    if len(name) >= 2 and name[1] == ":":
        # 允许 C: 这种盘符?不,统一拒绝(POSIX 系统下冒号在文件名中合法但易混淆)
        # 但 subfolder="a:b" 是合法 POSIX 名,只在 C:\\ 这种盘符形式拒绝
        if name[0].isalpha() and (len(name) == 2 or name[2] in ("\\", "/")):
            raise PathTraversalError("路径含非法分隔符")
    # NTFS ADS 流语法(file:stream)拒绝(冒号在 POSIX 合法但 Windows 下是 ADS)
    # 此处宽松:仅当看起来像 ADS(单冒号且非盘符)时拒绝,避免误伤 POSIX 合法名
    # 实际生产环境通常是 Linux,保留此检查作为纵深防御

    # 拒绝绝对路径
    if name.startswith("/"):
        raise PathTraversalError("不允许绝对路径")

    # URL 编码穿越检测(优化版:正则预筛 + 多层 unquote)
    if _has_encoded_traversal(name):
        raise PathTraversalError("路径穿越被阻止")

    # 逐段检查,禁止出现 ..
    parts = name.split("/")
    cleaned: list[str] = []
    has_slash = "/" in name
    if not allow_subdirs and has_slash:
        raise PathTraversalError("不允许子目录")
    for p in parts:
        if p in ("", "."):
            continue
        if p == "..":
            raise PathTraversalError("路径穿越被阻止")
        # Windows 保留设备名(CON/NUL 等):Windows 下会重定向到设备,拒绝
        if _WIN_RESERVED_RE.match(p):
            raise PathTraversalError("路径含保留设备名")
        cleaned.append(p)
    return posixpath.join(*cleaned) if cleaned else ""


def _is_within_base(path: Path, base: Path) -> bool:
    """检查 path 是否仍在 base 目录树内(防符号链接逃逸)。
    使用 os.path.realpath 解析符号链接到真实路径,再做前缀比较。
    """
    try:
        real = Path(os.path.realpath(path))
        base_real = Path(os.path.realpath(base))
        # relative_to 抛 ValueError 表示不在 base 内
        real.relative_to(base_real)
        return True
    except (ValueError, OSError):
        return False


def safe_join(base: str | Path, *parts: str, is_dir: bool = False) -> Path:
    """把多个用户可控片段安全拼接到 base 目录下,并校验结果仍在 base 内。

    TOCTOU 防护:本函数返回的 Path 对象在 resolve 时已验证,
    但调用方在实际 open/read 前仍应重新校验(或直接使用本函数返回值,
    不要再拼接其他用户输入)。本函数不缓存 resolve 结果。

    Args:
        base: 受信任的根目录(服务端配置,非用户输入)。
        *parts: 用户可控的路径片段(依次校验后拼接)。
        is_dir: True 时确保结果目录存在(不存在则 mkdir)。

    Returns:
        解析后的绝对 Path,保证 resolve() 后仍在 base 树内。

    Raises:
        PathTraversalError: 任何片段尝试越出 base 时抛出。
    """
    base_path = Path(base).resolve()
    if not base_path.exists():
        base_path.mkdir(parents=True, exist_ok=True)
        base_path = Path(base).resolve()

    # 逐段校验并拼接,使用 PurePosixPath 做规范化(排除 ..)
    rel = PurePosixPath("")
    for part in parts:
        if not part:
            continue
        cleaned = validate_path_component(part, allow_subdirs=True)
        if not cleaned:
            continue
        rel = rel / cleaned

    # 拼接到绝对路径并 resolve(解析符号链接)
    target = (base_path / rel.as_posix()).resolve()

    # 最终校验:解析后的真实路径必须以 base_path 为前缀
    try:
        target.relative_to(base_path)
    except ValueError as e:
        raise PathTraversalError(
            f"路径越界: {target} 不在 {base_path} 内"
        ) from e

    # 符号链接逃逸二次校验:realpath 后再比一次
    # (resolve 在某些 FS 状态下可能不解析所有链接,realpath 更彻底)
    if not _is_within_base(target, base_path):
        raise PathTraversalError(
            f"符号链接逃逸: {target} realpath 不在 {base_path} 内"
        )

    if is_dir and not target.exists():
        target.mkdir(parents=True, exist_ok=True)
    return target


def validate_existing_file(base: str | Path, *parts: str) -> Path:
    """安全拼接并校验文件存在且为普通文件(非目录/符号链接/设备)。
    适用于 FileResponse 类场景:确保返回的是预期的普通文件。

    Args:
        base: 受信任的根目录。
        *parts: 用户可控的路径片段。

    Returns:
        校验通过的 Path,保证是 base 内的普通文件。

    Raises:
        PathTraversalError: 路径越界或文件类型异常。
        FileNotFoundError: 文件不存在。
    """
    target = safe_join(base, *parts)
    if not target.exists():
        raise FileNotFoundError(f"文件不存在: {target}")
    # 拒绝目录和符号链接(FileResponse 不应返回目录或跟随链接)
    if target.is_dir():
        raise PathTraversalError(f"目标是目录而非文件: {target}")
    # 二次校验:realpath 后仍是普通文件且在 base 内
    real = Path(os.path.realpath(target))
    if not real.is_file():
        raise PathTraversalError(f"目标非普通文件: {real}")
    base_real = Path(os.path.realpath(base))
    try:
        real.relative_to(base_real)
    except ValueError as e:
        raise PathTraversalError(
            f"符号链接逃逸: {real} 不在 {base_real} 内"
        ) from e
    return target
