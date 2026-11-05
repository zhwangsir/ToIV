"""FE multi-tab watermark sync (Cycle 50).

Same-origin tabs share the max(since_seq) cursor so reconnect/catch-up
does not regress when one tab holds a stale watermark. Paper + scratch
dry-run — flag default false, no tip BroadcastChannel mount, no fake progress.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from .stream_reconnect import ReconnectState, initial_state
from .stream_subscribe import SubscribePlan, plan_for

TAB_WATERMARK_PRODUCT_PATH = "fe_tab_watermark_sync"

# Transport sketch for tip (not mounted here).
DEFAULT_CHANNEL = "toiv:progress-watermark"
DEFAULT_STORAGE_KEY = "toiv.progress.watermark.v1"

SyncOutcome = Literal[
    "adopted_peer",
    "published_local",
    "noop_equal",
    "rejected_regress",
    "merged_max",
]


@dataclass(frozen=True)
class TabSyncPolicy:
    """How tabs exchange watermarks (paper defaults)."""

    channel: str = DEFAULT_CHANNEL
    storage_key: str = DEFAULT_STORAGE_KEY
    transport: Literal["broadcast_channel", "local_storage", "memory"] = "memory"
    # Prefer a single EventSource owner; followers mirror watermark only.
    single_subscriber: bool = True
    # Never allow a peer to lower the shared cursor.
    monotonic: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


DEFAULT_POLICY = TabSyncPolicy()


@dataclass
class TabPeer:
    """One browser tab's view of the shared watermark."""

    tab_id: str
    surface: str
    since_seq: int = 0
    is_leader: bool = False
    connected: bool = False
    last_outcome: SyncOutcome | None = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["watermark"] = self.since_seq
        return d


@dataclass
class TabWatermarkBus:
    """In-process stand-in for BroadcastChannel / storage events."""

    surface: str
    policy: TabSyncPolicy = field(default_factory=TabSyncPolicy)
    shared_seq: int = 0
    peers: dict[str, TabPeer] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    tip_mount: bool = False
    flag_default: bool = False
    needs_kouling: tuple[str, ...] = ("改码卡",)

    def to_dict(self) -> dict[str, Any]:
        return {
            "surface": self.surface,
            "shared_seq": self.shared_seq,
            "watermark": self.shared_seq,
            "policy": self.policy.to_dict(),
            "peers": {k: v.to_dict() for k, v in self.peers.items()},
            "events": list(self.events),
            "tip_mount": self.tip_mount,
            "flag_default": self.flag_default,
            "needs_kouling": list(self.needs_kouling),
            "leader_tab_id": next(
                (p.tab_id for p in self.peers.values() if p.is_leader), None
            ),
        }


def _record(
    bus: TabWatermarkBus,
    *,
    kind: str,
    tab_id: str,
    before: int,
    after: int,
    outcome: SyncOutcome,
) -> None:
    bus.events.append(
        {
            "kind": kind,
            "tab_id": tab_id,
            "before": before,
            "after": after,
            "outcome": outcome,
            "shared_seq": bus.shared_seq,
        }
    )


def join_tab(
    bus: TabWatermarkBus,
    tab_id: str,
    *,
    since_seq: int = 0,
    want_leader: bool = False,
) -> TabPeer:
    """Register a tab; adopt shared max; elect leader if none yet."""
    seq = max(int(since_seq or 0), int(bus.shared_seq or 0))
    if bus.policy.monotonic:
        bus.shared_seq = max(int(bus.shared_seq or 0), seq)
    else:
        bus.shared_seq = seq

    has_leader = any(p.is_leader for p in bus.peers.values())
    is_leader = False
    if bus.policy.single_subscriber:
        if want_leader or not has_leader:
            # Demote existing leaders when an explicit want_leader joins.
            if want_leader:
                for p in bus.peers.values():
                    p.is_leader = False
                is_leader = True
            elif not has_leader:
                is_leader = True

    # Existing peers adopt raised shared watermark (join is a merge event).
    for other in bus.peers.values():
        if int(other.since_seq) < int(bus.shared_seq):
            other.since_seq = int(bus.shared_seq)
            other.last_outcome = "adopted_peer"

    peer = TabPeer(
        tab_id=tab_id,
        surface=bus.surface,
        since_seq=int(bus.shared_seq),
        is_leader=is_leader,
        connected=is_leader,  # only leader owns EventSource in paper model
        last_outcome="merged_max" if seq != int(since_seq or 0) else "noop_equal",
    )
    bus.peers[tab_id] = peer
    _record(
        bus,
        kind="join",
        tab_id=tab_id,
        before=int(since_seq or 0),
        after=peer.since_seq,
        outcome=peer.last_outcome or "noop_equal",
    )
    return peer


