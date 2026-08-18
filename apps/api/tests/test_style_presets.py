"""风格预设、LLM 路由、模型健康检查的单元测试。"""
from __future__ import annotations

import pytest

from app.workflows.style_presets import (
    ALL_PRESETS,
    DEFAULT_IMAGE_PRESET,
    DEFAULT_VIDEO_PRESET,
    IMAGE_PRESET_IDS,
    VIDEO_PRESET_IDS,
    MediaType,
    StylePreset,
    list_presets,
    resolve_style_preset,
)
from app.workflows.llm_router import (
    ContentType,
    LLMLayer,
    list_content_types,
    list_llm_endpoints,
    llm_endpoints,
    route_llm,
)
from app.workflows.model_health import (
    HealthStatus,
    ModelEvaluator,
    _check_critical,
    _suggest_fallbacks,
)
from app.workflows.model_profiles import profile_for


# ─────────────────────────────────────────────────────────────────────────────
# style_presets 测试
# ─────────────────────────────────────────────────────────────────────────────


class TestStylePresets:
    def test_all_presets_have_required_fields(self):
        """每个预设必须有 id/label/ckpt_name/media,且 id 唯一。"""
        ids = set()
        for preset_id, preset in ALL_PRESETS.items():
            assert isinstance(preset, StylePreset)
            assert preset.id == preset_id
            assert preset.label, f"{preset_id} 缺少 label"
            assert preset.ckpt_name, f"{preset_id} 缺少 ckpt_name"
            assert isinstance(preset.media, MediaType)
            assert 0 < preset.width <= 2048
            assert 0 < preset.height <= 2048
            ids.add(preset_id)
        assert len(ids) == len(ALL_PRESETS), "预设 id 有重复"

    def test_recommended_skills_align_with_builtin_agents(self):
        """三层联动(2026-08-18):list_presets 输出 recommended_skill;
        非空值必须命中内置技能种子 id(防映射表与 agents_seed 漂移后静默失效)。"""
        from app.agents_seed import BUILTIN_AGENTS

        builtin_ids = {spec["id"] for spec in BUILTIN_AGENTS}
        presets = list_presets()
        assert presets, "预设列表非空"
        with_rec = [p for p in presets if p.get("recommended_skill")]
        assert with_rec, "至少有预设携带推荐技能"
        for p in with_rec:
            assert p["recommended_skill"] in builtin_ids, (
                f"预设 {p['id']} 推荐技能 {p['recommended_skill']} 不在内置种子中"
            )

    def test_list_presets_outputs_linkage_fields(self):
        """list_presets 输出联动字段:回显用采样/画幅推荐 + prompt_hint/negative_prompt。"""
        presets = {p["id"]: p for p in list_presets()}
        cinematic = presets["cinematic"]
        assert cinematic["prompt_hint"]  # 有必含要素
        assert cinematic["recommended_sampler"] == "euler"
        assert cinematic["recommended_scheduler"] == "simple"
        assert cinematic["recommended_steps"] == 28
        assert cinematic["recommended_cfg"] == 1.0
        # realistic 带推荐负向(cinematic 是 CFG1 族负向为空,属合法设计)
        assert presets["realistic"]["negative_prompt"]
        # turbo 类预设无 prompt_hint 也合法(字段恒存在)
        assert presets["turbo"]["prompt_hint"] == ""


    def test_image_presets_point_to_deployed_models(self):
        """图像预设的 ckpt_name 必须指向 worker 已部署的模型(文件名需在已知列表中)。"""
        deployed_checkpoints = {
            "majicMIX realistic 麦橘写实_v7.safetensors",
            "cyberrealistic_v120.safetensors",
            "cyberrealisticPony_v180Coreshift.safetensors",
            "ponyRealism_V22.safetensors",
            "lustifySDXLNSFW_apexV8.safetensors",
            "waiIllustriousSDXL_v170.safetensors",
            "hassakuXLIllustrious_v34.safetensors",
            "noobaiXL_vpred10.safetensors",
            "nova3DCGXL_ilV90.safetensors",
            "ponyDiffusionV6XL_v6.safetensors",
            "autismmixSDXL_autismmixPony.safetensors",
            "waiSHUFFLENOOB_vPred04.safetensors",
            "uberRealisticPornMerge_urpmv13.safetensors",
        }
        deployed_unets = {
            "flux2_dev_fp8mixed.safetensors",
            "qwen_image_fp8_e4m3fn.safetensors",
            "z_image_turbo_bf16.safetensors",
            "flux-2-klein-4b.safetensors",
        }
        deployed_all = deployed_checkpoints | deployed_unets

        for preset_id in IMAGE_PRESET_IDS:
            preset = ALL_PRESETS[preset_id]
            assert preset.ckpt_name in deployed_all, (
                f"预设 {preset_id} 的模型 {preset.ckpt_name} 不在 worker 已部署列表中"
            )

    def test_video_presets_point_to_deployed_models(self):
        """视频预设的 ckpt_name 必须指向 worker 已部署的 Wan/LTX 模型。"""
        deployed_video_unets = {
            "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors",
            "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors",
            "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
            "ltx-2.3-22b-distilled-1.1.safetensors",
            "ltx-video-2b-v0.9.5.safetensors",
        }
        for preset_id in VIDEO_PRESET_IDS:
            preset = ALL_PRESETS[preset_id]
            assert preset.ckpt_name in deployed_video_unets, (
                f"视频预设 {preset_id} 的模型 {preset.ckpt_name} 不在 worker 已部署列表"
            )

    def test_default_presets_exist(self):
        """默认图像/视频预设必须存在于 ALL_PRESETS 中。"""
        assert DEFAULT_IMAGE_PRESET in ALL_PRESETS
        assert DEFAULT_VIDEO_PRESET in ALL_PRESETS
        assert ALL_PRESETS[DEFAULT_IMAGE_PRESET].media == MediaType.IMAGE
        assert ALL_PRESETS[DEFAULT_VIDEO_PRESET].media == MediaType.VIDEO

    def test_resolve_style_preset_valid_id(self):
        """传入有效 id 返回对应预设。"""
        preset = resolve_style_preset("chinese_text", MediaType.IMAGE)
        assert preset.id == "chinese_text"
        assert "qwen_image" in preset.ckpt_name
        assert preset.commercial_safe is True

    def test_resolve_style_preset_invalid_falls_back_to_default(self):
        """无效 id 返回对应媒体类型的默认预设。"""
        preset = resolve_style_preset("nonexistent_xyz", MediaType.IMAGE)
        assert preset.id == DEFAULT_IMAGE_PRESET

    def test_resolve_style_preset_none_returns_default(self):
        """None 返回默认图像预设。"""
        preset = resolve_style_preset(None, MediaType.IMAGE)
        assert preset.id == DEFAULT_IMAGE_PRESET

    def test_resolve_style_preset_video_default(self):
        """视频类型 None 返回默认视频预设。"""
        preset = resolve_style_preset(None, MediaType.VIDEO)
        assert preset.id == DEFAULT_VIDEO_PRESET
        assert preset.media == MediaType.VIDEO

    def test_list_presets_all(self):
        """list_presets() 返回全部预设,数量与 ALL_PRESETS 一致。"""
        presets = list_presets()
        assert len(presets) == len(ALL_PRESETS)
        for p in presets:
            assert "id" in p
            assert "label" in p
            assert "ckpt_name" in p
            assert "media" in p

    def test_list_presets_filter_by_media(self):
        """按 media 筛选只返回对应类型的预设。"""
        img_presets = list_presets(MediaType.IMAGE)
        vid_presets = list_presets(MediaType.VIDEO)
        assert len(img_presets) == len(IMAGE_PRESET_IDS)
        assert len(vid_presets) == len(VIDEO_PRESET_IDS)
        assert all(p["media"] == "image" for p in img_presets)
        assert all(p["media"] == "video" for p in vid_presets)

    def test_nsfw_presets_use_l4_llm(self):
        """NSFW 预设的 llm_layer 应为 L4。"""
        for pid in ("nsfw_realistic", "nsfw_anime", "nsfw_pony",
                    "nsfw_wai_shufflenoob", "nsfw_noobai_vpred", "nsfw_urpm"):
            preset = ALL_PRESETS[pid]
            assert preset.llm_layer == "L4", f"{pid} 应使用 L4 NSFW 模型"

    def test_sfw_intent_marks_exactly_main_site_anime_presets(self):
        """sfw_intent 精确标记主站 SFW 意图预设(底模命中 hints 但定位通用风格)。

        真 NSFW 预设(nsfw_*)、以及 hints 认定为成人向底模的预设
        (chibi→nova3dcg / portrait→cyberrealistic)不得标记,继续在主站隐藏。
        anime_high_quality(noobai)为通用二次元定位,与 anime(waiIllustrious)同逻辑标记;
        R18 用法由 nsfw_noobai_vpred 承担。
        """
        expected = {"anime", "anime_soft", "fantasy", "campus", "history_war",
                    "anime_high_quality"}
        marked = {p.id for p in ALL_PRESETS.values() if p.sfw_intent}
        assert marked == expected, f"sfw_intent 标记集合不符: {marked ^ expected}"
        for pid in ("nsfw_realistic", "nsfw_anime", "nsfw_pony",
                    "nsfw_wai_shufflenoob", "nsfw_noobai_vpred", "nsfw_urpm",
                    "chibi", "portrait"):
            assert ALL_PRESETS[pid].sfw_intent is False, f"{pid} 不应标 sfw_intent"

    def test_list_presets_exposes_sfw_intent(self):
        """list_presets 输出携带 sfw_intent(engine_registry 据此决定打 nsfw 标)。"""
        flags = {p["id"]: p["sfw_intent"] for p in list_presets()}
        assert flags["anime"] is True
        assert flags["fantasy"] is True
        assert flags["nsfw_anime"] is False
        assert flags["realistic"] is False

    def test_turbo_presets_have_low_steps(self):
        """极速/草稿预设步数应 <= 8。"""
        for pid in ("turbo", "draft"):
            preset = ALL_PRESETS[pid]
            assert preset.sampling.steps is not None
            assert preset.sampling.steps <= 8, f"{pid} 步数应 <= 8 但为 {preset.sampling.steps}"
            assert preset.commercial_safe is True

    def test_commercial_safe_presets_use_apache_models(self):
        """可商用预设只能指向 Apache 2.0 模型(Qwen-Image / Z-Image / Wan)。"""
        apache_keywords = ("qwen_image", "z_image", "wan")
        for preset in ALL_PRESETS.values():
            if preset.commercial_safe:
                assert any(kw in preset.ckpt_name.lower() for kw in apache_keywords), (
                    f"预设 {preset.id} 标记 commercial_safe 但模型 {preset.ckpt_name} 可能非 Apache 2.0"
                )

    def test_prompt_hint_does_not_double_append(self):
        """prompt_hint 不应包含逗号空格格式问题(以逗号开头才正确拼接)。"""
        for preset in ALL_PRESETS.values():
            if preset.prompt_hint:
                assert preset.prompt_hint.startswith(", "), (
                    f"{preset.id} 的 prompt_hint 应以 ', ' 开头以便拼接"
                )

    def test_nextgen_presets_cfg_matches_model_profiles(self):
        """次世代模型预设的推荐 cfg 须与 model_profiles 档案一致:
        flux2/z_image(蒸馏族)→ cfg≈1;qwen_image 底模 → 真 CFG 2.5~4。"""
        for preset in ALL_PRESETS.values():
            if preset.sampling.cfg is None:
                continue
            ckpt = preset.ckpt_name.lower()
            if "qwen_image" in ckpt:
                assert 2.5 <= preset.sampling.cfg <= 4.0, (
                    f"{preset.id} 使用 Qwen-Image 底模但 cfg={preset.sampling.cfg},应为真 CFG 2.5~4"
                )
            elif any(kw in ckpt for kw in ("flux2", "z_image")):
                assert 0.5 <= preset.sampling.cfg <= 2.0, (
                    f"{preset.id} 使用蒸馏次世代模型但 cfg={preset.sampling.cfg},应接近 1.0"
                )

    def test_qwen_image_presets_cfg_aligned_with_profile(self):
        """chinese_text/commercial_design 的 cfg 须等于 qwen_image 档案值(3.5)。"""
        profile_cfg = profile_for("qwen_image_fp8_e4m3fn.safetensors").cfg
        for pid in ("chinese_text", "commercial_design"):
            assert ALL_PRESETS[pid].sampling.cfg == profile_cfg == 3.5, (
                f"{pid} 的 cfg 应与 model_profiles qwen_image 档案一致"
            )

    def test_prompt_hint_has_no_lora_tags(self):
        """prompt_hint 必须是纯文本,禁止 <lora:> 等 A1111 语法(ComfyUI 不解析)。"""
        for preset in ALL_PRESETS.values():
            assert "<lora:" not in preset.prompt_hint, (
                f"{preset.id} 的 prompt_hint 含 <lora:> 标签,应改用 loras 字段"
            )

    def test_preset_loras_well_formed(self):
        """预设 loras 每项为 (文件名, 权重),权重在 LoRA 合法区间内。"""
        for preset in ALL_PRESETS.values():
            for entry in preset.loras:
                name, weight = entry
                assert isinstance(name, str) and name, f"{preset.id} 的 LoRA 名为空"
                assert -2.0 <= weight <= 2.0, (
                    f"{preset.id} 的 LoRA {name} 权重 {weight} 越界"
                )


