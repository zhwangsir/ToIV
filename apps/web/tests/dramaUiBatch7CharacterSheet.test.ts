/**
 * Batch7 短剧 UI:角色设定卡入口(源码断言)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("CastStage:设定卡古风/二次元入口", () => {
  const src = readSrc("components/studio/stages/CastStage.tsx");
  assert.ok(src.includes("generateStudioCharacterSheet"), "未接设定卡 API");
  assert.ok(src.includes('data-testid="studio-sheet-actions"'), "缺设定卡操作区");
  assert.ok(src.includes('data-testid="studio-sheet-ancient"'), "缺古风入口");
  assert.ok(src.includes('data-testid="studio-sheet-anime"'), "缺二次元入口");
  assert.ok(src.includes("ancient_realistic"), "未传古风写实 style");
});

test("api.ts:generateStudioCharacterSheet 契约", () => {
  const api = readSrc("lib/api.ts");
  assert.ok(api.includes("generateStudioCharacterSheet"), "缺客户端方法");
  assert.ok(
    api.includes("/studio/characters/${cid}/character-sheet"),
    "路径不对",
  );
});

test("studio.css:设定卡样式", () => {
  const css = readSrc("app/styles/studio.css");
  assert.ok(css.includes(".studio-sheet-actions"), "缺设定卡样式");
  assert.ok(css.includes(".studio-sheet-thumb"), "缺设定卡缩略图样式");
});
