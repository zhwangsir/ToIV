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

    result = page.evaluate(r"""() => {
      const all = Array.from(document.querySelectorAll('*'));
      const hits = [];
      for (const el of all) {
        const text = (el.textContent || '').trim();
        if (text === 'N') {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          hits.push({
            tag: el.tagName,
            className: el.className,
            id: el.id,
            text: text.slice(0,30),
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            position: style.position,
          });
        }
      }
      return hits;
    }""")
    for r in result:
        print(r)
    browser.close()
