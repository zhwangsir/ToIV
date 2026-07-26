"""路径穿越防护测试 —— 确保 pathsafe.py 正确阻止所有常见穿越向量。"""
from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from app.pathsafe import (
    PathTraversalError,
    safe_join,
    validate_existing_file,
    validate_path_component,
)


class TestValidatePathComponent:
    """单组件校验测试。"""

    def test_clean_filename_passes(self):
        assert validate_path_component("image.png") == "image.png"
        assert validate_path_component("my_photo_001.jpg") == "my_photo_001.jpg"
        assert validate_path_component("video clip.mp4") == "video clip.mp4"

    def test_subfolder_allowed_when_flag_set(self):
        assert validate_path_component("2026/07", allow_subdirs=True) == "2026/07"
        assert validate_path_component("a/b/c", allow_subdirs=True) == "a/b/c"

    def test_subfolder_rejected_by_default(self):
        with pytest.raises(PathTraversalError, match="不允许子目录"):
            validate_path_component("a/b")

    def test_double_dot_rejected(self):
        for bad in ("..", "../etc/passwd", "a/../b", "../../secret"):
            with pytest.raises(PathTraversalError, match="路径穿越被阻止"):
                validate_path_component(bad, allow_subdirs=True)

    def test_absolute_path_rejected(self):
        for bad in ("/etc/passwd", "/etc", "/"):
            with pytest.raises(PathTraversalError, match="不允许绝对路径"):
                validate_path_component(bad, allow_subdirs=True)

    def test_null_byte_rejected(self):
        # 深化后:空字节属于控制字符,统一用"控制字符"消息
        with pytest.raises(PathTraversalError, match="控制字符"):
            validate_path_component("file.png\x00.jpg")

    def test_control_chars_rejected(self):
        # 深化新增:所有 C0/C1 控制字符均拒绝(防终端转义/换行注入)
        for bad in ("file\x01.png", "file\x07.png", "file\x1f.png", "file\x7f.png"):
            with pytest.raises(PathTraversalError, match="控制字符"):
                validate_path_component(bad)

    def test_path_too_long_rejected(self):
        # 深化新增:超长路径拒绝(防 DoS)
        with pytest.raises(PathTraversalError, match="路径过长"):
            validate_path_component("a" * 5000)

    def test_windows_reserved_device_rejected(self):
        # 深化新增:Windows 保留设备名(CON/NUL/AUX/COM1/LPT1 等)拒绝
        for bad in ("CON", "con.txt", "NUL.log", "AUX", "COM1.png", "lpt1.dat"):
            with pytest.raises(PathTraversalError, match="保留设备名"):
                validate_path_component(bad)

    def test_backslash_rejected(self):
        with pytest.raises(PathTraversalError, match="非法分隔符"):
            validate_path_component("a\\b\\c")

    def test_windows_drive_rejected(self):
        with pytest.raises(PathTraversalError, match="非法分隔符"):
            validate_path_component("C:\\Windows")

    def test_empty_string_returns_empty(self):
        assert validate_path_component("") == ""

    def test_dots_normalized(self):
        assert validate_path_component("./file", allow_subdirs=True) == "file"
        assert validate_path_component("a/./b", allow_subdirs=True) == "a/b"


class TestSafeJoin:
    """safe_join 拼接与越界检测测试。"""

    def test_simple_join(self, tmp_path):
        result = safe_join(tmp_path, "subdir", "file.txt")
        assert result == tmp_path / "subdir" / "file.txt"

    def test_traversal_outside_base_rejected(self, tmp_path):
        with pytest.raises(PathTraversalError):
            safe_join(tmp_path, "..", "outside.txt")

    def test_nested_subdir_ok(self, tmp_path):
        result = safe_join(tmp_path, "a", "b", "c", "file.png")
        expected = tmp_path / "a" / "b" / "c" / "file.png"
        assert result == expected

    def test_is_dir_creates_directory(self, tmp_path):
        target = safe_join(tmp_path, "new_dir", "nested", is_dir=True)
        assert target.exists()
        assert target.is_dir()

    def test_symlink_outside_base_rejected(self, tmp_path):
        outside = tmp_path.parent / "outside.txt"
        outside.write_text("secret")
        link = tmp_path / "link.txt"
        link.symlink_to(outside)
        with pytest.raises(PathTraversalError, match="路径越界"):
            safe_join(tmp_path, "link.txt")

    def test_encoded_traversal_blocked(self, tmp_path):
        for bad in ("%2e%2e/etc/passwd", "..%2f..%2fsecret", "%2e%2e/%2e%2e/secret"):
            with pytest.raises(PathTraversalError):
                safe_join(tmp_path, bad)

    def test_validate_existing_file_ok(self, tmp_path):
        # 深化新增:validate_existing_file 返回普通文件路径
        f = tmp_path / "image.png"
        f.write_bytes(b"\x89PNG")
        result = validate_existing_file(tmp_path, "image.png")
        assert result.is_file()
        assert result == f

    def test_validate_existing_file_rejects_dir(self, tmp_path):
        # 深化新增:目录拒绝(防 FileResponse 返回目录)
        (tmp_path / "subdir").mkdir()
        with pytest.raises(PathTraversalError, match="目录而非文件"):
            validate_existing_file(tmp_path, "subdir")

    def test_validate_existing_file_rejects_symlink_escape(self, tmp_path):
        # 深化新增:符号链接逃逸到 base 外拒绝
        outside = tmp_path.parent / "secret.txt"
        outside.write_text("secret")
        try:
            link = tmp_path / "link.png"
            link.symlink_to(outside)
            with pytest.raises(PathTraversalError):
                validate_existing_file(tmp_path, "link.png")
        finally:
            outside.unlink(missing_ok=True)

    def test_validate_existing_file_not_found(self, tmp_path):
        # 深化新增:文件不存在抛 FileNotFoundError(非 PathTraversalError)
        with pytest.raises(FileNotFoundError):
            validate_existing_file(tmp_path, "missing.png")
