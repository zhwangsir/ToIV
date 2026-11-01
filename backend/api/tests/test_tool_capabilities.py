"""生成工具能力单源(GET /api/models/capabilities)测试。

约束:能力必须从引擎注册表声明派生,不得在能力层另写一份尺寸/时长/模型表。
验收口径:
  · 新增模型 = 只在引擎注册表/worker 选项加一项,能力响应随之变化;
  · 超限尺寸(如视频 2:1)标 unavailable + 可读原因;
  · 不可用引擎/空槽位进入 issues,并列出会失败的功能。
"""
from __future__ import annotations

from app.services.tool_capabilities import build_tool_capabilities


def _image_engine(*, available: bool = True, reason: str | None = None,
                  ckpts: list[str] | None = None) -> dict:
    ckpts = ckpts if ckpts is not None else ["", "sdxl_base.safetensors"]
    engine = {
        "id": "txt2img",
        "label": "文生图",
        "kind": "image",
        "nsfw": False,
        "description": "图像工作流",
        "submit": {"route": "/api/generate/txt2img", "kind": "txt2img"},
        "available": available,
        "params": [
            {
                "key": "ckpt_name", "label": "底模", "type": "select", "default": "",
                "options": [
                    {"value": v, "label": v or "平台默认底模", **({"nsfw": True} if "nsfw" in v else {})}
                    for v in ckpts
                ],
            },
            {"key": "width", "label": "宽度", "type": "number", "default": 1024,
             "min": 64, "max": 2048, "step": 8, "ar": [0.5, 2.0]},
            {"key": "height", "label": "高度", "type": "number", "default": 1024,
             "min": 64, "max": 2048, "step": 8},
        ],
        "limits": {"prompt_max_chars": 2000},
    }
    if reason:
        engine["unavailable_reason"] = reason
    return engine


def _video_engine(*, available: bool = True, reason: str | None = None,
                  durations: list[str] | None = None) -> dict:
    durations = durations if durations is not None else ["4", "5", "6", "8", "10", "15"]
    engine = {
        "id": "h3-t2v",
        "label": "MiniMax H3 文生视频",
        "kind": "video",
        "nsfw": False,
        "description": "默认视频引擎",
        "submit": {"route": "/api/h3/t2v", "kind": "h3-t2v"},
        "available": available,
        "params": [
            {"key": "width", "label": "宽度", "type": "number", "default": 1344,
             "min": 256, "max": 1344, "step": 32, "ar": [0.5625, 1.7777777777777777]},
            {"key": "height", "label": "高度", "type": "number", "default": 768,
             "min": 256, "max": 1344, "step": 32},
            {"key": "duration", "label": "时长", "type": "select", "default": "5",
             "options": [{"value": v, "label": f"{v} 秒"} for v in durations]},
        ],
        "limits": {"prompt_max_chars": 1500},
    }
    if reason:
        engine["unavailable_reason"] = reason
    return engine


def _avatar_engine() -> dict:
    return {
        "id": "avatar-talk", "label": "数字人口播", "kind": "video", "nsfw": False,
        "description": "口型同步", "submit": {"route": "/api/avatar/talk", "kind": "avatar-talk"},
        "available": True, "params": [], "limits": {},
    }


def _audio_engine() -> dict:
    return {
        "id": "ace-step", "label": "ACE-Step 音乐", "kind": "audio", "nsfw": False,
        "description": "音乐生成", "submit": {"route": "/api/generate/audio", "kind": "audio"},
        "available": True, "params": [], "limits": {},
    }


def test_image_tool_derives_models_and_sizes_from_engine_params():
    image = build_tool_capabilities([_image_engine()])["tools"]["image"]

    assert image["engine_id"] == "txt2img"
    assert image["route"] == "/api/generate/txt2img"
    assert image["available"] is True
    assert image["model_param"] == "ckpt_name"
    assert [m["value"] for m in image["models"]] == ["", "sdxl_base.safetensors"]
    assert image["models"][0]["default"] is True

    sizes = {s["value"]: s for s in image["sizes"]}
    assert (sizes["1:1"]["width"], sizes["1:1"]["height"]) == (1024, 1024)
    assert (sizes["16:9"]["width"], sizes["16:9"]["height"]) == (1024, 576)
    assert (sizes["9:16"]["width"], sizes["9:16"]["height"]) == (576, 1024)
    # 图像引擎 AR 声明为 1:2~2:1,2:1 合法
    assert (sizes["2:1"]["width"], sizes["2:1"]["height"]) == (1024, 512)
    assert all(s["available"] for s in image["sizes"])
    assert image["durations"] == []


