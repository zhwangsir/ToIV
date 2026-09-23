/**
 * 助手门户入口单测(node:test,无 DOM)——Studio Console v1(2026-08-31)口径:
 * 首页空态只剩输入框,旧「引擎胶囊/场景 chip/最近作品」已退役;
 * 本文件仅保留仍存活的 filterPortalEntries × @ 技能面板(SKILL_ENTRIES)门控测试。
 * @/lib/api 经 tests/loader.mjs 映射到 mocks/studioApi 可控替身。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// ── window/localStorage 替身:必须在导入组件模块前装好(模块顶层读 window 兜底) ──
const g = globalThis as { window?: unknown; localStorage?: unknown };
g.window ??= globalThis;
const localStore = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => localStore.delete(k),
  clear: () => localStore.clear(),
};

const { filterPortalEntries, SKILL_ENTRIES, OFFLINE_ENTRIES } = await import(
  "../components/assistant/AssistantView"
);

test("filterPortalEntries:@ 技能面板 R18/SFW 门控(drama 仅 R18)", () => {
  const sfwSkills = filterPortalEntries(SKILL_ENTRIES, false).map((e) => e.view);
  assert.ok(!sfwSkills.includes("drama"));
  assert.ok(filterPortalEntries(SKILL_ENTRIES, true).some((e) => e.view === "drama"));
  // 通用入口双模式可见
  for (const v of ["image", "video", "audio", "avatartalk", "library"]) {
    assert.ok(sfwSkills.includes(v), `@ 面板 SFW 缺 ${v}`);
  }
});

test("Studio Console v1:离线降级导航覆盖工作台层,不含系统层", () => {
  const views = OFFLINE_ENTRIES.map((e) => e.view);
  for (const v of ["image", "video", "audio", "studio", "library"]) {
    assert.ok(views.includes(v), `离线导航缺 ${v}`);
  }
  for (const v of ["admin", "observability", "settings", "home"]) {
    assert.ok(!views.includes(v), `离线导航不应含 ${v}`);
  }
});


test("P0.2 SKILL_ENTRIES:生成类带 prompt;作品库 navigate;非 goView 目录", () => {
  for (const e of SKILL_ENTRIES) {
    if (e.view === "library") {
      assert.equal(e.navigate, true, "作品库应 navigate");
      assert.ok(!e.prompt, "作品库不应带生成 prompt");
    } else {
      assert.ok(e.prompt && e.prompt.length > 4, `${e.view} 缺对话 prompt`);
      assert.ok(!e.navigate, `${e.view} 不应 navigate`);
    }
  }
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../components/assistant/PortalEmpty.tsx"), "utf-8");
  assert.ok(src.includes("onChipPrompt"), "PortalEmpty 未接 onChipPrompt");
  assert.ok(!src.includes("一期内容 = 工作台快捷入口"), "陈旧工作台快捷入口注释未清");
  assert.ok(src.includes("对话内 prompt chips"), "缺 P0 chips 注释");
});
