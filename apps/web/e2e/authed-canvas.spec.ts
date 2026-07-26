import { test, expect, type Page } from "@playwright/test";

/**
 * 画布核心流 E2E 测试 (chromium-authed project)
 *
 * 对应 M1.5d 子任务:覆盖无限画布视图的 6 个核心流。
 *  - 登录态下渲染正常
 *  - 工具栏可见(选择器 / 新建 / 添加节点 / 语音开关)
 *  - 新建画布后选择器中出现
 *  - 添加文本节点出现在画布上
 *  - 拖动节点不报错
 *  - 打开语音开关显示 VoiceBar
 *
 * 选择器对齐 CanvasView.tsx / VoiceBar.tsx 实际 className:
 *  - 根容器:        .canvas-view
 *  - 顶部工具栏:     header.cv-toolbar
 *  - 画布选择器:     select[aria-label="选择画布"]
 *  - 新建画布按钮:   button[aria-label="新建画布"]   (文案"新建")
 *  - 添加节点按钮:   .cv-add-menu button[aria-haspopup="menu"]  (文案"添加节点")
 *  - 添加节点菜单项: .cv-add-item (role="menuitem"),label 见 ADD_NODE_OPTIONS
 *  - 语音开关按钮:   button[aria-label="语音 Agent 开关"]  (文案"语音"/"语音已开")
 *  - VoiceBar:      .voice-bar (role="region" aria-label="语音助手")
 *  - ReactFlow 节点: .react-flow__node
 *
 * M2 新增(WorkflowLibrary / runSubgraph):
 *  - 模板库按钮:     button[aria-label="模板库"]   (文案"模板")
 *  - 模板库弹出面板:  .cv-workflow-library (role="dialog")
 *  - 模板卡片:       .cv-workflow-item
 *  - 运行选中按钮:   .cv-run-selected (aria-label="运行选中节点")
 */

const ERROR_PATTERNS = [
  "Application error",
  "Internal Server Error",
  "500",
  "会话已过期",
  "Something went wrong",
  "TypeError",
  "ReferenceError",
  "Cannot read",
  "is not defined",
];

// 关键选择器(集中管理,便于源码 className 变更时同步)
const SEL = {
  canvasView: ".canvas-view",
  toolbar: "header.cv-toolbar",
  canvasSelect: 'select[aria-label="选择画布"]',
  newCanvasBtn: 'button[aria-label="新建画布"]',
  addNodeBtn: '.cv-add-menu button[aria-haspopup="menu"]',
  addNodePopover: ".cv-add-popover",
  addNodeItemText: '.cv-add-item:has-text("文本")',
  voiceToggleBtn: 'button[aria-label="语音 Agent 开关"]',
  voiceBar: ".voice-bar",
  reactFlow: ".react-flow",
  reactFlowNode: ".react-flow__node",
};

/** 失败时截图并抛出带描述性信息的错误(总是 throw,返回 Promise<never>) */
async function failWithScreenshot(
  page: Page,
  msg: string,
  shotPath: string,
): Promise<never> {
  await page.screenshot({ path: shotPath, fullPage: true });
  throw new Error(`${msg}(截图: ${shotPath})`);
}

/** 等待关键选择器出现,超时则截图并抛错 */
async function waitOrFail(
  page: Page,
  selector: string,
  timeout: number,
  label: string,
  shotPath: string,
): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout });
  } catch {
    await failWithScreenshot(
      page,
      `${label}: 等待选择器 ${selector} 超时(${timeout}ms)`,
      shotPath,
    );
  }
}

/** 确保当前有激活画布;若无则新建一个,并等待 ReactFlow 渲染完成。
 *  CanvasView 在无 activeCanvasId 且 canvases 非空时会自动选中第一个,
 *  所以这里只关心"选择器中至少有一个真实画布 + ReactFlow 已渲染"。 */
