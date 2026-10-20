#!/usr/bin/env python3
"""Deploy drain / gen-window guard (P-25 / AGENTS §〇).

旧守卫只 ``pgrep tmp/batch*_*.py``,覆盖不到 studio 生成窗(studio_batch_render /
parse / Comfy Job / 烟测 campaign running>0),api 重启会误杀在飞作业。

本脚本在重启 toiv-api **之前**汇总忙因;任一忙因非空则 exit 3。

用法::

    # 纯逻辑/单测:喂快照
    python3 deploy/deploy_drain.py --snapshot-json '{"smoke_running":1,"jobs":[]}'

    # 干跑(打印判定,不查真库)
    python3 deploy/deploy_drain.py --dry-run --snapshot-json '{"batch_drivers":["x"],"smoke_running":0,"jobs":[]}'

    # 远端/本机实探(读 toiv-api 进程环境的 TOIV_DATABASE_URL + pgrep)
    python3 deploy/deploy_drain.py --probe-local

    # 可选等待排水
    python3 deploy/deploy_drain.py --probe-local --wait-sec 120 --poll-interval 5

环境:
  TOIV_API_PID / systemctl MainPID 用于取 environ
  TOIV_DATABASE_URL 可显式注入(测用);未设则从 api 进程 environ 读
  FORCE 旁路由 deploy.sh 的 FORCE_API_RESTART=1 负责,本脚本无旁路
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

# Job 忙态:进程内 tracker / 后台协程随 api 重启消失
ACTIVE_JOB_STATUSES = frozenset({"queued", "running"})

# 明确点名的 studio / 短剧 / 成片窗(日志更可读);其余 kind 仍计入「其他在飞 Job」
STUDIO_GEN_KIND_PREFIXES = ("studio_", "drama_")
STUDIO_GEN_KIND_EXACT = frozenset(
    {
        "board_film",
        "video_upscale",
        "scope_camera",
        "app_run",
        "app_video",
        "app_image",
        "app_audio",
        "app_3d",
    }
)

BATCH_DRIVER_PGREP = r"tmp/batch[0-9]+_[^ ]*\.py"

EXIT_BUSY = 3
EXIT_USAGE = 2


@dataclass(frozen=True)
class JobCount:
    kind: str
    status: str
    count: int


@dataclass
class BusySnapshot:
    batch_drivers: list[str] = field(default_factory=list)
    smoke_running: int = 0
    jobs: list[JobCount] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "batch_drivers": list(self.batch_drivers),
            "smoke_running": int(self.smoke_running),
            "jobs": [asdict(j) if isinstance(j, JobCount) else j for j in self.jobs],
            "notes": list(self.notes),
        }


@dataclass(frozen=True)
class BusyReason:
    code: str
    detail: str


def parse_snapshot(raw: dict[str, Any] | None) -> BusySnapshot:
    raw = raw or {}
    jobs_in = raw.get("jobs") or []
    jobs: list[JobCount] = []
    for item in jobs_in:
        if isinstance(item, JobCount):
            jobs.append(item)
            continue
        if not isinstance(item, dict):
            continue
        jobs.append(
            JobCount(
                kind=str(item.get("kind") or ""),
                status=str(item.get("status") or ""),
                count=int(item.get("count") or 0),
            )
        )
    drivers = raw.get("batch_drivers") or []
    return BusySnapshot(
        batch_drivers=[str(x) for x in drivers if str(x).strip()],
        smoke_running=int(raw.get("smoke_running") or 0),
        jobs=jobs,
        notes=[str(x) for x in (raw.get("notes") or [])],
    )


def is_studio_gen_kind(kind: str) -> bool:
    k = (kind or "").strip()
    if not k:
        return False
    if k in STUDIO_GEN_KIND_EXACT:
        return True
    return any(k.startswith(p) for p in STUDIO_GEN_KIND_PREFIXES)


def evaluate_busy(snapshot: BusySnapshot | dict[str, Any]) -> list[BusyReason]:
    """纯函数:根据快照返回忙因列表(空=可重启 api)。"""
    snap = snapshot if isinstance(snapshot, BusySnapshot) else parse_snapshot(snapshot)
    reasons: list[BusyReason] = []

    if snap.batch_drivers:
        preview = "; ".join(snap.batch_drivers[:5])
        more = f" (+{len(snap.batch_drivers) - 5} more)" if len(snap.batch_drivers) > 5 else ""
        reasons.append(
            BusyReason(
                code="batch_driver",
                detail=f"渲染批跑驱动在跑 ({len(snap.batch_drivers)}): {preview}{more}",
            )
        )

    if snap.smoke_running > 0:
        reasons.append(
            BusyReason(
                code="smoke_campaign",
                detail=f"烟测 campaign running>0 (smoke_status=running 卡={snap.smoke_running})",
            )
        )

    studio_n = 0
    other_n = 0
    studio_parts: list[str] = []
    other_parts: list[str] = []
    for j in snap.jobs:
        if j.count <= 0:
            continue
        if j.status not in ACTIVE_JOB_STATUSES:
            continue
        label = f"{j.kind}:{j.status}×{j.count}"
        if is_studio_gen_kind(j.kind):
            studio_n += j.count
            studio_parts.append(label)
        else:
            other_n += j.count
            other_parts.append(label)

    if studio_n > 0:
        reasons.append(
            BusyReason(
                code="studio_gen_window",
                detail=f"studio/短剧生成窗在飞 Job={studio_n} [{', '.join(studio_parts[:12])}]",
            )
        )
    if other_n > 0:
        reasons.append(
            BusyReason(
                code="active_jobs",
                detail=f"其他在飞 Job(queued/running)={other_n} [{', '.join(other_parts[:12])}]",
            )
        )

    return reasons


def format_busy_report(reasons: list[BusyReason]) -> str:
    if not reasons:
        return "OK: deploy drain clear (no gen-window / campaign / batch driver)"
    lines = ["✖ deploy drain busy — 拒绝重启 toiv-api (FORCE_API_RESTART=1 可强制):"]
    for r in reasons:
        lines.append(f"  - [{r.code}] {r.detail}")
    lines.append("  等待 running=0 / 批跑结束后再部署;见 docs/ops/DEPLOY_DRAIN_STUDIO_20261020.md")
    return "\n".join(lines)


# ----- collectors (injectable for tests) -----


def collect_batch_drivers_from_pgrep(
    run: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> list[str]:
    runner = run or subprocess.run
    # P-4: pgrep -af 模式;过滤 pgrep 自身
    # 与 deploy.sh 历史口径一致;单引号包住 BRE
    proc = runner(
        ["bash", "-lc", r"pgrep -af 'tmp/batch[0-9]+_[^ ]*\.py' | grep -v pgrep || true"],
        capture_output=True,
        text=True,
        check=False,
    )
    lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    return lines


def _read_environ_file(pid: int) -> dict[str, str]:
    path = Path(f"/proc/{pid}/environ")
    if not path.is_file():
        return {}
    raw = path.read_bytes().split(b"\0")
    out: dict[str, str] = {}
    for chunk in raw:
        if not chunk or b"=" not in chunk:
            continue
        k, _, v = chunk.partition(b"=")
        try:
            out[k.decode()] = v.decode()
        except UnicodeDecodeError:
            continue
    return out


def resolve_api_pid() -> int | None:
    env_pid = os.environ.get("TOIV_API_PID", "").strip()
    if env_pid.isdigit():
        return int(env_pid)
    try:
        proc = subprocess.run(
            ["systemctl", "show", "-p", "MainPID", "--value", "toiv-api"],
            capture_output=True,
            text=True,
            check=False,
        )
        val = (proc.stdout or "").strip()
        if val.isdigit() and int(val) > 0:
            return int(val)
    except OSError:
        pass
    return None


def resolve_database_url() -> str | None:
    explicit = (os.environ.get("TOIV_DATABASE_URL") or "").strip()
    if explicit:
        return explicit
    pid = resolve_api_pid()
    if not pid:
        return None
    env = _read_environ_file(pid)
    return (env.get("TOIV_DATABASE_URL") or "").strip() or None


def _normalize_pg_url(url: str) -> str:
    """SQLAlchemy 风格 postgresql+psycopg:// → psycopg 可连的 postgresql://。"""
    if url.startswith("postgresql+psycopg://"):
        return "postgresql://" + url[len("postgresql+psycopg://") :]
    if url.startswith("postgresql+psycopg2://"):
        return "postgresql://" + url[len("postgresql+psycopg2://") :]
    return url


