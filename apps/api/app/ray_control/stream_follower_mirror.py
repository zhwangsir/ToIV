"""FE follower read-only mirror + leader badge (Cycle 52).

Followers never own EventSource; they mirror shared_seq / progress from the
leader bus and show honest role badges. Paper + scratch dry-run — flag default
false, no tip BroadcastChannel / DOM mount, no invented progress.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from .stream_leader_heartbeat import (
    DEFAULT_HB_POLICY,
    HeartbeatPolicy,
    LeaderWatch,
    advance_clock,
    beat,
    failover_if_stale,
    seed_watch,
)
from .stream_reconnect import ReconnectState, initial_state
from .stream_subscribe import SubscribePlan, plan_for
from .stream_tab_watermark import (
    DEFAULT_POLICY as DEFAULT_TAB_POLICY,
    TabSyncPolicy,
    apply_bus_to_reconnect,
    publish_local,
)

FOLLOWER_MIRROR_PRODUCT_PATH = "fe_follower_mirror_badge"

RoleKind = Literal["leader", "follower", "orphan"]
MirrorOutcome = Literal[
    "mirrored",
    "badge_ok",
    "rejected_follower_write",
    "leader_publish_ok",
    "role_switched",
    "noop_no_peer",
]

# ToIV-original short labels (zh); never paste competitor UI copy.
BADGE_LABELS_ZH: dict[str, str] = {
    "leader": "领导",
    "follower": "跟随·只读",
    "orphan": "未接入",
}


@dataclass(frozen=True)
class MirrorPolicy:
    """Follower mirror + badge defaults (paper; tip uses real DOM)."""

    read_only_followers: bool = True
    show_leader_badge: bool = True
    show_follower_badge: bool = True
    mirror_shared_seq: bool = True
    block_follower_mutate: bool = True
    # Followers may soft-refresh local view from shared_seq only.
    allow_follower_refresh: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


DEFAULT_MIRROR_POLICY = MirrorPolicy()


@dataclass
class FollowerMirrorView:
    """Per-tab mirror projection + badge for dry-run / paper."""

    tab_id: str
    role: RoleKind
    badge_zh: str
    mirrored_seq: int = 0
    can_mutate: bool = False
    can_own_es: bool = False
    last_outcome: MirrorOutcome | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class MirrorBoard:
    """In-process stand-in for follower mirror + leader badge UI."""

    watch: LeaderWatch
    policy: MirrorPolicy = field(default_factory=MirrorPolicy)
    views: dict[str, FollowerMirrorView] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    tip_mount: bool = False
    flag_default: bool = False
    needs_kouling: tuple[str, ...] = ("改码卡",)
    last_outcome: MirrorOutcome | None = None
    reject_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy": self.policy.to_dict(),
            "views": {k: v.to_dict() for k, v in self.views.items()},
            "events": list(self.events),
            "tip_mount": self.tip_mount,
            "flag_default": self.flag_default,
            "needs_kouling": list(self.needs_kouling),
            "last_outcome": self.last_outcome,
            "reject_count": self.reject_count,
            "shared_seq": self.watch.bus.shared_seq,
            "leader_tab_id": self.watch.leader_tab_id(),
            "watch": self.watch.to_dict(),
        }


def _role_for(watch: LeaderWatch, tab_id: str) -> RoleKind:
    peer = watch.bus.peers.get(tab_id)
    if peer is None:
        return "orphan"
    if peer.is_leader:
        return "leader"
    return "follower"


def _badge_zh(role: RoleKind, policy: MirrorPolicy) -> str:
    if role == "leader" and not policy.show_leader_badge:
        return ""
    if role == "follower" and not policy.show_follower_badge:
        return ""
    return BADGE_LABELS_ZH[role]


def _record(
    board: MirrorBoard,
    *,
    kind: str,
    tab_id: str | None,
    outcome: MirrorOutcome,
    detail: dict[str, Any] | None = None,
) -> None:
    board.last_outcome = outcome
    ev: dict[str, Any] = {
        "kind": kind,
        "tab_id": tab_id,
        "outcome": outcome,
        "shared_seq": board.watch.bus.shared_seq,
        "leader_tab_id": board.watch.leader_tab_id(),
    }
    if detail:
        ev.update(detail)
    board.events.append(ev)


def refresh_views(board: MirrorBoard) -> None:
    """Rebuild per-tab mirror views from current leader/follower roles."""
    shared = int(board.watch.bus.shared_seq)
    for tid, peer in board.watch.bus.peers.items():
        role = _role_for(board.watch, tid)
        can_mutate = role == "leader" or not board.policy.block_follower_mutate
        can_own_es = role == "leader"
        mirrored = shared if board.policy.mirror_shared_seq else int(peer.since_seq)
        board.views[tid] = FollowerMirrorView(
            tab_id=tid,
            role=role,
            badge_zh=_badge_zh(role, board.policy),
            mirrored_seq=mirrored,
            can_mutate=can_mutate,
            can_own_es=can_own_es,
            last_outcome="badge_ok",
        )
    # Drop views for peers that left
    for tid in list(board.views.keys()):
        if tid not in board.watch.bus.peers:
            del board.views[tid]


def seed_board(
    *,
    surface: str,
    initial_seqs: dict[str, int],
    leader_tab: str,
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
    mirror_policy: MirrorPolicy = DEFAULT_MIRROR_POLICY,
    start_ms: int = 0,
) -> MirrorBoard:
    watch = seed_watch(
        surface=surface,
        initial_seqs=initial_seqs,
        leader_tab=leader_tab,
        tab_policy=tab_policy,
        hb_policy=hb_policy,
        start_ms=start_ms,
    )
    board = MirrorBoard(watch=watch, policy=mirror_policy)
    refresh_views(board)
    _record(board, kind="seed", tab_id=leader_tab, outcome="badge_ok")
    return board


def mirror_from_shared(board: MirrorBoard, tab_id: str) -> MirrorOutcome:
    """Follower (or any peer) adopts shared_seq into local mirror view."""
    if tab_id not in board.watch.bus.peers:
        _record(board, kind="mirror", tab_id=tab_id, outcome="noop_no_peer")
        return "noop_no_peer"
    refresh_views(board)
    view = board.views[tab_id]
    view.mirrored_seq = int(board.watch.bus.shared_seq)
    view.last_outcome = "mirrored"
    peer = board.watch.bus.peers[tab_id]
    if board.policy.mirror_shared_seq:
        peer.since_seq = max(int(peer.since_seq), int(board.watch.bus.shared_seq))
    _record(board, kind="mirror", tab_id=tab_id, outcome="mirrored")
    return "mirrored"


def try_publish(
    board: MirrorBoard,
    tab_id: str,
    seq: int,
) -> MirrorOutcome:
    """Leader may advance watermark; followers are rejected when read-only."""
    if tab_id not in board.watch.bus.peers:
        _record(board, kind="publish", tab_id=tab_id, outcome="noop_no_peer")
        return "noop_no_peer"

    role = _role_for(board.watch, tab_id)
    if role != "leader" and board.policy.block_follower_mutate:
        board.reject_count += 1
        if tab_id in board.views:
            board.views[tab_id].last_outcome = "rejected_follower_write"
        _record(
            board,
            kind="publish",
            tab_id=tab_id,
            outcome="rejected_follower_write",
            detail={"attempted_seq": int(seq), "role": role},
        )
        return "rejected_follower_write"

    publish_local(board.watch.bus, tab_id, int(seq))
    refresh_views(board)
    _record(board, kind="publish", tab_id=tab_id, outcome="leader_publish_ok")
    return "leader_publish_ok"


def apply_failover_and_rebadge(board: MirrorBoard) -> MirrorOutcome:
    """After C51 failover, rebuild badges so new leader shows 领导."""
    outcome = failover_if_stale(board.watch)
    refresh_views(board)
    if outcome == "failover_elected":
        _record(board, kind="rebadge", tab_id=board.watch.leader_tab_id(), outcome="role_switched")
        return "role_switched"
    # Still refresh badges even when no election
    _record(
        board,
        kind="rebadge",
        tab_id=board.watch.leader_tab_id(),
        outcome="badge_ok",
        detail={"failover_outcome": outcome},
    )
    return "badge_ok"


def mirror_cycle(
    plan: SubscribePlan,
    *,
    initial_seqs: dict[str, int] | None = None,
    leader_tab: str = "tab-a",
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
    mirror_policy: MirrorPolicy = DEFAULT_MIRROR_POLICY,
) -> dict[str, Any]:
    """Dry-run: seed → leader publish → follower rejected write → mirror → failover rebadge."""
    initial_seqs = initial_seqs or {"tab-a": 4, "tab-b": 9, "tab-c": 6}
    board = seed_board(
        surface=plan.surface,
        initial_seqs=initial_seqs,
        leader_tab=leader_tab,
        tab_policy=tab_policy,
        hb_policy=hb_policy,
        mirror_policy=mirror_policy,
        start_ms=0,
    )

    # Leader advances watermark
    target = int(board.watch.bus.shared_seq) + 3
    assert try_publish(board, leader_tab, target) == "leader_publish_ok"
    seq_after = int(board.watch.bus.shared_seq)

    # Follower cannot mutate
    followers = [t for t in board.views if board.views[t].role == "follower"]
    assert followers
    follower = sorted(followers)[0]
    assert try_publish(board, follower, seq_after + 10) == "rejected_follower_write"
    assert int(board.watch.bus.shared_seq) == seq_after

    # Follower mirrors shared_seq
    assert mirror_from_shared(board, follower) == "mirrored"
    assert board.views[follower].mirrored_seq == seq_after
    assert board.views[follower].badge_zh == BADGE_LABELS_ZH["follower"]
    assert board.views[leader_tab].badge_zh == BADGE_LABELS_ZH["leader"]
    assert board.views[follower].can_mutate is False
    assert board.views[leader_tab].can_own_es is True

    # Miss lease → failover → badges swap
    advance_clock(board.watch, hb_policy.timeout_ms + hb_policy.interval_ms)
    assert apply_failover_and_rebadge(board) == "role_switched"
    new_leader = board.watch.leader_tab_id()
    assert new_leader is not None and new_leader != leader_tab
    assert board.views[new_leader].role == "leader"
    assert board.views[new_leader].badge_zh == BADGE_LABELS_ZH["leader"]
    assert board.views[leader_tab].role == "follower"
    assert board.views[leader_tab].badge_zh == BADGE_LABELS_ZH["follower"]
    assert int(board.watch.bus.shared_seq) == seq_after

    beat(board.watch, new_leader)
    reconnect = initial_state(plan.surface, since_seq=0)
    apply_bus_to_reconnect(reconnect, board.watch.bus)

    return {
        "product_path": FOLLOWER_MIRROR_PRODUCT_PATH,
        "surface": plan.surface,
        "enabled": True,
        "reason": None,
        "flag_default": False,
        "tip_mount": False,
        "live_frames": False,
        "needs_kouling": ["改码卡"],
        "policy": mirror_policy.to_dict(),
        "hb_policy": hb_policy.to_dict(),
        "tab_policy": tab_policy.to_dict(),
        "board": board.to_dict(),
        "reconnect": reconnect.to_dict(),
        "since_seq": board.watch.bus.shared_seq,
        "next_seq": board.watch.bus.shared_seq,
        "leader_tab_id": new_leader,
        "demoted_tab_id": leader_tab,
        "reject_count": board.reject_count,
        "peer_count": len(board.watch.bus.peers),
        "event_count": len(board.events),
        "badges": {tid: v.badge_zh for tid, v in board.views.items()},
        "catchup_product_paths": list(plan.catchup_product_paths),
        "plan": plan.to_dict(),
        "notes": (
            "Cycle 52: follower read-only mirror + leader/follower badges; "
            "follower writes rejected; watermark intact across failover; tip DOM waits 改码卡"
        ),
    }


def checklist_static_payload(
    *,
    surface: str = "task_center",
    since_seq: int = 0,
    plan: SubscribePlan | None = None,
    mirror_policy: MirrorPolicy = DEFAULT_MIRROR_POLICY,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
) -> dict[str, Any]:
    """Flag-off: mirror + badge rules only; no bus traffic."""
    return {
        "product_path": FOLLOWER_MIRROR_PRODUCT_PATH,
        "enabled": False,
        "reason": "ray_control_disabled",
        "flag_default": False,
        "tip_mount": False,
        "live_frames": False,
        "surface": surface if plan is None else plan.surface,
        "since_seq": int(since_seq or 0),
        "next_seq": int(since_seq or 0),
        "policy": mirror_policy.to_dict(),
        "hb_policy": hb_policy.to_dict(),
        "tab_policy": tab_policy.to_dict(),
        "badge_labels_zh": dict(BADGE_LABELS_ZH),
        "rules": {
            "mirror": "followers adopt shared_seq; never invent progress",
            "read_only": "block_follower_mutate rejects follower publish attempts",
            "badge": "领导 on ES owner; 跟随·只读 on others; 未接入 when orphan",
            "es": "only leader can_own_es; C51 failover rebadges both sides",
            "honesty": "null progress stays null; C48 banner still owned by leader",
        },
        "peer_count": 0,
        "event_count": 0,
        "reject_count": 0,
        "ui_phase_hint": "offline",
        "label_zh_hint": "连接已断开",
        "catchup_product_paths": [] if plan is None else list(plan.catchup_product_paths),
        "needs_kouling": ["改码卡"],
        "ties": {
            "C48": "leader owns reconnect UI FSM banner",
            "C50": "single_subscriber bus; followers mirror max(watermark)",
            "C51": "heartbeat lease + failover elect before rebadge",
            "C52": "follower read-only mirror + leader/follower badges",
        },
        "plan": None if plan is None else plan.to_dict(),
        "notes": "flag off: follower mirror / leader badge paper only; no tip DOM",
    }


def plan_or_none(surface: str) -> SubscribePlan | None:
    return plan_for(surface)
