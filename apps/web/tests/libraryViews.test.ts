/**
 * 作品库重设计(2026-08-15 专业工具风)单测(node:test,无 DOM):
 * ① 查询管线 applyLibraryQuery:内容分级 / 类型(含前缀规则)/ prompt 搜索 / 时间排序
 * ② 类型计数 countByFilter(与内容分级口径一致,未识别 kind 只计全部)
 * ③ 网格密度 loadDensity/persistDensity(假 localStorage 持久化 + 损坏回退)
 * ④ 批量删除 deleteJobsBatch(顺序执行 / 部分失败保留 / 空输入)
 * ⑤ 工具条渲染(renderToStaticMarkup:搜索框 / chips / 排序 / 密度 / 批量管理)
 * ⑥ 空态渲染(LibraryEmptyState:暂无作品 + 去创作 CTA)
 * ⑦ 结构源码断言:新类名锚点 + 16/9 缩略图 + token 收编
 * 说明:LibraryView 经 tests/loader.mjs 把 @/lib/api 映射到 mocks/studioApi.ts,
 * 初始渲染 loading=true(useEffect 不跑),工具条与骨架可见,正好覆盖⑤。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  applyLibraryQuery,
  countByFilter,
  DEFAULT_LIBRARY_QUERY,
  deleteJobsBatch,
  kindLabel,
  kindToFilter,
  LIBRARY_DENSITY_KEY,
  loadDensity,
  persistDensity,
  type LibraryQuery,
} from "../lib/libraryQuery";
import type { JobItem } from "../lib/types";
import { LibraryEmptyState, LibraryView } from "../components/library/LibraryView";
import { ToastProvider } from "../components/ui/Toast";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── 假 window.localStorage(密度持久化用例;模块运行时读取,无需抢在 import 前) ── */
const store = new Map<string, string>();
const g = globalThis as { window?: unknown };
g.window = {
  localStorage: {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => void store.set(k, v),
    removeItem: (k: string): void => void store.delete(k),
  },
};

function makeJob(id: string, over: Partial<JobItem> = {}): JobItem {
  return {
    id,
    prompt_id: `p-${id}`,
    kind: "txt2img",
    status: "done",
    prompt: "",
    seed: 1,
    created_at: "2026-08-10T00:00:00Z",
    results: [`${id}.png`],
    ...over,
  };
}

function query(over: Partial<LibraryQuery> = {}): LibraryQuery {
  return { ...DEFAULT_LIBRARY_QUERY, ...over };
}

/* ── ① 查询管线 ── */
test("内容分级:sfw 只留非 nsfw,r18 只留 nsfw,all 不过滤", () => {
  const jobs = [makeJob("a"), makeJob("b", { nsfw: true }), makeJob("c", { nsfw: false })];
  assert.deepEqual(
    applyLibraryQuery(jobs, query({ contentFilter: "sfw" })).map((j) => j.id),
    ["a", "c"],
  );
  assert.deepEqual(
    applyLibraryQuery(jobs, query({ contentFilter: "r18" })).map((j) => j.id),
    ["b"],
  );
  assert.equal(applyLibraryQuery(jobs, query({ contentFilter: "all" })).length, 3);
});

test("类型筛选:kind 精确映射 + 前缀规则,未识别 kind 只在「全部」出现", () => {
  const jobs = [
    makeJob("img", { kind: "txt2img" }),
    makeJob("vid", { kind: "h3_t2v" }),
    makeJob("cad", { kind: "cad_front" }),
    makeJob("ref", { kind: "drama_char_reference_hero" }),
    makeJob("unknown", { kind: "some_future_kind" }),
  ];
  assert.deepEqual(
    applyLibraryQuery(jobs, query({ filter: "image" })).map((j) => j.id),
    ["img", "ref"],
  );
  assert.deepEqual(
    applyLibraryQuery(jobs, query({ filter: "video" })).map((j) => j.id),
    ["vid"],
  );
  assert.deepEqual(
    applyLibraryQuery(jobs, query({ filter: "3d" })).map((j) => j.id),
    ["cad"],
  );
  // 未识别 kind:不进任何分类桶,但「全部」保留
  assert.equal(applyLibraryQuery(jobs, query({ filter: "all" })).length, 5);
  assert.equal(kindToFilter("some_future_kind"), null);
});

