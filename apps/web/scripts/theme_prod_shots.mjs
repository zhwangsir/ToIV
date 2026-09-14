import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://192.168.71.47:3100";
const OUT = "/tmp/theme-prod";
const token = fs.readFileSync("/tmp/toiv_token_tmp.txt", "utf8").trim();
fs.mkdirSync(OUT, { recursive: true });

const PRESETS = ["minimal", "cinema", "paper", "graphite"];
const PURPLE = "#8B5CF6";

function applyThemeInPage(theme, mode = null, accent = null) {
  // Returns a function for page.evaluate
  return ({ theme, mode, accent }) => {
    try {
      if (theme === "minimal") {
        localStorage.removeItem("toiv_theme");
        delete document.documentElement.dataset.theme;
      } else {
        localStorage.setItem("toiv_theme", theme);
        document.documentElement.dataset.theme = theme;
      }
      if (mode === "dark") {
        localStorage.setItem("toiv_mode", "dark");
        document.documentElement.dataset.mode = "dark";
      } else if (mode === "light") {
        localStorage.setItem("toiv_mode", "light");
        delete document.documentElement.dataset.mode;
      }
      if (accent) {
        localStorage.setItem("toiv_accent_custom", accent);
        document.documentElement.dataset.accentCustom = "1";
        document.documentElement.style.setProperty("--accent-user", accent);
        // approximate on-color
        const r = parseInt(accent.slice(1, 3), 16);
        const g = parseInt(accent.slice(3, 5), 16);
        const b = parseInt(accent.slice(5, 7), 16);
        const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        document.documentElement.style.setProperty("--accent-user-on", l > 0.55 ? "#17181A" : "#FFFFFF");
      } else if (accent === null) {
        localStorage.removeItem("toiv_accent_custom");
        delete document.documentElement.dataset.accentCustom;
        document.documentElement.style.removeProperty("--accent-user");
        document.documentElement.style.removeProperty("--accent-user-on");
      }
      window.dispatchEvent(new CustomEvent("toiv:theme-changed", { detail: { theme, mode: mode || undefined, accent: accent ?? undefined } }));
    } catch (e) {
      return String(e);
    }
    return "ok";
  };
}

async function shot(page, name) {
  const fp = path.join(OUT, name);
  await page.screenshot({ path: fp, fullPage: false });
  const st = fs.statSync(fp);
  console.log(`SAVED ${name} bytes=${st.size}`);
  return fp;
}

async function gotoView(page, view) {
  await page.goto(`${BASE}/?view=${view}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  console.log("STEP goto base");
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(800);

  console.log("STEP inject token");
  await page.evaluate((t) => {
    localStorage.setItem("toiv_token", t);
  }, token);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // Confirm login
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const url = page.url();
  const hasLogin =
    /登录|login|sign in|邮箱|密码/i.test(bodyText) &&
    !(await page.locator("nav, .app-bottom-nav, text=设置, text=市场").first().isVisible().catch(() => false));
  const hasNav = await page.locator("nav, .app-bottom-nav, [role='navigation']").first().isVisible().catch(() => false);
  const hasSettings = bodyText.includes("设置") || (await page.getByText("设置").first().isVisible().catch(() => false));
  const hasMarket = bodyText.includes("市场") || (await page.getByText("市场").first().isVisible().catch(() => false));

  console.log(`LOGIN_CHECK url=${url}`);
  console.log(`LOGIN_CHECK hasNav=${hasNav} hasSettings=${hasSettings} hasMarket=${hasMarket}`);
  console.log(`LOGIN_CHECK bodySnippet=${JSON.stringify(bodyText.slice(0, 200))}`);

  // Detect stuck on login: look for login form inputs without main nav
  const loginForm = await page.locator('input[type="password"], input[name="password"], button:has-text("登录")').first().isVisible().catch(() => false);
  if (loginForm && !hasNav) {
    console.log("LOGIN_FAILED token_expired_or_invalid");
    await shot(page, "login-failed.png");
    await browser.close();
    process.exit(3);
  }
  console.log("LOGIN_OK");

  // Reset theme to minimal light no accent before picker shot
  await page.evaluate(applyThemeInPage(), { theme: "minimal", mode: "light", accent: null });
  await gotoView(page, "settings");
  await page.waitForTimeout(1000);
  // Ensure ThemePicker visible
  const pickerVisible = await page.locator(".theme-picker").first().isVisible().catch(() => false);
  console.log(`ThemePicker visible=${pickerVisible}`);
  if (!pickerVisible) {
    // scroll to it
    await page.locator(".theme-picker").first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
  }
  await shot(page, "theme-picker-open.png");

  // Capture each preset home + market
  for (const theme of PRESETS) {
    await page.evaluate(applyThemeInPage(), { theme, mode: "light", accent: null });
    await page.waitForTimeout(400);
    await gotoView(page, "home");
    await page.waitForTimeout(800);
    await shot(page, `theme-${theme}-home.png`);
    await gotoView(page, "market");
    await page.waitForTimeout(800);
    await shot(page, `theme-${theme}-market.png`);
  }

  // Custom accent purple on home (minimal base)
  await page.evaluate(applyThemeInPage(), { theme: "minimal", mode: "light", accent: PURPLE });
  await gotoView(page, "home");
  await page.waitForTimeout(800);
  await shot(page, "theme-custom-accent-purple.png");

  // Minimal dark mode
  await page.evaluate(applyThemeInPage(), { theme: "minimal", mode: "dark", accent: null });
  await gotoView(page, "home");
  await page.waitForTimeout(800);
  const modeAttr = await page.evaluate(() => document.documentElement.dataset.mode || "light");
  console.log(`minimal dark modeAttr=${modeAttr}`);
  await shot(page, "theme-minimal-dark-home.png");

  // Visual notes: sample computed styles
  const notes = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      theme: document.documentElement.dataset.theme || "minimal",
      mode: document.documentElement.dataset.mode || "light",
      bg: cs.getPropertyValue("--bg-canvas").trim(),
      accent: cs.getPropertyValue("--accent").trim() || cs.getPropertyValue("--accent-user").trim(),
      title: document.title,
    };
  });
  console.log("VISUAL_NOTES " + JSON.stringify(notes));

  await browser.close();
  // cleanup token file
  try { fs.unlinkSync("/tmp/toiv_token_tmp.txt"); } catch {}
  console.log("DONE");
}

main().catch((e) => {
  console.error("FATAL", e && e.message ? e.message : e);
  process.exit(1);
});
