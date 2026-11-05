"""FE create-rail read-only shell visual tokens + disabled tip matrix (Cycle 54).

Projects ToIV-original visual tokens (opacity/cursor/banner/badge/CTA) and a
per-action tip_zh matrix on top of Cycle 53 MutateBoard. Paper + scratch
dry-run — flag default false, no tip DOM mount, no competitor UI copy.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from .stream_follower_mirror import (
    DEFAULT_MIRROR_POLICY,
    MirrorPolicy,
)
from .stream_follower_mutate_disable import (
    DEFAULT_MUTATE_POLICY,
    MUTATE_ACTIONS,
    SHELL_BANNER_ZH,
    SOFT_ACTIONS,
    HeartbeatPolicy,
    MutateBoard,
    MutateDisablePolicy,
    advance_clock,
    apply_failover_and_reshell,
    project_shell,
    seed_mutate_board,
    try_action,
)
from .stream_leader_heartbeat import DEFAULT_HB_POLICY
from .stream_subscribe import SubscribePlan, plan_for
from .stream_tab_watermark import DEFAULT_POLICY as DEFAULT_TAB_POLICY, TabSyncPolicy

READONLY_SHELL_VISUAL_PRODUCT_PATH = "fe_readonly_shell_visual_tokens"

# ToIV-original visual tokens (CSS-like strings; never paste competitor tokens).
VISUAL_TOKENS: dict[str, dict[str, str]] = {
    "interactive": {
        "opacity": "1",
        "cursor": "pointer",
        "banner_bg": "#12161f",
        "banner_fg": "#e8eef8",
        "border": "1px solid #3a4660",
        "badge_bg": "#2f6fed",
        "badge_fg": "#ffffff",
        "cta_opacity": "1",
        "rail_filter": "none",
    },
    "readonly": {
        "opacity": "0.45",
        "cursor": "not-allowed",
        "banner_bg": "#1a1f2e",
        "banner_fg": "#9db0d0",
        "border": "1px dashed #3a4660",
        "badge_bg": "#2a3348",
        "badge_fg": "#a8b8d8",
        "cta_opacity": "0.45",
        "rail_filter": "grayscale(0.25)",
    },
    "orphan": {
        "opacity": "0.35",
        "cursor": "not-allowed",
        "banner_bg": "#141820",
        "banner_fg": "#7a869c",
        "border": "1px dotted #2a3348",
        "badge_bg": "#1e2433",
        "badge_fg": "#7a869c",
        "cta_opacity": "0.3",
        "rail_filter": "grayscale(0.5)",
    },
}

# tip_zh for every MUTATE_ACTIONS + SOFT_ACTIONS id (ToIV original Chinese).
DISABLED_TIP_MATRIX: dict[str, str] = {
    "create_job": "跟随页不可新建任务 · 请切到领导标签",
    "edit_prompt": "跟随页不可编辑提示 · 请切到领导标签",
    "change_model": "跟随页不可切换模型 · 请切到领导标签",
    "submit_generate": "跟随页不可提交生成 · 请切到领导标签",
    "open_export_wizard": "跟随页不可打开导出 · 请切到领导标签",
    "retry_job": "跟随页不可重试任务 · 请切到领导标签",
    "delete_asset": "跟随页不可删除素材 · 请切到领导标签",
    "rename_session": "跟随页不可重命名会话 · 请切到领导标签",
    "attach_artifact": "跟随页不可挂接产物 · 请切到领导标签",
    "seed_timeline": "跟随页不可写入时间线 · 请切到领导标签",
    "soft_refresh": "跟随可查看 · 软刷新水位可用",
    "open_read_detail": "跟随可查看 · 详情只读",
    "copy_job_id": "跟随可查看 · 可复制任务号",
}

_SOFT_IDS = {a["id"] for a in SOFT_ACTIONS}
_MUTATE_IDS = {a["id"] for a in MUTATE_ACTIONS}


@dataclass(frozen=True)
class VisualTokenPolicy:
    """Create-rail readonly shell visual token defaults."""

    opacity_disabled: float = 0.45
    cursor_disabled: str = "not-allowed"
    banner_bg: str = "#1a1f2e"
    banner_fg: str = "#9db0d0"
    badge_follower_bg: str = "#2a3348"
    badge_follower_fg: str = "#a8b8d8"
    lock_icon: str = "lock"
    cta_ghost: bool = True
    tip_delay_ms: int = 280
    show_per_action_tip: bool = True
    dim_create_rail: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


DEFAULT_VISUAL_POLICY = VisualTokenPolicy()


@dataclass
class TokenBoard:
    """Wraps MutateBoard with resolved visual tokens + tip matrix snapshot."""

    mutate: MutateBoard
    policy: VisualTokenPolicy = field(default_factory=VisualTokenPolicy)
    tokens_by_tab: dict[str, dict[str, str]] = field(default_factory=dict)
    tip_matrix: dict[str, str] = field(default_factory=lambda: dict(DISABLED_TIP_MATRIX))
    tip_mount: bool = False
    flag_default: bool = False
    needs_kouling: tuple[str, ...] = ("改码卡",)

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy": self.policy.to_dict(),
            "tokens_by_tab": {k: dict(v) for k, v in self.tokens_by_tab.items()},
            "tip_matrix": dict(self.tip_matrix),
            "tip_mount": self.tip_mount,
            "flag_default": self.flag_default,
            "needs_kouling": list(self.needs_kouling),
            "mutate": self.mutate.to_dict(),
            "block_count": self.mutate.block_count,
        }


def resolve_tokens(mode: str) -> dict[str, str]:
    """Return CSS-like visual token map for interactive/readonly/orphan."""
    return dict(VISUAL_TOKENS.get(mode, VISUAL_TOKENS["orphan"]))


def tip_for(action_id: str, mode: str) -> str:
    """Pick tip_zh for an action under a shell mode."""
    if action_id not in DISABLED_TIP_MATRIX:
        return "未知操作"
    if mode == "interactive":
        if action_id in _SOFT_IDS:
            return "领导可查看"
        return "领导可写"
    if mode == "orphan":
        return "未接入 · 操作不可用"
    # readonly / follower
    return DISABLED_TIP_MATRIX[action_id]


def project_token_shell(board: TokenBoard, tab_id: str) -> dict[str, Any]:
    """Project create-rail shell + resolve visual tokens for one tab."""
    shell = project_shell(board.mutate, tab_id)
    tokens = resolve_tokens(shell.mode)
    # Overlay policy defaults onto readonly tokens when dimming rail.
    if shell.mode == "readonly" and board.policy.dim_create_rail:
        tokens = dict(tokens)
        tokens["opacity"] = str(board.policy.opacity_disabled)
        tokens["cursor"] = board.policy.cursor_disabled
        tokens["banner_bg"] = board.policy.banner_bg
        tokens["banner_fg"] = board.policy.banner_fg
        tokens["badge_bg"] = board.policy.badge_follower_bg
        tokens["badge_fg"] = board.policy.badge_follower_fg
        if board.policy.cta_ghost:
            tokens["cta_opacity"] = str(board.policy.opacity_disabled)
    board.tokens_by_tab[tab_id] = tokens
    return {
        "shell": shell.to_dict(),
        "visual_tokens": tokens,
        "lock_icon": board.policy.lock_icon if shell.locked else None,
        "tip_delay_ms": board.policy.tip_delay_ms,
        "show_per_action_tip": board.policy.show_per_action_tip,
    }


def _refresh_token_shells(board: TokenBoard) -> None:
    for tid in list(board.mutate.mirror.watch.bus.peers.keys()):
        project_token_shell(board, tid)
    for tid in list(board.tokens_by_tab.keys()):
        if tid not in board.mutate.mirror.watch.bus.peers:
            del board.tokens_by_tab[tid]


def seed_token_board(
    *,
    surface: str,
    initial_seqs: dict[str, int],
    leader_tab: str,
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
    mirror_policy: MirrorPolicy = DEFAULT_MIRROR_POLICY,
    mutate_policy: MutateDisablePolicy = DEFAULT_MUTATE_POLICY,
    visual_policy: VisualTokenPolicy = DEFAULT_VISUAL_POLICY,
    start_ms: int = 0,
) -> TokenBoard:
    mutate = seed_mutate_board(
        surface=surface,
        initial_seqs=initial_seqs,
        leader_tab=leader_tab,
        tab_policy=tab_policy,
        hb_policy=hb_policy,
        mirror_policy=mirror_policy,
        mutate_policy=mutate_policy,
        start_ms=start_ms,
    )
    board = TokenBoard(mutate=mutate, policy=visual_policy)
    _refresh_token_shells(board)
    return board


def token_matrix_cycle(
    plan: SubscribePlan,
    *,
    initial_seqs: dict[str, int] | None = None,
    leader_tab: str = "tab-a",
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
    mirror_policy: MirrorPolicy = DEFAULT_MIRROR_POLICY,
    mutate_policy: MutateDisablePolicy = DEFAULT_MUTATE_POLICY,
    visual_policy: VisualTokenPolicy = DEFAULT_VISUAL_POLICY,
) -> dict[str, Any]:
    """Dry-run: seed tokens → tip matrix → block follower mutate → failover reshell."""
    initial_seqs = initial_seqs or {"tab-a": 4, "tab-b": 9, "tab-c": 6}
    board = seed_token_board(
        surface=plan.surface,
        initial_seqs=initial_seqs,
        leader_tab=leader_tab,
        tab_policy=tab_policy,
        hb_policy=hb_policy,
        mirror_policy=mirror_policy,
        mutate_policy=mutate_policy,
        visual_policy=visual_policy,
        start_ms=0,
    )

    leader_shell = board.mutate.shells[leader_tab]
    assert leader_shell.mode == "interactive"
    assert board.tokens_by_tab[leader_tab]["cursor"] == "pointer"
    assert try_action(board.mutate, leader_tab, "create_job") == "allowed"

    followers = [t for t, s in board.mutate.shells.items() if s.mode == "readonly"]
    assert followers
    follower = sorted(followers)[0]
    assert board.tokens_by_tab[follower]["cursor"] == "not-allowed"
    assert float(board.tokens_by_tab[follower]["opacity"]) < float(
        board.tokens_by_tab[leader_tab]["opacity"]
    )
    assert try_action(board.mutate, follower, "create_job") == "blocked_follower"
    assert try_action(board.mutate, follower, "soft_refresh") == "allowed"
    assert tip_for("create_job", "readonly").startswith("跟随页不可")
    assert "跟随可查看" in tip_for("soft_refresh", "readonly")

    advance_clock(board.mutate.mirror.watch, hb_policy.timeout_ms + hb_policy.interval_ms)
    assert apply_failover_and_reshell(board.mutate) == "role_switched"
    _refresh_token_shells(board)
    new_leader = board.mutate.mirror.watch.leader_tab_id()
    assert new_leader is not None and new_leader != leader_tab
    assert board.mutate.shells[new_leader].mode == "interactive"
    assert board.tokens_by_tab[new_leader]["cursor"] == "pointer"
    assert board.mutate.shells[leader_tab].mode == "readonly"
    assert board.tokens_by_tab[leader_tab]["cursor"] == "not-allowed"
    assert try_action(board.mutate, new_leader, "create_job") == "allowed"
    assert try_action(board.mutate, leader_tab, "create_job") == "blocked_follower"

    shells = {tid: s.to_dict() for tid, s in board.mutate.shells.items()}
    return {
        "product_path": READONLY_SHELL_VISUAL_PRODUCT_PATH,
        "surface": plan.surface,
        "enabled": True,
        "reason": None,
        "flag_default": False,
        "tip_mount": False,
        "live_frames": False,
        "needs_kouling": ["改码卡"],
        "policy": visual_policy.to_dict(),
        "mutate_policy": mutate_policy.to_dict(),
        "mirror_policy": mirror_policy.to_dict(),
        "hb_policy": hb_policy.to_dict(),
        "tab_policy": tab_policy.to_dict(),
        "board": board.to_dict(),
        "since_seq": board.mutate.mirror.watch.bus.shared_seq,
        "next_seq": board.mutate.mirror.watch.bus.shared_seq,
        "leader_tab_id": new_leader,
        "demoted_tab_id": leader_tab,
        "block_count": board.mutate.block_count,
        "peer_count": len(board.mutate.mirror.watch.bus.peers),
        "event_count": len(board.mutate.events),
        "shells": shells,
        "visual_tokens_by_tab": {k: dict(v) for k, v in board.tokens_by_tab.items()},
        "tip_matrix": dict(board.tip_matrix),
        "visual_tokens_defaults": {m: dict(t) for m, t in VISUAL_TOKENS.items()},
        "shell_banner_zh": dict(SHELL_BANNER_ZH),
        "mutate_catalog": list(MUTATE_ACTIONS),
        "soft_catalog": list(SOFT_ACTIONS),
        "catchup_product_paths": list(plan.catchup_product_paths),
        "plan": plan.to_dict(),
        "notes": (
            "Cycle 54: create-rail readonly shell visual tokens + disabled tip matrix; "
            "ToIV-original zh; tip DOM waits 改码卡"
        ),
    }


def checklist_static_payload(
    *,
    surface: str = "create_rail",
    since_seq: int = 0,
    plan: SubscribePlan | None = None,
    visual_policy: VisualTokenPolicy = DEFAULT_VISUAL_POLICY,
    mutate_policy: MutateDisablePolicy = DEFAULT_MUTATE_POLICY,
    mirror_policy: MirrorPolicy = DEFAULT_MIRROR_POLICY,
    hb_policy: HeartbeatPolicy = DEFAULT_HB_POLICY,
    tab_policy: TabSyncPolicy = DEFAULT_TAB_POLICY,
) -> dict[str, Any]:
    """Flag-off: visual token + tip matrix rules only; no bus traffic."""
    return {
        "product_path": READONLY_SHELL_VISUAL_PRODUCT_PATH,
        "enabled": False,
        "reason": "ray_control_disabled",
        "flag_default": False,
        "tip_mount": False,
        "live_frames": False,
        "surface": surface if plan is None else plan.surface,
        "since_seq": int(since_seq or 0),
        "next_seq": int(since_seq or 0),
        "policy": visual_policy.to_dict(),
        "mutate_policy": mutate_policy.to_dict(),
        "mirror_policy": mirror_policy.to_dict(),
        "hb_policy": hb_policy.to_dict(),
        "tab_policy": tab_policy.to_dict(),
        "visual_tokens": {m: dict(t) for m, t in VISUAL_TOKENS.items()},
        "tip_matrix": dict(DISABLED_TIP_MATRIX),
        "shell_banner_zh": dict(SHELL_BANNER_ZH),
        "mutate_catalog": list(MUTATE_ACTIONS),
        "soft_catalog": list(SOFT_ACTIONS),
        "rules": {
            "tokens": "readonly opacity/cursor/banner/badge from VisualTokenPolicy + VISUAL_TOKENS",
            "tips": "DISABLED_TIP_MATRIX covers every MUTATE_ACTIONS + SOFT_ACTIONS id",
            "soft_tip": "soft actions tip_zh 跟随可查看; mutate tips block + 请切到领导标签",
            "shell": "C53 CreateRailShell still owns CTA lock; C54 only paints tokens/tips",
            "honesty": "no tip DOM; no competitor tokens or copy",
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
            "C54": "readonly shell visual tokens + disabled tip matrix",
        },
        "plan": None if plan is None else plan.to_dict(),
        "notes": "flag off: readonly shell visual tokens / tip matrix paper only; no tip DOM",
    }


def plan_or_none(surface: str) -> SubscribePlan | None:
    return plan_for(surface)
