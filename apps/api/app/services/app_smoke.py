"""应用烟测 + 自愈归因(Phase 1 自愈闭环,2026-09-15)。

目标:新导入/存量大市场的每个应用都能被**自动真跑一遍**(fixture 媒体 + 默认参数),
失败给出结构化归因;可修复类(combo 漂移/类名别名)先走确定性修复器重试一次。

口径与 wave runner 一致但服务化:
- classify_failure:错误文本+node_errors → 归因类(与 BUG_REGISTRY 分类法对齐)
- run_app_smoke:默认参数 + fixture 媒体 → _build_graph → 选 worker → 上传/转运 →
  提交 → 轮询 → 归因落库(App.smoke_*)
- _combo_repair:首跑校验失败时,拉目标实例 object_info,把「不在列表」的
  模型文件名/节点类名改写到最接近的在列变体( stem 归一相似度),重建重提一次
"""
from __future__ import annotations

import asyncio
import copy
import logging
import re
from datetime import datetime
from pathlib import Path

from sqlmodel import Session, select

from app.config import get_settings
from app.db import engine
from app.models import App
from app.comfy.pool import WorkerPool

_FIXTURES = Path(__file__).resolve().parent.parent / "data" / "fixtures"
_MEDIA_FIXTURE = {
    "images": ("face_ref.png", "image/png"),
    "image": ("face_ref.png", "image/png"),
    "video": ("drive_2s.mp4", "video/mp4"),
    "audio": ("dlg_h3b.wav", "audio/wav"),
}
_SMKE_TIMEOUT = {"image": 480, "audio": 480, "video": 1800}
# O3 超时分级:output_kind=image 但图里跑视频/大模型链(wan 图生视频输出帧序列、
# 27B LLM 分镜、RIFE/SeedVR2/FlashVSR 超分插帧)按视频档计时。烟测超时并不会
# 取消 worker 上的作业,GPU 时间照样花掉,480s 只会把「慢但能出」误记 timeout,
# 还让下一张卡排队连带超时(2026-09-25 rh-acc-2804021249 实证)。
_HEAVY_CLASS_MARKERS = (
    "WanVideo", "WanImageToVideo", "WanFirstLastFrame", "WanAnimate", "WanVace",
    "LTXV", "HunyuanVideo", "HyVideo", "SeedVR2", "FlashVSR", "RIFE", "VFI",
    "llama_cpp", "SVD_img2vid", "CogVideo", "Mochi",
)
_HEAVY_WEIGHT_MARKERS = ("wan2", "wan_2", "ltx", "hunyuan", "cogvideo", "mochi")
_SMKE_TIMEOUT_MAX = 3600


def smoke_limit(graph: dict, output_kind: str, override: int | None = None) -> int:
    """烟测轮询上限(秒):显式 override 优先;image/audio 图含重链时升到视频档。"""
    if override:
        return max(60, min(int(override), _SMKE_TIMEOUT_MAX))
    base = _SMKE_TIMEOUT.get(output_kind, 300)
    if base >= _SMKE_TIMEOUT["video"]:
        return base
    for n in (graph or {}).values():
        if not isinstance(n, dict):
            continue
        ct = str(n.get("class_type") or "")
        if any(m in ct for m in _HEAVY_CLASS_MARKERS):
            return _SMKE_TIMEOUT["video"]
        if ct in ("UNETLoader", "CheckpointLoaderSimple"):
            name = str((n.get("inputs") or {}).get("unet_name")
                       or (n.get("inputs") or {}).get("ckpt_name") or "").lower()
            if any(m in name for m in _HEAVY_WEIGHT_MARKERS):
                return _SMKE_TIMEOUT["video"]
    return base
_SMKE_ERROR_MAX = 300

_SMKE_TASK: asyncio.Task | None = None
_SMKE_SUMMARY: dict | None = None


def _missing_binding_targets(workflow: dict, bindings: dict) -> set[str]:
    """返回 bindings 指向、但 workflow 里已不存在的节点 id 集合。

    用于拒绝「删掉了表单绑定目标」的 LLM 补丁:那种图跑起来会在 _write_leaf 抛 422
    「绑定 X 指向不存在的节点 N」,并被归因成 app_data,把首跑的真实失败原因盖掉。
    """
    present = {str(nid) for nid, node in (workflow or {}).items() if isinstance(node, dict)}
    missing: set[str] = set()
    for tgt in (bindings or {}).values():
        if isinstance(tgt, dict) and tgt.get("node") is not None:
            nid = str(tgt["node"])
            if nid not in present:
                missing.add(nid)
    return missing


# ---------------------------------------------------------------------------
# 归因器:错误文本 + node_errors → 结构化类(与 BUG_REGISTRY/whitepaper 分类法对齐)
# ---------------------------------------------------------------------------
def classify_failure(message: str, node_errors: dict | None = None) -> dict:
    """返回 {cls, detail};cls ∈ ok 之外的九类,repairable 标记确定性修复器可处理。"""
    m = message or ""
    low = m.lower()
    ne = node_errors or {}

    def _has(pat: str) -> bool:
        return pat in low

    if _has("缺模型"):
        cls = "missing_model"
        detail = m[:160]
    elif _has("缺节点"):
        cls = "missing_node"
        detail = m[:160]
    elif _has("missing_node_type") or _has("not found. the custom node"):
        cls = "missing_node"
        detail = _first_json_field(m, "class_type") or m[:160]
    elif _has("not in list") and ("value_not_in_list" in low or "value not in list" in low):
        # 只有「文件名」不在下拉里才算缺权重;sampler_name/scheduler 等枚举值缺失
        # 是自定义节点包没装(2026-09-27 rh-acc-5812480002 res_2s_ode 需 RES4LYF,
        # 曾被误归 missing_model 派给模型下载)。
        field, val = _not_in_list_field_value(m)
        if field in _ENUM_FROM_NODE_PACK_FIELDS and val and not _looks_like_model_file(val):
            cls = "missing_node"
            detail = f"{field}: {val}(枚举值由自定义节点包提供)"
        elif val and not _looks_like_model_file(val):
            cls = "validation"
            detail = f"{field}: {val}" if field else (_first_not_in_list(m) or m[:160])
        else:
            cls = "missing_model"
            detail = _first_not_in_list(m) or m[:160]
    elif _has("required_input_missing") or _has("required input is missing") or _has("prompt_outputs_failed_validation"):
        cls = "validation"
        detail = m[:160]
    elif "mat1 and mat2" in m or _has("cuda error") or _has("integer overflow") or _has("kernel"):
        cls = "runtime_cuda"
        detail = m[:160]
    elif _has("out of memory") or _has("内存不足") or _has("显存不足"):
        cls = "resource"
        detail = m[:160]
    elif _has("still queued") or _has("queued_timeout"):
        cls = "timeout"
        detail = "queued timeout"
    elif _has("timed out") or _has("poll exceeded"):
        cls = "timeout"
        detail = m[:160]
    elif _has("无法转运") or _has("connection") or _has("upload"):
        cls = "transport"
        detail = m[:160]
    elif _has("no face detected") or _has("division by zero") or _has("lora_a.weight") or _has("ext"):
        cls = "app_data"
        detail = m[:160]
    else:
        cls = "product"
        detail = m[:160]
    return {"cls": cls, "detail": detail, "repairable": cls in ("missing_node", "missing_model")}


