"""图片 → VLM 解析 → 短剧分镜拆解服务。

「上传图片 → VLM 解析 → 自动建短剧项目+分镜」管线的 VLM 解析环节:
把 1+ 张参考/分镜图发给 workstation 上的 Nemotron 全模态 VLM(OpenAI 兼容,
已实测支持 data:image/...;base64 内联多模态输入),引导它:
  a) 分析图片内容(场景/角色/氛围/画风)
  b) 扩写成一部完整短剧
  c) 只输出 JSON {title, premise, script, shots:[...]}
供 drama_studio 的 from-image 端点消费。

容错策略(与 storyboard 端点一致):任何失败(网络/非 200/空内容/JSON 解析/
无有效分镜)一律抛 502,不静默降级 —— 建项目是用户显式动作,失败必须显式反馈。
例外:VLM 输出字段级校验全部判坏时,降 temperature + 追加修正指令重试一次,
重试仍全坏抛 422(输入图片与约束不匹配,需用户调整,见 validate_storyboard_shots)。
"""
from __future__ import annotations

import base64
import logging
import re

import httpx
from fastapi import HTTPException, Request

from app.config import get_settings
from app.jsonutil import parse_json_obj
from app.request_cancel import ClientAborted, abort_http_exception, await_or_disconnect

logger = logging.getLogger(__name__)

# VLM 调用超时:Nemotron omni 多图推理 + 长 JSON 输出,180s 与 TTS 超时同档
_VLM_TIMEOUT = 180.0


# ===========================================================================
# 图片分镜拆解系统提示(短剧导演版;字段语义与 drama_studio._STORYBOARD_SYSTEM 对齐)
# ===========================================================================
_IMAGE_STORYBOARD_SYSTEM = (
    "你是 AI 短剧导演 + 分镜师。用户会给你 1 张或多张参考图/分镜图。\n"
    "你要做的三件事:\n"
    "1. 分析图片内容:场景、角色、情绪氛围、画风;\n"
    "2. 以图片为视觉起点,扩写成一部完整、连贯的短剧;\n"
    "3. 按用户要求的镜头数拆解成影视分镜脚本。\n"
    "\n"
    "【视频提示词铁律 —— 直接决定 LTX 视频生成画面质量】\n"
    "1. 每个镜头只表现【一个清晰的瞬间、一个主体焦点】。**绝对禁止** montage / "
    "蒙太奇 / 拼贴 / 分屏 / split screen / collage / multiple scenes。单镜头画不下。\n"
    "2. 多人物场景只聚焦 1-2 个主要角色的单一动作(例:与其写 'A打B、C逃跑',"
    "只写 'A一拳挥向B')。\n"
    "3. prompt 必须是【英文影视描述】,逗号分隔的关键词为主,适配 LTX 视频模型:"
    "`主体(1boy/1girl/2boys 等) + 外貌服装 + 单一动作 + 表情 + 场景地点 + 光影氛围 + "
    "画质标签(cinematic, masterpiece, 8k, highly detailed, film grain)`。\n"
    "4. **禁用**会被误解成拼贴的词:dynamic angles、fight montage、multiple、several、"
    "various、collage、abstract。构图用单一明确的:close-up / medium shot / wide shot / "
    "from side / low angle / overhead shot 之一。\n"
    "5. 角色出场时用其固定外貌特征(发色/瞳色/服装)保持跨镜一致,且与图片中的形象对齐。\n"
    "6. 视频时长建议 4-8 秒(整数),动作戏可适当延长。\n"
    "\n"
    "只输出一个 JSON 对象,不要解释,不要代码块标记,形如:\n"
    '{"title":"短剧标题","premise":"一句话故事概要",'
    '"script":"完整剧本文本",'
    '"shots":[{"scene":"该镜的场景/情绪简述(中文)",'
    '"prompt":"1boy, ...(英文视频提示词,单主体单动作)",'
    '"characters":["出场角色名"],'
    '"dialogue":"该镜中文台词或旁白(没有则空字符串)",'
    '"speaker":"说话人(角色名 / narrator / 空=无对白)",'
    '"duration_sec":6}]}'
)


# ===========================================================================
# JSON 提取(共用实现 app.jsonutil.parse_json_obj,锚定 "shots" 键做平衡括号匹配)
# ===========================================================================
_SHOTS_ANCHORS = ('{"shots"', "{'shots'", '"shots"')


def _parse_json_obj(text: str) -> dict | None:
    return parse_json_obj(text, anchors=_SHOTS_ANCHORS)


def _build_user_text(hint: str, style: str, num_shots: int, num_images: int) -> str:
    """组装 user 文本:故事方向(可选) + 风格 + 镜头数 + 图片数量。"""
    lines = [f"参考图数量:{num_images}", f"镜头数量:{num_shots}(严格等于)"]
    if style:
        lines.append(f"整体风格:{style}")
    if hint.strip():
        lines.append(f"用户故事方向:{hint.strip()}")
    lines.append("请先分析图片内容,再扩写成完整短剧并拆解分镜,只输出 JSON。")
    return "\n".join(lines)


