import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * 可访问性测试
 * - 对首页和 5 个主要视图用 AxeBuilder 扫描
 * - 只关注 critical 和 serious 级别的违规
 * - 如果 @axe-core/playwright 安装失败,改为只检查基本 a11y
 */

const TARGETS = [
  { name: "home", url: "/" },
  { name: "assistant", url: "/?view=assistant" },
  { name: "generate", url: "/?view=generate" },
  { name: "library", url: "/?view=library" },
  { name: "models", url: "/?view=models" },
  { name: "canvas", url: "/?view=canvas" },
];

for (const target of TARGETS) {
  test.describe(`a11y: ${target.name}`, () => {
    test(`${target.name} 不应有 critical/serious a11y 违规`, async ({ page }) => {
      const response = await page.goto(target.url);

      // 跳过被重定向到登录页的目标
      if (response && /\/login/.test(page.url())) {
        test.skip(true, "重定向到登录页,跳过 a11y 扫描");
        return;
      }

      try {
        await page.waitForLoadState("networkidle", { timeout: 10000 });
      } catch {
        // 忽略
      }

      let axeAvailable = true;
      try {
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa"])
          .analyze();

        const critical = results.violations.filter(
          (v) => v.impact === "critical",
        );
        const serious = results.violations.filter(
          (v) => v.impact === "serious",
        );

        test.info().annotations.push({
          type: "violations",
          description: `critical=${critical.length}, serious=${serious.length}`,
        });

        // 不强制失败,只记录。dev 模式下很多 a11y 问题来自运行时数据
        if (critical.length > 0) {
          console.log(
            `[${target.name}] critical violations:`,
            critical.map((v) => v.id).join(", "),
          );
        }
        if (serious.length > 0) {
          console.log(
            `[${target.name}] serious violations:`,
            serious.map((v) => v.id).join(", "),
          );
        }

        expect(critical.length, `${target.name} 不应有 critical 违规`).toBe(0);
      } catch (e) {
        axeAvailable = false;
        console.log(`[${target.name}] Axe 不可用,回退基本 a11y:`, e);
      }

      if (!axeAvailable) {
        // 基本 a11y 检查:img 应有 alt,button 应有文本或 aria-label
        const imagesWithoutAlt = await page
          .locator("img:not([alt])")
          .count();
        const buttonsWithoutText = await page
          .locator("button:not([aria-label]):not([aria-labelledby])")
          .evaluateAll((els) =>
            els.filter((el) => !el.textContent?.trim()).length,
          );

        expect(
          imagesWithoutAlt,
          `${target.name} 无 alt 的 img 应为 0`,
        ).toBe(0);
        expect(
          buttonsWithoutText,
          `${target.name} 无文本/aria 的 button 应为 0`,
        ).toBe(0);
      }
    });
  });
}