def _first_json_field(message: str, field: str) -> str:
    """错误文本内嵌 JSON 时抽 extra_info.<field>。"""
    mobj = re.search(r'\{\\"error\\".*', message) or re.search(r'\{"error".*', message)
    if not mobj:
        return ""
    seg = mobj.group(0)
    m2 = re.search(rf'\\"{field}\\": \\"([^"\\]+)\\"', seg) or re.search(rf'"{field}": "([^"]+)"', seg)
    return m2.group(1) if m2 else ""


_ENUM_FROM_NODE_PACK_FIELDS = frozenset({"sampler_name", "scheduler", "sampler", "noise_type"})
_MODEL_FILE_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx", ".sft", ".pkl", ".vae")


def _looks_like_model_file(val: str) -> bool:
    v = (val or "").strip().lower()
    return v.endswith(_MODEL_FILE_EXTS) or "/" in v or "\\" in v


def _not_in_list_field_value(message: str) -> tuple[str, str]:
    """抽 node_errors details 里的 "<field>: '<val>' not in"(兼容 Value not in list 旧格式与转义引号)。"""
    mobj = (re.search(r"([A-Za-z_]\w*)\s*:\s*\\?'([^'\\]+)\\?'\s+not in", message)
            or re.search(r"value not in list:?\s*([A-Za-z_]\w*)\s*:\s*\\?'([^'\\]+)\\?'", message, re.I))
    if not mobj:
        return "", ""
    return mobj.group(1), mobj.group(2)


def _first_not_in_list(message: str) -> str:
    m2 = re.search(r"details\\?\":\\?\"([^\\\\\"]+not in [^\\\\\"]+)", message)
    if m2:
        return m2.group(1)[:160]
    m3 = re.search(r"Value not in list \w+: '([^']+)'", message)
    return m3.group(1) if m3 else ""


# ---------------------------------------------------------------------------
# 默认参数:从 params_schema 合成一份「能跑就行」的值
# ---------------------------------------------------------------------------
_SEED_KEY_RE = re.compile(r"seed|种子", re.I)


def default_values(schema: list[dict]) -> dict:
    values: dict = {}
    for p in schema or []:
        key = p.get("key")
        if not key:
            continue
        t = p.get("type", "text")
        if t in ("images", "image", "video", "audio"):
            # 上传名在 build 前即确定(_upload_fixtures 按同名上传),避免占位二次替换
            values[key] = _fixture_name(key, t)
            continue
        if "default" in p and p.get("default") is not None:
            # 空串默认对烟测无意义(H3 CR Text default="" →「prompt 不能为空」);
            # text/textarea 改走下方 "smoke test",其它类型仍尊重空默认。
            if not (t in ("text", "textarea") and p.get("default") == ""):
                values[key] = p["default"]
                continue
        if t == "select":
            opts = p.get("options") or []
            values[key] = opts[0].get("value") if opts and isinstance(opts[0], dict) else (opts[0] if opts else "")
        elif t == "number":
            values[key] = 1
        elif t in ("loras",):
            values[key] = []
        elif _SEED_KEY_RE.search(str(key)) or _SEED_KEY_RE.search(str(p.get("label") or "")):
            # seed 常是 text 参数但绑定 INT 叶子:"smoke test" 会被 _coerce_for_leaf 422
            # (2026-09-25 ltx-txt2video/ltx-img2video/ltx-lipsync/wan-nsfw-i2v 实证)
            values[key] = "42"
        else:
            values[key] = "smoke test"
    return values


# ---------------------------------------------------------------------------
# combo 校准修复器:把不在列表的值改写到最接近的在列变体(确定性修复)
# ---------------------------------------------------------------------------
_COMBO_LOADERS = {
    "CheckpointLoaderSimple": "ckpt_name",
    "UNETLoader": "unet_name",
    "VAELoader": "vae_name",
    "CLIPLoader": "clip_name",
    "LoraLoaderModelOnly": "lora_name",
    "ControlNetLoader": "control_net_name",
    "UpscaleModelLoader": "model_name",
    "CLIPVisionLoader": "clip_name",
    "WanVideoModelLoader": "model",
    # LongCat/:8197 常缺 RH 默认 Florence-2-base;并入并集后 combo_repair/路由可感知
    # (2026-09-25 rh-acc-6231837698 实证 :8196 有 / :8197 仅 Flux-Large+PromptGen)
    "Florence2ModelLoader": "model",
}
_STEM_RE = re.compile(r"[^a-z0-9]+")


def _combo_opts(raw) -> list[str]:
    """object_info combo 槽位 → 选项列表。兼容旧版 [["a","b"]] 与新版动态 COMBO
    ["COMBO", {"options": [...]}] —— 后者直接取 [0] 得到 "COMBO" 字符串,
    逐字符迭代会污染并集/误判缺失(ComfyUI 0.34 动态 COMBO 坑)。"""
    if isinstance(raw, (list, tuple)) and raw:
        if isinstance(raw[0], (list, tuple)):
            return [str(v) for v in raw[0]]
        if isinstance(raw[0], str) and len(raw) > 1 and isinstance(raw[1], dict):
            return [str(v) for v in (raw[1].get("options") or [])]
    return []


def _stem(name: str) -> str:
    """文件名 stem 归一:去扩展/分隔符/常见前后缀噪声,供相似度比较。"""
    s = name.lower().rsplit(".", 1)[0]
    s = _STEM_RE.sub("", s)
    for noise in ("pruned", "scaled", "convrot", "fp16", "fp8", "int8", "bf16", "e4m3fn", "comfyorg"):
        s = s.replace(noise, "")
    return s


def _best_match(value: str, combo: list[str]) -> str:
    """stem 相似(子串关系)的在列项;唯一才返回,避免瞎猜。"""
    v = _stem(value)
    if not v:
        return ""
    cands = [c for c in combo if v and v in _stem(c)]
    if len(cands) == 1:
        return cands[0]
    # 精确 stem 相等的优先
    exact = [c for c in cands if _stem(c) == v]
    return exact[0] if len(exact) == 1 else ""


# 长 token 必须排在会被其包含的短 token 之前:fp8_scaled/fp8_e4m3fn 先于 fp8,nvfp4 先于 fp4,
# 否则 "…fp8_scaled…" 会被读成 fp8,精度比较就失去意义。
_PRECISION_TOKENS = (
    "fp8_scaled", "fp8_e4m3fn", "fp8_e4m3", "nvfp4", "fp4", "fp8",
    "fp16", "bf16", "int8", "int4", "gguf",
)