test("libraryQuery:chromakey/i2l/motion_brush/wan_animate* 分桶与短名", () => {
  assert.equal(kindToFilter("chromakey"), "video");
  assert.equal(kindToFilter("i2l"), "image");
  assert.equal(kindToFilter("motion_brush"), "image");
  assert.equal(kindToFilter("wan_animate"), "video");
  assert.equal(kindToFilter("wan_animate2"), "video");
  assert.equal(kindLabel("chromakey"), "扣像");
  assert.equal(kindLabel("i2l"), "风格LoRA");
  assert.equal(kindLabel("motion_brush"), "局部动效");
  assert.equal(kindLabel("wan_animate"), "动作迁移");
  assert.equal(kindLabel("wan_animate2"), "动作迁移2");
  // 引擎 id(连字符)不是 Job.kind
  assert.equal(kindToFilter("wan-animate"), null);
  assert.equal(kindToFilter("wan-animate-2"), null);
});

test("搜索:按 prompt 过滤,大小写不敏感,首尾空白忽略,空词不过滤", () => {
  const jobs = [
    makeJob("cat", { prompt: "一只 Cat 在窗台" }),
    makeJob("dog", { prompt: "Dog portrait" }),
    makeJob("empty", { prompt: "" }),
  ];
  assert.deepEqual(
    applyLibraryQuery(jobs, query({ search: "cat" })).map((j) => j.id),
    ["cat"],
  );
  assert.deepEqual(
    applyLibraryQuery(jobs, query({ search: "  DOG " })).map((j) => j.id),
    ["dog"],
  );
  assert.equal(applyLibraryQuery(jobs, query({ search: "   " })).length, 3);
  assert.equal(applyLibraryQuery(jobs, query({ search: "不存在" })).length, 0);
});

test("排序:newest 默认倒序,oldest 正序,非法日期沉底", () => {
  const jobs = [
    makeJob("old", { created_at: "2026-08-01T00:00:00Z" }),
    makeJob("new", { created_at: "2026-08-12T00:00:00Z" }),
    makeJob("bad", { created_at: "not-a-date" }),
  ];
  assert.deepEqual(
    applyLibraryQuery(jobs, query({ sort: "newest" })).map((j) => j.id),
    ["new", "old", "bad"],
  );
  assert.deepEqual(
    applyLibraryQuery(jobs, query({ sort: "oldest" })).map((j) => j.id),
    ["bad", "old", "new"],
  );
  // 不就地修改输入
  assert.deepEqual(jobs.map((j) => j.id), ["old", "new", "bad"]);
});

test("组合查询:分级 + 类型 + 搜索 + 排序叠加", () => {
  const jobs = [
    makeJob("a", { kind: "wan_t2v", prompt: "海边日落", created_at: "2026-08-02T00:00:00Z" }),
    makeJob("b", { kind: "wan_t2v", prompt: "海边日落 nsfw 版", nsfw: true, created_at: "2026-08-03T00:00:00Z" }),
    makeJob("c", { kind: "txt2img", prompt: "海边日落", created_at: "2026-08-04T00:00:00Z" }),
  ];
  const out = applyLibraryQuery(
    jobs,
    query({ filter: "video", contentFilter: "sfw", search: "海边", sort: "newest" }),
  );
  assert.deepEqual(out.map((j) => j.id), ["a"]);
});

/* ── ② 类型计数 ── */
test("countByFilter:按内容分级后的集合计数,未识别 kind 只计全部", () => {
  const jobs = [
    makeJob("a", { kind: "txt2img" }),
    makeJob("b", { kind: "wan_t2v" }),
    makeJob("c", { kind: "unknown_x" }),
    makeJob("d", { kind: "txt2img", nsfw: true }),
  ];
  const all = countByFilter(jobs, "all");
  assert.deepEqual(all, { all: 4, image: 2, video: 1, audio: 0, "3d": 0 });
  const sfw = countByFilter(jobs, "sfw");
  assert.deepEqual(sfw, { all: 3, image: 1, video: 1, audio: 0, "3d": 0 });
  const r18 = countByFilter(jobs, "r18");
  assert.deepEqual(r18, { all: 1, image: 1, video: 0, audio: 0, "3d": 0 });
});

