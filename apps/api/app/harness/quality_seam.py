"""质量门插件:把 quality/decision.py 的 advisory 评估接入 harness 事件总线。

orchestrator.render_shot 在图像渲染完成点 emit `quality/advisory` 事件
(payload={image_url, prompt, shot_id}),本插件订阅并执行 evaluate_image。
失败降级直通语义不变(打分器不可用/异常一律忽略,不阻塞主流程)。

manju 的阻断式 run_quality_checks 不动:同步阻断语义无法事件化
(需要立即返回 422 阻断响应,事件总线是 fire-and-forget)。
"""
from __future__ import annotations

import logging

from app.harness import events as ev
from app.harness.context import HarnessContext

logger = logging.getLogger(__name__)


class QualityPlugin:
    """把质量门 advisory 评估挂到 harness 事件总线。"""

    name = "quality-seam"

    def activate(self, ctx: HarnessContext) -> None:
        ctx.on_dispose(ctx.events.on(ev.QUALITY_ADVISORY, self._on_advisory))
        ctx.register_service("quality", self)

    async def _on_advisory(self, payload: dict) -> None:
        """质量门 advisory:打分→三态决策,只记日志不阻断。"""
        from app.quality import decision as quality_decision

        image_url = payload.get("image_url", "")
        prompt = payload.get("prompt")
        shot_id = payload.get("shot_id", "")
        try:
            gate = await quality_decision.evaluate_image(image_url, prompt)
            if gate.decision is not quality_decision.QualityDecision.PASS:
                logger.info(
                    "render_shot 质量门:shot=%s decision=%s score=%s critique=%s",
                    shot_id,
                    gate.decision.value,
                    gate.score,
                    gate.critique,
                )
        except Exception:
            logger.debug(
                "render_shot 质量门异常(降级忽略):shot=%s", shot_id, exc_info=True
            )
