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
  assert.ok(src.includes("listStudioCharacterSheets"), "CastStage 须按风格列表取缩略图");
  assert.ok(src.includes('data-testid="studio-sheet-thumbs"'), "缺按风格缩略图区");
  assert.ok(!src.includes('u.includes("char_sheet_")'), "不得再从 reference_images 找整卡");
});

test("api.ts:设定卡契约", () => {
  const api = readSrc("lib/api.ts");
  assert.ok(api.includes("generateStudioCharacterSheet"), "缺客户端方法");
  assert.ok(api.includes("listStudioCharacterSheets"), "缺列表方法");
  assert.ok(api.includes("regenerateStudioCharacterSheetPanels"), "缺单格重生");
  assert.ok(api.includes("replaceStudioCharacterSheetPanel"), "缺单格替换");
  assert.ok(api.includes("recomposeStudioCharacterSheet"), "缺资料重拼");
  assert.ok(api.includes("/character-sheet/recompose"), "重拼路径不对");
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
  assert.ok(src.includes('data-testid="sheet-editor-save"'), "缺保存资料");
  assert.ok(src.includes("recomposeStudioCharacterSheet"), "未接资料重拼 API");
  assert.ok(src.includes('data-testid="sheet-editor-retry"'), "缺重试");
  assert.ok(src.includes('data-testid="sheet-editor-role"'), "缺身份资料");
  assert.ok(src.includes('data-testid="sheet-editor-personality"'), "缺性格资料");
  assert.ok(src.includes('data-testid="sheet-editor-notes"'), "缺设计说明");
  assert.ok(src.includes('data-testid="sheet-editor-notes-hint"'), "缺设计说明行数提示");
  assert.ok(src.includes("assertDesignNotesOk"), "缺设计说明 3–5 行校验");
  assert.ok(src.includes("countDesignNoteLines"), "缺设计说明行数统计");
  assert.ok(src.includes('data-testid="sheet-editor-height"'), "缺身高");
  assert.ok(src.includes("apply_to_video_refs: false"), "编辑器生成须不写 refs");
  const applyFalseCount = (src.match(/apply_to_video_refs:\s*false/g) || []).length;
  assert.ok(applyFalseCount >= 2, "生成与单格重生均须默认 apply_to_video_refs: false");
  assert.ok(!/apply_to_video_refs:\s*true/.test(src), "编辑器不得默认 true 写 refs");
});

test("studio.css:设定卡样式", () => {
  const css = readSrc("app/styles/studio.css");
  assert.ok(css.includes(".studio-sheet-actions"), "缺设定卡样式");
  assert.ok(css.includes(".studio-sheet-editor"), "缺编辑器样式");
  assert.ok(css.includes(".studio-sheet-hotspot"), "缺热区样式");
  assert.ok(css.includes(".studio-sheet-notes-hint"), "缺设计说明行数样式");
});