def publish_local(bus: TabWatermarkBus, tab_id: str, since_seq: int) -> TabPeer:
    """Local tab advances watermark; broadcast max to peers."""
    if tab_id not in bus.peers:
        raise KeyError(f"unknown tab_id: {tab_id}")
    peer = bus.peers[tab_id]
    before = int(peer.since_seq)
    incoming = int(since_seq)
    if bus.policy.monotonic and incoming < int(bus.shared_seq):
        peer.last_outcome = "rejected_regress"
        _record(
            bus,
            kind="publish",
            tab_id=tab_id,
            before=before,
            after=peer.since_seq,
            outcome="rejected_regress",
        )
        return peer

    new_shared = max(int(bus.shared_seq), incoming)
    bus.shared_seq = new_shared
    peer.since_seq = new_shared
    peer.last_outcome = "published_local"
    # Followers mirror
    for other in bus.peers.values():
        if other.tab_id == tab_id:
            continue
        if bus.policy.monotonic:
            other.since_seq = max(int(other.since_seq), new_shared)
        else:
            other.since_seq = new_shared
        other.last_outcome = "adopted_peer"
    _record(
        bus,
        kind="publish",
        tab_id=tab_id,
        before=before,
        after=peer.since_seq,
        outcome="published_local",
    )
    return peer


def on_peer_message(
    bus: TabWatermarkBus,
    tab_id: str,
    peer_seq: int,
    *,
    from_tab: str = "peer",
) -> TabPeer:
    """Apply a peer BroadcastChannel / storage message to one tab."""
    if tab_id not in bus.peers:
        raise KeyError(f"unknown tab_id: {tab_id}")
    peer = bus.peers[tab_id]
    before = int(peer.since_seq)
    incoming = int(peer_seq)
    if bus.policy.monotonic and incoming < before:
        peer.last_outcome = "rejected_regress"
        _record(
            bus,
            kind="peer_message",
            tab_id=tab_id,
            before=before,
            after=before,
            outcome="rejected_regress",
        )
        return peer

    if incoming == before:
        peer.last_outcome = "noop_equal"
        _record(
            bus,
            kind="peer_message",
            tab_id=tab_id,
            before=before,
            after=before,
            outcome="noop_equal",
        )
        return peer

    new_shared = max(int(bus.shared_seq), incoming)
    bus.shared_seq = new_shared
    peer.since_seq = new_shared
    peer.last_outcome = "adopted_peer"
    _record(
        bus,
        kind="peer_message",
        tab_id=tab_id,
        before=before,
        after=peer.since_seq,
        outcome="adopted_peer",
    )
    _ = from_tab  # documented in events via tab_id only; keep API clear
    return peer


def apply_bus_to_reconnect(
    reconnect: ReconnectState,
    bus: TabWatermarkBus,
) -> ReconnectState:
    """Project shared watermark onto ReconnectState; never invent progress."""
    reconnect.since_seq = max(int(reconnect.since_seq or 0), int(bus.shared_seq or 0))
    return reconnect


