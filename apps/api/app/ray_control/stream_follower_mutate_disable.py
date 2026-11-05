"""FE follower mutate-disable catalog + create-rail read-only shell (Cycle 53).

Lists workbench mutations followers must not fire, and projects a create-rail
read-only shell (disabled CTAs) while the tab is follower. Paper + scratch
dry-run — flag default false, no tip DOM / create-rail mount, no invented jobs.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from .stream_follower_mirror import (
    BADGE_LABELS_ZH,
    DEFAULT_MIRROR_POLICY,
    MirrorBoard,
    MirrorPolicy,
    apply_failover_and_rebadge,
    mirror_from_shared,
    refresh_views,
    seed_board,
    try_publish,
)
from .stream_leader_heartbeat import DEFAULT_HB_POLICY, HeartbeatPolicy, advance_clock
from .stream_subscribe import SubscribePlan, plan_for
from .stream_tab_watermark import DEFAULT_POLICY as DEFAULT_TAB_POLICY, TabSyncPolicy

FOLLOWER_MUTATE_DISABLE_PRODUCT_PATH = "fe_follower_mutate_disable"

ShellMode = Literal["interactive", "readonly", "orphan"]
ActionOutcome = Literal[
    "allowed",
    "blocked_follower",
    "blocked_orphan",
    "shell_ok",
    "role_switched",
    "noop_unknown_action",
]

# ToIV-original action ids + zh labels (never paste competitor UI copy).
MUTATE_ACTIONS: tuple[dict[str, Any], ...] = (
    {"id": "create_job", "label_zh": "新建任务", "rail": "create", "is_write": True},
    {"id": "edit_prompt", "label_zh": "编辑提示", "rail": "create", "is_write": True},
    {"id": "change_model", "label_zh": "切换模型", "rail": "create", "is_write": True},
    {"id": "submit_generate", "label_zh": "提交生成", "rail": "create", "is_write": True},
    {"id": "open_export_wizard", "label_zh": "打开导出", "rail": "export", "is_write": True},
    {"id": "retry_job", "label_zh": "重试任务", "rail": "task", "is_write": True},
    {"id": "delete_asset", "label_zh": "删除素材", "rail": "asset", "is_write": True},
    {"id": "rename_session", "label_zh": "重命名会话", "rail": "session", "is_write": True},
    {"id": "attach_artifact", "label_zh": "挂接产物", "rail": "task", "is_write": True},
    {"id": "seed_timeline", "label_zh": "写入时间线", "rail": "timeline", "is_write": True},
)

# Soft / read actions followers may still use.
SOFT_ACTIONS: tuple[dict[str, Any], ...] = (
    {"id": "soft_refresh", "label_zh": "软刷新水位", "rail": "mirror", "is_write": False},
    {"id": "open_read_detail", "label_zh": "查看详情", "rail": "task", "is_write": False},
    {"id": "copy_job_id", "label_zh": "复制任务号", "rail": "task", "is_write": False},
)

SHELL_BANNER_ZH = {
    "interactive": "领导 · 创建轨可写",
    "readonly": "跟随·只读 · 创建轨已锁定",
    "orphan": "未接入 · 创建轨不可用",
}


@dataclass(frozen=True)
class MutateDisablePolicy:
    """Follower mutate-disable + create-rail shell defaults."""

    disable_all_mutates: bool = True
    show_readonly_shell: bool = True
    show_disabled_reason: bool = True
    allow_soft_actions: bool = True
    lock_create_rail_on_follower: bool = True
    # After failover, new leader unlocks rail immediately.
    unlock_on_promote: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


DEFAULT_MUTATE_POLICY = MutateDisablePolicy()


@dataclass
class ActionGate:
    """Per-action enablement for a tab role."""

    action_id: str
    label_zh: str
    enabled: bool
    reason_zh: str
    is_write: bool
    rail: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CreateRailShell:
    """Create-rail projection: interactive vs read-only shell."""

    tab_id: str
    mode: ShellMode
    banner_zh: str
    cta_create_enabled: bool
    cta_submit_enabled: bool
    locked: bool
    disabled_action_ids: list[str] = field(default_factory=list)
    gates: list[ActionGate] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "tab_id": self.tab_id,
            "mode": self.mode,
            "banner_zh": self.banner_zh,
            "cta_create_enabled": self.cta_create_enabled,
            "cta_submit_enabled": self.cta_submit_enabled,
            "locked": self.locked,
            "disabled_action_ids": list(self.disabled_action_ids),
            "gates": [g.to_dict() for g in self.gates],
        }


@dataclass
class MutateBoard:
    """In-process stand-in for mutate-disable catalog + create-rail shell."""

    mirror: MirrorBoard
    policy: MutateDisablePolicy = field(default_factory=MutateDisablePolicy)
    shells: dict[str, CreateRailShell] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    tip_mount: bool = False
    flag_default: bool = False
    needs_kouling: tuple[str, ...] = ("改码卡",)
    last_outcome: ActionOutcome | None = None
    block_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy": self.policy.to_dict(),
            "shells": {k: v.to_dict() for k, v in self.shells.items()},
            "events": list(self.events),
            "tip_mount": self.tip_mount,
            "flag_default": self.flag_default,
            "needs_kouling": list(self.needs_kouling),
            "last_outcome": self.last_outcome,
            "block_count": self.block_count,
            "mirror": self.mirror.to_dict(),
            "mutate_action_ids": [a["id"] for a in MUTATE_ACTIONS],
            "soft_action_ids": [a["id"] for a in SOFT_ACTIONS],
        }


def _mode_for(role: str) -> ShellMode:
    if role == "leader":
        return "interactive"
    if role == "follower":
        return "readonly"
    return "orphan"


def _reason_zh(mode: ShellMode, action_id: str, *, soft: bool, policy: MutateDisablePolicy) -> str:
    if mode == "interactive":
        return "领导可写"
    if soft and policy.allow_soft_actions and mode == "readonly":
        return "跟随允许软操作"
    if mode == "orphan":
        return "未接入不可写"
    return "跟随·只读已禁用"


def _build_gates(mode: ShellMode, policy: MutateDisablePolicy) -> list[ActionGate]:
    gates: list[ActionGate] = []
    for a in MUTATE_ACTIONS:
        enabled = mode == "interactive" or not policy.disable_all_mutates
        gates.append(
            ActionGate(
                action_id=a["id"],
                label_zh=a["label_zh"],
                enabled=enabled,
                reason_zh=_reason_zh(mode, a["id"], soft=False, policy=policy),
                is_write=bool(a["is_write"]),
                rail=a["rail"],
            )
        )
    for a in SOFT_ACTIONS:
        soft_ok = mode == "interactive" or (mode == "readonly" and policy.allow_soft_actions)
        gates.append(
            ActionGate(
                action_id=a["id"],
                label_zh=a["label_zh"],
                enabled=soft_ok,
                reason_zh=_reason_zh(mode, a["id"], soft=True, policy=policy),
                is_write=False,
                rail=a["rail"],
            )
        )
    return gates


def project_shell(board: MutateBoard, tab_id: str) -> CreateRailShell:
    """Project create-rail shell for one tab from current mirror role."""
    refresh_views(board.mirror)
    view = board.mirror.views.get(tab_id)
    role = view.role if view is not None else "orphan"
    mode = _mode_for(role)
    if mode == "readonly" and not board.policy.show_readonly_shell:
        # Still locked logically; banner suppressed.
        banner = ""
    else:
        banner = SHELL_BANNER_ZH[mode]
    gates = _build_gates(mode, board.policy)
    disabled = [g.action_id for g in gates if not g.enabled]
    locked = mode != "interactive" and board.policy.lock_create_rail_on_follower
    shell = CreateRailShell(
        tab_id=tab_id,
        mode=mode,
        banner_zh=banner,
        cta_create_enabled=mode == "interactive",
        cta_submit_enabled=mode == "interactive",
        locked=locked,
        disabled_action_ids=disabled,
        gates=gates,
    )
    board.shells[tab_id] = shell
    return shell


def refresh_shells(board: MutateBoard) -> None:
    for tid in list(board.mirror.watch.bus.peers.keys()):
        project_shell(board, tid)
    for tid in list(board.shells.keys()):
        if tid not in board.mirror.watch.bus.peers:
            del board.shells[tid]


def _record(
    board: MutateBoard,
    *,
    kind: str,
    tab_id: str | None,
    outcome: ActionOutcome,
    detail: dict[str, Any] | None = None,
) -> None:
    board.last_outcome = outcome
    ev: dict[str, Any] = {
        "kind": kind,
        "tab_id": tab_id,
        "outcome": outcome,
        "leader_tab_id": board.mirror.watch.leader_tab_id(),
    }
    if detail:
        ev.update(detail)
    board.events.append(ev)


def seed_mutate_board(
    *,
    surface: str,
    initial_seqs: dict[str, int],
    leader_tab: str,
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
    mirror_policy: MirrorPolicy = DEFAULT_MIRROR_POLICY,
    mutate_policy: MutateDisablePolicy = DEFAULT_MUTATE_POLICY,
    start_ms: int = 0,
) -> MutateBoard:
    mirror = seed_board(
        surface=surface,
        initial_seqs=initial_seqs,
        leader_tab=leader_tab,
        tab_policy=tab_policy,
        hb_policy=hb_policy,
        mirror_policy=mirror_policy,
        start_ms=start_ms,
    )
    board = MutateBoard(mirror=mirror, policy=mutate_policy)
    refresh_shells(board)
    _record(board, kind="seed", tab_id=leader_tab, outcome="shell_ok")
    return board


def try_action(board: MutateBoard, tab_id: str, action_id: str) -> ActionOutcome:
    """Attempt a catalog action; followers are blocked on mutate ids."""
    known = {a["id"] for a in MUTATE_ACTIONS} | {a["id"] for a in SOFT_ACTIONS}
    if action_id not in known:
        _record(
            board,
            kind="action",
            tab_id=tab_id,
            outcome="noop_unknown_action",
            detail={"action_id": action_id},
        )
        return "noop_unknown_action"

    shell = project_shell(board, tab_id)
    gate = next((g for g in shell.gates if g.action_id == action_id), None)
    if gate is None or not gate.enabled:
        board.block_count += 1
        outcome: ActionOutcome = (
            "blocked_orphan" if shell.mode == "orphan" else "blocked_follower"
        )
        _record(
            board,
            kind="action",
            tab_id=tab_id,
            outcome=outcome,
            detail={"action_id": action_id, "mode": shell.mode},
        )
        return outcome

    _record(
        board,
        kind="action",
        tab_id=tab_id,
        outcome="allowed",
        detail={"action_id": action_id, "mode": shell.mode},
    )
    return "allowed"


def apply_failover_and_reshell(board: MutateBoard) -> ActionOutcome:
    """C51/C52 failover then rebuild create-rail shells."""
    outcome = apply_failover_and_rebadge(board.mirror)
    refresh_shells(board)
    if outcome == "role_switched":
        _record(
            board,
            kind="reshell",
            tab_id=board.mirror.watch.leader_tab_id(),
            outcome="role_switched",
        )
        return "role_switched"
    _record(
        board,
        kind="reshell",
        tab_id=board.mirror.watch.leader_tab_id(),
        outcome="shell_ok",
        detail={"failover_outcome": outcome},
    )
    return "shell_ok"


def mutate_disable_cycle(
    plan: SubscribePlan,
    *,
    initial_seqs: dict[str, int] | None = None,
    leader_tab: str = "tab-a",
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
    mirror_policy: MirrorPolicy = DEFAULT_MIRROR_POLICY,
    mutate_policy: MutateDisablePolicy = DEFAULT_MUTATE_POLICY,
) -> dict[str, Any]:
    """Dry-run: seed shells → block follower mutate → allow soft → failover unlock."""
    initial_seqs = initial_seqs or {"tab-a": 4, "tab-b": 9, "tab-c": 6}
    board = seed_mutate_board(
        surface=plan.surface,
        initial_seqs=initial_seqs,
        leader_tab=leader_tab,
        tab_policy=tab_policy,
        hb_policy=hb_policy,
        mirror_policy=mirror_policy,
        mutate_policy=mutate_policy,
        start_ms=0,
    )

    leader_shell = board.shells[leader_tab]
    assert leader_shell.mode == "interactive"
    assert leader_shell.cta_create_enabled is True
    assert try_action(board, leader_tab, "create_job") == "allowed"
    assert try_action(board, leader_tab, "submit_generate") == "allowed"

    followers = [t for t, s in board.shells.items() if s.mode == "readonly"]
    assert followers
    follower = sorted(followers)[0]
    fshell = board.shells[follower]
    assert fshell.locked is True
    assert fshell.cta_submit_enabled is False
    assert "create_job" in fshell.disabled_action_ids
    assert try_action(board, follower, "create_job") == "blocked_follower"
    assert try_action(board, follower, "submit_generate") == "blocked_follower"
    assert try_action(board, follower, "soft_refresh") == "allowed"
    assert try_action(board, follower, "open_read_detail") == "allowed"

    # Mirror watermark stays honest; follower publish still rejected via C52.
    target = int(board.mirror.watch.bus.shared_seq) + 2
    assert try_publish(board.mirror, leader_tab, target) == "leader_publish_ok"
    assert try_publish(board.mirror, follower, target + 5) == "rejected_follower_write"
    assert mirror_from_shared(board.mirror, follower) == "mirrored"
    refresh_shells(board)

    advance_clock(board.mirror.watch, hb_policy.timeout_ms + hb_policy.interval_ms)
    assert apply_failover_and_reshell(board) == "role_switched"
    new_leader = board.mirror.watch.leader_tab_id()
    assert new_leader is not None and new_leader != leader_tab
    assert board.shells[new_leader].mode == "interactive"
    assert board.shells[new_leader].locked is False
    assert board.shells[leader_tab].mode == "readonly"
    assert board.shells[leader_tab].locked is True
    assert try_action(board, new_leader, "create_job") == "allowed"
    assert try_action(board, leader_tab, "create_job") == "blocked_follower"

    return {
        "product_path": FOLLOWER_MUTATE_DISABLE_PRODUCT_PATH,
        "surface": plan.surface,
        "enabled": True,
        "reason": None,
        "flag_default": False,
        "tip_mount": False,
        "live_frames": False,
        "needs_kouling": ["改码卡"],
        "policy": mutate_policy.to_dict(),
        "mirror_policy": mirror_policy.to_dict(),
        "hb_policy": hb_policy.to_dict(),
        "tab_policy": tab_policy.to_dict(),
        "board": board.to_dict(),
        "since_seq": board.mirror.watch.bus.shared_seq,
        "next_seq": board.mirror.watch.bus.shared_seq,
        "leader_tab_id": new_leader,
        "demoted_tab_id": leader_tab,
        "block_count": board.block_count,
        "peer_count": len(board.mirror.watch.bus.peers),
        "event_count": len(board.events),
        "shells": {tid: s.to_dict() for tid, s in board.shells.items()},
        "mutate_catalog": list(MUTATE_ACTIONS),
        "soft_catalog": list(SOFT_ACTIONS),
        "badge_labels_zh": dict(BADGE_LABELS_ZH),
        "catchup_product_paths": list(plan.catchup_product_paths),
        "plan": plan.to_dict(),
        "notes": (
            "Cycle 53: follower mutate-disable catalog + create-rail read-only shell; "
            "soft actions allowed; failover unlocks new leader rail; tip DOM waits 改码卡"
        ),
    }


def checklist_static_payload(
    *,
    surface: str = "create_rail",
    since_seq: int = 0,
    plan: SubscribePlan | None = None,
    mutate_policy: MutateDisablePolicy = DEFAULT_MUTATE_POLICY,
    mirror_policy: MirrorPolicy = DEFAULT_MIRROR_POLICY,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
) -> dict[str, Any]:
    """Flag-off: mutate-disable + shell rules only; no bus traffic."""
    return {
        "product_path": FOLLOWER_MUTATE_DISABLE_PRODUCT_PATH,
        "enabled": False,
        "reason": "ray_control_disabled",
        "flag_default": False,
        "tip_mount": False,
        "live_frames": False,
        "surface": surface if plan is None else plan.surface,
        "since_seq": int(since_seq or 0),
        "next_seq": int(since_seq or 0),
        "policy": mutate_policy.to_dict(),
        "mirror_policy": mirror_policy.to_dict(),
        "hb_policy": hb_policy.to_dict(),
        "tab_policy": tab_policy.to_dict(),
        "mutate_catalog": list(MUTATE_ACTIONS),
        "soft_catalog": list(SOFT_ACTIONS),
        "shell_banner_zh": dict(SHELL_BANNER_ZH),
        "badge_labels_zh": dict(BADGE_LABELS_ZH),
        "rules": {
            "mutate": "followers block all MUTATE_ACTIONS when disable_all_mutates",
            "soft": "soft_refresh / open_read_detail / copy_job_id stay allowed",
            "shell": "create-rail readonly shell locks CTAs; banner 跟随·只读 · 创建轨已锁定",
            "failover": "C51/C52 promote unlocks rail for new leader immediately",
            "honesty": "no invented jobs; C52 reject_follower_write still owns watermark",
        },
        "peer_count": 0,
        "event_count": 0,
        "block_count": 0,
        "ui_phase_hint": "offline",
        "label_zh_hint": "创建轨已锁定",
        "catchup_product_paths": [] if plan is None else list(plan.catchup_product_paths),
        "needs_kouling": ["改码卡"],
        "ties": {
            "C48": "leader owns reconnect UI FSM banner",
            "C50": "single_subscriber bus; followers mirror max(watermark)",
            "C51": "heartbeat lease + failover elect",
            "C52": "follower read-only mirror + leader/follower badges",
            "C53": "mutate-disable catalog + create-rail read-only shell",
        },
        "plan": None if plan is None else plan.to_dict(),
        "notes": "flag off: follower mutate-disable / create-rail shell paper only; no tip DOM",
    }


def plan_or_none(surface: str) -> SubscribePlan | None:
    return plan_for(surface)