# ===========================================================================
# VLM 输出字段级校验(coerce 兜底之前;坏 shot 剔除,告警交调用方记录)
# ===========================================================================
_DURATION_MIN, _DURATION_MAX = 2, 15  # 与 drama_studio._coerce_shot 钳制范围一致

# 明显多镜头标志词(LTX 提示词铁律静态复查):命中则剥离该句,记告警,不判坏
_MONTAGE_MARKERS = ("蒙太奇", "剪辑到", "画面切换", "montage", "cut to")

# 分句/子句切分:中英句号、叹问号、分号、换行、英文逗号
_CLAUSE_SPLIT_RE = re.compile(r"[。!?!;;\n]+|,\s*")


def _strip_montage_clauses(prompt: str) -> tuple[str, list[str]]:
    """剥离 prompt 中含多镜头标志词的句/子句,返回 (清洗后 prompt, 被剥离片段)。"""
    kept: list[str] = []
    stripped: list[str] = []
    for part in _CLAUSE_SPLIT_RE.split(prompt):
        seg = part.strip()
        if not seg:
            continue
        if any(m in seg.lower() or m in seg for m in _MONTAGE_MARKERS):
            stripped.append(seg)
        else:
            kept.append(seg)
    return ", ".join(kept), stripped


def validate_storyboard_shots(shots_raw: list) -> tuple[list[dict], list[str]]:
    """字段级校验 VLM 分镜:返回 (合格 shots, 告警列表)。

    规则:
      · 非对象 / prompt 缺失或非空字符串 → 判坏剔除;
      · prompt 含多镜头标志词 → 剥离该句记告警(剥离后为空才判坏);
      · duration_sec 必须数值(数字字符串可转),否则判坏;越界钳到 2-15 并记告警;
      · scene/dialogue/speaker 类型不符 → 删字段记告警(交由下游 coerce 兜底);
      · characters 非数组 → 删字段记告警。
    """
    good: list[dict] = []
    warnings: list[str] = []
    for i, raw in enumerate(shots_raw):
        if not isinstance(raw, dict):
            warnings.append(f"shot#{i}: 非对象,剔除")
            continue
        shot = dict(raw)

        prompt = raw.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            warnings.append(f"shot#{i}: prompt 缺失或为空,剔除")
            continue
        cleaned, stripped = _strip_montage_clauses(prompt.strip())
        if stripped:
            warnings.append(
                f"shot#{i}: 含多镜头标志词,剥离 {'; '.join(stripped)}"
            )
            if not cleaned:
                warnings.append(f"shot#{i}: prompt 剥离后为空,剔除")
                continue
            shot["prompt"] = cleaned

        dur = raw.get("duration_sec")
        if dur is not None:
            if isinstance(dur, bool):
                warnings.append(f"shot#{i}: duration_sec 类型错误({dur!r}),剔除")
                continue
            if isinstance(dur, str):
                try:
                    dur = float(dur.strip())
                except ValueError:
                    warnings.append(f"shot#{i}: duration_sec 非数值({dur!r}),剔除")
                    continue
            if not isinstance(dur, (int, float)):
                warnings.append(f"shot#{i}: duration_sec 类型错误({dur!r}),剔除")
                continue
            if dur < _DURATION_MIN or dur > _DURATION_MAX:
                clamped = max(_DURATION_MIN, min(dur, _DURATION_MAX))
                warnings.append(
                    f"shot#{i}: duration_sec {dur} 越界,钳制为 {clamped}"
                )
                dur = clamped
            shot["duration_sec"] = dur

        for key in ("scene", "dialogue", "speaker"):
            val = raw.get(key)
            if val is not None and not isinstance(val, str):
                warnings.append(f"shot#{i}: {key} 类型错误({val!r}),已忽略该字段")
                shot.pop(key, None)
        chars = raw.get("characters")
        if chars is not None and not isinstance(chars, list):
            warnings.append(f"shot#{i}: characters 非数组({chars!r}),已忽略该字段")
            shot.pop("characters", None)

        good.append(shot)
    return good, warnings


def _build_payload(
    images: list[tuple[bytes, str]], hint: str, style: str, num_shots: int
) -> dict:
    """构造 OpenAI 兼容多模态 chat/completions 请求体。

    images 为 (字节, MIME 如 "image/jpeg") 列表;每张图一个 image_url 内容块
    (data: URL 内联),文本块放最后。Nemotron 是思考型模型,按 llm.py 约定
    同时给顶层 enable_thinking 与 chat_template_kwargs 抑制 thinking。
    """
    content: list[dict] = [
        {
            "type": "image_url",
            "image_url": {
                "url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
            },
        }
        for data, mime in images
    ]
    content.append({
        "type": "text",
        "text": _build_user_text(hint, style, num_shots, len(images)),
    })
    return {
        "model": get_settings().vlm_model_id,
        "messages": [
            {"role": "system", "content": _IMAGE_STORYBOARD_SYSTEM},
            {"role": "user", "content": content},
        ],
        "max_tokens": 8192,
        "temperature": 0.5,
        # 思考型模型双通道抑制(见 app/agent/llm.py 注释):顶层 EXO 原生字段 +
        # chat_template_kwargs(vLLM/SGLang 风格),传了不生效也不会报错。
        "enable_thinking": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }


