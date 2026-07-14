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
    page.wait_for_selector(".app-sidebar", state="visible")
    time.sleep(1)
    page.screenshot(path="/tmp/toiv-test/assistant_mobile_debug.png", full_page=True)

    # 获取右下角附近元素
    el = page.evaluate("""() => {
      const rect = { x: 320, y: 780, width: 55, height: 55 };
      const el = document.elementFromPoint(rect.x + rect.width/2, rect.y + rect.height/2);
      if (!el) return null;
      let cur = el;
      const path = [];
      while (cur && cur !== document.body) {
        path.push(cur.tagName + (cur.className ? '.' + cur.className.split(' ').join('.') : ''));
        cur = cur.parentElement;
      }
      return { tag: el.tagName, className: el.className, text: el.innerText?.slice(0,50), path };
    }""")
    print(el)
    browser.close()
