"""H2 工具缝(ctx.tools)测试:注册表 / SYSTEM 生成 / 守卫管线 / 工具行为对齐。

关键锁定:
- 注册表 schemas() 与 tools.TOOL_SCHEMAS + tools_gen.TOOL_SCHEMAS_GEN 逐键等价(同一对象来源);
- build_system_prompt 含全部 14 工具名;runner.system_prompt() 与锁定字面量逐字节一致
  (2026-08-24 深度接管:追加 4 生成工具 + 原则 12-15 导演行为准则);
- 守卫:NSFW 工具无 X-NSFW 上下文被拦(403 语义文本回给 LLM,executor 不被调用);
  限流守卫命中记配额,超额返回 429 语义文本;
- 10 个同步小工具经注册表执行的输入输出与旧 if/elif 链一致(fake pool/client + 真库 session);
- tools.execute 兼容入口委托注册表。

每个用例前后 reset_ctx(),保证单例隔离(同 test_harness.py 纪律)。
"""
from __future__ import annotations

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.agent import tools
from app.comfy.client import ComfyUIError
from app.harness import events as ev
from app.harness.context import HarnessContext
from app.harness.ctx import get_ctx, reset_ctx
from app.harness.tool_seam import ToolRegistry, ToolSpec
from app.models import Tenant, User
from app.nsfw_ctx import nsfw_intent_var
from app import ratelimit


@pytest.fixture(autouse=True)
async def _fresh_ctx():
    await reset_ctx()
    yield
    await reset_ctx()


# 迁移前 runner.SYSTEM 字面量(锁:生成的提示词必须与之逐字节一致;
# WIKI-2026-08-18 起新增第 9 工具 model_qa,插在 list_models 之后;
# 2026-08-24 深度接管:追加 4 个生成工具(submit_generation/check_jobs/
# optimize_prompt/propose_plan)+ 原则 12-15 导演行为准则)
LEGACY_SYSTEM = """你是 ToIV——一个由 ComfyUI 集群驱动的 AI 创作平台的智能助手。
你能通过工具实时为用户生成内容并直接展示结果:
- generate_image:文生图(海报/插画/照片/概念图等)
- generate_video:文生视频(把画面"动起来",约 1-2 分钟,调用前先告知用户需稍候)
- generate_music:文生音乐(BGM/纯音乐/带词歌曲)
- edit_image:图生图/重绘(仅当用户本轮上传了图片且想修改它时)
- generate_3d:生成可旋转的 3D 模型(有上传图则用该图转,否则按描述先出图再转;约 1-3 分钟)
- list_models:查询可用的图像大模型
- model_qa:模型百科问答(某模型是什么/怎么用/选型推荐;比 list_models 信息全)
- search_knowledge:检索平台知识库(ComfyUI 节点/工作流配方/模型/提示词)
- web_search:联网搜索(查平台没有的新知识:最新模型/插件/LoRA/行业动态/事实核查;可多轮换词深挖)
- run_workflow:提交自定义 ComfyUI 工作流图(标准工具满足不了时;搭图前先 search_knowledge 查配方与真实模型名)
- submit_generation:异步提交任意引擎的生成作业(视频/批量/专用实例引擎一律用它;立即返回 job_id,约耗时见引擎说明)
- check_jobs:查询生成作业状态与产物(用户追问进度时;done 的自动把产物展示给用户)
- optimize_prompt:提示词优化(提交生成前必调;按引擎/底模自动切方言)
- propose_plan:大需求提案(视频/批量/多步/整集类先出方案等用户确认再执行)

原则:
1. 用户表达创作意图时,主动调用相应工具完成,而不是只给建议。
2. 提示词尽量优化(补充风格、光影、质量词);除非用户指定,图片默认 1:1。
3. 工具会把图片/视频/音乐直接展示给用户,你只需简洁说明你做了什么、给点搭配建议。
4. 用中文,简洁友好。一次对话可多次调用工具(如"生成4张不同风格")。
5. 闲聊或咨询类问题直接回答,不必调用工具。
6. 需要 ComfyUI/模型/参数细节或要搭自定义工作流时,先用 search_knowledge 查证再动手;不要编造不存在的模型名或节点。
7. 工具返回失败/超时/不可用时,如实转告原因并停下;不要同一轮反复重试同一工具或改猜参数绕过。
8. 只确认工具实际成功返回的结果;未执行或未成功的步骤不说成已完成。
9. 用户问模型清单/能力等状态类问题时,先调用工具查当前结果再回答,不凭记忆猜测。
10. 多阶段的大需求(如"做一部短片")先与用户确认拆解方案再动手,不自动连发一整串生成调用;必要时引导使用 Agent Team 任务编排。
11. 生成结果由工具直接展示;不要自己输出媒体链接、markdown 图片语法或本地文件路径。
12. 生成走两条路:单张小图/短音乐用 generate_image/generate_music 直接出;视频、批量、长耗时或指定引擎/底模的一律用 submit_generation 异步提交(立即返回 job_id,不会卡住对话)。
13. 提交生成前一律先 optimize_prompt 把用户描述优化成目标引擎/底模的专业提示词(除非用户输入已是详细英文提示词);优化结果原样用于提交。
14. 视频/批量/多步/整集类大需求:先用自然语言与用户敲定风格与关键细节(题材/画风/镜头/时长/NSFW 档位),达成一致后调 propose_plan 出方案;提案发出后本轮结束,等用户确认/修改/拒绝后再执行,不要边问边做。
15. submit_generation 成功后,主动告知用户 job_id 与预计耗时(H3 约 15 分钟/段、SCoPE 运镜约 19 分钟、Wan-Animate-2 数分钟、池内图像约 1 分钟);用户追问进度时用 check_jobs 查询,done 的产物会自动展示给用户,不要谎称完成。"""

