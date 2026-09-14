"""应用用途分类(use_case)LLM 打标(市场策展层,2026-09-12)。

照 services/app_guide_gen 的范本:system prompt 契约 + _extract_json(容忍
```json 围栏)+ 枚举校验 + LLMError 上抛(路由侧统一 503)。

输入组装:App 元信息(name/description/category/output_kind)
+ 该 app 已发布/草稿说明卡的 purpose/when_to_use(有则喂,没有就跳过)。

产出契约:严格 JSON {"use_case": "<id>"},id 必须命中 services/use_cases 的
12 类枚举;不命中枚举时回退 "other"(fallback=True,不视为 LLM 故障),
JSON 解析失败才抛 LLMError(路由侧 503)。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session

from app.agent.llm import LLMError, chat
from app.models import App, AppGuide
from app.services.app_packager import _extract_json
from app.services.use_cases import USE_CASE_IDS, USE_CASES

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = """你是 AI 应用商店的应用分类专家。根据给定应用的信息,从下面的用途分类枚举中选择**唯一一个**最贴切的分类,输出**唯一一个 JSON 对象**,不要输出任何其他文字(不要用 ``` 围栏)。

用途分类枚举:
""" + "\n".join(f'- "{uc}": {label}' for uc, label in USE_CASES) + """

各类边界（严格遵守）:
- "motion" 仅限**动作/姿态/舞蹈迁移**类:把参考视频的动作套到另一个主体上(动作迁移、姿态驱动、舞蹈复刻)。通用的图生视频、首尾帧过渡、参考图续写**不算** motion。
- "drama" 仅限有**剧情/对白/人物演绎/叙事**要素的短剧、故事视频;普通文生/图生视频没有剧情要素时不选 drama。
- "face" 仅限换脸、人脸特征保留(IPAdapter FaceID 类)、把人物替换进已有视频。
- "avatar" 仅限数字人、对口型(唇形同步)、口播、让照片开口说话。
- "anime" 仅限明确动漫/二次元风格;含真人的不选。
- "ad" 仅限明确面向广告/营销/产品宣传的应用。
- "photo" 仅限写实摄影、写真、真人模特套图。
- "art" 用于通用文生图、艺术创作、插画、风格化图片。
- "edit" 用于图片编辑、局部重绘、修复、扩图、多视角生成。
- "fashion" 用于换装、穿搭、服装展示。
- "ecommerce" 用于电商产品图(非服装类:商品场景图、产品海报)。
- 通用文生视频/图生视频/全能参考类,没有上述明确特征的一律 "other"。

输出 JSON 结构:
{"use_case": "<上面枚举中的一个 id>"}

铁律:
1. use_case 必须严格等于枚举中的某个 id,不得自造新值。
2. 按用户的**使用意图**分类,不是按产物形态(图片/视频)分类。
3. 拿不准、跨多个意图、或信息不足时,选 "other"。"""


def build_messages(app: App, guide: AppGuide | None) -> list[dict]:
    """组 LLM 消息:system(契约+枚举)+ user(应用元信息 + 说明卡摘要)。"""
    info: dict[str, Any] = {
        "name": app.name,
        "description": app.description or "",
        "category": app.category,
        "output_kind": app.output_kind,
    }
    if guide is not None:
        if guide.purpose:
            info["guide_purpose"] = guide.purpose
        if guide.when_to_use:
            info["guide_when_to_use"] = guide.when_to_use
    user = "应用信息:\n" + json.dumps(info, ensure_ascii=False) + "\n\n请输出分类 JSON。"
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


async def classify_use_case(session: Session, app: App) -> tuple[str, bool]:
    """LLM 判定应用用途分类。

    Returns:
        (use_case, fallback):use_case 恒为枚举内 id;LLM 产出不在枚举时
        回退 "other" 且 fallback=True。

    Raises:
        LLMError: LLM 不可用/超时/产出非 JSON(路由侧统一 503)。
    """
    guide = session.get(AppGuide, app.id)
    messages = build_messages(app, guide)
    try:
        msg = await chat(messages, max_tokens=64, temperature=0.0,
                         enable_thinking=False)
    except LLMError:
        raise
    except Exception as e:  # 超时/连接等非 LLMError 形态统一收敛
        raise LLMError(f"用途分类 LLM 调用失败: {e!r}") from e
    data = _extract_json(str(msg.get("content") or ""))
    use_case = str(data.get("use_case") or "").strip()
    if use_case in USE_CASE_IDS:
        return use_case, False
    logger.warning("用途分类产出 %r 不在枚举,回退 other(app=%s)", use_case, app.id)
    return "other", True


def save_use_case(session: Session, app_id: str, use_case: str) -> App:
    """写 App.use_case + updated_at;app 不存在抛 KeyError(路由侧 404)。"""
    a = session.get(App, app_id)
    if not a:
        raise KeyError(app_id)
    a.use_case = use_case
    a.updated_at = datetime.now(timezone.utc)
    session.add(a)
    session.commit()
    session.refresh(a)
    return a
