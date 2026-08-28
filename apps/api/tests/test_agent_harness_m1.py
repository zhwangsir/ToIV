"""Agent Harness 化 M1(2026-08-19)测试。

覆盖:
  · context.compress_history:配对不变量(assistant.tool_calls+tool 原子单元)、
    预算内原样返回、超预算折叠中间(首锚点+最近尾保留)、system 追加折叠注、
    极端首尾超预算仍非空、纯函数不改入参
  · runner._skills_context:名称整体命中(≥2 分)、噪声不命中、topk 截断、
    R18 门控(无 R18 上下文跳过)、个人技能不注入、topk=0 关闭
  · runner 主循环:轮次取自 settings.agent_max_rounds、每轮前经压缩(tool 事件带 round)
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.agent.context import (
    CONTEXT_OVERFLOW_USER_MSG,
    TOOL_CONTENT_CAP,
    _group_units,
    chat_tool_schemas,
    compress_history,
    last_user_turn,
    model_messages_from_rows,
)
from app.agent import llm as agent_llm
from app.agent import runner as agent_runner
from app.models import Agent, AgentMessage, AgentSession, Tenant, User
from app.security import hash_password


# --------------------------------------------------------------------------- #
# compress_history 纯函数
# --------------------------------------------------------------------------- #


def _hist() -> list[dict]:
    """典型形态:system + 首任务 + 多轮(user / assistant+tools / tool 结果)。"""
    return [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "帮我做一张海报"},  # 首锚点
        {"role": "assistant", "content": "", "tool_calls": [{"id": "t1", "function": {"name": "generate_image", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "t1", "content": "ok:" + "x" * 2000},
        {"role": "assistant", "content": "第一版完成"},
        {"role": "user", "content": "再改成蓝色"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "t2", "function": {"name": "edit_image", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "t2", "content": "ok:" + "y" * 2000},
        {"role": "assistant", "content": "第二版完成"},
    ]


def test_under_budget_returns_unchanged_copy():
    # 短正文(低于 tool 帽)才走原样浅拷贝;超长 tool 另见 cap 测试
    h = [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]
    out = compress_history(h, 100000)
    assert [m.get("content") for m in out] == [m.get("content") for m in h]
    assert out is not h and out[0] is not h[0]  # 浅拷贝新列表


def test_group_units_pairs_tool_calls_with_results():
    units = _group_units(_hist())
    flat = [i for u in units for i in u]
    assert flat == [i for i in range(1, 9)]  # 非 system 全覆盖无遗漏
    # units: [海报] [t1调用+结果] [第一版] [再改蓝] [t2调用+结果] [第二版]
    assert units[1] == [2, 3]
    assert units[4] == [6, 7]


def test_over_budget_folds_middle_keeps_anchor_and_tail():
    h = _hist()
    # 预算 2100:逆序贪心保最近 → t2 单元(最近,~2015)保留、t1 单元(最老的大块)折叠
    out = compress_history(h, 2100)
    contents = [m.get("content") or "" for m in out]
    combined = "\n".join(contents)
    assert out[0]["role"] == "system"
    assert "帮我做一张海报" in contents  # 首锚点保留
    assert "第二版完成" in contents  # 尾部保留
    assert "y" * 100 in combined  # 最近的大工具结果 t2 保留(贪心保近)
    assert "x" * 100 not in combined  # 最老的大工具结果 t1 被折叠
    assert "折叠省略" in out[0]["content"]  # 折叠注追加到 system
    # 配对不变量:任何 tool 消息的前一条必须是对应 assistant(tool_calls)
    for i, m in enumerate(out):
        if m.get("role") == "tool":
            prev = out[i - 1]
            assert prev.get("role") == "assistant" and prev.get("tool_calls")


def test_extreme_first_plus_tail_over_budget_never_empty():
    h = _hist()
    out = compress_history(h, 1)  # 极端小预算
    assert len(out) >= 3  # system + 首单元 + 尾单元
    assert "帮我做一张海报" in (m.get("content") or "" for m in out)


def test_no_system_messages_passthrough():
    h = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
    out = compress_history(h, 10)
    assert out[0]["role"] == "user"


def test_pure_function_input_untouched():
    h = _hist()
    snapshot = json.dumps(h, ensure_ascii=False)
    compress_history(h, 100)
    assert json.dumps(h, ensure_ascii=False) == snapshot


def test_fat_first_unit_tool_capped_under_budget():
    fat = "S" * 20000
    h = [
        {"role": "system", "content": "SYS"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "t1", "function": {"name": "get_system_stats", "arguments": "{}"}},
        ]},
        {"role": "tool", "tool_call_id": "t1", "content": fat},
        {"role": "user", "content": "然后呢"},
    ]
    snapshot = json.dumps(h, ensure_ascii=False)
    out = compress_history(h, 24000)
    assert json.dumps(h, ensure_ascii=False) == snapshot
    tool = next(m for m in out if m.get("role") == "tool")
    assert tool["content"].endswith("...(截断)")
    assert len(tool["content"]) <= TOOL_CONTENT_CAP + 20
    assert len(tool["content"]) < 20000
    non_sys = 0
    for m in out:
        if m.get("role") == "system":
            continue
        non_sys += len(m.get("content") or "")
        if m.get("tool_calls"):
            non_sys += len(json.dumps(m["tool_calls"], ensure_ascii=False))
    assert non_sys < 24000
    for i, m in enumerate(out):
        if m.get("role") == "tool":
            prev = out[i - 1]
            assert prev.get("role") == "assistant" and prev.get("tool_calls")


def test_first_last_over_budget_truncates_inside_units():
    h = [
        {"role": "system", "content": "SYS"},
        {"role": "assistant", "content": "A" * 5000, "tool_calls": [
            {"id": "t1", "function": {"name": "x", "arguments": "{}"}},
        ]},
        {"role": "tool", "tool_call_id": "t1", "content": "T" * 20000},
        {"role": "assistant", "content": "B" * 8000},
    ]
    out = compress_history(h, 3000)
    assert any(m.get("role") == "tool" for m in out)
    assert any(m.get("tool_calls") for m in out)
    non_sys = 0
    for m in out:
        if m.get("role") == "system":
            continue
        non_sys += len(m.get("content") or "")
        if m.get("tool_calls"):
            non_sys += len(json.dumps(m["tool_calls"], ensure_ascii=False))
    assert non_sys <= 3000
    for i, m in enumerate(out):
        if m.get("role") == "tool":
            prev = out[i - 1]
            assert prev.get("role") == "assistant" and prev.get("tool_calls")


def test_chat_tool_schemas_omits_mcp_prefix():
    schemas = [
        {"type": "function", "function": {"name": "generate_image"}},
        {"type": "function", "function": {"name": "mcp__get_system_stats"}},
        {"type": "function", "function": {"name": "check_jobs"}},
    ]
    names = [s["function"]["name"] for s in chat_tool_schemas(schemas)]
    assert names == ["generate_image", "check_jobs"]


def test_last_user_turn_keeps_system_and_latest_user():
    h = _hist()
    snapshot = json.dumps(h, ensure_ascii=False)
    out = last_user_turn(h)
    assert json.dumps(h, ensure_ascii=False) == snapshot
    assert [m["role"] for m in out] == ["system", "user"]
    assert out[1]["content"] == "再改成蓝色"
    assert "新开会话" not in CONTEXT_OVERFLOW_USER_MSG


def test_model_messages_from_rows_restores_tool_pair():
    rows = [
        {"role": "user", "content": "有哪些模型", "tool_calls": ""},
        {
            "role": "assistant", "content": "",
            "tool_calls": json.dumps([{"id": "t1", "function": {"name": "list_models", "arguments": "{}"}}]),
        },
        {
            "role": "tool", "content": "ckpt: a.safetensors",
            "tool_calls": json.dumps({"tool_call_id": "t1", "name": "list_models", "args": {}}),
        },
        {"role": "assistant", "content": "已列出", "tool_calls": ""},
        {"role": "system", "content": "skip me", "tool_calls": ""},
    ]
    out = model_messages_from_rows(rows)
    assert [m["role"] for m in out] == ["user", "assistant", "tool", "assistant"]
    assert out[1]["tool_calls"][0]["id"] == "t1"
    assert out[2]["tool_call_id"] == "t1"
    assert out[2]["content"] == "ckpt: a.safetensors"


# --------------------------------------------------------------------------- #
# _skills_context
# --------------------------------------------------------------------------- #


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="harness")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(email="harness@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        s.add(user)
        s.commit()
        s.refresh(user)
        s.add(Agent(id="ghibli", name="吉卜力风格", description="宫崎骏 吉卜力 手绘动画 质感",
                    system_prompt="你是吉卜力风格画师" + "p" * 800, user_id=""))
        s.add(Agent(id="noise", name="无关技能", description="完全不相干的描述",
                    system_prompt="x", user_id=""))
        s.add(Agent(id="r18", name="写实人像大师", description="写实 人像 光影",
                    system_prompt="y", user_id="", is_nsfw=True))
        s.add(Agent(id="mine", name="私人技能吉卜力", description="吉卜力",
                    system_prompt="z", user_id=user.id))
        s.commit()
        yield s, user


def _msgs(text: str) -> list[dict]:
    return [{"role": "user", "content": text}]


def test_skills_name_hit_injects_persona(db):
    s, user = db
    with patch.object(agent_runner, "nsfw_allowed", lambda u: False):
        ctx = agent_runner._skills_context(_msgs("用吉卜力风格画一座森林"), user, s)
    assert ctx is not None
    assert "吉卜力风格" in ctx
    assert "人格要点" in ctx
    assert "无关技能" not in ctx
    assert "私人技能" not in ctx  # 个人技能不注入
    # 人格截断到 600
    assert "p" * 601 not in ctx


def test_skills_r18_gated_without_nsfw_context(db):
    s, user = db
    with patch.object(agent_runner, "nsfw_allowed", lambda u: False):
        ctx = agent_runner._skills_context(_msgs("写实 人像 大师 光影 风格"), user, s)
    assert ctx is None  # 唯一命中的是 R18 技能,SFW 上下文不可见


def test_skills_r18_injected_with_nsfw_context(db):
    s, user = db
    with patch.object(agent_runner, "nsfw_allowed", lambda u: True):
        ctx = agent_runner._skills_context(_msgs("写实 人像 大师 光影 风格"), user, s)
    assert ctx is not None and "写实人像大师" in ctx


def test_skills_no_match_returns_none(db):
    s, user = db
    with patch.object(agent_runner, "nsfw_allowed", lambda u: False):
        assert agent_runner._skills_context(_msgs("今天天气怎么样"), user, s) is None


def test_skills_disabled_by_topk_zero(db):
    s, user = db
    with patch.object(agent_runner, "get_settings", lambda: SimpleNamespace(agent_skills_topk=0)):
        with patch.object(agent_runner, "nsfw_allowed", lambda u: False):
            assert agent_runner._skills_context(_msgs("吉卜力风格"), user, s) is None


# --------------------------------------------------------------------------- #
# runner 主循环(轮次配置化 + 每轮压缩 + round 事件字段)
# --------------------------------------------------------------------------- #


class _FakeLLM:
    """每轮都返回一次工具调用,最终轮返回纯文本(可控收尾)。"""

    def __init__(self, rounds_before_final: int) -> None:
        self.calls: list[list[dict]] = []
        self._left = rounds_before_final

    async def chat(self, msgs, tools=None):
        self.calls.append([dict(m) for m in msgs])
        if self._left > 0:
            self._left -= 1
            return {"content": "调用中", "tool_calls": [
                {"id": f"c{len(self.calls)}", "function": {"name": "noop", "arguments": "{}"}}
            ]}
        return {"content": "完成", "tool_calls": []}


class _FakeTools:
    def schemas(self):
        return []

    async def execute(self, name, args, ctx):
        return "ok:" + "z" * 300, []

    def build_system_prompt(self):
        return ""


@pytest.mark.asyncio
async def test_runner_rounds_respect_settings_and_emits_round():
    import asyncio

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="h2")
        s.add(tenant); s.commit(); s.refresh(tenant)
        user = User(email="h2@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        s.add(user); s.commit(); s.refresh(user)

        fake_llm = _FakeLLM(rounds_before_final=2)
        fake_tools = _FakeTools()
        fake_ctx = type("Ctx", (), {})()

        def svc(name):
            if name == "llm":
                return fake_llm
            if name == "tools":
                return fake_tools
            raise KeyError(name)

        fake_ctx.service = svc

        events = []
        fake_settings = SimpleNamespace(agent_max_rounds=5, agent_context_budget=50, agent_skills_topk=0)
        with patch.object(agent_runner, "get_ctx", lambda: fake_ctx), \
             patch.object(agent_runner, "nsfw_allowed", lambda u: False), \
             patch.object(agent_runner, "_rag_context", _noop_rag), \
             patch.object(agent_runner, "get_settings", lambda: fake_settings):
            gen = agent_runner.run(
                [{"role": "user", "content": "a" * 400}], pool=None, user=user, session=s
            )
            events = [ev async for ev in gen]

        # 3 轮模型调用:2 轮工具 + 1 轮收尾
        assert len(fake_llm.calls) == 3
        # 第 1 轮:仅 system+单条 user(单单元无从折叠,原样)
        assert fake_llm.calls[0][0]["role"] == "system"
        # 第 3 轮:历史 = sys, user(400), a1+tool1(303), a2+tool2(303);预算 50
        # → 首锚点+尾单元保留,中间 a1 单元折叠;system 追加折叠注,大工具结果不重复出现两次
        third = fake_llm.calls[2]
        assert "折叠省略" in third[0]["content"]
        third_text = "\n".join(m.get("content") or "" for m in third)
        # "z"*300 里 count("z"*100) 恒为 3(非重叠),须按工具结果前缀计数:只留最近一个
        assert third_text.count("ok:") <= 1  # a1 单元被折叠,仅保留最近工具结果
        # tool 事件带 round 字段(1、2)
        tool_evs = [e for e in events if e.get("type") == "tool"]
        assert [e["round"] for e in tool_evs] == [1, 2]
        # 最终文本
        assert events[-1]["type"] == "text" and events[-1]["content"] == "完成"


async def _noop_rag(messages):
    return None


class _OverflowLLM:
    def __init__(self) -> None:
        self.n = 0

    async def chat(self, msgs, tools=None):
        self.n += 1
        raise agent_llm.LLMError(
            "LLM 调用失败(400): maximum context length is 32768 tokens. "
            "However, you requested 0 output tokens and your prompt contains at least 32769 input tokens"
        )


@pytest.mark.asyncio
async def test_runner_context_overflow_yields_friendly_zh():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="ovf")
        s.add(tenant); s.commit(); s.refresh(tenant)
        user = User(email="ovf@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        s.add(user); s.commit(); s.refresh(user)

        fake_llm = _OverflowLLM()
        fake_tools = _FakeTools()
        fake_ctx = type("Ctx", (), {})()

        def svc(name):
            if name == "llm":
                return fake_llm
            if name == "tools":
                return fake_tools
            raise KeyError(name)

        fake_ctx.service = svc
        fake_settings = SimpleNamespace(agent_max_rounds=5, agent_context_budget=24000, agent_skills_topk=0)
        with patch.object(agent_runner, "get_ctx", lambda: fake_ctx), \
             patch.object(agent_runner, "nsfw_allowed", lambda u: False), \
             patch.object(agent_runner, "_rag_context", _noop_rag), \
             patch.object(agent_runner, "get_settings", lambda: fake_settings):
            events = [ev async for ev in agent_runner.run(
                [{"role": "user", "content": "hi"}], pool=None, user=user, session=s
            )]

        assert fake_llm.n == 3  # 预算 → 半预算 → 只留最近 user
        assert len(events) == 1 and events[0]["type"] == "error"
        assert events[0]["content"] == CONTEXT_OVERFLOW_USER_MSG
        assert "新开会话" not in events[0]["content"]
        assert "maximum context length" not in events[0]["content"]
        assert "主备均不可用" not in events[0]["content"]


class _OverflowThenOkLLM:
    """前 fail_times 次报上下文溢出,之后正常收尾。"""

    def __init__(self, fail_times: int) -> None:
        self.n = 0
        self.fail_times = fail_times
        self.calls: list[list[dict]] = []

    async def chat(self, msgs, tools=None):
        self.n += 1
        self.calls.append([dict(m) for m in msgs])
        if self.n <= self.fail_times:
            raise agent_llm.LLMError(
                "LLM 调用失败(400): maximum context length is 32768 tokens. "
                "However, you requested 0 output tokens and your prompt contains at least 32769 input tokens"
            )
        return {"content": "折叠后继续", "tool_calls": []}


@pytest.mark.asyncio
async def test_runner_overflow_retry_last_user_no_new_session():
    """最近 user 很短时,半预算仍溢出则只留 system+该 user 再试,成功则不提新开会话。"""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="ovf2")
        s.add(tenant); s.commit(); s.refresh(tenant)
        user = User(email="ovf2@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        s.add(user); s.commit(); s.refresh(user)

        fake_llm = _OverflowThenOkLLM(fail_times=2)
        fake_tools = _FakeTools()
        fake_ctx = type("Ctx", (), {})()

        def svc(name):
            if name == "llm":
                return fake_llm
            if name == "tools":
                return fake_tools
            raise KeyError(name)

        fake_ctx.service = svc
        fake_settings = SimpleNamespace(agent_max_rounds=5, agent_context_budget=24000, agent_skills_topk=0)
        with patch.object(agent_runner, "get_ctx", lambda: fake_ctx), \
             patch.object(agent_runner, "nsfw_allowed", lambda u: False), \
             patch.object(agent_runner, "_rag_context", _noop_rag), \
             patch.object(agent_runner, "get_settings", lambda: fake_settings):
            events = [ev async for ev in agent_runner.run(
                [
                    {"role": "user", "content": "很久以前的问题"},
                    {"role": "assistant", "content": "很久以前的回答"},
                    {"role": "user", "content": "hi"},
                ],
                pool=None, user=user, session=s,
            )]

        assert fake_llm.n == 3
        assert events[-1]["type"] == "text" and events[-1]["content"] == "折叠后继续"
        joined = "\n".join(str(e.get("content") or "") for e in events)
        assert "新开会话" not in joined
        third = fake_llm.calls[2]
        assert third[0]["role"] == "system"
        assert [m["role"] for m in third[1:]] == ["user"]
        assert third[-1]["content"] == "hi"


@pytest.mark.asyncio
async def test_runner_uses_db_history_not_one_item_client_body():
    """续聊:agent_session 在时用库里的 user/assistant/tool,忽略客户端 1 条 body。"""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        tenant = Tenant(name="hist")
        s.add(tenant); s.commit(); s.refresh(tenant)
        user = User(email="hist@toiv.ai", hashed_password=hash_password("password1"), tenant_id=tenant.id)
        s.add(user); s.commit(); s.refresh(user)
        sess = AgentSession(user_id=user.id, title="hist")
        s.add(sess); s.commit(); s.refresh(sess)
        s.add(AgentMessage(session_id=sess.id, role="user", content="历史用户"))
        s.add(AgentMessage(
            session_id=sess.id, role="assistant", content="",
            tool_calls=json.dumps([
                {"id": "t1", "function": {"name": "list_models", "arguments": "{}"}},
            ]),
        ))
        s.add(AgentMessage(
            session_id=sess.id, role="tool", content="ckpt: a.safetensors",
            tool_calls=json.dumps({"tool_call_id": "t1", "name": "list_models", "args": {}}),
        ))
        s.add(AgentMessage(session_id=sess.id, role="assistant", content="已列出"))
        s.add(AgentMessage(session_id=sess.id, role="user", content="本轮新问题"))
        s.commit()

        fake_llm = _FakeLLM(rounds_before_final=0)
        fake_tools = _FakeTools()
        fake_ctx = type("Ctx", (), {})()

        def svc(name):
            if name == "llm":
                return fake_llm
            if name == "tools":
                return fake_tools
            raise KeyError(name)

        fake_ctx.service = svc
        fake_settings = SimpleNamespace(agent_max_rounds=5, agent_context_budget=24000, agent_skills_topk=0)
        with patch.object(agent_runner, "get_ctx", lambda: fake_ctx), \
             patch.object(agent_runner, "nsfw_allowed", lambda u: False), \
             patch.object(agent_runner, "_rag_context", _noop_rag), \
             patch.object(agent_runner, "get_settings", lambda: fake_settings):
            events = [ev async for ev in agent_runner.run(
                [{"role": "user", "content": "本轮新问题"}],
                pool=None, user=user, session=s, agent_session=sess,
            )]

        assert events[-1]["type"] == "text" and events[-1]["content"] == "完成"
        sent = fake_llm.calls[0]
        contents = [m.get("content") or "" for m in sent]
        assert "历史用户" in contents
        assert "本轮新问题" in contents
        assert "ckpt: a.safetensors" in contents
        assert any(m.get("tool_calls") for m in sent)
        assert any(m.get("role") == "tool" and m.get("tool_call_id") == "t1" for m in sent)
        assert len([m for m in sent if m.get("role") != "system"]) >= 5


def test_chat_request_accepts_over_40_and_single_continuation():
    from pydantic import ValidationError
    from app.routes.agent import ChatRequest

    body = ChatRequest.model_validate({
        "messages": [{"role": "user" if i % 2 == 0 else "assistant", "content": str(i)} for i in range(50)],
        "session_id": "s1",
    })
    assert len(body.messages) == 50
    one = ChatRequest.model_validate({
        "messages": [{"role": "user", "content": "下一句"}],
        "session_id": "s1",
    })
    assert len(one.messages) == 1
    long = ChatRequest.model_validate({
        "messages": [{"role": "user", "content": "汉" * 20000}],
    })
    assert len(long.messages[0].content) == 20000
    with pytest.raises(ValidationError):
        ChatRequest.model_validate({
            "messages": [{"role": "user", "content": "x"} for _ in range(201)],
        })