BUILTIN_ORDER = [
    "generate_image", "generate_video", "generate_music", "edit_image",
    "generate_3d", "list_models", "model_qa", "search_knowledge",
    "web_search", "run_workflow",
    # 深度接管生成工具(tools_gen.py,2026-08-24)
    "submit_generation", "check_jobs", "optimize_prompt", "propose_plan",
]


# --------------------------------------------------------------------------- #
# 注册表 / schema 等价 / SYSTEM 生成
# --------------------------------------------------------------------------- #
def test_builtin_tools_registered_in_system_order():
    reg = get_ctx().service("tools")
    assert isinstance(reg, ToolRegistry)
    assert reg.names == BUILTIN_ORDER


def test_schemas_equal_legacy_tool_schemas():
    reg = get_ctx().service("tools")
    got = reg.schemas()
    # 同步小工具(schema 与 tools.TOOL_SCHEMAS 同对象)+ 深度接管工具(tools_gen.TOOL_SCHEMAS_GEN)
    from app.agent import tools_gen

    want = tools.TOOL_SCHEMAS + tools_gen.TOOL_SCHEMAS_GEN
    # 按 name 对齐后逐键比对(注册顺序=SYSTEM 清单顺序,与 schema 数组序不同)
    want_by_name = {w["function"]["name"]: w for w in want}
    assert {g["function"]["name"] for g in got} == set(want_by_name)
    for g in got:
        assert g == want_by_name[g["function"]["name"]]


def test_build_system_prompt_contains_all_tools():
    reg = get_ctx().service("tools")
    prompt = reg.build_system_prompt()
    for name in BUILTIN_ORDER:
        assert f"- {name}:" in prompt
    assert len(prompt.splitlines()) == len(BUILTIN_ORDER)


def test_runner_system_prompt_byte_identical_to_legacy():
    from app.agent import runner

    assert runner.system_prompt() == LEGACY_SYSTEM


def test_duplicate_register_raises_keyerror():
    reg = get_ctx().service("tools")

    async def _noop(args, ctx):
        return "ok", []

    with pytest.raises(KeyError):
        reg.register(
            ToolSpec("generate_image", {"type": "function"}, _noop, "重复注册")
        )


