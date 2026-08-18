/**
 * 模型百科(WIKI-2026-08-18)前端防回归(node:test 源码断言):
 * 本地模型行 → 可点击百科详情卡;问 AI 自然语言框;admin 富化按钮;api/types 契约。
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

test("api.ts:wiki 三端点封装(列表/问答/富化)+ ModelWikiCard 契约", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes('"/api/models/wiki'), "缺 wiki 列表端点");
  assert.ok(src.includes('"/api/models/ask"'), "缺问答端点");
  assert.ok(src.includes('"/api/models/wiki/enrich"'), "缺富化端点");
  for (const f of [
    "has_detail", "trigger_words", "prompt_dialect", "usage", "civitai_url",
  ]) {
    assert.ok(src.includes(f), `ModelWikiCard 缺 ${f}`);
  }
});

test("ModelsView:文件行点击开详情卡(Modal 五段式)+ 未收录兜底", () => {
  const src = readSrc("components/models/ModelsView.tsx");
  assert.ok(src.includes("mv-model-main"), "文件名主体未改按钮");
  assert.ok(src.includes("openCard(f, g.type)"), "行点击未接 openCard");
  // 详情卡五段:是什么/怎么用/提示词写法/触发词/来源
  for (const s of ["这是什么", "怎么用", "提示词写法", "触发词", "来源"]) {
    assert.ok(src.includes(s), `详情卡缺「${s}」段`);
  }
  assert.ok(src.includes("暂未收录介绍"), "缺未收录兜底文案");
});

test("ModelsView:问 AI 输入框 + 匹配卡片 chip 回开详情", () => {
  const src = readSrc("components/models/ModelsView.tsx");
  assert.ok(src.includes("askModelWiki"), "未调问答 API");
  assert.ok(src.includes("问 AI:"), "缺问 AI 占位文案");
  assert.ok(src.includes("mv-ask-chip"), "缺匹配 chip");
});

test("ModelsView:admin 富化按钮存在且调 enrichModelWiki", () => {
  const src = readSrc("components/models/ModelsView.tsx");
  assert.ok(src.includes("enrichModelWiki"));
  assert.ok(src.includes("富化介绍"));
  assert.ok(src.includes('isAdmin && ('), "富化按钮未做 admin 门控");
});
