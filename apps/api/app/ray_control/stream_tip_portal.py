"""FE tip portal pseudocode deepen (Cycle 66).

Deepens Cycle 55 W5 tip_portal + Cycle 65 JR-R5 (tip / task-center mount)
into a machine-checkable portal contract + offline dry-run. Projects host /
anchor registry, open/close/delay intents, role-aware tip text, and
job.terminal → toast+tip handoff — without mounting live ArcReel tip DOM.

Flag default false; tip_mount=false; accepted=false; no ray start.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Mapping

from .ray_job_router_emit_gate import OP_DEFAULTS
from .stream_follower_mutate_disable import MUTATE_ACTIONS, SOFT_ACTIONS
from .stream_readonly_shell_tip_mount import (
    TIP_MOUNT_PRODUCT_PATH,
    TipBinding,
    WIRING_STEPS,
    tip_bindings_cycle,
)
from .stream_readonly_shell_tokens import (
    DEFAULT_VISUAL_POLICY,
    DISABLED_TIP_MATRIX,
    VisualTokenPolicy,
    tip_for,
)
from .stream_subscribe import SubscribePlan, plan_for

PRODUCT_PATH = "fe_tip_portal_pseudocode"
MILESTONE = "fe_tip_portal_pseudocode_ready"

PortalHost = Literal["create_rail", "task_center"]
PortalAnchor = Literal[
    "cta_button",
    "soft_action",
    "banner",
    "badge",
    "task_row",
    "toast_focus",
    "tip_portal",
]
PortalPhase = Literal["idle", "delay", "open", "close", "blocked"]


# --- Catalog -----------------------------------------------------------------

@dataclass(frozen=True)
class PortalStep:
    """One tip-portal lifecycle checklist row (TP*)."""

    id: str
    title: str
    summary: str
    host: str
    anchors: tuple[str, ...]
    harness_call: str
    acceptance: str
    kouling_blocker: tuple[str, ...]
    implementable_offline: bool
    ties: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["anchors"] = list(self.anchors)
        d["kouling_blocker"] = list(self.kouling_blocker)
        d["ties"] = list(self.ties)
        d["needs_kouling"] = bool(self.kouling_blocker)
        return d


PORTAL_STEPS: tuple[PortalStep, ...] = (
    PortalStep(
        id="TP1",
        title="portal host registry",
        summary="Register create_rail + task_center as tip portal hosts.",
        host="create_rail|task_center",
        anchors=("tip_portal",),
        harness_call="register_portal_hosts(create_rail, task_center)",
        acceptance="hosts list both surfaces; tip_mount stays false",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("C55-W5", "JR-R5"),
    ),
    PortalStep(
        id="TP2",
        title="anchor registry",
        summary=(
            "Map CTA / soft / banner / badge / task_row / toast_focus "
            "anchors onto portal host slots."
        ),
        host="create_rail|task_center",
        anchors=(
            "cta_button",
            "soft_action",
            "banner",
            "badge",
            "task_row",
            "toast_focus",
        ),
        harness_call="register_portal_anchors(host, anchors)",
        acceptance="six anchors registered; no live DOM",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("C55-W1..W4", "JR-R5"),
    ),
    PortalStep(
        id="TP3",
        title="open / close / delay lifecycle",
        summary=(
            "Hover/focus → tip_delay_ms → open intent; leave/blur/timeout → close. "
            "Delay from VisualTokenPolicy (default 280)."
        ),
        host="create_rail",
        anchors=("cta_button", "soft_action", "banner", "badge"),
        harness_call="project_open_close_intents(delay_ms)",
        acceptance="open intents carry delay_ms; tip_mount=false; phase never live-open",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("C54", "C55-W4"),
    ),
    PortalStep(
        id="TP4",
        title="role-aware tip text",
        summary=(
            "Project tip_for(action, mode) for leader vs follower; "
            "reuse DISABLED_TIP_MATRIX; never duplicate matrix text."
        ),
        host="create_rail",
        anchors=("cta_button", "soft_action", "banner", "badge"),
        harness_call="tip_for + project_tip_bindings / tip_bindings_cycle",
        acceptance="leader create_job→领导可写; follower→跟随页不可*; soft never 请切到领导标签",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("C54", "C55"),
    ),
    PortalStep(
        id="TP5",
        title="failover tip rebind",
        summary="On leader failover, reproject tip bindings with flipped roles.",
        host="create_rail",
        anchors=("cta_button", "badge"),
        harness_call="tip_bindings_cycle failover path",
        acceptance="demoted tip flips to readonly; new leader tip 领导可写",
        kouling_blocker=(),
        implementable_offline=True,
        ties=("C51", "C55-W4"),
    ),
    PortalStep(
        id="TP6",
        title="job.terminal → toast + tip handoff",
        summary=(
            "Map C64 OP_DEFAULTS terminal/cancel (bus_kind=job.terminal) onto "
            "toast_focus + task_row tip intents for JR-R5."
        ),
        host="task_center",
        anchors=("toast_focus", "task_row", "tip_portal"),
        harness_call="terminal_to_portal_intent(state)",
        acceptance=(
            "succeeded/failed/cancelled produce toast+tip intents; "
            "accepted=false; tip_mount=false; no live hub"
        ),
        kouling_blocker=("改码卡", "Ray LAN（含 head）"),
        implementable_offline=False,  # paper map ok; live hub needs kouling
        ties=("C64", "C65-JR-R5", "export_toast"),
    ),
    PortalStep(
        id="TP7",
        title="tip_mount kouling gate",
        summary=(
            "Keep tip_mount=false until 改码卡; Ray LAN not required for offline "
            "dry-run of TP1–TP5 paper projections."
        ),
        host="create_rail|task_center",
        anchors=("tip_portal",),
        harness_call="portal_plan.tip_mount / needs_kouling",
        acceptance="tip_mount false; accepted false when kouling listed; no ray start",
        kouling_blocker=("改码卡",),
        implementable_offline=False,
        ties=("C55-W5", "JR-R5"),
    ),
)


def portal_checklist() -> list[dict[str, Any]]:
    return [s.to_dict() for s in PORTAL_STEPS]


def get_portal_step(step_id: str) -> PortalStep | None:
    for s in PORTAL_STEPS:
        if s.id == step_id:
            return s
    return None


def offline_step_ids() -> list[str]:
    return [s.id for s in PORTAL_STEPS if s.implementable_offline]


def kouling_step_ids() -> list[str]:
    return [s.id for s in PORTAL_STEPS if s.kouling_blocker]


# --- Anchors / hosts ---------------------------------------------------------

@dataclass(frozen=True)
class PortalAnchorSpec:
    """One portal anchor slot (paper)."""

    id: str
    host: PortalHost | str
    mount_target: str
    source_cycle: str
    tip_rule: str
    delay_ms_source: str = "VisualTokenPolicy.tip_delay_ms"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


PORTAL_ANCHORS: tuple[PortalAnchorSpec, ...] = (
    PortalAnchorSpec(
        id="cta_button",
        host="create_rail",
        mount_target="cta_button",
        source_cycle="C55-W1",
        tip_rule="tip_for(mutate, mode)",
    ),
    PortalAnchorSpec(
        id="soft_action",
        host="create_rail",
        mount_target="soft_action",
        source_cycle="C55-W2",
        tip_rule="tip_for(soft, mode); never 请切到领导标签",
    ),
    PortalAnchorSpec(
        id="banner",
        host="create_rail",
        mount_target="banner",
        source_cycle="C55-W3",
        tip_rule="SHELL_BANNER_ZH[mode]",
    ),
    PortalAnchorSpec(
        id="badge",
        host="create_rail",
        mount_target="badge",
        source_cycle="C55-W4",
        tip_rule="领导 / 跟随·只读 / 未接入",
    ),
    PortalAnchorSpec(
        id="task_row",
        host="task_center",
        mount_target="task_row",
        source_cycle="JR-R5",
        tip_rule="job.terminal tip_zh by state",
    ),
    PortalAnchorSpec(
        id="toast_focus",
        host="create_rail",
        mount_target="toast_focus",
        source_cycle="C64/C65 + export_toast",
        tip_rule="focus toast from job.terminal; short success/fail copy",
    ),
)


def anchor_catalog() -> list[dict[str, Any]]:
    return [a.to_dict() for a in PORTAL_ANCHORS]


PORTAL_HOSTS: tuple[str, ...] = ("create_rail", "task_center")


# --- Terminal → toast+tip handoff (paper; ToIV original zh) ------------------

# Maps ProgressBus terminal states → portal intents. No competitor copy.
TERMINAL_PORTAL_MAP: dict[str, dict[str, str]] = {
    "succeeded": {
        "toast_kind": "success",
        "toast_zh": "任务已完成",
        "tip_zh": "任务已完成 · 可在任务中心查看",
        "task_row_tip_zh": "已完成 · 点开详情",
        "surface": "toast_focus",
    },
    "failed": {
        "toast_kind": "failure",
        "toast_zh": "任务失败",
        "tip_zh": "任务失败 · 可查看原因或重试",
        "task_row_tip_zh": "失败 · 可重试",
        "surface": "toast_focus",
    },
    "cancelled": {
        "toast_kind": "info",
        "toast_zh": "任务已取消",
        "tip_zh": "任务已取消 · 可在任务中心确认",
        "task_row_tip_zh": "已取消",
        "surface": "toast_focus",
    },
}


@dataclass(frozen=True)
class PortalIntent:
    """Projected open/close/terminal intent (no DOM)."""

    kind: str  # open | close | terminal_toast | terminal_tip
    host: str
    anchor: str
    tip_zh: str
    delay_ms: int
    phase: PortalPhase | str
    role_mode: str = ""
    job_id: str | None = None
    terminal_state: str | None = None
    toast_kind: str | None = None
    tip_mount: bool = False
    accepted: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def terminal_to_portal_intent(
    state: str,
    *,
    job_id: str = "job-demo",
    delay_ms: int | None = None,
) -> dict[str, Any]:
    """Map a terminal job state onto toast+tip portal intents (paper)."""
    delay = int(
        DEFAULT_VISUAL_POLICY.tip_delay_ms if delay_ms is None else delay_ms
    )
    row = TERMINAL_PORTAL_MAP.get(state)
    if row is None:
        return {
            "ok": False,
            "reason": "unknown_terminal_state",
            "state": state,
            "tip_mount": False,
            "accepted": False,
            "intents": [],
            "ray_started": False,
            "join_ready": False,
        }

    # Confirm C64 OP_DEFAULTS: terminal/cancel → job.terminal + emit true.
    terminal_op = OP_DEFAULTS.get("terminal", {})
    cancel_op = OP_DEFAULTS.get("cancel", {})
    bus_ok = (
        terminal_op.get("bus_kind") == "job.terminal"
        and terminal_op.get("emit") is True
        and cancel_op.get("bus_kind") == "job.terminal"
    )

    toast_intent = PortalIntent(
        kind="terminal_toast",
        host="create_rail",
        anchor="toast_focus",
        tip_zh=row["toast_zh"],
        delay_ms=delay,
        phase="blocked",
        job_id=job_id,
        terminal_state=state,
        toast_kind=row["toast_kind"],
        tip_mount=False,
        accepted=False,
    )
    tip_intent = PortalIntent(
        kind="terminal_tip",
        host="task_center",
        anchor="task_row",
        tip_zh=row["task_row_tip_zh"],
        delay_ms=delay,
        phase="blocked",
        job_id=job_id,
        terminal_state=state,
        toast_kind=row["toast_kind"],
        tip_mount=False,
        accepted=False,
    )
    return {
        "ok": True,
        "reason": "paper_terminal_handoff_await_kouling",
        "state": state,
        "job_id": job_id,
        "tip_mount": False,
        "accepted": False,
        "ray_started": False,
        "join_ready": False,
        "needs_kouling": ["改码卡", "Ray LAN（含 head）"],
        "c64_bus_kind_ok": bus_ok,
        "c64_terminal_emit": bool(terminal_op.get("emit")),
        "op_defaults_terminal": {
            "bus_kind": terminal_op.get("bus_kind"),
            "emit": terminal_op.get("emit"),
            "state": terminal_op.get("state"),
        },
        "map": dict(row),
        "intents": [toast_intent.to_dict(), tip_intent.to_dict()],
        "jr_r5_ticket": "JR-R5",
        "notes": (
            "Cycle 66: job.terminal → toast_focus + task_row tip intents; "
            "live hub / tip DOM waits 改码卡 + Ray LAN"
        ),
    }


def project_open_close_intents(
    bindings: list[TipBinding] | list[Mapping[str, Any]],
    *,
    delay_ms: int | None = None,
) -> list[dict[str, Any]]:
    """Project open+close intents from tip bindings (tip_mount always false)."""
    delay = int(
        DEFAULT_VISUAL_POLICY.tip_delay_ms if delay_ms is None else delay_ms
    )
    out: list[dict[str, Any]] = []
    for b in bindings:
        if isinstance(b, TipBinding):
            d = b.to_dict()
        else:
            d = dict(b)
        # Skip synthetic banner/badge for open on CTA/soft only? Keep all.
        host = "create_rail"
        out.append(
            PortalIntent(
                kind="open",
                host=host,
                anchor=str(d.get("mount_target") or "cta_button"),
                tip_zh=str(d.get("tip_zh") or ""),
                delay_ms=int(d.get("tip_delay_ms") or delay),
                phase="delay",
                role_mode=str(d.get("mode") or ""),
                tip_mount=False,
                accepted=False,
            ).to_dict()
        )
        out.append(
            PortalIntent(
                kind="close",
                host=host,
                anchor=str(d.get("mount_target") or "cta_button"),
                tip_zh="",
                delay_ms=0,
                phase="close",
                role_mode=str(d.get("mode") or ""),
                tip_mount=False,
                accepted=False,
            ).to_dict()
        )
    return out


# --- Plan / dry-run ----------------------------------------------------------

@dataclass
class PortalPlan:
    """Offline portal plan projection (scratch)."""

    product_path: str = PRODUCT_PATH
    milestone: str = MILESTONE
    hosts: tuple[str, ...] = PORTAL_HOSTS
    tip_mount: bool = False
    tip_delay_ms: int = 280
    accepted: bool = False
    ray_started: bool = False
    join_ready: bool = False
    flag_default: bool = False
    needs_kouling: tuple[str, ...] = ("改码卡", "Ray LAN（含 head）")
    steps: list[dict[str, Any]] = field(default_factory=list)
    anchors: list[dict[str, Any]] = field(default_factory=list)
    intents: list[dict[str, Any]] = field(default_factory=list)
    role_tips: dict[str, Any] = field(default_factory=dict)
    terminal_handoffs: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "product_path": self.product_path,
            "milestone": self.milestone,
            "hosts": list(self.hosts),
            "tip_mount": self.tip_mount,
            "tip_delay_ms": self.tip_delay_ms,
            "accepted": self.accepted,
            "ray_started": self.ray_started,
            "join_ready": self.join_ready,
            "flag_default": self.flag_default,
            "needs_kouling": list(self.needs_kouling),
            "steps": list(self.steps),
            "anchors": list(self.anchors),
            "intents": list(self.intents),
            "role_tips": dict(self.role_tips),
            "terminal_handoffs": list(self.terminal_handoffs),
            "step_count": len(self.steps),
            "anchor_count": len(self.anchors),
            "intent_count": len(self.intents),
        }


def competitor_pattern_rows() -> list[dict[str, str]]:
    """Summarize competitor UX patterns → ToIV TP steps (no copyrighted copy)."""
    return [
        {
            "pattern": "disabled control hover tip",
            "toiv_step": "TP2/TP4",
            "landing": "cta_button + tip_for(readonly)",
        },
        {
            "pattern": "soft-action still readable tip",
            "toiv_step": "TP2/TP4",
            "landing": "soft_action + 跟随可查看*",
        },
        {
            "pattern": "role badge / shell banner tip",
            "toiv_step": "TP2/TP5",
            "landing": "banner + badge; failover rebind",
        },
        {
            "pattern": "delay before tip open",
            "toiv_step": "TP3",
            "landing": "tip_delay_ms (default 280)",
        },
        {
            "pattern": "terminal job toast + task-center row tip",
            "toiv_step": "TP6",
            "landing": "job.terminal → toast_focus + task_row (JR-R5)",
        },
        {
            "pattern": "real tip portal mount",
            "toiv_step": "TP7",
            "landing": "tip_mount false until 改码卡",
        },
    ]


def role_aware_tip_samples(
    *,
    visual_policy: VisualTokenPolicy = DEFAULT_VISUAL_POLICY,
) -> dict[str, Any]:
    """Sample leader vs follower tip_zh without seeding a full board."""
    _ = visual_policy  # reserved for delay/opacity overlays
    create_leader = tip_for("create_job", "interactive")
    create_follower = tip_for("create_job", "readonly")
    soft_follower = tip_for("soft_refresh", "readonly")
    soft_leader = tip_for("soft_refresh", "interactive")
    return {
        "create_job_leader": create_leader,
        "create_job_follower": create_follower,
        "soft_refresh_follower": soft_follower,
        "soft_refresh_leader": soft_leader,
        "follower_starts_with_跟随页不可": create_follower.startswith("跟随页不可"),
        "soft_has_跟随可查看": "跟随可查看" in soft_follower,
        "soft_never_请切到领导标签": "请切到领导标签" not in soft_follower,
        "leader_is_领导可写": create_leader == "领导可写",
        "tip_matrix_keys": sorted(DISABLED_TIP_MATRIX.keys()),
        "mutate_count": len(MUTATE_ACTIONS),
        "soft_count": len(SOFT_ACTIONS),
        "c55_w5_still_kouling": WIRING_STEPS[4].needs_kouling is True,
        "c55_product_path": TIP_MOUNT_PRODUCT_PATH,
    }


def run_tip_portal_cycle(
    *,
    surface: str = "create_rail",
    leader_tab: str = "tab-a",
    initial_seqs: dict[str, int] | None = None,
    sample_job_id: str = "job-demo-c66",
    visual_policy: VisualTokenPolicy = DEFAULT_VISUAL_POLICY,
    plan: SubscribePlan | None = None,
) -> dict[str, Any]:
    """Flag-on offline dry-run: bindings + open intents + terminal handoff.

    tip_mount stays false; accepted=false; never starts Ray / joins workers.
    """
    plan = plan or plan_for(surface)
    role = role_aware_tip_samples(visual_policy=visual_policy)
    delay = int(visual_policy.tip_delay_ms)

    bindings_body: dict[str, Any] | None = None
    open_intents: list[dict[str, Any]] = []
    failover_ok = False
    if plan is not None:
        bindings_body = tip_bindings_cycle(
            plan,
            initial_seqs=initial_seqs
            or {"tab-a": 4, "tab-b": 9, "tab-c": 6},
            leader_tab=leader_tab,
            visual_policy=visual_policy,
        )
        open_intents = project_open_close_intents(
            bindings_body.get("bindings") or [],
            delay_ms=delay,
        )
        failover_ok = (
            bindings_body.get("demoted_tab_id") == leader_tab
            and bindings_body.get("leader_tab_id") not in (None, leader_tab)
            and bindings_body.get("tip_mount") is False
        )

    terminal_states = ("succeeded", "failed", "cancelled")
    handoffs = [
        terminal_to_portal_intent(s, job_id=sample_job_id, delay_ms=delay)
        for s in terminal_states
    ]
    bad_terminal = terminal_to_portal_intent(
        "running", job_id=sample_job_id, delay_ms=delay
    )

    all_accepted_false = all(h.get("accepted") is False for h in handoffs)
    all_tip_mount_false = all(h.get("tip_mount") is False for h in handoffs)
    all_intents_unmounted = all(
        intent.get("tip_mount") is False
        for h in handoffs
        for intent in (h.get("intents") or [])
    )
    c64_ok = all(h.get("c64_bus_kind_ok") is True for h in handoffs)

    portal = PortalPlan(
        tip_delay_ms=delay,
        steps=portal_checklist(),
        anchors=anchor_catalog(),
        intents=open_intents[:12],  # sample slice for payload size
        role_tips=role,
        terminal_handoffs=handoffs,
        needs_kouling=("改码卡", "Ray LAN（含 head）"),
    )

    return {
        "product_path": PRODUCT_PATH,
        "milestone": MILESTONE,
        "enabled": True,
        "reason": None,
        "flag_default": False,
        "tip_mount": False,
        "accepted": False,
        "ray_started": False,
        "join_ready": False,
        "join_ready_any": False,
        "live_frames": False,
        "surface": surface if plan is None else plan.surface,
        "tip_delay_ms": delay,
        "hosts": list(PORTAL_HOSTS),
        "checklist": portal_checklist(),
        "steps_dry_runnable": offline_step_ids(),
        "steps_need_kouling": kouling_step_ids(),
        "anchors": anchor_catalog(),
        "competitor_patterns": competitor_pattern_rows(),
        "role_tips": role,
        "failover_ok": failover_ok,
        "binding_count": 0 if bindings_body is None else bindings_body.get("binding_count", 0),
        "open_close_intent_count": len(open_intents),
        "open_close_intents_sample": open_intents[:8],
        "all_open_intents_tip_mount_false": all(
            i.get("tip_mount") is False for i in open_intents
        ),
        "terminal_handoffs": handoffs,
        "bad_terminal_rejected": bad_terminal.get("ok") is False,
        "all_accepted_false": all_accepted_false,
        "all_tip_mount_false": all_tip_mount_false and all_intents_unmounted,
        "c64_terminal_bus_ok": c64_ok,
        "tp6_blocked": "TP6" in kouling_step_ids(),
        "tp7_blocked": "TP7" in kouling_step_ids(),
        "c55_w5_kouling": True,
        "c55_tip_mount_path": TIP_MOUNT_PRODUCT_PATH,
        "jr_r5_ticket": "JR-R5",
        "needs_kouling": ["改码卡", "Ray LAN（含 head）"],
        "plan": portal.to_dict(),
        "subscribe_plan": None if plan is None else plan.to_dict(),
        "bindings_cycle": None
        if bindings_body is None
        else {
            "product_path": bindings_body.get("product_path"),
            "tip_mount": bindings_body.get("tip_mount"),
            "leader_tab_id": bindings_body.get("leader_tab_id"),
            "demoted_tab_id": bindings_body.get("demoted_tab_id"),
            "binding_count": bindings_body.get("binding_count"),
        },
        "ties": {
            "C54": "tip_for + DISABLED_TIP_MATRIX + VisualTokenPolicy",
            "C55": "W5 tip_portal still needs 改码卡; W3/W4 dry-run reused",
            "C64": "OP_DEFAULTS terminal/cancel → job.terminal emit=true",
            "C65": "JR-R5 tip / 任务中心挂载 kouling",
            "export_toast": "toast surface pattern (no live FFmpeg)",
        },
        "notes": (
            "Cycle 66: tip portal pseudocode deepen; TP1–TP5 offline; "
            "TP6/TP7 await 改码卡 (+ Ray LAN for live hub); tip_mount=false"
        ),
    }


def contract_static_payload(
    *,
    surface: str = "create_rail",
    visual_policy: VisualTokenPolicy = DEFAULT_VISUAL_POLICY,
    plan: SubscribePlan | None = None,
) -> dict[str, Any]:
    """Flag-off: tip portal checklist paper only; no binding bus / no intents."""
    role = role_aware_tip_samples(visual_policy=visual_policy)
    return {
        "product_path": PRODUCT_PATH,
        "milestone": MILESTONE,
        "enabled": False,
        "reason": "ray_control_disabled",
        "flag_default": False,
        "tip_mount": False,
        "accepted": False,
        "ray_started": False,
        "join_ready": False,
        "join_ready_any": False,
        "live_frames": False,
        "surface": surface if plan is None else plan.surface,
        "tip_delay_ms": int(visual_policy.tip_delay_ms),
        "hosts": list(PORTAL_HOSTS),
        "checklist": portal_checklist(),
        "steps_dry_runnable": offline_step_ids(),
        "steps_need_kouling": kouling_step_ids(),
        "anchors": anchor_catalog(),
        "competitor_patterns": competitor_pattern_rows(),
        "role_tips": role,
        "terminal_map_keys": sorted(TERMINAL_PORTAL_MAP.keys()),
        "op_defaults_terminal": {
            "bus_kind": OP_DEFAULTS["terminal"]["bus_kind"],
            "emit": OP_DEFAULTS["terminal"]["emit"],
        },
        "c55_tip_mount_path": TIP_MOUNT_PRODUCT_PATH,
        "jr_r5_ticket": "JR-R5",
        "needs_kouling": ["改码卡", "Ray LAN（含 head）"],
        "rules": {
            "hosts": "create_rail + task_center",
            "anchors": "cta / soft / banner / badge / task_row / toast_focus",
            "tips": "reuse tip_for + DISABLED_TIP_MATRIX; no competitor copy",
            "delay": "VisualTokenPolicy.tip_delay_ms (default 280)",
            "terminal": "job.terminal → toast_focus + task_row (JR-R5 paper)",
            "honesty": "tip_mount false until 改码卡; Ray LAN not required for offline dry-run",
        },
        "ties": {
            "C54": "tip_for + DISABLED_TIP_MATRIX + VisualTokenPolicy",
            "C55": "W5 tip_portal still needs 改码卡",
            "C64": "OP_DEFAULTS terminal emit",
            "C65": "JR-R5 tip / 任务中心挂载",
        },
        "plan": None if plan is None else plan.to_dict(),
        "notes": (
            "flag off: tip portal pseudocode checklist paper only; "
            "no tip DOM / no live hub"
        ),
    }


def plan_or_none(surface: str) -> SubscribePlan | None:
    return plan_for(surface)

