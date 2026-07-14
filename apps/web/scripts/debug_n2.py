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

    # 在左下角 N 附近取点
    pts = [(28, 760), (28, 780), (40, 770), (25, 775)]
    for x, y in pts:
        el = page.evaluate(f"""() => {{
          const el = document.elementFromPoint({x}, {y});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return {{
            tag: el.tagName,
            className: el.className,
            id: el.id,
            text: (el.textContent || '').trim().slice(0,40),
            rect: {{x:r.x, y:r.y, w:r.width, h:r.height}},
            before: style.content,
            bg: style.backgroundImage.slice(0,80),
          }};
        }}""")
        print(x, y, el)
    browser.close()