def collect_jobs_and_smoke_from_db(
    database_url: str,
    connect: Callable[..., Any] | None = None,
) -> tuple[list[JobCount], int]:
    """查询 Job queued/running 分组 + App.smoke_status=running 计数。

    ``connect`` 可注入(单测 mock);默认用 psycopg.connect。
    """
    url = _normalize_pg_url(database_url)
    if "sqlite" in url.lower():
        raise RuntimeError("deploy drain 拒绝 SQLite(须生产 PG;见 P-18)")

    if connect is None:
        try:
            import psycopg  # type: ignore
        except ImportError as e:  # pragma: no cover
            raise RuntimeError("需要 psycopg(请用 api/.venv/bin/python 跑本脚本)") from e

        def connect(u: str) -> Any:
            return psycopg.connect(u)

    jobs: list[JobCount] = []
    smoke = 0
    with connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT kind, status, COUNT(*)::int
                FROM job
                WHERE status = ANY(%s)
                GROUP BY kind, status
                ORDER BY COUNT(*) DESC, kind
                """,
                (list(ACTIVE_JOB_STATUSES),),
            )
            for kind, status, count in cur.fetchall():
                jobs.append(JobCount(kind=str(kind), status=str(status), count=int(count)))

            cur.execute(
                """
                SELECT COUNT(*)::int FROM app
                WHERE smoke_status = 'running'
                """
            )
            row = cur.fetchone()
            smoke = int(row[0]) if row else 0
    return jobs, smoke


def probe_local(
    *,
    pgrep_run: Callable[..., subprocess.CompletedProcess[str]] | None = None,
    db_connect: Callable[..., Any] | None = None,
    database_url: str | None = None,
) -> BusySnapshot:
    notes: list[str] = []
    drivers = collect_batch_drivers_from_pgrep(run=pgrep_run)
    url = (database_url or resolve_database_url() or "").strip()
    jobs: list[JobCount] = []
    smoke = 0
    if not url:
        notes.append("无 TOIV_DATABASE_URL(未设且无法从 toiv-api environ 读取)— 仅 pgrep 批跑守卫生效")
    else:
        try:
            jobs, smoke = collect_jobs_and_smoke_from_db(url, connect=db_connect)
        except Exception as e:  # noqa: BLE001 — 探测失败应视为忙(fail-closed)
            notes.append(f"DB 探测失败(fail-closed): {e}")
            # 合成一条假 job 让 evaluate 拦下;同时保留 note
            jobs = [JobCount(kind="_drain_probe_error", status="running", count=1)]
    return BusySnapshot(batch_drivers=drivers, smoke_running=smoke, jobs=jobs, notes=notes)


def run_check(
    snapshot: BusySnapshot,
    *,
    dry_run: bool = False,
) -> int:
    reasons = evaluate_busy(snapshot)
    for n in snapshot.notes:
        print(f"  note: {n}", file=sys.stderr)
    report = format_busy_report(reasons)
    if dry_run:
        print("[dry-run] " + report.replace("\n", "\n[dry-run] "))
        print("[dry-run] snapshot=" + json.dumps(snapshot.to_dict(), ensure_ascii=False))
        return 0 if not reasons else EXIT_BUSY
    if reasons:
        print(report, file=sys.stderr)
        return EXIT_BUSY
    print(report)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Deploy drain: block toiv-api restart during gen window")
    parser.add_argument("--snapshot-json", help="BusySnapshot JSON(测用/干跑)")
    parser.add_argument("--snapshot-file", type=Path, help="从文件读快照 JSON")
    parser.add_argument("--probe-local", action="store_true", help="本机 pgrep + PG 实探")
    parser.add_argument("--dry-run", action="store_true", help="打印判定;忙时仍返回 3")
    parser.add_argument("--wait-sec", type=int, default=0, help="忙则轮询等待至多 N 秒再判定")
    parser.add_argument("--poll-interval", type=int, default=5, help="等待轮询间隔秒")
    parser.add_argument("--database-url", default="", help="覆盖 TOIV_DATABASE_URL(测用)")
    args = parser.parse_args(argv)

    def once() -> tuple[BusySnapshot, int]:
        if args.snapshot_json or args.snapshot_file:
            if args.snapshot_file:
                data = json.loads(args.snapshot_file.read_text(encoding="utf-8"))
            else:
                data = json.loads(args.snapshot_json or "{}")
            snap = parse_snapshot(data)
        elif args.probe_local:
            snap = probe_local(database_url=args.database_url or None)
        else:
            parser.error("请指定 --probe-local 或 --snapshot-json/--snapshot-file")
            raise SystemExit(EXIT_USAGE)
        return snap, run_check(snap, dry_run=args.dry_run)

    snap, code = once()
    if code == 0 or args.wait_sec <= 0:
        return code

    deadline = time.time() + args.wait_sec
    interval = max(1, int(args.poll_interval))
    while time.time() < deadline:
        print(f"… drain 等待中({int(deadline - time.time())}s 剩余)", file=sys.stderr)
        time.sleep(interval)
        snap, code = once()
        if code == 0:
            return 0
    print("✖ drain 等待超时,仍 busy", file=sys.stderr)
    return EXIT_BUSY


if __name__ == "__main__":
    raise SystemExit(main())
