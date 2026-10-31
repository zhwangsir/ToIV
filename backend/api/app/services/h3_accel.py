"""H3 智能加速:按机读规格 profiles.json 把 ComfyUI prompt 改写为加速档。

档位:off(原生)/ lossless(无损加速)/ balanced(甜点位)/ extreme(极限加速)。
仅 H3 家族应用可接受非 off 值(判断口径与 routes/apps._pick_app_client 的
h3 路由一致:应用 id 前缀 h3-,或图内 class_type 含 MiniMaxH3/HailuoH3 家族)。

规格文件(并行基准 agent 产出,可能尚不存在 —— 缺失时优雅降级为原生提交,
不报错):.regen_tmp/h3_sglang_bench_20260912/profiles.json,可用环境变量
TOIV_H3_ACCEL_PROFILES_PATH 覆盖(config.h3_accel_profiles_path)。

安全门:档位 spec.recommended=false(基准方主动下架)→ 按原生提交(applied=false)。

Schema 契约(顶层 profiles key,按档位索引;全部 id 无关 —— 生产图与基准图节点 id 不同,
一律按 class_type 在图上定位):
{
  "profiles": {
    "<level>": {
      "label": "...", "speedup": 1.4, "recommended": true,
      "nodes_to_add": [                  # 追加节点;inputs 可用占位符按 class_type 解析:
        {                                #   ["<UNETLoader_node>", 0] → 图上 UNETLoader 节点
          "class_type": "FooPatch",      #   ["<SagePatch_node>", 0]  → class_type 含 "SagePatch"
          "inputs": {"model": ["<UNETLoader_node>", 0], ...}
        }                                # 追加后:原 model 头(BasicGuider/BasicScheduler/
      ],                                 # KSampler 的 inputs.model)自动改接最后一个追加节点输出
      "nodes_to_replace": {              # 按 class_type 原位换实现(连线保持,因节点 id 不变)
        "KSamplerSelect": {"class_type": "FooSampler", "patch_inputs": {...}}
      },
      "sampler_params": {                # 定向参数(按 key 落到指定类,绝不散落到全部采样节点):
        "steps": 50,                     #   steps→BasicScheduler/KSampler;scheduler→同;
        "sampler": "euler",              #   sampler→KSamplerSelect.sampler_name/KSampler.sampler_name;
        "flow_shift_video": 12.0         #   flow_shift_*→MiniMaxH3* 节点;占位符值(如
      }                                  #   "<MiniMaxH3TurboSampler>")跳过,由 nodes_to_replace 负责
    }
  }
}
改写后做连线校验:所有 [node_id, slot] 引用必须指向图内存在节点,否则整体降级原生提交。
"""
from __future__ import annotations

import copy
import json
import logging
import re
from pathlib import Path
from typing import Any

from app.config import get_settings

logger = logging.getLogger(__name__)

ACCEL_LEVELS: tuple[str, ...] = ("off", "lossless", "balanced", "extreme")

# H3 家族 class_type 判定(与 routes/apps._pick_app_client 同一口径)。
_H3_PREFIXES = ("MiniMaxH3", "MinimaxH3", "RHMiniMaxH3", "RHMinimaxH3", "RH_MinimaxHailuoH3", "HailuoH3")
_H3_MARKERS = ("MiniMaxH3", "MinimaxH3", "HailuoH3")

# 社区参考倍率(规格文件缺失/档位缺省时前端展示用,注明「参考」)。
REFERENCE_PROFILES: dict[str, dict[str, Any]] = {
    "lossless": {"label": "无损加速", "speedup": 1.4},
    "balanced": {"label": "甜点位", "speedup": 2.0},
    "extreme": {"label": "极限加速", "speedup": 3.2},
}

_DEFAULT_SPEC_REL = Path(".regen_tmp") / "h3_sglang_bench_20260912" / "profiles.json"

_PLACEHOLDER_RE = re.compile(r"^<(.+)>$")

