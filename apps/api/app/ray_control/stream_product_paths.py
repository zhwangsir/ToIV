"""Unified ProgressStream / catch-up product_path index (Cycle 44).

Competitive pattern: one workbench subscribes to a single progress pipe, then
routes frames by channel/job namespace. ToIV scratch exposes several flag-gated
payload helpers that all share ProgressStreamHub + SSE/WS path hints — this
module is the single lookup so FE/改码卡 wiring does not hunt constants.

No tip mount / no live StreamingResponse / flag default false.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

Family = Literal["stream", "catchup", "toast", "adjacent"]

SSE_PATH_HINT = "/api/ray/progress/stream"
WS_PATH_HINT = "/api/ray/progress/ws"


@dataclass(frozen=True)
class StreamProductPath:
    """One product_path row in the stream/catch-up index."""

    product_path: str
    family: Family
    cycle: int
    helper: str
    description: str
    filter_hint: str = ""
    channels: tuple[str, ...] = ("progress",)
    sse_path: str = SSE_PATH_HINT
    ws_path: str = WS_PATH_HINT
    tip_mount: bool = False
    needs_kouling: tuple[str, ...] = ("改码卡",)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["channels"] = list(self.channels)
        d["needs_kouling"] = list(self.needs_kouling)
        return d


# --- Canonical stream family (ProgressStreamHub) --------------------------------

STREAM_ENTRIES: tuple[StreamProductPath, ...] = (
    StreamProductPath(
        product_path="progress_sse_ws",
        family="stream",
        cycle=40,
        helper="routes_stream.progress_stream_since_payload",
        description="Bus/hub catch-up snapshot + SSE text preview (all jobs)",
        filter_hint="none (full hub buffer)",
        channels=("progress", "toast"),
    ),
    StreamProductPath(
        product_path="job_router_stream_hub",
        family="stream",
        cycle=41,
        helper="routes_stream.drain_router_stream_payload",
        description="JobRouter drain/tick → hub frames (progress + focus toast)",
        filter_hint="frames published during drain window",
        channels=("progress", "toast"),
    ),
    StreamProductPath(
        product_path="client_stream_hub",
        family="stream",
        cycle=42,
        helper="routes_stream.client_stream_payload",
        description="Client enqueue/retry/cancel mutation → hub catch-up (no drain)",
        filter_hint="frames already published by client hot path",
        channels=("progress", "toast"),
    ),
    StreamProductPath(
        product_path="export_stream_hub",
        family="stream",
        cycle=43,
        helper="routes_stream.export_stream_payload",
        description="Export ProgressBus publish → hub; filter export:* / kind=export",
        filter_hint="job_id startswith export: OR labels.kind=export",
        channels=("progress", "toast"),
    ),
)

# --- Catch-up / journal companions (same FE since watermark story) --------------

CATCHUP_ENTRIES: tuple[StreamProductPath, ...] = (
    StreamProductPath(
        product_path="ray_job_deltas_dr4",
        family="catchup",
        cycle=31,
        helper="routes_jobs.list_job_deltas_payload",
        description="D-R4 JobDeltaJournal list_since (authoritative audit/catch-up)",
        filter_hint="journal seq watermark",
        channels=("progress",),
        sse_path="",
        ws_path="",
    ),
    StreamProductPath(
        product_path="job_router_delta_journal",
        family="catchup",
        cycle=34,
        helper="routes_jobs.drain_router_deltas_payload",
        description="JobRouter → optional D-R4 dual-write drain",
        filter_hint="router journal window",
        channels=("progress",),
        sse_path="",
        ws_path="",
    ),
    StreamProductPath(
        product_path="retry_delta_journal",
        family="catchup",
        cycle=35,
        helper="routes_jobs.retry_with_journal_payload",
        description="Client.retry → ProgressBus + D-R4 dual-write",
        filter_hint="retry mutation",
        channels=("progress",),
        sse_path="",
        ws_path="",
    ),
    StreamProductPath(
        product_path="cancel_delta_journal",
        family="catchup",
        cycle=36,
        helper="routes_jobs.cancel_with_journal_payload",
        description="Client.cancel → ProgressBus + D-R4 dual-write",
        filter_hint="cancel mutation",
        channels=("progress",),
        sse_path="",
        ws_path="",
    ),
    StreamProductPath(
        product_path="enqueue_delta_journal",
        family="catchup",
        cycle=37,
        helper="routes_jobs.enqueue_with_journal_payload",
        description="Client.enqueue → ProgressBus + D-R4 dual-write",
        filter_hint="enqueue mutation",
        channels=("progress",),
        sse_path="",
        ws_path="",
    ),
    StreamProductPath(
        product_path="sessions_list_since",
        family="catchup",
        cycle=38,
        helper="routes_sessions.list_sessions_since_payload",
        description="Sessions stack catch-up via D-R4 list_since",
        filter_hint="session ids in journal",
        channels=("progress",),
        sse_path="",
        ws_path="",
    ),
    StreamProductPath(
        product_path="jobs_list_since",
        family="catchup",
        cycle=39,
        helper="routes_jobs.list_jobs_since_payload",
        description="Task-center job_list catch-up via D-R4 list_since",
        filter_hint="job ids in journal",
        channels=("progress", "task_center"),
        sse_path="",
        ws_path="",
    ),
    StreamProductPath(
        product_path="fe_stream_reconnect",
        family="catchup",
        cycle=46,
        helper="routes_stream.fe_stream_reconnect_payload",
        description="FE reconnect dry-run: disconnect keeps watermark; hub list_since catch-up (S5)",
        filter_hint="client since_seq / next_seq watermark; optional plan.catchup_product_paths overlay",
        channels=("progress", "toast", "task_center"),
    ),
    StreamProductPath(
        product_path="fe_es_onerror_wiring",
        family="catchup",
        cycle=47,
        helper="routes_stream.fe_es_onerror_wiring_payload",
        description="FE EventSource onerror → ReconnectState watermark wiring checklist (W1–W5)",
        filter_hint="onerror→simulate_disconnect(es_onerror); reopen via hub.list_since; tip mount needs 改码卡",
        channels=("progress", "toast", "task_center"),
    ),
    StreamProductPath(
        product_path="fe_reconnect_ui_fsm",
        family="catchup",
        cycle=48,
        helper="routes_stream.fe_reconnect_ui_fsm_payload",
        description="FE workbench reconnecting UI FSM (live/重连中/补齐/offline/degraded); honest progress",
        filter_hint="banner phase from ReconnectState; null progress stays null; tip banner needs 改码卡",
        channels=("progress", "toast", "task_center"),
    ),
    StreamProductPath(
        product_path="fe_reconnect_backoff",
        family="catchup",
        cycle=49,
        helper="routes_stream.fe_reconnect_backoff_payload",
        description="FE reconnect full-jitter backoff budget (T4/T5); attempt+wall cap → degraded",
        filter_hint="delay=U(0,min(cap,base*2^attempt)); watermark unchanged; tip timers need 改码卡",
        channels=("progress", "toast", "task_center"),
    ),
    StreamProductPath(
        product_path="fe_tab_watermark_sync",
        family="catchup",
        cycle=50,
        helper="routes_stream.fe_tab_watermark_sync_payload",
        description="FE multi-tab max(watermark) sync; single EventSource leader; reject regress",
        filter_hint="BroadcastChannel/storage sketch; shared_seq=max; tip channel needs 改码卡",
        channels=("progress", "toast", "task_center"),
    ),
    StreamProductPath(
        product_path="fe_leader_heartbeat_failover",
        family="catchup",
        cycle=51,
        helper="routes_stream.fe_leader_heartbeat_failover_payload",
        description="FE leader-tab heartbeat lease + failover elect; ES transfer; watermark intact",
        filter_hint="interval/timeout lease; lowest_tab_id election; tip timers need 改码卡",
        channels=("progress", "toast", "task_center"),
    ),
    StreamProductPath(
        product_path="fe_follower_mirror_badge",
        family="catchup",
        cycle=52,
        helper="routes_stream.fe_follower_mirror_badge_payload",
        description="FE follower read-only mirror + leader/follower badges; reject follower mutate",
        filter_hint="mirror shared_seq; 领导/跟随·只读 badges; tip DOM needs 改码卡",
        channels=("progress", "toast", "task_center"),
    ),
    StreamProductPath(
        product_path="fe_follower_mutate_disable",
        family="catchup",
        cycle=53,
        helper="routes_stream.fe_follower_mutate_disable_payload",
        description="FE follower mutate-disable catalog + create-rail read-only shell; soft actions allowed",
        filter_hint="disable MUTATE_ACTIONS; lock create-rail CTAs; failover unlock; tip DOM needs 改码卡",
        channels=("progress", "toast", "task_center"),
    ),
    StreamProductPath(
        product_path="fe_readonly_shell_visual_tokens",
        family="catchup",
        cycle=54,
        helper="routes_stream.fe_readonly_shell_visual_tokens_payload",
        description="FE create-rail readonly shell visual tokens + disabled-state tip copy matrix (ToIV zh)",
        filter_hint="opacity/cursor/banner/badge tokens; per-action tip_zh; tip DOM needs 改码卡",
        channels=("progress", "toast", "task_center"),
    ),
    StreamProductPath(
        product_path="fe_readonly_shell_tip_mount",
        family="catchup",
        cycle=55,
        helper="routes_stream.fe_readonly_shell_tip_mount_payload",
        description="FE create-rail readonly-shell tip-mount wiring checklist (CTA/soft/banner/badge → tip_zh)",
        filter_hint="W1–W5 tip anchors; W3/W4 dry-run; tip DOM / portal needs 改码卡",
        channels=("progress", "toast", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_lan_readonly_probe",
        family="catchup",
        cycle=56,
        helper="routes_stream.ray_lan_readonly_probe_payload",
        description="Ray LAN read-only probe checklist + frozen-fleet inventory drift vs paper head",
        filter_hint="P0–P6; GCS 6380≠Redis 6379; live TCP optional; no ray start; Ray LAN 口令",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_worker_label_contract",
        family="catchup",
        cycle=57,
        helper="routes_stream.ray_worker_label_contract_payload",
        description="Ray worker label contract: canonical keys + frozen profiles + requires⊆labels match",
        filter_hint="role/pool/host_id/comfy_port/llm_port; join_ready=false until Ray LAN+head; no ray start",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_node_register_contract",
        family="catchup",
        cycle=58,
        helper="routes_stream.ray_node_register_contract_payload",
        description="Ray NodeRegistry register field contract: wire→NodeInfo→Redis→Cycle57 labels",
        filter_hint="register dry-run; join_ready=false; paper .47 rejected; no ray start; empty gpu_uuid OK",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_scheduler_enqueue_contract",
        family="catchup",
        cycle=59,
        helper="routes_stream.ray_scheduler_enqueue_contract_payload",
        description="Ray PriorityScheduler enqueue field contract: wire→JobSpec→Redis→Cycle57 labels",
        filter_hint="enqueue dry-run; join_ready=false; paper .47 rejected; requires⊆CANONICAL; no ray start",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_scheduler_lease_dequeue_contract",
        family="catchup",
        cycle=60,
        helper="routes_stream.ray_scheduler_lease_dequeue_contract_payload",
        description="Ray PriorityScheduler lease/dequeue field contract: claim→LEASED→lease key TTL",
        filter_hint="lease dry-run; stub_skips_leased; join_ready=false; paper .47 rejected; TTL 120; no ray start",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_scheduler_lease_renew_reclaim_contract",
        family="catchup",
        cycle=61,
        helper="routes_stream.ray_scheduler_lease_renew_reclaim_contract_payload",
        description="Ray PriorityScheduler lease renew/reclaim field contract: TTL refresh + expiry requeue",
        filter_hint="renew/reclaim dry-run; stub_skips_leased; join_ready=false; paper .47 rejected; TTL 120; no ray start",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_job_state_progress_events_contract",
        family="catchup",
        cycle=62,
        helper="routes_stream.ray_job_state_progress_events_contract_payload",
        description="Ray JobState progress/events field contract: wire→JobState→Redis hash+events",
        filter_hint="progress dry-run; regress guard; retry reset; join_ready=false; no live Redis; no ray start",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_scheduler_progress_glue_contract",
        family="catchup",
        cycle=63,
        helper="routes_stream.ray_scheduler_progress_glue_contract_payload",
        description="Ray PriorityScheduler↔ProgressBus glue: enqueue/lease/renew/reclaim/terminal→JobEvent",
        filter_hint="glue dry-run; renew emit=false; reclaim attempts+1→progress0; join_ready=false; no ray start",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_job_router_emit_gate_contract",
        family="catchup",
        cycle=64,
        helper="routes_stream.ray_job_router_emit_gate_contract_payload",
        description="Ray JobRouter emit-gate + kind→adapter (echo/comfy_pool/llm_gateway)→ProgressBus",
        filter_hint="emit-gate dry-run; adapter_tick emit=false; C63 align; join_ready=false; no ray start",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_job_router_recode_checklist",
        family="catchup",
        cycle=65,
        helper="routes_stream.ray_job_router_recode_checklist_payload",
        description="JobRouter 改码 checklist 拆票 JR-R1…R6 keyed to C64 emit-gate + kind→adapter",
        filter_hint="checklist dry-run; JR-R4 offline regress; JR-R5/R6 kouling; accepted=false; no ray start",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="fe_tip_portal_pseudocode",
        family="catchup",
        cycle=66,
        helper="routes_stream.fe_tip_portal_pseudocode_payload",
        description="FE tip portal pseudocode deepen: host/anchor/open-close + job.terminal toast+tip (JR-R5)",
        filter_hint="TP1–TP7; tip_mount=false; TP6/TP7 kouling; offline dry-run; no live ArcReel tip DOM",
        channels=("progress", "toast", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_job_router_publish_kind_split_contract",
        family="catchup",
        cycle=67,
        helper="routes_stream.ray_job_router_publish_kind_split_contract_payload",
        description="JR-R1 _publish kind 三分 (enqueued/updated/terminal) paper+scratch; live always-updated gap",
        filter_hint="PK1–PK6; OP_DEFAULTS reuse; wrong_kind drop; live _publish unchanged; accepted=false; no ray start",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_job_router_adapter_tick_silent_contract",
        family="catchup",
        cycle=70,
        helper="routes_stream.ray_job_router_adapter_tick_silent_contract_payload",
        description="JR-R2 adapter_tick silent + progress/state delta gate (emit_false_silent / no_delta)",
        filter_hint="AT1–AT7; OP_DEFAULTS emit=false; delta open emit; regress drop; live tick unchanged; accepted=false; no ray start",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_job_router_progress_regress_parity_contract",
        family="catchup",
        cycle=79,
        helper="routes_stream.ray_job_router_progress_regress_parity_contract_payload",
        description="JR-R4 ProgressBus regress-drop parity (D3/D4 + emit-gate + renew-glue)",
        filter_hint="PR1–PR7; 0.5→0.2 drop; attempts reset; terminal bypass; mono advance; live bus unchanged; accepted=false; no ray start",
        channels=("progress", "task_center"),
    ),
    StreamProductPath(
        product_path="ray_job_router_kind_adapter_parity_contract",
        family="catchup",
        cycle=81,
        helper="routes_stream.ray_job_router_kind_adapter_parity_contract_payload",
        description="JR-R3 kind→adapter table parity (echo/comfy/llm + generic×policy + live default-gap)",
        filter_hint="KA1–KA7; KIND_TO_ADAPTER; route_kind parity; live default fail vs helper echo; live unchanged; accepted=false; no ray start",
        channels=("progress", "task_center"),
    ),
)

TOAST_ENTRIES: tuple[StreamProductPath, ...] = (
    StreamProductPath(
        product_path="create_rail_export_toast",
        family="toast",
        cycle=32,
        helper="export_toast.export_toast_payload / routes_export.complete_export_with_toast_payload",
        description="Export complete → ProgressBus focus toast (+ Cycle 43 hub dual-publish)",
        filter_hint="export: namespace",
        channels=("toast", "progress"),
    ),
)

ALL_ENTRIES: tuple[StreamProductPath, ...] = STREAM_ENTRIES + CATCHUP_ENTRIES + TOAST_ENTRIES

_BY_PATH: dict[str, StreamProductPath] = {e.product_path: e for e in ALL_ENTRIES}

INDEX_PRODUCT_PATH = "stream_product_path_index"


def get_entry(product_path: str) -> StreamProductPath | None:
    return _BY_PATH.get(product_path)


def list_entries(
    *,
    family: Family | None = None,
    stream_only: bool = False,
) -> list[StreamProductPath]:
    rows = list(ALL_ENTRIES)
    if stream_only:
        rows = [e for e in rows if e.family == "stream"]
    elif family is not None:
        rows = [e for e in rows if e.family == family]
    return rows


def list_product_paths(*, family: Family | None = None, stream_only: bool = False) -> list[str]:
    return [e.product_path for e in list_entries(family=family, stream_only=stream_only)]


def index_dict(*, family: Family | None = None, stream_only: bool = False) -> dict[str, Any]:
    """Serializable index for docs / flag-gated payload."""
    entries = list_entries(family=family, stream_only=stream_only)
    return {
        "product_path": INDEX_PRODUCT_PATH,
        "count": len(entries),
        "sse_path_hint": SSE_PATH_HINT,
        "ws_path_hint": WS_PATH_HINT,
        "tip_mount": False,
        "flag_default": False,
        "families": sorted({e.family for e in entries}),
        "entries": [e.to_dict() for e in entries],
        "stream_product_paths": [e.product_path for e in entries if e.family == "stream"],
    }


def assert_stream_constants_aligned(
    *,
    progress_sse_ws: str,
    job_router_stream_hub: str,
    client_stream_hub: str,
    export_stream_hub: str,
) -> None:
    """Call from routes_stream tests to keep index ↔ constant names in sync."""
    expected = {
        "progress_sse_ws": progress_sse_ws,
        "job_router_stream_hub": job_router_stream_hub,
        "client_stream_hub": client_stream_hub,
        "export_stream_hub": export_stream_hub,
    }
    for path, const in expected.items():
        if path != const:
            raise AssertionError(f"product_path mismatch: index={path!r} const={const!r}")
        if get_entry(path) is None:
            raise AssertionError(f"missing index entry for {path!r}")
