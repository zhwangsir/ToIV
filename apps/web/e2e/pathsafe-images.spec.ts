import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * pathsafe 图片加载全面 E2E 测试
 *
 * 测试端点:GET /api/images(pathsafe 在生产环境的唯一 HTTP 入口)
 * 测试维度:
 *   1. 功能验证 —— 合法路径通过校验,认证方式正确
 *   2. 边界条件 —— 空/缺参/超长/特殊字符
 *   3. 异常处理 —— 路径穿越/ADS/同形字符/保留名/空字节/绝对路径
 *   4. 性能测试 —— 恶意路径快速短路,连续请求不崩溃
 *   5. 兼容性测试 —— 多设备尺寸下页面正常渲染
 *
 * 运行: npx playwright test --config=playwright.prod.config.ts pathsafe-images.spec.ts
 */

const API_BASE = process.env.TOIV_API_BASE || "http://192.168.71.127:8090";
const WEB_BASE = process.env.TOIV_WEB_BASE || "http://192.168.71.127:3100";
// 任意 worker:路径校验在 worker 校验之前,恶意路径会先返回 400"非法路径"
// 合法路径会继续到 resolve_worker,因 worker 不在白名单返回 400"未知的 worker"
const DUMMY_WORKER = "http://127.0.0.1:8188";

