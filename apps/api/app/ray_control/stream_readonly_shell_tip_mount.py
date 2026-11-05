"""FE create-rail readonly-shell tip-mount wiring checklist (Cycle 55).

Maps C54 visual tokens + DISABLED_TIP_MATRIX onto tip mount anchors
(create-rail CTA / soft actions / banner / badge) without mounting real tip DOM.
Paper + scratch dry-run — flag default false; true tip DOM needs 改码卡.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

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
    MutateDisablePolicy,
    advance_clock,
    apply_failover_and_reshell,
)
from .stream_leader_heartbeat import DEFAULT_HB_POLICY
from .stream_readonly_shell_tokens import (
    DEFAULT_VISUAL_POLICY,
    DISABLED_TIP_MATRIX,
    VisualTokenPolicy,
    project_token_shell,
    seed_token_board,
    tip_for,
    _refresh_token_shells,
)
from .stream_subscribe import SubscribePlan, plan_for
from .stream_tab_watermark import DEFAULT_POLICY as DEFAULT_TAB_POLICY, TabSyncPolicy

TIP_MOUNT_PRODUCT_PATH = "fe_readonly_shell_tip_mount"

MountTarget = Literal[
    "cta_button",
    "soft_action",
    "banner",
    "badge",
    "tip_portal",
]


@dataclass(frozen=True)
class WiringStep:
    """One checklist row for tip-mount ↔ C54 token/tip wiring (改码卡 unlock)."""

    id: str
    mount_target: MountTarget | str
    harness_call: str
    tip_rule: str
    acceptance: str
    needs_kouling: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


WIRING_STEPS: tuple[WiringStep, ...] = (
    WiringStep(
        id="W1",
        mount_target="cta_button",
        harness_call="bind tip_for(action, mode) on each MUTATE_ACTIONS CTA",
        tip_rule="readonly → DISABLED_TIP_MATRIX; interactive → 领导可写",
        acceptance="follower create_job tip starts with 跟随页不可; leader tip 领导可写",
        needs_kouling=True,
    ),
    WiringStep(
        id="W2",
        mount_target="soft_action",
        harness_call="bind tip_for soft actions (soft_refresh / open_read_detail / copy_job_id)",
        tip_rule="readonly soft → 跟随可查看*; interactive soft → 领导可查看",
        acceptance="soft tips never say 请切到领导标签",
        needs_kouling=True,
    ),
    WiringStep(
        id="W3",
        mount_target="banner",
        harness_call="project_token_shell → banner + badge tip surfaces",
        tip_rule="SHELL_BANNER_ZH[mode] + lock_icon when locked; badge uses follower tokens",
        acceptance="readonly banner_zh present; lock_icon set when shell.locked",
        needs_kouling=False,  # scratch projects shell + tokens today
    ),
    WiringStep(
        id="W4",
        mount_target="badge",
        harness_call="tip_bindings_cycle: seed → bind all tabs/actions → failover reshell",
        tip_rule="tip_delay_ms from VisualTokenPolicy; tip_mount stays false",
        acceptance="bindings cover MUTATE+SOFT; failover flips tip mode with role",
        needs_kouling=False,  # dry-run via tip_bindings_cycle
    ),
    WiringStep(
        id="W5",
        mount_target="tip_portal",
        harness_call="real tip DOM / portal on create-rail (ArcReel)",
        tip_rule="same tip_zh + delay contract as scratch; no competitor copy",
        acceptance="tip_mount true only after 改码卡",
        needs_kouling=True,
    ),
)


def wiring_checklist() -> list[dict[str, Any]]:
    return [s.to_dict() for s in WIRING_STEPS]


@dataclass(frozen=True)
class TipBinding:
    """One projected tip anchor (no DOM)."""

    tab_id: str
    action_id: str
    mode: str
    tip_zh: str
    mount_target: str
    tip_delay_ms: int
    locked: bool
    cursor: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TipMountBoard:
    """Wraps TokenBoard with projected tip bindings (scratch)."""

    tokens_surface: str
    bindings: list[TipBinding] = field(default_factory=list)
    tip_mount: bool = False
    flag_default: bool = False
    needs_kouling: tuple[str, ...] = ("改码卡",)

    def to_dict(self) -> dict[str, Any]:
        return {
            "tokens_surface": self.tokens_surface,
            "bindings": [b.to_dict() for b in self.bindings],
            "binding_count": len(self.bindings),
            "tip_mount": self.tip_mount,
            "flag_default": self.flag_default,
            "needs_kouling": list(self.needs_kouling),
        }


def _mount_target_for(action_id: str) -> str:
    soft_ids = {a["id"] for a in SOFT_ACTIONS}
    if action_id in soft_ids:
        return "soft_action"
    return "cta_button"


def project_tip_bindings(board) -> list[TipBinding]:
    """Project tip_for + visual tokens into TipBinding rows for every tab/action."""
    out: list[TipBinding] = []
    action_ids = [a["id"] for a in MUTATE_ACTIONS] + [a["id"] for a in SOFT_ACTIONS]
    for tab_id, shell in board.mutate.shells.items():
        projected = project_token_shell(board, tab_id)
        tokens = projected["visual_tokens"]
        for action_id in action_ids:
            out.append(
                TipBinding(
                    tab_id=tab_id,
                    action_id=action_id,
                    mode=shell.mode,
                    tip_zh=tip_for(action_id, shell.mode),
                    mount_target=_mount_target_for(action_id),
                    tip_delay_ms=int(board.policy.tip_delay_ms),
                    locked=bool(shell.locked),
                    cursor=str(tokens.get("cursor", "")),
                )
            )
        # Banner + badge synthetic anchors (one per tab).
        banner_zh = SHELL_BANNER_ZH.get(shell.mode, SHELL_BANNER_ZH.get("orphan", ""))
        out.append(
            TipBinding(
                tab_id=tab_id,
                action_id="__banner__",
                mode=shell.mode,
                tip_zh=banner_zh,
                mount_target="banner",
                tip_delay_ms=int(board.policy.tip_delay_ms),
                locked=bool(shell.locked),
                cursor=str(tokens.get("cursor", "")),
            )
        )
        out.append(
            TipBinding(
                tab_id=tab_id,
                action_id="__badge__",
                mode=shell.mode,
                tip_zh="跟随 · 只读" if shell.mode == "readonly" else (
                    "领导" if shell.mode == "interactive" else "未接入"
                ),
                mount_target="badge",
                tip_delay_ms=int(board.policy.tip_delay_ms),
                locked=bool(shell.locked),
                cursor=str(tokens.get("cursor", "")),
            )
        )
    return out


def tip_bindings_cycle(
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
    """Dry-run W3+W4: seed tokens → tip bindings → failover → rebind."""
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

    before = project_tip_bindings(board)
    leader_create = [
        b for b in before
        if b.tab_id == leader_tab and b.action_id == "create_job"
    ]
    assert leader_create and leader_create[0].tip_zh == "领导可写"
    follower_create = [
        b for b in before
        if b.tab_id != leader_tab and b.action_id == "create_job" and b.mode == "readonly"
    ]
    assert follower_create
    assert follower_create[0].tip_zh.startswith("跟随页不可")
    soft = [
        b for b in before
        if b.mode == "readonly" and b.action_id == "soft_refresh"
    ]
    assert soft and "跟随可查看" in soft[0].tip_zh
    assert "请切到领导标签" not in soft[0].tip_zh
    banners = [b for b in before if b.mount_target == "banner"]
    assert banners

    advance_clock(board.mutate.mirror.watch, hb_policy.timeout_ms + hb_policy.interval_ms)
    assert apply_failover_and_reshell(board.mutate) == "role_switched"
    _refresh_token_shells(board)
    after = project_tip_bindings(board)
    new_leader = board.mutate.mirror.watch.leader_tab_id()
    assert new_leader is not None and new_leader != leader_tab
    demoted_create = [
        b for b in after
        if b.tab_id == leader_tab and b.action_id == "create_job"
    ]
    assert demoted_create and demoted_create[0].mode == "readonly"
    assert demoted_create[0].tip_zh.startswith("跟随页不可")
    new_leader_create = [
        b for b in after
        if b.tab_id == new_leader and b.action_id == "create_job"
    ]
    assert new_leader_create and new_leader_create[0].tip_zh == "领导可写"

    tip_board = TipMountBoard(tokens_surface=plan.surface, bindings=after)
    return {
        "product_path": TIP_MOUNT_PRODUCT_PATH,
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
        "since_seq": board.mutate.mirror.watch.bus.shared_seq,
        "next_seq": board.mutate.mirror.watch.bus.shared_seq,
        "leader_tab_id": new_leader,
        "demoted_tab_id": leader_tab,
        "binding_count_before": len(before),
        "binding_count": len(after),
        "bindings": [b.to_dict() for b in after],
        "tip_matrix": dict(DISABLED_TIP_MATRIX),
        "shell_banner_zh": dict(SHELL_BANNER_ZH),
        "checklist": wiring_checklist(),
        "steps_dry_runnable": ["W3", "W4"],
        "steps_need_kouling": ["W1", "W2", "W5"],
        "board": tip_board.to_dict(),
        "peer_count": len(board.mutate.mirror.watch.bus.peers),
        "block_count": board.mutate.block_count,
        "catchup_product_paths": list(plan.catchup_product_paths),
        "plan": plan.to_dict(),
        "notes": (
            "Cycle 55: readonly-shell tip-mount wiring checklist; "
            "W3/W4 dry-runnable; W1/W2/W5 tip DOM waits 改码卡"
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
    """Flag-off: tip-mount wiring checklist paper only; no bindings bus."""
    return {
        "product_path": TIP_MOUNT_PRODUCT_PATH,
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
        "tip_matrix": dict(DISABLED_TIP_MATRIX),
        "shell_banner_zh": dict(SHELL_BANNER_ZH),
        "mutate_catalog": list(MUTATE_ACTIONS),
        "soft_catalog": list(SOFT_ACTIONS),
        "checklist": wiring_checklist(),
        "steps_dry_runnable": ["W3", "W4"],
        "steps_need_kouling": ["W1", "W2", "W5"],
        "bindings": [],
        "binding_count": 0,
        "rules": {
            "anchors": "CTA / soft / banner / badge / tip_portal",
            "tips": "reuse C54 tip_for + DISABLED_TIP_MATRIX; no competitor copy",
            "delay": "VisualTokenPolicy.tip_delay_ms (default 280)",
            "honesty": "tip_mount false until 改码卡; scratch only projects bindings",
        },
        "peer_count": 0,
        "block_count": 0,
        "ui_phase_hint": "offline",
        "label_zh_hint": "创建轨 tip 未挂载",
        "catchup_product_paths": [] if plan is None else list(plan.catchup_product_paths),
        "needs_kouling": ["改码卡"],
        "ties": {
            "C48": "leader owns reconnect UI FSM banner",
            "C50": "single_subscriber bus; followers mirror max(watermark)",
            "C51": "heartbeat lease + failover elect",
            "C52": "follower read-only mirror + leader/follower badges",
            "C53": "mutate-disable catalog + create-rail read-only shell",
            "C54": "readonly shell visual tokens + disabled tip matrix",
            "C55": "tip-mount wiring checklist on C54 tokens/tips",
        },
        "plan": None if plan is None else plan.to_dict(),
        "notes": "flag off: tip-mount wiring checklist paper only; no tip DOM",
    }


def plan_or_none(surface: str) -> SubscribePlan | None:
    return plan_for(surface)
