/**
 * Studio 剧本拆解:超时/中止必须 cancelJob,不能只停前端轮询。
 * F12:ScriptStage/kindLabel 断言随七步工作室与作品库面退役删除;
 * lib/studioParseUx 仍被 lib/api(parseStudioScript)消费,契约断言保留。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  STUDIO_PARSE_DEADLINE_MS,
  isParseAbortError,
  studioParsePollDecision,
} from "../lib/studioParseUx";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("studioParsePollDecision:done/fail/wait/timeout", () => {
  assert.equal(studioParsePollDecision("done", 0), "done");
  assert.equal(studioParsePollDecision("error", 1000), "fail");
  assert.equal(studioParsePollDecision("canceled", 1000), "fail");
  assert.equal(studioParsePollDecision("running", 1000), "wait");
  assert.equal(studioParsePollDecision("queued", STUDIO_PARSE_DEADLINE_MS - 1), "wait");
  assert.equal(studioParsePollDecision("running", STUDIO_PARSE_DEADLINE_MS), "timeout");
});

test("isParseAbortError:AbortError / DOMException", () => {
  const abort = new Error("已中止");
  abort.name = "AbortError";
  assert.equal(isParseAbortError(abort), true);
  assert.equal(isParseAbortError(new Error("拆解失败")), false);
  assert.equal(isParseAbortError(new DOMException("已中止", "AbortError")), true);
});

test("parseStudioScript:超时与 abort 都 cancelJob", () => {
  const src = readSrc("lib/api.ts");
  const fn = src.slice(src.indexOf("export const parseStudioScript"));
  assert.ok(fn.includes("studioParsePollDecision"), "轮询未走 studioParsePollDecision");
  assert.ok(fn.includes("cancelJob(submitted.job_id)"), "超时/中止未 cancelJob");
  assert.ok(fn.includes("opts?.signal"), "未接 AbortSignal");
  assert.ok(fn.includes("作业已中止"), "超时报错未声明已中止作业");
});
