"""用户级路径安全场景测试 —— 通过 HTTP API 验证 pathsafe 防护在不同用户角色和攻击向量下的表现。

覆盖维度:
1. 用户角色:未认证 / 普通用户 / 管理员
2. 攻击向量:路径穿越 / ADS 流语法 / Unicode 同形字符 / Windows 保留名 / 空字节 / 超长路径 / 反斜杠
3. 合法场景:正常 filename 应通过路径校验(后续因 worker 未知返回 400)

测试端点:GET /api/images(pathsafe 在生产环境的唯一 HTTP 入口)
  - filename: validate_path_component(allow_subdirs=False)
  - subfolder: validate_path_component(allow_subdirs=True)

判定逻辑:
  - 恶意路径 → 400(detail 含"非法路径",在 worker 校验之前拦截)
  - 合法路径 → 400(detail 含"未知的 worker",路径校验通过后 worker 校验拦截)
  - 未认证   → 401(在路径校验之前拦截)
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import hash_password

# 任意 worker 值:路径校验在 worker 校验之前执行,恶意路径会先返回 400"非法路径"
# 合法路径会继续到 resolve_worker,因 worker 不在白名单返回 400"未知的 worker"
_DUMMY_WORKER = "http://127.0.0.1:8188"


@pytest.fixture
def clients():
    """创建 admin + 普通用户 + TestClient,返回 (client, admin_token, user_token)。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override

    with Session(engine) as s:
        tenant = Tenant(name="test-tenant")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)

        admin = User(
            email="admin",
            hashed_password=hash_password("admin123"),
            tenant_id=tenant.id,
            role="admin",
        )
        normal = User(
            email="user",
            hashed_password=hash_password("user123"),
            tenant_id=tenant.id,
            role="user",
        )
        s.add_all([admin, normal])
        s.commit()

    client = TestClient(app)

    admin_token = client.post(
        "/api/auth/login", json={"email": "admin", "password": "admin123"}
    ).json()["token"]
    user_token = client.post(
        "/api/auth/login", json={"email": "user", "password": "user123"}
    ).json()["token"]

    yield client, admin_token, user_token
    app.dependency_overrides.clear()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _get(client: TestClient, token: str | None, **params) -> object:
    """带可选 token 调用 GET /api/images,返回 Response。"""
    headers = _auth(token) if token else {}
    return client.get("/api/images", params={"worker": _DUMMY_WORKER, **params}, headers=headers)


# ──────────────────────────────────────────────────────────────────────
# 场景1:未认证用户访问(401,在路径校验之前拦截)
# ──────────────────────────────────────────────────────────────────────
class TestUnauthenticatedAccess:
    """未认证用户:无论路径是否恶意,都应返回 401。"""

    def test_no_token_normal_path_returns_401(self, clients):
        client, _, _ = clients
        r = _get(client, None, filename="image.png")
        assert r.status_code == 401

    def test_no_token_traversal_path_returns_401(self, clients):
        client, _, _ = clients
        r = _get(client, None, filename="../../../etc/passwd")
        assert r.status_code == 401

    def test_no_token_ads_path_returns_401(self, clients):
        client, _, _ = clients
        r = _get(client, None, filename="file:stream")
        assert r.status_code == 401

    def test_no_token_homoglyph_path_returns_401(self, clients):
        client, _, _ = clients
        r = _get(client, None, filename="fаke.png")
        assert r.status_code == 401


# ──────────────────────────────────────────────────────────────────────
# 场景2:认证用户(admin)路径穿越攻击(400"非法路径")
# ──────────────────────────────────────────────────────────────────────
class TestPathTraversalAttacks:
    """路径穿越攻击:所有变体应被 validate_path_component 拦截,返回 400。"""

    @pytest.mark.parametrize(
        "filename",
        [
            "../../../etc/passwd",
            "..",
            "../secret",
            "a/../../../b",
            "../../",
            "a/..",
            "a/../b",
        ],
        ids=["dotdot-slash", "dotdot-only", "dotdot-secret", "nested-dotdot", "dotdot-trail", "a-dotdot", "a-dotdot-b"],
    )
    def test_traversal_rejected(self, clients, filename):
        client, admin_token, _ = clients
        r = _get(client, admin_token, filename=filename)
        assert r.status_code == 400, f"filename={filename!r} 应被拦截"
        assert "非法路径" in r.json()["detail"]