/** 登录获取 token */
async function getToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/auth/login`, {
    data: { email: "admin", password: "admin123" },
    timeout: 15000,
  });
  expect(res.ok(), `登录应成功,实际 ${res.status()}`).toBeTruthy();
  const body = await res.json();
  expect(body.token, "登录响应应含 token").toBeTruthy();
  return body.token as string;
}

/** 构造 /api/images URL(带可选 token 查询参数) */
function imagesUrl(
  filename: string,
  opts: { worker?: string; subfolder?: string; token?: string } = {},
): string {
  const worker = opts.worker ?? DUMMY_WORKER;
  const params = new URLSearchParams({ filename, worker });
  if (opts.subfolder) params.set("subfolder", opts.subfolder);
  if (opts.token) params.set("token", opts.token);
  return `${API_BASE}/api/images?${params.toString()}`;
}

/** 带 Bearer token 的请求头 */
function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// ═══════════════════════════════════════════════════════════════════════
// 维度 1:功能验证
// ═══════════════════════════════════════════════════════════════════════
test.describe("功能验证", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await getToken(request);
  });

  test("合法 filename 通过路径校验(因 worker 未知返回 400)", async ({ request }) => {
    const res = await request.get(imagesUrl("image.png"), {
      headers: authHeaders(token),
      timeout: 15000,
    });
    // 路径校验通过 → worker 校验拦截 → 400"未知的 worker"
    expect(res.status(), "合法路径应通过校验,因 worker 未知返回 400").toBe(400);
    const detail = (await res.json()).detail;
    expect(detail, `应含"未知的 worker",实际: ${detail}`).toContain("未知的 worker");
  });

  test("token 查询参数认证方式(?token=xxx,<img> 标签场景)", async ({ request }) => {
    // 前端 <img src> 无法带 Authorization 头,只能走 ?token= 查询参数
    const url = imagesUrl("image.png", { token });
    const res = await request.get(url, { timeout: 15000 });
    expect(res.status(), "token 查询参数认证应通过(后续因 worker 未知返回 400)").toBe(400);
    expect((await res.json()).detail).toContain("未知的 worker");
  });

  test("合法 subfolder 通过校验", async ({ request }) => {
    const res = await request.get(imagesUrl("image.png", { subfolder: "2026/07" }), {
      headers: authHeaders(token),
      timeout: 15000,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).detail).toContain("未知的 worker");
  });

  test("合法 filename 含空格通过校验", async ({ request }) => {
    const res = await request.get(imagesUrl("video clip.mp4"), {
      headers: authHeaders(token),
      timeout: 15000,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).detail).toContain("未知的 worker");
  });

  test("合法 filename 含中文通过校验", async ({ request }) => {
    const res = await request.get(imagesUrl("图片.png"), {
      headers: authHeaders(token),
      timeout: 15000,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).detail).toContain("未知的 worker");
  });

  test("合法 filename 纯 Cyrillic 通过校验(不触发同形字符)", async ({ request }) => {
    const res = await request.get(imagesUrl("файл.png"), {
      headers: authHeaders(token),
      timeout: 15000,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).detail).toContain("未知的 worker");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 维度 2:边界条件测试
// ═══════════════════════════════════════════════════════════════════════
test.describe("边界条件测试", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await getToken(request);
  });

  test("空 filename → 400(不能为空)", async ({ request }) => {
    const res = await request.get(imagesUrl(""), {
      headers: authHeaders(token),
      timeout: 15000,
    });
    expect(res.status()).toBe(400);
    const detail = (await res.json()).detail;
    // 空 filename 会被 validate_path_component 返回空字符串,然后 images.py 检查"filename 不能为空"
    expect(detail).toMatch(/不能为空|非法路径/);
  });

  test("缺少 filename 参数 → 422(FastAPI 参数校验)", async ({ request }) => {
    const url = `${API_BASE}/api/images?worker=${encodeURIComponent(DUMMY_WORKER)}`;
    const res = await request.get(url, {
      headers: authHeaders(token),
      timeout: 15000,
    });
    expect(res.status()).toBe(422);
  });

  test("缺少 worker 参数 → 422(FastAPI 参数校验)", async ({ request }) => {
    const url = `${API_BASE}/api/images?filename=image.png`;
    const res = await request.get(url, {
      headers: authHeaders(token),
      timeout: 15000,
    });
    expect(res.status()).toBe(422);
  });

  test("超长 filename(5000 字符)→ 400 路径过长", async ({ request }) => {
    const res = await request.get(imagesUrl("a".repeat(5000)), {
      headers: authHeaders(token),
      timeout: 15000,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).detail).toContain("非法路径");
  });

  test("仅含点号的 filename → 400(路径穿越)", async ({ request }) => {
    const res = await request.get(imagesUrl("."), {
      headers: authHeaders(token),
      timeout: 15000,
    });
    // 单个 "." 会被 validate_path_component 规范化为空字符串,然后"不能为空"
    expect(res.status()).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 维度 3:异常处理 —— 路径穿越攻击全向量
// ═══════════════════════════════════════════════════════════════════════
test.describe("异常处理 - 路径穿越攻击", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await getToken(request);
  });

  // 路径穿越变体
  const traversalCases = [
    { name: "dotdot-slash", filename: "../../../etc/passwd" },
    { name: "dotdot-only", filename: ".." },
    { name: "dotdot-secret", filename: "../secret" },
    { name: "nested-dotdot", filename: "a/../../../b" },
    { name: "dotdot-trail", filename: "../../" },
    { name: "a-dotdot", filename: "a/.." },
  ];

  for (const tc of traversalCases) {
    test(`路径穿越 ${tc.name} → 400`, async ({ request }) => {
      const res = await request.get(imagesUrl(tc.filename), {
        headers: authHeaders(token),
        timeout: 15000,
      });
      expect(res.status(), `filename=${JSON.stringify(tc.filename)} 应被拦截`).toBe(400);
      expect((await res.json()).detail).toContain("非法路径");
    });
  }

  // ADS 流语法 + 冒号
  const adsCases = [
    { name: "png-stream", filename: "image.png:stream" },
    { name: "file-ads", filename: "file:stream" },
    { name: "drive-c-file", filename: "C:file" },
    { name: "drive-c-windows", filename: "C:\\Windows" },
    { name: "colon-ab", filename: "a:b" },
  ];

  for (const tc of adsCases) {
    test(`ADS/冒号 ${tc.name} → 400`, async ({ request }) => {
      const res = await request.get(imagesUrl(tc.filename), {
        headers: authHeaders(token),
        timeout: 15000,
      });
      expect(res.status(), `filename=${JSON.stringify(tc.filename)} 应被拦截`).toBe(400);
      expect((await res.json()).detail).toContain("非法路径");
    });
  }

  // Unicode 同形字符
  const homoglyphCases = [
    { name: "cyrillic-a-fake", filename: "fаke.png" },     // Cyrillic а U+0430
    { name: "cyrillic-a-image", filename: "imаge.png" },
    { name: "greek-alpha", filename: "fileα.txt" },         // Greek α U+03B1
    { name: "cyrillic-a-admin", filename: "аdmin.png" },
  ];

  for (const tc of homoglyphCases) {
    test(`同形字符 ${tc.name} → 400`, async ({ request }) => {
      const res = await request.get(imagesUrl(tc.filename), {
        headers: authHeaders(token),
        timeout: 15000,
      });
      expect(res.status(), `filename=${JSON.stringify(tc.filename)} 应被拦截`).toBe(400);
      expect((await res.json()).detail).toContain("非法路径");
    });
  }

  // Windows 保留名 + 其他攻击向量
  const otherCases = [
    { name: "CON", filename: "CON", keyword: "非法路径" },
    { name: "NUL.log", filename: "NUL.log", keyword: "非法路径" },
    { name: "AUX", filename: "AUX", keyword: "非法路径" },
    { name: "COM1.png", filename: "COM1.png", keyword: "非法路径" },
    { name: "null-byte", filename: "image.png\x00.jpg", keyword: "非法路径" },
    { name: "ctrl-0x01", filename: "file\x01.png", keyword: "非法路径" },
    { name: "backslash", filename: "a\\b\\c", keyword: "非法路径" },
    { name: "absolute", filename: "/etc/passwd", keyword: "非法路径" },
  ];

  for (const tc of otherCases) {
    test(`${tc.name} → 400`, async ({ request }) => {
      const res = await request.get(imagesUrl(tc.filename), {
        headers: authHeaders(token),
        timeout: 15000,
      });
      expect(res.status(), `filename=${JSON.stringify(tc.filename)} 应被拦截`).toBe(400);
      expect((await res.json()).detail).toContain(tc.keyword);
    });
  }

  // subfolder 路径穿越
  test("subfolder 路径穿越 → 400", async ({ request }) => {
    const res = await request.get(
      imagesUrl("image.png", { subfolder: "../../../etc" }),
      { headers: authHeaders(token), timeout: 15000 },
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).detail).toContain("非法路径");
  });

  test("subfolder 含冒号 → 400", async ({ request }) => {
    const res = await request.get(
      imagesUrl("image.png", { subfolder: "a:b" }),
      { headers: authHeaders(token), timeout: 15000 },
    );
    expect(res.status()).toBe(400);
    expect((await res.json()).detail).toContain("非法路径");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 维度 4:认证测试(未认证 / 无效 token)
// ═══════════════════════════════════════════════════════════════════════
test.describe("认证测试", () => {
  test("无 token 访问 → 401", async ({ request }) => {
    const res = await request.get(imagesUrl("image.png"), { timeout: 15000 });
    expect(res.status()).toBe(401);
  });

  test("无 token 恶意路径 → 401(认证在路径校验之前)", async ({ request }) => {
    const res = await request.get(imagesUrl("../../../etc/passwd"), { timeout: 15000 });
    expect(res.status()).toBe(401);
  });

  test("无效 token → 401", async ({ request }) => {
    const res = await request.get(imagesUrl("image.png"), {
      headers: { Authorization: "Bearer invalid.token.here" },
      timeout: 15000,
    });
    expect(res.status()).toBe(401);
  });

  test("无效 token 查询参数 → 401", async ({ request }) => {
    const res = await request.get(imagesUrl("image.png", { token: "invalid" }), {
      timeout: 15000,
    });
    expect(res.status()).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 维度 5:性能测试
// ═══════════════════════════════════════════════════════════════════════
test.describe("性能测试", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await getToken(request);
  });

  test("恶意路径响应 < 1s(快速短路,不连 worker)", async ({ request }) => {
    const start = Date.now();
    const res = await request.get(imagesUrl("../../../etc/passwd"), {
      headers: authHeaders(token),
      timeout: 15000,
    });
    const elapsed = Date.now() - start;
    expect(res.status()).toBe(400);
    expect(elapsed, `恶意路径应在 1s 内响应,实际 ${elapsed}ms`).toBeLessThan(1000);
    console.log(`  [性能] 恶意路径响应时间: ${elapsed}ms`);
  });

  test("合法路径响应 < 2s(路径校验 + worker 校验)", async ({ request }) => {
    const start = Date.now();
    const res = await request.get(imagesUrl("image.png"), {
      headers: authHeaders(token),
      timeout: 15000,
    });
    const elapsed = Date.now() - start;
    expect(res.status()).toBe(400);
    expect(elapsed, `合法路径应在 2s 内响应,实际 ${elapsed}ms`).toBeLessThan(2000);
    console.log(`  [性能] 合法路径响应时间: ${elapsed}ms`);
  });

  test("连续 10 次恶意请求不崩溃(并发稳定性)", async ({ request }) => {
    const attacks = [
      "../../../etc/passwd",
      "file:stream",
      "fаke.png",
      "CON",
      "image.png\x00.jpg",
      "/etc/passwd",
      "a\\b\\c",
      "a".repeat(5000),
      "..",
      "a:b",
    ];
    const results: { status: number; ms: number }[] = [];
    for (const filename of attacks) {
      const start = Date.now();
      const res = await request.get(imagesUrl(filename), {
        headers: authHeaders(token),
        timeout: 15000,
      });
      results.push({ status: res.status(), ms: Date.now() - start });
    }
    const all400 = results.every((r) => r.status === 400);
    expect(all400, `所有恶意请求应返回 400,实际: ${JSON.stringify(results)}`).toBeTruthy();
    const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
    console.log(`  [性能] 10 次恶意请求平均响应: ${avgMs}ms,全部 400`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 维度 6:兼容性测试 —— 多设备尺寸下页面正常渲染
// ═══════════════════════════════════════════════════════════════════════
test.describe("兼容性测试 - 多设备尺寸", () => {
  const devices = [
    { name: "桌面 1920×1080", width: 1920, height: 1080 },
    { name: "标准 1440×900", width: 1440, height: 900 },
    { name: "平板 768×1024", width: 768, height: 1024 },
    { name: "手机 390×844", width: 390, height: 844 },
  ];

  for (const device of devices) {
    test(`${device.name} - 作品库页面正常渲染(图片加载不阻塞)`, async ({ page, request }) => {
      // 获取 token 并注入 localStorage(模拟登录态)
      const token = await getToken(request);
      await page.addInitScript((t) => {
        window.localStorage.setItem("toiv_token", t);
      }, token);

      await page.setViewportSize({ width: device.width, height: device.height });
      await page.goto(`${WEB_BASE}/?view=library`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(3000);

      // 收集 console 错误
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      // 截图
      await page.screenshot({
        path: `test-results-prod/pathsafe-${device.width}x${device.height}-library.png`,
        fullPage: false,
      });

      // 校验页面无致命错误(图片 404/400 不算致命,页面应仍可交互)
      const body = page.locator("body");
      await expect(body).toBeVisible();
      const bodyText = await body.innerText().catch(() => "");
      const fatalErrors = [
        "Application error",
        "Internal Server Error",
        "Something went wrong",
        "TypeError",
        "ReferenceError",
      ];
      const foundFatal = fatalErrors.some((e) => bodyText.includes(e));
      expect(foundFatal, `${device.name} 页面不应有致命错误`).toBe(false);

      console.log(`  [兼容] ${device.name}: 页面正常,console 错误 ${consoleErrors.length} 条`);
    });
  }

  test("桌面 1440×900 - 生成页面正常渲染", async ({ page, request }) => {
    const token = await getToken(request);
    await page.addInitScript((t) => {
      window.localStorage.setItem("toiv_token", t);
    }, token);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${WEB_BASE}/?view=image`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: `test-results-prod/pathsafe-1440x900-image.png`,
      fullPage: false,
    });

    await expect(page.locator("body")).toBeVisible();
  });
});
