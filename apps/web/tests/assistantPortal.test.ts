/**
 * 首页门户(2026-08-16 堆友范式)纯函数单测(node:test,无 DOM):
 * ① pickRecentWorks:排除 R18/未完成/无产物,按创建时间倒序,截取前 N 件
 * ② buildEngineCapsules:按注册表 id 前缀分组,组内任一可用即绿灯,缺席组不渲染
 * ③ filterPortalEntries:R18/SFW 门控(drama 仅 R18 可达,video 仅 SFW 补位)
 * @/lib/api 经 tests/loader.mjs 映射到 mocks/studioApi 可控替身。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { EngineInfo } from "../lib/engines";
import type { JobItem } from "../lib/types";

// ── window/localStorage 替身:必须在导入组件模块前装好(模块顶层读 window 兜底) ──
const g = globalThis as { window?: unknown; localStorage?: unknown };
g.window ??= globalThis;
const localStore = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => void localStore.delete(k),
  clear: () => localStore.clear(),
};

const {
  buildEngineCapsules,
  filterPortalEntries,
  pickRecentWorks,
  SCENE_CAPSULES,
  SKILL_ENTRIES,
} = await import("../components/assistant/AssistantView");

const makeJob = (id: string, over: Partial<JobItem> = {}): JobItem => ({
  id,
  prompt_id: id,
  kind: "txt2img",
  status: "done",
  prompt: `作品 ${id}`,
  seed: 1,
  created_at: "2026-08-16T00:00:00Z",
  results: ["a.png"],
  ...over,
});

const makeEngine = (id: string, available: boolean): EngineInfo => ({
  id,
  label: id,
  kind: "video",
  available,
  nsfw: false,
  params: [],
});

test("① pickRecentWorks:R18/未完成/无产物被排除,倒序 + 截取上限", () => {
  const jobs = [
    makeJob("old", { created_at: "2026-08-10T00:00:00Z" }),
    makeJob("nsfw", { nsfw: true, created_at: "2026-08-15T00:00:00Z" }),
    makeJob("running", { status: "running", created_at: "2026-08-15T12:00:00Z" }),
    makeJob("noresult", { results: [], created_at: "2026-08-15T06:00:00Z" }),
    makeJob("new", { created_at: "2026-08-14T00:00:00Z" }),
  ];
  const out = pickRecentWorks(jobs);
  assert.deepEqual(
    out.map((j) => j.id),
    ["new", "old"],
  );
  // 截取上限:14 件完成品 → 默认 12 件
  const many = Array.from({ length: 14 }, (_, i) =>
    makeJob(`j${i}`, { created_at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
  );
  assert.equal(pickRecentWorks(many).length, 12);
  assert.equal(pickRecentWorks(many, 8).length, 8);
  assert.deepEqual(pickRecentWorks([]), []);
});

test("② buildEngineCapsules:组内任一可用即绿灯;注册表缺席的组不渲染", () => {
  const capsules = buildEngineCapsules([
    makeEngine("h3-t2v", false),
    makeEngine("h3-i2v", true),
    makeEngine("longcat-t2v", true),
  ]);
  const h3 = capsules.find((c) => c.key === "h3");
  const longcat = capsules.find((c) => c.key === "longcat");
  assert.equal(h3?.available, true); // i2v 可用 → 整组绿灯
  assert.equal(longcat?.available, true);
  assert.equal(capsules.some((c) => c.key === "wan"), false); // 缺席不渲染
  // 全组离线 → 红灯保留展示
  const down = buildEngineCapsules([makeEngine("h3-t2v", false)]);
  assert.equal(down.find((c) => c.key === "h3")?.available, false);
  assert.deepEqual(buildEngineCapsules([]), []);
});

test("③ filterPortalEntries:drama 仅 R18;video 仅 SFW 补位;通用入口双模式可见", () => {
  const r18Views = filterPortalEntries(SCENE_CAPSULES, true).map((e) => e.view);
  const sfwViews = filterPortalEntries(SCENE_CAPSULES, false).map((e) => e.view);
  assert.ok(r18Views.includes("drama"));
  assert.ok(!r18Views.includes("video"));
  assert.ok(!sfwViews.includes("drama"));
  assert.ok(sfwViews.includes("video"));
  // W4(2026-08-31 紧凑化):通用入口 = 图像/音频/数字人/译制;作品库移出(与最近作品区重复)
  for (const v of ["image", "audio", "avatartalk", "dub"]) {
    assert.ok(r18Views.includes(v) && sfwViews.includes(v), `${v} 应双模式可见`);
  }
  assert.ok(!r18Views.includes("library") && !sfwViews.includes("library"), "作品库不再占场景 chip");
  // 双模式各 5 枚,视觉对称
  assert.equal(r18Views.length, 5);
  assert.equal(sfwViews.length, 5);
  // @ 技能面板:SFW 模式不含短剧工作台入口
  const sfwSkills = filterPortalEntries(SKILL_ENTRIES, false).map((e) => e.view);
  assert.ok(!sfwSkills.includes("drama"));
  assert.ok(filterPortalEntries(SKILL_ENTRIES, true).some((e) => e.view === "drama"));
});
