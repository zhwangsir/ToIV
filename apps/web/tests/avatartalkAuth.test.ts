/**
 * 数字人(opentalking)前端鉴权契约:探活端点后端要求登录,前端必须带 JWT。
 * 回归背景:`otGetStatus` 曾用裸 fetch(注释声称"无需鉴权"),生产实测浏览器里
 * GET /api/opentalking/status → 401,而带 token curl → 200;UI 于是把「引擎不可达」
 * 误报成登录问题。后端事实:routes/opentalking.py 的 ot_status 带 Depends(get_current_user)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf-8");

test("otGetStatus 走带鉴权的 otFetch,不用裸 fetch", () => {
  const src = read("lib/opentalking.ts");
  const fn = src.slice(src.indexOf("export async function otGetStatus"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /await otFetch\(`\/status`\)/, "必须经 otFetch(自动带 authHeaders)");
  assert.doesNotMatch(body, /await fetch\(/, "不得用裸 fetch 打需鉴权的端点");
});

test("EventSource 无法带 header 时仍走 ?token=(既有口径,别改坏)", () => {
  const src = read("lib/opentalking.ts");
  assert.match(src, /\?token=\$\{encodeURIComponent\(token\)\}/);
});

test("后端 /opentalking/status 确实要求登录(前端注释不得反过来)", () => {
  const be = readFileSync(join(here, "..", "..", "api", "app", "routes", "opentalking.py"), "utf-8");
  const at = be.indexOf("async def ot_status");
  assert.notEqual(at, -1);
  assert.match(be.slice(Math.max(0, at - 220), at + 120), /Depends\(get_current_user\)/);
});
