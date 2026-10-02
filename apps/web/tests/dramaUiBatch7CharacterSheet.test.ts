/**
 * Batch7 短剧 UI:角色设定卡入口 + 编辑器(源码断言)。
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
  assert.ok(src.includes('data-testid="studio-sheet-open-editor"'), "缺编辑器入口");
  assert.ok(src.includes("CharacterSheetEditor"), "未挂设定卡编辑器");
  assert.ok(src.includes("ancient_realistic"), "未传古风写实 style");
  assert.ok(src.includes("apply_to_video_refs: false"), "快捷生成须默认不写 reference_images");
});

test("api.ts:设定卡契约", () => {
  const api = readSrc("lib/api.ts");
  assert.ok(api.includes("generateStudioCharacterSheet"), "缺客户端方法");
  assert.ok(api.includes("listStudioCharacterSheets"), "缺列表方法");
  assert.ok(api.includes("regenerateStudioCharacterSheetPanels"), "缺单格重生");
  assert.ok(api.includes("replaceStudioCharacterSheetPanel"), "缺单格替换");
  assert.ok(
    api.includes("/studio/characters/${cid}/character-sheet"),
    "路径不对",
  );
});

test("CharacterSheetEditor:热区与失败重试", () => {
  const src = readSrc("components/studio/CharacterSheetEditor.tsx");
  assert.ok(src.includes("三视图·正"), "缺中文格名");
  assert.ok(src.includes("PANEL_LABEL") || src.includes("panelLabel"), "缺中文映射");
  assert.ok(src.includes('data-testid="studio-sheet-editor"'), "缺编辑器根");
  assert.ok(src.includes('data-testid="sheet-editor-create"'), "缺新建");
  assert.ok(src.includes('data-testid="sheet-editor-regen"'), "缺重生");
  assert.ok(src.includes('data-testid="sheet-editor-replace"'), "缺替换");
  assert.ok(src.includes('data-testid="sheet-editor-lock"'), "缺锁定");
  assert.ok(src.includes('data-testid="sheet-editor-export"'), "缺导出");
  assert.ok(src.includes('data-testid="sheet-editor-retry"'), "缺重试");
  assert.ok(src.includes("apply_to_video_refs: false"), "编辑器生成须不写 refs");
});

test("studio.css:设定卡样式", () => {
  const css = readSrc("app/styles/studio.css");
  assert.ok(css.includes(".studio-sheet-actions"), "缺设定卡样式");
  assert.ok(css.includes(".studio-sheet-editor"), "缺编辑器样式");
  assert.ok(css.includes(".studio-sheet-hotspot"), "缺热区样式");
});