def _precision_of(filename: str) -> str | None:
    """从权重文件名里读出精度/量化 token;读不出返回 None(此时不做精度守卫)。"""
    low = (filename or "").lower()
    for t in _PRECISION_TOKENS:
        if t in low:
            return t
    return None


_MISSING = object()


def _spec_default(spec) -> object:
    """object_info 里某个输入槽的默认值;拿不到返回 _MISSING(表示补不出来,别瞎补)。

    只认两种来源:①widget 显式声明的 {"default": …};②combo 的第一个选项
    (ComfyUI 的隐式默认)。连线型(["IMAGE"]/["MODEL"] 一类)没有默认值 → _MISSING,
    因为凭空造一条连线等于改拓扑,那不是修复是编造。
    """
    if not isinstance(spec, (list, tuple)) or not spec:
        return _MISSING
    head = spec[0]
    if isinstance(head, (list, tuple)):
        opts = [v for v in head if isinstance(v, str)]
        return opts[0] if opts else _MISSING
    if len(spec) > 1 and isinstance(spec[1], dict):
        opts = spec[1].get("options")
        if isinstance(opts, list) and opts:
            return opts[0]
        if "default" in spec[1]:
            return spec[1]["default"]
    return _MISSING


async def _fetch_class_specs(client, graph: dict, tries: int = 2) -> tuple[dict, list[str]]:
    """按类逐个拉 object_info。返回 (规格并集, 拉不到的类名列表)。

    为什么必须把「拉不到」和「没这个类」分开:实例装载 19.5GB 级模型时 ComfyUI 的
    HTTP 服务与执行共用一个事件循环,会被阻塞几十秒——实测同一条 `/object_info/SeedVR2`
    在 :8196 上依次返回 `35s 无响应(http=000)` → `8.7s` → `6ms`。单次抓取失败若被
    `except: pass` 吞掉,`combo_repair` 就拿不到该类的 required 规格,**补不了缺失的必填输入**,
    于是「我们没修好」被记成「应用自己是坏的 validation 失败」(P-11 同型:查询失败不得当成"没有")。
    重试一次可跨过大部分装载窗口;仍失败就把类名透出,让归因保持诚实。
    """
    specs: dict = {}
    failed: list[str] = []
    for ct in sorted({n.get("class_type") for n in (graph or {}).values() if isinstance(n, dict)}):
        if not isinstance(ct, str):
            continue
        got: dict | None = None
        for i in range(max(1, tries)):
            try:
                got = await client.object_info(ct) or {}
                break
            except Exception:  # noqa: BLE001 — 装载窗口内的探测失败要重试,不能吞成"没这个类"
                got = None
                if i + 1 < tries:
                    await asyncio.sleep(1.0)
        if got:
            specs.update(got)
        else:
            failed.append(ct)
    return specs, failed


def _spec_incomplete_note(failed: list[str]) -> str:
    """规格没取全时的归因标注。

    措辞刻意避开 classify_failure 的关键词(缺模型/缺节点/超时/required input is missing 等),
    否则这条标注自己就会把失败改分类,变成新的误判源。
    """
    return (f"repair_incomplete: {len(failed)} 个类的 object_info 未取到"
            f"(实例装载大模型时事件循环阻塞),其必填输入无从补齐: {sorted(failed)[:5]}")


def combo_repair(graph: dict, objinfo: dict, edits_out: list | None = None) -> list[str]:
    """首跑校验失败后的确定性修复:类名别名 + combo 变体改写 + 缺的 widget 按声明默认值补齐。

    返回修复说明列表。

    edits_out 若给出,会被填入**结构化**修改记录 (node_id, kind, field, old, new),
    kind ∈ {"class_type", "input", "input_missing"}(末者 old 恒为 None,表示当时该键缺失,
    回放时若存量图已有值则不覆盖)。用途:烟测通过后把同样的修改施加到**存量 workflow_json**
    上再落库——修复只作用于 _build_graph 产出的运行图,而运行图里已经写进了烟测 fixture 的
    表单值,直接把它存回去等于把测试用的提示词/种子/图片固化进应用。故必须回放结构化 edits。
    """
    fixes: list[str] = []

    def _rec(nid, kind, field, old, new):
        if edits_out is not None:
            edits_out.append((str(nid), kind, field, old, new))
    # 1) 类名:大小写/紧缩写别名(如 StringToInt vs Stringtoint)
    classes = set(objinfo.keys())
    lower_map: dict[str, str] = {}
    for c in classes:
        lower_map.setdefault(_STEM_RE.sub("", c.lower()), c)
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        if isinstance(ct, str) and ct not in classes:
            aliased = lower_map.get(_STEM_RE.sub("", ct.lower()))
            if aliased:
                node["class_type"] = aliased
                fixes.append(f"node {nid}: class {ct} → {aliased}")
                _rec(nid, "class_type", None, ct, aliased)
    # 2) combo 字段:值不在列表 → 最近变体
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        field = _COMBO_LOADERS.get(ct)
        if not field:
            continue
        info = objinfo.get(ct) or {}
        combo = _combo_opts((info.get("input") or {}).get("required", {}).get(field))
        val = (node.get("inputs") or {}).get(field)
        if not isinstance(val, str) or val in combo:
            continue
        cand = _best_match(val, combo)
        if cand:
            po, pc = _precision_of(val), _precision_of(cand)
            if po and pc and po != pc:
                # 换精度不是「修复」:显存占用与出图特性都会变,且与同节点的量化部件耦合。
                # 实测 fp8_scaled→fp16 后 quantization 仍是 fp8_scaled,报「The model is not a
                # scaled fp8 model, please disable '_scaled' in quantization」——把「该 worker
                # 缺此权重 / 路由错」伪装成「权重不兼容」,归因被修复动作覆盖(与 LLM 补丁
                # 删绑定目标节点撞 422 遮蔽真因同型)。拒绝并在 fixes 里写明真因。
                fixes.append(
                    f"node {nid}: {ct}.{field} {val} 拒绝换成 {cand}"
                    f"(精度 {po}→{pc} 会变显存/出图特性,且与本节点量化部件耦合);"
                    f"真因=该 worker 缺此权重或路由错"
                )
            else:
                node["inputs"][field] = cand
                fixes.append(f"node {nid}: {ct}.{field} {val} → {cand}")
                _rec(nid, "input", field, val, cand)
    # 3) 缺的 required widget:按**已安装节点自己声明的默认值**补齐。
    #    RH 导出图会省略「等于默认值」的 widget,而部分节点版本在 API 格式下仍强制要求它出现
    #    (实测 AILab_QwenVL_Advanced.use_torch_compile 报 "Required input is missing …",
    #    影响 183 个应用;SeedVR2.input_noise_scale 同款,影响 1347 个)。
    #    补进去的就是节点自己声明的默认值,所以:ComfyUI 本来会自动填的情况下这是**语义空操作**,
    #    强制要求的情况下则直接修好——两头都不亏,不需要判断哪种节点属于哪一类
    #    (我实测过:有没有 default 并不决定 ComfyUI 是否强制,故没有可靠的静态判据可用)。
    #    连线型补不出来(_spec_default 返回 _MISSING),不硬造:造连线等于改拓扑,那不是修复。
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        info = objinfo.get(ct) if isinstance(ct, str) else None
        if not isinstance(info, dict):
            continue
        required = (info.get("input") or {}).get("required")
        inputs = node.get("inputs")
        if not isinstance(required, dict) or not isinstance(inputs, dict):
            continue
        for key, spec in required.items():
            if key in inputs:
                continue
            default = _spec_default(spec)
            if default is _MISSING:
                continue
            inputs[key] = default
            fixes.append(f"node {nid}: {ct}.{key} 缺失 → 按已装节点默认值补 {default!r}")
            _rec(nid, "input_missing", key, None, default)
    return fixes


