"""工具缝(ctx.tools):ToolSpec 注册表 + 守卫管线(H2)。

- Definition:ToolSpec{name, schema(OpenAI function dict), executor, summary, nsfw,
  rate_scope} —— schema/执行器/SYSTEM 说明单一事实源,消灭 TOOL_SCHEMAS、execute
  if/elif、runner.SYSTEM 三处手工同步。
- Provider:ToolPlugin —— harness bootstrap 时在 LLMPlugin 之后激活(见
  plugin.bootstrap_default),注册 8 个内建工具(执行器事实源在 app.agent.tools)
  与两条内建守卫(R18 门 / 限流记配额)。
- Consumer:agent/runner 与 routes 经 get_ctx().service("tools") 取用;
  app.agent.tools.execute 保留兼容入口(委托本注册表)。

守卫管线(对齐 dsh tools/* 域):
- 执行前 waterfall TOOLS_PRE_EXECUTE:监听器收到 (payload, next);调 next(可改写
  payload.args)放行,不调 next 直接返回 (text, events) 即阻断 —— 该文本作为工具
  结果回给 LLM,不抛异常、不断 SSE 流。内建守卫按序:R18 门(nsfw=True 工具且
  请求上下文不放行 → 403 语义文本)→ 限流(按 spec.rate_scope 记配额,超额 →
  429 语义文本)。
- 执行后 emit TOOLS_POST_EXECUTE:审计负载(name/args/结果文本/媒体事件/用户 id)。
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from fastapi import HTTPException

from app.harness import events as ev
from app.harness.context import HarnessContext
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_rate_limit

logger = logging.getLogger(__name__)

# 工具执行器签名:(LLM 给的参数, 调用上下文) → (给 LLM 的文字结果, 推前端的媒体事件)
# 调用上下文 dict 约定键:pool / user / session / attachment(可空)。
ToolExecutor = Callable[[dict, dict], Awaitable[tuple[str, list[dict]]]]


@dataclass
class ToolSpec:
    """一个工具的完整声明。summary 是给 SYSTEM 工具清单段的一句话。"""

    name: str
    schema: dict
    executor: ToolExecutor
    summary: str
    nsfw: bool = False  # True=仅 R18 上下文可执行(守卫拦,返回 403 语义文本)
    rate_scope: str = "generation"  # 限流配额维度(空串=不记配额)


class ToolRegistry:
    """工具注册表:schema 列表 / SYSTEM 工具说明段 / 带守卫管线的执行。"""

    def __init__(self, ctx: HarnessContext) -> None:
        self._ctx = ctx
        self._specs: dict[str, ToolSpec] = {}
        self._order: list[str] = []

    def register(self, spec: ToolSpec) -> None:
        """注册工具;重名抛 KeyError(与服务注册同一纪律,防静默覆盖)。"""
        if spec.name in self._specs:
            raise KeyError(f"工具重复注册: {spec.name}")
        self._specs[spec.name] = spec
        self._order.append(spec.name)

    @property
    def names(self) -> list[str]:
        """已注册工具名(按注册顺序,即 SYSTEM 清单顺序)。"""
        return list(self._order)

    def get(self, name: str) -> ToolSpec | None:
        return self._specs.get(name)

    def schemas(self) -> list[dict]:
        """OpenAI tools 参数(注册顺序)。"""
        return [self._specs[n].schema for n in self._order]

    def build_system_prompt(self) -> str:
        """从各工具 summary 生成 SYSTEM 的工具说明段(每行 "- name:summary")。"""
        return "\n".join(f"- {n}:{self._specs[n].summary}" for n in self._order)

    async def execute(self, name: str, args: dict, ctx: dict) -> tuple[str, list[dict]]:
        """经守卫管线执行工具,返回 (给 LLM 的文本, 推前端的媒体事件)。

        未知工具与旧 tools.execute 行为一致:返回 "未知工具: xxx" 文本,不抛异常。
        """
        spec = self._specs.get(name)
        if spec is None:
            return f"未知工具: {name}", []
        payload = {"name": name, "args": args, "ctx": ctx, "spec": spec}

        async def _final(p: dict) -> tuple[str, list[dict]]:
            return await p["spec"].executor(p["args"], p["ctx"])

        text, events = await self._ctx.events.waterfall(ev.TOOLS_PRE_EXECUTE, payload, _final)
        # 执行后审计(监听器异常不中断,见 EventBus.emit)
        await self._ctx.events.emit(
            ev.TOOLS_POST_EXECUTE,
            {
                "name": name,
                "args": args,
                "text": text,
                "events": events,
                "user_id": getattr(ctx.get("user"), "id", None),
            },
        )
        return text, events


# ---------------------------------------------------------------------------
# 内建守卫(TOOLS_PRE_EXECUTE waterfall 监听器;顺序 = 注册顺序)
# ---------------------------------------------------------------------------


async def _nsfw_guard(payload: dict, nxt: ev.WaterfallNext) -> tuple[str, list[dict]]:
    """R18 门:nsfw=True 工具且请求上下文不放行 → 403 语义文本回给 LLM(不抛异常)。"""
    spec: ToolSpec = payload["spec"]
    if spec.nsfw and not nsfw_allowed(payload["ctx"].get("user")):
        return "该工具仅 R18 模式可用(403),本轮请改用常规工具或提示用户切换模式。", []
    return await nxt(payload)


async def _rate_guard(payload: dict, nxt: ev.WaterfallNext) -> tuple[str, list[dict]]:
    """限流守卫:按 spec.rate_scope 记配额;超额 → 429 语义文本回给 LLM。"""
    spec: ToolSpec = payload["spec"]
    user = payload["ctx"].get("user")
    if user is not None and spec.rate_scope:
        try:
            enforce_rate_limit(user, scope=spec.rate_scope)
        except HTTPException as exc:
            return f"操作过于频繁({exc.detail}),请稍后重试。", []
    return await nxt(payload)


# ---------------------------------------------------------------------------
# 内建工具(8 个;执行器事实源在 app.agent.tools,此处薄包装)
# ---------------------------------------------------------------------------


def _wrap(fn) -> ToolExecutor:
    """把 tools.exec_*(args, pool, user, session, attachment) 包装成 (args, ctx) 签名。"""

    async def _exec(args: dict, ctx: dict) -> tuple[str, list[dict]]:
        return await fn(
            args, ctx["pool"], ctx["user"], ctx["session"], ctx.get("attachment")
        )

    return _exec


def builtin_tool_specs() -> list[ToolSpec]:
    """8 个内建工具的 ToolSpec(顺序即 SYSTEM 工具清单顺序,与迁移前 runner.SYSTEM 逐字一致)。

    惰性 import app.agent.tools:本模块可能被 harness bootstrap 早期加载,
    而 tools 依赖 harness.ctx(兼容入口),模块级互导会成环。
    """
    from app.agent import tools

    def schema(name: str) -> dict:
        # schema 与 tools.TOOL_SCHEMAS 同对象,保证注册表与旧清单逐键等价
        return next(s for s in tools.TOOL_SCHEMAS if s["function"]["name"] == name)

    return [
        ToolSpec("generate_image", schema("generate_image"), _wrap(tools.exec_generate_image),
                 "文生图(海报/插画/照片/概念图等)"),
        ToolSpec("generate_video", schema("generate_video"), _wrap(tools.exec_generate_video),
                 "文生视频(把画面\"动起来\",约 1-2 分钟,调用前先告知用户需稍候)"),
        ToolSpec("generate_music", schema("generate_music"), _wrap(tools.exec_generate_music),
                 "文生音乐(BGM/纯音乐/带词歌曲)"),
        ToolSpec("edit_image", schema("edit_image"), _wrap(tools.exec_edit_image),
                 "图生图/重绘(仅当用户本轮上传了图片且想修改它时)"),
        ToolSpec("generate_3d", schema("generate_3d"), _wrap(tools.exec_generate_3d),
                 "生成可旋转的 3D 模型(有上传图则用该图转,否则按描述先出图再转;约 1-3 分钟)"),
        ToolSpec("list_models", schema("list_models"), _wrap(tools.exec_list_models),
                 "查询可用的图像大模型"),
        ToolSpec("search_knowledge", schema("search_knowledge"), _wrap(tools.exec_search_knowledge),
                 "检索平台知识库(ComfyUI 节点/工作流配方/模型/提示词)"),
        ToolSpec("run_workflow", schema("run_workflow"), _wrap(tools.exec_run_workflow),
                 "提交自定义 ComfyUI 工作流图(标准工具满足不了时;搭图前先 search_knowledge 查配方与真实模型名)"),
    ]


class ToolPlugin:
    """把 ToolRegistry 注册为 ctx.tools 的内建插件,并挂两条内建守卫。

    可注入自定义 specs(测试/裁剪场景);dispose 时随 scope 逆序回收服务与守卫。
    """

    name = "tool-seam"

    def __init__(self, specs: list[ToolSpec] | None = None) -> None:
        self._specs = specs if specs is not None else builtin_tool_specs()

    def activate(self, ctx: HarnessContext) -> None:
        registry = ToolRegistry(ctx)
        for spec in self._specs:
            registry.register(spec)
        ctx.register_service("tools", registry)
        # 守卫顺序:R18 门在前(被拦的工具不消耗配额),限流在后
        ctx.on_dispose(ctx.events.on_waterfall(ev.TOOLS_PRE_EXECUTE, _nsfw_guard))
        ctx.on_dispose(ctx.events.on_waterfall(ev.TOOLS_PRE_EXECUTE, _rate_guard))
