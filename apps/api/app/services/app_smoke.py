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
_SMKE_ERROR_MAX = 300

_SMKE_TASK: asyncio.Task | None = None
_SMKE_SUMMARY: dict | None = None


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


def _first_not_in_list(message: str) -> str:
    m2 = re.search(r"details\\?\":\\?\"([^\\\\\"]+not in [^\\\\\"]+)", message)
    if m2:
        return m2.group(1)[:160]
    m3 = re.search(r"Value not in list \w+: '([^']+)'", message)
    return m3.group(1) if m3 else ""


# ---------------------------------------------------------------------------
# 默认参数:从 params_schema 合成一份「能跑就行」的值
# ---------------------------------------------------------------------------
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


def combo_repair(graph: dict, objinfo: dict) -> list[str]:
    """首跑校验失败后的确定性修复:类名别名 + combo 变体改写。返回修复说明列表。"""
    fixes: list[str] = []
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
            node["inputs"][field] = cand
            fixes.append(f"node {nid}: {ct}.{field} {val} → {cand}")
    return fixes




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
async def run_app_smoke(
    pool: WorkerPool, session: Session, app: App,
    *, workflow_override: dict | None = None, allow_llm: bool = True,
    values_override: dict | None = None, collect_result: bool = False,
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
    )
    from app.comfy.client import ComfyUIError

    app.smoke_status = "running"
    session.add(app)
    session.commit()

    values = default_values(app.params_schema or [])
    if values_override:
        values = {**values, **values_override}
    fixes_all: list[str] = []
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
        fixes0 = combo_repair(graph, await _union_objinfo(pool))
        if fixes0:
            fixes_all.extend(fixes0)
    except Exception:  # noqa: BLE001 — 并集拉取失败不阻塞烟测
        pass

    for attempt in (1, 2):  # 2=combo 校准修复后原位重试(重建会丢修复,故循环外构建)
        required = _extract_required(graph)
        nodes = set(app.required_nodes or []) or {
            n.get("class_type") for n in graph.values() if isinstance(n, dict) and n.get("class_type")
        }
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
                status, msg, out_files = await _poll_history(client, prompt_id, app.output_kind or "image")
                if status == "pass":
                    out = _finish(session, app, "pass", {"cls": "", "detail": msg}, fixes_all,
                                  files=out_files if collect_result else None)
                    if collect_result:
                        out["worker"] = client.base_url  # demo 封面按此下载产物
                    return out
                last_msg, last_ne = msg, node_errors or {}
        # 失败 → 确定性修复(combo 校准)后重试一次
        if attempt == 1:
            try:
                objinfo_all: dict = {}
                for ct in {n.get("class_type") for n in graph.values() if isinstance(n, dict)}:
                    if not isinstance(ct, str):
                        continue
                    try:
                        objinfo_all.update(await client.object_info(ct) or {})
                    except Exception:
                        pass
                fixes = combo_repair(graph, objinfo_all)
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
            objinfo_all: dict = {}
            for ct in {n.get("class_type") for n in graph.values() if isinstance(n, dict)}:
                if not isinstance(ct, str):
                    continue
                try:
                    objinfo_all.update(await client.object_info(ct) or {})
                except Exception:
                    pass
            from app.services import selfheal_llm

            out = await selfheal_llm.propose_and_validate(graph, res["cls"], last_msg, objinfo_all)
            if out is not None:
                patch, patched_raw, applied = out
                trial = await run_app_smoke(
                    pool, session, app, workflow_override=patched_raw, allow_llm=False,
                    values_override=values_override, collect_result=collect_result,
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
_IMAGE_FIXTURE_ROTATION = (
    "face_ref.png",
    "shiba_frame.jpg",
    "beauty01.png",
    "beauty02.png",
)


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


async def _poll_history(client, prompt_id: str, output_kind: str) -> tuple[str, str, list[dict]]:
    """轮询 history:pass(有产物,顺带展平产物清单)/error/timeout。"""
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


async def preflight_check(pool: WorkerPool, workflow_json: dict, required_nodes: list[str] | None = None) -> dict:
    """导入前依赖预检:模型文件/节点类在全 fleet 是否可得(不烧 GPU,纯 object_info 并集)。

    返回 {procurable, missing_models, missing_nodes, total_models}。
    用途:RH 导入管线在入库前调用——不可得的应用打 content_missing 隔离,
    不进入市场稀释可用率。
    """
    base = {"procurable": True, "missing_models": [], "missing_nodes": [], "total_models": 0}
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
    base["procurable"] = not missing_models and not missing_nodes
    return base
