/**
 * 译制台对口型:停止必须 cancelJob,不能只停轮询。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "components/dub/DubView.tsx"),
  "utf-8",
);

test("DubView:对口型 busy 态停止走 cancelJob(job_id)", () => {
  assert.ok(src.includes("doCancelLipsync"), "缺 doCancelLipsync");
  assert.ok(src.includes("cancelJob(id)"), "停止未 cancelJob");
  assert.ok(src.includes("lipsyncStart?.job_id ?? animeStart?.job_id"), "未用 lipsync/anime job_id");
  assert.ok(src.includes("title=\"中止后端作业并停止本页跟踪\""), "停止按钮未标明会中止后端");
  assert.ok(src.includes("{lipsyncBusy && ("), "busy 态才露出停止");
});
