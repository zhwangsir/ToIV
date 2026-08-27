import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import (
    create_token,
    decode_token,
    hash_password,
    verify_password,
)


@pytest.fixture
def client():
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
    # 直接播种一个账号(无自助注册)
    with Session(engine) as s:
        tenant = Tenant(name="tester")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        s.add(
            User(
                email="tester",
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
        )
        s.commit()
    yield TestClient(app)
    app.dependency_overrides.clear()


# ---------- 单元:哈希 / JWT ----------
def test_password_hash_roundtrip():
    h = hash_password("s3cret-pw")
    assert h != "s3cret-pw"
    assert verify_password("s3cret-pw", h)
    assert not verify_password("wrong", h)


def test_password_hash_is_salted():
    assert hash_password("same") != hash_password("same")


def test_jwt_roundtrip():
    token = create_token("user-123")
    assert decode_token(token) == "user-123"


def test_jwt_tampered_rejected():
    assert decode_token("not.a.jwt") is None


# ---------- 集成:登录 / me ----------
def test_no_public_register(client):
    # 自助注册端点已移除
    assert client.post("/api/auth/register", json={"email": "x", "password": "y"}).status_code == 404


def test_login_success_and_wrong_password(client):
    ok = client.post("/api/auth/login", json={"email": "tester", "password": "password1"})
    assert ok.status_code == 200 and ok.json()["token"]
    bad = client.post("/api/auth/login", json={"email": "tester", "password": "nope"})
    assert bad.status_code == 401


def test_login_rate_limit_per_ip_and_account(client):
    """同 IP+同账号连续尝试,第 6 次起 429(login scope 5/min,防爆破)。"""
    from app.ratelimit import _hits

    _hits.clear()
    for i in range(5):
        r = client.post("/api/auth/login", json={"email": "brute", "password": "x"})
        assert r.status_code == 401, f"第 {i+1} 次应 401 而非 {r.status_code}"
    r = client.post("/api/auth/login", json={"email": "brute", "password": "x"})
    assert r.status_code == 429
    assert "Retry-After" in r.headers
    _hits.clear()


def test_login_rate_limit_isolated_by_account(client):
    """同 IP 不同账号独立计数:brute 被限后,其它账号仍可正常登录。"""
    from app.ratelimit import _hits

    _hits.clear()
    for _ in range(6):
        client.post("/api/auth/login", json={"email": "brute", "password": "x"})
    ok = client.post("/api/auth/login", json={"email": "tester", "password": "password1"})
    assert ok.status_code == 200
    _hits.clear()


def test_login_rate_limit_honors_x_forwarded_for(client, monkeypatch):
    """反代场景:直连对端属可信代理网段(TOIV_TRUSTED_PROXY_IPS)时,
    X-Forwarded-For 首跳作为限流主体;不同来源 IP 互不影响。"""
    from types import SimpleNamespace

    from app.ratelimit import _hits
    from app.routes import auth as auth_mod

    monkeypatch.setattr(
        auth_mod, "get_settings",
        lambda: SimpleNamespace(trusted_proxy_ips="10.0.0.0/8"),
    )
    _hits.clear()
    # 反代出口 10.0.0.2(在可信网段内):XFF 生效
    proxy = TestClient(app, client=("10.0.0.2", 50000))
    for _ in range(6):
        proxy.post(
            "/api/auth/login",
            json={"email": "brute", "password": "x"},
            headers={"X-Forwarded-For": "203.0.113.9"},
        )
    r = proxy.post(
        "/api/auth/login",
        json={"email": "brute", "password": "x"},
        headers={"X-Forwarded-For": "203.0.113.10"},
    )
    assert r.status_code == 401  # 新 IP 不受旧 IP 限制影响(401=凭据错,非 429)
    _hits.clear()


def test_login_rate_limit_ignores_xff_without_trusted_proxy(client, monkeypatch):
    """未配置可信代理(默认):XFF 被忽略,限流主体为直连 IP——伪造 XFF 换 IP 绕过限流无效。"""
    from types import SimpleNamespace

    from app.ratelimit import _hits
    from app.routes import auth as auth_mod

    monkeypatch.setattr(
        auth_mod, "get_settings",
        lambda: SimpleNamespace(trusted_proxy_ips=""),
    )
    _hits.clear()
    for _ in range(5):
        r = client.post(
            "/api/auth/login",
            json={"email": "brute", "password": "x"},
            headers={"X-Forwarded-For": "203.0.113.9"},
        )
        assert r.status_code == 401
    # 换 XFF 也逃不掉:主体仍是直连对端(TestClient 默认 "testclient"),第 6 次 429
    r = client.post(
        "/api/auth/login",
        json={"email": "brute", "password": "x"},
        headers={"X-Forwarded-For": "203.0.113.10"},
    )
    assert r.status_code == 429
    _hits.clear()


def test_login_rate_limit_ignores_xff_from_untrusted_direct(client, monkeypatch):
    """配置了可信代理,但直连对端不在清单内(绕过反代直连):XFF 仍被忽略。"""
    from types import SimpleNamespace

    from app.ratelimit import _hits
    from app.routes import auth as auth_mod

    monkeypatch.setattr(
        auth_mod, "get_settings",
        lambda: SimpleNamespace(trusted_proxy_ips="10.0.0.0/8"),
    )
    _hits.clear()
    direct = TestClient(app, client=("192.0.2.1", 50000))  # 不在 10.0.0.0/8
    for _ in range(5):
        r = direct.post(
            "/api/auth/login",
            json={"email": "brute", "password": "x"},
            headers={"X-Forwarded-For": "203.0.113.9"},
        )
        assert r.status_code == 401
    r = direct.post(
        "/api/auth/login",
        json={"email": "brute", "password": "x"},
        headers={"X-Forwarded-For": "203.0.113.10"},
    )
    assert r.status_code == 429  # 主体恒为直连 192.0.2.1
    _hits.clear()


def test_is_trusted_proxy_parsing(monkeypatch):
    """_is_trusted_proxy:单 IP / CIDR / 非法配置项 / 非 IP 对端 / 空清单各分支。"""
    from types import SimpleNamespace

    from app.routes import auth as auth_mod

    monkeypatch.setattr(
        auth_mod, "get_settings",
        lambda: SimpleNamespace(trusted_proxy_ips="127.0.0.1, 10.0.0.0/8,bad-entry"),
    )
    assert auth_mod._is_trusted_proxy("127.0.0.1") is True
    assert auth_mod._is_trusted_proxy("10.1.2.3") is True
    assert auth_mod._is_trusted_proxy("192.168.1.1") is False
    assert auth_mod._is_trusted_proxy("not-an-ip") is False  # TestClient 默认对端
    assert auth_mod._is_trusted_proxy("") is False
    # 空清单 = 不信任任何对端
    monkeypatch.setattr(
        auth_mod, "get_settings", lambda: SimpleNamespace(trusted_proxy_ips="")
    )
    assert auth_mod._is_trusted_proxy("127.0.0.1") is False


def test_login_account_case_insensitive(client):
    r = client.post("/api/auth/login", json={"email": "TESTER", "password": "password1"})
    assert r.status_code == 200


def test_me_requires_auth(client):
    assert client.get("/api/auth/me").status_code == 401


def test_me_returns_profile_and_usage(client):
    token = client.post(
        "/api/auth/login", json={"email": "tester", "password": "password1"}
    ).json()["token"]
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["email"] == "tester"
    assert body["user"]["role"] == "user"
    assert body["usage"]["total"] == 0


# ---------- test-login 通道(密钥换 admin token):限流 + 常量时间比较 ----------
@pytest.fixture
def testkey_client(monkeypatch):
    """开启测试通道(test_key 非空)并播种一个 admin 的客户端。"""
    from types import SimpleNamespace

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
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        s.add(
            User(
                email="admin",
                hashed_password=hash_password("x"),
                tenant_id=tenant.id,
                role="admin",
            )
        )
        s.commit()
    # 仅替换 auth 路由模块内的 get_settings(测试通道开关),不影响全局配置
    # trusted_proxy_ips 一并配置:XFF 相关用例(按来源 IP 隔离限流)才有生效前提
    fake = SimpleNamespace(
        test_key="secret-test-key", admin_email="admin", trusted_proxy_ips="10.0.0.0/8"
    )
    monkeypatch.setattr("app.routes.auth.get_settings", lambda: fake)
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_test_login_disabled_404(client, monkeypatch):
    """test_key 为空时通道关闭,404 不暴露端点存在性(本地 .env 默认非空,须显式关闭)。"""
    from types import SimpleNamespace

    monkeypatch.setattr(
        "app.routes.auth.get_settings",
        lambda: SimpleNamespace(test_key="", admin_email=""),
    )
    r = client.post("/api/auth/test-login", json={"key": "whatever"})
    assert r.status_code == 404


def test_test_login_correct_key_returns_admin_token(testkey_client):
    r = testkey_client.post("/api/auth/test-login", json={"key": "secret-test-key"})
    assert r.status_code == 200
    body = r.json()
    assert body["token"]
    assert body["user"]["role"] == "admin"


def test_test_login_wrong_key_rate_limited(testkey_client):
    """连续错误密钥:前 5 次 403,第 6 次触发 login scope(60s/5 次)限流 429。"""
    for i in range(5):
        r = testkey_client.post("/api/auth/test-login", json={"key": "wrong"})
        assert r.status_code == 403, f"第 {i + 1} 次应 403 而非 {r.status_code}"
    r = testkey_client.post("/api/auth/test-login", json={"key": "wrong"})
    assert r.status_code == 429
    assert "Retry-After" in r.headers


def test_test_login_rate_limit_isolated_by_ip(testkey_client):
    """限流主体为 IP+端点:换来源 IP 后正确密钥仍可 200(不受上个用例/本用例旧计数影响)。

    XFF 仅在直连对端属可信代理网段时生效(testkey fixture 已配 10.0.0.0/8)。
    """
    proxy = TestClient(app, client=("10.0.0.2", 50000))
    for _ in range(6):
        proxy.post(
            "/api/auth/test-login",
            json={"key": "wrong"},
            headers={"X-Forwarded-For": "203.0.113.9"},
        )
    r = proxy.post(
        "/api/auth/test-login",
        json={"key": "secret-test-key"},
        headers={"X-Forwarded-For": "203.0.113.10"},
    )
    assert r.status_code == 200


# ---------- 微信登录(/auth/wechat):bypass 开发通道 + code2session ----------
def _wechat_settings(**kw):
    """构造仅含微信登录三项配置的假 settings(与 testkey_client 同思路,不影响全局配置)。"""
    from types import SimpleNamespace

    base = {"wechat_appid": "", "wechat_secret": "", "wechat_dev_bypass": False}
    base.update(kw)
    return SimpleNamespace(**base)


def test_wechat_login_not_configured_503(client, monkeypatch):
    """bypass 关 + appid/secret 未配置 → 503 微信登录未配置。"""
    monkeypatch.setattr("app.routes.auth.get_settings", lambda: _wechat_settings())
    r = client.post("/api/auth/wechat", json={"code": "abc"})
    assert r.status_code == 503


def test_wechat_login_bypass_auto_signup(client, monkeypatch):
    """bypass 开:code 映射 dev-{code} openid,首登自动开户并签发可过 /auth/me 的 token。"""
    monkeypatch.setattr(
        "app.routes.auth.get_settings",
        lambda: _wechat_settings(wechat_dev_bypass=True),
    )
    r = client.post("/api/auth/wechat", json={"code": "abc", "nickname": "小明"})
    assert r.status_code == 200
    body = r.json()
    assert body["token"]
    assert body["user"]["email"] == "wx-dev-abc@wechat.local"
    assert body["user"]["role"] == "user"
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "wx-dev-abc@wechat.local"


def test_wechat_login_same_code_same_user(client, monkeypatch):
    """同 code 二次登录幂等绑定:返回同一 user id,不重复开户。"""
    monkeypatch.setattr(
        "app.routes.auth.get_settings",
        lambda: _wechat_settings(wechat_dev_bypass=True),
    )
    first = client.post("/api/auth/wechat", json={"code": "abc"}).json()
    second = client.post("/api/auth/wechat", json={"code": "abc"}).json()
    assert first["user"]["id"] == second["user"]["id"]


def test_wechat_login_blank_code_422(client, monkeypatch):
    """code 为空串或纯空白 → 422(长度校验 1-128)。"""
    monkeypatch.setattr(
        "app.routes.auth.get_settings",
        lambda: _wechat_settings(wechat_dev_bypass=True),
    )
    assert client.post("/api/auth/wechat", json={"code": ""}).status_code == 422
    assert client.post("/api/auth/wechat", json={"code": "   "}).status_code == 422


def test_wechat_login_errcode_401(client, monkeypatch):
    """配置齐全 + 腾讯返回 errcode(40029 invalid code)→ 401,detail 含 errcode。"""
    monkeypatch.setattr(
        "app.routes.auth.get_settings",
        lambda: _wechat_settings(wechat_appid="wx-appid", wechat_secret="wx-secret"),
    )
    monkeypatch.setattr(
        "app.routes.auth._wechat_code2session",
        lambda code, appid, secret: {"errcode": 40029, "errmsg": "invalid code"},
    )
    r = client.post("/api/auth/wechat", json={"code": "bad-code"})
    assert r.status_code == 401
    assert "40029" in r.json()["detail"]


def test_wechat_login_real_openid_bound(client, monkeypatch):
    """配置齐全 + 腾讯返回 openid → 200,自动开户绑定该 openid,token 可过 /auth/me。"""
    monkeypatch.setattr(
        "app.routes.auth.get_settings",
        lambda: _wechat_settings(wechat_appid="wx-appid", wechat_secret="wx-secret"),
    )
    monkeypatch.setattr(
        "app.routes.auth._wechat_code2session",
        lambda code, appid, secret: {
            "errcode": 0,
            "openid": "real-openid",
            "session_key": "sk",
        },
    )
    r = client.post("/api/auth/wechat", json={"code": "good-code"})
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["email"] == "wx-real-openid@wechat.local"
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