# sampler_params 定向落点:参数 key → (目标 class_type 候选元组, 目标 input key)。
# 只落第一命中类;未知 key 一律跳过(2026-09-12 教训:盲合并曾把 "sampler":"euler"
# 字符串写进 SamplerCustomAdvanced.sampler 对象槽,执行期 'str' has no 'sample')。
_PARAM_TARGETS: dict[str, tuple[tuple[str, ...], str]] = {
    "steps": (("BasicScheduler", "KSampler"), "steps"),
    "scheduler": (("BasicScheduler", "KSampler"), "scheduler"),
    "sampler": (("KSamplerSelect", "KSampler"), "sampler_name"),
    "flow_shift_video": (_H3_PREFIXES, "flow_shift_video"),
    "flow_shift_audio": (_H3_PREFIXES, "flow_shift_audio"),
}

# model 头消费类:追加节点(model 链环)接入后,这些节点的 inputs.model 改接链尾输出。
_MODEL_CONSUMER_CLASSES = ("BasicGuider", "BasicScheduler", "KSampler")

_spec_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}


def validate_acceleration(v: object) -> str:
    """档位校验:pydantic field_validator 用,非法值抛 ValueError → 422。"""
    level = "off" if v is None else str(v).strip().lower()
    if level not in ACCEL_LEVELS:
        raise ValueError(f"acceleration 须为 {' / '.join(ACCEL_LEVELS)} 之一")
    return level


def is_h3_family(app_id: object, nodes: object) -> bool:
    """H3 家族判定:与 _pick_app_client 的 h3 路由同一口径(id 前缀 h3- 或节点家族)。"""
    if isinstance(app_id, str) and app_id.startswith("h3-"):
        return True
    for n in nodes or ():
        if isinstance(n, str) and (
            n.startswith(_H3_PREFIXES) or any(m in n for m in _H3_MARKERS)
        ):
            return True
    return False


def default_spec_path() -> Path:
    """规格文件默认路径:仓库根 .regen_tmp/...(可用 settings/env 覆盖)。"""
    override = (get_settings().h3_accel_profiles_path or "").strip()
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[4] / _DEFAULT_SPEC_REL


def load_profiles(path: str | Path | None = None) -> dict[str, Any] | None:
    """读规格文件;缺失/损坏/无 profiles key → None(调用方优雅降级)。"""
    p = Path(path) if path is not None else default_spec_path()
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return None
    cached = _spec_cache.get(str(p))
    if cached and cached[0] == mtime:
        return cached[1]
    data: dict[str, Any] | None = None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("profiles"), dict):
            data = raw["profiles"]
        else:
            logger.warning("h3 accel 规格 %s 缺 profiles key,忽略", p)
    except (OSError, ValueError) as e:
        logger.warning("h3 accel 规格 %s 读取失败(%s),忽略", p, e)
    _spec_cache[str(p)] = (mtime, data)
    return data


def _first_node_id_by_class(out: dict, classes: tuple[str, ...]) -> str | None:
    """按 class_type 找第一个节点 id —— 全图 id 无关定位。
    先精确匹配(防 KSamplerSelect 被 "KSampler" 前缀误吞),再无精确命中时前缀匹配。"""
    for want in classes:
        for nid, node in out.items():
            if isinstance(node, dict) and node.get("class_type") == want:
                return nid
    for want in classes:
        for nid, node in out.items():
            if isinstance(node, dict) and isinstance(node.get("class_type"), str):
                if node["class_type"].startswith(want):
                    return nid
    return None


def _words(token: str) -> frozenset[str]:
    """Pascal/驼峰拆词(大小写运行 + 数字附着):SagePatch→{sage,patch};
    UNETLoader→{unet,loader};MiniMaxH3TurboSampler→{minimax,h3,turbo,sampler}。"""
    parts = re.findall(r"[A-Z]+(?![a-z])|[A-Z][a-z]*[0-9]*|[0-9]+", token)
    return frozenset(p.lower() for p in parts if p and not p.isdigit())


def _resolve_placeholder(token: str, out: dict, added_ids: list[str]) -> str | None:
    """占位符(如 UNETLoader_node / SagePatch_node / MiniMaxH3TurboSampler)→ 节点 id。
    先查本批追加节点(按序,后面的可引用前面的),再查原图;
    词集包含匹配(class 词集 ⊇ 占位符词集),id 无关且容忍命名变体(SagePatch→SageAttentionPatch)。"""
    stem = token[:-5] if token.endswith("_node") else token
    want = _words(stem)
    if not want:
        return None
    candidates: list[str] = [*added_ids, *[k for k in out.keys() if k not in added_ids]]
    for nid in candidates:
        ct = out.get(nid, {}).get("class_type", "")
        if isinstance(ct, str) and want.issubset(_words(ct)):
            return nid
    return None


