"""FE leader-tab heartbeat + failover (Cycle 51).

Extends Cycle 50 single-subscriber leadership: the EventSource owner emits
heartbeats; if the lease expires, elect a follower, transfer ES ownership,
and keep shared_seq monotonic. Paper + scratch dry-run — flag default false,
no tip timers / BroadcastChannel mount, no invented progress.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from .stream_reconnect import ReconnectState, initial_state
from .stream_subscribe import SubscribePlan, plan_for
from .stream_tab_watermark import (
    DEFAULT_POLICY as DEFAULT_TAB_POLICY,
    TabSyncPolicy,
    TabWatermarkBus,
    apply_bus_to_reconnect,
    join_tab,
    publish_local,
)

LEADER_HB_PRODUCT_PATH = "fe_leader_heartbeat_failover"

FailoverOutcome = Literal[
    "heartbeat_ok",
    "leader_alive",
    "leader_stale",
    "failover_elected",
    "noop_no_candidate",
    "noop_no_leader",
]


@dataclass(frozen=True)
class HeartbeatPolicy:
    """Leader lease defaults (paper; tip uses real timers)."""

    interval_ms: int = 2000
    timeout_ms: int = 6000  # ~3 missed intervals → stale
    election: Literal["lowest_tab_id", "stable_oldest"] = "lowest_tab_id"
    transfer_es: bool = True
    preserve_watermark: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


DEFAULT_HB_POLICY = HeartbeatPolicy()


@dataclass
class LeaderWatch:
    """In-process stand-in for leader lease + failover over a TabWatermarkBus."""

    bus: TabWatermarkBus
    policy: HeartbeatPolicy = field(default_factory=HeartbeatPolicy)
    last_heartbeat_ms: dict[str, int] = field(default_factory=dict)
    clock_ms: int = 0
    events: list[dict[str, Any]] = field(default_factory=list)
    tip_mount: bool = False
    flag_default: bool = False
    needs_kouling: tuple[str, ...] = ("改码卡",)
    last_outcome: FailoverOutcome | None = None
    failover_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "clock_ms": self.clock_ms,
            "policy": self.policy.to_dict(),
            "last_heartbeat_ms": dict(self.last_heartbeat_ms),
            "events": list(self.events),
            "tip_mount": self.tip_mount,
            "flag_default": self.flag_default,
            "needs_kouling": list(self.needs_kouling),
            "last_outcome": self.last_outcome,
            "failover_count": self.failover_count,
            "leader_tab_id": self.leader_tab_id(),
            "shared_seq": self.bus.shared_seq,
            "bus": self.bus.to_dict(),
        }

    def leader_tab_id(self) -> str | None:
        for p in self.bus.peers.values():
            if p.is_leader:
                return p.tab_id
        return None


def _record(
    watch: LeaderWatch,
    *,
    kind: str,
    tab_id: str | None,
    outcome: FailoverOutcome,
    detail: dict[str, Any] | None = None,
) -> None:
    watch.last_outcome = outcome
    ev: dict[str, Any] = {
        "kind": kind,
        "tab_id": tab_id,
        "outcome": outcome,
        "clock_ms": watch.clock_ms,
        "shared_seq": watch.bus.shared_seq,
        "leader_tab_id": watch.leader_tab_id(),
    }
    if detail:
        ev.update(detail)
    watch.events.append(ev)


def advance_clock(watch: LeaderWatch, delta_ms: int) -> int:
    watch.clock_ms = int(watch.clock_ms) + max(0, int(delta_ms))
    return watch.clock_ms


def beat(watch: LeaderWatch, tab_id: str, *, now_ms: int | None = None) -> FailoverOutcome:
    """Record a heartbeat. Leaders renew the lease; followers only mark presence."""
    if tab_id not in watch.bus.peers:
        raise KeyError(f"unknown tab_id: {tab_id}")
    if now_ms is not None:
        watch.clock_ms = max(int(watch.clock_ms), int(now_ms))
    ts = int(watch.clock_ms)
    watch.last_heartbeat_ms[tab_id] = ts
    peer = watch.bus.peers[tab_id]
    if peer.is_leader:
        _record(watch, kind="beat", tab_id=tab_id, outcome="heartbeat_ok")
        return "heartbeat_ok"
    _record(watch, kind="beat", tab_id=tab_id, outcome="leader_alive")
    return "leader_alive"


def leader_age_ms(watch: LeaderWatch) -> int | None:
    lid = watch.leader_tab_id()
    if lid is None:
        return None
    last = watch.last_heartbeat_ms.get(lid)
    if last is None:
        return int(watch.policy.timeout_ms) + 1  # never beat → stale
    return max(0, int(watch.clock_ms) - int(last))


def is_leader_stale(watch: LeaderWatch) -> bool:
    age = leader_age_ms(watch)
    if age is None:
        return False
    return age > int(watch.policy.timeout_ms)


def _pick_candidate(watch: LeaderWatch, *, exclude: str | None) -> str | None:
    ids = [tid for tid in watch.bus.peers.keys() if tid != exclude]
    if not ids:
        return None
    if watch.policy.election == "stable_oldest":
        # Join order ≈ events with kind=join on the bus; fall back to sorted.
        joined: list[str] = []
        for ev in watch.bus.events:
            if ev.get("kind") == "join" and ev.get("tab_id") in ids:
                tid = str(ev["tab_id"])
                if tid not in joined:
                    joined.append(tid)
        for tid in ids:
            if tid not in joined:
                joined.append(tid)
        return joined[0] if joined else None
    return sorted(ids)[0]


def failover_if_stale(watch: LeaderWatch) -> FailoverOutcome:
    """If leader lease expired, demote and elect one follower; keep watermark."""
    lid = watch.leader_tab_id()
    if lid is None:
        _record(watch, kind="failover", tab_id=None, outcome="noop_no_leader")
        return "noop_no_leader"

    if not is_leader_stale(watch):
        _record(watch, kind="check", tab_id=lid, outcome="leader_alive")
        return "leader_alive"

    _record(
        watch,
        kind="stale",
        tab_id=lid,
        outcome="leader_stale",
        detail={"age_ms": leader_age_ms(watch), "timeout_ms": watch.policy.timeout_ms},
    )

    before_seq = int(watch.bus.shared_seq)
    old = watch.bus.peers[lid]
    old.is_leader = False
    old.connected = False

    cand = _pick_candidate(watch, exclude=lid)
    if cand is None:
        _record(watch, kind="failover", tab_id=lid, outcome="noop_no_candidate")
        return "noop_no_candidate"

    for p in watch.bus.peers.values():
        p.is_leader = False
        if watch.policy.transfer_es:
            p.connected = False

    new = watch.bus.peers[cand]
    new.is_leader = True
    if watch.policy.transfer_es:
        new.connected = True

    if watch.policy.preserve_watermark:
        assert int(watch.bus.shared_seq) == before_seq
        for p in watch.bus.peers.values():
            p.since_seq = max(int(p.since_seq), before_seq)

    # New leader starts a fresh lease immediately.
    watch.last_heartbeat_ms[cand] = int(watch.clock_ms)
    watch.failover_count += 1
    _record(
        watch,
        kind="failover",
        tab_id=cand,
        outcome="failover_elected",
        detail={"demoted": lid, "shared_seq": watch.bus.shared_seq},
    )
    return "failover_elected"


def seed_watch(
    *,
    surface: str,
    initial_seqs: dict[str, int],
    leader_tab: str,
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
    start_ms: int = 0,
) -> LeaderWatch:
    bus = TabWatermarkBus(surface=surface, policy=tab_policy)
    ordered = sorted(initial_seqs.keys(), key=lambda t: (0 if t == leader_tab else 1, t))
    for tid in ordered:
        join_tab(
            bus,
            tid,
            since_seq=int(initial_seqs[tid]),
            want_leader=(tid == leader_tab),
        )
    watch = LeaderWatch(bus=bus, policy=hb_policy, clock_ms=int(start_ms))
    # Initial lease for current leader
    lid = watch.leader_tab_id()
    if lid is not None:
        watch.last_heartbeat_ms[lid] = int(start_ms)
        _record(watch, kind="seed", tab_id=lid, outcome="heartbeat_ok")
    return watch


def failover_cycle(
    plan: SubscribePlan,
    *,
    initial_seqs: dict[str, int] | None = None,
    leader_tab: str = "tab-a",
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
) -> dict[str, Any]:
    """Dry-run: seed → beats → miss timeout → elect follower → watermark intact."""
    initial_seqs = initial_seqs or {"tab-a": 4, "tab-b": 9, "tab-c": 6}
    watch = seed_watch(
        surface=plan.surface,
        initial_seqs=initial_seqs,
        leader_tab=leader_tab,
        tab_policy=tab_policy,
        hb_policy=hb_policy,
        start_ms=0,
    )

    # Leader beats twice on schedule
    advance_clock(watch, hb_policy.interval_ms)
    beat(watch, leader_tab)
    advance_clock(watch, hb_policy.interval_ms)
    beat(watch, leader_tab)

    # Leader publishes watermark advance while alive
    advanced = int(watch.bus.shared_seq) + 3
    publish_local(watch.bus, leader_tab, advanced)
    seq_before_fail = int(watch.bus.shared_seq)

    # Miss heartbeats past timeout
    advance_clock(watch, hb_policy.timeout_ms + hb_policy.interval_ms)
    assert is_leader_stale(watch)
    outcome = failover_if_stale(watch)
    assert outcome == "failover_elected"
    new_leader = watch.leader_tab_id()
    assert new_leader is not None and new_leader != leader_tab
    assert int(watch.bus.shared_seq) == seq_before_fail
    assert all(p.since_seq == seq_before_fail for p in watch.bus.peers.values())
    assert watch.bus.peers[leader_tab].is_leader is False
    assert watch.bus.peers[leader_tab].connected is False
    assert watch.bus.peers[new_leader].is_leader is True
    assert watch.bus.peers[new_leader].connected is True

    # New leader renews; not stale
    beat(watch, new_leader)
    assert failover_if_stale(watch) == "leader_alive"

    reconnect = initial_state(plan.surface, since_seq=0)
    apply_bus_to_reconnect(reconnect, watch.bus)

    return {
        "product_path": LEADER_HB_PRODUCT_PATH,
        "surface": plan.surface,
        "enabled": True,
        "reason": None,
        "flag_default": False,
        "tip_mount": False,
        "live_frames": False,
        "needs_kouling": ["改码卡"],
        "policy": hb_policy.to_dict(),
        "tab_policy": tab_policy.to_dict(),
        "watch": watch.to_dict(),
        "reconnect": reconnect.to_dict(),
        "since_seq": watch.bus.shared_seq,
        "next_seq": watch.bus.shared_seq,
        "leader_tab_id": new_leader,
        "demoted_tab_id": leader_tab,
        "failover_count": watch.failover_count,
        "peer_count": len(watch.bus.peers),
        "event_count": len(watch.events),
        "catchup_product_paths": list(plan.catchup_product_paths),
        "plan": plan.to_dict(),
        "notes": (
            "Cycle 51: leader heartbeat lease + failover elect; "
            "ES ownership transfers; watermark never regresses; tip timers wait 改码卡"
        ),
    }


def checklist_static_payload(
    *,
    surface: str = "task_center",
    since_seq: int = 0,
    plan: SubscribePlan | None = None,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
) -> dict[str, Any]:
    """Flag-off: lease rules only; no clock traffic."""
    return {
        "product_path": LEADER_HB_PRODUCT_PATH,
        "enabled": False,
        "reason": "ray_control_disabled",
        "flag_default": False,
        "tip_mount": False,
        "live_frames": False,
        "surface": surface if plan is None else plan.surface,
        "since_seq": int(since_seq or 0),
        "next_seq": int(since_seq or 0),
        "policy": hb_policy.to_dict(),
        "tab_policy": tab_policy.to_dict(),
        "rules": {
            "lease": "leader must beat every interval_ms; stale when age > timeout_ms",
            "failover": "demote stale leader; elect one candidate; transfer ES if transfer_es",
            "election": "lowest_tab_id (default) or stable_oldest join order",
            "watermark": "shared_seq unchanged across failover; never invent progress",
            "honesty": "null progress stays null; C48/C49 banner/backoff owned by new leader",
        },
        "peer_count": 0,
        "event_count": 0,
        "failover_count": 0,
        "ui_phase_hint": "offline",
        "label_zh_hint": "连接已断开",
        "catchup_product_paths": [] if plan is None else list(plan.catchup_product_paths),
        "needs_kouling": ["改码卡"],
        "ties": {
            "C46": "ReconnectState.since_seq watermark",
            "C47": "onerror keeps watermark across reopen",
            "C48/C49": "new leader owns UI FSM + backoff after failover",
            "C50": "single_subscriber bus; max(watermark) merge",
            "C51": "leader lease heartbeat + failover elect",
        },
        "plan": None if plan is None else plan.to_dict(),
        "notes": "flag off: leader heartbeat / failover paper only; no tip timers",
    }


def plan_or_none(surface: str) -> SubscribePlan | None:
    return plan_for(surface)
