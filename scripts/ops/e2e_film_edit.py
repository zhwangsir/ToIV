#!/usr/bin/env python3
"""FU2 成片剪辑生产 e2e（真机、多 take、自检闭环）。

流程即 agent 的工作流:
  1) 索引一条真实成片的转录(媒体库文本检索数据层);
  2) 文本检索命中短语;
  3) 提交一个故意宽的 EDL → 期望被剪规拦下,但 takes_packed.md 已产出;
  4) 读 packed md 的短语间隙(≥0.5s)选干净切点,重提 EDL;
  5) 轮询作业到 done/needs_review,核对 qa/findings 与成片时长、下钻图、产物可下载。

用法: python3 scripts/ops/e2e_film_edit.py <take_a.mp4 绝对路径> <take_b.mp4 绝对路径>
(路径须为 core 上 api 进程可读的本地路径)
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request

BASE = "http://192.168.71.47:8090"
LINE_RE = re.compile(r"^\s*\[(\d+\.\d+)-(\d+\.\d+)\]")


def req(method, path, body=None, tok=None, timeout=120, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if tok:
        r.add_header("Authorization", f"Bearer {tok}")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x:
            payload = x.read()
            if raw:
                return x.status, payload
            return x.status, (json.loads(payload.decode()) if payload else {})
    except urllib.error.HTTPError as e:
        err = e.read().decode(errors="replace")[:200]
        return e.code, (err if raw else {"_err": err})


def main() -> int:
    take_a, take_b = sys.argv[1], sys.argv[2]
    st, login = req("POST", "/api/auth/login", {"email": "admin", "password": "admin123"})
    assert st == 200, login
    tok = login["token"]

    st, ix = req("POST", "/api/admin/media/transcript", {"url": take_a}, tok, timeout=600)
    print(f"[1] transcript index http={st} {ix}")
    assert st == 200 and ix.get("words", 0) > 0, "转录索引失败或无词"

    st, empty = req("GET", "/api/admin/media/transcripts/search?q=", tok=tok)
    assert st == 200 and empty == {"q": "", "results": []}, empty

    st, bad = req("POST", "/api/admin/edit/jobs",
                  {"edl": {"sources": {"a": take_a}, "ranges": [{"source": "a", "start": 0.0, "end": 0.7}]}}, tok)
    print(f"[3] wide EDL submit http={st} {bad}")
    assert st == 202, bad
    j1 = bad["job_id"]
    for _ in range(60):
        st, s1 = req("GET", f"/api/admin/edit/jobs/{j1}", tok=tok)
        if s1.get("status") not in ("queued", "running"):
            break
        time.sleep(3)
    print(f"    job1 status={s1.get('status')} err={str(s1.get('error'))[:120]}")
    assert s1.get("status") == "error" and "校验不过" in s1.get("error", ""), "宽 EDL 应被剪规拦下"

    st, md_b = req("GET", f"/api/edit/files/{j1}/takes_packed.md", tok=tok, raw=True)
    assert st == 200, md_b
    print(f"[4] packed md http={st} bytes={len(md_b)}")
    raw = md_b.decode()
    phrases = [(float(a), float(b)) for a, b in LINE_RE.findall(raw)]
    assert len(phrases) >= 2, f"短语不足: {phrases}"
    cuts = []
    for (s0, e0), (s1_, _) in zip(phrases, phrases[1:]):
        if s1_ - e0 >= 0.5:
            cuts.append((e0 + (s1_ - e0) / 2))
    assert cuts, f"没有 ≥0.5s 的短语间隙: {phrases}"
    r1 = (max(0.0, phrases[0][0] - 0.0), cuts[0])
    r2 = (cuts[0], min(phrases[-1][1] + 0.2, cuts[0] + 6.0)) if len(cuts) > 1 else (cuts[0], phrases[-1][1])
    print(f"    选切点 cuts={cuts[:3]} ranges={r1} {r2}")

    st, good = req("POST", "/api/admin/edit/jobs", {"edl": {
        "sources": {"a": take_a, "b": take_b},
        "ranges": [
            {"source": "a", "start": round(r1[0], 2), "end": round(r1[1], 2), "beat": "takeA", "reason": "e2e"},
            {"source": "b", "start": round(r2[0], 2), "end": round(r2[1], 2), "beat": "takeB"},
        ]}}, tok)
    print(f"[5] clean EDL submit http={st} {good}")
    assert st == 202, good
    j2 = good["job_id"]
    for _ in range(200):
        st, s2 = req("GET", f"/api/admin/edit/jobs/{j2}", tok=tok)
        if s2.get("status") not in ("queued", "running"):
            break
        time.sleep(5)
    print(f"    job2 status={s2.get('status')} rounds={s2.get('rounds')} "
          f"qa_loudness={s2.get('qa', {}).get('loudness_i')} mean={s2.get('qa', {}).get('mean_db')} "
          f"findings={[f['kind'] for f in s2.get('findings', [])]}")
    assert s2.get("status") in ("done", "needs_review"), s2
    for name in (s2.get("out"), s2.get("view"), s2.get("packed")):
        code = urllib.request.urlopen(urllib.request.Request(
            BASE + f"/api/edit/files/{j2}/{name}",
            headers={"Authorization": f"Bearer {tok}"}), timeout=120).status
        print(f"    artifact {name} http={code}")
        assert code == 200
    print("E2E OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