def _resolve_placeholders(value: Any, out: dict, added_ids: list[str]) -> Any:
    """递归解析 inputs 里的占位符:["<X>", slot] → [node_id, slot];纯字符串占位符同理。"""
    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], int):
        m = _PLACEHOLDER_RE.match(value[0])
        if m:
            nid = _resolve_placeholder(m.group(1), out, added_ids)
            if nid is None:
                raise ValueError(f"加速规格占位符 <{m.group(1)}> 在图上无匹配节点")
            return [nid, value[1]]
        return [copy.deepcopy(value[0]), value[1]]
    if isinstance(value, str):
        m = _PLACEHOLDER_RE.match(value)
        if m:
            nid = _resolve_placeholder(m.group(1), out, added_ids)
            if nid is None:
                raise ValueError(f"加速规格占位符 <{m.group(1)}> 在图上无匹配节点")
            return nid
        return value
    if isinstance(value, dict):
        return {k: _resolve_placeholders(v, out, added_ids) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_placeholders(v, out, added_ids) for v in value]
    return copy.deepcopy(value)


def _validate_links(out: dict) -> list[str]:
    """连线校验:所有 [node_id, slot] 引用必须指向图内存在节点。返回问题列表(空=通过)。"""
    problems: list[str] = []
    for nid, node in out.items():
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            continue
        for key, value in node["inputs"].items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], int):
                if value[0] not in out:
                    problems.append(f"节点 {nid}.{key} 引用不存在的节点 {value[0]}")
    return problems


def _degrade(out: dict, level: str, reason: str) -> tuple[dict, bool]:
    logger.warning("h3 accel %s 档 %s,按原生提交", level, reason)
    return out, False


