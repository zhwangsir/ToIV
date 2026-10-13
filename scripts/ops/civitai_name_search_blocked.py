"""W9 P1-4:走「名字检索」(生效参数是 query=,不是 search=)救 blocked 台账里 suggested_next=Civitai 的条目(只读探测)。

为什么不是 by-hash:调研结论推荐 by-hash 神谕,但实测台账 blocked=337 条里
**带 sha256 的有 0 条**(见 STATE pass_rate_gate… 同批核算)——没有哈希就没有 by-hash,
只能退回名字检索。生效参数是 **query=**:`search=`/`q`/`searchTerm`/`sort` 全部被静默忽略
(实测三词返回同一批,首条 id 恒为 257749 Pony V6)——这正是「工具可用 ≠ 对这批数据可用」。

边界(硬性):
  · 只取元数据(modelId/versionId/creator/许可旗标/fileMetadata),不下载权重、不注册账号、
    不绕登录墙/付费墙;
  · 不抓取也不复述任何露骨内容;按 nsfwLevel/tags 只登记分类旗标;
  · 涉及未成年一律绝对禁区:命中即跳过并记 `excluded_policy`,不做任何进一步查询。

P-12 纪律:先自证 `query=` 是否真生效——拿三个不同词打同一接口,
若返回同一批(首条 id 不变)就是被静默忽略,整批结论作废,不写任何账。

用法:
  python3 scripts/ops/civitai_name_search_blocked.py            # 只读,出 JSONL
  python3 scripts/ops/civitai_name_search_blocked.py --limit 20  # 先导
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEDGER = ROOT / "apps" / "api" / "app" / "data" / "model_sources.json"
OUT_DIR = ROOT / "tmp" / "civitai_name_search_20261013"
BASE = "https://civitai.red/api/v1"
UA = "ToIV/1.0 (+https://github.com/zhwangsir/ToIV)"

# 未成年相关词:命中即整条跳过(绝对禁区,优先级高于一切收益)
MINOR_TERMS = ("loli", "shota", "child", "kid", "minor", "schoolgirl", "schoolboy",
               "预教", "幼女", "幼男", "萝莉", "正太")


def get(path: str, params: dict | None = None, retries: int = 3) -> dict | None:
    """GET + UA + 4xx 不重试(重试 4xx 只会把权限问题伪装成网络问题)。"""
    q = f"?{urllib.parse.urlencode(params)}" if params else ""
    req = urllib.request.Request(BASE + path + q, method="GET")
    req.add_header("User-Agent", UA)
    for a in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:
                return {"_http": e.code}
            if a == retries - 1:
                return {"_http": e.code, "_err": "transport"}
            time.sleep(2 * (a + 1))
        except Exception as e:  # noqa: BLE001
            if a == retries - 1:
                return {"_err": f"{type(e).__name__}: {str(e)[:80]}"}
            time.sleep(2 * (a + 1))
    return None


def search_is_live(probe_terms: list[str]) -> tuple[bool, str]:
    """自证 query= 生效:不同词必须给不同批(首条 id 或总数变化)。"""
    sigs = {}
    for t in probe_terms:
        d = get("/models", {"type": "Model", "query": t, "limit": 5})
        items = (d or {}).get("items") or []
        sigs[t] = (len(items), items[0].get("id") if items else None)
    vals = list(sigs.values())
    if all(v == vals[0] for v in vals) and vals[0][1] is not None:
        return False, f"query= 被静默忽略:三词返回同一批 {sigs}"
    if all(v[0] == 0 for v in vals):
        return False, f"三词全空,接口形态可能变了: {sigs}"
    return True, json.dumps(sigs, ensure_ascii=False)[:220]


def term_for(basename: str) -> str:
    """从文件名提检索词:去扩展名/哈希尾巴/步数精度尾巴,保留主体。"""
    s = re.sub(r"\.(safetensors|ckpt|pt|pth|bin|onnx|gguf|pkl)$", "", basename, flags=re.I)
    s = re.sub(r"[-_.][A-Za-z0-9]{6,8}(?=\.)?$", "", s)          # xb7F 这类尾巴
    s = re.sub(r"(__|^\d+)", " ", s)
    s = re.sub(r"[-_](bf16|fp16|fp8|fp32|int8|int4|nvfp4|gguf)\b", "", s, flags=re.I)
    s = re.sub(r"\b\d+\s*步\s*[a-z0-9.]*\b", "", s, flags=re.I)
    s = re.sub(r"[-_]?\d+(steps|step)\b", "", s, flags=re.I)
    s = re.sub(r"[_-]\d{6,}", "", s)                                # _000000275
    s = re.sub(r"[&]?\s+", " ", s).strip(" -_.")
    return s[:80]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--sleep", type=float, default=0.35)
    ap.add_argument("--all-blocked", action="store_true",
                    help="不看 suggested_next,扫全部 blocked")
    args = ap.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"nameresult_{time.strftime('%H%M%S')}.jsonl"

    led = json.loads(LEDGER.read_text())
    items = led["items"]
    blocked = [i for i in items if i.get("status") == "blocked"]
    targets = blocked if args.all_blocked else [
        i for i in blocked if "suggested_next=Civitai" in str(i.get("notes", ""))]
    print(f"blocked 全集 {len(blocked)} | 本轮目标(suggested_next=Civitai) {len(targets)}")

    live, why = search_is_live(["Z-Image-Turbo", "totally nonsense zqxvjk", "Illustrious"])
    print(f"query= 生效自证: {'✅ 生效' if live else '❌ 不生效'} — {why}")
    if not live:
        print("按 P-12 整批结论作废,不写任何账。")
        return 3

    tally: dict[str, int] = {}
    t0 = time.time()
    with out_path.open("w", encoding="utf-8") as log:
        for n, it in enumerate(targets[: args.limit], 1):
            bn = it.get("basename") or ""
            low = bn.lower()
            hit = [t for t in MINOR_TERMS if t in low]
            if hit:
                rec = {"basename": bn, "state": "excluded_policy", "term_hits": hit}
                tally["excluded_policy"] = tally.get("excluded_policy", 0) + 1
                log.write(json.dumps(rec, ensure_ascii=False) + "\n"); log.flush()
                continue
            term = term_for(bn)
            if len(term) < 3:
                tally["term_too_short"] = tally.get("term_too_short", 0) + 1
                log.write(json.dumps({"basename": bn, "state": "term_too_short"},
                                     ensure_ascii=False) + "\n"); log.flush()
                continue
            d = get("/models", {"type": "Model", "query": term, "limit": 10})
            models = (d or {}).get("items") or []
            exact, ambiguous = [], []
            for m in models:
                for v in (m.get("modelVersions") or [])[:6]:
                    for f in (v.get("files") or [])[:8]:
                        fn = (f.get("name") or "").strip()
                        if fn.lower() == bn.lower():
                            exact.append((m, v, f))
                        elif fn and _stem(fn) == _stem(bn):
                            ambiguous.append((m, v, f))
            st = "matched" if exact else ("name_only" if models and ambiguous
                                          else ("partial" if models else "not_found"))
            tally[st] = tally.get(st, 0) + 1
            pick = (exact or ambiguous or [(None, None, None)])[0]
            m, v, f = pick
            rec = {
                "basename": bn, "term": term, "state": st,
                "hits": len(models),
                "modelId": (m or {}).get("id"), "modelName": (m or {}).get("name"),
                "type": (m or {}).get("type"),
                "nsfw": (m or {}).get("nsfw"),
                "versionId": (v or {}).get("id"), "versionName": (v or {}).get("name"),
                "fileName": (f or {}).get("name"), "fileMd5": (f or {}).get("md5"),
                "filePickle": (f or {}).get("pickleScanResult"),
                "virusScan": (f or {}).get("virusScanResult"),
                "sizeKB": (f or {}).get("sizeKB"),
                "creator": ((m or {}).get("creatorUserId")
                            or (v or {}).get("creator", {}).get("username")),
                "trainedWords": (v or {}).get("trainedWords"),
                "earlyAccess": (v or {}).get("earlyAccessEndsAt"),
                "downloadable_anon": (v or {}).get("downloadUrl") is not None,
            }
            if v:
                lc = v.get("licensing") or (v.get("meta") or {}).get("licensing") or {}
                rec["license_flags"] = {k: lc.get(k) for k in
                                        ("allowCommercialUse", "allowDerivatives",
                                         "allowDifferentLicense", "allowResale")}
            log.write(json.dumps(rec, ensure_ascii=False) + "\n"); log.flush()
            if n % 10 == 0 or n == min(len(targets), args.limit):
                el = n / max(time.time() - t0, 1)
                print(f"  {n}/{min(len(targets), args.limit)} | {tally} | {el:.1f} 条/s",
                      flush=True)
            time.sleep(args.sleep)

    total = sum(tally.values())
    print(f"\n完成 {total} 条 → {out_path.name}")
    print(f"状态分布: {json.dumps(tally, ensure_ascii=False)}")
    hit = tally.get("matched", 0) + tally.get("name_only", 0)
    print(f"可溯源(含仅同名不同精度) {hit}/{total} = {hit / max(total, 1):.1%}")
    print("注意:matched 只证明「找得到」,不等于「下得到」(匿名 401 属创作者开关)。")
    return 0


def _stem(s: str) -> str:
    s = re.sub(r"\.(safetensors|ckpt|pt|pth|bin|onnx|gguf|pkl)$", "", s, flags=re.I)
    return re.sub(r"[-_. ]", "", s).lower()


if __name__ == "__main__":
    sys.exit(main())
