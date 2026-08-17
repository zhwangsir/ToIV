"""小说 → 结构化分镜 JSON。

入口:
    asyncio.run(novel_to_storyboard(novel_text, max_shots=20))

默认直接访问 spark02 vLLM (:8000)；当在 apps/api 上下文运行时，
可经 TOIV_USE_APP_LLM=1 切换到 app.workflows.llm_router + app.agent.llm。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

# drama/scripts 与 apps/api 不在同包，按需把项目根加入路径以复用 app 代码
_TOIV_ROOT = Path(__file__).resolve().parents[2]
if str(_TOIV_ROOT) not in sys.path:
    sys.path.insert(0, str(_TOIV_ROOT))

from storyboard_schema import Storyboard  # noqa: E402

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 默认端点与可调参数
# ---------------------------------------------------------------------------
DEFAULT_LLM_BASE_URL = os.environ.get(
    "TOIV_LLM_BASE_URL", "http://192.168.71.84:8000/v1"
)
DEFAULT_LLM_MODEL = os.environ.get("TOIV_LLM_MODEL", "qwen3.6-uncensored")
DEFAULT_LLM_API_KEY = os.environ.get("TOIV_LLM_API_KEY", "lm-studio")
DEFAULT_TEMPERATURE = 0.5
DEFAULT_MAX_TOKENS = 8192
DEFAULT_CHUNK_SIZE = 2000
DEFAULT_CHUNK_OVERLAP = 200
DEFAULT_READ_TIMEOUT = 300.0

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"


# ---------------------------------------------------------------------------
# Prompt 工程
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT = """你是一位专业的 AI 短剧分镜导演。请将用户提供的小说片段转换为结构化的分镜 JSON。

要求：
1. 只输出合法 JSON，不要任何 markdown 代码块标记、解释或注释。
2. JSON 必须严格符合下面 schema，字段名不得改动或遗漏。
3. `prompt` 和 `motion_prompt` 必须是英文，适合直接输入给文生视频模型。
4. `description` 和 `dialogue.text` / `narration.text` 保持中文。
5. 根据小说情节合理划分幕（act）和镜头，每个镜头 3–10 秒。
6. 角色需在 `characters` 中完整定义，包括外貌描述和音色标签。
7. `narration` 时间轴需覆盖全片，start/end 为秒级时间戳，与 shots 总时长大致对齐。

JSON schema：
{
  "title": "短剧标题",
  "characters": [
    {"name": "角色名", "description": "外貌/性格/背景", "voice_tag": "音色标签", "is_narrator": false}
  ],
  "shots": [
    {
      "id": "s1_1",
      "act": 1,
      "duration": 5,
      "type": "scene",
      "description": "镜头中文描述",
      "prompt": "English visual prompt for video generation",
      "motion_prompt": "English camera movement / motion description",
      "characters": ["角色名"],
      "dialogue": {"speaker": "角色名", "text": "对白内容"},
      "negative": "blurry, low quality, text, watermark, deformed"
    }
  ],
  "narration": [
    {"start": 0, "end": 5, "speaker": "narrator", "text": "旁白文本"}
  ]
}
"""

_FEW_SHOT_EXAMPLE = """示例输入（小说片段）：
“夜色如墨，少年林凡背着药篓走在回家的山路上。忽然，一道流星划破天际，坠落在不远处的山谷中。林凡心中一惊，急忙赶了过去。山谷里，一块散发着幽蓝光芒的晶石静静躺在焦土之上。”