# ─────────────────────────────────────────────────────────────────────────────
# llm_router 测试
# ─────────────────────────────────────────────────────────────────────────────


class TestLLMRouter:
    def test_all_four_layers_have_endpoints(self):
        """四层 LLM (L1-L4) 都必须配置端点(从 settings 解析)。"""
        endpoints = llm_endpoints()
        for layer in LLMLayer:
            assert layer in endpoints
            ep = endpoints[layer]
            assert ep.base_url.startswith("http")
            assert ep.model_id
            assert ep.timeout > 0

    def test_route_chat_to_l1(self):
        """实时聊天/草稿路由到 L1(快速)。"""
        ep = route_llm(ContentType.CHAT)
        assert ep.layer == LLMLayer.L1_DRAFT

    def test_route_script_to_l3(self):
        """正式剧本/创意故事路由到 L3(精修)。"""
        for ct in (ContentType.SCRIPT, ContentType.CREATIVE_STORY, ContentType.TECHNICAL_DOC):
            ep = route_llm(ct)
            assert ep.layer == LLMLayer.L3_POLISH, f"{ct.value} 应路由到 L3"

    def test_route_marketing_to_l2(self):
        """营销文案/分镜/对话路由到 L2(主力)。"""
        for ct in (ContentType.MARKETING_COPY, ContentType.STORYBOARD, ContentType.DIALOGUE):
            ep = route_llm(ct)
            assert ep.layer == LLMLayer.L2_MAIN, f"{ct.value} 应路由到 L2"

    def test_route_nsfw_forces_l4(self):
        """is_nsfw=True 强制路由到 L4,忽略 content_type。"""
        ep = route_llm(ContentType.CHAT, is_nsfw=True)
        assert ep.layer == LLMLayer.L4_NSFW
        ep2 = route_llm(ContentType.SCRIPT, is_nsfw=True)
        assert ep2.layer == LLMLayer.L4_NSFW

    def test_force_layer_override(self):
        """force_layer 覆盖自动路由。"""
        ep = route_llm(ContentType.CHAT, force_layer=LLMLayer.L3_POLISH)
        assert ep.layer == LLMLayer.L3_POLISH

    def test_force_layer_string(self):
        """force_layer 接受字符串。"""
        ep = route_llm(ContentType.CHAT, force_layer="L2")
        assert ep.layer == LLMLayer.L2_MAIN

    def test_string_content_type(self):
        """content_type 接受字符串。"""
        ep = route_llm("chat")
        assert ep.layer == LLMLayer.L1_DRAFT
        ep2 = route_llm("nsfw_script")
        assert ep2.layer == LLMLayer.L4_NSFW

    def test_list_endpoints_returns_all_four(self):
        endpoints = list_llm_endpoints()
        assert len(endpoints) == 4
        layers = {e["layer"] for e in endpoints}
        assert layers == {"L1", "L2", "L3", "L4"}

    def test_list_content_types_covers_all_enum(self):
        types = list_content_types()
        type_ids = {t["content_type"] for t in types}
        for ct in ContentType:
            assert ct.value in type_ids, f"ContentType {ct.value} 未在路由表中"

    def test_nsfw_content_types_route_to_l4(self):
        """所有 nsfw_ 开头的内容类型必须路由到 L4。"""
        types = list_content_types()
        for t in types:
            if t["content_type"].startswith("nsfw_"):
                assert t["recommended_layer"] == "L4", (
                    f"{t['content_type']} 应路由到 L4"
                )


