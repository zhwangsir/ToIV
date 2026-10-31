"""D0 渲染前工作量、费率与预算估算；预览和提交共用同一确定性实现。"""
from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlmodel import Session, select

from app.config import get_settings
from app.models import StudioProject, StudioShot
from app.services.studio.keyframe_drive import KEYFRAME_REQUIRED_DETAIL, keyframe_gate_blocks

ESTIMATE_SCHEMA = "toiv_render_estimate_v1"
RATE_SOURCE = "TOIV_STUDIO_COST_RATES_JSON"
_CURRENCY = re.compile(r"^[A-Z]{3}$")


class EstimateConfigError(ValueError):
    """费率/预算配置不可用；路由必须映射 503，不得按免费处理。"""


def _decimal(value: Any, label: str) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as e:
        raise EstimateConfigError(f"{label} 须为合法十进制数") from e
    if not result.is_finite() or result < 0:
        raise EstimateConfigError(f"{label} 须为有限非负十进制数")
    return result


def _pricing_config() -> tuple[str | None, dict[str, dict[str, Decimal]], Decimal]:
    settings = get_settings()
    raw = getattr(settings, "studio_cost_rates_json", "") or ""
    budget_raw = str(getattr(settings, "studio_render_budget_limit", "0") or "0").strip()
    limit = _decimal(budget_raw or "0", "TOIV_STUDIO_RENDER_BUDGET_LIMIT")
    if not raw.strip():
        return None, {}, limit
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as e:
        raise EstimateConfigError("TOIV_STUDIO_COST_RATES_JSON 不是合法 JSON") from e
    if not isinstance(data, dict) or not isinstance(data.get("rates"), dict):
        raise EstimateConfigError("TOIV_STUDIO_COST_RATES_JSON 须含 currency 与 rates 对象")
    currency = data.get("currency")
    if not isinstance(currency, str) or not _CURRENCY.fullmatch(currency):
        raise EstimateConfigError("费率 currency 须为三位大写 ISO 币种代码")
    rates: dict[str, dict[str, Decimal]] = {}
    for key, components in data["rates"].items():
        if not isinstance(key, str) or not isinstance(components, dict):
            raise EstimateConfigError("rates 的键须为字符串、值须为价格组成对象")
        parts = key.split(":")
        if (
            len(parts) not in (2, 3)
            or parts[0] not in ("h3", "ltx")
            or parts[1] not in ("video", "image_motion")
            or (len(parts) == 3 and parts[2] not in ("ref2va", "c", "c_hybrid", "legacy"))
        ):
            raise EstimateConfigError(
                f"费率键 {key!r} 非法；须为 engine:render_mode 或 engine:render_mode:pipeline"
            )
        unknown_components = set(components) - {"pixel_frame", "candidate"}
        if unknown_components:
            raise EstimateConfigError(f"费率 {key} 含未知价格组成")
        rates[key] = {
            component: _decimal(value, f"费率 {key}.{component}")
            for component, value in components.items()
        }
    return currency, rates, limit


def _decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    return "0" if text in ("-0", "") else text


def _normalized_json(raw: Any) -> Any:
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return raw


def _rate_for(
    rates: dict[str, dict[str, Decimal]], engine: str, render_mode: str, pipeline: str
) -> tuple[str, dict[str, Decimal] | None]:
    exact = f"{engine}:{render_mode}:{pipeline}"
    if exact in rates:
        return exact, rates[exact]
    family = f"{engine}:{render_mode}"
    return exact, rates.get(family)


def _warning() -> list[dict[str, str]]:
    return [{
        "code": "REQUEST_UPPER_BOUND_NOT_VENDOR_METERING",
        "message": (
            "按项目 fps×时长×候选上限估算请求工作量，不是实际 GPU/供应商计量；"
            "旧产物复用可能减少工作量，QA 重试等未知增量未计入确定报价；"
            "c_hybrid 首帧仅使用本地抽帧或现有参考，不另计虚构生成资费。"
        ),
    }]


