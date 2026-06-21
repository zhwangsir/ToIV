"""智能体主循环:LLM 工具调用 → 执行 ComfyUI 能力 → 回灌结果,流式产出事件。"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

from app.agent import llm, tools
from app.agent.rag import get_kb
from app.comfy.pool import WorkerPool
from app.models import User

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


async def _rag_context(messages: list[dict]) -> str | None:
    """对最近一条用户消息做向量检索,拼成背景知识块。"""
    last_user = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
    if not last_user:
        return None
    chunks = await get_kb().retrieve(last_user, k=4)
    if not chunks:
        return None
    body = "\n\n".join(f"### {c.title}\n{c.text}" for c in chunks)
    return f"以下是可能相关的平台知识(供你参考,不必逐条复述给用户):\n\n{body}"


async def run(
    messages: list[dict], pool: WorkerPool, user: User, session,
    attachment: dict | None = None,
) -> AsyncIterator[dict]:
    msgs: list[dict] = [{"role": "system", "content": SYSTEM}]
    context = await _rag_context(messages)
    if context:
        msgs.append({"role": "system", "content": context})
    if attachment and attachment.get("filename"):
        msgs.append({
            "role": "system",
            "content": "用户本轮上传了一张图片。若用户想修改/重绘它,调用 edit_image;"
                       "若想把它转成 3D 模型,调用 generate_3d(无需再描述)。",
        })
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
            text, events = await tools.execute(name, args, pool, user, session, attachment)
            for ev in events:
                yield ev
            msgs.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": text})

    yield {"type": "text", "content": "(已达到最大处理步数,请精简需求后重试)"}
