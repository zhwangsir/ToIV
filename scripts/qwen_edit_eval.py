#!/usr/bin/env python3
"""Qwen-Image-Edit 全面评测:3 主体 × 6 操作矩阵,生产 API 生成 + molmo2 VLM 三维评分。

用法: python3 scripts/qwen_edit_eval.py [--round NAME]
产物: /tmp/qwen_eval/<round>/ 下源图+结果图+report.json+报告打印
"""
import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

import urllib.parse

CORE = "http://100.77.80.100:8090"
VLM = "http://100.81.235.124:8000/v1/chat/completions"
OUT = Path("/tmp/qwen_eval") / (sys.argv[sys.argv.index("--round") + 1] if "--round" in sys.argv else "r1")
OUT.mkdir(parents=True, exist_ok=True)

def token():
    req = urllib.request.Request(
        CORE + "/api/auth/login",
        data=json.dumps({"email": "admin", "password": "admin123"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req, timeout=30))["token"]

TK = token()

def api(path, body=None, raw=False, files=None):
    url = CORE + path
    if files:
        import requests  # Mac 上有 requests
        r = requests.post(url, headers={"Authorization": f"Bearer {TK}"}, files=files, timeout=120)
        return r.json()
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {TK}", "Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=120)
    return resp.read() if raw else json.loads(resp.read())

def upload(path: Path):
    import requests
    r = requests.post(CORE + "/api/upload?kind=img2img",
                      headers={"Authorization": f"Bearer {TK}"},
                      files={"image": (path.name, open(path, "rb"), "image/png")}, timeout=120)
    d = r.json()
    return d["filename"], d["worker"]

def qwen_edit(filename, worker, positive="", camera=None, fast=True, seed=42):
    body = {"image": filename, "worker": worker, "positive": positive,
            "camera": camera, "fast": fast, "seed": seed}
    return api("/api/generate/qwen-edit", body)["prompt_id"]

def wait_job(pid, timeout=300):
    t0 = time.time()
    while time.time() - t0 < timeout:
        jobs = api("/api/jobs?limit=50")
        for j in jobs:
            if j["prompt_id"] == pid:
                if j["status"] == "done" and j.get("results"):
                    return j["results"][0]
                if j["status"] == "error":
                    raise RuntimeError("job error")
        time.sleep(4)
    raise TimeoutError(pid)

def download(url_path, dest: Path):
    sep = "&" if "?" in url_path else "?"
    req = urllib.request.Request(CORE + url_path + sep + "token=" + TK,
                                 headers={"Authorization": f"Bearer {TK}"})
    dest.write_bytes(urllib.request.urlopen(req, timeout=120).read())

def b64(path: Path):
    return base64.b64encode(path.read_bytes()).decode()

def vlm_score(src: Path, out: Path, instruction: str) -> dict:
    prompt = (
        "你是图像编辑质量评审。给定[原图]和[编辑后图],编辑指令是:「%s」。\n"
        "按三个维度各打 1-10 分,只输出 JSON:\n"
        '{"instruction_following": int(指令是否被准确执行), '
        '"identity_preservation": int(未要求改变的部分/主体一致性保持程度), '
        '"quality": int(画质/ artifacts 程度,10=无瑕疵), "comment": "一句话中文评价"}\n'
        "原图在后,编辑图在前。" % instruction
    )
    body = {
        "model": "omni-captioner",
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64(out)}"}},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64(src)}"}},
        ]}],
        "max_tokens": 300, "temperature": 0.1,
    }
    req = urllib.request.Request(VLM, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    txt = json.load(urllib.request.urlopen(req, timeout=180))["choices"][0]["message"]["content"]
    # 容错解析
    import re
    m = re.search(r"\{.*\}", txt, re.S)
    return json.loads(m.group(0))

# ── 评测矩阵 ──
SUBJECTS = {
    "char": ("/tmp/char_front.png", "卡通男孩角色立绘"),
    "ink": ("/tmp/qwen_edit_src.png", "水墨园林画"),
}
OPS = [
    ("semantic_style", "把画面变成赛博朋克霓虹风格", None),
    ("semantic_object", "给主体添加一顶红色的帽子", None),
    ("cam_rotate_left", "", "rotate_left"),
    ("cam_rotate_right", "", "rotate_right"),
    ("cam_top_down", "", "top_down"),
    ("cam_closeup", "", "closeup"),
]

report = []
for subj, (src_path, desc) in SUBJECTS.items():
    src = Path(src_path)
    fn, wk = upload(src)
    for op, positive, camera in OPS:
        name = f"{subj}_{op}"
        instr = positive or camera
        try:
            pid = qwen_edit(fn, wk, positive, camera)
            url = wait_job(pid)
            out = OUT / f"{name}.png"
            download(url, out)
            score = vlm_score(src, out, positive or f"相机:{camera}")
            report.append({"case": name, "instruction": instr, "fast": True, **score})
            print(f"[{name}] IF={score['instruction_following']} IP={score['identity_preservation']} Q={score['quality']} | {score.get('comment','')}")
        except Exception as e:
            report.append({"case": name, "instruction": instr, "error": str(e)})
            print(f"[{name}] ERROR {e}")

(OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
ok = [r for r in report if "error" not in r]
if ok:
    for dim in ("instruction_following", "identity_preservation", "quality"):
        avg = sum(r[dim] for r in ok) / len(ok)
        print(f"AVG {dim}: {avg:.1f}")
print("report:", OUT / "report.json")
