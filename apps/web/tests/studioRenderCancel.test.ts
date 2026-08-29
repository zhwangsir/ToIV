/**
 * Studio 单镜/批量渲染:busy 必须可中止(abort 同步请求,后端 disconnect 时 cancel_prompt)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("renderStudioShot/All 接 AbortSignal", () => {
  const src = readSrc("lib/api.ts");
  const shot = src.slice(src.indexOf("export const renderStudioShot"));
  assert.ok(shot.includes("signal?: AbortSignal"), "renderStudioShot 未接 signal");
  const all = src.slice(src.indexOf("export const renderStudioAll"));
  assert.ok(all.includes("signal?: AbortSignal"), "renderStudioAll 未接 signal");
});

test("useStudioProject:renderShot 传 signal,暴露 cancelRenderShot", () => {
  const src = readSrc("hooks/useStudioProject.ts");
  assert.ok(src.includes("cancelRenderShot"), "缺 cancelRenderShot");
  assert.ok(src.includes("cancelRenderAll"), "缺 cancelRenderAll");
  assert.ok(src.includes("renderStudioShot(sid, { signal: ac.signal })"), "单镜未传 signal");
  assert.ok(src.includes("renderStudioAll(pid, { signal: ac.signal })"), "批量未传 signal");
  assert.ok(src.includes("isParseAbortError"), "中止未按 AbortError 静默");
});

test("ShotCard/StoryboardStage:生成中按钮是中止,不是死 loading", () => {
  const card = readSrc("components/studio/ShotCard.tsx");
  assert.ok(card.includes("onCancelRender"), "ShotCard 缺 onCancelRender");
  assert.ok(card.includes("{busyRender ? \"中止\" : \"生成\"}"), "单镜 busy 不是「中止」");
  assert.ok(card.includes("尝试中断 GPU"), "未标明会尝试中断 GPU");
  const board = readSrc("components/studio/stages/StoryboardStage.tsx");
  assert.ok(board.includes("cancelRenderAll"), "批量未接 cancelRenderAll");
  assert.ok(board.includes("中止批量"), "批量 busy 不是「中止批量」");
});
