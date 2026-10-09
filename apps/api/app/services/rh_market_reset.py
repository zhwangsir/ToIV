"""RunningHub 市场重置规则：soft-hide 计划（dry-run 优先）。

产品纪律（feat/studio-rh-market-reset · 开发 PASS 2026-10-10）：
- 只 soft-hide（is_public=false），不硬删行。
- 非 RH 默认下架；smoke fail|timeout 下架；**未测 ≠ 挂**（pass1 keep，二次扫后再砍）。
- KEEP_WHITELIST 保住意图本地 alt / 核心引擎 / longcat / avatar 等。
- bulk-public / 现网 reseed 须用户另令；本模块默认只产出计划，不写库。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Mapping, Sequence

# 意图条本地 alt + 核心内置引擎 + AGENTS HOLD keepers（非 RH 不盲砍）。
# 行缺失时仍留在白名单：种子复活 / revive 时继续受保护。
KEEP_WHITELIST: frozenset[str] = frozenset(
    {
        # intent local alts
        "h3-i2v",
        "h3-t2v",
        "ovi-i2v",
        # avatar（数字人）— dump 中常 soft-hide；revive 策略见 plan_revive
        "avatar-talk",
        # longcat 族
        "longcat-t2v",
        "longcat-i2v",
        "longcat-continue",
        # intent 本地主键
        "removebg",
        "upscale",
        "ace-music",
        "ace-music-legacy",
        "vace-edit",
        "h3-r2v-voice",
        # 核心 H3 族
        "h3-fl2v",
        "h3-multishot",
        "h3-r2v",
        "h3-t2v-15s-fast",
        "h3-i2v-15s-fast",
        "h3-nsfw-t2v",
        "h3-nsfw-i2v",
        "h3-nsfw-fl2v",
        "h3-nsfw-r2v",
        "h3-nsfw-t2v-15s-fast",
        "h3-nsfw-i2v-15s-fast",
        "h3-nsfw-r2v-voice",
        # 基础出图
        "txt2img-basic",
        "img2img-basic",
        # 其他产品依赖引擎卡（种子 _EXPECTED_IDS 交集）
        "ovi-t2v",
        "wan-animate",
        "wan-animate-2",
        "wan-vace",
        "phantom-s2v",
        "qwen-image-edit",
        "controlnet",
        "ipadapter",
        "inpaint",
        "pulid",
        "ltx-txt2video",
        "ltx-img2video",
        "ltx-lipsync",
        "nsfw-txt2img",
        "nsfw-img2img",
        "wan-nsfw-i2v",
        "facedetailer",
        "hunyuan-i2v",
        "latentsync",
    }
)

# 能力缺口 market-reset 扫描（2026-10-10）交叉：公开可本地 keep 外、且非意图 keepers。
# 开发收口：本轮 dry-run 建议一键 soft-hide 仅此 2；不跑 smoke-fail 大批下架；RH re-import P0 延期。
P0_SOFT_HIDE_IDS: frozenset[str] = frozenset(
    {
        "flux1-nunchaku",  # nodes_only: Nunchaku*
        "ltx25-multishot",  # both: LTXVDualCFGGuider + LTX-2.5 权重
    }
)

SMOKE_FAIL_STATUSES = frozenset({"fail", "timeout"})
SMOKE_PASS = "pass"


@dataclass(frozen=True)
class AppView:
    """规则输入的最小视图（DB App / API dump / 单测 dict 均可）。"""

    id: str
    is_public: bool = True
    smoke_status: str = ""
    is_builtin: bool = False
    rh_webapp_id: str = ""
    cover_url: str = ""

    @staticmethod
    def from_mapping(row: Mapping[str, Any]) -> "AppView":
        aid = str(row.get("id") or "").strip()
        smoke = row.get("smoke_status")
        if smoke is None:
            smoke = row.get("smokeStatus") or ""
        return AppView(
            id=aid,
            is_public=bool(row.get("is_public", row.get("isPublic", True))),
            smoke_status=str(smoke or "").strip(),
            is_builtin=bool(row.get("is_builtin", row.get("isBuiltin", False))),
            rh_webapp_id=str(row.get("rh_webapp_id") or row.get("rhWebappId") or ""),
            cover_url=str(row.get("cover_url") or row.get("coverUrl") or ""),
        )


@dataclass
class DelistDecision:
    app_id: str
    action: str  # keep | soft_hide | defer_untested | already_hidden | revive_candidate
    reason: str
    is_rh: bool
    smoke_status: str
    was_public: bool


@dataclass
class MarketResetPlan:
    """dry-run 计划；不写库。"""

    scope: str  # public_only | all
    total_input: int = 0
    public_input: int = 0
    keep: list[DelistDecision] = field(default_factory=list)
    soft_hide: list[DelistDecision] = field(default_factory=list)
    defer_untested: list[DelistDecision] = field(default_factory=list)
    already_hidden: list[DelistDecision] = field(default_factory=list)
    revive_candidates: list[DelistDecision] = field(default_factory=list)
    missing_whitelist_rows: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def counts(self) -> dict[str, int]:
        return {
            "total_input": self.total_input,
            "public_input": self.public_input,
            "keep": len(self.keep),
            "soft_hide": len(self.soft_hide),
            "defer_untested": len(self.defer_untested),
            "already_hidden": len(self.already_hidden),
            "revive_candidates": len(self.revive_candidates),
            "missing_whitelist_rows": len(self.missing_whitelist_rows),
        }

    def soft_hide_ids(self) -> list[str]:
        return [d.app_id for d in self.soft_hide]

    def to_dict(self, *, include_ids: bool = True, id_limit: int = 200) -> dict[str, Any]:
        out: dict[str, Any] = {
            "scope": self.scope,
            "counts": self.counts(),
            "missing_whitelist_rows": list(self.missing_whitelist_rows),
            "notes": list(self.notes),
            "bulk_public_forbidden_without_user_order": True,
        }
        if include_ids:
            out["soft_hide_ids"] = self.soft_hide_ids()[:id_limit]
            out["soft_hide_ids_truncated"] = len(self.soft_hide) > id_limit
            out["defer_untested_ids"] = [d.app_id for d in self.defer_untested][:id_limit]
            out["revive_candidate_ids"] = [d.app_id for d in self.revive_candidates]
            out["keep_public_sample"] = [d.app_id for d in self.keep if d.was_public][:id_limit]
        return out


def is_rh_app_id(app_id: str) -> bool:
    return (app_id or "").startswith("rh-")


def normalize_smoke(status: str | None) -> str:
    return (status or "").strip()


def classify_app(
    app: AppView,
    *,
    whitelist: frozenset[str] = KEEP_WHITELIST,
    localizable_ids: frozenset[str] | None = None,
    pass_index: int = 1,
) -> DelistDecision:
    """单卡决策。

    pass_index=1: 未测 RH 公开卡 → defer_untested（不下架）。
    pass_index=2: 未测也可按策略 soft_hide（仅当调用方显式二次扫）。
    localizable_ids: 若给出，则不在集合内的非白名单 RH 公开卡 soft_hide（能力缺口联手）。
    """
    aid = app.id
    smoke = normalize_smoke(app.smoke_status)
    is_rh = is_rh_app_id(aid)
    base = dict(
        app_id=aid,
        is_rh=is_rh,
        smoke_status=smoke or "untested",
        was_public=bool(app.is_public),
    )

    if aid in P0_SOFT_HIDE_IDS and app.is_public:
        return DelistDecision(
            action="soft_hide",
            reason="P0 capability-gap soft-hide (flux1-nunchaku|ltx25-multishot)",
            **base,
        )

    if aid in whitelist:
        if not app.is_public and aid == "avatar-talk":
            return DelistDecision(
                action="revive_candidate",
                reason="whitelist avatar-talk currently soft-hidden; revive when smoke pass / dedicated pool ready",
                **base,
            )
        if not app.is_public and aid in {
            "longcat-t2v",
            "longcat-i2v",
            "ovi-t2v",
            "h3-t2v-15s-fast",
            "h3-i2v-15s-fast",
            "ace-music-legacy",
        }:
            return DelistDecision(
                action="revive_candidate",
                reason="whitelist local engine currently soft-hidden; product may revive",
                **base,
            )
        if not app.is_public:
            return DelistDecision(
                action="already_hidden",
                reason="whitelist but already soft-hidden",
                **base,
            )
        return DelistDecision(action="keep", reason="KEEP_WHITELIST", **base)

    if not app.is_public:
        return DelistDecision(
            action="already_hidden",
            reason="already soft-hidden",
            **base,
        )

    # —— 以下仅公开卡 ——
    if not is_rh:
        return DelistDecision(
            action="soft_hide",
            reason="non-RH public not in KEEP_WHITELIST",
            **base,
        )

    if smoke in SMOKE_FAIL_STATUSES:
        return DelistDecision(
            action="soft_hide",
            reason=f"RH smoke_{smoke}",
            **base,
        )

    if localizable_ids is not None and aid not in localizable_ids:
        return DelistDecision(
            action="soft_hide",
            reason="RH not in localizable keep set (capability gap)",
            **base,
        )

    if smoke != SMOKE_PASS:
        # 未测 / running / 空
        if pass_index >= 2:
            return DelistDecision(
                action="soft_hide",
                reason="RH untested on pass2 after keep-scan/smoke",
                **base,
            )
        return DelistDecision(
            action="defer_untested",
            reason="RH untested≠fail; keep until keep-scan/smoke then pass2",
            **base,
        )

    return DelistDecision(action="keep", reason="RH smoke_pass", **base)


def plan_market_reset(
    apps: Iterable[Mapping[str, Any] | AppView],
    *,
    scope: str = "public_only",
    whitelist: frozenset[str] = KEEP_WHITELIST,
    localizable_ids: frozenset[str] | None = None,
    pass_index: int = 1,
) -> MarketResetPlan:
    """对目录跑 dry-run 计划。scope=public_only 只决策当前公开卡（已隐藏进 already_hidden 桶若 scope=all）。"""
    views: list[AppView] = []
    for row in apps:
        if isinstance(row, AppView):
            views.append(row)
        else:
            views.append(AppView.from_mapping(row))

    plan = MarketResetPlan(scope=scope)
    plan.total_input = len(views)
    plan.public_input = sum(1 for v in views if v.is_public)
    seen_ids = {v.id for v in views if v.id}
    plan.missing_whitelist_rows = sorted(wid for wid in whitelist if wid not in seen_ids)

    for v in views:
        if not v.id:
            continue
        if scope == "public_only" and not v.is_public:
            # 仍扫描白名单 revive
            if v.id in whitelist:
                d = classify_app(
                    v,
                    whitelist=whitelist,
                    localizable_ids=localizable_ids,
                    pass_index=pass_index,
                )
                if d.action == "revive_candidate":
                    plan.revive_candidates.append(d)
            continue
        d = classify_app(
            v,
            whitelist=whitelist,
            localizable_ids=localizable_ids,
            pass_index=pass_index,
        )
        if d.action == "keep":
            plan.keep.append(d)
        elif d.action == "soft_hide":
            plan.soft_hide.append(d)
        elif d.action == "defer_untested":
            plan.defer_untested.append(d)
        elif d.action == "already_hidden":
            plan.already_hidden.append(d)
        elif d.action == "revive_candidate":
            plan.revive_candidates.append(d)

    plan.notes.append("建议一键 hide 这2: " + ", ".join(sorted(P0_SOFT_HIDE_IDS)))
    plan.notes.extend(
        [
            "soft-hide only (is_public=false); never hard-delete",
            "bulk-public / live reseed require explicit user order",
            "pass1: untested RH kept (defer); pass2 after capability keep-scan + smoke",
            "RH re-import: accurate export only; cover_url=RH original; smoke pass before public",
            "coordinate: 能力缺口(localizable keep) / 模型下载(basename) / 设备管家(nodes/pools)",
        ]
    )
    if pass_index == 1 and plan.defer_untested:
        plan.notes.append(
            f"pass1 deferred untested RH public: {len(plan.defer_untested)} (do not mix with fail)"
        )
    return plan


def chunk_ids(ids: Sequence[str], size: int = 200) -> list[list[str]]:
    """bulk-public 单次 ≤200；仅供用户令后编排，本模块不调用。"""
    if size <= 0:
        raise ValueError("size must be positive")
    out: list[list[str]] = []
    buf = [i for i in ids if (i or "").strip()]
    for i in range(0, len(buf), size):
        out.append(buf[i : i + size])
    return out


def plan_as_jsonable(plan: MarketResetPlan, **kwargs: Any) -> dict[str, Any]:
    return plan.to_dict(**kwargs)
