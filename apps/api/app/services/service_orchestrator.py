"""按需资源分配 R1:冷层服务编排(services/service_orchestrator.py)。

背景:集群是 bare-metal + systemd 的 LAN 异构舰队;冷层服务(i2l :9101 /
trainer :9100 / lipsync :9103 / hy3dtex :9404,均在 workstation 192.168.71.127)
常驻白占显存,目标是闲置自动回收、按需唤醒。热层(H3/LLM/VLM/TTS)常驻不动,
不进本注册表。本模块只做编排器底座:

  · 服务注册表:内置默认四服务(name/systemd_unit/host/port/health_path/
    tier=cold/idle_timeout_sec 默认 900s);环境变量 TOIV_ORCH_SERVICES(JSON,
    dict name→字段 或 list[含 name 的字段])按 name 合并覆盖/追加。
  · 状态机:running/waking/sleeping/stopped/error;每服务记录 last_request_at、
    启停次数(wake_count/stop_count)、last_error。
  · mark_request(name):业务路由每次调用冷服务前打点(更新 last_request_at)。
  · ensure_running(name):sleeping/stopped/error → waking(SSH
    `sudo -n systemctl start <unit>`,host 经 ssh 别名,默认 workstation)→
    轮询健康检查(HTTP GET health_path 任意响应即存活,同 fleet 口径;
    health_path 空串退化为 TCP 连通探测;总超时默认 120s)→ running;
    失败 → error + 审计 orch.wake_failed + 502/504。并发唤醒经 per-service
    锁串行化(后到者等前者唤醒完再复查状态)。
  · ensure_awake(name, enabled=...):R2 业务路由接线(打点 + 非 running 唤醒,
    失败转 503);开关/注册表条目禁用时直通(零行为变化)。
  · idle_sweep()/idle_sweep_loop():每 60s 扫 cold 层,闲置超阈值 →
    `sudo -n systemctl stop` → sleeping + 审计 orch.sleep。
    默认保守不回收:仅当服务显式声明 safe_idle=true 才自动停;有关联活跃
    Job(queued/running/held,按注册表 job_kinds 查询,查询方式即配置项)、
    从未打点、或状态不在 running 的服务一律不动;作业查询失败按「有活跃
    作业」处理,绝不误停在跑作业。

审计身份:启停是系统动作无登录用户,AuditLog 以 system/orchestrator 落库
(独立短事务;审计故障只留日志,不阻断编排链路)。
SSH 注入防线:systemd_unit 白名单字符校验,注册表加载时剔除非法条目。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException
from sqlmodel import Session, select

from app.config import get_settings
from app.db import engine
from app.models import AuditLog, Job

logger = logging.getLogger(__name__)

# 状态机合法状态
STATES = ("running", "waking", "sleeping", "stopped", "error")

# systemd unit 名字符白名单(unit 会拼进远端 shell 命令,防 SSH 命令注入)
_UNIT_RE = re.compile(r"^[A-Za-z0-9_.@-]+$")

# 唤醒健康检查轮询间隔(秒);测试可 monkeypatch 压小
WAKE_POLL_INTERVAL_SEC = 2.0
# 单次 HTTP/TCP 健康检查超时(秒)
HEALTH_CHECK_TIMEOUT_SEC = 3.0
# 单次 ssh systemctl 调用超时(秒)
SSH_CMD_TIMEOUT_SEC = 30.0

# 回收判定时视为「在跑」的关联作业状态
ACTIVE_JOB_STATES = ("queued", "running", "held")


@dataclass(frozen=True)
class ServiceSpec:
    """冷层服务注册条目(配置驱动;idle/wake 超时 0 = 用全局设置值)。"""

    name: str
    systemd_unit: str
    host: str
    port: int
    health_path: str = "/health"  # 空串 = TCP 连通探测
    tier: str = "cold"
    idle_timeout_sec: int = 0  # 0 → settings.orch_idle_timeout_sec(默认 900)
    wake_timeout_sec: float = 0.0  # 0 → settings.orch_wake_timeout_sec(默认 120)
    safe_idle: bool = False  # 显式 true 才允许 idle_sweep 自动停(保守默认)
    job_kinds: tuple[str, ...] = ()  # 关联 Job.kind(回收前查活跃作业)
    wake_on_call: bool = True  # R2:显式 false 时业务路由不自动唤醒本服务(直通)


@dataclass
class ServiceState:
    """单服务运行时状态(进程内;api 重启回 stopped,首次 ensure/wake 校正)。"""

    status: str = "stopped"
    last_request_at: float | None = None  # time.time()
    wake_count: int = 0
    stop_count: int = 0
    last_error: str = ""
    changed_at: float = field(default_factory=time.time)


# 内置默认四服务(均在 workstation;AGENTS.md 第五节 systemd 单元名)
_WS = "192.168.71.127"
_DEFAULT_SERVICES: tuple[dict, ...] = (
    # i2L 是单次前向导出(同步等待无 Job 行),trainer 作业在 TrainJob 表,
    # 二者无 Job.kind 关联 → job_kinds 空;叠加 safe_idle=false 双保险不自动回收。
    {"name": "i2l", "systemd_unit": "toiv-i2l.service", "host": _WS, "port": 9101},
    {"name": "trainer", "systemd_unit": "toiv-trainer.service", "host": _WS, "port": 9100},
    {"name": "lipsync", "systemd_unit": "toiv-lipsync.service", "host": _WS, "port": 9103,
     "job_kinds": ["lipsync"]},
    {"name": "hy3dtex", "systemd_unit": "toiv-hy3dtex.service", "host": _WS, "port": 9404,
     "job_kinds": ["threed_texture"]},
)

_registry: dict[str, ServiceSpec] | None = None
_states: dict[str, ServiceState] = {}
_locks: dict[str, asyncio.Lock] = {}


# ─────────────────────────── 注册表 ───────────────────────────


def _build_spec(raw: dict) -> ServiceSpec | None:
    """dict → ServiceSpec;缺字段/类型错/端口越界/unit 非法 → 记 warning 丢弃。"""
    try:
        name = str(raw["name"]).strip()
        unit = str(raw["systemd_unit"]).strip()
        host = str(raw["host"]).strip()
        port = int(raw["port"])
    except (KeyError, TypeError, ValueError):
        logger.warning("orch 注册表条目缺字段/类型错,丢弃: %r", raw)
        return None
    if not name or not host or not (1 <= port <= 65535):
        logger.warning("orch 注册表条目非法(name/host/port),丢弃: %r", raw)
        return None
    if not _UNIT_RE.match(unit):
        logger.warning("orch 注册表 unit 含非法字符(注入防线),丢弃: %r", unit)
        return None
    kinds = raw.get("job_kinds") or ()
    return ServiceSpec(
        name=name,
        systemd_unit=unit,
        host=host,
        port=port,
        health_path=str(raw.get("health_path", "/health")),
        tier=str(raw.get("tier", "cold")),
        idle_timeout_sec=int(raw.get("idle_timeout_sec", 0)),
        wake_timeout_sec=float(raw.get("wake_timeout_sec", 0.0)),
        safe_idle=bool(raw.get("safe_idle", False)),
        job_kinds=tuple(str(k) for k in kinds),
        wake_on_call=bool(raw.get("wake_on_call", True)),
    )


def load_registry() -> dict[str, ServiceSpec]:
    """内置默认 + TOIV_ORCH_SERVICES 覆盖(同名合并,新名追加)。

    覆盖 JSON 解析失败/形态非法 → 沿用内置默认;覆盖把条目改非法(如 unit
    注入)→ 该条目连同内置一并剔除,绝不放行。
    """
    specs: dict[str, ServiceSpec] = {}
    for raw in _DEFAULT_SERVICES:
        spec = _build_spec(raw)
        if spec:
            specs[spec.name] = spec
    override_raw = get_settings().orch_services.strip()
    if not override_raw:
        return specs
    try:
        payload = json.loads(override_raw)
    except json.JSONDecodeError as e:
        logger.warning("TOIV_ORCH_SERVICES JSON 解析失败,沿用内置默认: %s", e)
        return specs
    entries = (
        [{"name": k, **(v or {})} for k, v in payload.items()]
        if isinstance(payload, dict)
        else payload
    )
    if not isinstance(entries, list):
        logger.warning("TOIV_ORCH_SERVICES 形态非法(需 dict 或 list),沿用内置默认")
        return specs
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get("name"):
            logger.warning("TOIV_ORCH_SERVICES 条目缺 name,丢弃: %r", entry)
            continue
        base = specs.get(str(entry["name"]))
        merged = {**(asdict(base) if base else {}), **entry}
        spec = _build_spec(merged)
        if spec is not None:
            specs[spec.name] = spec
        else:
            specs.pop(str(entry["name"]), None)
    return specs


def get_registry() -> dict[str, ServiceSpec]:
    global _registry
    if _registry is None:
        _registry = load_registry()
    return _registry


def get_spec(name: str) -> ServiceSpec:
    spec = get_registry().get(name)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"未知的编排服务: {name}")
    return spec


def reset_orchestrator() -> None:
    """测试隔离/运维重载:清注册表缓存 + 状态机 + 锁。"""
    global _registry
    _registry = None
    _states.clear()
    _locks.clear()


# ─────────────────────────── 状态机 ───────────────────────────


def _state(name: str) -> ServiceState:
    st = _states.get(name)
    if st is None:
        st = ServiceState()
        _states[name] = st
    return st


def _set_status(st: ServiceState, status: str, error: str = "") -> None:
    assert status in STATES, f"非法状态: {status}"
    st.status = status
    st.changed_at = time.time()
    if error:
        st.last_error = error


def mark_request(name: str) -> bool:
    """每次业务调用冷服务前打点(更新 last_request_at);未知服务记 warning 返回 False。"""
    if name not in get_registry():
        logger.warning("mark_request 未注册服务: %s", name)
        return False
    _state(name).last_request_at = time.time()
    return True


# ─────────────────────────── SSH / 健康检查(测试 mock 缝) ───────────────────────────


def _ssh_argv(spec: ServiceSpec, action: str) -> list[str]:
    """ssh argv(纯函数):BatchMode 防交互挂起;sudo -n 免密失败即报错不等密码。"""
    return [
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        get_settings().orch_ssh_target,
        f"sudo -n systemctl {action} {spec.systemd_unit}",
    ]


async def _run_systemctl(spec: ServiceSpec, action: str) -> tuple[int, str]:
    """经 SSH 在目标机执行 systemctl start/stop;返回 (returncode, stderr/stdout 尾部)。"""
    proc = await asyncio.create_subprocess_exec(
        *_ssh_argv(spec, action),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=SSH_CMD_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, f"ssh systemctl {action} 超时({SSH_CMD_TIMEOUT_SEC}s)"
    tail = ((err or out) or b"").decode(errors="replace")[-500:]
    return proc.returncode or 0, tail


async def _tcp_probe(host: str, port: int) -> bool:
    """TCP 连通探测;任何异常 → False。"""
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=HEALTH_CHECK_TIMEOUT_SEC
        )
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except Exception:
        return False


async def _check_health(spec: ServiceSpec) -> bool:
    """健康检查:health_path 非空 → HTTP GET(任何 HTTP 响应即存活,同 fleet 口径);
    空串 → TCP 连通探测。任何异常 → False(由调用方按轮询重试)。"""
    if spec.health_path:
        try:
            async with httpx.AsyncClient(timeout=HEALTH_CHECK_TIMEOUT_SEC) as client:
                await client.get(f"http://{spec.host}:{spec.port}{spec.health_path}")
            return True
        except Exception:
            return False
    return await _tcp_probe(spec.host, spec.port)


async def _wait_healthy(spec: ServiceSpec, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        if await _check_health(spec):
            return True
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(WAKE_POLL_INTERVAL_SEC)


# ─────────────────────────── 审计 ───────────────────────────


def _audit(action: str, spec: ServiceSpec, summary: str, detail: dict | None = None) -> None:
    """系统身份审计(独立短事务;失败仅留日志,不阻断编排动作)。"""
    try:
        with Session(engine) as session:
            session.add(
                AuditLog(
                    tenant_id="system",
                    user_id="system",
                    user_email="orchestrator",
                    action=action,
                    target_type="orch_service",
                    target_id=spec.name,
                    summary=summary,
                    detail=json.dumps(detail or {}, ensure_ascii=False),
                )
            )
            session.commit()
    except Exception as e:  # noqa: BLE001 — 审计故障不能拖垮启停链路
        logger.warning("orch 审计写入失败(%s %s): %s", action, spec.name, e)


# ─────────────────────────── 唤醒 ───────────────────────────


async def ensure_running(name: str) -> dict:
    """确保冷服务运行:sleeping/stopped/error → waking(SSH start)→ 健康轮询 → running。

    已在 running 直接返回(不发 SSH);并发唤醒经 per-service 锁串行化。
    SSH 失败 → 502;健康检查超时 → 504;两者均落 error 态 + 审计 orch.wake_failed。
    """
    spec = get_spec(name)
    mark_request(name)
    lock = _locks.setdefault(name, asyncio.Lock())
    async with lock:
        st = _state(name)
        if st.status == "running":
            return _snapshot(spec, st)
        _set_status(st, "waking")
        rc, tail = await _run_systemctl(spec, "start")
        if rc != 0:
            msg = f"systemctl start {spec.systemd_unit} 失败(rc={rc}): {tail}"
            _set_status(st, "error", msg)
            _audit("orch.wake_failed", spec, f"唤醒 {spec.name} 失败: {msg}",
                   {"rc": rc, "stderr_tail": tail})
            raise HTTPException(status_code=502, detail=msg)
        timeout = spec.wake_timeout_sec or get_settings().orch_wake_timeout_sec
        if not await _wait_healthy(spec, timeout):
            msg = f"唤醒 {spec.name} 超时({timeout:.0f}s 内健康检查未通过)"
            _set_status(st, "error", msg)
            _audit("orch.wake_failed", spec, msg, {"wake_timeout_sec": timeout})
            raise HTTPException(status_code=504, detail=msg)
        st.wake_count += 1
        _set_status(st, "running")
        _audit("orch.wake", spec,
               f"唤醒 {spec.name}({spec.systemd_unit} @ {spec.host})")
        return _snapshot(spec, st)


# ─────────────────────────── R2:业务路由接线 ───────────────────────────


async def ensure_awake(name: str, *, enabled: bool) -> bool:
    """R2 冷层路由接线:冷层业务端点收到请求时打点 + 按需唤醒。

    直通(返回 False,调用方原逻辑零行为变化):
      · enabled=False(路由侧读 settings.orch_wake_on_call,全局开关关);
      · 服务未在注册表(未知/热层服务绝不误碰);
      · 注册表条目 wake_on_call=false(单服务禁用自动唤醒)。
    启用路径:mark_request 打点;状态非 running(sleeping/stopped/error,
    及 waking 并发在途)→ ensure_running 同步等健康(超时上限 = 服务级
    wake_timeout_sec 或全局 orch_wake_timeout_sec,默认 120s)。
    唤醒失败(ensure_running 的 502/504)统一转 503:冷层未就绪对业务即
    「服务不可用」,按降级硬约束返回 error,不造假产物。
    """
    if not enabled:
        return False
    spec = get_registry().get(name)
    if spec is None or not spec.wake_on_call:
        return False
    mark_request(name)
    if _state(name).status == "running":
        return True
    try:
        await ensure_running(name)
    except HTTPException as e:
        raise HTTPException(
            status_code=503, detail=f"冷层服务 {name} 唤醒失败:{e.detail}"
        ) from e
    return True


# ─────────────────────────── 闲置回收 ───────────────────────────


def _has_active_jobs(spec: ServiceSpec) -> bool:
    """关联活跃作业检查(查询方式可配置:注册表 job_kinds 声明关联的 Job.kind)。

    job_kinds 空 = 无关联作业声明;查询失败按「有活跃作业」处理——保守不回收。
    """
    if not spec.job_kinds:
        return False
    try:
        with Session(engine) as session:
            row = session.exec(
                select(Job.id)
                .where(Job.kind.in_(spec.job_kinds))  # type: ignore[attr-defined]
                .where(Job.status.in_(ACTIVE_JOB_STATES))  # type: ignore[attr-defined]
                .limit(1)
            ).first()
        return row is not None
    except Exception as e:  # noqa: BLE001 — 查不到就当有,绝不能误停在跑作业
        logger.warning("orch 活跃作业查询失败,按有作业处理(%s): %s", spec.name, e)
        return True


async def idle_sweep(now: float | None = None) -> dict:
    """一轮闲置扫描;返回 {"stopped": [...]} 供日志与测试断言。

    保守纪律(默认不回收):仅 safe_idle=true 且 status=running 且 last_request_at
    非空且闲置超阈值且无关联活跃作业的服务才会被 stop;stop 失败落 error 态留日志。
    """
    now = time.time() if now is None else now
    settings = get_settings()
    stopped: list[str] = []
    for spec in get_registry().values():
        if spec.tier != "cold" or not spec.safe_idle:
            continue
        st = _state(spec.name)
        if st.status != "running" or st.last_request_at is None:
            continue
        idle_timeout = spec.idle_timeout_sec or settings.orch_idle_timeout_sec
        idle_sec = now - st.last_request_at
        if idle_sec < idle_timeout:
            continue
        if _has_active_jobs(spec):
            logger.info("orch %s 有关联活跃作业,跳过回收", spec.name)
            continue
        rc, tail = await _run_systemctl(spec, "stop")
        if rc != 0:
            msg = f"systemctl stop {spec.systemd_unit} 失败(rc={rc}): {tail}"
            _set_status(st, "error", msg)
            logger.warning("orch 回收 %s 失败: %s", spec.name, msg)
            continue
        st.stop_count += 1
        _set_status(st, "sleeping")
        stopped.append(spec.name)
        _audit("orch.sleep", spec,
               f"闲置 {idle_sec:.0f}s 回收 {spec.name}({spec.systemd_unit})",
               {"idle_sec": round(idle_sec, 1)})
    return {"stopped": stopped}


async def idle_sweep_loop() -> None:
    """闲置扫描后台循环(挂 main.py lifespan;异常不外冒,同 reconcile_loop 原则)。"""
    interval = max(5.0, get_settings().orch_sweep_interval_sec)
    while True:
        await asyncio.sleep(interval)
        try:
            result = await idle_sweep()
            if result["stopped"]:
                logger.info("orch 闲置回收: %s", result["stopped"])
        except Exception as e:  # noqa: BLE001 — 循环绝不能死
            logger.warning("orch 闲置扫描轮异常: %s", e)


# ─────────────────────────── 快照 / 列表 ───────────────────────────


def _iso(ts: float | None) -> str | None:
    return None if ts is None else datetime.fromtimestamp(ts, timezone.utc).isoformat()


def _snapshot(spec: ServiceSpec, st: ServiceState) -> dict:
    now = time.time()
    return {
        "name": spec.name,
        "systemd_unit": spec.systemd_unit,
        "host": spec.host,
        "port": spec.port,
        "health_path": spec.health_path,
        "tier": spec.tier,
        "safe_idle": spec.safe_idle,
        "idle_timeout_sec": spec.idle_timeout_sec or get_settings().orch_idle_timeout_sec,
        "status": st.status,
        "idle_sec": (
            round(now - st.last_request_at, 1)
            if st.last_request_at is not None
            else None
        ),
        "last_request_at": _iso(st.last_request_at),
        "wake_count": st.wake_count,
        "stop_count": st.stop_count,
        "last_error": st.last_error,
        "status_changed_at": _iso(st.changed_at),
    }


def list_services() -> dict:
    """GET /api/orch/services 载荷:状态/闲置时长/启停次数全量透出。"""
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "services": [
            _snapshot(spec, _state(spec.name)) for spec in get_registry().values()
        ],
    }
