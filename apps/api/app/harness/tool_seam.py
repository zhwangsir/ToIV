"""工具缝(ctx.tools):ToolSpec 注册表 + 守卫管线(H2)。

- Definition:ToolSpec{name, schema(OpenAI function dict), executor, summary, nsfw,
  rate_scope} —— schema/执行器/SYSTEM 说明单一事实源,消灭 TOOL_SCHEMAS、execute
  if/elif、runner.SYSTEM 三处手工同步。
- Provider:ToolPlugin —— harness bootstrap 时在 LLMPlugin 之后激活(见
  plugin.bootstrap_default),注册内建工具(10 个同步小工具,执行器事实源在
  app.agent.tools;+ 4 个深度接管生成工具,事实源在 app.agent.tools_gen)
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

# 工具执行器签名:(LLM 给的参数, 调用上下文) → (给 LLM 的文字结果, 推前端的事件列表)
# 调用上下文 dict 约定键:pool / user / session / attachment(可空) /
# agent_session(可空,本会话 AgentSession 行;仅对话链路有,propose_plan 落提案用)。
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
    """内建工具的 ToolSpec(顺序即 SYSTEM 工具清单顺序)。

    前 10 个为 tools.py 的同步直出小工具(与迁移前 runner.SYSTEM 逐字一致);
    后 4 个为 tools_gen.py 的深度接管工具(异步提交/查状态/提示词优化/提案)。
    submit/optimize 走 routes 端点函数自带限流,故 rate_scope="" 防双记配额。

    惰性 import app.agent.tools / tools_gen:本模块可能被 harness bootstrap 早期加载,
    而 tools 依赖 harness.ctx(兼容入口),模块级互导会成环。
    """
    from app.agent import tools, tools_gen

    def schema(name: str) -> dict:
        # schema 与 tools.TOOL_SCHEMAS 同对象,保证注册表与旧清单逐键等价
        return next(s for s in tools.TOOL_SCHEMAS if s["function"]["name"] == name)

    def gen_schema(name: str) -> dict:
        return next(s for s in tools_gen.TOOL_SCHEMAS_GEN if s["function"]["name"] == name)

    def _drama_specs() -> list[ToolSpec]:
        from app.agent import tools_drama

        def ds(name: str) -> dict:
            return next(s for s in tools_drama.TOOL_SCHEMAS_DRAMA if s["function"]["name"] == name)

        return [
            ToolSpec("create_storyboard", ds("create_storyboard"), tools_drama.exec_create_storyboard,
                     "剧本拆镜建分镜板(短剧/漫剧任务第一步;角色自动落库主体库)", rate_scope=""),
            ToolSpec("get_storyboard", ds("get_storyboard"), tools_drama.exec_get_storyboard,
                     "查看分镜板内容与各镜状态(拆镜汇报/成片前检查)", rate_scope=""),
            ToolSpec("generate_shot", ds("generate_shot"), tools_drama.exec_generate_shot,
                     "单独重跑分镜板某一镜(审片点名不满意/失败重试)", rate_scope=""),
            ToolSpec("assemble_storyboard", ds("assemble_storyboard"), tools_drama.exec_assemble_storyboard,
                     "一键成片(逐镜生成+配音+词锚定字幕+拼接;后台执行返回作业 id)", rate_scope=""),
            ToolSpec("check_film", ds("check_film"), tools_drama.exec_check_film,
                     "查询一键成片作业状态与产物(done 自动展示成片)", rate_scope=""),
            ToolSpec("remix_storyboard", ds("remix_storyboard"), tools_drama.exec_remix_storyboard,
                     "整片级 remix(克隆板换主角/换词/换背景并自动成片;原版不动)", rate_scope=""),
        ]

    def _selfheal_specs() -> list[ToolSpec]:
        from app.agent import tools_selfheal

        def sh(name: str) -> dict:
            return next(s for s in tools_selfheal.TOOL_SCHEMAS_SELFHEAL if s["function"]["name"] == name)

        return [
            ToolSpec("list_smoke_failures", sh("list_smoke_failures"), tools_selfheal.exec_list_smoke_failures,
                     "列出烟测失败/超时的应用及归因(仅管理员)", rate_scope=""),
            ToolSpec("explain_app_failure", sh("explain_app_failure"), tools_selfheal.exec_explain_app_failure,
                     "详解一个应用的烟测失败+修复建议+已有提案(仅管理员)", rate_scope=""),
            ToolSpec("run_app_smoke", sh("run_app_smoke"), tools_selfheal.exec_run_app_smoke,
                     "对应用现场重跑烟测(管线自动归因+修复重试;仅管理员)", rate_scope=""),
            ToolSpec("reject_app_fix", sh("reject_app_fix"), tools_selfheal.exec_reject_app_fix,
                     "回滚一个 LLM 修复提案(补丁帮倒忙时;仅管理员)", rate_scope=""),
        ]

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
        ToolSpec("model_qa", schema("model_qa"), _wrap(tools.exec_model_qa),
                 "模型百科问答(某模型是什么/怎么用/选型推荐;比 list_models 信息全)"),
        ToolSpec("search_knowledge", schema("search_knowledge"), _wrap(tools.exec_search_knowledge),
                 "检索平台知识库(ComfyUI 节点/工作流配方/模型/提示词)"),
        ToolSpec("web_search", schema("web_search"), _wrap(tools.exec_web_search),
                 "联网搜索(查平台没有的新知识:最新模型/插件/LoRA/行业动态/事实核查;可多轮换词深挖)"),
        ToolSpec("run_workflow", schema("run_workflow"), _wrap(tools.exec_run_workflow),
                 "提交自定义 ComfyUI 工作流图(标准工具满足不了时;搭图前先 search_knowledge 查配方与真实模型名)"),
        # ── 深度接管生成工具(tools_gen.py;executor 直接吃 (args, ctx))──
        # rate_scope="":提交/优化走 routes 端点函数自带限流,守卫不重复记配额
        ToolSpec("submit_generation", gen_schema("submit_generation"), tools_gen.exec_submit_generation,
                 "异步提交任意引擎的生成作业(视频/H3 优先 list_apps+run_app;engine_id 是进阶兜底;立即返回 job_id)", rate_scope=""),
        ToolSpec("list_entities", gen_schema("list_entities"), tools_gen.exec_list_entities,
                 "查询用户全局主体库(角色/场景/道具,生成中保持主体一致时先查)", rate_scope=""),
        ToolSpec("list_apps", gen_schema("list_apps"), tools_gen.exec_list_apps,
                 "查询应用市场(视频/H3 优先用应用而不是裸引擎;可按分类/关键词过滤)", rate_scope=""),
        ToolSpec("get_app", gen_schema("get_app"), tools_gen.exec_get_app,
                 "查看应用参数表与填值说明(run_app 前若不确定参数先查)", rate_scope=""),
        ToolSpec("run_app", gen_schema("run_app"), tools_gen.exec_run_app,
                 "运行市场应用(异步返回 job_id;视频/H3 用户意图优先走它)", rate_scope=""),
        ToolSpec("check_jobs", gen_schema("check_jobs"), tools_gen.exec_check_jobs,
                 "查询生成作业状态与产物(用户追问进度时;done 的自动把产物展示给用户)", rate_scope=""),
        ToolSpec("optimize_prompt", gen_schema("optimize_prompt"), tools_gen.exec_optimize_prompt,
                 "提示词优化(提交生成前必调;按引擎/底模自动切方言)", rate_scope=""),
        ToolSpec("propose_plan", gen_schema("propose_plan"), tools_gen.exec_propose_plan,
                 "大需求提案(视频/批量/多步/整集类先出方案等用户确认再执行)", rate_scope=""),
        ToolSpec("adjust_3d", gen_schema("adjust_3d"), tools_gen.exec_adjust_3d,
                 "3D 模型材质/渲染调整(材质烘焙成新 GLB 模型/染色;旋转视频、快照为可选查看产物;立即出产物)", rate_scope=""),
        # ── W3 UI 驱动工具(零服务端副作用的界面指令;open_asset 仅做归属校验)──
        ToolSpec("navigate_view", gen_schema("navigate_view"), tools_gen.exec_navigate_view,
                 "切换前端界面到指定功能页(「去/打开 X」类意图)", rate_scope=""),
        ToolSpec("prefill_generate", gen_schema("prefill_generate"), tools_gen.exec_prefill_generate,
                 "预填生成工作台提示词并跳转(用户想微调参数再手动提交时)", rate_scope=""),
        ToolSpec("open_asset", gen_schema("open_asset"), tools_gen.exec_open_asset,
                 "在作品库打开一个已有产物(需 job_id,限本人)", rate_scope=""),
        # ── 漫剧线工具(tools_drama.py;分镜板管线:拆镜→单镜→成片→追踪)──
        *_drama_specs(),
        # ── 自愈闭环延伸工具(tools_selfheal.py;烟测失败归因/修复建议/重测/回滚)──
        *_selfheal_specs(),
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