def estimate_shot(
    session: Session,
    project: StudioProject,
    shot: StudioShot,
    *,
    options: dict[str, Any] | None = None,
    body_present: bool = True,
) -> dict[str, Any]:
    opts = dict(options or {})
    candidates = int(opts.get("num_candidates", 2 if body_present else 1) or 1)
    return _estimate(
        session, project, [shot], scope="shot", options=opts,
        candidates=candidates, force_direct=bool(opts.get("force_direct", False)),
        body_present=body_present,
    )


def estimate_batch(
    session: Session,
    project: StudioProject,
    *,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    opts = dict(options or {})
    shots = session.exec(
        select(StudioShot)
        .where(StudioShot.project_id == project.id)
        .order_by(StudioShot.idx)  # type: ignore[attr-defined]
    ).all()
    from app.services.studio import orchestrator

    pending = [s for s in shots if (s.status or "") not in orchestrator.terminal_states()]
    return _estimate(
        session, project, pending, scope="batch", options=opts,
        candidates=2, force_direct=False, body_present=True,
    )


def _estimate(
    session: Session,
    project: StudioProject,
    shots: list[StudioShot],
    *,
    scope: str,
    options: dict[str, Any],
    candidates: int,
    force_direct: bool,
    body_present: bool,
) -> dict[str, Any]:
    currency, rates, budget_limit = _pricing_config()
    items: list[dict[str, Any]] = []
    blockers: list[dict[str, str]] = []
    unknowns: list[str] = []
    totals: list[Decimal] = []
    requested_duration = 0
    for shot in shots:
        engine = str(options.get("video_model") or shot.video_model or "h3").strip() or "h3"
        if engine not in ("h3", "ltx"):
            engine = "h3"
        render_mode = str(shot.render_mode or "video")
        pipeline = str(options.get("pipeline") or "ref2va").strip().lower() or "ref2va"
        if engine != "h3":
            pipeline = "legacy"
        duration = max(0, int(shot.duration_sec or 0))
        frames = max(0, int(project.fps or 0)) * duration * candidates
        pixel_frames = frames * max(0, int(project.width or 0)) * max(0, int(project.height or 0))
        items.append({
            "shot_id": shot.id,
            "idx": int(shot.idx or 0),
            "engine": engine,
            "pipeline": pipeline,
            "render_mode": render_mode,
            "candidates": candidates,
            "duration_sec": duration,
            "frames": frames,
            "pixel_frames_upper_bound": pixel_frames,
        })
        requested_duration += duration

        blocked = keyframe_gate_blocks(
            drive_mode=getattr(project, "preferred_drive_mode", "keyframe"),
            shot=shot,
            force_direct=force_direct,
        )
        if blocked is not None:
            blockers.append({
                "code": blocked["code"], "message": blocked["message"], "stage": "storyboard",
            })

        rate_key, components = _rate_for(rates, engine, render_mode, pipeline)
        if components is None:
            if rate_key not in unknowns:
                unknowns.append(rate_key)
            continue
        item_total = Decimal(0)
        if "pixel_frame" in components:
            item_total += Decimal(pixel_frames) * components["pixel_frame"]
        if "candidate" in components:
            item_total += Decimal(candidates) * components["candidate"]
        totals.append(item_total)

    if scope == "batch" and shots:
        from app.services.studio import stages as stages_svc

        storyboard = stages_svc.stage_state_of(session, project, "storyboard")["state"]
        if storyboard not in ("confirmed", "skipped"):
            blockers.append({
                "code": "STORYBOARD_NOT_CONFIRMED",
                "message": f"故事板(stage)尚未确认(当前 {storyboard});请先确认/跳过 storyboard 阶段再批量渲染",
                "stage": "storyboard",
            })

    if not items and not rates:
        unknowns.append("no_render_work")
    estimated = len(unknowns) == 0
    pricing = {
        "status": "estimated" if estimated else "unpriced",
        "currency": currency if estimated else None,
        "total": _decimal_text(sum(totals, Decimal(0))) if estimated else None,
        "rate_source": RATE_SOURCE,
        "unknowns": unknowns,
    }
    budget: dict[str, Any]
    if budget_limit == 0:
        budget = {"status": "disabled", "limit": None, "currency": None}
    else:
        budget = {
            "status": "within" if not items else ("unpriced" if not estimated else (
                "exceeded" if Decimal(pricing["total"]) > budget_limit else "within"
            )),
            "limit": _decimal_text(budget_limit),
            "currency": currency,
        }
        if not estimated and items:
            blockers.append({
                "code": "COST_UNPRICED",
                "message": "已启用渲染预算，但当前价格组成未知，无法核价；请补全费率配置后再提交",
            })
        elif estimated and Decimal(pricing["total"]) > budget_limit:
            blockers.append({
                "code": "RENDER_BUDGET_EXCEEDED",
                "message": f"本次渲染预估 {pricing['total']} {currency}，超过预算 {budget['limit']} {currency}",
            })

    work = {
        "shot_count": len(items),
        "candidate_upper_bound": sum(i["candidates"] for i in items),
        "requested_duration_sec": requested_duration,
        "requested_frame_count": sum(i["frames"] for i in items),
        "pixel_frame_upper_bound": sum(i["pixel_frames_upper_bound"] for i in items),
        "image_motion_count": sum(i["render_mode"] == "image_motion" for i in items),
    }
    normalized_options = {
        k: v for k, v in options.items() if k != "wait" and v is not None
    }
    normalized_options.update({
        "pipeline": normalized_options.get("pipeline") or "ref2va",
        "num_candidates": candidates,
        "accel": normalized_options.get("accel") or "off",
        "force_direct": force_direct,
    })
    fingerprint_input = {
        "scope": scope,
        "project_id": project.id,
        "stage_revision": int(project.stage_revision or 0),
        "options": normalized_options,
        "shots": [{
            "id": s.id,
            "current_revision_id": s.current_revision_id or "",
            "render_mode": s.render_mode,
            "duration_sec": s.duration_sec,
            "video_model": s.video_model or "h3",
            "image_url": s.image_url or "",
            "ref_images": _normalized_json(s.ref_images_json),
            "scene_ref": _normalized_json(s.scene_ref_json),
        } for s in shots],
        "project_specs": {"width": project.width, "height": project.height, "fps": project.fps},
        "project_generation": {
            "preferred_drive_mode": project.preferred_drive_mode,
            "scene_images": _normalized_json(project.scene_images_json),
            "style": project.style or "",
            "ckpt_name": project.ckpt_name or "",
        },
        "rates": {
            "currency": currency,
            "rates": {key: {name: _decimal_text(value) for name, value in components.items()}
                      for key, components in rates.items()},
        },
        "budget": _decimal_text(budget_limit),
    }
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_input, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
    blockers.sort(key=lambda b: 0 if b["code"] == "STORYBOARD_NOT_CONFIRMED" else 1)
    result = {
        "schema": ESTIMATE_SCHEMA,
        "scope": scope,
        "project_id": project.id,
        "allowed": not blockers,
        "blockers": blockers,
        "warnings": _warning(),
        "input_fingerprint": fingerprint,
        "work": work,
        "items": items,
        "pricing": pricing,
        "budget": budget,
    }
    if scope == "shot" and shots:
        result["shot_id"] = shots[0].id
    return result


def estimate_snapshot(estimate: dict[str, Any]) -> dict[str, Any]:
    """落任务/修订的机读摘要，不复制原始配置或环境。"""
    return {
        "schema": estimate["schema"],
        "scope": estimate["scope"],
        "input_fingerprint": estimate["input_fingerprint"],
        "work": estimate["work"],
        "pricing": estimate["pricing"],
        "budget": estimate["budget"],
    }
