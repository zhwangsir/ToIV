/**
 * Batch5:样片种子 + 步骤整组重跑 + 我的剧集进度点(源码/契约断言)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("api.ts:样片种子与整组重跑端点契约", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("/studio/sample-projects/rain-night"), "缺样片种子路径");
  assert.ok(src.includes("seedRainNightSample"), "缺 seedRainNightSample");
  assert.ok(src.includes("/steps/${step}/rerun") || src.includes("/steps/"), "缺 step rerun 路径");
  assert.ok(src.includes("rerunStudioStep"), "缺 rerunStudioStep");
  assert.ok(src.includes("StudioStepRerunResult"), "缺 StudioStepRerunResult");
});

test("useStudioProject:rerunStep 接 API 且失败透出", () => {
  const hook = readSrc("hooks/useStudioProject.ts");
  assert.ok(hook.includes("rerunStep"), "缺 rerunStep");
  assert.ok(hook.includes("rerunStudioStep"), "未接 rerunStudioStep");
  assert.ok(hook.includes("整组重跑"), "缺整组重跑 label");
  assert.ok(hook.includes("setError"), "失败未透出 setError");
});

test("StoryboardStage:studio-step-rerun 按钮覆盖视频/配音/对口型/分镜", () => {
  const board = readSrc("components/studio/stages/StoryboardStage.tsx");
  assert.ok(board.includes('data-testid="studio-step-rerun"'), "缺 studio-step-rerun");
  assert.ok(board.includes("整组重跑"), "缺按钮文案");
  assert.ok(board.includes("rerunStepGroup"), "缺 rerunStepGroup");
  assert.ok(board.includes('rerunStep(step)'), "未调 project.rerunStep");
});

test("StudioView:我的剧集 + 样片种子 + 进度点", () => {
  const src = readSrc("components/studio/StudioView.tsx");
  assert.ok(src.includes("我的剧集"), "缺我的剧集");
  assert.ok(src.includes('data-testid="studio-my-dramas"') || src.includes('aria-label="我的剧集"'), "缺剧集列表锚点");
  assert.ok(src.includes("seedRainNightSample"), "未接样片种子 API");
  assert.ok(src.includes('data-testid="studio-seed-rain-night"'), "缺样片按钮");
  assert.ok(src.includes("studio-home-progress") || src.includes("studio-home-dot"), "缺进度点");
});

test("studio.css:我的剧集进度点样式", () => {
  const css = readSrc("app/styles/studio.css");
  assert.ok(css.includes(".studio-home-dot"), "缺 .studio-home-dot");
  assert.ok(css.includes(".studio-home-progress"), "缺 .studio-home-progress");
});
