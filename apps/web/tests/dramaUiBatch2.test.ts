/**
 * Batch2 短剧 UI:七步就绪态 + 角色三视图 + 分镜督导(源码断言)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("StudioView:七步短标签 剧本→资产→分镜→视频→配音→对口型→成片", () => {
  const src = readSrc("components/studio/StudioView.tsx");
  for (const label of ["剧本", "资产", "分镜", "视频", "配音", "对口型", "成片"]) {
    assert.ok(src.includes(`label: "${label}"`), `缺步骤标签 ${label}`);
  }
  assert.ok(src.includes("deriveStageReadiness"), "缺就绪态推导");
  assert.ok(src.includes("studioStatus"), "未轮询 studioStatus");
  assert.ok(src.includes("next_step") || src.includes("nextStep"), "未接线 next_step");
  assert.ok(src.includes("studio-next-hint"), "缺下一步提示");
  assert.ok(src.includes("is-ready") || src.includes("data-ready"), "缺就绪态 class/data");
  assert.ok(src.includes('focus={'), "视频/配音/对口型未透传 focus");
});

test("api.ts:studioStatus 含 next_step;patchStudioCharacter 接受 reference_images", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("StudioNextStep"), "缺 StudioNextStep 类型");
  assert.ok(
    /studioStatus[\s\S]*next_step/.test(src),
    "studioStatus 返回类型须含 next_step",
  );
  assert.ok(
    src.includes("reference_images?: string[]") || src.includes("reference_images: string[]"),
    "StudioCharacterInput 缺 reference_images",
  );
});

test("CastStage:三视图槽 正/侧/全身 + uploadImage + patch reference_images", () => {
  const src = readSrc("components/studio/stages/CastStage.tsx");
  assert.ok(src.includes('label: "正"'), "缺正视图槽");
  assert.ok(src.includes('label: "侧"'), "缺侧视图槽");
  assert.ok(src.includes('label: "全身"'), "缺全身槽");
  assert.ok(src.includes("studio-ref-slot"), "缺 ref slot class");
  assert.ok(src.includes("uploadImage"), "未走 uploadImage");
  assert.ok(src.includes("reference_images"), "未 patch reference_images");
  assert.ok(src.includes("studio-ref-clear") || src.includes("清除"), "缺清除槽位");
});

test("StoryboardStage:督导条 + 重跑失败", () => {
  const src = readSrc("components/studio/stages/StoryboardStage.tsx");
  assert.ok(src.includes("studio-supervise"), "缺督导条");
  assert.ok(src.includes("重跑失败"), "缺重跑失败按钮");
  assert.ok(src.includes('status === "error"') || src.includes('status==="error"'), "未筛选 error 镜");
  assert.ok(src.includes("renderShot"), "重跑未走 renderShot");
  assert.ok(src.includes("focus?"), "缺 focus prop");
});

test("studio.css:就绪点与三视图/督导样式", () => {
  const css = readSrc("app/styles/studio.css");
  assert.ok(css.includes(".studio-stage-dot"), "缺就绪点");
  assert.ok(css.includes(".studio-ref-thumb"), "缺参考图缩略图");
  assert.ok(css.includes(".studio-supervise"), "缺督导条样式");
  assert.ok(css.includes(".studio-next-hint"), "缺下一步提示样式");
});
