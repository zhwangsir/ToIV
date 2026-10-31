import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const globalsCss = readFileSync(join(webRoot, "app/globals.css"), "utf-8");

function globalTokens(): string[] {
  const root = globalsCss.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(root, "globals.css 缺 :root");
  return [...root[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((x) => x[1]);
}

test("globals.css 核心设计令牌源码契约完整", () => {
  const actual = new Set(globalTokens());
  const required = [
    "--bg-canvas", "--bg-surface-1", "--border-subtle", "--text-primary", "--text-muted",
    "--accent", "--ok", "--warn", "--err", "--space-1", "--radius-panel", "--duration-base",
  ];
  assert.deepEqual(required.filter((token) => !actual.has(token)), []);
});

test("engineStudio 区零 hex(P-2b ②):自 .apps-studio { 起到文件尾", () => {
  const src = readFileSync(join(webRoot, "app/styles/apps.css"), "utf-8");
  const idx = src.indexOf(".apps-studio {");
  assert.ok(idx >= 0, "apps.css 缺 .apps-studio { 起点(结构变了就同步本测试)");
  const zone = src.slice(idx);
  const hexes = zone.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hexes, [], `engineStudio 区出现 hex(用 var(--token)): ${hexes.join(",")}`);
});
