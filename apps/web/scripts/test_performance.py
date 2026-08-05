from playwright.sync_api import sync_playwright
import time
import json
from pathlib import Path

BASE_URL = "http://localhost:3100"
OUT = Path("/tmp/toiv-test")
OUT.mkdir(exist_ok=True)

VIEWS = [
    ("assistant", "AI 助手"),
    ("image", "图片"),
    ("video", "视频"),
    ("audio", "音频"),
    ("canvas", "画布"),
    ("studio", "创作"),
    ("dub", "译制"),
    ("train", "训练"),
    ("library", "作品库"),
    ("models", "模型"),
]


def login(page):
    page.goto(f"{BASE_URL}/login")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector("#account", state="visible")
    page.locator("#account").fill("admin")
    page.locator("#password").fill("admin123")
    page.locator('button[type="submit"]').click(force=True)
    page.wait_for_url(f"{BASE_URL}/", wait_until="networkidle")
    page.wait_for_selector(".app-sidebar", state="visible")
    time.sleep(0.6)


def measure_view(page, key, label):
    # 通过侧边栏切换视图
    btn = page.locator(f'.app-sidebar-item:has-text("{label}")')
    if btn.count():
        btn.first.click(force=True)
        time.sleep(0.5)
    else:
        page.goto(f"{BASE_URL}/?view={key}")
        page.wait_for_load_state("networkidle")
        time.sleep(0.3)

    metrics = page.evaluate("() => JSON.stringify(window.performance.getEntriesByType('navigation'))")
    nav = json.loads(metrics)
    paint = page.evaluate("() => JSON.stringify(window.performance.getEntriesByType('paint'))")
    paints = json.loads(paint)

    result = {"view": key, "navigation": nav, "paint": paints}
    # 提取关键指标
    if nav:
        n = nav[0]
        result["summary"] = {
            "dns": round(n.get("domainLookupEnd", 0) - n.get("domainLookupStart", 0), 2),
            "tcp": round(n.get("connectEnd", 0) - n.get("connectStart", 0), 2),
            "ttfb": round(n.get("responseStart", 0) - n.get("fetchStart", 0), 2),
            "download": round(n.get("responseEnd", 0) - n.get("responseStart", 0), 2),
            "dom_ready": round(n.get("domContentLoadedEventEnd", 0) - n.get("fetchStart", 0), 2),
            "load_complete": round(n.get("loadEventEnd", 0) - n.get("fetchStart", 0), 2),
        }
    for p in paints:
        if p["name"] == "first-contentful-paint":
            result["summary"]["fcp"] = round(p["startTime"], 2)
    return result


def run():
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        login(page)
        for key, label in VIEWS:
            results.append(measure_view(page, key, label))
        browser.close()

    out_path = OUT / "performance_metrics.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"saved {out_path}")

    print("\n关键性能指标汇总 (ms):")
    print(f"{'视图':<12} {'FCP':>8} {'DOM Ready':>12} {'Load':>10}")
    for r in results:
        s = r.get("summary", {})
        print(f"{r['view']:<12} {s.get('fcp', '-'):>8} {s.get('dom_ready', '-'):>12} {s.get('load_complete', '-'):>10}")


if __name__ == "__main__":
    run()
