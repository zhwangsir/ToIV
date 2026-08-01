"""LLM 输出 JSON 提取 —— 从模型文本里稳健地抽出 JSON 对象。

原 drama_image / drama_studio / manju / optimize 四处各持一份拷贝,合并于此。
容忍:思考标签 <think> 前缀、代码块包裹、JSON 前后多余文本。

anchors 参数化保留原两档行为:
- 不传(原 manju/optimize 版):think 剥离后直接首 { 到末 } 解析;
- 传入(原 drama_image/drama_studio 版):先按锚(如 '{"shots"')做平衡大括号
  匹配,精确锁定目标 JSON 块,避免思考段里散落的 {…} 示例被误当成最终结果。
"""
from __future__ import annotations

import json


def parse_json_obj(text: str, *, anchors: tuple[str, ...] = ()) -> dict | None:
    """从 LLM 文本里稳健地抽出 JSON 对象;失败返回 None。"""
    t = text.strip()
    # Qwen3 等思考型模型把推理过程包在 <think>...</think> 中,
    # 真正的 JSON 输出在 </think> 之后。剥离思考前缀,避免误把思考里
    # 出现的 {…} 示例当成最终 JSON。
    if "</think>" in t:
        t = t.split("</think>", 1)[1].strip()

    # 1) 锚定目标块:寻找 {"shots":... 这类完整 JSON 块(平衡大括号匹配)。
    #    即便思考段里散落 {…} 示例,也能精确锁定目标 JSON。
    for anchor in anchors:
        idx = t.find(anchor)
        if idx == -1:
            continue
        # 向左回溯到对应的左大括号
        start = t.rfind("{", 0, idx + 1)
        if start == -1:
            continue
        # 平衡大括号匹配,提取最外层完整 JSON
        depth = 0
        in_str = False
        escape = False
        for i in range(start, len(t)):
            ch = t[i]
            if in_str:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        candidate = t[start : i + 1]
                        try:
                            obj = json.loads(candidate)
                            if isinstance(obj, dict):
                                return obj
                        except (ValueError, TypeError):
                            pass
                        break
        # 当前 anchor 失败,换下一个

    # 2) 兜底:剥离代码块标记后,整体取首 { 到末 } 再试
    t_clean = t.strip()
    if t_clean.startswith("```"):
        # 去掉 ```json ... ``` 包裹
        t_clean = t_clean.split("\n", 1)[-1] if "\n" in t_clean else t_clean[3:]
        if t_clean.endswith("```"):
            t_clean = t_clean[:-3]
        t_clean = t_clean.strip()
    if "{" in t_clean and "}" in t_clean:
        candidate = t_clean[t_clean.index("{") : t_clean.rindex("}") + 1]
        try:
            obj = json.loads(candidate)
            return obj if isinstance(obj, dict) else None
        except (ValueError, TypeError):
            return None
    return None
