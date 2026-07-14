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
    time.sleep(0.6)

    # 查找包含文本 "N" 的元素
    els = page.locator("text=N").all()
    print(f"found {len(els)} elements containing 'N'")
    for i, el in enumerate(els[:20]):
        tag = el.evaluate("e => e.tagName")
        cls = el.evaluate("e => e.className")
        text = el.inner_text()
        rect = el.bounding_box()
        outer = el.evaluate("e => e.outerHTML.slice(0, 200)")
        print(f"[{i}] tag={tag} class={cls!r} text={text!r} rect={rect} outer={outer}")

    browser.close()