async function ensureActiveCanvas(page: Page): Promise<void> {
  await waitOrFail(
    page,
    SEL.canvasView,
    10000,
    "ensureActiveCanvas 根容器",
    "test-results/authed-canvas-ensure.png",
  );
  await waitOrFail(
    page,
    SEL.toolbar,
    10000,
    "ensureActiveCanvas 工具栏",
    "test-results/authed-canvas-ensure.png",
  );
  await waitOrFail(
    page,
    SEL.canvasSelect,
    10000,
    "ensureActiveCanvas 选择器",
    "test-results/authed-canvas-ensure.png",
  );

  // 等待 canvases 加载完成(空态也会有"尚无画布"option)
  try {
    await page.waitForSelector(`${SEL.canvasSelect} option`, { timeout: 10000 });
  } catch {
    // 加载卡住,继续往下判断
  }

  // 检查是否有真实画布(option value 非空)
  const realOptions = page.locator(
    `${SEL.canvasSelect} option:not([value=""])`,
  );
  const realCount = await realOptions.count();

  if (realCount === 0) {
    // 无画布,点击"新建"按钮创建一个
    const newBtn = page.locator(SEL.newCanvasBtn);
    await newBtn.click();
    try {
      await expect(realOptions).toHaveCount(1, { timeout: 15000 });
    } catch {
      await failWithScreenshot(
        page,
        "ensureActiveCanvas: 新建画布后选择器中未出现新画布",
        "test-results/authed-canvas-ensure.png",
      );
    }
  }

  // 等待 ReactFlow 容器渲染(标志激活画布已加载完成)
  try {
    await page.waitForSelector(SEL.reactFlow, { timeout: 10000 });
  } catch {
    await failWithScreenshot(
      page,
      "ensureActiveCanvas: ReactFlow 容器未渲染(可能画布加载失败)",
      "test-results/authed-canvas-ensure.png",
    );
  }
}

