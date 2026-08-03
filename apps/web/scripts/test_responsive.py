from playwright.sync_api import sync_playwright
import time

BASE_URL = "http://localhost:3100"


def login(page):
    page.goto(f"{BASE_URL}/login")
    page.wait_for_load_state("networkidle")
    page.locator('input[type="text"]').fill("admin")
    page.locator('input[type="password"]').fill("admin123")
    page.locator('button[type="submit"]').click(force=True)
    page.wait_for_url(f"{BASE_URL}/", wait_until="networkidle")
    page.wait_for_selector(".app-sidebar-item", state="visible")
    time.sleep(0.6)


def test_viewport(page, width, height):
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{BASE_URL}/?view=generate")
    page.wait_for_load_state("networkidle")
    time.sleep(0.5)
    has_overflow = page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth")
    panel_count = page.locator(".generate-params").count()
    stage_count = page.locator(".generate-results").count()
    # 通过计算样式判断 generate-body 是单列还是双列
    grid_cols = page.locator(".generate-body").first.evaluate("(el) => window.getComputedStyle(el).flexDirection")
    is_single = grid_cols.strip() == "column"  # 窄屏时 generate-body 转纵向
    print(f"viewport {width}x{height}: overflow={has_overflow}, panels={panel_count}, stages={stage_count}, flex_dir={grid_cols!r}, single_col={is_single}")
    page.screenshot(path=f"/tmp/toiv-test/generate_{width}x{height}.png", full_page=True)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    login(page)
    test_viewport(page, 1440, 900)
    test_viewport(page, 1100, 800)
    test_viewport(page, 900, 700)
    test_viewport(page, 768, 600)
    browser.close()