def apply_edits_to_workflow(workflow: dict, edits: list) -> tuple[dict, list[str]]:
    """把 combo_repair 的结构化 edits 施加到**存量 workflow_json** 的深拷贝上。

    返回 (新 workflow, 跳过原因列表)。任何一条 edit 落不下去(节点不存在 / 原值对不上)
    都进 skipped——此时调用方**不得落库**,否则存进去的是只改了一半的图,比不改更难查。
    「原值必须对得上才改」是防止把 edits 回放到一个已被别处改过的图上。
    """
    out = copy.deepcopy(workflow) if isinstance(workflow, dict) else {}
    skipped: list[str] = []
    for nid, kind, field, old, new in edits:
        node = out.get(nid)
        if not isinstance(node, dict) and str(nid).lstrip("-").isdigit():
            node = out.get(int(nid))
        if not isinstance(node, dict):
            skipped.append(f"node {nid} 不在存量图里")
            continue
        if kind == "class_type":
            if node.get("class_type") != old:
                skipped.append(f"node {nid} class_type 已不是 {old!r}")
                continue
            node["class_type"] = new
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            skipped.append(f"node {nid} 无 inputs")
            continue
        if kind == "input_missing":
            # old 恒为 None:该键在运行图里当时是**缺失**的。存量图里若已有值,
            # 说明别处填过,不能用默认值覆盖人家的显式值。
            if field in inputs and inputs.get(field) is not None:
                skipped.append(f"node {nid}.{field} 存量图里已有值,不用默认值覆盖")
                continue
            inputs[field] = new
            continue
        if inputs.get(field) != old:
            skipped.append(f"node {nid}.{field} 已不是 {old!r}")
            continue
        inputs[field] = new
    return out, skipped




_UNION_CACHE: dict = {"objinfo": {}, "ts": 0.0}
_UNION_TTL = 600.0


async def _union_objinfo(pool: WorkerPool) -> dict:
    """全 fleet 并集 combo:loader 类的取值清单跨 worker 合并(去重)。

    修复器在 pick 之前用并集改写「RH 名≠fleet 名」:改写后 pick 自然路由到
    持有该文件的 worker。带 10 分钟缓存(9 实例×8 类 object_info 太贵)。
    """
    import time as _t
    from app.comfy.client import ComfyUIClient
    from app.services.h3 import h3_instances

    now = _t.monotonic()
    if now - _UNION_CACHE.get("ts", 0.0) < _UNION_TTL and _UNION_CACHE.get("objinfo"):
        return _UNION_CACHE["objinfo"]
    settings = get_settings()
    urls: list[str] = [c.base_url.rstrip("/") for c in getattr(pool, "clients", [])]
    try:
        urls += [u.rstrip("/") for u in h3_instances()]
    except Exception:
        pass
    for attr in ("longcat_base", "qwen_edit_base", "wan_animate2_base", "infinitetalk_base"):
        u = (getattr(settings, attr, "") or "").rstrip("/")
        if u:
            urls.append(u)
    union: dict = {}
    seen: set[str] = set()
    for u in urls:
        if not u or u in seen:
            continue
        seen.add(u)
        c = ComfyUIClient(u, timeout=8)
        for ct, field in _COMBO_LOADERS.items():
            try:
                info = await c.object_info(ct) or {}
                opts = _combo_opts(info[ct]["input"]["required"].get(field))
            except Exception:
                continue
            slot = union.setdefault(ct, {"input": {"required": {field: [[]]}}})
            cur = slot["input"]["required"].setdefault(field, [[]])[0]
            for v in opts:
                if v not in cur:
                    cur.append(v)
    if union:
        _UNION_CACHE["objinfo"] = union
        _UNION_CACHE["ts"] = now
    return union

# ---------------------------------------------------------------------------
# 烟测主流程
# ---------------------------------------------------------------------------
def _apply_smoke_accel(app: App, graph: dict, accel: str | None) -> tuple[dict, bool, str]:
    """烟测加速档(2026-10-15 用户拍板:测试默认走加速拿结果)。

    返回 (图, 是否生效, 档位)。仅 H3 家族图、仅规格里 recommended 的档;
    apply_acceleration 对不可加速/规格缺失/连线校验失败的图原样返回,宁慢不坏。
    产品路径不调这里——各自路由的 accel 参数说了算,本函数只改烟测口径。
    """
    level = accel if accel is not None else get_settings().smoke_accel_level
    if not level or level == "off":
        return graph, False, level or "off"
    from app.routes.apps import _extract_required  # 惰性:routes 顶层 import 本模块
    from app.services import h3_accel

    if not h3_accel.is_h3_family(app.id, _extract_required(graph)):
        return graph, False, level
    out, applied = h3_accel.apply_acceleration(graph, level)
    return out, applied, level


SMOKE_QUANT_CKPT_SWAP: dict[str, str] = {
    # #22 灰度:同 seed A/B 门判 draft-only(SSIM 0.863/2.5x)→ 只进烟测/草稿路径,产品默认仍 bf16。
    "z_image_turbo_bf16.safetensors": "z-image-turbo_fp8_scaled_KJ.safetensors",
}


def _apply_smoke_quant_swap(graph: dict) -> tuple[dict, int]:
    """烟测路径把图系 bf16 ckpt 字符串换成盘上 fp8 变体(仅字符串替换,不动连线)。

    目标权重在某 worker 不可见时由既有 pick/warmup 口径报 missing_model,不在此另加探测。
    """
    if not get_settings().smoke_quant_ckpt_swap:
        return graph, 0
    n = 0
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key, val in list(inputs.items()):
            tgt = SMOKE_QUANT_CKPT_SWAP.get(val) if isinstance(val, str) else None
            if tgt:
                inputs[key] = tgt
                n += 1
    return graph, n