test.describe("画布核心流", () => {
  // 前置:确认 storageState 中确实有 token(globalSetup 可能登录失败)
  // 复用 authed-views.spec.ts 的 token 校验逻辑
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/");
    const token = await page.evaluate(() =>
      window.localStorage.getItem("toiv_token"),
    );
    await context.close();
    if (!token) {
      test.skip(true, "globalSetup 未获取到 token,跳过画布核心流测试");
      return;
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/?view=canvas", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {
      // dev 模式 networkidle 可能超时,忽略
    }
    // 等待 canvas 根容器可见
    try {
      await page.waitForSelector(SEL.canvasView, { timeout: 10000 });
    } catch {
      await page.screenshot({
        path: "test-results/authed-canvas-beforeeach.png",
        fullPage: true,
      });
      throw new Error("canvas 视图未加载:.canvas-view 容器未出现");
    }
  });

  // 1. canvas 登录态下渲染正常
  test("canvas 登录态下渲染正常", { tag: "@authed" }, async ({ page }) => {
    try {
      // 校验 canvas 根容器可见
      await expect(page.locator(SEL.canvasView)).toBeVisible({
        timeout: 10000,
      });
      // 校验 app-shell / topbar / sidebar 可见(对齐 authed-views 风格)
      await expect(page.locator(".app-shell")).toBeVisible({
        timeout: 10000,
      });
      await expect(page.locator("header.topbar")).toBeVisible();
      await expect(page.locator("aside.app-sidebar")).toBeVisible();
      // 校验无 .landing-form(不应是登录页)
      const landingFormCount = await page.locator(".landing-form").count();
      expect(landingFormCount, "canvas 登录态下不应有登录表单").toBe(0);
      // 校验无 ERROR_PATTERNS 文案
      const bodyText = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      const errorFound = ERROR_PATTERNS.some((p) =>
        bodyText.toLowerCase().includes(p.toLowerCase()),
      );
      expect(errorFound, "canvas 不应包含错误文案").toBe(false);
    } catch (e) {
      await page.screenshot({
        path: "test-results/authed-canvas.png",
        fullPage: true,
      });
      throw e;
    }
    await page.screenshot({
      path: "test-results/authed-canvas.png",
      fullPage: true,
    });
    test.info().annotations.push({ type: "view", description: "canvas" });
  });

  // 2. canvas 工具栏可见
  test("canvas 工具栏可见", { tag: "@authed" }, async ({ page }) => {
    try {
      // 校验画布工具栏可见
      await expect(page.locator(SEL.toolbar)).toBeVisible({
        timeout: 10000,
      });
      // 校验画布选择器可见
      await expect(page.locator(SEL.canvasSelect)).toBeVisible();
      // 校验"新建画布"按钮可见
      await expect(page.locator(SEL.newCanvasBtn)).toBeVisible();
      // 校验"添加节点"按钮可见
      await expect(page.locator(SEL.addNodeBtn)).toBeVisible();
      // 校验语音开关按钮可见
      await expect(page.locator(SEL.voiceToggleBtn)).toBeVisible();
    } catch (e) {
      await page.screenshot({
        path: "test-results/authed-canvas-toolbar.png",
        fullPage: true,
      });
      throw e;
    }
    await page.screenshot({
      path: "test-results/authed-canvas-toolbar.png",
      fullPage: true,
    });
  });

  // 3. 新建画布后选择器中出现
  test("新建画布后选择器中出现", { tag: "@authed" }, async ({ page }) => {
    try {
      // 等待工具栏 + 选择器就绪
      await expect(page.locator(SEL.toolbar)).toBeVisible({ timeout: 10000 });
      await expect(page.locator(SEL.canvasSelect)).toBeVisible();

      // 等待 canvases 列表加载完成(至少有一个 option)
      try {
        await page.waitForSelector(`${SEL.canvasSelect} option`, {
          timeout: 10000,
        });
      } catch {
        // 加载未完成,继续(用 0 作为基线)
      }

      // 记录选择器中现有真实画布数量(option value 非空)
      const realOptions = page.locator(
        `${SEL.canvasSelect} option:not([value=""])`,
      );
      const beforeCount = await realOptions.count();
      test
        .info()
        .annotations.push({
          type: "beforeCount",
          description: String(beforeCount),
        });

      // 点击"新建画布"按钮
      await page.locator(SEL.newCanvasBtn).click();

      // 等待选择器更新(真实画布数量 +1)
      try {
        await expect(realOptions).toHaveCount(beforeCount + 1, {
          timeout: 15000,
        });
      } catch {
        const afterCount = await realOptions.count();
        await page.screenshot({
          path: "test-results/authed-canvas-new.png",
          fullPage: true,
        });
        throw new Error(
          `新建画布后选择器中画布数量未增加: 期望 ${beforeCount + 1}, 实际 ${afterCount}`,
        );
      }

      test
        .info()
        .annotations.push({
          type: "afterCount",
          description: String(await realOptions.count()),
        });
    } catch (e) {
      await page.screenshot({
        path: "test-results/authed-canvas-new.png",
        fullPage: true,
      });
      throw e;
    }
    await page.screenshot({
      path: "test-results/authed-canvas-new.png",
      fullPage: true,
    });
  });

  // 4. 添加文本节点出现在画布上
  test("添加文本节点出现在画布上", { tag: "@authed" }, async ({ page }) => {
    try {
      // 先确保有画布
      await ensureActiveCanvas(page);

      // 点击"添加节点"按钮触发菜单
      const addBtn = page.locator(SEL.addNodeBtn);
      await expect(addBtn).toBeVisible({ timeout: 10000 });
      await expect(addBtn).toBeEnabled({ timeout: 10000 });
      await addBtn.click();

      // 等待菜单弹出
      await waitOrFail(
        page,
        SEL.addNodePopover,
        5000,
        "添加节点菜单",
        "test-results/authed-canvas-add-node.png",
      );

      // 点击"文本"菜单项(label 为"文本",对齐 ADD_NODE_OPTIONS[0])
      const textItem = page.locator(SEL.addNodeItemText).first();
      await expect(textItem).toBeVisible({ timeout: 5000 });
      await textItem.click();

      // 等待 .react-flow__node 出现(10s 超时)
      try {
        await page.waitForSelector(SEL.reactFlowNode, { timeout: 10000 });
      } catch {
        await page.screenshot({
          path: "test-results/authed-canvas-add-node.png",
          fullPage: true,
        });
        throw new Error("添加文本节点后未出现 .react-flow__node");
      }

      // 校验节点数量 >= 1
      const nodeCount = await page.locator(SEL.reactFlowNode).count();
      expect(nodeCount, "画布上至少有 1 个节点").toBeGreaterThanOrEqual(1);
      test
        .info()
        .annotations.push({
          type: "nodeCount",
          description: String(nodeCount),
        });
    } catch (e) {
      await page.screenshot({
        path: "test-results/authed-canvas-add-node.png",
        fullPage: true,
      });
      throw e;
    }
    await page.screenshot({
      path: "test-results/authed-canvas-add-node.png",
      fullPage: true,
    });
  });

  // 5. 拖动节点不报错
  test("拖动节点不报错", { tag: "@authed" }, async ({ page }) => {
    // 收集页面错误和 console.error(在拖动前注册,捕获拖动过程中的任何异常)
    const errors: string[] = [];
    page.on("pageerror", (err) => {
      errors.push(`[pageerror] ${err.message}`);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(`[console.error] ${msg.text()}`);
      }
    });

    try {
      // 先添加一个文本节点
      await ensureActiveCanvas(page);

      const addBtn = page.locator(SEL.addNodeBtn);
      await expect(addBtn).toBeEnabled({ timeout: 10000 });
      await addBtn.click();
      await waitOrFail(
        page,
        SEL.addNodePopover,
        5000,
        "添加节点菜单",
        "test-results/authed-canvas-drag.png",
      );
      const textItem = page.locator(SEL.addNodeItemText).first();
      await textItem.click();

      // 等待节点出现
      try {
        await page.waitForSelector(SEL.reactFlowNode, { timeout: 10000 });
      } catch {
        await page.screenshot({
          path: "test-results/authed-canvas-drag.png",
          fullPage: true,
        });
        throw new Error("拖动测试前置:添加文本节点失败");
      }

      // 获取节点 boundingBox
      const node = page.locator(SEL.reactFlowNode).first();
      const box = await node.boundingBox();
      if (!box) {
        await page.screenshot({
          path: "test-results/authed-canvas-drag.png",
          fullPage: true,
        });
        throw new Error("无法获取节点 boundingBox");
      }

      // 拖动节点:从中心拖到偏移 (100, 60) 的位置
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      const endX = startX + 100;
      const endY = startY + 60;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      // 分步移动以模拟真实拖动(ReactFlow 监听 mousemove)
      await page.mouse.move(endX, endY, { steps: 10 });
      await page.mouse.up();

      // 校验拖动后无 ERROR_PATTERNS 文案出现
      // 注:位置回写在 store.ts 中静默失败(apiUpdateNode.catch(() => {})),
      // 不会触发 console.error,因此这里只关心拖动本身的错误
      const matched = errors.filter((e) =>
        ERROR_PATTERNS.some((p) => e.toLowerCase().includes(p.toLowerCase())),
      );
      if (matched.length > 0) {
        await page.screenshot({
          path: "test-results/authed-canvas-drag.png",
          fullPage: true,
        });
        throw new Error(`拖动节点时出现错误: ${matched.join("; ")}`);
      }

      test
        .info()
        .annotations.push({
          type: "errorsCollected",
          description: String(errors.length),
        });
    } catch (e) {
      await page.screenshot({
        path: "test-results/authed-canvas-drag.png",
        fullPage: true,
      });
      throw e;
    }
    await page.screenshot({
      path: "test-results/authed-canvas-drag.png",
      fullPage: true,
    });
  });

  // 6. 打开语音开关显示 VoiceBar
  test("打开语音开关显示 VoiceBar", { tag: "@authed" }, async ({ page }) => {
    try {
      // 确保有画布(语音开关在有激活画布时才 enabled)
      await ensureActiveCanvas(page);

      // 点击语音开关按钮
      const voiceBtn = page.locator(SEL.voiceToggleBtn);
      await expect(voiceBtn).toBeVisible({ timeout: 10000 });
      await expect(voiceBtn).toBeEnabled({ timeout: 10000 });
      await voiceBtn.click();

      // 等待 VoiceBar 容器可见
      try {
        await expect(page.locator(SEL.voiceBar)).toBeVisible({
          timeout: 10000,
        });
      } catch {
        await page.screenshot({
          path: "test-results/authed-canvas-voice.png",
          fullPage: true,
        });
        throw new Error("点击语音开关后 VoiceBar(.voice-bar)未显示");
      }
    } catch (e) {
      await page.screenshot({
        path: "test-results/authed-canvas-voice.png",
        fullPage: true,
      });
      throw e;
    }
    await page.screenshot({
      path: "test-results/authed-canvas-voice.png",
      fullPage: true,
    });
  });
});