# ──────────────────────────────────────────────────────────────────────
# 场景3:认证用户(admin)ADS 流语法 + 冒号攻击(400)
# ──────────────────────────────────────────────────────────────────────
class TestColonAdsAttacks:
    """冒号全拒:NTFS ADS 流语法 + Windows 盘符,所有含冒号的路径应返回 400。"""

    @pytest.mark.parametrize(
        "filename",
        [
            "image.png:stream",
            "file:ads",
            "C:file",
            "C:\\Windows",
            "a:b",
            "image.png:thumbnail",
        ],
        ids=["png-stream", "file-ads", "drive-c-file", "drive-c-windows", "colon-ab", "png-thumbnail"],
    )
    def test_colon_rejected(self, clients, filename):
        client, admin_token, _ = clients
        r = _get(client, admin_token, filename=filename)
        assert r.status_code == 400, f"filename={filename!r} 应被拦截"
        assert "非法路径" in r.json()["detail"]


# ──────────────────────────────────────────────────────────────────────
# 场景4:认证用户(admin)Unicode 同形字符攻击(400)
# ──────────────────────────────────────────────────────────────────────
class TestHomoglyphAttacks:
    """Unicode 同形字符:ASCII 为主 + 掺杂 Cyrillic/Greek 应返回 400。"""

    @pytest.mark.parametrize(
        "filename",
        [
            "fаke.png",      # Cyrillic а (U+0430) 替换 ASCII a
            "imаge.png",     # Cyrillic а
            "аdmin.png",     # Cyrillic а 开头
            "fileα.txt",     # Greek α (U+03B1)
            "pаssword",      # Cyrillic а
        ],
        ids=["cyrillic-a-fake", "cyrillic-a-image", "cyrillic-a-admin", "greek-alpha", "cyrillic-a-password"],
    )
    def test_homoglyph_rejected(self, clients, filename):
        client, admin_token, _ = clients
        r = _get(client, admin_token, filename=filename)
        assert r.status_code == 400, f"filename={filename!r} 应被拦截"
        assert "非法路径" in r.json()["detail"]

    def test_pure_cyrillic_not_blocked_by_homoglyph(self, clients):
        """纯 Cyrillic 文件名不触发同形字符检测(合法命名)。"""
        client, admin_token, _ = clients
        r = _get(client, admin_token, filename="файл.png")
        # 纯 Cyrillic 不触发同形字符,路径校验通过 → 因 worker 未知返回 400"未知的 worker"
        assert r.status_code == 400
        assert "未知的 worker" in r.json()["detail"]


# ──────────────────────────────────────────────────────────────────────
# 场景5:认证用户(admin)其他攻击向量(400)
# ──────────────────────────────────────────────────────────────────────
class TestOtherAttackVectors:
    """Windows 保留名 / 空字节 / 控制字符 / 超长路径 / 反斜杠 / 绝对路径。"""

    @pytest.mark.parametrize(
        "filename,expected_keyword",
        [
            ("CON", "保留设备名"),
            ("con.txt", "保留设备名"),
            ("NUL.log", "保留设备名"),
            ("AUX", "保留设备名"),
            ("COM1.png", "保留设备名"),
            ("lpt1.dat", "保留设备名"),
            ("image.png\x00.jpg", "控制字符"),
            ("file\x01.png", "控制字符"),
            ("file\x7f.png", "控制字符"),
            ("a" * 5000, "路径过长"),
            ("a\\b\\c", "非法分隔符"),
            ("/etc/passwd", "绝对路径"),
        ],
        ids=["CON", "con.txt", "NUL.log", "AUX", "COM1.png", "lpt1.dat",
             "null-byte", "ctrl-0x01", "ctrl-0x7f", "too-long", "backslash", "absolute"],
    )
    def test_attack_vector_rejected(self, clients, filename, expected_keyword):
        client, admin_token, _ = clients
        r = _get(client, admin_token, filename=filename)
        assert r.status_code == 400, f"filename={filename!r} 应被拦截"
        assert expected_keyword in r.json()["detail"], (
            f"filename={filename!r} 期望关键词 '{expected_keyword}',"
            f"实际 detail={r.json()['detail']!r}"
        )


