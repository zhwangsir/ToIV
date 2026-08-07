"""智能体主循环:LLM 工具调用 → 执行 ComfyUI 能力 → 回灌结果,流式产出事件。"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

from sqlmodel import Session, select

from app.agent import llm, tools
from app.agent.rag import get_kb
from app.comfy.pool import WorkerPool
from app.models import Document, User
from app.services import docs as docsvc

SYSTEM = """你是 ToIV——一个由 ComfyUI 集群驱动的 AI 创作平台的智能助手。
你能通过工具实时为用户生成内容并直接展示结果:
- generate_image:文生图(海报/插画/照片/概念图等)
- generate_video:文生视频(把画面"动起来",约 1-2 分钟,调用前先告知用户需稍候)
- generate_music:文生音乐(BGM/纯音乐/带词歌曲)
- edit_image:图生图/重绘(仅当用户本轮上传了图片且想修改它时)
- generate_3d:生成可旋转的 3D 模型(有上传图则用该图转,否则按描述先出图再转;约 1-3 分钟)
- list_models:查询可用的图像大模型
- search_knowledge:检索平台知识库(ComfyUI 节点/工作流配方/模型/提示词)
- run_workflow:提交自定义 ComfyUI 工作流图(标准工具满足不了时;搭图前先 search_knowledge 查配方与真实模型名)

原则:
1. 用户表达创作意图时,主动调用相应工具完成,而不是只给建议。
2. 提示词尽量优化(补充风格、光影、质量词);除非用户指定,图片默认 1:1。
3. 工具会把图片/视频/音乐直接展示给用户,你只需简洁说明你做了什么、给点搭配建议。
4. 用中文,简洁友好。一次对话可多次调用工具(如"生成4张不同风格")。
5. 闲聊或咨询类问题直接回答,不必调用工具。
6. 需要 ComfyUI/模型/参数细节或要搭自定义工作流时,先用 search_knowledge 查证再动手;不要编造不存在的模型名或节点。"""

_MAX_ROUNDS = 8
# 挂载文档检索注入的上限:top-k 块数 × 单块 ≤900 字符,控制注入体量不挤爆上下文
_DOC_TOP_K = 6


def _last_user_msg(messages: list[dict]) -> str:
    return next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")


async def _rag_context(messages: list[dict]) -> str | None:
    """对最近一条用户消息做向量检索,拼成背景知识块。"""
    last_user = _last_user_msg(messages)
    if not last_user:
        return None
    chunks = await get_kb().retrieve(last_user, k=4)
    if not chunks:
        return None
    body = "\n\n".join(f"### {c.title}\n{c.text}" for c in chunks)
    return f"以下是可能相关的平台知识(供你参考,不必逐条复述给用户):\n\n{body}"


async def _docs_context(
    messages: list[dict], document_ids: list[str], user: User, session: Session
) -> str | None:
    """对用户挂载的文档做余弦 top-k 检索,拼成文档片段块(embedding 不可用→空)。"""
    if not document_ids:
        return None
    last_user = _last_user_msg(messages)
    if not last_user:
        return None
    rows = session.exec(
        select(Document).where(
            Document.user_id == user.id, Document.id.in_(document_ids)  # type: ignore[attr-defined]
        )
    ).all()
    hits = await docsvc.retrieve(list(rows), last_user, k=_DOC_TOP_K)
    if not hits:
        return None
    body = "\n\n".join(f"### 《{h.filename}》片段\n{h.text}" for h in hits)
    return (
        "用户为本轮对话挂载了文档。以下是与最新消息最相关的文档片段,"
        "优先据此回答(可注明出自哪篇文档,不必逐条复述):\n\n" + body
    )


async def run(
    messages: list[dict], pool: WorkerPool, user: User, session,
    attachment: dict | None = None,
    document_ids: list[str] | None = None,
) -> AsyncIterator[dict]:
    # 把所有 system 内容拼到开头唯一一条 system 消息里(vLLM 要求 system 只能在消息列表开头,
    # 多条 system 会被拒绝;LM Studio 宽容但不保证)。用换行 + 分隔标记区分各段。
    sys_parts: list[str] = [SYSTEM]
    context = await _rag_context(messages)
    if context:
        sys_parts.append(context)
    docs_context = await _docs_context(messages, document_ids or [], user, session)
    if docs_context:
        sys_parts.append(docs_context)
    if attachment and attachment.get("filename"):
        sys_parts.append(
            "用户本轮上传了一张图片。若用户想修改/重绘它,调用 edit_image;"
            "若想把它转成 3D 模型,调用 generate_3d(无需再描述)。"
        )
    msgs: list[dict] = [{"role": "system", "content": "\n\n".join(sys_parts)}]
    msgs.extend(messages)

    for _ in range(_MAX_ROUNDS):
        try:
            assistant = await llm.chat(msgs, tools=tools.TOOL_SCHEMAS)
        except llm.LLMError as e:
            yield {"type": "error", "content": str(e)}
            return

        tool_calls = assistant.get("tool_calls") or []
        content = assistant.get("content") or ""
        if content:
            yield {"type": "text", "content": content}
        if not tool_calls:
            return

        msgs.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
        for tc in tool_calls:
            fn = tc.get("function", {})
            name = fn.get("name", "")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            yield {"type": "tool", "name": name, "args": args}
            text, events = await tools.execute(
                name, args, pool, user, session, attachment
            )
            for ev in events:
                yield ev
            msgs.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": text})

    yield {"type": "text", "content": "(已达到最大处理步数,请精简需求后重试)"}