async def run_app_smoke(
    pool: WorkerPool, session: Session, app: App,
    *, workflow_override: dict | None = None, allow_llm: bool = True,
    values_override: dict | None = None, collect_result: bool = False,
    timeout_s: int | None = None, accel: str | None = None,
) -> dict:
    """单应用真跑一遍;结果落 App.smoke_*;返回 {status, cls, detail, fixes}。

    workflow_override:用给定原始图代替 app.workflow_json(LVM 修复试提交用,
    不落库);allow_llm=False 禁用 LLM 修复阶段(试提交内层必须关,防递归)。
    values_override:覆盖默认表单值(demo 封面注入美女素材/提示词用);
    collect_result=True 时返回值附带 files([{filename,subfolder,type},…],demo
    封面取产物用)。
    """
    from app.routes.apps import (  # 惰性导入防循环(routes 顶层 import 本模块)
        _build_graph,
        _doomed_save_nodes,
        _ensure_graph_media_on_client,
        _extract_required,
        _pick_app_client,
        _queue_with_validation,
        resolve_required_nodes,
    )
    from app.comfy.client import ComfyUIError

    app.smoke_status = "running"
    app.smoke_started_at = datetime.utcnow()
    session.add(app)
    session.commit()

    values = default_values(app.params_schema or [])
    for key in mask_consuming_image_keys(
        workflow_override if workflow_override is not None else (app.workflow_json or {}),
        app.bindings or {},
    ):
        if key in values:
            values[key] = f"smoke_{key}_masked_ref.png"
    if values_override:
        values = {**values, **values_override}
    fixes_all: list[str] = []
    # combo_repair 的结构化修改记录,烟测通过后回放到存量图(见 _persist_repairs)
    edits_all: list = []
    last_msg = ""
    last_ne: dict = {}

    base_workflow = workflow_override if workflow_override is not None else (app.workflow_json or {})
    try:
        graph = _build_graph(base_workflow, app.bindings or {}, values)
    except Exception as exc:  # 构建期 422 类
        return _finish(session, app, "fail", classify_failure(str(exc), {}), fixes_all)
    if not graph:
        return _finish(session, app, "fail", {"cls": "app_data", "detail": "空工作流图"}, fixes_all)

    # pick 之前先做并集校准:RH 名≠fleet 名时改写到真实在列变体,自然路由到持有者
    try:
        fixes0 = combo_repair(graph, await _union_objinfo(pool), edits_all)
        if fixes0:
            fixes_all.extend(fixes0)
    except Exception:  # noqa: BLE001 — 并集拉取失败不阻塞烟测
        pass

    # 烟测默认走加速档拿结果(2026-10-15 用户拍板):仅 H3 家族图、仅规格里 recommended
    # 的档(balanced=BlockCache T8+SageAttention,实测 2.94x/SSIM 0.82 过门);
    # apply_acceleration 对不可加速/规格缺失图原样返回(applied=False),宁慢不坏。
    # 产品路径不受影响:各自路由的 accel 参数说了算,这里只改烟测口径。
    graph, accel_applied, accel_level = _apply_smoke_accel(app, graph, accel)
    if accel_applied:
        fixes_all.append(f"accel={accel_level}")
        logging.getLogger("toiv.smoke").info(
            "烟测加速档生效 app=%s level=%s", app.id, accel_level)

    graph, swap_n = _apply_smoke_quant_swap(graph)
    if swap_n:
        fixes_all.append(f"quant_swap={swap_n}")
        logging.getLogger("toiv.smoke").info(
            "烟测量化换权生效 app=%s swapped=%d", app.id, swap_n)

    for attempt in (1, 2):  # 2=combo 校准修复后原位重试(重建会丢修复,故循环外构建)
        required = _extract_required(graph)
        # 与 routes/apps.py 同一口径:以将提交的图为准(库内快照可能含归一已摘除的 Text/Bool 原语)
        nodes = resolve_required_nodes(app.required_nodes, graph)
        try:
            client = await _pick_app_client(pool, set(filter(None, nodes)), required)
        except Exception as exc:
            res = classify_failure(str(exc), {})
            if res["cls"] == "product":
                res["cls"] = "transport"
            return _finish(session, app, "fail", res, fixes_all)
        # 先上传 fixture 媒体到目标实例,再做跨机转运兜底(顺序反了会被判 404)
        try:
            await _upload_fixtures(client, graph)
            await _ensure_graph_media_on_client(client, pool, graph)
        except Exception as exc:
            return _finish(session, app, "fail", {"cls": "transport", "detail": str(exc)[:160]}, fixes_all)

        try:
            prompt_id, node_errors = await _queue_with_validation(client, graph, f"smoke-{app.id[:16]}-{attempt}")
        except ComfyUIError as exc:  # /prompt 400 类校验拒绝 → 按校验失败进修复/LLM 阶段
            last_msg = str(exc)
            last_ne = {}
        else:
            doomed, reasons = _doomed_save_nodes(graph, node_errors)
            if doomed:
                last_msg = "工作流校验未通过,主保存节点不会执行: " + "; ".join(reasons or sorted(doomed))
                last_ne = node_errors or {}
            else:
                limit = smoke_limit(graph, app.output_kind or "image", timeout_s)
                status, msg, out_files = await _poll_history(
                    client, prompt_id, app.output_kind or "image", limit=limit)
                timed_out = status == "error" and msg.startswith("poll exceeded")
                if timed_out:
                    # 到点仍未出片:清掉 worker 上的这张作业,免得拖累后续卡连带超时
                    try:
                        await client.cancel_prompt(prompt_id)
                    except Exception:  # noqa: BLE001 — 清场尽力而为
                        pass
                if status == "pass":
                    _persist_repairs(session, app, edits_all)
                    out = _finish(session, app, "pass", {"cls": "", "detail": msg}, fixes_all,
                                  files=out_files if collect_result else None)
                    if collect_result:
                        out["worker"] = client.base_url  # demo 封面按此下载产物
                    return out
                last_msg, last_ne = msg, node_errors or {}
                if timed_out:
                    break  # 超时不是校验问题,combo 重试只会再排一遍重作业
        # 失败 → 确定性修复(combo 校准)后重试一次
        if attempt == 1:
            try:
                objinfo_all, spec_failed = await _fetch_class_specs(client, graph)
                if spec_failed:
                    fixes_all.append(_spec_incomplete_note(spec_failed))
                fixes = combo_repair(graph, objinfo_all, edits_all)
                if fixes:
                    fixes_all.extend(fixes)
                    continue
            except Exception as exc:  # noqa: BLE001 — 修复器故障不遮蔽原错误
                last_msg = last_msg or f"repair error: {exc}"
        break

    # ── LLM 修复阶段(Phase1-P1.6):确定性修复无解时 DSv4 提议补丁,沙箱+试提交
    res = classify_failure(last_msg, last_ne)
    if (
        allow_llm and res["cls"] in ("missing_node", "missing_model", "validation")
        and get_settings().selfheal_llm_enabled
    ):
        try:
            objinfo_all, spec_failed = await _fetch_class_specs(client, graph)
            if spec_failed:
                fixes_all.append(_spec_incomplete_note(spec_failed))
            from app.services import selfheal_llm

            out = await selfheal_llm.propose_and_validate(graph, res["cls"], last_msg, objinfo_all)
            if out is not None:
                patch, patched_raw, applied = out
                # 补丁不得删掉表单绑定的目标节点:否则 _build_graph 写值时抛
                # 422「绑定 X 指向不存在的节点 N」,而这条 422 会被归类成 app_data、
                # **掩盖首跑的真实失败原因**(2026-10-13 实证:rh-acc-0052555778-19dac9)。
                # 拒补丁并保留原错误,比拿一个语义已变的图去试跑更诚实。
                dropped = _missing_binding_targets(patched_raw, app.bindings or {})
                if dropped:
                    last_msg = (
                        f"llm patch rejected: 删掉了表单绑定目标节点 {sorted(dropped)[:3]};"
                        f"原错误:{last_msg[:140]}"
                    )
                    selfheal_llm.record_proposal(
                        session, app, res["cls"], last_msg, patch,
                        workflow_override if workflow_override is not None else (app.workflow_json or {}),
                        f"rejected_drops_binding_targets={sorted(dropped)[:5]} fixes={applied[:3]}",
                    )
                else:
                    trial = await run_app_smoke(
                        pool, session, app, workflow_override=patched_raw, allow_llm=False,
                        values_override=values_override, collect_result=collect_result,
                        timeout_s=timeout_s,
                    )
                    note = f"trial={trial['status']} {trial['detail'][:160]} fixes={applied[:3]}"
                    selfheal_llm.record_proposal(
                        session, app, res["cls"], last_msg, patch,
                        workflow_override if workflow_override is not None else (app.workflow_json or {}),
                        note,
                    )
                    if trial["status"] == "pass":
                        app.workflow_json = patched_raw  # 补丁固化(原始图已备份提案)
                        session.add(app)
                        session.commit()
                        return {**trial, "fixes": fixes_all + [f"llm:{a}" for a in applied]}
                    last_msg = f"llm-repair trial fail: {trial['detail'][:160]}"
        except Exception as exc:  # noqa: BLE001 — LLM 修复故障不遮蔽原错误
            last_msg = last_msg or f"llm repair error: {exc}"
        res = classify_failure(last_msg, last_ne)

    return _finish(session, app, "timeout" if res["cls"] == "timeout" else "fail", res, fixes_all)


