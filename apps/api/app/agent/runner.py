"""智能体主循环:LLM 工具调用 → 执行 ComfyUI 能力 → 回灌结果,流式产出事件。"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

from app.agent import llm, tools
from app.comfy.pool import WorkerPool
from app.models import User

SYSTEM = """你是 ToIV——一个由 ComfyUI 集群驱动的 AI 创作平台的智能助手。
你能通过工具实时为用户生成内容并直接展示结果:
- generate_image:文生图(海报/插画/照片/概念图等)
- generate_music:文生音乐(BGM/纯音乐/带词歌曲)
- list_models:查询可用的图像大模型

原则:
1. 用户表达创作意图时,主动调用相应工具完成,而不是只给建议。
2. 提示词尽量优化(补充风格、光影、质量词);除非用户指定,图片默认 1:1。
3. 工具会把图片/音乐直接展示给用户,你只需简洁说明你做了什么、给点搭配建议。
4. 用中文,简洁友好。一次对话可多次调用工具(如"生成4张不同风格")。
5. 闲聊或咨询类问题直接回答,不必调用工具。"""

_MAX_ROUNDS = 6


async def run(
    messages: list[dict], pool: WorkerPool, user: User, session
) -> AsyncIterator[dict]:
    msgs: list[dict] = [{"role": "system", "content": SYSTEM}, *messages]

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
            text, events = await tools.execute(name, args, pool, user, session)
            for ev in events:
                yield ev
            msgs.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": text})

    yield {"type": "text", "content": "(已达到最大处理步数,请精简需求后重试)"}
