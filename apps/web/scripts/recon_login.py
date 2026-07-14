from playwright.sync_api import sync_playwright
import json

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto("http://localhost:8081/login")
    page.wait_for_load_state("networkidle")
    page.screenshot(path="/tmp/recon_login.png", full_page=True)

    # 发现表单字段和按钮
    inputs = page.locator("input").all()
    buttons = page.locator("button").all()
    print("=== Inputs ===")
    for i in inputs:
        print(i.get_attribute("type"), i.get_attribute("name"), i.get_attribute("placeholder"))
    print("=== Buttons ===")
    for b in buttons:
        print(b.inner_text().strip(), b.get_attribute("type"))

    browser.close()
