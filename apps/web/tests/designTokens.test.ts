/**
 * DESIGN.md 设计令牌契约机器校验(2026-10-14 T0-5 立项,格式对齐 google-labs-code/design.md)。
 *
 * 契约:
 * ① DESIGN.md frontmatter 声明的每个 token 必须存在于 globals.css(不许臆造);
 * ② 核心组双向覆盖:globals.css :root 里 abs/bg/border/text/accent/ok/warn/err/run
 *    组的 token 若未在 DESIGN.md 声明 = 漂移(改了真源没重跑 scripts/gen_design_md.py);
 * ③ engineStudio 区(P-2b):自 `.apps-studio {` 起到文件尾禁 hex;
 * ④ globals.css 是唯一允许定义 token 的真源文件(新 token 先进 globals.css)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const repoRoot = join(webRoot, "..", "..");

const globalsCss = readFileSync(join(webRoot, "app/globals.css"), "utf-8");
const designMd = readFileSync(join(repoRoot, "docs/DESIGN.md"), "utf-8");

function declaredTokens(src: string): string[] {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "DESIGN.md 缺 frontmatter");
  return [...m[1].matchAll(/^\s+(--[a-z0-9-]+):/gm)].map((x) => x[1]);
}

function globalTokens(): string[] {
  const root = globalsCss.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(root, "globals.css 缺 :root");
  return [...root[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((x) => x[1]);
}

test("DESIGN.md frontmatter 每个声明 token 都存在于 globals.css 真源", () => {
  const declared = new Set(declaredTokens(designMd));
  assert.ok(declared.size > 50, `声明 token 数异常: ${declared.size}`);
  const actual = new Set(globalTokens());
  const ghost = [...declared].filter((t) => !actual.has(t));
  assert.deepEqual(ghost, [], `DESIGN.md 声明了 globals.css 不存在的 token: ${ghost.join(",")}`);
});

test("核心组双向覆盖:globals.css 核心组 token 未声明 = 漂移", () => {
  const CORE = ["abs", "bg", "border", "text", "accent", "ok", "warn", "err", "run"];
  const declared = new Set(declaredTokens(designMd));
  const missing = globalTokens().filter((t) => {
    const g = t.slice(2).split("-")[0];
    return CORE.includes(g) && !declared.has(t);
  });
  assert.deepEqual(missing, [], `核心组漂移(重跑 scripts/gen_design_md.py): ${missing.join(",")}`);
});

test("engineStudio 区零 hex(P-2b ②):自 .apps-studio { 起到文件尾", () => {
  // 真机定位(2026-10-14):apps-studio 样式区在 app/styles/apps.css
  const target = "app/styles/apps.css";
  const src = readFileSync(join(webRoot, target), "utf-8");
  const idx = src.indexOf(".apps-studio {");
  assert.ok(idx >= 0, "apps.css 缺 .apps-studio { 起点(结构变了就同步本测试)");
  const zone = src.slice(idx);
  const hexes = zone.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hexes, [], `engineStudio 区出现 hex(用 var(--token)): ${hexes.join(",")}`);
});

test("DESIGN.md 契约正文存在使用铁律与生成器说明", () => {
  assert.match(designMd, /使用铁律/, "缺使用铁律节");
  assert.match(designMd, /gen_design_md\.py/, "缺生成器说明");
  assert.match(designMd, /Apache-2\.0/, "缺 design.md 规范格式归属");
});