# ─────────────────────────────────────────────────────────────────────────────
# model_health 测试
# ─────────────────────────────────────────────────────────────────────────────


class TestModelHealth:
    def test_check_critical_all_present(self):
        """所有关键模型存在时返回全部 healthy,无缺失。"""
        existing = ["a.safetensors", "b.safetensors", "c.safetensors"]
        critical = ["a.safetensors", "b.safetensors"]
        health, missing = _check_critical(existing, critical)
        assert len(health) == 2
        assert all(h.status == HealthStatus.HEALTHY for h in health)
        assert missing == []

    def test_check_critical_missing(self):
        """缺失模型被正确标记。"""
        existing = ["a.safetensors"]
        critical = ["a.safetensors", "b.safetensors", "c.safetensors"]
        health, missing = _check_critical(existing, critical)
        assert len(missing) == 2
        assert "b.safetensors" in missing
        assert "c.safetensors" in missing

    def test_check_critical_case_insensitive(self):
        """文件名匹配大小写不敏感。"""
        existing = ["Flux2_Dev_FP8.Safetensors"]
        critical = ["flux2_dev_fp8mixed.safetensors"]
        health, missing = _check_critical(existing, critical)
        # "Flux2_Dev_FP8" 不完全等于 "flux2_dev_fp8mixed"
        assert "flux2_dev_fp8mixed.safetensors" in missing

    def test_suggest_fallbacks_for_missing(self):
        """缺失关键模型时有替代建议。"""
        missing = ["qwen_image_fp8_e4m3fn.safetensors", "ae.safetensors"]
        suggestions = _suggest_fallbacks(missing)
        assert len(suggestions) >= 1
        # Qwen-Image 的建议应提到替代方案
        assert any("替代" in s or "FLUX" in s or "z_image" in s for s in suggestions)

    def test_suggest_fallbacks_unknown_missing_no_suggestion(self):
        """未知的缺失模型不给出建议。"""
        suggestions = _suggest_fallbacks(["totally_unknown_model.xyz"])
        assert suggestions == []


