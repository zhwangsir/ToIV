from playwright.sync_api import sync_playwright
import time

BASE_URL = "http://localhost:3100"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto(f"{BASE_URL}/login")
    page.wait_for_load_state("networkidle")
    page.locator('input[type="text"]').fill("admin")
    page.locator('input[type="password"]').fill("admin123")
    page.locator('button[type="submit"]').click(force=True)
    page.wait_for_url(f"{BASE_URL}/", wait_until="networkidle")
    page.wait_for_selector(".app-sidebar", state="visible")
    time.sleep(1)

    # 检查各分类的 aria-expanded 和子项数量
    sections = page.locator(".app-sidebar-section").all()
    print(f"section count: {len(sections)}")
    for i, sec in enumerate(sections):
        title = sec.locator(".app-sidebar-section-title").first
        expanded = title.get_attribute("aria-expanded")
        label = title.inner_text()
        items = sec.locator(".app-sidebar-item").count()
        print(f"[{i}] {label.strip()!r} expanded={expanded} items={items}")

    # 截图
    page.screenshot(path="/tmp/toiv-test/debug_sidebar.png", full_page=False)
    browser.close()
