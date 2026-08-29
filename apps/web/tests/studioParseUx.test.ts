/**
 * Studio 剧本拆解:超时/中止必须 cancelJob,不能只停前端轮询。
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
import { kindLabel } from "../lib/libraryQuery";

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

test("ScriptStage:拆解中主按钮/确认框可中止", () => {
  const src = readSrc("components/studio/stages/ScriptStage.tsx");
  assert.ok(src.includes("abortParse"), "缺 abortParse");
  assert.ok(src.includes("中止拆解"), "主按钮拆解中不是「中止拆解」");
  assert.ok(src.includes("{ signal: ac.signal }"), "parseStudioScript 未传 signal");
  assert.ok(src.includes("isParseAbortError"), "中止未按 AbortError 静默");
  assert.ok(!src.includes("disabled={parsing || !premise.trim()}"), "拆解中主按钮仍 disabled=死控件");
  assert.ok(!src.includes("disabled={parsing}"), "确认框取消在 parsing 时仍 disabled");
});

test("kindLabel:studio_script_parse → 剧本拆解", () => {
  assert.equal(kindLabel("studio_script_parse"), "剧本拆解");
});
