/**
 * QUEUE-2026-08-18 排队可见性防回归(node:test 源码断言):
 * H3 同实例作业排队(ComfyUI 原生队列)后,queued_behind 须一路透传到用户眼前——
 * 提交即 toast「排队等待,非故障」+ 结果卡 notice 常驻排队位次。
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

test("types.ts:GenerateResponse 契约含 queued_behind(编译层透传)", () => {
  const src = readSrc("lib/types.ts");
  assert.ok(src.includes("queued_behind?: number"), "缺 queued_behind 字段");
});

test("engines.ts:H3 提交走 GenerateResponse 泛型(queued_behind 自动透传)", () => {
  const src = readSrc("lib/engines.ts");
  assert.ok(src.includes("_postH3"), "H3 提交函数缺失");
  // _postH3 返回 res.json() as GenerateResponse——字段无需逐个映射即可到达调用方
  assert.ok(src.includes("Promise<GenerateResponse>"), "H3 提交未走 GenerateResponse 泛型");
});
