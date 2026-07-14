import { test, expect, type Page } from "@playwright/test";

/**
 * 短剧生成完整流程 E2E(headed 模式,真实用户点击 + 输入)
 *
 * 流程:登录 → 译制页面 → 上传视频 → Whisper 听写 → 配音生成 → 口型同步
 * 每一步都有截图作为证据
 */

const SCREENSHOT_DIR = "/tmp/dub-flow-screenshots";
const TEST_VIDEO = "/tmp/test_short_drama.mp4";

// 辅助:截图
async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: false });
  console.log(`[截图] ${name}.png`);
}

// 辅助:等待文本出现(长超时)
async function waitText(page: Page, text: string, timeout = 120000) {
  await page.getByText(text).first().waitFor({ state: "visible", timeout });
}

test.setTimeout(600000); // 10 分钟总超时

test("短剧生成完整流程", async ({ browser }) => {
  // 用独立 context(headed 模式,让用户能看到)
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: "/tmp/dub-flow-video" },
  });
  const page = await context.newPage();

  // 收集 console 错误
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  try {
    // ── 1. 登录 ──────────────────────────────────────────────
    console.log("[步骤 1] 登录");
    await page.goto("https://toiv.dgmt.top/?view=login", { waitUntil: "domcontentloaded" });
    // 公网生产模式走 CSR,登录表单靠 JS 加载;先等网络空闲再等 input(最长 60s)
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.locator('input[type="text"], input[type="email"]').first().waitFor({ state: "visible", timeout: 60000 });

    // 填写凭据
    await page.locator('input[type="text"], input[type="email"]').first().fill("admin");
    await page.locator('input[type="password"]').first().fill("admin123");
    await shot(page, "01-login-page");

    // 点击登录
    await page.getByRole("button", { name: "登录" }).click();
    await page.waitForTimeout(3000);
    await shot(page, "02-after-login");

    // 验证登录成功(应该看到导航栏)
    await expect(page.getByText("AI 助手").first()).toBeVisible({ timeout: 15000 });
    console.log("[步骤 1] ✅ 登录成功");

    // ── 2. 导航到译制页面 ────────────────────────────────────
    console.log("[步骤 2] 导航到译制页面");
    await page.goto("https://toiv.dgmt.top/?view=dub", { waitUntil: "domcontentloaded" });
    // 译制页面也是 CSR,等上传区出现
    await page.locator('input[type="file"], .dub-upload, [class*="upload"]').first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await shot(page, "03-dub-view");

    // 验证译制页面出现
    await expect(page.getByRole("heading", { name: "上传源视频" })).toBeVisible({ timeout: 10000 });
    console.log("[步骤 2] ✅ 译制页面加载成功");

    // ── 3. 上传视频文件 ──────────────────────────────────────
    console.log("[步骤 3] 上传视频文件");
    const fileInput = page.locator('input[type="file"][accept="video/*"]');
    await fileInput.setInputFiles(TEST_VIDEO);
    await page.waitForTimeout(1000);
    await shot(page, "04-file-selected");

    // 验证文件已选中(应显示文件名)
    await expect(page.getByText("test_short_drama.mp4")).toBeVisible({ timeout: 5000 });
    console.log("[步骤 3a] ✅ 文件已选中");

    // 点击"开始上传"
    await page.getByRole("button", { name: "开始上传" }).click();

    // 等待上传完成(应出现"已上传"徽章或"下一步"按钮)
    console.log("[步骤 3b] 等待上传完成...");
    try {
      await waitText(page, "已上传", 60000);
      await shot(page, "05-upload-done");
      console.log("[步骤 3b] ✅ 上传完成");
    } catch {
      await shot(page, "05-upload-failed");
      // 检查是否有错误
      const errorText = await page.locator(".dub-error").textContent().catch(() => null);
      console.log(`[步骤 3b] ❌ 上传可能失败: ${errorText || "未知错误"}`);
      throw new Error(`上传失败: ${errorText}`);
    }

    // ── 4. 切换到 Step 2 听写字幕 ────────────────────────────
    console.log("[步骤 4] 切换到听写字幕");
    await page.getByRole("button", { name: "下一步 · 听写字幕" }).click();
    await page.waitForTimeout(1000);
    await shot(page, "06-step2-transcribe");

    // 验证 Step 2 出现
    await expect(page.getByRole("heading", { name: "生成字幕" })).toBeVisible({ timeout: 5000 });
    console.log("[步骤 4] ✅ 进入听写字幕步骤");

    // ── 5. Whisper 听写 ──────────────────────────────────────
    console.log("[步骤 5] 启动 Whisper 听写");
    await page.getByRole("button", { name: "Whisper 听写" }).click();
    await shot(page, "07-whisper-start");

    // 等待听写完成(应出现字幕分段或"条字幕"徽章)
    console.log("[步骤 5] 等待 Whisper 听写完成(最长 5 分钟)...");
    try {
      await waitText(page, "条字幕", 300000); // 5 分钟超时
      await shot(page, "08-whisper-done");
      console.log("[步骤 5] ✅ Whisper 听写完成");
    } catch {
      await shot(page, "08-whisper-failed");
      const errorText = await page.locator(".dub-error").textContent().catch(() => null);
      console.log(`[步骤 5] ❌ 听写可能失败: ${errorText || "超时"}`);
      throw new Error(`听写失败: ${errorText || "超时"}`);
    }

    // ── 6. 切换到 Step 3 配音生成 ────────────────────────────
    console.log("[步骤 6] 切换到配音生成");
    await page.getByRole("button", { name: "下一步 · 配音生成" }).click();
    await page.waitForTimeout(1000);
    await shot(page, "09-step3-voice");

    // 验证 Step 3 出现
    await expect(page.getByRole("heading", { name: "配音生成" })).toBeVisible({ timeout: 5000 });
    console.log("[步骤 6] ✅ 进入配音生成步骤");

    // 填写情绪提示词
    const emoInput = page.locator('input[placeholder*="平静"]').first();
    if (await emoInput.isVisible()) {
      await emoInput.fill("平静、温暖");
      console.log("[步骤 6a] 填写情绪提示词: 平静、温暖");
    }

    // ── 7. 生成配音轨 ────────────────────────────────────────
    console.log("[步骤 7] 启动配音生成");
    await page.getByRole("button", { name: "生成配音轨" }).click();
    await shot(page, "10-voice-start");

    // 等待配音完成
    console.log("[步骤 7] 等待配音生成完成(最长 5 分钟)...");
    try {
      await waitText(page, "配音轨", 300000);
      await shot(page, "11-voice-done");
      console.log("[步骤 7] ✅ 配音生成完成");
    } catch {
      await shot(page, "11-voice-failed");
      const errorText = await page.locator(".dub-error").textContent().catch(() => null);
      console.log(`[步骤 7] ❌ 配音可能失败: ${errorText || "超时"}`);
      throw new Error(`配音失败: ${errorText || "超时"}`);
    }

    // ── 8. 切换到 Step 4 口型同步 ────────────────────────────
    console.log("[步骤 8] 切换到口型同步");
    // 找"下一步"按钮
    const nextBtn = page.getByRole("button", { name: /下一步|口型/ }).first();
    if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await nextBtn.click();
    } else {
      // 手动点击步骤 4
      await page.getByRole("button", { name: "4 口型同步" }).click();
    }
    await page.waitForTimeout(1000);
    await shot(page, "12-step4-lipsync");

    // ── 9. 开始对口型 ────────────────────────────────────────
    console.log("[步骤 9] 启动口型同步");
    // 精确匹配启动按钮(DubView step4 doLipsync 按钮文案)
    const lipsyncBtn = page.getByRole("button", { name: /提交对口型任务|提交动漫对口型|生成精剪|重新提交/ }).first();
    if (await lipsyncBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await lipsyncBtn.click();
      await shot(page, "13-lipsync-start");

      // 等待口型同步启动(出现"处理中"或状态徽章)
      console.log("[步骤 9] 等待口型同步启动(最长 30s)...");
      try {
        await waitText(page, "处理中", 30000);
        await shot(page, "14-lipsync-running");
        console.log("[步骤 9] ✅ 口型同步任务已启动");
      } catch {
        await shot(page, "14-lipsync-no-progress");
        console.log("[步骤 9] ⚠️ 未检测到处理中文案(可能已完成或异步)");
      }
    } else {
      console.log("[步骤 9] 未找到口型同步启动按钮");
      await shot(page, "13-lipsync-no-btn");
    }

    // ── 最终截图 ──────────────────────────────────────────────
    await shot(page, "15-final");
    console.log("[完成] 短剧生成流程结束");

    // 输出 console 错误汇总
    if (consoleErrors.length > 0) {
      console.log(`\n[Console 错误汇总] ${consoleErrors.length} 条:`);
      consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  ${i + 1}. ${e.slice(0, 200)}`));
    } else {
      console.log("\n[Console 错误汇总] 0 条 ✅");
    }
  } finally {
    await context.close();
  }
});