/* ── ③ 密度持久化 ── */
test("密度切换:默认舒适,持久化后读取一致,损坏值回退舒适", () => {
  store.clear();
  assert.equal(loadDensity(), "comfortable");
  persistDensity("compact");
  assert.equal(store.get(LIBRARY_DENSITY_KEY), "compact");
  assert.equal(loadDensity(), "compact");
  persistDensity("comfortable");
  assert.equal(loadDensity(), "comfortable");
  // 损坏/未知值回退舒适
  store.set(LIBRARY_DENSITY_KEY, "huge");
  assert.equal(loadDensity(), "comfortable");
  store.clear();
});

/* ── ④ 批量删除 ── */
test("deleteJobsBatch:顺序执行,单条失败不中断,done/failed 分组返回", async () => {
  const calls: string[] = [];
  const okIds = new Set(["a", "c"]);
  const result = await deleteJobsBatch(["a", "b", "c"], async (id) => {
    calls.push(id);
    if (!okIds.has(id)) throw new Error("boom");
    // 模拟软删除端点:成功项返回撤销凭据
    return { undo_token: `tok-${id}` };
  });
  assert.deepEqual(calls, ["a", "b", "c"], "必须按传入顺序逐条调用");
  assert.deepEqual(result.done, ["a", "c"]);
  assert.deepEqual(result.failed, ["b"]);
  assert.deepEqual(result.undoTokens, ["tok-a", "tok-c"], "成功删除项的撤销凭据须收集");
});

test("deleteJobsBatch:空输入不调用删除函数,全失败时 done/undoTokens 为空", async () => {
  let n = 0;
  const empty = await deleteJobsBatch([], async () => {
    n++;
  });
  assert.equal(n, 0);
  assert.deepEqual(empty, { done: [], failed: [], undoTokens: [] });
  const allFail = await deleteJobsBatch(["x", "y"], async () => {
    throw new Error("nope");
  });
  assert.deepEqual(allFail.done, []);
  assert.deepEqual(allFail.failed, ["x", "y"]);
  assert.deepEqual(allFail.undoTokens, []);
});

/* ── ⑤ 工具条渲染(SSR 初始帧:loading 骨架 + 工具条) ── */
test("LibraryView 工具条:搜索 / 类型 chips / 排序 / 密度切换 / 批量管理均渲染", () => {
  const html = renderToStaticMarkup(
    h(
      ToastProvider,
      null,
      // LibraryView props 整体可选(createElement 重载对可选 props 推断较弱,显式标注)
      h(LibraryView as React.FC<{ onNavigate?: (target: string) => void }>, {
        onNavigate: () => {},
      }),
    ),
  );
  assert.match(html, /lib-toolbar/, "缺少 sticky 工具条");
  assert.match(html, /lib-search-input/, "缺少搜索框");
  assert.match(html, /aria-label="搜索提示词"/, "搜索框缺 aria-label");
  assert.match(html, /lib-chip/, "缺少类型筛选 chips");
  assert.match(html, /lib-chip-count/, "chips 缺少数量徽标");
  assert.match(html, /aria-label="排序方式"/, "缺少排序段控");
  assert.match(html, /aria-label="密度切换"/, "缺少密度切换段控");
  assert.match(html, /aria-label="舒适密度"/, "缺少舒适密度按钮");
  assert.match(html, /aria-label="紧凑密度"/, "缺少紧凑密度按钮");
  assert.match(html, /lib-batch-toggle/, "缺少批量管理按钮");
  // 初始 loading:骨架网格渲染
  assert.match(html, /lib-thumb-skel/, "缺少加载骨架");
});

