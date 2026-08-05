from playwright.sync_api import sync_playwright, ConsoleMessage
from pathlib import Path
import time
import json

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

MOBILE_VIEWS = [("assistant", "AI 助手"), ("image", "图片"), ("studio", "创作")]


def login(page, console_logs):
    page.goto(f"{BASE_URL}/login")
    page.wait_for_load_state("networkidle")
    page.locator('input[type="text"]').fill("admin")
    page.locator('input[type="password"]').fill("admin123")
    page.locator('button[type="submit"]').click(force=True)
    page.wait_for_url(f"{BASE_URL}/", wait_until="networkidle")
    # 等待侧边栏渲染并让其展开动画完成
    page.wait_for_selector(".app-sidebar", state="visible")
    page.wait_for_selector(".app-sidebar-item", state="visible")
    time.sleep(0.6)


def screenshot_view(page, key, label, suffix="desktop"):
    # 移动端需要先打开抽屉
    if suffix == "mobile":
        toggle = page.locator(".mobile-menu-toggle")
        if toggle.count() and not page.locator(".app-shell.is-sidebar-open").count():
            toggle.first.click(force=True)
            time.sleep(0.3)
    # 通过侧边栏按钮切换视图
    btn = page.locator(f'.app-sidebar-item:has-text("{label}")')
    if btn.count():
        btn.first.click(force=True)
        time.sleep(0.6)
    else:
        # 兜底:地址栏深链
        page.goto(f"{BASE_URL}/?view={key}")
        page.wait_for_load_state("networkidle")
        time.sleep(0.3)
    path = OUT / f"{key}_{suffix}.png"
    page.screenshot(path=str(path), full_page=True)
    print(f"saved {path}")
    return str(path)


def validate_layout(page, suffix="desktop"):
    """基础布局断言:顶栏、侧边栏、主内容区均正常渲染。"""
    assert page.locator(".topbar").count() > 0, "顶栏缺失"
    assert page.locator(".app-sidebar").count() > 0, "侧边栏缺失"
    assert page.locator(".app-main").count() > 0, "主内容区缺失"
    if suffix == "desktop":
        # 桌面端侧边栏应常驻可见
        assert page.locator(".app-sidebar").first.is_visible(), "桌面端侧边栏不可见"
    else:
        # 移动端汉堡按钮应可见
        assert page.locator(".mobile-menu-toggle").first.is_visible(), "移动端菜单按钮不可见"


def run():
    console_logs = []

    def on_console(msg: ConsoleMessage):
        console_logs.append({"type": msg.type, "text": msg.text, "location": msg.location})

    with sync_playwright() as p:
        # 桌面端
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", on_console)
        login(page, console_logs)
        validate_layout(page, "desktop")
        for key, label in VIEWS:
            screenshot_view(page, key, label, "desktop")
        browser.close()

        # 移动端
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 375, "height": 812})
        page.on("console", on_console)
        login(page, console_logs)
        validate_layout(page, "mobile")
        for key, label in MOBILE_VIEWS:
            screenshot_view(page, key, label, "mobile")
        browser.close()

    # 保存控制台日志
    log_path = OUT / "console_logs.json"
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(console_logs, f, ensure_ascii=False, indent=2)
    print(f"saved {log_path}")


if __name__ == "__main__":
    run()
