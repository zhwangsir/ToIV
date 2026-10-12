#!/usr/bin/env python3
"""Accurate RH reseed: export real Comfy API graphs via getJsonApiFormat, seed non-builtin public apps.

NO template clones. Uses:
  POST /api/webapp/detail -> workflowState==1 + workflowId
  POST /api/openapi/getJsonApiFormat -> data.prompt graph
Schema/bindings from RH inputNodes (+ graph fallback via LoadImage/CLIPTextEncode/etc).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

# 2026-10-13(W8):本文件从 .regen_tmp/ 提升到 scripts/ops/,层级 +1,故 parents[1] → parents[2]。
# (原值在新位置会把 ROOT 指到 scripts/,导致 .auth/ 与候选清单路径全部失效)
ROOT = Path(__file__).resolve().parents[2]
AUTH = ROOT / ".auth" / "admin.json"
RH_AUTH = ROOT / ".auth" / "runninghub.json"
DEFAULT_BASE = "http://192.168.71.47:8090"
RH_DETAIL = "https://www.runninghub.ai/api/webapp/detail"
RH_EXPORT = "https://www.runninghub.ai/api/openapi/getJsonApiFormat"

# 2026-10-13(W8):原脚本硬编码 is_public=True,直接复跑会把未经验证的新导入应用一次性推上市场。
# 改为默认**不公开**:导入后先 smoke 真跑验证,再由 bulk-public 分批上架(守 rh_market_reset 纪律)。
# 需要导入即公开时由 driver 显式设 IS_PUBLIC_DEFAULT=True 并说明理由。
IS_PUBLIC_DEFAULT = False

IMG_CAT = ROOT / ".regen_tmp" / "rh_image_candidates_full.json"
WAN_CAT = ROOT / ".regen_tmp" / "rh_ingest_candidates_wan_ltx_h3.json"
PROOFS = ROOT / ".regen_tmp" / "_rh_export_success_samples.json"
CKPT = ROOT / ".regen_tmp" / "rh_accurate_reseed_checkpoint.json"
REPORT_MD = ROOT / ".regen_tmp" / "rh-accurate-reseed-20260907.md"
REPORT_JSON = ROOT / ".regen_tmp" / "rh_accurate_reseed_report.json"

FAMILIES = ("flux", "qwen", "h3", "wan", "ltx")

# Prefer these known-exportable proofs first
SEED_FIRST = [
    "2033346185657847809",  # Flux2-klein
    "2087489031323267073",  # H3 Lip Sync
    "2091224373751918593",  # H3 T2AV
    "2086832389875421185",  # H3 Turbo Director
]


def _load_rh_key() -> str:
    data = json.loads(RH_AUTH.read_text(encoding="utf-8"))
    key = data.get("RUNNINGHUB_API_KEY") or data.get("apiKey") or ""
    if not key:
        raise SystemExit("missing RUNNINGHUB_API_KEY in .auth/runninghub.json")
    return key


def _load_admin() -> tuple[str, str]:
    data = json.loads(AUTH.read_text(encoding="utf-8"))
    tok = data.get("token") or ""
    origin = (data.get("origin") or DEFAULT_BASE).rstrip("/")
    if not tok:
        raise SystemExit("missing token in .auth/admin.json")
    return origin, tok


def _http_json(url: str, method: str = "GET", body: dict | None = None,
               headers: dict | None = None, timeout: float = 60, retries: int = 5) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    hdrs = {"Content-Type": "application/json", "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                detail = json.loads(raw)
            except Exception:
                detail = {"raw": raw.decode("utf-8", "replace")[:500]}
            return e.code, detail
        except (ConnectionResetError, BrokenPipeError, TimeoutError, urllib.error.URLError, OSError) as e:
            last_err = e
            time.sleep(min(20, 1.4 ** attempt))
    raise ConnectionError(f"exhausted retries {method} {url}: {last_err}")


def _tag_family(name: str, searches: list | None = None, use_case: str = "") -> list[str]:
    s = " ".join([name or "", use_case or ""] + list(searches or [])).lower()
    tags: list[str] = []
    if any(x in s for x in ("flux", "klein", "kontext")):
        tags.append("flux")
    if any(x in s for x in ("qwen", "千问")):
        tags.append("qwen")
    if any(x in s for x in ("h3", "海螺", "minimax", "lip sync", "t2av")):
        tags.append("h3")
    if any(x in s for x in ("wan2", "wan 2", "wan-", "wan.", "万相", "wan image", "wan video")):
        tags.append("wan")
    if "ltx" in s:
        tags.append("ltx")
    return tags or ["other"]


def _load_candidates() -> list[dict]:
    """Merge catalogs; prefer high useCount; inject known proofs; diversify families."""
    by_id: dict[str, dict] = {}
    for path in (IMG_CAT, WAN_CAT):
        if not path.is_file():
            continue
        blob = json.loads(path.read_text(encoding="utf-8"))
        items = blob.get("items") if isinstance(blob, dict) else blob
        for it in items or []:
            wid = str(it.get("webappId") or "")
            if not wid:
                continue
            cur = by_id.get(wid)
            if not cur or (it.get("useCount") or 0) > (cur.get("useCount") or 0):
                row = dict(it)
                row["webappId"] = wid
                row["families"] = _tag_family(
                    str(row.get("name") or ""),
                    row.get("searches") if isinstance(row.get("searches"), list) else None,
                    str(row.get("useCase") or ""),
                )
                by_id[wid] = row
    # inject proofs
    if PROOFS.is_file():
        blob = json.loads(PROOFS.read_text(encoding="utf-8"))
        for p in blob.get("proofs") or []:
            wid = str(p.get("webappId") or "")
            if not wid:
                continue
            if wid not in by_id:
                by_id[wid] = {
                    "webappId": wid,
                    "name": p.get("name") or wid,
                    "coverUrl": "",
                    "useCount": 10**9,  # force front
                    "author": "",
                    "searches": [],
                    "useCase": "",
                    "families": _tag_family(str(p.get("name") or "")),
                }
            else:
                by_id[wid]["useCount"] = max(by_id[wid].get("useCount") or 0, 10**9)
    rows = list(by_id.values())
    rows.sort(key=lambda r: -(r.get("useCount") or 0))
    return rows


def _pick_pilot(rows: list[dict], target: int, per_family: int = 12) -> list[dict]:
    """Round-robin high-value across flux/qwen/h3/wan (+ltx filler)."""
    buckets: dict[str, list[dict]] = {f: [] for f in FAMILIES}
    other: list[dict] = []
    for r in rows:
        fams = r.get("families") or ["other"]
        placed = False
        for f in FAMILIES:
            if f in fams:
                buckets[f].append(r)
                placed = True
                break
        if not placed:
            other.append(r)
    picked: list[dict] = []
    seen: set[str] = set()
    # force SEED_FIRST
    by_id = {r["webappId"]: r for r in rows}
    for wid in SEED_FIRST:
        if wid in by_id and wid not in seen:
            picked.append(by_id[wid])
            seen.add(wid)
    # per-family top
    for f in FAMILIES:
        n = 0
        for r in buckets[f]:
            if r["webappId"] in seen:
                continue
            picked.append(r)
            seen.add(r["webappId"])
            n += 1
            if n >= per_family:
                break
    # fill to target from remaining high useCount
    for r in rows:
        if len(picked) >= target:
            break
        if r["webappId"] in seen:
            continue
        picked.append(r)
        seen.add(r["webappId"])
    return picked[:target]


def _cover_from_detail(detail: dict, catalog_cover: str = "") -> str:
    for key in ("covers", "chineseCovers"):
        covers = detail.get(key) or []
        if isinstance(covers, list) and covers:
            c0 = covers[0]
            if isinstance(c0, dict):
                url = c0.get("url") or c0.get("uri") or ""
                if url:
                    return str(url)[:500]
            elif isinstance(c0, str) and c0.startswith("http"):
                return c0[:500]
    for key in ("coverUrl", "cover"):
        v = detail.get(key)
        if isinstance(v, str) and v.startswith("http"):
            return v[:500]
    if catalog_cover and str(catalog_cover).startswith("http"):
        return str(catalog_cover)[:500]
    return ""


def _parse_prompt(data: Any) -> dict | None:
    if not isinstance(data, dict):
        return None
    prompt = data.get("prompt")
    if isinstance(prompt, str):
        try:
            prompt = json.loads(prompt)
        except Exception:
            return None
    if isinstance(prompt, dict) and prompt:
        # already graph?
        if all(isinstance(v, dict) and isinstance(v.get("class_type"), str) for v in prompt.values()):
            return prompt
    # some responses nest further
    inner = data.get("data") if isinstance(data.get("data"), dict) else None
    if inner:
        return _parse_prompt(inner)
    return None


def rh_detail(api_key: str, webapp_id: str) -> tuple[str, dict | None, str]:
    """Returns (status, detail_or_none, reason). status: ok|skip|error."""
    code, body = _http_json(RH_DETAIL, "POST", {"apiKey": api_key, "webappId": webapp_id}, timeout=45)
    if code != 200 or not isinstance(body, dict):
        return "error", None, f"detail_http_{code}"
    if body.get("code") not in (0, "0", None) and body.get("code") != 0:
        # RH uses code 0 success
        if body.get("code") != 0:
            return "skip", None, f"detail_code_{body.get('code')}"
    detail = body.get("data")
    if not isinstance(detail, dict):
        return "skip", None, "detail_no_data"
    wf_state = detail.get("workflowState")
    wf_id = detail.get("workflowId")
    if wf_id is None or wf_id == "" or wf_id == "null":
        return "skip", detail, "null_workflowId"
    try:
        if int(wf_state) != 1:
            return "skip", detail, f"workflowState_{wf_state}"
    except Exception:
        if wf_state != 1 and str(wf_state) != "1":
            return "skip", detail, f"workflowState_{wf_state}"
    return "ok", detail, "ok"


def rh_export(api_key: str, workflow_id: str) -> tuple[str, dict | None, str, Any]:
    code, body = _http_json(
        RH_EXPORT,
        "POST",
        {"apiKey": api_key, "workflowId": str(workflow_id)},
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=90,
    )
    if code == 403:
        return "skip", None, "export_403", body
    if code != 200 or not isinstance(body, dict):
        return "error", None, f"export_http_{code}", body
    rh_code = body.get("code")
    if rh_code in (380, "380"):
        return "skip", None, "export_380", body
    if rh_code in (1913, "1913"):
        return "skip", None, "export_1913", body
    if rh_code in (403, "403"):
        return "skip", None, "export_403", body
    if rh_code not in (0, "0"):
        return "skip", None, f"export_code_{rh_code}", body
    graph = _parse_prompt(body.get("data") if isinstance(body.get("data"), dict) else body)
    if not graph:
        # try data as string
        data = body.get("data")
        if isinstance(data, str):
            try:
                graph = _parse_prompt({"prompt": data})
            except Exception:
                graph = None
        elif isinstance(data, dict) and "prompt" not in data:
            # maybe data IS the graph
            if all(isinstance(v, dict) and v.get("class_type") for v in data.values()):
                graph = data
    if not graph:
        return "skip", None, "export_no_prompt", body
    return "ok", graph, "ok", body


_FIELD_TYPE_MAP = {
    "IMAGE": "images",
    "STRING": "textarea",
    "LIST": "select",
    "INT": "number",
    "FLOAT": "number",
    "BOOLEAN": "switch",
    "AUDIO": "audio",
    "VIDEO": "video",
}


def _slug_key(base: str, used: set[str]) -> str:
    raw = re.sub(r"[^a-zA-Z0-9_]+", "_", base.strip()).strip("_").lower() or "param"
    raw = raw[:48]
    key = raw
    i = 2
    while key in used:
        key = f"{raw}_{i}"
        i += 1
    used.add(key)
    return key



_BINDING_FIELD_RE = re.compile(r"^(inputs|widgets_values)\.[A-Za-z0-9_]+$")


def _filter_valid_bindings(schema, bindings):
    dropped = []
    keep = set()
    new_b = {}
    for key, b in (bindings or {}).items():
        if not isinstance(b, dict):
            dropped.append(key)
            continue
        field = str(b.get("field") or "")
        if not _BINDING_FIELD_RE.match(field):
            dropped.append(key)
            continue
        new_b[key] = b
        keep.add(key)
    new_s = [x for x in (schema or []) if x.get("key") in keep]
    return new_s, new_b, dropped

def _options_from_field_data(field_data: str) -> list[str]:
    if not field_data:
        return []
    try:
        parsed = json.loads(field_data)
    except Exception:
        return []
    # COMBO form: ["COMBO", {"options": [...]}]
    if isinstance(parsed, list) and len(parsed) >= 2 and isinstance(parsed[1], dict):
        opts = parsed[1].get("options")
        if isinstance(opts, list) and opts:
            return [str(o) for o in opts]
    if isinstance(parsed, dict):
        opts = parsed.get("options")
        if isinstance(opts, list) and opts:
            return [str(o) for o in opts]
    return []


def build_schema_bindings(graph: dict, input_nodes: list | None) -> tuple[list[dict], dict, str]:
    """Build params_schema + bindings from RH inputNodes, fallback to graph lenses."""
    schema: list[dict] = []
    bindings: dict = {}
    used_keys: set[str] = set()
    nodes_ok = set(str(k) for k in graph.keys())

    for inode in input_nodes or []:
        if not isinstance(inode, dict):
            continue
        node_id = str(inode.get("nodeId") or "")
        field_name = str(inode.get("fieldName") or "")
        if not node_id or not field_name or node_id not in nodes_ok:
            continue
        # verify leaf exists and is scalar-ish
        node = graph.get(node_id) or graph.get(int(node_id) if node_id.isdigit() else node_id)
        # keys in graph are strings usually
        if node is None:
            for k, v in graph.items():
                if str(k) == node_id:
                    node = v
                    node_id = str(k)
                    break
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        if field_name not in inputs:
            continue
        val = inputs[field_name]
        if isinstance(val, list):  # link — skip
            continue
        ftype = str(inode.get("fieldType") or "STRING").upper()
        ptype = _FIELD_TYPE_MAP.get(ftype, "text")
        label = (
            inode.get("descriptionCn")
            or inode.get("descriptionEn")
            or inode.get("description")
            or field_name
        )
        key_base = f"{inode.get('nodeName') or node.get('class_type') or 'n'}_{field_name}"
        key = _slug_key(str(key_base), used_keys)
        param: dict[str, Any] = {
            "key": key,
            "label": str(label)[:80],
            "type": ptype,
        }
        if ptype == "textarea":
            param["default"] = str(inode.get("fieldValue") if inode.get("fieldValue") is not None else val or "")
        elif ptype == "number":
            try:
                num = float(inode.get("fieldValue") if inode.get("fieldValue") not in (None, "") else val)
                if num == int(num):
                    num = int(num)
                param["default"] = num
            except Exception:
                param["default"] = val if isinstance(val, (int, float)) else 0
        elif ptype == "select":
            opts = _options_from_field_data(str(inode.get("fieldData") or ""))
            if not opts:
                # degrade to text
                param["type"] = "text"
                param["default"] = str(inode.get("fieldValue") or val or "")
            else:
                param["options"] = opts
                fv = str(inode.get("fieldValue") or "")
                param["default"] = fv if fv in opts else opts[0]
        elif ptype == "switch":
            fv = inode.get("fieldValue")
            param["default"] = bool(fv) if not isinstance(fv, str) else fv.lower() in ("1", "true", "yes")
        elif ptype in ("images", "audio", "video"):
            param["required"] = True
        else:
            param["default"] = str(inode.get("fieldValue") or val or "")
        schema.append(param)
        bindings[key] = {"node": node_id, "field": f"inputs.{field_name}"}

    # Fallback: scan graph if schema empty or missing prompts/images
    has_image = any(p.get("type") == "images" for p in schema)
    has_prompt = any(p.get("type") in ("textarea", "text") for p in schema)
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        if not has_image and ct == "LoadImage" and isinstance(inputs.get("image"), str):
            key = _slug_key(f"loadimage_{nid}", used_keys)
            schema.append({"key": key, "label": "image", "type": "images", "required": True})
            bindings[key] = {"node": str(nid), "field": "inputs.image"}
            has_image = True
        if not has_prompt and ct == "CLIPTextEncode" and isinstance(inputs.get("text"), str):
            key = _slug_key(f"prompt_{nid}", used_keys)
            schema.append({
                "key": key,
                "label": "prompt",
                "type": "textarea",
                "default": inputs.get("text") or "",
            })
            bindings[key] = {"node": str(nid), "field": "inputs.text"}
            has_prompt = True
        if ct == "LoadAudio" and isinstance(inputs.get("audio"), str):
            key = _slug_key(f"audio_{nid}", used_keys)
            if key not in bindings:
                schema.append({"key": key, "label": "audio", "type": "audio"})
                bindings[key] = {"node": str(nid), "field": "inputs.audio"}
        if ct == "LoadVideo" and isinstance(inputs.get("file"), str):
            key = _slug_key(f"video_{nid}", used_keys)
            if key not in bindings:
                schema.append({"key": key, "label": "video", "type": "video"})
                bindings[key] = {"node": str(nid), "field": "inputs.file"}

    # output kind
    cts = {n.get("class_type") for n in graph.values() if isinstance(n, dict)}
    if cts & {"SaveVideo", "VHS_VideoCombine", "CreateVideo"}:
        output_kind = "video"
    elif cts & {"SaveAudio", "SaveAudioMP3", "PreviewAudio"}:
        output_kind = "audio"
    else:
        output_kind = "image"
    return schema, bindings, output_kind


def _guess_category(families: list[str], output_kind: str, name: str) -> str:
    n = (name or "").lower()
    if output_kind == "video":
        return "video"
    if output_kind == "audio":
        return "audio"
    if any(x in n for x in ("edit", "编辑", "inpaint", "重绘", "换装", "换脸")):
        return "edit"
    if "qwen" in families or "flux" in families:
        return "edit" if any(x in n for x in ("edit", "编辑", "kontext", "klein")) else "image"
    if "wan" in families or "h3" in families or "ltx" in families:
        return "video" if output_kind == "video" else "image"
    return "image" if output_kind == "image" else output_kind


def _app_id(webapp_id: str, name: str = "") -> str:
    wid = re.sub(r"[^0-9a-zA-Z]", "", str(webapp_id))[-10:] or "0"
    h = hashlib.sha1(f"{webapp_id}|{name}".encode()).hexdigest()[:6]
    return f"rh-acc-{wid}-{h}".lower()[:64]


def _core_req(base: str, method: str, path: str, token: str, body: dict | None = None):
    return _http_json(
        base.rstrip("/") + path,
        method,
        body,
        headers={"Authorization": f"Bearer {token}", "X-NSFW": "1"},
        timeout=90,
        retries=6,
    )


def _load_ckpt() -> dict:
    if CKPT.is_file():
        return json.loads(CKPT.read_text(encoding="utf-8"))
    return {
        "seeded": [],
        "skipped": [],
        "errors": [],
        "processed_ids": [],
        "spot_checks": [],
    }


def _save_ckpt(ckpt: dict) -> None:
    CKPT.write_text(json.dumps(ckpt, ensure_ascii=False, indent=2), encoding="utf-8")


def _already_seeded_webapp_ids(base: str, token: str) -> set[str]:
    """库内已有 RH 溯源的 webappId 集合(导入去重用)。

    2026-10-13(W8)修:原实现一次拉 `?limit=5000`,但 S1 分页契约把 limit 上限钉在 1000
    (实测 422 `Input should be less than or equal to 1000`),而这里把非 200 **静默**当空集返回
    → 去重整条失效、复跑会重复导入(D-2「一次性手工迁移没有守护会静默失效」同类)。
    现改为 limit=1000 + offset 分页拉全量,且**任何一页失败都抛错**,不允许带着坏去重继续。
    """
    out: set[str] = set()
    offset = 0
    page = 1000
    total = None
    while True:
        code, apps = _core_req(base, "GET", f"/api/apps?limit={page}&offset={offset}", token)
        if code != 200:
            raise RuntimeError(
                f"拉取 /api/apps 失败(offset={offset}, code={code}):{str(apps)[:200]};"
                f"去重信息不完整时禁止继续导入"
            )
        items = apps if isinstance(apps, list) else (apps.get("items") or [])
        for a in items:
            desc = a.get("description") or ""
            m = re.search(r"RH:(\d+)", desc)
            if m:
                out.add(m.group(1))
        if total is None:
            total = len(items) if len(items) < page else None
        if len(items) < page:
            break
        offset += page
        if offset > 200_000:  # 保险丝:异常分页不应无限循环
            raise RuntimeError("分页拉取超过 200k 行,疑似 offset 未生效")
    return out


def seed_one(api_key: str, base: str, token: str, row: dict, dry_run: bool,
             used_names: set[str]) -> dict:
    wid = str(row["webappId"])
    name = str(row.get("name") or wid)[:120]
    result = {
        "webappId": wid,
        "name": name,
        "families": row.get("families") or [],
        "status": "pending",
        "reason": "",
    }
    st, detail, reason = rh_detail(api_key, wid)
    if st != "ok":
        result["status"] = "skipped"
        result["reason"] = reason
        return result
    assert detail is not None
    wf_id = detail.get("workflowId")
    result["workflowId"] = str(wf_id)
    result["workflowState"] = detail.get("workflowState")
    cover = _cover_from_detail(detail, str(row.get("coverUrl") or ""))
    result["cover_url"] = cover
    # prefer RH name from detail
    rh_name = str(detail.get("name") or name)[:120]
    result["name"] = rh_name

    st2, graph, reason2, raw = rh_export(api_key, str(wf_id))
    if st2 != "ok" or not graph:
        result["status"] = "skipped"
        result["reason"] = reason2
        return result
    node_count = len(graph)
    result["export_node_count"] = node_count
    schema, bindings, output_kind = build_schema_bindings(graph, detail.get("inputNodes"))
    schema, bindings, dropped_bindings = _filter_valid_bindings(schema, bindings)
    if dropped_bindings:
        result["dropped_bindings"] = dropped_bindings
    families = row.get("families") or _tag_family(rh_name)
    category = _guess_category(families, output_kind, rh_name)
    author = str(detail.get("authorName") or detail.get("author") or row.get("author") or "")[:120]
    # description must contain RH:{webappId}; keep under 500
    desc = f"RH:{wid} · accurate export · nodes={node_count}"
    if author:
        desc = f"RH:{wid} · {author} · nodes={node_count}"
    desc = desc[:500]
    app_id = _app_id(wid, rh_name)
    # dedupe display name
    display = rh_name
    if display in used_names:
        display = f"{rh_name} · {wid[-6:]}"[:120]
    used_names.add(display)

    body = {
        "id": app_id,
        "name": display,
        "description": desc,
        "icon": "workflow" if output_kind == "image" else ("video" if output_kind == "video" else "app-window"),
        "cover_url": cover,
        "author": author,
        "category": category,
        "workflow_json": graph,
        "params_schema": schema,
        "bindings": bindings,
        "required_nodes": sorted({
            n.get("class_type") for n in graph.values()
            if isinstance(n, dict) and isinstance(n.get("class_type"), str)
        })[:80],
        "output_kind": output_kind,
        "submit_kind": "app_run",
        "is_nsfw": False,
        "is_public": IS_PUBLIC_DEFAULT,
        "sort": 200,
    }
    result["app_id"] = app_id
    result["category"] = category
    result["output_kind"] = output_kind
    result["schema_keys"] = [p["key"] for p in schema]

    if dry_run:
        result["status"] = "dry_run"
        result["reason"] = "ok"
        return result

    code, resp = _core_req(base, "POST", "/api/apps", token, body)
    if code not in (200, 201):
        # conflict? try patch if exists
        if code == 409 or (isinstance(resp, dict) and "已存在" in str(resp)):
            result["status"] = "skipped"
            result["reason"] = f"create_conflict_{code}"
            result["detail"] = resp
            return result
        result["status"] = "error"
        result["reason"] = f"create_{code}"
        result["detail"] = resp
        return result

    # verify
    vcode, vapp = _core_req(base, "GET", f"/api/apps/{app_id}", token)
    if vcode != 200 or not isinstance(vapp, dict):
        result["status"] = "error"
        result["reason"] = f"verify_get_{vcode}"
        return result
    stored_wf = vapp.get("workflow_json") or {}
    stored_n = len(stored_wf) if isinstance(stored_wf, dict) else -1
    stored_cover = vapp.get("cover_url") or ""
    result["stored_node_count"] = stored_n
    result["stored_cover_url"] = stored_cover
    ok_nodes = stored_n == node_count
    ok_cover = (not cover) or (stored_cover == cover) or (cover.split("?")[0] in stored_cover)
    if not ok_nodes:
        result["status"] = "error"
        result["reason"] = f"node_mismatch_export_{node_count}_stored_{stored_n}"
        return result
    if cover and not ok_cover:
        result["status"] = "error"
        result["reason"] = "cover_mismatch"
        return result
    result["status"] = "seeded"
    result["reason"] = "ok"
    return result


def write_report(ckpt: dict, phase: str) -> None:
    seeded = [x for x in ckpt.get("seeded") or []]
    skipped = ckpt.get("skipped") or []
    errors = ckpt.get("errors") or []
    reasons = Counter(x.get("reason") for x in skipped)
    err_reasons = Counter(x.get("reason") for x in errors)
    lines = [
        f"# RH accurate reseed — 2026-09-07",
        "",
        f"- Phase: **{phase}**",
        f"- Core: `{DEFAULT_BASE}`",
        f"- Seeded: **{len(seeded)}**",
        f"- Skipped: **{len(skipped)}**",
        f"- Errors: **{len(errors)}**",
        "",
        "## Skip reasons",
        "",
    ]
    for r, c in reasons.most_common():
        lines.append(f"- `{r}`: {c}")
    if err_reasons:
        lines += ["", "## Error reasons", ""]
        for r, c in err_reasons.most_common():
            lines.append(f"- `{r}`: {c}")
    lines += ["", "## Sample seeded app ids", ""]
    for s in seeded[:15]:
        lines.append(
            f"- `{s.get('app_id')}` — {s.get('name','')[:50]} — "
            f"nodes={s.get('export_node_count')} RH:{s.get('webappId')}"
        )
    if ckpt.get("spot_checks"):
        lines += ["", "## Spot-checks (5)", ""]
        for sc in ckpt["spot_checks"]:
            lines.append(
                f"- webapp `{sc.get('webappId')}` name={sc.get('name')} "
                f"workflowState={sc.get('workflowState')} workflowId={sc.get('workflowId')} "
                f"cover={'yes' if sc.get('cover_url') else 'no'}"
            )
    lines += [
        "",
        "## Method",
        "",
        "1. `POST /api/webapp/detail` → require `workflowState==1` + `workflowId`",
        "2. `POST /api/openapi/getJsonApiFormat` → `data.prompt` Comfy API graph",
        "3. Schema/bindings from RH `inputNodes` (+ graph LoadImage/CLIPTextEncode fallback)",
        "4. `POST /api/apps` non-builtin public; description contains `RH:{webappId}`",
        "5. Verify stored node count == export; cover URL matches card",
        "",
        "NO template clones. BUILD_ID: none (HTTP seed only).",
        "",
        "No commit/push; AGENTS.md not touched.",
    ]
    REPORT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    REPORT_JSON.write_text(json.dumps({
        "phase": phase,
        "seeded_count": len(seeded),
        "skipped_count": len(skipped),
        "error_count": len(errors),
        "skip_reasons": dict(reasons),
        "error_reasons": dict(err_reasons),
        "sample_app_ids": [s.get("app_id") for s in seeded[:20]],
        "seeded": seeded,
        "skipped": skipped,
        "errors": errors,
        "spot_checks": ckpt.get("spot_checks") or [],
        "BUILD_ID": None,
    }, ensure_ascii=False, indent=2), encoding="utf-8")


def _pool_remaining(rows: list[dict], processed: set[str], seeded_wids: set[str],
                     attempt_cap: int, per_family: int) -> list[dict]:
    """Pick remaining candidates, excluding already processed/seeded, with family diversity then fill."""
    remaining = [r for r in rows if r["webappId"] not in processed and r["webappId"] not in seeded_wids]
    if attempt_cap <= 0:
        return remaining
    # diversify first via pick_pilot on remaining only
    diversified = _pick_pilot(remaining, target=min(attempt_cap, len(remaining)), per_family=per_family)
    seen = {r["webappId"] for r in diversified}
    if len(diversified) >= attempt_cap:
        return diversified[:attempt_cap]
    for r in remaining:
        if len(diversified) >= attempt_cap:
            break
        if r["webappId"] in seen:
            continue
        diversified.append(r)
        seen.add(r["webappId"])
    return diversified


def write_scale_report(ckpt: dict, phase: str, baseline_seeded: int, new_seeded: list,
                       post_spot: list) -> None:
    seeded = ckpt.get("seeded") or []
    skipped = ckpt.get("skipped") or []
    errors = ckpt.get("errors") or []
    reasons = Counter(x.get("reason") for x in skipped)
    err_reasons = Counter(x.get("reason") for x in errors)
    fam = Counter()
    for s in seeded:
        for f in (s.get("families") or ["other"]):
            fam[f] += 1
    scale_md = ROOT / ".regen_tmp" / "rh-accurate-reseed-scale2-20260907.md"
    scale_json = ROOT / ".regen_tmp" / "rh_accurate_reseed_scale2_report.json"
    lines = [
        "# RH accurate reseed SCALE2 — 2026-09-07",
        "",
        "- Time: 2026-09-07 (Asia/Shanghai)",
        f"- Core: `{DEFAULT_BASE}`",
        "- Script: `.regen_tmp/seed_rh_accurate_20260907.py`",
        "- Checkpoint: `.regen_tmp/rh_accurate_reseed_checkpoint.json`",
        f"- Phase: **{phase}**",
        "",
        "## Outcome",
        "",
        f"- **New seeded this run: {len(new_seeded)}**",
        f"- **Cumulative seeded: {len(seeded)}** (baseline before scale: {baseline_seeded})",
        f"- **Cumulative skipped: {len(skipped)}**",
        f"- **Cumulative errors: {len(errors)}**",
        f"- Processed ids: {len(ckpt.get('processed_ids') or [])}",
        "- BUILD_ID: none (HTTP seed only)",
        "- NO template clones",
        "",
        "## Skip reasons (cumulative)",
        "",
    ]
    for r, c in reasons.most_common():
        lines.append(f"- `{r}`: {c}")
    if err_reasons:
        lines += ["", "## Error reasons (cumulative)", ""]
        for r, c in err_reasons.most_common():
            lines.append(f"- `{r}`: {c}")
    lines += ["", "## Family coverage (cumulative seeded)", ""]
    for f, c in fam.most_common():
        lines.append(f"- {f}: {c}")
    lines += ["", "## Sample new seeded app ids (this run)", ""]
    for s in new_seeded[:25]:
        lines.append(
            f"- `{s.get('app_id')}` — {str(s.get('name',''))[:50]} — "
            f"nodes={s.get('export_node_count')} RH:{s.get('webappId')}"
        )
    if post_spot:
        ok_n = sum(1 for sc in post_spot if sc.get("ok"))
        lines += ["", f"## Post-batch spot-checks ({ok_n}/{len(post_spot)} OK)", ""]
        for sc in post_spot:
            lines.append(
                f"- `{sc.get('app_id')}` RH:{sc.get('webappId')} nodes={sc.get('stored_nodes')}/"
                f"{sc.get('export_nodes')} cover={sc.get('cover_ok')} desc_RH={sc.get('desc_ok')} "
                f"builtin={sc.get('is_builtin')} ok={sc.get('ok')}"
            )
    lines += [
        "",
        "## Method",
        "",
        "Same accurate path as pilot:",
        "1. detail → workflowState==1 + workflowId",
        "2. getJsonApiFormat → real prompt JSON",
        "3. admin create + verify nodes/cover (ASCII binding leaves only)",
        "",
        "No commit/push; AGENTS.md not touched.",
        "",
    ]
    scale_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    scale_json.write_text(json.dumps({
        "phase": phase,
        "baseline_seeded": baseline_seeded,
        "new_seeded_count": len(new_seeded),
        "cumulative_seeded": len(seeded),
        "cumulative_skipped": len(skipped),
        "cumulative_errors": len(errors),
        "skip_reasons": dict(reasons),
        "error_reasons": dict(err_reasons),
        "family_coverage": dict(fam),
        "sample_new_app_ids": [s.get("app_id") for s in new_seeded[:30]],
        "new_seeded": new_seeded,
        "post_spot_checks": post_spot,
        "BUILD_ID": None,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print("scale_report", scale_md)


def _post_spot_checks(base: str, token: str, seeded_rows: list[dict], n: int = 10) -> list[dict]:
    """Spot-check >=n recently seeded apps via GET."""
    import random
    pool = [s for s in seeded_rows if s.get("app_id")]
    if len(pool) <= n:
        sample = pool
    else:
        sample = pool[-n:]  # prefer newest
        # also mix a few random older if available
        older = [s for s in pool[:-n]]
        if older:
            sample = sample[: max(6, n - 4)] + random.sample(older, min(4, len(older)))
            sample = sample[:n]
    out = []
    for s in sample:
        app_id = s.get("app_id")
        code, vapp = _core_req(base, "GET", f"/api/apps/{app_id}", token)
        if code != 200 or not isinstance(vapp, dict):
            out.append({"app_id": app_id, "webappId": s.get("webappId"), "ok": False, "reason": f"get_{code}"})
            continue
        stored_wf = vapp.get("workflow_json") or {}
        stored_n = len(stored_wf) if isinstance(stored_wf, dict) else -1
        exp_n = s.get("export_node_count") or s.get("stored_node_count")
        cover = s.get("cover_url") or ""
        stored_cover = vapp.get("cover_url") or ""
        desc = vapp.get("description") or ""
        wid = str(s.get("webappId") or "")
        desc_ok = f"RH:{wid}" in desc
        cover_ok = (not cover) or (stored_cover == cover) or (cover.split("?")[0] in stored_cover)
        nodes_ok = (exp_n is None) or (stored_n == exp_n)
        is_builtin = bool(vapp.get("is_builtin"))
        ok = nodes_ok and cover_ok and desc_ok and not is_builtin and stored_n > 0
        out.append({
            "app_id": app_id,
            "webappId": wid,
            "name": vapp.get("name"),
            "export_nodes": exp_n,
            "stored_nodes": stored_n,
            "cover_ok": cover_ok,
            "desc_ok": desc_ok,
            "is_builtin": is_builtin,
            "ok": ok,
        })
    return out


def main() -> None:
    global REPORT_MD, REPORT_JSON
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--phase", choices=["A", "B", "C", "scale"], default="A")
    ap.add_argument("--limit", type=int, default=0, help="override candidate attempt cap")
    ap.add_argument("--target-seeded", type=int, default=0, help="stop after cumulative N successful seeds")
    ap.add_argument("--target-new", type=int, default=0, help="stop after N NEW seeds this run")
    ap.add_argument("--sleep", type=float, default=0.35)
    ap.add_argument("--resume", action="store_true", default=True)
    ap.add_argument("--fresh-ckpt", action="store_true", help="ignore checkpoint (dangerous)")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    if not base.startswith("http://192.168."):
        raise SystemExit("refusing non-LAN base")

    api_key = _load_rh_key()
    origin, token = _load_admin()
    if args.base == DEFAULT_BASE:
        base = origin  # prefer auth origin

    rows = _load_candidates()
    phase = "C" if args.phase == "scale" else args.phase

    ckpt = _load_ckpt() if (args.resume and not args.fresh_ckpt) else {
        "seeded": [], "skipped": [], "errors": [], "processed_ids": [], "spot_checks": [],
    }
    processed = set(ckpt.get("processed_ids") or [])
    seeded_wids = {s.get("webappId") for s in ckpt.get("seeded") or []}
    if args.apply:
        seeded_wids |= _already_seeded_webapp_ids(base, token)

    baseline_seeded = len(ckpt.get("seeded") or [])
    new_seeded_this_run: list[dict] = []

    if phase == "A":
        target_seeded = args.target_seeded or 40
        attempt_cap = args.limit or 120
        per_family = 15
        pool = _pool_remaining(rows, processed, seeded_wids, attempt_cap, per_family)
    elif phase == "B":
        target_seeded = args.target_seeded or 300
        attempt_cap = args.limit or 800
        per_family = 80
        pool = _pool_remaining(rows, processed, seeded_wids, attempt_cap, per_family)
    else:  # C / scale
        target_seeded = args.target_seeded or (baseline_seeded + 500)
        attempt_cap = args.limit or 3500
        per_family = 120
        pool = _pool_remaining(rows, processed, seeded_wids, attempt_cap, per_family)
        REPORT_MD = ROOT / ".regen_tmp" / "rh-accurate-reseed-scale2-20260907.md"
        REPORT_JSON = ROOT / ".regen_tmp" / "rh_accurate_reseed_scale2_report.json"

    target_new = args.target_new or 0
    print(
        f"phase={phase} pool={len(pool)} catalog={len(rows)} "
        f"baseline_seeded={baseline_seeded} target_seeded={target_seeded} "
        f"target_new={target_new or 'n/a'} apply={args.apply} remaining_excl={len(rows)-len(processed)}"
    )
    used_names: set[str] = set()

    # Spot-check 5 details up front (phase A)
    if phase == "A" and not ckpt.get("spot_checks"):
        checks = []
        for row in pool[:8]:
            if len(checks) >= 5:
                break
            st, detail, reason = rh_detail(api_key, row["webappId"])
            checks.append({
                "webappId": row["webappId"],
                "name": (detail or {}).get("name") or row.get("name"),
                "status": st,
                "reason": reason,
                "workflowId": (detail or {}).get("workflowId") if detail else None,
                "workflowState": (detail or {}).get("workflowState") if detail else None,
                "cover_url": _cover_from_detail(detail or {}, str(row.get("coverUrl") or "")) if detail else "",
                "inputNodes": len((detail or {}).get("inputNodes") or []) if detail else 0,
            })
            time.sleep(args.sleep)
        ckpt["spot_checks"] = checks
        _save_ckpt(ckpt)
        print("spot_checks", json.dumps(checks, ensure_ascii=False)[:800])

    for row in pool:
        n_seeded = len(ckpt.get("seeded") or [])
        if n_seeded >= target_seeded:
            print(f"reached target_seeded={target_seeded}")
            break
        if target_new and len(new_seeded_this_run) >= target_new:
            print(f"reached target_new={target_new}")
            break
        wid = row["webappId"]
        if wid in processed or wid in seeded_wids:
            continue
        try:
            result = seed_one(api_key, base, token, row, dry_run=not args.apply, used_names=used_names)
        except Exception as e:
            result = {
                "webappId": wid,
                "name": row.get("name"),
                "status": "error",
                "reason": f"exception_{type(e).__name__}",
                "detail": str(e)[:300],
            }
        processed.add(wid)
        ckpt.setdefault("processed_ids", []).append(wid)
        st = result.get("status")
        if st == "seeded":
            ckpt.setdefault("seeded", []).append(result)
            seeded_wids.add(wid)
            new_seeded_this_run.append(result)
            print("SEEDED", result.get("app_id"), result.get("name", "")[:40],
                  "nodes", result.get("export_node_count"), result.get("families"),
                  f"new={len(new_seeded_this_run)} cum={len(ckpt.get('seeded') or [])}")
        elif st == "dry_run":
            # do not inflate cumulative seeded / processed permanently for apply resume
            ckpt.setdefault("dry_runs", []).append(result)
            new_seeded_this_run.append(result)  # count toward target_new in dry mode
            print("DRY", result.get("app_id"), result.get("name", "")[:40],
                  "nodes", result.get("export_node_count"), result.get("families"),
                  f"new={len(new_seeded_this_run)}")
        elif st == "skipped":
            ckpt.setdefault("skipped", []).append(result)
            print("SKIP", wid, result.get("reason"), (result.get("name") or "")[:40])
        else:
            ckpt.setdefault("errors", []).append(result)
            print("ERR", wid, result.get("reason"), str(result.get("detail"))[:120])
        _save_ckpt(ckpt)
        time.sleep(args.sleep)

    post_spot: list[dict] = []
    if args.apply and new_seeded_this_run:
        post_spot = _post_spot_checks(base, token, new_seeded_this_run, n=12)
        ckpt["scale_spot_checks"] = post_spot
        _save_ckpt(ckpt)
        ok_n = sum(1 for sc in post_spot if sc.get("ok"))
        print(f"post_spot_checks {ok_n}/{len(post_spot)} OK")

    if phase in ("C", "scale") or args.target_new:
        write_scale_report(ckpt, phase, baseline_seeded, new_seeded_this_run, post_spot)
    else:
        write_report(ckpt, phase)

    n_seeded = len(ckpt.get("seeded") or [])
    n_skip = len(ckpt.get("skipped") or [])
    n_err = len(ckpt.get("errors") or [])
    print(
        f"DONE phase={phase} new_seeded={len(new_seeded_this_run)} "
        f"cumulative_seeded={n_seeded} skipped={n_skip} errors={n_err}"
    )
    print("report", REPORT_MD)


if __name__ == "__main__":
    main()