/* ── ⑥ 空态渲染 ── */
test("LibraryEmptyState:细线框图标 + 暂无作品 + 去创作 CTA", () => {
  const html = renderToStaticMarkup(h(LibraryEmptyState, { onCreate: () => {} }));
  assert.match(html, /lib-empty-icon/, "空态图标类名缺失");
  assert.match(html, /lib-empty-display/, "空态标题类名缺失");
  assert.match(html, /暂无作品/, "空态标题文案缺失");
  assert.match(html, /去创作/, "缺少去创作 CTA");
});

/* ── ⑧ 服务端分页(2026-08-16 无限滚动,老作品不再被 50 条截断) ── */
test("api.ts:fetchJobsPage 带 limit/offset;首页走 JOBS_PAGE_LIMIT", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("export async function fetchJobsPage"), "fetchJobsPage 未导出");
  assert.ok(src.includes("offset=${offset}"), "分页未带 offset");
  assert.ok(src.includes("export const JOBS_PAGE_LIMIT = 200"), "首页档应为 200(后端上限)");
  // fetchJobsRaw 必须走分页函数(首页),不允许裸调 /api/jobs(默认 50 截断)
  const raw = src.slice(src.indexOf("async function fetchJobsRaw"));
  assert.ok(raw.includes("fetchJobsPage(0, JOBS_PAGE_LIMIT)"), "首页未走 fetchJobsPage");
});

test("LibraryView 服务端分页:触底哨兵 + id 去重 + 两层 advance(源码断言)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("fetchJobsPage"), "未引入服务端分页拉取");
  assert.ok(src.includes("serverHasMore"), "缺服务端分页态");
  assert.ok(src.includes("IntersectionObserver"), "缺触底哨兵");
  assert.ok(src.includes("lib-load-sentinel"), "哨兵类名缺失");
  assert.ok(src.includes("!seen.has(j.id)"), "页间未按 id 去重(新作业插入会页间重叠)");
  // advance 须先扩客户端渲染、再拉服务端(两层分页对用户透明)
  const i = src.indexOf("const advance = useCallback");
  const block = src.slice(i, src.indexOf("}, [", i));
  assert.ok(block.includes("hasMore") && block.includes("loadMoreServer"), "advance 未覆盖两层分页");
  const css = readSrc("app/styles/library.css");
  assert.ok(css.includes(".lib-load-sentinel"), "哨兵样式缺失");
});

/* ── ⑦ 结构源码断言 ── */
test("LibraryView 新结构类名锚点 + library.css 16/9 与 token 收编", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  for (const cls of [
    "lib-toolbar",
    "lib-search",
    "lib-chip",
    "lib-seg",
    "lib-density",
    "lib-batch-toggle",
    "lib-batchbar",
    "lib-check",
    "lib-status-dot",
    "lib-card-title",
    "lib-meta",
    "lib-kind",
    "lib-lb-side",
    "lib-lb-meta",
    "lib-lb-prompt-block",
  ]) {
    assert.ok(src.includes(cls), `LibraryView.tsx 缺少 ${cls}`);
  }
  // 交互逻辑锚点:密度持久化 / 批量删除流 / 清空查询
  assert.ok(src.includes("persistDensity"), "密度未持久化");
  assert.ok(src.includes("deleteJobsBatch"), "批量删除未走批量 helper");
  assert.ok(src.includes("applyLibraryQuery"), "查询未走统一管线");

  const css = readSrc("app/styles/library.css");
  assert.ok(css.includes("aspect-ratio: 16 / 9"), "缩略图未固定 16/9");
  assert.ok(css.includes("var(--text-display-md)"), "空态 display token 未接入");
  assert.ok(css.includes("var(--font-semibold)"), "semibold 字重 token 未接入");
  assert.ok(css.includes("var(--text-on-accent)"), "scrim 文字色 token 未接入");
  assert.ok(css.includes("position: sticky"), "工具条未 sticky");
  assert.ok(!css.includes("font-size: 32px"), "空态 32px 硬编码未收编");
  assert.ok(!css.includes("font-weight: 650"), "650 字重硬编码未收编");
  assert.ok(!css.includes("color: #FFFFFF"), "scrim #FFFFFF 硬编码未收编");
});