# ──────────────────────────────────────────────────────────────────────
# 场景6:subfolder 路径穿越(400)
# ──────────────────────────────────────────────────────────────────────
class TestSubfolderAttacks:
    """subfolder 参数的路径穿越攻击,应被 validate_path_component 拦截。"""

    @pytest.mark.parametrize(
        "subfolder",
        [
            "../../../etc",
            "..",
            "../secret",
            "a/../../../b",
        ],
        ids=["dotdot-etc", "dotdot-only", "dotdot-secret", "nested-dotdot"],
    )
    def test_subfolder_traversal_rejected(self, clients, subfolder):
        client, admin_token, _ = clients
        r = _get(client, admin_token, filename="image.png", subfolder=subfolder)
        assert r.status_code == 400, f"subfolder={subfolder!r} 应被拦截"
        assert "非法路径" in r.json()["detail"]

    def test_subfolder_with_colon_rejected(self, clients):
        """subfolder 含冒号也应被拦截。"""
        client, admin_token, _ = clients
        r = _get(client, admin_token, filename="image.png", subfolder="a:b")
        assert r.status_code == 400
        assert "非法路径" in r.json()["detail"]


# ──────────────────────────────────────────────────────────────────────
# 场景7:普通用户与 admin 相同的路径安全防护
# ──────────────────────────────────────────────────────────────────────
class TestNormalUserProtection:
    """普通用户(user 角色)应与 admin 受到相同的路径安全防护。"""

    def test_normal_user_traversal_rejected(self, clients):
        client, _, user_token = clients
        r = _get(client, user_token, filename="../../../etc/passwd")
        assert r.status_code == 400
        assert "非法路径" in r.json()["detail"]

    def test_normal_user_ads_rejected(self, clients):
        client, _, user_token = clients
        r = _get(client, user_token, filename="file:stream")
        assert r.status_code == 400
        assert "非法路径" in r.json()["detail"]

    def test_normal_user_homoglyph_rejected(self, clients):
        client, _, user_token = clients
        r = _get(client, user_token, filename="fаke.png")
        assert r.status_code == 400
        assert "非法路径" in r.json()["detail"]

    def test_normal_user_reserved_name_rejected(self, clients):
        client, _, user_token = clients
        r = _get(client, user_token, filename="CON")
        assert r.status_code == 400
        assert "非法路径" in r.json()["detail"]


# ──────────────────────────────────────────────────────────────────────
# 场景8:合法路径通过校验(400"未知的 worker")
# ──────────────────────────────────────────────────────────────────────
class TestLegitimatePaths:
    """合法路径应通过 validate_path_component,因 worker 未知返回 400"未知的 worker"。"""

    @pytest.mark.parametrize(
        "filename",
        [
            "image.png",
            "my_photo_001.jpg",
            "video clip.mp4",
            "2026-07-27_render.mp4",
            "файл.png",        # 纯 Cyrillic 合法
            "图片.png",         # 纯中文合法
        ],
        ids=["png", "jpg", "mp4-space", "mp4-date", "cyrillic", "chinese"],
    )
    def test_legitimate_filename_passes_path_check(self, clients, filename):
        client, admin_token, _ = clients
        r = _get(client, admin_token, filename=filename)
        # 路径校验通过 → worker 校验拦截 → 400"未知的 worker"
        assert r.status_code == 400, f"filename={filename!r} 应通过路径校验"
        assert "未知的 worker" in r.json()["detail"], (
            f"filename={filename!r} 期望通过路径校验后因 worker 未知返回 400,"
            f"实际 detail={r.json()['detail']!r}"
        )

    def test_legitimate_subfolder_passes_path_check(self, clients):
        """合法 subfolder(如 2026/07)应通过校验。"""
        client, admin_token, _ = clients
        r = _get(client, admin_token, filename="image.png", subfolder="2026/07")
        assert r.status_code == 400
        assert "未知的 worker" in r.json()["detail"]

    def test_empty_filename_returns_400(self, clients):
        """空 filename 应返回 400(filename 不能为空)。"""
        client, admin_token, _ = clients
        r = _get(client, admin_token, filename="")
        assert r.status_code == 400