def sync_cycle(
    plan: SubscribePlan,
    *,
    initial_seqs: dict[str, int] | None = None,
    leader_tab: str = "tab-a",
    policy: TabSyncPolicy = DEFAULT_POLICY,
) -> dict[str, Any]:
    """Dry-run: two+ tabs join, one advances, peers adopt max; no regress."""
    initial_seqs = initial_seqs or {"tab-a": 3, "tab-b": 7, "tab-c": 5}
    bus = TabWatermarkBus(surface=plan.surface, policy=policy)

    # Join in stable order; explicit leader first
    ordered = sorted(initial_seqs.keys(), key=lambda t: (0 if t == leader_tab else 1, t))
    for tid in ordered:
        join_tab(
            bus,
            tid,
            since_seq=int(initial_seqs[tid]),
            want_leader=(tid == leader_tab),
        )

    # Stale tab tries to publish regress → rejected
    stale = ordered[-1]
    publish_local(bus, stale, max(0, int(bus.shared_seq) - 1))

    # Leader publishes a higher watermark; peers adopt
    advanced = int(bus.shared_seq) + 4
    publish_local(bus, leader_tab, advanced)

    # Simulate a late peer message with equal seq → noop
    follower = next(t for t in ordered if t != leader_tab)
    on_peer_message(bus, follower, int(bus.shared_seq), from_tab=leader_tab)

    reconnect = initial_state(plan.surface, since_seq=0)
    apply_bus_to_reconnect(reconnect, bus)

    leaders = [p.tab_id for p in bus.peers.values() if p.is_leader]
    assert len(leaders) == 1
    assert bus.shared_seq == advanced
    assert all(p.since_seq == advanced for p in bus.peers.values())
    assert reconnect.since_seq == advanced

    return {
        "product_path": TAB_WATERMARK_PRODUCT_PATH,
        "surface": plan.surface,
        "enabled": True,
        "reason": None,
        "flag_default": False,
        "tip_mount": False,
        "live_frames": False,
        "needs_kouling": ["改码卡"],
        "policy": policy.to_dict(),
        "bus": bus.to_dict(),
        "reconnect": reconnect.to_dict(),
        "since_seq": bus.shared_seq,
        "next_seq": bus.shared_seq,
        "leader_tab_id": leaders[0],
        "peer_count": len(bus.peers),
        "event_count": len(bus.events),
        "catchup_product_paths": list(plan.catchup_product_paths),
        "plan": plan.to_dict(),
        "notes": (
            "Cycle 50: multi-tab max(watermark) sync; "
            "single EventSource leader; reject regress; tip BroadcastChannel waits 改码卡"
        ),
    }


def checklist_static_payload(
    *,
    surface: str = "task_center",
    since_seq: int = 0,
    plan: SubscribePlan | None = None,
    policy: TabSyncPolicy = DEFAULT_POLICY,
) -> dict[str, Any]:
    """Flag-off: policy + rules only; no in-memory bus traffic."""
    return {
        "product_path": TAB_WATERMARK_PRODUCT_PATH,
        "enabled": False,
        "reason": "ray_control_disabled",
        "flag_default": False,
        "tip_mount": False,
        "live_frames": False,
        "surface": surface if plan is None else plan.surface,
        "since_seq": int(since_seq or 0),
        "next_seq": int(since_seq or 0),
        "policy": policy.to_dict(),
        "rules": {
            "merge": "shared_seq = max(local, peer)",
            "regress": "reject peer/local publish < shared_seq when monotonic",
            "leader": "single_subscriber → one tab owns EventSource; others mirror",
            "honesty": "never invent progress=100; null stays null",
        },
        "transport_sketch": {
            "broadcast_channel": policy.channel,
            "local_storage_key": policy.storage_key,
            "scratch_transport": "memory",
        },
        "peer_count": 0,
        "event_count": 0,
        "ui_phase_hint": "offline",
        "label_zh_hint": "连接已断开",
        "catchup_product_paths": [] if plan is None else list(plan.catchup_product_paths),
        "needs_kouling": ["改码卡"],
        "ties": {
            "C46": "ReconnectState.since_seq watermark",
            "C47": "onerror keeps watermark across reopen",
            "C48/C49": "UI FSM + backoff never rewrite watermark",
            "C50": "tabs converge on max(watermark); one leader ES",
        },
        "plan": None if plan is None else plan.to_dict(),
        "notes": "flag off: multi-tab watermark sync paper only; no BroadcastChannel",
    }


def plan_or_none(surface: str) -> SubscribePlan | None:
    return plan_for(surface)