# 多图槽轮换不同 fixture,避免 FL2VA first+last 同指纹撞 H3 encode cache
# → condition_blocks[1] semantic_frame_index 串线(2026-09-24 rh-acc-1665610753)。
# 只轮换含人脸的图:shiba 无人脸,会让 Stand-In/Lynx/WanAnimate 等人脸卡误判
#「No face detected」(2026-09-25 rh-acc-0079678466)。
_IMAGE_FIXTURE_ROTATION = (
    "face_ref.png",
    "beauty01.png",
    "beauty02.png",
)


_MASK_LOADERS = {"LoadImage", "LoadImageMask"}


def mask_consuming_image_keys(workflow: dict, bindings: dict) -> list[str]:
    """表单图槽绑定的 LoadImage 若其 MASK 输出(slot 1)被下游消费 → 该槽需带遮罩图。

    局部重绘类卡(RH 里用户在 clipspace 手涂遮罩)用无 alpha 的烟测图时,
    LoadImage 给 64x64 空遮罩,下游 Mask Fill Holes / LayerStyle 尺寸不符返回 None
    → easy imageSize 'NoneType' has no attribute 'shape'(2026-09-25 rh-acc-3051342849)。
    这类槽烟测改用 masked_ref.png(中央椭圆透明 = 遮罩区)。
    """
    if not isinstance(workflow, dict):
        return []
    node_to_key: dict[str, str] = {}
    for key, target in (bindings or {}).items():
        for slot in (target if isinstance(target, list) else [target]):
            if isinstance(slot, dict) and slot.get("node") is not None:
                node_to_key.setdefault(str(slot["node"]), key)
    out: list[str] = []
    for nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") not in _MASK_LOADERS:
            continue
        key = node_to_key.get(str(nid))
        if not key or key in out:
            continue
        for other in workflow.values():
            if not isinstance(other, dict):
                continue
            if any(
                isinstance(v, list) and len(v) == 2 and str(v[0]) == str(nid) and v[1] == 1
                for v in (other.get("inputs") or {}).values()
            ):
                out.append(key)
                break
    return out


def _fixture_name(key: str, media_type: str) -> str:
    if media_type in ("image", "images"):
        idx = sum(ord(c) for c in key) % len(_IMAGE_FIXTURE_ROTATION)
        base = _IMAGE_FIXTURE_ROTATION[idx]
    else:
        base = _MEDIA_FIXTURE.get(media_type, ("shiba_frame.jpg", "image/jpeg"))[0]
    stem, ext = base.rsplit(".", 1)
    return f"smoke_{key}_{stem}.{ext}"


async def _upload_fixtures(client, graph: dict) -> None:
    """把图内引用的 smoke_*.mp4/wav/png 上传到目标实例(幂等:同名覆盖关掉,先试拉取)。"""
    names: set[str] = set()
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        for v in (node.get("inputs") or {}).values():
            if isinstance(v, str) and v.startswith("smoke_"):
                names.add(v)
    for name in sorted(names):
        try:
            await client.get_image_bytes(name, "", "input")
            continue  # 已在目标机
        except Exception:
            pass
        stem = name.rsplit(".", 1)[0]
        src = next((f for f in _FIXTURES.iterdir() if stem.endswith(f.stem)), None)
        if src is None:
            raise RuntimeError(f"smoke fixture missing: {name}")
        await client.upload_image(src.read_bytes(), name)


async def _poll_history(client, prompt_id: str, output_kind: str,
                        limit: int | None = None) -> tuple[str, str, list[dict]]:
    """轮询 history:pass(有产物,顺带展平产物清单)/error/timeout。"""
    if not limit:
        limit = _SMKE_TIMEOUT.get(output_kind, 300)
    t0 = asyncio.get_event_loop().time()
    while asyncio.get_event_loop().time() - t0 < limit:
        await asyncio.sleep(6)
        try:
            h = await client.get_history(prompt_id)
        except Exception:
            continue
        e = (h or {}).get(prompt_id)
        if not e:
            continue
        st = e.get("status", {})
        if st.get("status_str") == "error":
            msgs = [str(v[1].get("exception_message", "")) for v in (st.get("messages") or [])
                    if isinstance(v, list) and v and v[0] == "execution_error"]
            return "error", (msgs[0] if msgs else "execution error")[:_SMKE_ERROR_MAX], []
        if st.get("completed") and e.get("outputs"):
            files: list[dict] = []
            for node_out in e["outputs"].values():
                if not isinstance(node_out, dict):
                    continue
                for key in ("images", "gifs", "videos", "audio"):
                    for f in node_out.get(key) or []:
                        if isinstance(f, dict) and f.get("filename"):
                            files.append({
                                "filename": f["filename"],
                                "subfolder": f.get("subfolder", ""),
                                "type": f.get("type", "output"),
                            })
            return "pass", f"outputs={list(e['outputs'])[:3]}", files
    return "error", f"poll exceeded {limit}s", []