async def test_unknown_tool_returns_text_not_raise():
    reg = get_ctx().service("tools")
    text, events = await reg.execute("nope", {}, {})
    assert text == "未知工具: nope"
    assert events == []


# --------------------------------------------------------------------------- #
# 守卫管线
# --------------------------------------------------------------------------- #
def _recording_spec(name: str = "spy", **kw) -> tuple[ToolSpec, list[dict]]:
    calls: list[dict] = []

    async def _exec(args, ctx):
        calls.append(args)
        return "执行成功", [{"type": "image", "urls": ["/x.png"]}]

    return ToolSpec(name, {"type": "function"}, _exec, "间谍工具", **kw), calls


async def test_nsfw_guard_blocks_without_r18_context():
    reg = get_ctx().service("tools")
    spec, calls = _recording_spec("nsfw_spy", nsfw=True)
    reg.register(spec)
    user = User(id="u-guard", email="g@toiv.ai", hashed_password="x", tenant_id="t")

    text, events = await reg.execute("nsfw_spy", {}, {"user": user})
    assert "403" in text
    assert events == []
    assert calls == [], "被拦时 executor 不应被调用"

    # 放行上下文(X-NSFW)后正常执行
    token = nsfw_intent_var.set(True)
    try:
        text2, events2 = await reg.execute("nsfw_spy", {}, {"user": user})
    finally:
        nsfw_intent_var.reset(token)
    assert text2 == "执行成功" and events2 and calls != []


async def test_rate_guard_records_quota_and_blocks_on_exceed():
    reg = get_ctx().service("tools")
    spec, calls = _recording_spec("rate_spy")  # 默认 rate_scope="generation"
    reg.register(spec)
    user = User(id="u-rate", email="r@toiv.ai", hashed_password="x", tenant_id="t")

    text, _ = await reg.execute("rate_spy", {"n": 1}, {"user": user})
    assert text == "执行成功"
    assert ratelimit.remaining(user, "generation") == 19, "命中一次记一次配额"

    # 打满配额:再执行 18 次(共 19),此时桶内 19 次;第 20 次放行,第 21 次拦截
    for i in range(18):
        await reg.execute("rate_spy", {"n": i + 2}, {"user": user})
    assert ratelimit.remaining(user, "generation") == 1
    text_ok, _ = await reg.execute("rate_spy", {}, {"user": user})
    assert text_ok == "执行成功"
    text_blocked, events_blocked = await reg.execute("rate_spy", {}, {"user": user})
    assert "频繁" in text_blocked and events_blocked == []
    assert len(calls) == 20, "超额后 executor 不再被调用"


async def test_post_execute_audit_event():
    ctx = get_ctx()
    seen: list[dict] = []
    ctx.events.on(ev.TOOLS_POST_EXECUTE, lambda p: seen.append(p))
    reg = ctx.service("tools")
    user = User(id="u-audit", email="a@toiv.ai", hashed_password="x", tenant_id="t")

    pool = _FakePool(_FakeClient())  # list_models 链
    await reg.execute("list_models", {}, {"pool": pool, "user": user, "session": None, "attachment": None})
    assert len(seen) == 1
    assert seen[0]["name"] == "list_models"
    assert seen[0]["user_id"] == "u-audit"
    assert "当前可用图像大模型" in seen[0]["text"]


async def test_waterfall_guard_can_rewrite_args():
    ctx = get_ctx()
    reg = ctx.service("tools")
    spec, calls = _recording_spec("rewrite_spy", rate_scope="")  # 不记配额,专注改写
    reg.register(spec)

    async def _rewrite(payload, nxt):
        payload["args"]["prompt"] = "改写后"
        return await nxt(payload)

    ctx.events.on_waterfall(ev.TOOLS_PRE_EXECUTE, _rewrite)
    text, _ = await reg.execute("rewrite_spy", {"prompt": "原始"}, {})
    assert text == "执行成功"
    assert calls[-1]["prompt"] == "改写后"


