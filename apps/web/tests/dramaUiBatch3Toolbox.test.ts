/**
 * Batch3 工具箱信息架构收口(源码断言):MarketView 枢纽 + 导航主入口。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("MarketView 工具箱:六段 chips + aria-label + hub 标记", () => {
  const src = readSrc("components/market/MarketView.tsx");
  assert.ok(src.includes('aria-label="工具箱"'), "aria-label 应为工具箱");
  assert.ok(!src.includes('aria-label="市场"'), "用户可见 aria 不应再写市场");
  assert.ok(src.includes('data-testid="toolbox-hub"'), "缺 toolbox-hub");
  assert.ok(src.includes("data-testid={`toolbox-tab-"), "缺 toolbox-tab-* testid 模板");
  for (const key of ["apps", "skills", "image", "video", "audio", "resources"]) {
    assert.ok(src.includes(`key: "${key}"`), `TOOLBOX_TABS 缺 ${key}`);
  }
  for (const label of ["应用", "技能", "图片", "视频", "音频", "资源"]) {
    assert.ok(src.includes(`label: "${label}"`), `缺短标签 ${label}`);
  }
  assert.ok(src.includes("mtab"), "深链应使用 mtab(避免与资源 tab 冲突)");
  assert.ok(src.includes("EngineStudioView"), "图片/视频应复用引擎工作台");
  assert.ok(src.includes("AudioView"), "音频应复用 AudioView");
  assert.ok(src.includes("ResourcesView"), "资源应复用 ResourcesView");
  assert.ok(src.includes('runnerBackLabel="返回"'), "应用运行返回应少字");
});

test("page.tsx:做短剧主入口 + 工具箱 rail + MarketView 接线", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(src.includes("studio:    { label: NAV_LABELS.studio }"), "VIEW_META 缺做短剧");
  assert.ok(src.includes("market:     { label: NAV_LABELS.market }"), "VIEW_META 缺工具箱");
  const rail = src.slice(src.indexOf("const RAIL_ITEMS"), src.indexOf("const BOTTOM_NAV_ITEMS"));
  assert.ok(rail.includes('{ key: "studio", label: NAV_LABELS.studio'), "左栏缺做短剧");
  assert.ok(rail.includes('{ key: "market", label: NAV_LABELS.market'), "左栏缺工具箱");
  assert.ok(src.includes("<MarketView onNavigate={handleFusionNavigate}"), "MarketView 未接 onNavigate");
  assert.ok(src.includes('{view === "image" && <EngineStudioView kind="image" />}'), "独立图片视图应保留");
  assert.ok(src.includes('{view === "video" && <EngineStudioView kind="video" />}'), "独立视频视图应保留");
});

test("少字:运行页默认返回不再写「返回市场」", () => {
  const runner = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(runner.includes('backLabel = "返回"'), "AppRunner 默认应是「返回」");
  assert.ok(!runner.includes('backLabel = "返回市场"'), "不应再默认「返回市场」");
});
