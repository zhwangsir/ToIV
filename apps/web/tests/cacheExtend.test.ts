/**
 * 本机缓存三层扩展(2026-09-01,L1+L2+L3)防回归:
 * ① swr-cache 行为:prime 回种即命中 / invalidate 强制重取 / 同键 in-flight 去重 /
 *    TTL 过期返 stale 并后台刷新(node 环境只有内存层,正好验证核心语义);
 * ② L1 接线(源码断言):engines/sessions/entities/apps/agent-runs/studio-projects
 *    全部走 swr,写路径显式失效;
 * ③ L2:large 选项落 IndexedDB(swr-cache 内建,node 无 IDB 时静默降级);
 * ④ L3:prefetch 映射覆盖高频视图,page.tsx 悬停与空闲预热已接线。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CACHE_KEYS, TTL, invalidate, prime, swr } from "../lib/swr-cache";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

let seq = 0;
/** 每用例唯一键(模块级 mem 跨用例共享,防串扰)。 */
function uniqKey(base: string): string {
  seq += 1;
  return `test:${base}:${seq}`;
}

/* ── ① swr-cache 行为(内存层,node 直连) ── */

test("swr:prime 回种后 TTL 内命中,不再打网络", async () => {
  const key = uniqKey("prime");
  prime(key, ["a"]);
  let calls = 0;
  const v = await swr(key, async () => {
    calls += 1;
    return ["b"];
  }, TTL.models);
  assert.deepEqual(v, ["a"]);
  assert.equal(calls, 0, "fresh 命中不得触发 fetcher");
});

test("swr:invalidate 后强制走网络并覆盖缓存", async () => {
  const key = uniqKey("invalidate");
  prime(key, 1);
  invalidate(key);
  const v = await swr(key, async () => 2, TTL.models);
  assert.equal(v, 2);
  // 已覆盖:再次读取不再打网络
  let calls = 0;
  await swr(key, async () => {
    calls += 1;
    return 3;
  }, TTL.models);
  assert.equal(calls, 0);
});

test("swr:同键并发共享 in-flight,fetcher 只跑一次", async () => {
  const key = uniqKey("inflight");
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return "x";
  };
  const [a, b] = await Promise.all([swr(key, fetcher, TTL.models), swr(key, fetcher, TTL.models)]);
  assert.equal(a, "x");
  assert.equal(b, "x");
  assert.equal(calls, 1, "并发应共享同一 in-flight Promise");
});

test("swr:TTL 过期返 stale 并后台刷新覆盖", async () => {
  const key = uniqKey("stale");
  prime(key, "old");
  // 人工老化:把内存条目时间戳推到过去(prime 后再写无法实现,改用 ttl=0 立即过期)
  let calls = 0;
  const v = await swr(
    key,
    async () => {
      calls += 1;
      return "new";
    },
    0, // ttl=0 → 任何缓存都 stale
  );
  assert.equal(v, "old", "stale 命中应立即返旧值");
  await new Promise((r) => setTimeout(r, 20)); // 等后台刷新落地
  assert.equal(calls, 1, "stale 须触发后台刷新");
  const again = await swr(key, async () => "never", TTL.models);
  assert.equal(again, "new", "后台刷新应已覆盖缓存");
});

/* ── ② L1 接线(源码断言) ── */

test("L1:engines 走 swr 且 /nsfw 分轨,refresh 回种当前档并作废另一档", () => {
  const src = readSrc("lib/engines.ts");
  assert.ok(src.includes("swr("), "fetchEngines 未接 swr");
  assert.ok(src.includes("CACHE_KEYS.engines"), "缺 engines 缓存键");
  assert.ok(src.includes("`${CACHE_KEYS.engines}:nsfw`"), "NSFW 上下文未分轨");
  assert.ok(src.includes("prime("), "refreshEngines 未回种缓存");
  assert.ok(src.includes("isNsfwIntent()"), "未按 R18 上下文选键");
});

