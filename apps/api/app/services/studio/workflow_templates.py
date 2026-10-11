"""W2.4(2026-10-11):工作流模板库——node_mapping 声明式注册。

契约见 docs/ops/PLATFORM_V2_CONTRACT.md §3。本实现贴真实架构:
H3 管线图由代码构建器(app/workflows/h3_pipeline_c.py 与 h3/{t2v,i2v}_prompt.json)
生成,模板库不复制图,而是**登记每个 (engine, mode) 的注入点 node_mapping 与能力
约束**,作为「参数怎么进图」的唯一声明源;激活状态落 data 域 JSON(同一 (engine,
mode) 仅一个 active 天然成立——键即 (engine,mode))。

node_mapping 值均从真实构建器提取(测试断言对图核验,防漂移)。
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()

# ── 注册表(真值:节点 id 提取自 app/workflows/h3_pipeline_c.py 与 h3/*_prompt.json) ──
TEMPLATES: dict[str, dict[str, Any]] = {
    # 管线 C / 独立镜 Ref2VA(fl2va 同构 UNET、ref2va 参考链)
    "h3_ref2va_single": {
        "id": "h3_ref2va_single",
        "engine": "h3",
        "mode": "single",
        "builder": "app.workflows.h3_pipeline_c.build_h3_pipeline_c_graph(indep=True)",
        "comfy_workflow": "(code-builder)",
        "node_mapping": {
            "prompt": "9", "seed": "5", "sampler": "3",
            "ref_image_1": "7a", "ref_image_2": "7b", "ref_image_3": "7c", "ref_image_4": "7d",
            "first_frame": "7", "save_prefix": "18",
        },
        "extension": {"max_clip_duration": 15, "frame_count": 1, "supports_audio": True},
        "ref_slots": {"character": {"max": 4, "required": 0}, "scene": {"max": 0, "required": 0}},
        "acceleration": {"lora": "", "default_steps": 20},
    },
    "h3_ref2va_first_last": {
        "id": "h3_ref2va_first_last",
        "engine": "h3",
        "mode": "first_last",
        "builder": "app.workflows.h3_pipeline_c.build_h3_pipeline_c_graph(续写)",
        "comfy_workflow": "(code-builder)",
        "node_mapping": {
            "prompt": "9", "seed": "5", "sampler": "3",
            "ref_image_1": "7a", "first_frame": "7",
            "context_latent": "MotionContextLoadLatent", "save_prefix": "18",
            "save_context": "19",
        },
        "extension": {"max_clip_duration": 15, "frame_count": 2, "supports_audio": True},
        "ref_slots": {"character": {"max": 4, "required": 0}, "motion": {"max": 1, "required": 0}},
        "acceleration": {"lora": "", "default_steps": 20},
    },
    "h3_ref2va_kf2": {
        "id": "h3_ref2va_kf2", "engine": "h3", "mode": "kf2",
        "builder": "build_h3_pipeline_c_graph(images=(k1,k2))",
        "comfy_workflow": "(code-builder)",
        "node_mapping": {"prompt": "9", "seed": "5", "keyframe_1": "7a", "keyframe_2": "7b", "save_prefix": "18"},
        "extension": {"max_clip_duration": 15, "frame_count": 2, "supports_audio": True},
        "ref_slots": {"character": {"max": 2, "required": 0}},
        "acceleration": {"lora": "", "default_steps": 20},
    },
    "h3_ref2va_kf3": {
        "id": "h3_ref2va_kf3", "engine": "h3", "mode": "kf3",
        "builder": "build_h3_pipeline_c_graph(images=(k1,k2,k3))",
        "comfy_workflow": "(code-builder)",
        "node_mapping": {"prompt": "9", "seed": "5", "keyframe_1": "7a", "keyframe_2": "7b", "keyframe_3": "7c", "save_prefix": "18"},
        "extension": {"max_clip_duration": 15, "frame_count": 3, "supports_audio": True},
        "ref_slots": {"character": {"max": 3, "required": 0}},
        "acceleration": {"lora": "", "default_steps": 20},
    },
    # FL2VA 模板图(app/workflows/h3/*.json 真实文件)
    "h3_fl2va_t2v": {
        "id": "h3_fl2va_t2v", "engine": "h3", "mode": "single",
        "builder": "app.workflows.h3.t2v_prompt.json",
        "comfy_workflow": "app/workflows/h3/t2v_prompt.json",
        "node_mapping": {
            "prompt": "104", "seed": "15", "unet": "6", "clip": "13",
            "width_height_length": "104", "save_prefix": "92",
        },
        "extension": {"max_clip_duration": 5, "frame_count": 1, "supports_audio": True},
        "ref_slots": {},
        "acceleration": {"lora": "", "default_steps": 20},
    },
    "h3_fl2va_i2v": {
        "id": "h3_fl2va_i2v", "engine": "h3", "mode": "first_last",
        "builder": "app.workflows/h3/i2v_prompt.json",
        "comfy_workflow": "app/workflows/h3/i2v_prompt.json",
        "node_mapping": {
            "prompt": "104", "seed": "15", "unet": "6", "first_frame": "100", "save_prefix": "92",
        },
        "extension": {"max_clip_duration": 5, "frame_count": 2, "supports_audio": True},
        "ref_slots": {"character": {"max": 1, "required": 1}},
        "acceleration": {"lora": "", "default_steps": 20},
    },
}

# 同 (engine, mode) 多模板时的默认激活表(可被 data 域覆盖)
_DEFAULT_ACTIVE: dict[str, str] = {
    "h3|single": "h3_ref2va_single",
    "h3|first_last": "h3_ref2va_first_last",
    "h3|kf2": "h3_ref2va_kf2",
    "h3|kf3": "h3_ref2va_kf3",
}


def _state_path() -> Path:
    from app.config import get_settings

    base = Path(__file__).resolve().parents[3] / "app" / "data"
    return base / "workflow_template_active.json"


def _load_active() -> dict[str, str]:
    p = _state_path()
    if p.is_file():
        try:
            v = json.loads(p.read_text())
            if isinstance(v, dict):
                return {str(k): str(x) for k, x in v.items()}
        except (ValueError, TypeError):
            pass
    return dict(_DEFAULT_ACTIVE)


def _save_active(active: dict[str, str]) -> None:
    p = _state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(active, ensure_ascii=False, indent=1))


def list_templates() -> list[dict[str, Any]]:
    active = _load_active()
    out = []
    for tid, t in TEMPLATES.items():
        item = dict(t)
        item["is_active"] = active.get(f"{t['engine']}|{t['mode']}") == tid
        out.append(item)
    return out


def get_template(tid: str) -> dict[str, Any] | None:
    if tid not in TEMPLATES:
        return None
    t = dict(TEMPLATES[tid])
    t["is_active"] = _load_active().get(f"{t['engine']}|{t['mode']}") == tid
    return t


def set_active(tid: str) -> dict[str, Any]:
    """切换激活(同一 (engine,mode) 键唯一覆盖,天然单激活语义)。"""
    t = TEMPLATES.get(tid)
    if t is None:
        raise KeyError(tid)
    with _LOCK:
        active = _load_active()
        active[f"{t['engine']}|{t['mode']}"] = tid
        _save_active(active)
    return get_template(tid)  # type: ignore[return-value]
