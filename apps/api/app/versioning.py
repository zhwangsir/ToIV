"""产物版本树辅助:生成请求 → 参数快照(JSON)。

快照存进 Job.params,记录建档时的完整请求(含实际 seed / 解析后的底模),
使任意产物可被精确重生(rerun)、锁 seed 微调或从任意版本分支。
"""
from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel


def params_snapshot(req: BaseModel, **extra: Any) -> str:
    """请求模型 → JSON 快照;extra 用实际值覆盖(如 seed=实际使用的种子)。"""
    data = req.model_dump()
    for key, value in extra.items():
        if value is not None:
            data[key] = value
    return json.dumps(data, ensure_ascii=False)