示例输出 JSON：
{
  "title": "陨落之星",
  "characters": [
    {
      "name": "林凡",
      "description": "年轻山村少年，黑发朴素衣衫，眼神坚毅好奇，背负药篓",
      "voice_tag": "youthful_male",
      "is_narrator": false
    },
    {
      "name": "旁白",
      "description": "沉稳叙事者",
      "voice_tag": "narrator",
      "is_narrator": true
    }
  ],
  "shots": [
    {
      "id": "s1_1",
      "act": 1,
      "duration": 5,
      "type": "scene",
      "description": "夜色山路，少年背着药篓独行",
      "prompt": "A young black-haired boy in simple clothes carrying a herb basket walks along a mountain path at night, dark ink-blue sky, cinematic wide shot, fantasy style",
      "motion_prompt": "slow tracking shot from behind, gentle moonlight flicker",
      "characters": ["林凡"],
      "dialogue": null,
      "negative": "blurry, low quality, text, watermark, deformed"
    },
    {
      "id": "s1_2",
      "act": 1,
      "duration": 4,
      "type": "action",
      "description": "流星划破夜空，坠入山谷",
      "prompt": "A bright shooting star tears across the dark night sky and crashes into a distant valley, sparks and dust explosion, epic fantasy atmosphere",
      "motion_prompt": "fast pan following the meteor impact, slight camera shake",
      "characters": [],
      "dialogue": null,
      "negative": "blurry, low quality, text, watermark, deformed"
    },
    {
      "id": "s1_3",
      "act": 1,
      "duration": 5,
      "type": "action",
      "description": "林凡震惊后奔向山谷",
      "prompt": "The young boy looks up in shock, then runs urgently toward the smoky valley, night forest, dynamic motion, fantasy style",
      "motion_prompt": "quick handheld follow shot through trees",
      "characters": ["林凡"],
      "dialogue": null,
      "negative": "blurry, low quality, text, watermark, deformed"
    },
    {
      "id": "s1_4",
      "act": 1,
      "duration": 6,
      "type": "scene",
      "description": "山谷焦土上，幽蓝晶石发光",
      "prompt": "A mysterious blue-glowing crystal lies on scorched earth in a valley at night, ethereal cyan light pulsing, smoke drifting, cinematic close-up",
      "motion_prompt": "slow push-in on the crystal, pulsing light",
      "characters": [],
      "dialogue": null,
      "negative": "blurry, low quality, text, watermark, deformed"
    }
  ],
  "narration": [
    {"start": 0, "end": 5, "speaker": "旁白", "text": "夜色如墨，少年林凡背着药篓走在回家的山路上。"},
    {"start": 5, "end": 9, "speaker": "旁白", "text": "忽然，一道流星划破天际，坠落在不远处的山谷中。"},
    {"start": 9, "end": 14, "speaker": "旁白", "text": "林凡心中一惊，急忙赶了过去。山谷里，一块散发着幽蓝光芒的晶石静静躺在焦土之上。"}
  ]
}
"""


def _build_user_prompt(novel_text: str, max_shots: int, chunk_index: int, total_chunks: int) -> str:
    ctx = ""
    if total_chunks > 1:
        ctx = f"这是小说第 {chunk_index + 1}/{total_chunks} 段，请结合上下文理解，并为本段产出独立的分镜。"
    return (
        f"{ctx}\n"
        f"请将以下小说转换为分镜 JSON，最多 {max_shots} 个镜头。\n\n"
        f"小说内容：\n{novel_text}\n\n"
        "要求：只输出合法 JSON，不要 markdown 代码块。"
    )


def _extract_json(raw: str) -> dict:
    """从 LLM 输出中提取 JSON；兼容 markdown 代码块与纯文本。"""
    raw = raw.strip()
    # 优先匹配 ```json ... ```
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if m:
        return json.loads(m.group(1))
    # 再尝试从第一个 { 到最后一个 }
    m = re.search(r"(\{.*\})", raw, re.DOTALL)
    if m:
        return json.loads(m.group(1))
    raise ValueError("LLM 输出中未找到合法 JSON")


def _chunk_text(text: str, chunk_size: int = DEFAULT_CHUNK_SIZE, overlap: int = DEFAULT_CHUNK_OVERLAP) -> list[str]:
    """按字符数分段，保留 overlap 上下文。"""
    if not text:
        return []
    if len(text) <= chunk_size:
        return [text]

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        if end >= len(text):
            chunks.append(text[start:])
            break
        # 尽量在句号/换行处截断
        cut = text.rfind("。", end - chunk_size // 4, end)
        if cut == -1:
            cut = text.rfind("\n", end - chunk_size // 4, end)
        if cut == -1:
            cut = end
        chunks.append(text[start:cut + 1])
        start = max(start + 1, cut + 1 - overlap)
    return chunks


async def _call_llm_http(
    messages: list[dict[str, Any]],
    *,
    base_url: str = DEFAULT_LLM_BASE_URL,
    model: str = DEFAULT_LLM_MODEL,
    api_key: str = DEFAULT_LLM_API_KEY,
    temperature: float = DEFAULT_TEMPERATURE,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    read_timeout: float = DEFAULT_READ_TIMEOUT,
) -> dict:
    """通过 httpx 直接调用 OpenAI 兼容 LLM。"""
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    timeout = httpx.Timeout(read_timeout, connect=8.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{base_url.rstrip('/')}/chat/completions",
            json=payload,
            headers=headers,
        )
        resp.raise_for_status()
        body = resp.json()
        return body["choices"][0]["message"]


async def _call_llm_app(
    messages: list[dict[str, Any]],
    *,
    layer: str = "L2",
    temperature: float = DEFAULT_TEMPERATURE,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> dict:
    """复用 apps/api 的 LLM 路由（需在同 Python 路径下运行）。"""
    from app.workflows.llm_router import ContentType, route_llm
    from app.agent.llm import chat_layered

    ep = route_llm(ContentType.STORYBOARD)
    logger.info("使用 app LLM 层: %s @ %s", ep.model_id, ep.base_url)
    return await chat_layered(
        messages,
        layer=layer,
        temperature=temperature,
        max_tokens=max_tokens,
    )


async def _generate_chunk(
    chunk: str,
    *,
    max_shots: int,
    chunk_index: int,
    total_chunks: int,
    use_app_llm: bool = False,
) -> dict:
    """对单段文本调用 LLM，返回解析后的 JSON dict。"""
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": _FEW_SHOT_EXAMPLE},
        {"role": "user", "content": _build_user_prompt(chunk, max_shots, chunk_index, total_chunks)},
    ]

    if use_app_llm:
        msg = await _call_llm_app(messages)
    else:
        msg = await _call_llm_http(messages)

    content = msg.get("content", "")
    if not content:
        raise RuntimeError("LLM 返回空 content")
    return _extract_json(content)


def _merge_chunk_outputs(chunks: list[dict], max_shots: int) -> dict:
    """合并多段分镜输出，重新编号并截断到 max_shots。"""
    title = chunks[0].get("title", "Untitled Drama")
    characters: dict[str, dict] = {}
    shots: list[dict] = []
    narration: list[dict] = []
    time_offset = 0.0

    for chunk in chunks:
        # 合并角色（按 name 去重）
        for c in chunk.get("characters", []) or []:
            name = c.get("name")
            if name and name not in characters:
                characters[name] = c

        # 合并镜头，并累加时间偏移
        chunk_shots = chunk.get("shots", []) or []
        chunk_duration = 0.0
        for shot in chunk_shots:
            shot = dict(shot)
            shot["start"] = time_offset
            dur = float(shot.get("duration", 5))
            shot["end"] = time_offset + dur
            shots.append(shot)
            time_offset += dur
            chunk_duration += dur

        # 合并 narration 时间轴（按本段镜头总时长做整体偏移）
        for cue in chunk.get("narration", []) or []:
            cue = dict(cue)
            cue_start = float(cue.get("start", 0))
            cue_end = float(cue.get("end", chunk_duration))
            cue["start"] = cue_start + time_offset - chunk_duration
            cue["end"] = cue_end + time_offset - chunk_duration
            narration.append(cue)

    # 截断到 max_shots，并重新分配 id / act
    shots = shots[:max_shots]
    current_act = 1
    shot_in_act = 0
    for shot in shots:
        shot_in_act += 1
        shot["id"] = f"s{current_act}_{shot_in_act}"
        shot["act"] = current_act
        # 简单启发：每 4 镜自动进下一幕
        if shot_in_act >= 4:
            current_act += 1
            shot_in_act = 0

    # narration 也截断到与 shots 总时长对齐
    total_duration = sum(float(s.get("duration", 5)) for s in shots)
    narration = [n for n in narration if float(n.get("start", 0)) < total_duration]

    return {
        "title": title,
        "characters": list(characters.values()),
        "shots": shots,
        "narration": narration,
    }


def save_storyboard(data: dict, output_dir: Path | None = None) -> tuple[Path, Path]:
    """保存分镜 JSON 到带时间戳文件，并更新 storyboard_latest.json 软链接/副本。"""
    out_dir = output_dir or OUTPUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    timestamped = out_dir / f"storyboard_{ts}.json"
    latest = out_dir / "storyboard_latest.json"

    storyboard = Storyboard.from_dict(data)
    storyboard.to_json_file(timestamped)
    storyboard.to_json_file(latest)
    logger.info("分镜已保存: %s", timestamped)
    return timestamped, latest


async def novel_to_storyboard(
    novel_text: str,
    *,
    max_shots: int = 20,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
    use_app_llm: bool = False,
    save: bool = True,
    output_dir: Path | None = None,
) -> dict:
    """将小说文本转换为结构化分镜 JSON。

    Args:
        novel_text: 小说原始文本。
        max_shots: 最大镜头数。
        chunk_size: 每段最大字符数。
        chunk_overlap: 分段间重叠字符数。
        use_app_llm: 是否复用 apps/api 的 LLM 路由（默认直接 httpx 访问 spark02）。
        save: 是否保存到 drama/output/。
        output_dir: 自定义输出目录。

    Returns:
        符合 Storyboard schema 的 dict。
    """
    chunks = _chunk_text(novel_text, chunk_size=chunk_size, overlap=chunk_overlap)
    if not chunks:
        raise ValueError("novel_text is empty")

    per_chunk_shots = max(1, max_shots // len(chunks)) if chunks else max_shots

    results: list[dict] = []
    for i, chunk in enumerate(chunks):
        logger.info("处理小说分段 %d/%d, 长度=%d", i + 1, len(chunks), len(chunk))
        result = await _generate_chunk(
            chunk,
            max_shots=per_chunk_shots,
            chunk_index=i,
            total_chunks=len(chunks),
            use_app_llm=use_app_llm,
        )
        results.append(result)

    merged = _merge_chunk_outputs(results, max_shots=max_shots)

    # 用 Pydantic 做最终校验与默认值填充
    storyboard = Storyboard.from_dict(merged)
    data = storyboard.model_dump(mode="json")

    if save:
        save_storyboard(data, output_dir=output_dir)
    return data


def novel_to_storyboard_sync(
    novel_text: str,
    *,
    max_shots: int = 20,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
    use_app_llm: bool = False,
    save: bool = True,
    output_dir: Path | None = None,
) -> dict:
    """novel_to_storyboard 的同步包装。"""
    return asyncio.run(
        novel_to_storyboard(
            novel_text,
            max_shots=max_shots,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            use_app_llm=use_app_llm,
            save=save,
            output_dir=output_dir,
        )
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _demo_novel() -> str:
    return (
        "夜色如墨，少年林凡背着药篓走在回家的山路上。忽然，一道流星划破天际，"
        "坠落在不远处的山谷中。林凡心中一惊，急忙赶了过去。山谷里，一块散发着"
        "幽蓝光芒的晶石静静躺在焦土之上。他小心翼翼地伸出手，指尖刚触到晶石表面，"
        "一道刺目的蓝光便将他整个人吞没。等光芒散去，林凡发现自己脑海中多了一部"
        "名为《星辰诀》的修炼功法。"
    )


async def _main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    use_app = os.environ.get("TOIV_USE_APP_LLM", "0") == "1"
    text = os.environ.get("TOIV_NOVEL_TEXT") or _demo_novel()
    result = await novel_to_storyboard(text, max_shots=12, use_app_llm=use_app)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(_main())
