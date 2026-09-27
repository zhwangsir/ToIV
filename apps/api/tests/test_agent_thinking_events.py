"""助手思考展示(2026-09-28):_merge_reasoning 归一化 _reasoning + runner thinking done 事件。"""
import time

from app.agent import llm
from app.agent import runner as agent_runner


def test_merge_reasoning_keeps_field_reasoning_when_content_present():
    msg = {"role": "assistant", "content": "答案", "reasoning_content": "先想想"}
    out = llm._merge_reasoning(msg)
    assert out["content"] == "答案"
    assert out["_reasoning"] == "先想想"


def test_merge_reasoning_extracts_inline_think():
    msg = {"role": "assistant", "content": "<think>分析一下</think>正式回答"}
    out = llm._merge_reasoning(msg)
    assert out["content"] == "正式回答"
    assert out["_reasoning"] == "分析一下"


def test_merge_reasoning_backfilled_answer_not_duplicated_as_thought():
    msg = {"role": "assistant", "content": "", "reasoning": "只有推理"}
    out = llm._merge_reasoning(msg)
    assert out["content"] == "只有推理"
    assert out["_reasoning"] == ""


def test_thinking_done_event_merges_chatter_and_truncates():
    ev = agent_runner._thinking_done_event(
        {"_reasoning": "推理"}, "I will call the tool", 2, time.monotonic() - 1.5,
    )
    assert ev["type"] == "thinking" and ev["status"] == "done" and ev["round"] == 2
    assert ev["content"] == "推理\n\nI will call the tool"
    assert ev["elapsed_ms"] >= 1400
    long = agent_runner._thinking_done_event(
        {"_reasoning": "x" * 9000}, "", 1, time.monotonic(),
    )
    assert len(long["content"]) == agent_runner.THINKING_MAX_CHARS + 1
