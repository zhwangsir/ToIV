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

    # 在左下角几个点采样元素
    points = [(30, 880), (40, 880), (50, 880), (60, 880), (30, 860), (30, 890)]
    for x, y in points:
        el = page.evaluate(f"() => {{ const el = document.elementFromPoint({x}, {y}); return el ? {{tag: el.tagName, class: el.className, text: el.innerText?.slice(0,50), html: el.outerHTML.slice(0,200)}} : null; }}")
        print(f"({x},{y}): {el}")

    # 也采样 account avatar 位置
    avatar = page.locator(".app-sidebar-account-avatar").first
    if avatar.count():
        box = avatar.bounding_box()
        print("avatar box:", box)
        text = avatar.inner_text()
        print("avatar text:", repr(text))
        html = avatar.evaluate("e => e.outerHTML")
        print("avatar html:", html)

    browser.close()
