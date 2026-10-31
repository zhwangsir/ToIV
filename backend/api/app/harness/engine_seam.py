"""引擎注册缝(ctx.engines):EnginePlugin 把 engine_registry 的 20 条引擎
条目在 bootstrap 时填充到运行时注册表,并注册 profile 停用集。

- Definition:引擎注册表(app.services.engine_registry._REGISTRY)是唯一事实源;
- Provider:EnginePlugin — bootstrap 时调 populate_registry() 填充,并按 profile
  传入的停用集调 set_disabled_engines();
- Consumer:routes/models.py 的 GET /api/models/engines 经 list_engines 读取。

🔒 兼容性铁律:list_engines 输出形状必须字节级不变(/api/models/engines 是前端
动态渲染事实源);新增的 submit 绑定字段仅追加,不改既有字段形状。
"""
from __future__ import annotations

from app.harness.context import HarnessContext


class EnginePlugin:
    """把引擎注册表注册为 harness 服务。可注入停用集(profile 裁剪)。"""

    name = "engine-seam"

    def __init__(self, disabled_engines: set[str] | None = None) -> None:
        self._disabled = disabled_engines or set()

    def activate(self, ctx: HarnessContext) -> None:
        from app.services.engine_registry import populate_registry

        populate_registry(disabled=self._disabled if self._disabled else None)
        # 注册自身为服务,供 profile 自省(engines_disabled 清单)
        ctx.register_service("engines", self)

    @property
    def disabled_engines(self) -> set[str]:
        return set(self._disabled)
