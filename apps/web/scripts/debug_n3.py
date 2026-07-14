from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 375, "height": 812})
    page.goto("http://localhost:8081/login")
    page.wait_for_load_state("networkidle")
    page.locator('input[type="text"]').fill("admin")
    page.locator('input[type="password"]').fill("admin123")
    page.locator('button[type="submit"]').click(force=True)
    page.wait_for_url("http://localhost:8081/", wait_until="networkidle")
    time.sleep(1)

    portals = page.locator("nextjs-portal").all()
    for i, portal in enumerate(portals):
        html = portal.inner_html()
        if html.strip():
            print(f"--- portal {i} ---")
            print(html[:800])
    browser.close()