def apply_acceleration(
    graph: dict,
    level: str,
    *,
    profiles: dict[str, Any] | None = None,
) -> tuple[dict, bool]:
    """按档位改写 prompt。返回 (新图, 是否实际生效)。

    - off / 档位未知 / recommended=false / 规格缺失 / 占位符无法解析 / 连线校验失败:
      一律原样(deepcopy)返回,applied=False —— 宁可不加速,不提交坏图。
    - 支持两种生产图形状:SamplerCustomAdvanced 三元组链(KSamplerSelect/
      BasicScheduler/BasicGuider)与直连 KSampler;全部按 class_type 定位,id 无关。
    """
    out = copy.deepcopy(graph)
    if level == "off":
        return out, False
    specs = profiles if profiles is not None else load_profiles()
    spec = (specs or {}).get(level)
    if not isinstance(spec, dict):
        return _degrade(out, level, "规格缺失或无该档")
    # 安全门:基准方 recommended=false(质量/接线待修)→ 原生提交
    if spec.get("recommended") is False:
        return _degrade(out, level, "recommended=false(基准方下架)")

    try:
        # ① nodes_to_replace:原位换实现(节点 id 不变 → 既有连线保持有效)。
        #    spec 用 "inputs" 键 → 整组替换原 inputs(如 TurboSampler 的 {});
        #    旧契约 "patch_inputs" → 合并(向后兼容)。
        n_replaced = 0
        replaced = spec.get("nodes_to_replace") or {}
        if isinstance(replaced, dict):
            for node in out.values():
                if not isinstance(node, dict):
                    continue
                ct = node.get("class_type")
                if ct in replaced and isinstance(replaced[ct], dict):
                    new_ct = replaced[ct].get("class_type")
                    if isinstance(new_ct, str) and new_ct:
                        node["class_type"] = new_ct
                    if "inputs" in replaced[ct]:
                        node["inputs"] = copy.deepcopy(replaced[ct]["inputs"] or {})
                    else:
                        patch = replaced[ct].get("patch_inputs")
                        if isinstance(patch, dict):
                            node.setdefault("inputs", {}).update(copy.deepcopy(patch))
                    n_replaced += 1

        # ② nodes_to_add:占位符解析后追加;再 model 链改接(BasicGuider/BasicScheduler/
        #    KSampler 的 inputs.model 从原头改接最后一个追加节点输出)
        added_ids: list[str] = []
        add = spec.get("nodes_to_add") or []
        if isinstance(add, list):
            for i, item in enumerate(add):
                if not isinstance(item, dict) or not isinstance(item.get("class_type"), str):
                    continue
                key = str(item.get("key") or f"h3accel_{i}")
                base, n = key, 1
                while key in out:
                    key = f"{base}_{n}"
                    n += 1
                inputs = _resolve_placeholders(item.get("inputs") or {}, out, added_ids)
                out[key] = {"class_type": item["class_type"], "inputs": inputs}
                added_ids.append(key)
        if added_ids:
            head_id = None
            for cls in _MODEL_CONSUMER_CLASSES:
                nid = _first_node_id_by_class(out, (cls,))
                if nid and isinstance(out[nid].get("inputs"), dict):
                    ref = out[nid]["inputs"].get("model")
                    if isinstance(ref, list) and len(ref) == 2:
                        head_id = ref[0]
                        break
            tail_id = added_ids[-1]
            if head_id is None:
                head_id = _first_node_id_by_class(out, ("UNETLoader",))
            if head_id is None:
                raise ValueError("加速改写找不到 model 头(UNETLoader/采样链)")
            n_rewired = 0
            for nid, node in out.items():
                if nid in added_ids or not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
                    continue
                if node["inputs"].get("model") == [head_id, 0]:
                    node["inputs"]["model"] = [tail_id, 0]
                    n_rewired += 1
            if n_rewired == 0:
                logger.warning("h3 accel %s 档:未找到 model 头消费者(BasicGuider/Scheduler),追加节点悬空", level)

        # ③ sampler_params:定向落点(见 _PARAM_TARGETS),占位符值跳过,未知 key 跳过
        n_patched = 0
        sampler_params = spec.get("sampler_params") or {}
        if isinstance(sampler_params, dict):
            for key, value in sampler_params.items():
                if isinstance(value, str) and _PLACEHOLDER_RE.match(value):
                    continue  # 占位符值(如 <MiniMaxH3TurboSampler>)由 nodes_to_replace 负责
                target = _PARAM_TARGETS.get(key)
                if target is None:
                    logger.warning("h3 accel %s 档:sampler_params.%s 无定向落点,跳过", level, key)
                    continue
                classes, input_key = target
                nid = _first_node_id_by_class(out, classes)
                if nid is None:
                    continue
                out[nid].setdefault("inputs", {})[input_key] = copy.deepcopy(value)
                n_patched += 1

        # ④ 连线校验:任何悬空引用 → 整体降级(不提交坏图)
        problems = _validate_links(out)
        if problems:
            for p in problems[:5]:
                logger.warning("h3 accel 连线校验: %s", p)
            return _degrade(out, level, "连线校验失败")

        if not (n_replaced or added_ids or n_patched):
            return _degrade(out, level, "规格为空改写")
        logger.info(
            "h3 accel %s 档生效:replace=%d add=%d rewire_head=%s sampler_patch=%d nodes=%d",
            level, n_replaced, len(added_ids),
            (added_ids[-1] if added_ids else "-"), n_patched, len(out),
        )
        return out, True
    except (ValueError, TypeError) as e:
        return _degrade(out, level, f"改写失败({e})")


def profile_summaries(path: str | Path | None = None) -> dict[str, Any]:
    """前端选择器用档位摘要:实测优先,缺失档位回落社区参考值并注明来源。

    每档带 recommended(规格文件 recommended=false=基准方下架 → 前端置灰「暂不可用」);
    参考值兜底与 off 档无下架语义,恒 True。
    """
    measured = load_profiles(path) or {}
    levels = []
    for level in ACCEL_LEVELS:
        if level == "off":
            levels.append({
                "level": level, "label": "关闭", "speedup": None,
                "source": "reference", "recommended": True,
            })
            continue
        spec = measured.get(level)
        if isinstance(spec, dict) and isinstance(spec.get("speedup"), (int, float)):
            levels.append({
                "level": level,
                "label": str(spec.get("label") or REFERENCE_PROFILES[level]["label"]),
                "speedup": float(spec["speedup"]),
                "source": "measured",
                "recommended": spec.get("recommended") is not False,
            })
        else:
            ref = REFERENCE_PROFILES[level]
            levels.append({
                "level": level,
                "label": ref["label"],
                "speedup": ref["speedup"],
                "source": "reference",
                "recommended": True,
            })
    return {"levels": levels, "default": "off"}