# --------------------------------------------------------------------------- #
# 8 工具执行行为与旧链一致(fake pool/client + 真库 session)
# --------------------------------------------------------------------------- #
class _FakeClient:
    """ComfyUIClient 替身:按脚本返回产物文件。"""

    def __init__(self, base_url: str = "http://fake:8188") -> None:
        self.base_url = base_url
        self.queued: list[dict] = []
        self.files_script: list[list[dict]] = []
        self.fail_object_info = False

    async def object_info(self, kind: str) -> dict:
        if self.fail_object_info:
            raise ComfyUIError("connection refused")
        return {
            "CheckpointLoaderSimple": {
                "input": {"required": {"ckpt_name": [["ckpt-a.safetensors", "ckpt-b.safetensors"]]}}
            }
        }

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.queued.append(graph)
        return f"pid-{len(self.queued)}"

    async def get_result_files(self, prompt_id: str) -> list[dict]:
        if self.files_script:
            return self.files_script.pop(0)
        return []

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        return b"img-bytes", {}

    async def upload_image(self, content: bytes, filename: str) -> str:
        return f"in-{filename}"


class _FakePool:
    def __init__(self, client: _FakeClient) -> None:
        self.clients = [client]

    async def pick(self, required=None):
        return self.clients[0]


@pytest.fixture
def db_env():
    """真库 session + 用户行(_record 落 Job 用)。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(email="tool@toiv.ai", hashed_password="x", tenant_id=tenant.id)
        s.add(user)
        s.commit()
        s.refresh(user)
        yield s, user


def _ctx(pool, user, session, attachment=None):
    return {"pool": pool, "user": user, "session": session, "attachment": attachment}


async def test_list_models_via_registry(db_env):
    s, user = db_env
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "list_models", {}, _ctx(_FakePool(_FakeClient()), user, s)
    )
    assert text == "当前可用图像大模型: ckpt-a.safetensors, ckpt-b.safetensors"
    assert events == []


async def test_list_models_query_failure(db_env):
    s, user = db_env
    client = _FakeClient()
    client.fail_object_info = True
    reg = get_ctx().service("tools")
    text, _ = await reg.execute("list_models", {}, _ctx(_FakePool(client), user, s))
    assert text == "当前可用图像大模型: (查询失败)"


async def test_generate_image_via_registry(db_env):
    s, user = db_env
    client = _FakeClient()
    client.files_script = [[{"filename": "out.png", "subfolder": "", "type": "output"}]]
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "generate_image", {"prompt": "a cat"}, _ctx(_FakePool(client), user, s)
    )
    assert text.startswith("已生成 1 张图片并展示给用户")
    assert len(events) == 1 and events[0]["type"] == "image"
    assert "out.png" in events[0]["urls"][0] and "worker=http" in events[0]["urls"][0]


async def test_generate_music_via_registry(db_env):
    s, user = db_env
    client = _FakeClient()
    client.files_script = [[{"filename": "song.mp3", "subfolder": "", "type": "output"}]]
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "generate_music", {"tags": "lofi"}, _ctx(_FakePool(client), user, s)
    )
    assert text == "已生成音乐并展示给用户。"
    assert events[0]["type"] == "audio" and "song.mp3" in events[0]["urls"][0]


async def test_generate_video_two_stage_via_registry(db_env):
    s, user = db_env
    client = _FakeClient()
    # 第一段:底图;第二段:视频
    client.files_script = [
        [{"filename": "base.png", "subfolder": "", "type": "output"}],
        [{"filename": "clip.mp4", "subfolder": "", "type": "output"}],
    ]
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "generate_video", {"prompt": "跑动的猫", "seconds": 3},
        _ctx(_FakePool(client), user, s),
    )
    assert "已生成" in text and "短视频" in text
    assert events[0]["type"] == "video" and "clip.mp4" in events[0]["urls"][0]
    assert len(client.queued) == 2, "底图 + 视频两段提交"


async def test_edit_image_requires_attachment(db_env):
    s, user = db_env
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "edit_image", {"prompt": "换风格"}, _ctx(_FakePool(_FakeClient()), user, s)
    )
    assert text == "请先在对话框上传一张图片,再让我编辑/重绘它。"
    assert events == []


async def test_edit_image_with_attachment(db_env):
    s, user = db_env
    client = _FakeClient()
    client.files_script = [[{"filename": "edited.png", "subfolder": "", "type": "output"}]]
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "edit_image", {"prompt": "赛博朋克"},
        _ctx(_FakePool(client), user, s,
             attachment={"filename": "up.png", "worker": "http://fake:8188"}),
    )
    assert "已按要求重绘并展示" in text
    assert events[0]["type"] == "image" and "edited.png" in events[0]["urls"][0]


async def test_generate_3d_via_registry(db_env):
    s, user = db_env
    client = _FakeClient()
    client.files_script = [
        [{"filename": "base.png", "subfolder": "", "type": "output"}],
        [{"filename": "model.glb", "subfolder": "", "type": "output"}],
    ]
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "generate_3d", {"prompt": "a cube"}, _ctx(_FakePool(client), user, s)
    )
    assert text == "已生成 3D 模型并展示(可旋转查看)。"
    assert events[0]["type"] == "model3d" and "model.glb" in events[0]["urls"][0]


async def test_search_knowledge_via_registry(db_env, monkeypatch):
    s, user = db_env

    class _KB:
        async def retrieve(self, query, k=4):
            return []

    monkeypatch.setattr(tools, "get_kb", lambda: _KB())
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "search_knowledge", {"query": "配方"}, _ctx(_FakePool(_FakeClient()), user, s)
    )
    assert text == "知识库暂无相关内容(或检索暂不可用),请凭通用知识谨慎作答。"

    class _KB2:
        async def retrieve(self, query, k=4):
            from types import SimpleNamespace

            return [SimpleNamespace(text="文生图配方A", title="t")]

    monkeypatch.setattr(tools, "get_kb", lambda: _KB2())
    text2, _ = await reg.execute(
        "search_knowledge", {"query": "配方"}, _ctx(_FakePool(_FakeClient()), user, s)
    )
    assert "文生图配方A" in text2


async def test_run_workflow_media_classification(db_env):
    s, user = db_env
    client = _FakeClient()
    client.files_script = [[
        {"filename": "pic.webp", "subfolder": "", "type": "output"},
        {"filename": "data.json", "subfolder": "", "type": "output"},
    ]]
    reg = get_ctx().service("tools")
    graph = {"1": {"class_type": "SaveImage", "inputs": {}}}
    text, events = await reg.execute(
        "run_workflow", {"graph": graph, "summary": "测试图"},
        _ctx(_FakePool(client), user, s),
    )
    assert "产出 2 个文件" in text
    assert events == [{"type": "image", "urls": [events[0]["urls"][0]]}]
    assert "pic.webp" in events[0]["urls"][0]
    assert "data.json" in text  # 非媒体产物列入 notes


async def test_run_workflow_rejects_bad_graph(db_env):
    s, user = db_env
    reg = get_ctx().service("tools")
    text, events = await reg.execute(
        "run_workflow", {"graph": {"1": {"inputs": {}}}},
        _ctx(_FakePool(_FakeClient()), user, s),
    )
    assert "缺少 class_type" in text and events == []


async def test_tools_execute_compat_entry_delegates_to_registry(db_env):
    """旧兼容入口 tools.execute 委托注册表(带守卫),行为一致。"""
    s, user = db_env
    text, events = await tools.execute(
        "list_models", {}, _FakePool(_FakeClient()), user, s
    )
    assert "当前可用图像大模型" in text and events == []
    # 未知工具与旧行为一致
    text2, _ = await tools.execute("ghost", {}, _FakePool(_FakeClient()), user, s)
    assert text2 == "未知工具: ghost"


def test_new_registry_is_empty_and独立():
    """新建 ToolRegistry(非插件引导)为空表,互不影响。"""
    reg = ToolRegistry(HarnessContext())
    assert reg.names == []
    assert reg.schemas() == []
    assert reg.build_system_prompt() == ""
