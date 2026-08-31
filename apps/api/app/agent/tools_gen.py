"""深度接管生成工具:异步提交任意引擎作业 / 查状态 / 优化提示词 / 大需求提案。

与 tools.py 的 8 个同步小工具互补:那些直出快速小图小音乐(同步等结果);
本文件的 submit_generation 走「提交即返回 job_id」的异步路径,够得着
H3(:8195)/LongCat(:8197)/animate2(:8199)/qwen-edit(:8194) 等专用实例,
单段 15 分钟的 H3 作业也不会再被 _wait_files 超时卡死。

设计纪律:
- 提交全部委托 routes 层的端点函数(同一服务函数,带原有的请求模型校验/
  R18 门控/资源预检/hold 排队/tracker 落库),本文件不复制任何生成逻辑;
- 引擎清单/可用性以 services.engine_registry 为唯一事实源(get_engine_spec
  取原始条目做 R18 判定,list_engines 做可用性探测);
- R18 引擎门控:tool_seam 的静态 nsfw=True 标记会把整个工具锁死(SFW 引擎
  也用不了),故本工具在**执行器内按目标引擎逐条**判定,拦截文案与
  tool_seam._nsfw_guard 同一 403 语义;下游路由还有第二道门(nsfw_allowed)。
- 工具结果里的事件 dict(type=job/proposal/tool_event)由 runner 原样透出,
  路由层映射为同名 SSE 事件(协议见 routes/agent.py 头注释)。
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from pydantic import ValidationError
from sqlmodel import select

from app.comfy.pool import WorkerPool
from app.models import AgentSession, Entity, Job, User
from app.nsfw_ctx import nsfw_allowed

logger = logging.getLogger(__name__)

# 与 tool_seam._nsfw_guard 同一 403 语义文案(按引擎逐条判定的版本)
_R18_BLOCK_TEXT = (
    "引擎 {label}({engine_id})仅 R18 模式可用(403),"
    "本轮请改用常规引擎或提示用户切换到 /nsfw 专区后重试。"
)

TOOL_SCHEMAS_GEN = [
    {
        "type": "function",
        "function": {
            "name": "submit_generation",
            "description": (
                "异步提交一个生成作业到指定引擎(立即返回 job_id,不等待结果)。"
                "视频/批量/长耗时/专用实例引擎一律用它,不要用同步工具。"
                "提交前必须先 optimize_prompt 优化提示词(除非用户输入已是详细英文);"
                "需要参考图/驱动视频/音频的引擎(i2v/animate/avatar/edit 类)须在 params 里给 "
                "image/video/audio 文件名与 worker(用户本轮上传了图则自动用该图)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "engine_id": {
                        "type": "string",
                        "description": (
                            "引擎 id,可选:txt2img|img2img|qwen-image-edit|ace-music|"
                            "h3-t2v|h3-i2v|longcat-t2v|longcat-i2v|longcat-continue|"
                            "avatar-talk|wan-animate|wan-animate-2|wan-vace|"
                            "nsfw-txt2img|nsfw-img2img|h3-nsfw-t2v|h3-nsfw-i2v|"
                            "ltx-nsfw-t2v|ltx-nsfw-i2v|ltx-nsfw-lipsync|wan-nsfw-i2v"
                        ),
                    },
                    "positive": {"type": "string", "description": "正向提示词(英文效果最佳;ace-music 填音乐标签;wan-animate-2 留空=自动反推外观)"},
                    "negative": {"type": "string", "description": "负向提示词(可选)"},
                    "entity_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "全局主体库主体 id 列表(可选,1-4 个;先 list_entities 查)."
                            "选中后自动把主体的 prompt_hint 注入提示词;"
                            "对需要参考图的引擎(i2v/edit 类),首个有图主体的参考图"
                            "自动作为参考图提交(显式 image 参数优先)"
                        ),
                    },
                    "params": {
                        "type": "object",
                        "description": (
                            "引擎参数(与 /api/models/engines 该引擎 params 同 key):"
                            "图像 width/height/steps/cfg/ckpt_name/batch_size;"
                            "视频 width/height/duration_sec/steps/fps/seed;"
                            "参考媒体 image/images/video/audio + worker;"
                            "qwen-image-edit 的 camera/azimuth/elevation/distance/fast"
                        ),
                        "additionalProperties": True,
                    },
                },
                "required": ["engine_id", "positive"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_entities",
            "description": (
                "查询用户的全局主体库(角色/场景/道具,跨项目复用的主体资产,"
                "含参考图与提示词描述)。用户提到「我的角色/主体库/之前建的主体」"
                "或要在生成中保持角色一致时先查;返回的 id 可传给 "
                "submit_generation 的 entity_ids 引用主体。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["character", "scene", "prop"],
                        "description": "按主体类别过滤(可选;缺省返回全部)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_jobs",
            "description": "查询一批生成作业的状态与产物(用户追问进度/结果时调用;done 的会把产物链接补发给用户)。",
            "parameters": {
                "type": "object",
                "properties": {
                    "job_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "submit_generation 返回的 job_id 列表(1-20 个)",
                    },
                },
                "required": ["job_ids"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "optimize_prompt",
            "description": (
                "把用户的简单描述优化成目标引擎/底模听得懂的专业提示词(与输入框的「AI 优化」同一链路,"
                "按引擎/模型族自动切方言:H3 负向全正向化、wan-animate-2 纯外观 caption、"
                "Pony/SDXL 标签风、Flux/Qwen 自然语言等)。提交生成前必调。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "用户的原始描述(中文即可)"},
                    "kind": {
                        "type": "string",
                        "enum": ["image", "image_edit", "video", "audio", "threed", "qwen_edit", "scope"],
                        "description": "优化目标类型,默认 image;视频引擎用 video,智能编辑用 qwen_edit,音乐用 audio",
                    },
                    "engine": {"type": "string", "description": "目标引擎 id(视频类按引擎切方言,如 h3-t2v / wan-animate-2)"},
                    "model": {"type": "string", "description": "目标底模文件名(图像类按模型族切方言)"},
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_plan",
            "description": (
                "大需求(视频/批量/多步/整集短片)先出方案提案等用户确认。"
                "调用后本轮正常结束,用户确认/修改/拒绝后对话自动继续。"
                "提案前必须先用自然语言与用户敲定风格与关键细节(题材/画风/镜头/时长/NSFW 档位)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "方案标题(一句话)"},
                    "body": {"type": "string", "description": "方案正文(markdown):分步拆解、每步用的引擎/底模/提示词方向、产出物"},
                    "estimate": {"type": "string", "description": "预计耗时/资源,如「3 段 H3,约 45 分钟」"},
                },
                "required": ["title", "body"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "adjust_3d",
            "description": (
                "对已有 3D 模型(GLB)做材质/渲染/纹理级调整,立即返回产物。"
                "渲染的默认语义是把材质效果烘焙回 3D 模型本身,产出新的 3D 模型(GLB),"
                "不是生成图片/视频。"
                "自然语言映射:「换成金属/哑光/黏土/陶瓷质感」「渲染一下这个模型」"
                "→ op=render + material 预设(out 默认 glb,新模型进作品库 3D 桶);"
                "「出个旋转视频/转一圈看看」→ op=render + out=mp4;"
                "「渲染快照/看看某个角度/线框/法线看看」→ op=render + out=png(+azimuth;"
                "wireframe/normal 是纯查看模式,只能出 png/mp4,不能烘焙成 GLB);"
                "「染成青铜色/改成金色/更光滑」→ op=material + base_color/metallic/roughness(导出新 GLB);"
                "「上色/贴图/画纹理/换皮肤/生成真实材质贴图」→ op=texture(Hunyuan3D 2.1 多视图扩散"
                "生成真 PBR 贴图烘焙回模型,分钟级耗时,prompt 传风格描述如「青铜锈蚀质感」;"
                "图生3D 作业会自动复用原始参考图,无需用户提供)。"
                "来源:source_job_id 指定作品库 3D 作业,不传则用用户最近一个 3D 产物。"
                "注意:render/material 是秒级~一分钟,texture 是分钟级;都不改变模型几何。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "op": {
                        "type": "string",
                        "enum": ["render", "material", "texture"],
                        "description": "render=材质预设渲染(默认烘焙成新 GLB 模型);material=PBR 材质改写导出新 GLB;texture=Hunyuan3D 2.1 生成真 PBR 贴图(分钟级)",
                    },
                    "source_job_id": {
                        "type": "string",
                        "description": "作品库 3D 作业 id(可选;不传自动取用户最近一个 GLB 产物)",
                    },
                    "material": {
                        "type": "string",
                        "enum": ["clay", "matte", "metal", "glossy", "wireframe", "normal"],
                        "description": "render 材质预设:clay 黏土/matte 哑光/metal 金属/glossy 陶瓷(默认 clay);wireframe 线框/normal 法线仅查看模式(out=png/mp4)",
                    },
                    "out": {
                        "type": "string",
                        "enum": ["glb", "png", "mp4"],
                        "description": "render 输出:glb 材质烘焙成新 3D 模型(默认)/ png 静态快照 / mp4 360° 旋转视频",
                    },
                    "lighting": {
                        "type": "string",
                        "enum": ["environment", "studio", "rim"],
                        "description": "灯光:environment 天光/studio 三点布光(默认)/rim 轮廓光",
                    },
                    "background": {
                        "type": "string",
                        "enum": ["transparent", "white", "dark"],
                        "description": "背景:transparent 透明(仅 png)/white 白/dark 深灰渐变(默认)",
                    },
                    "format": {
                        "type": "string",
                        "enum": ["png", "mp4"],
                        "description": "旧参数,等价于 out;out 缺省时生效(默认 png)",
                    },
                    "azimuth": {
                        "type": "number",
                        "description": "快照方位角(度,0=正面,默认 30;仅 out=png)",
                    },
                    "base_color": {
                        "type": "string",
                        "description": "op=material 染色,#RRGGBB(如青铜 #b87333、金 #d4af37、银 #c0c0c0)",
                    },
                    "metallic": {"type": "number", "description": "op=material 金属度 0-1(默认 0.85)"},
                    "roughness": {"type": "number", "description": "op=material 粗糙度 0-1(默认 0.35)"},
                    "prompt": {"type": "string", "description": "用户意图原文(作为作品库展示标题)"},
                },
                "required": ["op"],
            },
        },
    },
    # ── W3 UI 驱动工具(2026-08-31):助手可驱动前端界面(跳转/预填/开产物) ──
    {
        "type": "function",
        "function": {
            "name": "navigate_view",
            "description": (
                "把前端界面切换到指定功能页(用户说「去/打开/切到 X」或任务需要在特定页面继续时用)。"
                "例如「帮我把这个视频送去译制」→ navigate_view(dub);「我要做数字人」→ avatartalk;"
                "「看看我的作品」→ library;「进工作室做短剧」→ studio。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "view": {
                        "type": "string",
                        "description": (
                            "目标页:home(对话首页)|image(图片)|video(视频)|audio(音频)|"
                            "fusion(场景门户)|studio(短剧工作室)|avatartalk(数字人)|dub(译制)|"
                            "imageEdit(图片编辑)|videoEdit(视频剪辑)|animatic(动态分镜)|"
                            "canvas(画布)|library(作品库)|entities(主体库)|market(市场)|"
                            "resources(资源中心)|settings(设置)"
                        ),
                    },
                    "reason": {"type": "string", "description": "一句话说明跳转原因(展示给用户)"},
                },
                "required": ["view"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prefill_generate",
            "description": (
                "预填生成工作台的提示词并跳过去(用户想自己微调参数再手动提交时用;"
                "若用户意图是「直接生成」,仍用 submit_generation)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["image", "video"], "description": "目标板块"},
                    "prompt": {"type": "string", "description": "预填的正向提示词"},
                },
                "required": ["kind", "prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_asset",
            "description": (
                "在作品库打开一个已有产物(用户说「打开/找到那个作品」时;"
                "先用 check_jobs 或对话上下文拿到 job_id)。job 必须属于当前用户。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "作品库作业 id"},
                },
                "required": ["job_id"],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# 引擎 → routes 端点函数分发(与前端工作台同一提交链路,不复制逻辑)
# ---------------------------------------------------------------------------
# 每条:async (positive, negative, params, pool, user, session) -> routes 返回 dict。
# 请求模型校验/门控/hold/tracker 全在路由函数内,这里只做参数搬运与媒体回填。

def _media_defaults(params: dict, attachment: dict | None, *keys: str) -> dict:
    """参考媒体回填:params 缺 image/worker 等键且本轮有上传图时,用上传句柄补上。"""
    out = dict(params)
    if attachment and attachment.get("filename"):
        for key in keys:
            if key == "worker":
                out.setdefault("worker", attachment.get("worker", ""))
            else:
                out.setdefault(key, attachment["filename"])
    return out


async def _submit_txt2img(pos, neg, params, pool, user, session) -> dict:
    from app.routes import generate as gen

    req = gen.Txt2ImgRequest(positive=pos, negative=neg, **params)
    return await gen.generate_txt2img(req, pool, user, session)


async def _submit_img2img(pos, neg, params, pool, user, session) -> dict:
    from app.routes import generate as gen

    req = gen.Img2ImgRequest(positive=pos, negative=neg, **params)
    return await gen.generate_img2img(req, user, session)


async def _submit_qwen_edit(pos, neg, params, pool, user, session) -> dict:
    from app.routes import generate as gen

    req = gen.QwenEditRequest(positive=pos, **params)
    return await gen.generate_qwen_edit(req, user, session)


async def _submit_ace_music(pos, neg, params, pool, user, session) -> dict:
    from app.routes import audio as audio_route

    req = audio_route.AudioRequest(tags=pos, **params)
    return await audio_route.generate_audio(req, pool, user, session)


async def _submit_ace_music_legacy(pos, neg, params, pool, user, session) -> dict:
    from app.routes import audio as audio_route

    # 旧版引擎固定 legacy 档(防 LLM 把 quality 改回 1.5)
    req = audio_route.AudioRequest(tags=pos, **{**params, "quality": "legacy"})
    return await audio_route.generate_audio(req, pool, user, session)


async def _submit_h3_t2v(pos, neg, params, pool, user, session) -> dict:
    from app.routes import h3_studio

    req = h3_studio.H3T2VRequest(positive=pos, negative=neg, **params)
    return await h3_studio.generate_h3_t2v(req, user, session)


async def _submit_h3_i2v(pos, neg, params, pool, user, session) -> dict:
    from app.routes import h3_studio

    req = h3_studio.H3I2VRequest(positive=pos, negative=neg, **params)
    return await h3_studio.generate_h3_i2v(req, user, session)


async def _submit_h3_multishot(pos, neg, params, pool, user, session) -> dict:
    from app.routes import h3_studio

    # 多镜头:shots(2-4 个镜头规格)由 LLM 按参数表显式给出;positive 仅作对话语境,
    # 不注入提示词(镜头内容全部由 shots 承载)
    req = h3_studio.H3MultiShotRequest(negative=neg, **params)
    return await h3_studio.generate_h3_multishot(req, user, session)


async def _submit_ltx_t2v(pos, neg, params, pool, user, session) -> dict:
    from app.routes import video as video_route

    req = video_route.LtxT2VRequest(positive=pos, negative=neg, **params)
    return await video_route.generate_ltx_t2v(req, user, session)


async def _submit_ltx_i2v(pos, neg, params, pool, user, session) -> dict:
    from app.routes import video as video_route

    req = video_route.LtxI2VRequest(positive=pos, negative=neg, **params)
    return await video_route.generate_ltx_i2v(req, user, session)


async def _submit_ltx_lipsync(pos, neg, params, pool, user, session) -> dict:
    from app.routes import video as video_route

    req = video_route.LtxLipsyncRequest(positive=pos, negative=neg, **params)
    return await video_route.generate_ltx_lipsync(req, user, session)


async def _submit_wan_nsfw_i2v(pos, neg, params, pool, user, session) -> dict:
    from app.routes import video as video_route

    req = video_route.WanI2VRequest(positive=pos, negative=neg or None, **params)
    return await video_route.generate_video(req, user, session)


async def _submit_longcat_t2v(pos, neg, params, pool, user, session) -> dict:
    from app.routes import longcat_studio

    req = longcat_studio.LongCatT2VRequest(positive=pos, negative=neg, **params)
    return await longcat_studio.generate_longcat_t2v(req, user, session)


async def _submit_longcat_i2v(pos, neg, params, pool, user, session) -> dict:
    from app.routes import longcat_studio

    req = longcat_studio.LongCatI2VRequest(positive=pos, negative=neg, **params)
    return await longcat_studio.generate_longcat_i2v(req, user, session)


async def _submit_longcat_continue(pos, neg, params, pool, user, session) -> dict:
    from app.routes import longcat_studio

    req = longcat_studio.LongCatContinueRequest(positive=pos, negative=neg, **params)
    return await longcat_studio.generate_longcat_continue(req, user, session)


async def _submit_avatar_talk(pos, neg, params, pool, user, session) -> dict:
    from app.routes import avatar_studio

    kw = dict(params)
    if neg:
        kw.setdefault("negative", neg)
    req = avatar_studio.AvatarTalkRequest(positive=pos, **kw)
    return await avatar_studio.generate_avatar_talk(req, user, session)


async def _submit_wan_animate(pos, neg, params, pool, user, session) -> dict:
    from app.routes import wan_studio

    req = wan_studio.WanAnimateRequest(positive=pos, negative=neg, **params)
    return await wan_studio.generate_wan_animate(req, user, session)


async def _submit_wan_animate2(pos, neg, params, pool, user, session) -> dict:
    from app.routes import wan_studio

    # positive 可空(后端 VLM 自动反推外观 caption)
    req = wan_studio.WanAnimate2Request(positive=pos, negative=neg, **params)
    return await wan_studio.generate_wan_animate2(req, user, session)


async def _submit_wan_vace(pos, neg, params, pool, user, session) -> dict:
    from app.routes import wan_studio

    req = wan_studio.WanVaceRequest(positive=pos, negative=neg, **params)
    return await wan_studio.generate_wan_vace(req, user, session)


# ── Phase 4 新引擎 dispatch(2026-08-28;dispatch_covers 守卫要求注册表全覆盖) ──


async def _submit_ovi_t2v(pos, neg, params, pool, user, session) -> dict:
    from app.routes import ovi

    # 台词/音频描述在路由侧经 assemble_ovi_prompt 三段式拼装;positive 作画面描述
    req = ovi.OviT2VRequest(positive=pos, negative=neg, **params)
    return await ovi.generate_ovi_t2v(req, user, session)


async def _submit_ovi_i2v(pos, neg, params, pool, user, session) -> dict:
    from app.routes import ovi

    req = ovi.OviI2VRequest(positive=pos, negative=neg, **params)
    return await ovi.generate_ovi_i2v(req, user, session)


async def _submit_phantom_s2v(pos, neg, params, pool, user, session) -> dict:
    from app.routes import phantom_studio

    req = phantom_studio.PhantomS2VRequest(positive=pos, negative=neg, **params)
    return await phantom_studio.generate_phantom_s2v(req, user, session)


async def _submit_ltx25_multishot(pos, neg, params, pool, user, session) -> dict:
    from app.routes import ltx

    # shots(2-4 镜头)由 LLM 按参数表显式给出;positive 仅作对话语境不注入
    req = ltx.LtxMultishotRequest(negative=neg, **params)
    return await ltx.generate_ltx_multishot(req, user, session)


async def _submit_flux_nunchaku(pos, neg, params, pool, user, session) -> dict:
    from app.routes import flux_nunchaku

    # FLUX 官方档:负向恒空(builder 内 FLUX.1-dev 范式),不入参
    req = flux_nunchaku.FluxNunchakuRequest(positive=pos, **params)
    return await flux_nunchaku.generate_flux_nunchaku(req, pool, user, session)


async def _submit_vace_edit(pos, neg, params, pool, user, session) -> dict:
    from app.routes import wan_studio

    # VACE 视频编辑:positive 作为编辑指令(edit_prompt 缺省回填);
    # source_video/worker 须由 LLM 按参数表显式给出(媒体为视频,不做图片附件回填)
    kw = dict(params)
    kw.setdefault("edit_prompt", pos)
    req = wan_studio.WanVaceEditRequest(negative=neg, **kw)
    return await wan_studio.generate_video_edit(req, user, session)


async def _submit_wan_transition(pos, neg, params, pool, user, session) -> dict:
    from app.routes import wan_studio

    req = wan_studio.TransitionRequest(positive=pos, negative=neg, **params)
    return await wan_studio.generate_transition(req, user, session)


async def _submit_keyframe_chain(pos, neg, params, pool, user, session) -> dict:
    from app.routes import wan_studio

    # 关键帧链:positive 作为全段共用提示词(prompts 单 string 语义);
    # keyframes(2-5 张链序上传句柄)/worker/durations 由 LLM 按参数表显式给出
    req = wan_studio.KeyframeChainRequest(prompts=pos, negative=neg, **params)
    return await wan_studio.generate_keyframe_chain(req, user, session)


# (分发函数, 参考媒体回填键)——回填键为空元组 = 纯文本引擎
_DISPATCH = {
    "txt2img": (_submit_txt2img, ()),
    "nsfw-txt2img": (_submit_txt2img, ()),
    "img2img": (_submit_img2img, ("image", "worker")),
    "nsfw-img2img": (_submit_img2img, ("image", "worker")),
    "qwen-image-edit": (_submit_qwen_edit, ("image", "worker")),
    "ace-music": (_submit_ace_music, ()),
    "ace-music-legacy": (_submit_ace_music_legacy, ()),
    "h3-t2v": (_submit_h3_t2v, ()),
    "h3-nsfw-t2v": (_submit_h3_t2v, ()),
    "h3-i2v": (_submit_h3_i2v, ("image", "worker")),
    "h3-nsfw-i2v": (_submit_h3_i2v, ("image", "worker")),
    "h3-multishot": (_submit_h3_multishot, ()),
    "ltx-nsfw-t2v": (_submit_ltx_t2v, ()),
    "ltx-nsfw-i2v": (_submit_ltx_i2v, ("image", "worker")),
    "ltx-nsfw-lipsync": (_submit_ltx_lipsync, ("image", "worker")),
    "wan-nsfw-i2v": (_submit_wan_nsfw_i2v, ("image", "worker")),
    "longcat-t2v": (_submit_longcat_t2v, ()),
    "longcat-i2v": (_submit_longcat_i2v, ("image", "worker")),
    "longcat-continue": (_submit_longcat_continue, ()),
    "avatar-talk": (_submit_avatar_talk, ("image", "worker")),
    "wan-animate": (_submit_wan_animate, ("image", "worker")),
    "wan-animate-2": (_submit_wan_animate2, ("image", "worker")),
    "wan-vace": (_submit_wan_vace, ()),
    "vace-edit": (_submit_vace_edit, ()),
    "wan-transition": (_submit_wan_transition, ()),
    "keyframe-chain": (_submit_keyframe_chain, ()),
    "ovi-t2v": (_submit_ovi_t2v, ()),
    "ovi-i2v": (_submit_ovi_i2v, ("image", "worker")),
    "phantom-s2v": (_submit_phantom_s2v, ("images",)),
    "ltx25-multishot": (_submit_ltx25_multishot, ()),
    "flux1-nunchaku": (_submit_flux_nunchaku, ()),
}


def _err_event(summary: str, detail: str = "") -> dict:
    ev: dict = {"type": "tool_event", "data": {"status": "error", "summary": summary}}
    if detail:
        ev["data"]["detail"] = detail
    return ev


def _job_event(*, job_id: str, kind: str, status: str, label: str,
               hold_reason: str = "", results: list[str] | None = None) -> dict:
    data: dict = {"job_id": job_id, "kind": kind, "status": status, "label": label}
    if hold_reason:
        data["hold_reason"] = hold_reason
    if results is not None:
        data["results"] = results
    return {"type": "job", "data": data}


# ---------------------------------------------------------------------------
# 执行器(签名:(args, ctx) → (给 LLM 的文本, 事件列表);ctx 键见 tool_seam 约定
# + agent_session:本会话 AgentSession 行,propose_plan 落 pending 提案用)
# ---------------------------------------------------------------------------

def _apply_entity_refs(
    session, user: User, entity_ids: list[str], positive: str, params: dict,
    media_keys: tuple[str, ...], engine_id: str = "",
) -> tuple[str, dict, list[str]]:
    """全局主体库注入:prompt_hint 拼入提示词;参考图按引擎媒体键形态注入。

    - 仅解析当前用户的主体(他人 id 静默跳过,防跨用户引用);
    - prompt_hint 为空回退 description;注入片段统一放 positive 末尾;
    - 单图引擎(image 键):首个有图主体补位(显式参数优先);
    - 多图引擎(images 键,phantom-s2v):entity_ids 直接透传进参数,
      由 phantom 路由自行解析(404 防枚举/422 无句柄,合计上限 4 张),
      避免此处重复实现一套句柄解析(2026-08-29 多主体注入修复);
    - H3 引擎(h3-t2v/i2v):entity_ids 同样透传,由 h3_studio 路由在 prompt
      绝对开头注入 @图片N 引用行(2026-08-29 B3 修复:此前 agent 路径丢弃
      entity_ids,只有文本 hint,@图片N 机制对助手完全失效)。
    返回 (positive, params, 命中的主体名列表)。
    """
    from app.services.entities import image_handle_for_injection

    ids = [i for i in entity_ids if isinstance(i, str) and i.strip()][:4]
    if not ids:
        return positive, params, []
    rows = session.exec(
        select(Entity).where(Entity.user_id == user.id, Entity.id.in_(ids))  # type: ignore[attr-defined]
    ).all()
    order = {i: n for n, i in enumerate(ids)}
    rows.sort(key=lambda e: order.get(e.id, len(ids)))

    hints: list[str] = []
    names: list[str] = []
    out = dict(params)
    for e in rows:
        names.append(e.name)
        hint = (e.prompt_hint or e.description or "").strip()
        if hint:
            hints.append(f"{e.name}: {hint}")
        if "image" in media_keys and not out.get("image"):
            handle = image_handle_for_injection(e)
            if handle:
                out["image"] = handle["filename"]
                out["worker"] = handle["worker"]
    # 多图引擎:显式 images/entity_ids 已给则不补,否则透传主体 id(phantom 路由解析)
    if "images" in media_keys and not out.get("images") and not out.get("entity_ids"):
        out["entity_ids"] = [e.id for e in rows]
    # H3 引擎:@图片N 引用行由路由层注入,需透传主体 id(显式 entity_ids 优先)
    if engine_id.startswith("h3-") and not out.get("entity_ids"):
        out["entity_ids"] = [e.id for e in rows]
    if hints:
        positive = f"{positive}\n[主体库] " + "; ".join(hints) if positive else "; ".join(hints)
    return positive, out, names


async def exec_submit_generation(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.services import engine_registry

    pool: WorkerPool = ctx["pool"]
    user: User = ctx["user"]
    session = ctx["session"]
    attachment = ctx.get("attachment")

    engine_id = str(args.get("engine_id") or "").strip()
    positive = str(args.get("positive") or "").strip()
    negative = str(args.get("negative") or "")
    params = args.get("params") if isinstance(args.get("params"), dict) else {}
    entity_ids = args.get("entity_ids") if isinstance(args.get("entity_ids"), list) else []
    # 前端 @主体 引用经 chat ctx 透传:LLM 未显式传 entity_ids 时用会话级兜底
    if not entity_ids:
        ctx_eids = ctx.get("entity_ids") or []
        if isinstance(ctx_eids, list):
            entity_ids = [i for i in ctx_eids if isinstance(i, str)][:4]

    spec = engine_registry.get_engine_spec(engine_id)
    if spec is None:
        return (
            f"未知引擎: {engine_id or '(空)'}。先用 search_knowledge 查引擎清单,"
            "或从 /api/models/engines 的引擎 id 里选。",
            [_err_event("未知引擎", engine_id)],
        )
    label = spec["label"]

    # R18 逐引擎门控(403 语义同 tool_seam._nsfw_guard;理由见模块头注释)
    if spec["nsfw"] and not nsfw_allowed(user):
        return _R18_BLOCK_TEXT.format(label=label, engine_id=engine_id), [
            _err_event(f"{label} 仅 R18 可用(403)")
        ]

    entry = _DISPATCH.get(engine_id)
    if entry is None:
        return f"引擎 {label}({engine_id})暂不支持助手提交,请引导用户到生成工作台操作。", [
            _err_event("引擎未接入助手提交", engine_id)
        ]
    submit_fn, media_keys = entry

    # 全局主体库注入:prompt_hint 拼提示词 + 首个有图主体补参考图(显式参数优先)
    entity_names: list[str] = []
    if entity_ids:
        positive, params, entity_names = _apply_entity_refs(
            session, user, entity_ids, positive, params, media_keys, engine_id,
        )

    # 可用性探测(注册表唯一事实源,8s TTL 缓存;R18 引擎在 R18 上下文才在列表里)
    try:
        engines = await engine_registry.list_engines(pool, user)
    except Exception as e:  # 探测自身异常不挡路,交给提交路径报错
        logger.warning("submit_generation: list_engines 探测异常(继续提交): %s", e)
        engines = []
    avail = next((e for e in engines if e["id"] == engine_id), None)
    if avail is not None and not avail.get("available"):
        reason = avail.get("unavailable_reason") or "引擎当前不可用"
        return f"引擎 {label} 当前不可用:{reason}", [_err_event(f"{label} 不可用", reason)]

    try:
        result = await submit_fn(
            positive, negative, _media_defaults(params, attachment, *media_keys),
            pool, user, session,
        )
    except HTTPException as e:
        return f"提交失败({e.status_code}):{e.detail}", [
            _err_event("提交失败", str(e.detail))
        ]
    except ValidationError as e:
        first = (e.errors() or [{}])[0]
        loc = ".".join(str(x) for x in first.get("loc", []))
        detail = f"参数 {loc or '?'} 不合法:{first.get('msg', e)}"
        return f"提交参数不合法:{detail}。请对照该引擎的参数表修正后重试。", [
            _err_event("参数不合法", detail)
        ]

    # 路由已落 Job + 挂 tracker(或 hold 排队);按 prompt_id 回查稳定 job_id
    prompt_id = result.get("prompt_id", "")
    job = session.exec(
        select(Job).where(Job.prompt_id == prompt_id, Job.user_id == user.id)
    ).first()
    job_id = job.id if job else prompt_id
    status = job.status if job else ("held" if result.get("held") else "queued")
    hold_reason = (job.hold_reason if job else "") or str(result.get("hold_reason") or "")
    kind = spec.get("submit", {}).get("kind", engine_id)

    event = _job_event(
        job_id=job_id, kind=kind, status=status, label=label, hold_reason=hold_reason,
    )
    if status == "held":
        text = (
            f"作业已提交但资源暂不足,进入排队(job_id={job_id})。原因:{hold_reason}。"
            "资源释放后会自动放行,用户追问进度时用 check_jobs 查询。"
        )
    else:
        queued_behind = result.get("queued_behind") or 0
        text = (
            f"作业已提交(job_id={job_id},引擎 {label}),后台生成中。"
            + (f"前方还有 {queued_behind} 个作业排队。" if queued_behind else "")
            + "请告知用户 job_id 与预计耗时;完成后产物会自动进作品库,"
              "用户追问进度时用 check_jobs 查询并把结果展示给用户。"
        )
    if entity_names:
        text += f"已引用主体库:{','.join(entity_names)}。"
    if result.get("duration_notice"):
        text += f"时长说明:{result['duration_notice']}"
    if result.get("upscale_notice"):
        text += f"超分说明:{result['upscale_notice']}"
    return text, [event]


async def exec_list_entities(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    """全局主体库查询:当前用户的主体清单(角色/场景/道具),供 entity_ids 引用。"""
    user: User = ctx["user"]
    session = ctx["session"]

    kind = str(args.get("kind") or "").strip()
    stmt = select(Entity).where(Entity.user_id == user.id)
    if kind in ("character", "scene", "prop"):
        stmt = stmt.where(Entity.kind == kind)
    rows = session.exec(stmt.order_by(Entity.created_at)).all()
    if not rows:
        return (
            "主体库为空。引导用户到「主体库」页创建角色/场景/道具主体"
            "(可上传参考图与三视图),创建后即可在生成中引用。",
            [],
        )
    kind_label = {"character": "角色", "scene": "场景", "prop": "道具"}
    lines = []
    for e in rows:
        has_img = "有图" if any(
            (v or "").strip()
            for v in (e.reference_front, e.ref_image, e.reference_side, e.reference_back)
        ) else "无图"
        hint = (e.prompt_hint or e.description or "").strip()
        lines.append(
            f"- {e.name}(id={e.id},{kind_label.get(e.kind, e.kind)},{has_img})"
            + (f":{hint[:80]}" if hint else "")
        )
    return "主体库清单:\n" + "\n".join(lines), []


async def exec_check_jobs(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    user: User = ctx["user"]
    session = ctx["session"]

    raw_ids = args.get("job_ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        return "job_ids 为空,请传入 submit_generation 返回的 job_id 列表。", [
            _err_event("job_ids 为空")
        ]
    job_ids = [str(j) for j in raw_ids][:20]

    # 兼容 job_id 与 prompt_id 两种入参(hold 放行会换名,job_id 全程稳定);
    # 用户隔离:只查本人作业,他人 id 一律「不存在」不泄露。
    rows = session.exec(
        select(Job).where(
            Job.user_id == user.id,
            (Job.id.in_(job_ids)) | (Job.prompt_id.in_(job_ids)),  # type: ignore[attr-defined]
        )
    ).all()
    by_id = {j.id: j for j in rows}
    by_pid = {j.prompt_id: j for j in rows}

    lines: list[str] = []
    events: list[dict] = []
    for jid in job_ids:
        job = by_id.get(jid) or by_pid.get(jid)
        if job is None:
            lines.append(f"- {jid}:不存在(或不属于当前用户)")
            continue
        results = json.loads(job.result) if job.result else []
        line = f"- {job.id} [{job.kind}]:{job.status}"
        if job.status == "held" and job.hold_reason:
            line += f"(排队原因:{job.hold_reason})"
        if job.status == "done":
            line += f",产物 {len(results)} 个已展示给用户"
            events.append(_job_event(
                job_id=job.id, kind=job.kind, status="done",
                label=job.kind, results=results,
            ))
        elif job.status == "error":
            line += f"({job.hold_reason or '执行失败'})"
        lines.append(line)
    return "作业状态:\n" + "\n".join(lines), events


async def exec_optimize_prompt(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import optimize as optimize_route

    user: User = ctx["user"]
    session = ctx["session"]

    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return "prompt 为空。", [_err_event("prompt 为空")]
    body = optimize_route.OptimizeRequest(
        prompt=prompt[:2000],
        kind=str(args.get("kind") or "image"),
        engine=args.get("engine") or None,
        model=args.get("model") or None,
    )
    try:
        # 复用路由端点函数(系统提示/方言/触发词/降级全同一事实源)
        resp = await optimize_route.optimize_prompt(body, user=user, session=session)
    except HTTPException as e:
        return f"提示词优化失败({e.status_code}):{e.detail}。可改用原始描述直接提交。", [
            _err_event("优化失败", str(e.detail))
        ]
    text = f"优化后提示词:\n{resp.optimized}"
    if resp.negative:
        text += f"\n负向提示词:\n{resp.negative}"
    text += "\n(提交生成时用上面的优化结果,不要再用原始描述。)"
    return text, []


async def exec_propose_plan(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    sess: AgentSession | None = ctx.get("agent_session")
    session = ctx["session"]

    title = str(args.get("title") or "").strip()[:120]
    body = str(args.get("body") or "").strip()[:4000]
    estimate = str(args.get("estimate") or "").strip()[:300]
    if not title or not body:
        return "提案标题与正文不能为空。", [_err_event("提案为空")]
    if sess is None:
        return "当前上下文不支持提案(非会话对话),请直接把方案讲给用户听。", [
            _err_event("无会话上下文")
        ]

    proposal = {
        "proposal_id": uuid.uuid4().hex[:12],
        "title": title,
        "body": body,
        "estimate": estimate,
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    sess.pending_proposal = json.dumps(proposal, ensure_ascii=False)
    session.add(sess)
    session.commit()

    event = {"type": "proposal", "data": {
        "proposal_id": proposal["proposal_id"],
        "title": title,
        "body": body,
        "estimate": estimate,
    }}
    return (
        f"方案已提交给用户确认(proposal_id={proposal['proposal_id']})。"
        "本轮到此结束:简要告诉用户方案要点,等其确认/修改/拒绝,不要自行开始执行。"
    ), [event]


# 可作为 adjust_3d 来源的 3D 作业 kind(产物含 .glb)
_3D_SOURCE_KINDS = ("hunyuan3d", "threed_material", "threed_texture")


def _find_3d_source_job(session, user: User, source_job_id: str | None) -> Job | None:
    """定位调整来源:指定 job_id 精确查(用户隔离),否则取最近一个 GLB 产物作业。"""
    if source_job_id:
        job = session.get(Job, source_job_id)
        if job is None or (
            user.role != "admin"
            and job.user_id != user.id
            and job.tenant_id != user.tenant_id
        ):
            return None
        return job
    rows = session.exec(
        select(Job)
        .where(
            Job.user_id == user.id,
            Job.status == "done",
            Job.result.like("%.glb%"),
        )
        .order_by(Job.created_at.desc())
        .limit(5)
    ).all()
    return rows[0] if rows else None


async def exec_adjust_3d(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    """3D 材质/渲染/纹理调整:同步委托 routes/threed_ops(/threed_texture),产物经 job 事件展示。"""
    from app.routes import threed_ops, threed_texture

    user: User = ctx["user"]
    session = ctx["session"]
    pool = ctx.get("pool")

    op = str(args.get("op") or "").strip()
    if op not in ("render", "material", "texture"):
        return "op 须为 render(材质预设渲染)/ material(材质改写)/ texture(生成纹理贴图)。", [
            _err_event("op 参数不合法", op)
        ]

    source_job_id = str(args.get("source_job_id") or "").strip() or None
    job = _find_3d_source_job(session, user, source_job_id)
    if job is None:
        if source_job_id:
            return f"作业 {source_job_id} 不存在或不属于当前用户。", [
                _err_event("3D 来源作业不存在", source_job_id)
            ]
        return "没有找到可调整的 3D 产物。先用 generate_3d 生成一个 3D 模型,再让我调整。", [
            _err_event("无 3D 产物可调整")
        ]

    try:
        if op == "texture":
            tex_body: dict = {"job_id": job.id}
            if args.get("prompt"):
                tex_body["prompt"] = str(args["prompt"])[:500]
            req = threed_texture.ThreeDTextureRequest.model_validate(tex_body)
            result = await threed_texture.threed_texture(req, user, session, pool)
        else:
            req_body: dict = {"op": op, "job_id": job.id}
            if args.get("prompt"):
                req_body["prompt"] = str(args["prompt"])[:500]
            for key in ("material", "lighting", "background", "format", "out", "base_color"):
                if args.get(key):
                    req_body[key] = str(args[key])
            for key in ("azimuth", "metallic", "roughness"):
                if args.get(key) is not None:
                    try:
                        req_body[key] = float(args[key])
                    except (TypeError, ValueError):
                        pass
            req = threed_ops.ThreeDOpsRequest.model_validate(req_body)
            result = await threed_ops.threed_ops(req, user, session, pool)
    except HTTPException as e:
        return f"3D 调整失败({e.status_code}):{e.detail}", [
            _err_event("3D 调整失败", str(e.detail))
        ]
    except ValidationError as e:
        first = (e.errors() or [{}])[0]
        return f"3D 调整参数不合法:{first.get('msg', e)}", [_err_event("参数不合法", str(e))]

    url = result["url"]
    render_labels = {"glb": "3D 材质模型", "mp4": "3D 旋转视频", "png": "3D 渲染快照"}
    label = req.prompt or (
        "3D 纹理模型"
        if op == "texture"
        else render_labels.get(str(result["format"]), "3D 渲染")
        if op == "render"
        else "3D 材质调整"
    )
    event = _job_event(
        job_id=str(result.get("job_id") or ""),
        kind=result["kind"], status="done", label=label, results=[url],
    )
    text = (
        f"3D 调整完成(产物已展示给用户并进作品库):{label}。"
        "如需继续调整(换材质/出旋转视频/染色/重新生成纹理),直接说即可。"
    )
    return text, [event]


# ---------------------------------------------------------------------------
# W3 UI 驱动工具(2026-08-31):助手驱动前端界面——跳转/预填/开产物
# 事件一律走 msg 包络(不进 _STREAM_EVENT_NAMES),前端 AssistantView 识别
# type="ui_action" 并执行。零服务端副作用(open_asset 只做归属校验)。
# ---------------------------------------------------------------------------

# 前端可跳转视图白名单(与 page.tsx VALID_VIEWS 对齐;observability/admin 排除——门控页)
_UI_VIEWS = {
    "home", "image", "video", "audio", "fusion", "imageEdit", "videoEdit",
    "animatic", "avatartalk", "canvas", "studio", "dub", "library",
    "entities", "resources", "market", "settings",
}


def _ui_action(action: str, **fields) -> dict:
    return {"type": "ui_action", "action": action, **fields}


async def exec_navigate_view(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    view = str(args.get("view") or "").strip()
    reason = str(args.get("reason") or "").strip()[:200]
    if view not in _UI_VIEWS:
        return f"目标页面不存在:{view}(可用:{', '.join(sorted(_UI_VIEWS))})。", [
            _err_event("页面不存在", view)
        ]
    text = f"已为你打开目标页面。" + (f"({reason})" if reason else "")
    return text, [_ui_action("navigate_view", view=view, reason=reason)]


async def exec_prefill_generate(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    kind = str(args.get("kind") or "").strip()
    prompt = str(args.get("prompt") or "").strip()[:4000]
    if kind not in ("image", "video"):
        return "kind 仅支持 image|video。", [_err_event("kind 不合法", kind)]
    if not prompt:
        return "预填提示词不能为空。", [_err_event("提示词为空")]
    return f"已把提示词填入{'图片' if kind == 'image' else '视频'}工作台,可微调后提交。", [
        _ui_action("prefill_generate", kind=kind, prompt=prompt)
    ]


async def exec_open_asset(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    session = ctx["session"]
    user: User = ctx["user"]
    job_id = str(args.get("job_id") or "").strip()
    if not job_id:
        return "job_id 不能为空。", [_err_event("缺 job_id")]
    job = session.get(Job, job_id)
    if job is None or (
        user.role != "admin"
        and job.user_id != user.id
        and job.tenant_id != user.tenant_id
    ):
        return "未找到该作品(或不属于当前账号)。", [_err_event("作品不存在", job_id)]
    return f"已在作品库定位该作品({job.kind or '产物'})。", [
        _ui_action("open_asset", job_id=job.id, kind=job.kind or "")
    ]