def _persist_repairs(session: Session, app: App, edits: list) -> None:
    """烟测通过且过程中改过图 → 把同样的修改回放到存量 workflow_json 并落库。

    不回放的后果是「烟测通过」成为假承诺:_finish 只写 smoke_status/smoke_error,
    存量图仍是坏的,而 combo_repair **不在 routes/apps.py 的生产运行路径上**,
    用户真跑时没有兜底 → 直接失败。实测 13 个应用正处于此状态,且**全部 is_public=true**,
    即已经挂在市场上等着被点开。

    只回放结构化 edits、**绝不直接存运行图**:运行图里已写进烟测 fixture 的表单值,
    存回去等于把测试用的提示词/种子/图片固化进应用。
    任何一条 edit 回放不下去就整体不落库(半改的图比不改更难查),只记日志。
    """
    if not edits:
        return
    raw = app.workflow_json if isinstance(app.workflow_json, dict) else {}
    if not raw:
        return
    log = logging.getLogger("toiv.smoke")
    new_wf, skipped = apply_edits_to_workflow(raw, edits)
    if skipped:
        log.warning("烟测通过但修复无法回放到存量图,不落库 app=%s skipped=%s",
                    app.id, skipped[:3])
        return
    app.workflow_json = new_wf
    session.add(app)
    session.commit()
    log.info("烟测修复已固化到存量图 app=%s edits=%d", app.id, len(edits))


def _finish(session: Session, app: App, status: str, res: dict, fixes: list[str],
            files: list[dict] | None = None) -> dict:
    detail = res.get("detail") or ""
    if fixes:
        detail = f"[fixes: {'; '.join(fixes[:3])}] {detail}"
    app.smoke_status = status
    app.smoke_cls = "" if status == "pass" else (res.get("cls") or "product")
    app.smoke_error = detail[:_SMKE_ERROR_MAX]
    app.smoke_at = datetime.utcnow()
    session.add(app)
    session.commit()
    out = {"status": status, "cls": app.smoke_cls, "detail": detail, "fixes": fixes}
    if files is not None:
        out["files"] = files
    return out


# ---------------------------------------------------------------------------
# O2:API 重启后把中断的 running 烟测卡放回待测(空状态),untested runner / batch 可续跑
# ---------------------------------------------------------------------------
def reconcile_interrupted_smokes() -> int:
    """把 smoke_status=running 的卡清回 ''(未测)。

    烟测是进程内协程:API 重启后 running 会永久卡住,untested_runner 又只挑
    smoke_status 为空的卡,导致被打断的卡既不重跑也不出现在失败列表。
    启动时收口一次即可;正在跑的烟测会在 run_app_smoke 开头再次写成 running。
    """
    n = 0
    with Session(engine) as session:
        rows = session.exec(select(App).where(App.smoke_status == "running")).all()
        for app in rows:
            app.smoke_status = ""
            app.smoke_cls = ""
            app.smoke_error = ""
            app.smoke_started_at = None
            session.add(app)
            n += 1
        if n:
            session.commit()
    if n:
        import logging
        logging.getLogger("toiv.smoke").info("reconcile_interrupted_smokes cleared %d running card(s)", n)
    return n


def running_cards_report(session: Session) -> dict:
    """running 行的年龄画像:靠 smoke_started_at 判孤儿,不靠 updated_at(无 onupdate,读不出年龄)。"""
    rows = session.exec(select(App).where(App.smoke_status == "running")).all()
    now = datetime.utcnow()
    ages = sorted(
        int((now - r.smoke_started_at).total_seconds())
        for r in rows
        if r.smoke_started_at is not None
    )
    return {
        "count": len(rows),
        "without_started_at": sum(1 for r in rows if r.smoke_started_at is None),
        "max_age_sec": ages[-1] if ages else None,
        "ids": [r.id for r in rows][:20],
    }


# ---------------------------------------------------------------------------
# 批量(单飞):按 smoke_status 空/失败的顺序跑一批
# ---------------------------------------------------------------------------
def _pick_batch(session: Session, limit: int, include_nsfw: bool) -> list[App]:
    q = select(App).where(App.is_public == True)  # noqa: E712
    rows = session.exec(q).all()
    todo = [a for a in rows if (not include_nsfw and a.is_nsfw) is False and a.smoke_status in ("", "fail", "timeout")]
    todo.sort(key=lambda a: (a.smoke_status != "", a.id))
    return todo[:limit]


async def _run_batch(pool: WorkerPool, limit: int, include_nsfw: bool) -> int:
    global _SMKE_SUMMARY
    done = 0
    with Session(engine) as session:
        batch = _pick_batch(session, limit, include_nsfw)
        for app in batch:
            try:
                await run_app_smoke(pool, session, app)
                done += 1
            except Exception:  # noqa: BLE001 — 单应用失败不中断批次
                app.smoke_status = app.smoke_status or "fail"
                session.add(app)
                session.commit()
            _SMKE_SUMMARY = {"done": done, "limit": limit,
                             "finished_at": datetime.utcnow().isoformat(timespec="seconds")}
    _SMKE_SUMMARY = {"done": done, "finished_at": datetime.utcnow().isoformat(timespec="seconds")}
    return done


def spawn_smoke_batch(pool: WorkerPool, limit: int = 50, include_nsfw: bool = False) -> asyncio.Task | None:
    """fire-and-forget 启动批量烟测(单飞);运行中返回 None。"""
    global _SMKE_TASK, _SMKE_SUMMARY
    if _SMKE_TASK is not None and not _SMKE_TASK.done():
        return None
    _SMKE_SUMMARY = {"done": 0, "started_at": datetime.utcnow().isoformat(timespec="seconds")}
    _SMKE_TASK = asyncio.create_task(_run_batch(pool, limit, include_nsfw))
    return _SMKE_TASK


def smoke_running() -> bool:
    return _SMKE_TASK is not None and not _SMKE_TASK.done()


def last_smoke_summary() -> dict | None:
    """最近一次批量烟测摘要(无则 None)。"""
    return _SMKE_SUMMARY


