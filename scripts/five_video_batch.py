#!/usr/bin/env python3
"""五路 60s 高清视频批量提交(2026-08-19):不同风格 × 三引擎并行。

引擎分工(全部 duration_sec=60 + resolution_target=1080p 自动超分链):
  1. H3        赛博朋克城市夜行(extend 4 段末帧续写,1344×768)
  2. H3        深海发光水母纪录片(extend 4 段,1344×768)
  3. LTX-2.5   水墨江南(extend 3 段音画同出,960×544)
  4. LongCat   吉卜力夏日原野(单镜头 961 帧 @16fps,832×480)
  5. LongCat   雪山日出延时(单镜头,1280×720)

提交原则:H3 负向约束不可靠 → 全正向指令;LongCat 单镜头引擎 → 提示词
明确「单个连续长镜头」保流畅;提交间隔 sleep 防限流。
"""
import json
import sys
import time
import urllib.request

BASE = "http://localhost:8090"

sys.path.insert(0, "/home/merlin/toiv/api")


def get_token() -> str:
    import os

    os.chdir("/home/merlin/toiv/api")
    for line in open("/home/merlin/toiv/deploy/.env"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.removeprefix("export ").strip(), v.strip().strip('"').strip("'"))
    # 显式取 admin(2026-08-20 教训:limit(1) 无序取到微信冒烟账号,
    # 作品挂错属主在作品库不可见)
    from app.db import engine
    from sqlmodel import Session, select

    from app.models import User
    from app.security import create_token

    with Session(engine) as s:
        u = s.exec(select(User).where(User.role == "admin")).first()
        return create_token(str(u.id))


def post(path: str, payload: dict, token: str) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as rsp:
            return {"status": rsp.status, "body": json.loads(rsp.read())}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "body": e.read().decode()[:300]}


TASKS = [
    {
        "name": "h3_cyberpunk",
        "path": "/api/h3/t2v",
        "payload": {
            "positive": (
                "霓虹赛博朋克城市夜景,雨后湿滑街道反射绚丽霓虹灯光,镜头沿街道平稳向前推进,"
                "行人撑全息伞走过,巨型广告牌与全息投影闪烁变换,蒸汽从井盖缓缓升起,"
                "电影级布光,高对比冷暖色调,细节丰富,运镜连贯流畅"
            ),
            "width": 1344, "height": 768, "duration_sec": 60,
            "steps": 20, "resolution_target": "1080p",
        },
    },
    {
        "name": "h3_jellyfish",
        "path": "/api/h3/t2v",
        "payload": {
            "positive": (
                "深海纪录片风格,一群半透明发光水母在幽蓝深海中缓慢漂浮,生物发光的触手随水流"
                "轻柔摆动,镜头缓慢环绕下潜,悬浮微粒在光束中闪烁,神秘宁静氛围,"
                "自然纪录片摄影质感,细节锐利,运镜平稳连贯"
            ),
            "width": 1344, "height": 768, "duration_sec": 60,
            "steps": 20, "resolution_target": "1080p",
        },
    },
    {
        "name": "ltx25_ink_jiangnan",
        "path": "/api/ltx25/t2v",
        "payload": {
            "positive": (
                "中国水墨画风格,江南水乡清晨,薄雾笼罩小桥流水人家,乌篷船缓缓划过平静水面,"
                "远山如黛,柳枝轻拂,镜头平稳横移,水墨晕染质感,大量留白,禅意悠远,氛围宁静"
            ),
            "width": 960, "height": 544, "duration_sec": 60,
            "fps": 24, "steps": 8, "resolution_target": "1080p",
        },
    },
    {
        "name": "longcat_ghibli_field",
        "path": "/api/longcat/t2v",
        "payload": {
            "positive": (
                "吉卜力动画风格,夏日广阔原野,白云在蓝天缓缓飘动,风吹过金色草浪形成波纹,"
                "远处小屋炊烟袅袅上升,镜头缓慢平稳向前推进,手绘水彩质感,清新明亮色彩,"
                "治愈系氛围,单个连续长镜头"
            ),
            "width": 832, "height": 480, "duration_sec": 60,
            "fps": 16, "steps": 10, "resolution_target": "1080p",
        },
    },
    {
        "name": "longcat_mountain_sunrise",
        "path": "/api/longcat/t2v",
        "payload": {
            "positive": (
                "电影感风光摄影,雪山日出延时,云海在山间翻涌流动,太阳缓缓升起将雪峰染成金色,"
                "光线随时间自然过渡变化,固定机位,超高清细节,史诗感构图,单个连续镜头"
            ),
            "width": 1280, "height": 720, "duration_sec": 60,
            "fps": 16, "steps": 10, "resolution_target": "1080p",
        },
    },
]


def main() -> None:
    token = get_token()
    print(f"token ok, 提交 {len(TASKS)} 个任务\n")
    results = {}
    for t in TASKS:
        r = post(t["path"], t["payload"], token)
        body = r["body"]
        print(f"[{t['name']}] HTTP {r['status']}")
        if r["status"] == 200:
            pid = body.get("prompt_id") or body.get("job_id") or ""
            notice = body.get("duration_notice") or ""
            print(f"  prompt_id={pid}")
            if notice:
                print(f"  notice: {notice}")
            results[t["name"]] = pid
        else:
            print(f"  ERR: {body}")
        time.sleep(8)  # 防生成限流
    print("\n=== 提交汇总 ===")
    print(json.dumps(results, ensure_ascii=False, indent=2))
    with open("/tmp/five_video_jobs.json", "w") as f:
        json.dump(results, f)


if __name__ == "__main__":
    main()
