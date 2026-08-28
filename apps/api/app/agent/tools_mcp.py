"""MCP 工具适配器 —— 把 comfyui-mcp 暴露的工具转成 ToolSpec 注册到 ToolRegistry。

设计:
- 从 MCP server 拉取 tools/list,动态生成 ToolSpec
- 每个 MCP 工具映射为一个 OpenAI function calling tool
- 工具名加 mcp__ 前缀防命名冲突
- 执行器:调 MCP tools/call,结果文本回给 LLM
- 只对助手暴露安全的只读/查询类工具;生成/修改类工具走现有 submit_generation 体系
"""
from __future__ import annotations

import json
import logging
from typing import Any

from app.harness.tool_seam import ToolSpec
from app.services.mcp_client import call_mcp_tool, is_mcp_enabled, list_mcp_tools

logger = logging.getLogger(__name__)

# 允许暴露给助手的 MCP 工具白名单(只读/查询/轻量操作类)
# 生成类(submit_generation)和系统管理类(restart/install)不暴露,走现有体系
_ALLOWED_TOOLS: set[str] = {
    # 查询类
    "get_system_stats",
    "queue",
    "get_history",
    "get_image",
    "list_local_models",
    "search_custom_nodes",
    "get_workflow",
    "list_api_nodes",
    "get_defaults",
    "model_metadata",
    "node_snapshot",
    # 工作流查看/可视化(不执行)
    "visualize_workflow",
    "calculate",
    # 轻量操作
    "upload_image",
    "clear_vram",
    # 节点搜索
    "node_pack",
    "list_packs",
}

# 工具名 → 中文一句话说明(给 SYSTEM prompt 用)
_TOOL_SUMMARIES: dict[str, str] = {
    "get_system_stats": "查询 ComfyUI 实例系统状态(GPU/VRAM/RAM)",
    "queue": "查看 ComfyUI 队列状态( pending/running 作业)",
    "get_history": "查询 ComfyUI 历史作业结果",
    "get_image": "获取 ComfyUI 生成的图片(按文件名)",
    "list_local_models": "列出 ComfyUI 可用的模型文件",
    "search_custom_nodes": "搜索 ComfyUI 自定义节点",
    "get_workflow": "查看 ComfyUI 工作流详情",
    "list_api_nodes": "列出 ComfyUI API 节点",
    "get_defaults": "获取 ComfyUI 默认参数",
    "model_metadata": "查询模型元数据(类型/大小/哈希)",
    "node_snapshot": "ComfyUI 节点快照(当前安装状态)",
    "visualize_workflow": "可视化 ComfyUI 工作流图(mermaid)",
    "calculate": "计算表达式(参数换算等)",
    "upload_image": "上传图片到 ComfyUI input 目录",
    "clear_vram": "清理 ComfyUI VRAM 缓存",
    "node_pack": "查询 ComfyUI 节点包详情",
    "list_packs": "列出 ComfyUI 节点包模板",
}


async def _make_mcp_executor(tool_name: str):
    """为 MCP 工具生成执行器。"""

    async def _exec(args: dict, ctx: dict) -> tuple[str, list[dict]]:
        try:
            result = await call_mcp_tool(tool_name, args)
            # MCP 返回 {content: [{type: "text", text: "..."}]}
            content = result.get("content", [])
            if content and isinstance(content, list):
                texts = [c.get("text", "") for c in content if c.get("type") == "text"]
                text = "\n".join(texts) if texts else json.dumps(result, ensure_ascii=False, default=str)
            else:
                text = json.dumps(result, ensure_ascii=False, default=str)
            # 截断过长文本(防 LLM 上下文爆炸)
            if len(text) > 8000:
                text = text[:8000] + "\n...(截断)"
            return text, []
        except Exception as e:
            logger.warning("MCP tool %s failed: %s", tool_name, e)
            return f"MCP 工具 {tool_name} 调用失败: {e}", []

    return _exec


def _mcp_tool_to_openai_schema(mcp_tool: dict) -> dict:
    """把 MCP 工具的 inputSchema 转成 OpenAI function calling schema。"""
    name = f"mcp__{mcp_tool['name']}"
    description = mcp_tool.get("description", "")
    input_schema = mcp_tool.get("inputSchema", {})
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": f"[ComfyUI MCP] {description}",
            "parameters": input_schema,
        },
    }


async def mcp_tool_specs() -> list[ToolSpec]:
    """从 MCP server 拉取工具列表,生成 ToolSpec 列表。

    只暴露白名单内的工具;MCP 不可达时返回空列表(不阻塞启动)。
    """
    if not is_mcp_enabled():
        return []
    try:
        tools = await list_mcp_tools()
    except Exception as e:
        logger.warning("MCP tools/list 失败,跳过 MCP 工具注册: %s", e)
        return []

    specs: list[ToolSpec] = []
    for tool in tools:
        name = tool.get("name", "")
        if name not in _ALLOWED_TOOLS:
            continue
        schema = _mcp_tool_to_openai_schema(tool)
        summary = _TOOL_SUMMARIES.get(name, tool.get("description", "")[:50])
        executor = await _make_mcp_executor(name)
        specs.append(ToolSpec(
            name=schema["function"]["name"],
            schema=schema,
            executor=executor,
            summary=summary,
            rate_scope="",  # 只读工具不记配额
        ))
    logger.info("MCP 工具注册: %d 个(白名单 %d 个,总可用 %d 个)",
                len(specs), len(_ALLOWED_TOOLS), len(tools))
    return specs