def test_video_tool_derives_duration_tiers_and_disables_out_of_range_ratio():
    video = build_tool_capabilities([_video_engine()])["tools"]["video"]

    assert video["engine_id"] == "h3-t2v"
    assert video["route"] == "/api/h3/t2v"
    sizes = {s["value"]: s for s in video["sizes"]}
    assert (sizes["16:9"]["width"], sizes["16:9"]["height"]) == (1344, 768)
    assert (sizes["9:16"]["width"], sizes["9:16"]["height"]) == (768, 1344)
    assert (sizes["1:1"]["width"], sizes["1:1"]["height"]) == (1344, 1344)

    wide = sizes["2:1"]
    assert wide["available"] is False
    assert "9:16" in wide["reason"] and "16:9" in wide["reason"]
    assert wide["width"] > 0 and wide["height"] > 0  # 仍给尺寸,只是不可提交

    assert [d["seconds"] for d in video["durations"]] == [4.0, 5.0, 6.0, 8.0, 10.0, 15.0]
    assert [d["value"] for d in video["durations"]] == ["4", "5", "6", "8", "10", "15"]
    assert all(d["available"] for d in video["durations"])


def test_capability_is_single_source_of_truth_for_new_models_and_durations():
    """新增底模/时长只改引擎声明一处,能力响应立即生效(无需改能力层代码)。"""
    before = build_tool_capabilities([_image_engine(), _video_engine()])
    after = build_tool_capabilities([
        _image_engine(ckpts=["", "sdxl_base.safetensors", "flux2_dev_fp8mixed.safetensors"]),
        _video_engine(durations=["4", "5", "6", "8", "10", "15", "20"]),
    ])

    assert [m["value"] for m in after["tools"]["image"]["models"]][-1] == "flux2_dev_fp8mixed.safetensors"
    assert len(after["tools"]["image"]["models"]) == len(before["tools"]["image"]["models"]) + 1
    assert after["tools"]["video"]["durations"][-1]["seconds"] == 20.0


def test_unavailable_tool_reports_reason_and_issue_with_affected_features():
    cap = build_tool_capabilities([
        _image_engine(available=False, reason="worker 不可达"),
        _video_engine(available=False, reason="H3 实例不可达"),
    ])

    assert cap["tools"]["image"]["available"] is False
    assert cap["tools"]["image"]["unavailable_reason"] == "worker 不可达"
    assert cap["tools"]["video"]["available"] is False

    issues = {i["id"]: i for i in cap["issues"]}
    image_issue = issues["tool-image-unavailable"]
    assert image_issue["reason"] == "worker 不可达"
    assert any("文生图" in item for item in image_issue["affects"])
    video_issue = issues["tool-video-unavailable"]
    assert any("文生视频" in item for item in video_issue["affects"])


def test_slots_group_business_capabilities_and_flag_empty_slot():
    cap = build_tool_capabilities([
        _image_engine(), _video_engine(), _avatar_engine(), _audio_engine(),
    ])
    slots = {s["id"]: s for s in cap["slots"]}

    assert list(slots) == ["image", "video", "avatar", "audio"]
    assert [s["label"] for s in slots.values()] == ["出图", "视频", "数字人", "音乐"]
    assert slots["avatar"]["available"] is True
    assert [e["id"] for e in slots["avatar"]["engines"]] == ["avatar-talk"]
    assert slots["audio"]["available"] is True
    assert cap["issues"] == []

    empty = build_tool_capabilities([_image_engine(), _video_engine()])
    empty_slots = {s["id"]: s for s in empty["slots"]}
    assert empty_slots["avatar"]["available"] is False
    empty_issues = {i["id"]: i for i in empty["issues"]}
    assert empty_issues["slot-avatar-empty"]["reason"]
    assert empty_issues["slot-avatar-empty"]["affects"]


def test_missing_default_engines_are_reported_as_issues():
    cap = build_tool_capabilities([])

    assert cap["tools"]["image"]["available"] is False
    assert "未注册" in cap["tools"]["image"]["unavailable_reason"]
    assert cap["tools"]["video"]["available"] is False
    assert {i["id"] for i in cap["issues"]} >= {"tool-image-unavailable", "tool-video-unavailable"}


def test_sizes_snap_to_declared_step_and_stay_inside_declared_range():
    engine = _image_engine()
    width = next(p for p in engine["params"] if p["key"] == "width")
    width["default"] = 1000
    image = build_tool_capabilities([engine])["tools"]["image"]
    square = next(s for s in image["sizes"] if s["value"] == "1:1")

    assert square["width"] % 8 == 0
    assert square["width"] <= width["max"]


async def test_capabilities_route_uses_engine_registry(monkeypatch):
    from app.routes import models as models_route

    async def fake_list_engines(pool, user=None):
        return [_image_engine(), _video_engine()]

    monkeypatch.setattr(models_route, "list_engines", fake_list_engines)
    body = await models_route.model_capabilities(pool=None, user=None)

    assert body["tools"]["image"]["engine_id"] == "txt2img"
    assert body["tools"]["video"]["durations"][-1]["seconds"] == 15.0