class TestModelEvaluator:
    def test_record_and_retrieve_score(self):
        ev = ModelEvaluator()
        ev.record_score("model_a", "realistic", 0.85)
        ev.record_score("model_a", "realistic", 0.75)
        ev.record_score("model_a", "realistic", 0.95)
        scores = ev.get_all_scores()
        ma = [s for s in scores if s["model_name"] == "model_a" and s["style_id"] == "realistic"]
        assert len(ma) == 1
        assert ma[0]["sample_count"] == 3
        assert abs(ma[0]["avg_score"] - 0.85) < 0.01  # (0.85+0.75+0.95)/3 = 0.85

    def test_get_best_model_returns_highest_scoring(self):
        ev = ModelEvaluator()
        # model_b 在 realistic 上表现更好
        for _ in range(3):
            ev.record_score("model_b", "realistic", 0.9)
        for _ in range(3):
            ev.record_score("model_c", "realistic", 0.7)
        best = ev.get_best_model("realistic")
        assert best == "model_b"

    def test_get_best_model_insufficient_samples(self):
        """样本数不足3时返回 None。"""
        ev = ModelEvaluator()
        ev.record_score("model_a", "anime", 0.8)
        ev.record_score("model_a", "anime", 0.9)
        assert ev.get_best_model("anime") is None

    def test_get_best_model_no_data(self):
        ev = ModelEvaluator()
        assert ev.get_best_model("nonexistent") is None

    def test_multiple_styles_separate(self):
        """不同风格的评分互不干扰。"""
        ev = ModelEvaluator()
        for _ in range(3):
            ev.record_score("model_x", "realistic", 0.6)
            ev.record_score("model_y", "anime", 0.9)
        assert ev.get_best_model("realistic") == "model_x"
        assert ev.get_best_model("anime") == "model_y"