test("L1:会话列表走 swr large(IDB),删除/分叉/对话完成显式失效", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(
    src.includes("swr(CACHE_KEYS.sessions") && src.includes("{ large: true }"),
    "listAgentSessions 未走 large(IDB)缓存",
  );
  const del = src.indexOf("deleteAgentSession");
  const fork = src.indexOf("forkAgentSession");
  const chatInvalidate = src.indexOf("// 一轮对话落库完成");
  assert.ok(del > 0 && fork > 0 && chatInvalidate > 0, "失效钩子缺失");
  assert.ok(
    (src.match(/invalidate\(CACHE_KEYS\.sessions\)/g) ?? []).length >= 4,
    "删除/分叉/agentChat/agentChatStream/agentChatResume 均应失效 sessions",
  );
});

test("L1:entities 走 swr;CRUD 三处显式失效", () => {
  const src = readSrc("lib/entities.ts");
  assert.ok(src.includes("swr(CACHE_KEYS.entities"), "loadEntitiesShared 未接 swr");
  assert.ok(src.includes("preloadEntities"), "缺 L3 预取出口");
  const api = readSrc("lib/api.ts");
  assert.ok(
    (api.match(/invalidate\(CACHE_KEYS\.entities\)/g) ?? []).length >= 3,
    "createEntity/updateEntity/deleteEntity 均应失效 entities",
  );
});

test("L1:apps 带过滤后缀分键;fork/run/confirmImport 失效", () => {
  const src = readSrc("lib/apps.ts");
  assert.ok(src.includes("`${CACHE_KEYS.apps}:${suffix}`"), "过滤档未分键");
  assert.ok(src.includes("invalidatePrefix(CACHE_KEYS.apps)"), "缺 invalidateApps");
  assert.ok((src.match(/invalidateApps\(\)/g) ?? []).length >= 3, "fork/run/confirm 均应失效");
});

test("L1:agent-runs / studio-projects 走 swr,写路径失效", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("CACHE_KEYS.agentRuns"), "agent-runs 未接缓存键");
  assert.ok(
    (src.match(/invalidatePrefix\(CACHE_KEYS\.agentRuns\)/g) ?? []).length >= 2,
    "create/cancel 均应失效 agent-runs",
  );
  // swr 调用允许多行写法(swr(\n  CACHE_KEYS.xxx …)
  assert.ok(/swr\(\s*CACHE_KEYS\.studioProjects/.test(src), "studio 列表未接 swr");
  assert.ok(
    (src.match(/invalidate\(CACHE_KEYS\.studioProjects\)/g) ?? []).length >= 3,
    "create/patch/delete 均应失效 studio-projects",
  );
});

/* ── ③ L2 大容量层 ── */

test("L2:swr-cache 内建 IndexedDB 层,node 无 IDB 静默降级", async () => {
  const src = readSrc("lib/swr-cache.ts");
  assert.ok(src.includes("indexedDB"), "缺 IDB 层");
  assert.ok(src.includes("opts?.large"), "swr 缺 large 选项");
  // node 无 window:large 键退化为仅内存,不抛错
  const key = uniqKey("large");
  const v = await swr(key, async () => ({ ok: 1 }), TTL.sessions, { large: true });
  assert.deepEqual(v, { ok: 1 });
});

/* ── ④ L3 预取接线 ── */

test("L3:prefetch 映射覆盖高频视图,page.tsx 悬停 + 空闲预热已接线", () => {
  const src = readSrc("lib/prefetch.ts");
  for (const view of ["home", "image", "video", "audio", "library", "market", "fusion", "resources", "studio"]) {
    assert.ok(src.includes(`${view}:`), `prefetch 缺 ${view} 预热`);
  }
  assert.ok(src.includes("requestIdleCallback"), "空闲预热缺 rIC");
  const page = readSrc("app/page.tsx");
  assert.ok(page.includes("prefetchView(key)"), "SideRail 悬停未接数据预取");
  assert.ok(page.includes("idlePrefetch("), "缺首屏空闲预热");
});
