"""Actor stubs for Ray control plane.

Importable without the ``ray`` package. Registry projection omitted from this
narrow JR-R1…R5 tip merge (no Wave B / H3 live pool).
"""

from __future__ import annotations

from ..fake_redis import FakeRedis
from .comfy_pool import ComfyPoolActor, ComfyPoolConfig, ComfyPoolEvent, run_comfy_job
from .echo import (
    EchoJobActor,
    EchoJobConfig,
    EchoJobRunner,
    EchoProgressEvent,
    run_echo_job,
)
from .job_router import JobRouter, JobRouterConfig, JobRouterEvent, run_routed_job
from .llm_gateway import (
    DryRunLlmBackend,
    LlmGatewayActor,
    LlmGatewayConfig,
    LlmGatewayEvent,
    LlmUpstream,
    run_llm_job,
)
from .scheduler import QueueScheduler, ScoreWeights, compute_priority_score

__all__ = [
    "FakeRedis",
    "EchoJobActor",
    "EchoJobConfig",
    "EchoJobRunner",
    "EchoProgressEvent",
    "run_echo_job",
    "QueueScheduler",
    "ScoreWeights",
    "compute_priority_score",
    "ComfyPoolActor",
    "ComfyPoolConfig",
    "ComfyPoolEvent",
    "run_comfy_job",
    "DryRunLlmBackend",
    "LlmGatewayActor",
    "LlmGatewayConfig",
    "LlmGatewayEvent",
    "LlmUpstream",
    "run_llm_job",
    "JobRouter",
    "JobRouterConfig",
    "JobRouterEvent",
    "run_routed_job",
]