async def _request_vlm(payload: dict, headers: dict, request: Request | None = None) -> str:
    """调 VLM chat/completions 并取回文本内容;网络/非 200/空内容一律抛 502。"""
    settings = get_settings()
    endpoint = f"{settings.vlm_server_url.rstrip('/')}/v1/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=_VLM_TIMEOUT, trust_env=False) as client:
            resp = await await_or_disconnect(
                request, client.post(endpoint, json=payload, headers=headers)
            )
    except ClientAborted:
        raise abort_http_exception() from None
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"VLM 服务不可达:{e}") from e

    if resp.status_code != 200:
        logger.warning(
            "图片分镜 VLM 非 200: status=%d body=%s",
            resp.status_code, resp.text[:500],
        )
        raise HTTPException(
            status_code=502, detail=f"VLM 服务返回 {resp.status_code},请重试"
        )

    try:
        data = resp.json()
        raw = (data["choices"][0]["message"].get("content") or "").strip()
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise HTTPException(status_code=502, detail="VLM 返回格式异常") from e
    if not raw:
        raise HTTPException(status_code=502, detail="VLM 返回为空,请重试")
    return raw


def _parse_and_validate(raw: str) -> tuple[dict | None, list, list[str]]:
    """解析 + 字段级校验一次 VLM 响应,返回 (obj, 合格 shots, 告警)。"""
    obj = _parse_json_obj(raw)
    shots_raw = obj.get("shots") if obj else None
    if not isinstance(shots_raw, list) or not shots_raw:
        return obj, [], []
    good, warnings = validate_storyboard_shots(shots_raw)
    return obj, good, warnings


# 全坏重试时追加的修正指令(同时降 temperature 收敛输出)
_RETRY_FIX_HINT = (
    "\n【修正要求】上次输出的分镜全部未通过校验(prompt 为空或字段类型错误)。"
    "请严格按 JSON schema 重新输出:每个 shot 必须有非空英文 prompt、"
    "数值型 duration_sec(2-15)、字符串 scene/dialogue/speaker、数组 characters。"
)


async def analyze_storyboard_images(
    images: list[tuple[bytes, str]], hint: str, style: str, num_shots: int,
    request: Request | None = None,
) -> dict:
    """把参考图发给 VLM 解析并扩写为短剧 JSON,返回 {title, premise, script, shots, warnings}。

    字段级校验:坏 shot(prompt 空/字段类型错)剔除,告警进 warnings;
    全部判坏时降 temperature + 追加修正指令重试一次,重试仍全坏抛 422。
    其余失败(网络/非 200/空内容/JSON 解析失败/无有效分镜)一律抛 HTTPException(502)。
    """
    settings = get_settings()
    payload = _build_payload(images, hint, style, num_shots)
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}

    raw = await _request_vlm(payload, headers, request=request)
    obj, shots, warnings = _parse_and_validate(raw)
    if obj is None or not (obj.get("shots") if obj else None):
        logger.warning(
            "图片分镜解析失败: raw_length=%d raw_preview=%s",
            len(raw), raw[:800].replace("\n", " "),
        )
        raise HTTPException(status_code=502, detail="图片解析失败,请重试")

    if not shots:
        # 全坏:降 temperature + 追加修正指令重试一次(浅拷贝,图片字节不复制)
        logger.warning("图片分镜全部校验失败,降 temperature 重试一次: %s", warnings)
        retry = dict(payload)
        retry["temperature"] = 0.2
        retry_messages = [dict(m) for m in payload["messages"]]
        user_content = list(retry_messages[1]["content"])
        text_block = dict(user_content[-1])
        text_block["text"] = text_block["text"] + _RETRY_FIX_HINT
        user_content[-1] = text_block
        retry_messages[1]["content"] = user_content
        retry["messages"] = retry_messages

        raw = await _request_vlm(retry, headers, request=request)
        obj, shots, retry_warnings = _parse_and_validate(raw)
        warnings = warnings + retry_warnings
        if not shots:
            logger.warning(
                "图片分镜重试仍全部校验失败: raw_preview=%s warnings=%s",
                raw[:800].replace("\n", " "), warnings,
            )
            raise HTTPException(
                status_code=422, detail="图片解析结果全部不合规,请调整参考图后重试"
            )

    # 字段规整:缺省回退,保证调用方拿到稳定结构
    return {
        "title": str(obj.get("title") or "").strip() or "未命名短剧",
        "premise": str(obj.get("premise") or "").strip(),
        "script": str(obj.get("script") or "").strip(),
        "shots": shots,
        "warnings": warnings,
    }
