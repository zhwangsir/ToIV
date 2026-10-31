/**
 * 前端 UX 精修批 D(2026-08-30)存留单测(node:test,源码断言):
 * F12 薄壳退役(2026-10-15)后仅保留两例——
 * ① page.tsx:animatic 深链经 EXTERNAL_VIEW_REDIRECTS 跳 canvas 短剧工作台(F3);
 * ② LandingPage:邮箱框 type=email + 网络故障/凭据错误文案分流(保留面:未登录落地)。
 * 其余绑定 StudioView/CanvasView/LibraryView/BacklotView/ModelsView/SettingsView
 * 的断言已随对应视图在 F12 物理删除而报废。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① page.tsx ── */
test("page.tsx:animatic 视图退役(F3:深链跳 canvas 短剧工作台)", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(
    src.includes('animatic: "/studio/toiv/drama"'),
    "animatic 应经 EXTERNAL_VIEW_REDIRECTS 跳 canvas 短剧列表(「从图片创建」承接)",
  );
});

/* ── ② LandingPage(F12 保留面:未登录落地/登录) ── */
test("LandingPage:邮箱框 type=email + 网络/凭据错误文案分流", () => {
  const src = readSrc("components/landing/LandingPage.tsx");
  assert.ok(src.includes('type="email"'), "邮箱框应为 type=email");
  assert.ok(src.includes("网络连接异常或请求超时,请检查网络后重试"), "缺网络故障文案");
  assert.ok(src.includes("账号或密码错误,请重试"), "缺凭据错误文案");
  assert.ok(src.includes("isNetwork"), "缺网络/凭据分流判定");
});
