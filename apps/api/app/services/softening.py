"""普通模式误触软化入口 —— 成人路径物理跳过。

当前无实际改写管线;本模块提供唯一入口闸,后续软化逻辑必须经 `maybe_soften`。
成人账号 / 未成年 / 匿名 → 原样返回,绝不进入 soften 实现。
"""
from __future__ import annotations

from typing import Any

from app.models import User
from app.redline import should_apply_softening


def maybe_soften_prompt(prompt: str, user: User | None, **_: Any) -> str:
    """仅普通模式可进入软化;成人路径物理跳过(直接返回原文)。"""
    if not should_apply_softening(user):
        return prompt
    # 占位:普通误触时的软化实现尚未落地;入口闸已确保成人不进入。
    return prompt