def signature_mismatches(graph: dict, objinfo: dict) -> dict:
    """图与**已安装**节点的签名级比对。返回 {missing_required, combo_invalid, undeclared}。

    为什么需要:能力扫描只比「类名在不在」,于是「装了但版本旧」的包一路骗过分类——
    先导批 25 条里 4 条就是这类(`AILab_QwenVL_Advanced` 缺 `use_torch_compile`、
    `SeedVR2` 缺 `input_noise_scale`、`RHHiddenNodes` 缺 `image_1`、
    `PathchSageAttentionKJ` 返回类型不匹配),分类却全判 ok。类名在、签名不在,
    是同一个坑的另一半。

    判定口径**只能按实测**,不能按 object_info 的 spec 形状推:拿先导批 25 条真图 ×
    真 smoke 结果回测,「required 里的键必须全部出现」这条规则做闸的话——14 条失败只抓到 1 条,
    却把 1 条**实际 pass** 的应用误判为不可得。逐条查 spec 后发现反例互斥:
    `AILab_QwenVL_Advanced.use_torch_compile` 是 `["BOOLEAN", {"default": false}]` 却被强制;
    `ImageScaleToTotalPixels.resolution_steps` 是 `["INT", {"default": 1}]` 却被容忍。
    即「有没有 default」并不决定 ComfyUI 是否强制,故**不存在可靠的静态判据**。

    因此前三类一律只作告警透出,**都不参与 procurable 判定**:
    - missing_required / combo_invalid / undeclared:仅供人工分诊与后续研究,
      拿去卡导入会同时产生漏判与误杀(实测数据见上)。

    第四类 socket_out_of_range 与前三类**性质不同**:连线的输出槽索引 ≥ 源类
    RETURN_TYPES 长度时,ComfyUI `execution.py:925-927` 的 `r[val[1]]` **必然**抛
    `IndexError: tuple index out of range`,不存在容忍反例,故判据是确定的。
    仍不作闸的唯一理由是 preflight 用的是**全 fleet 并集** objinfo——同名类在不同
    worker 上输出个数可能不同,并集里的 arity 未必等于实际接单那台。
    该错被 inner 分支(`execution.py:961`)捕获后挂在**下游消费者**身上,真凶不出现
    在错误信息里,一次可表现为多种互不相关的节点族,故必须靠静态比对点名源类。
    真实案例:`RHHiddenNodes` shim 只声明 1 个输出,而存量图有
    `TextEncodeQwenImageEditPlus.prompt ← ['382', 1]`。
    """
    missing_required: list[str] = []
    combo_invalid: list[str] = []
    undeclared: list[str] = []
    socket_out_of_range: list[str] = []
    for nid, node in (graph or {}).items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        info = objinfo.get(ct) if isinstance(ct, str) else None
        if not isinstance(info, dict):
            continue  # 类名缺失归 missing_nodes 那条路径管,别在这里重复报
        spec_in = info.get("input") if isinstance(info.get("input"), dict) else {}
        required = spec_in.get("required") if isinstance(spec_in.get("required"), dict) else {}
        optional = spec_in.get("optional") if isinstance(spec_in.get("optional"), dict) else {}
        declared = {**required, **optional}
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        tag = f"{ct}(node {nid})"
        for key in required:
            if key not in inputs:
                missing_required.append(f"{tag}: 缺必填输入 {key}")
        for key, val in inputs.items():
            if (isinstance(val, list) and len(val) == 2 and isinstance(val[0], str)
                    and isinstance(val[1], int) and not isinstance(val[1], bool)
                    and val[0] in graph):
                src = graph[val[0]]
                src_ct = src.get("class_type") if isinstance(src, dict) else None
                src_info = objinfo.get(src_ct) if isinstance(src_ct, str) else None
                outs = src_info.get("output") if isinstance(src_info, dict) else None
                if isinstance(outs, list) and val[1] >= len(outs):
                    socket_out_of_range.append(
                        f"{tag}: {key} ← 连线 {val} 输出槽越界"
                        f"(源类 {src_ct} 只有 {len(outs)} 个输出 {outs})")
            if key not in declared:
                undeclared.append(f"{tag}: 未声明的输入 {key}")
                continue
            # 连线(list)运行时才有值,这里只校验字面量
            if isinstance(val, str):
                opts = _combo_opts(declared[key])
                if opts and val not in opts:
                    combo_invalid.append(f"{tag}: {key}={val!r} 不在已安装 combo({len(opts)} 项)")
    return {"missing_required": missing_required,
            "combo_invalid": combo_invalid,
            "undeclared": undeclared,
            "socket_out_of_range": socket_out_of_range}


async def preflight_check(pool: WorkerPool, workflow_json: dict, required_nodes: list[str] | None = None) -> dict:
    """导入前依赖预检:模型文件/节点类/节点**签名**在全 fleet 是否可得(不烧 GPU,纯 object_info 并集)。

    返回 {procurable, missing_models, missing_nodes, total_models,
    signature_missing_required, signature_combo_invalid, signature_undeclared}。
    用途:RH 导入管线在入库前调用——不可得的应用打 content_missing 隔离,
    不进入市场稀释可用率。

    procurable 只被两件事否决:缺模型、缺类名。签名三类(missing_required /
    combo_invalid / undeclared)一律只作告警透出、不参与判定——拿它们做闸已实测会
    同时漏判与误杀,理由与数据见 signature_mismatches。
    """
    base = {"procurable": True, "missing_models": [], "missing_nodes": [], "total_models": 0,
            "signature_missing_required": [], "signature_combo_invalid": [],
            "signature_undeclared": [], "signature_socket_out_of_range": []}
    try:
        objinfo = await _union_objinfo(pool)
    except Exception as exc:  # noqa: BLE001 — 并集不可得时不误杀
        return {**base, "note": f"union unavailable: {exc!r}"[:120]}
    missing_nodes = [
        n for n in (required_nodes or [])
        if isinstance(n, str) and n not in objinfo and not any(
            _STEM_RE.sub("", n.lower()) == _STEM_RE.sub("", c.lower()) for c in objinfo
        )
    ]
    missing_models: list[str] = []
    total = 0
    for node in (workflow_json or {}).values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        field = _COMBO_LOADERS.get(ct)
        if not field or ct not in objinfo:
            continue
        combo = _combo_opts((objinfo[ct].get("input") or {}).get("required", {}).get(field))
        val = (node.get("inputs") or {}).get(field)
        if not isinstance(val, str) or not val:
            continue
        total += 1
        if val not in combo:
            missing_models.append(f"{ct}.{field}: {val}")
    base["missing_nodes"] = missing_nodes
    base["missing_models"] = missing_models[:20]
    base["total_models"] = total
    # 签名级比对:三类一律只透出、不判死(实测做闸会同时漏判与误杀,理由见 signature_mismatches)
    sig = signature_mismatches(workflow_json or {}, objinfo)
    base["signature_missing_required"] = sig["missing_required"][:20]
    base["signature_combo_invalid"] = sig["combo_invalid"][:20]
    base["signature_undeclared"] = sig["undeclared"][:20]
    base["signature_socket_out_of_range"] = sig["socket_out_of_range"][:20]
    base["procurable"] = not missing_models and not missing_nodes
    return base
