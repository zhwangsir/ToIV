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
  canRerun,
  countByFilter,
  DEFAULT_LIBRARY_QUERY,
  deleteJobsBatch,
  flattenLightboxEntries,
  kindLabel,
  kindToFilter,
  kindsQueryForFilter,
  LIBRARY_DENSITY_KEY,
  loadDensity,
  makeSeqGate,
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
  assert.equal(kindToFilter("h3_extend_i2v"), "video");
  assert.equal(kindLabel("chromakey"), "抠像");
  assert.equal(kindLabel("i2l"), "风格LoRA");
  assert.equal(kindLabel("motion_brush"), "局部动效");
  assert.equal(kindLabel("wan_animate"), "动作迁移");
  assert.equal(kindLabel("wan_animate2"), "动作迁移2");
  assert.equal(kindLabel("h3_extend_i2v"), "长视频续写");
  // 引擎 id(连字符)不是 Job.kind
  assert.equal(kindToFilter("wan-animate"), null);
  assert.equal(kindToFilter("wan-animate-2"), null);
});

test("kindsQueryForFilter:全部空串,类型桶逗号多值含 h3_extend_i2v", () => {
  assert.equal(kindsQueryForFilter("all"), "");
  const video = kindsQueryForFilter("video");
  assert.ok(video.includes("h3_t2v") && video.includes("h3_extend_i2v"), "视频桶须含 H3 文生/续写 kind");
  assert.ok(kindsQueryForFilter("image").includes("txt2img"));
});

test("kindsQueryForFilter:3D/图像桶带 cad_/drama_char_reference_ 前缀给服务端", () => {
  const d3 = kindsQueryForFilter("3d").split(",");
  const image = kindsQueryForFilter("image").split(",");
  assert.ok(d3.includes("cad_"), "3D 桶须带 cad_ 前缀 token");
  assert.ok(d3.includes("hunyuan3d"), "3D 桶仍含精确 kind");
  assert.ok(image.includes("drama_char_reference_"), "图像桶须带 drama_char_reference_ 前缀 token");
  assert.equal(kindsQueryForFilter("video").includes("cad_"), false);
  assert.equal(kindsQueryForFilter("all"), "");
});

test("makeSeqGate:next 递增,旧序号在 next 后失效;peek 不递增", () => {
  const g = makeSeqGate();
  assert.equal(g.peek(), 0);
  const a = g.next();
  const b = g.next();
  assert.equal(g.isLive(a), false);
  assert.equal(g.isLive(b), true);
  assert.equal(g.peek(), b);
  assert.equal(g.isLive(g.peek()), true);
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

/* ── ⑥ 空态渲染(2026-09-02 W3:单行化) ── */
test("LibraryEmptyState:单行 muted 提示 + 行内去创作 CTA", () => {
  const html = renderToStaticMarkup(h(LibraryEmptyState, { onCreate: () => {} }));
  assert.match(html, /lib-empty-hint/, "单行提示类名缺失");
  assert.doesNotMatch(html, /lib-empty-icon|lib-empty-display/, "大图标/大标题应退役");
  assert.match(html, /暂无作品/, "空态文案缺失");
  assert.match(html, /去创作/, "缺少去创作 CTA");
});

/* ── ⑧ 服务端分页(2026-08-16 无限滚动,老作品不再被 50 条截断) ── */
test("api.ts:fetchJobsPage 带 limit/offset;首页走 JOBS_PAGE_LIMIT", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("export async function fetchJobsPage"), "fetchJobsPage 未导出");
  assert.ok(src.includes("offset=${offset}"), "分页未带 offset");
  assert.ok(src.includes("&kind="), "fetchJobsPage 须可带 kind 过滤");
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
  assert.ok(src.includes("deleteJobsSmart"), "批量删除未走批量 helper");
  assert.ok(src.includes("applyLibraryQuery"), "查询未走统一管线");
  assert.ok(src.includes("kindsQueryForFilter"), "类型 chip 未走服务端 kind 过滤");
  assert.ok(src.includes("makeSeqGate"), "chip 连点未接序号门闩");
  assert.ok(src.includes("jobsFetchGate.isLive"), "过期 fetchJobsPage 响应未丢弃");
  assert.ok(src.includes('className="lib-nsfw-badge"'), "缺 18+ chip");
  assert.ok(src.includes("else if (isBlurred) toggleReveal"), "模糊卡须先揭示再进灯箱");
  assert.ok(!src.includes("else if (isNsfw) toggleReveal"), "已揭示 R18 卡不得再拦截打开");

  const css = readSrc("app/styles/library.css");
  assert.ok(css.includes("aspect-ratio: 16 / 9"), "缩略图未固定 16/9");
  // 2026-09-02 W3:空态面板/页头退役,计数入工具条;工具条去玻璃改实底+hairline
  assert.ok(!css.includes("var(--text-display-md)"), "空态不应再用 display 档大标题");
  assert.ok(css.includes("var(--text-on-accent)"), "scrim 文字色 token 未接入");
  assert.ok(css.includes("position: sticky"), "工具条未 sticky");
  // 工具条块级检查(灯箱/NSFW 遮罩等处 backdrop-filter 仍合法,不能全文断言)
  const toolbar = css.slice(css.indexOf(".lib-toolbar {"), css.indexOf(".lib-toolbar {") + 400);
  assert.ok(!toolbar.includes("backdrop-filter"), "工具条玻璃材质应已退役");
  assert.ok(toolbar.includes("background: var(--bg-canvas)"), "工具条应为实底");
  assert.ok(!css.includes("lib-card-in"), "卡片错落入场动画应已退役");
  assert.ok(!css.includes("font-size: 32px"), "空态 32px 硬编码未收编");
  assert.ok(!css.includes("font-weight: 650"), "650 字重硬编码未收编");
  assert.ok(!css.includes("color: #FFFFFF"), "scrim #FFFFFF 硬编码未收编");
});

/* ── P2 作品库破图占位(2026-09-07):类型图标 + 渐变底,不露破图 ── */
test("P2 破图占位:ThumbPlaceholder data-filter + JobThumbMedia 兜底 + CSS 渐变令牌", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("function thumbFilterOf"), "缺 thumbFilterOf");
  assert.ok(src.includes("function JobThumbMedia"), "缺 JobThumbMedia 统一入口");
  assert.ok(src.includes("function VideoThumb"), "缺 VideoThumb 失败降级");
  assert.ok(src.includes('data-filter={filterKey}'), "占位卡须挂 data-filter");
  assert.ok(src.includes('lib-thumb-placeholder-icon'), "缺占位大图标包裹");
  assert.ok(src.includes('filterKey === "other"'), "未知 kind 须落 other/file 图标");
  assert.ok(src.includes("onError={() => setMediaFailed(true)}"), "灯箱图/视频坏链须降级占位");
  assert.ok(src.includes("setMediaFailed(false)"), "切换作品须重置破图状态");

  const css = readSrc("app/styles/library.css");
  assert.ok(css.includes(".lib-thumb-placeholder[data-filter=\"image\"]"), "缺 image 渐变档");
  assert.ok(css.includes(".lib-thumb-placeholder[data-filter=\"video\"]"), "缺 video 渐变档");
  assert.ok(css.includes(".lib-thumb-placeholder[data-filter=\"audio\"]"), "缺 audio 渐变档");
  assert.ok(css.includes(".lib-thumb-placeholder[data-filter=\"3d\"]"), "缺 3d 渐变档");
  assert.ok(css.includes(".lib-thumb-placeholder[data-filter=\"other\"]"), "缺 other 渐变档");
  assert.ok(css.includes(".lib-thumb-placeholder-icon"), "缺占位图标样式");
  assert.ok(css.includes("linear-gradient"), "占位须渐变底(市场同范式)");
  // 零 hex:占位块走 token / color-mix
  const phStart = css.indexOf("/* ── 占位卡");
  const phEnd = css.indexOf(".lib-thumb-status {");
  assert.ok(phStart >= 0 && phEnd > phStart, "占位 CSS 块边界未找到");
  const phBlock = css.slice(phStart, phEnd);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(phBlock), "占位卡不得硬编码 hex");
  assert.ok(phBlock.includes("var(--bg-surface-2)"), "占位须引用表面令牌");
  assert.ok(phBlock.includes("color-mix"), "类型档须 color-mix 强调令牌");
});


/* ── 应用产物归桶(2026-09-15 作品库×应用搭配) ── */

test("kindToFilter:app_* 语义 kind 按产物类型归桶,app_run 不误归", () => {
  assert.equal(kindToFilter("app_image"), "image");
  assert.equal(kindToFilter("app_video"), "video");
  assert.equal(kindToFilter("app_audio"), "audio");
  assert.equal(kindToFilter("app_3d"), "3d");
  assert.equal(kindToFilter("app_run"), null, "遗留 app_run 无产物不归桶");
});

test("kindsQueryForFilter:类型 chip 的服务端 kind 查询包含 app_* 别名", () => {
  const video = kindsQueryForFilter("video").split(",");
  assert.ok(video.includes("app_video"), "视频桶须带 app_video");
  const image = kindsQueryForFilter("image").split(",");
  assert.ok(image.includes("app_image"), "图像桶须带 app_image");
  assert.ok(kindsQueryForFilter("audio").includes("app_audio"));
  assert.ok(kindsQueryForFilter("3d").includes("app_3d"));
});

test("kindLabel:app_* 中文短名;未知 kind 仍兜底「其他」", () => {
  assert.equal(kindLabel("app_video"), "应用·视频");
  assert.equal(kindLabel("app_image"), "应用·图像");
  assert.equal(kindLabel("app_run"), "应用");
  assert.equal(kindLabel("no_such_kind"), "其他");
});

/* ── 灯箱展平条目(2026-09-15):单作业多产物逐张翻 + 卡片叠放 ── */

test("flattenLightboxEntries:多产物作业逐条展开,占位作业保留一格", () => {
  const jobs = [
    { id: "multi", status: "done", results: ["/a.png", "/b.png", "/c.png"] },
    { id: "single", status: "done", results: ["/d.png"] },
    { id: "err", status: "error", results: [] },
  ] as unknown as Parameters<typeof flattenLightboxEntries>[0];
  const entries = flattenLightboxEntries(jobs);
  assert.equal(entries.length, 3 + 1 + 1);
  assert.equal(entries[0].url, "/a.png");
  assert.equal(entries[2].url, "/c.png");
  assert.equal(entries[0].count, 3);
  assert.equal(entries[1].index, 1);
  assert.ok(entries.every((e) => e.job.id !== "err" || e.placeholder));
  assert.equal(entries[4].job.id, "err");
  assert.equal(entries[4].placeholder, true);
});

test("LibraryCard 多产物:is-stack 类 + N 张角标 + 灯箱条目接线(源码)", () => {
  const src = readFileSync(join(webRoot, "components/library/LibraryView.tsx"), "utf-8");
  assert.ok(src.includes("is-stack"), "多产物作业卡缺叠放类");
  assert.ok(src.includes("lib-stack-badge"), "缺 N 张角标");
  assert.ok(src.includes("flattenLightboxEntries"), "灯箱须走展平条目");
  assert.ok(src.includes('entries={lightboxEntries}'), "主灯箱未接条目");
  assert.ok(src.includes("第 {entry.index + 1} / {entry.count} 张"), "灯箱缺组内序号");
  const css = readFileSync(join(webRoot, "app/styles/library.css"), "utf-8");
  assert.ok(css.includes(".lib-card.is-stack .lib-thumb"), "缺叠放阴影样式");
});

test("多产物二级页:叠放卡点击下钻(面包屑+全组网格),非直开灯箱(源码)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("openStackJobId"), "缺二级页状态");
  assert.ok(src.includes("else if (isStack) setOpenStackJobId(job.id)"), "叠放卡点击应进二级页");
  assert.ok(src.includes("lib-breadcrumb-back"), "二级页缺返回面包屑");
  assert.ok(src.includes("lib-stack-grid"), "二级页缺网格容器");
  const css = readFileSync(join(webRoot, "app/styles/library.css"), "utf-8");
  assert.ok(/5px -5px/.test(css), "衬纸应在右上角错位");
});

test("灯箱组内胶片条:多产物作业底部点选直达(源码+样式)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("lib-lb-filmstrip"), "缺胶片条容器");
  assert.ok(src.includes("本组图片"), "缺 aria 标签");
  const css = readFileSync(join(webRoot, "app/styles/library.css"), "utf-8");
  assert.ok(css.includes(".lib-lb-film.is-on"), "缺选中态样式");
});

test("场景组 chips 携带图标:8 组 icon 均为合法 Icon 名(源码)", () => {
  const src = readFileSync(join(webRoot, "lib/apps.ts"), "utf-8");
  for (const icon of ["user", "crop", "sparkles", "clapperboard", "brush", "mic", "store", "sliders"]) {
    assert.ok(src.includes(`icon: "${icon}"`), `缺图标 ${icon}`);
  }
});

test("作品库计数重设计:chips 用服务端总数 + 已加载/总数提示 + 分页阈值修正(源码)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("fetchJobCount"), "未接计数接口");
  assert.ok(src.includes("serverCounts"), "缺服务端计数 state");
  assert.ok(src.includes("lib-loaded-hint"), "缺已显示/总数提示");
  assert.ok(
    src.includes("setServerHasMore(page.length >= LIBRARY_PAGE_LIMIT)"),
    "loadMoreServer 满页阈值必须用 LIBRARY_PAGE_LIMIT(60),误用 200 会让无限滚动提前停",
  );
  assert.ok(!src.includes("setServerHasMore(page.length >= JOBS_PAGE_LIMIT)"));
});

test("一键清理失败作品:工具栏按钮+确认 Modal+软删恢复通道(源码)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("cleanupFailedJobs"), "未接清理接口");
  assert.ok(src.includes("setConfirmCleanupFailed(true)"), "清理按钮未接确认框");
  assert.ok(src.includes("清理失败 {failedCount}"), "按钮缺失败数角标");
  assert.ok(src.includes("72 小时内可在回收站恢复"), "提示语应说明可恢复");
  assert.ok(src.includes("loadCounts();"), "清理后计数应刷新");
  const mock = readFileSync(join(webRoot, "tests/mocks/studioApi.ts"), "utf-8");
  assert.ok(mock.includes("export const cleanupFailedJobs"), "替身缺导出会炸链接期");
});

test("视频卡提速:海报帧 + hoverOnly(不再整屏拉视频元数据)(源码)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(
    src.includes("poster={imageThumbUrl(job.results[0])}"),
    "视频卡缺服务端海报",
  );
  const lazy = readFileSync(join(webRoot, "components/ui/LazyVideo.tsx"), "utf-8");
  assert.ok(lazy.includes("hoverOnly"), "LazyVideo 缺 hoverOnly 档位");
});

// ── 2026-09-20 作品库优化 P0:来源筛选 / 重试白名单 ──

test("来源筛选:applyLibraryQuery source 维度(引擎族/应用)", () => {
  const q = applyLibraryQuery;
  const mk = (id: string, kind: string, appId = "") =>
    ({ id, kind, app_id: appId, prompt: "p" }) as never;
  const jobs = [
    mk("a", "txt2img"),
    mk("b", "h3_t2v"),
    mk("c", "h3_t2v"),
    mk("d", "app_video", "rh-x"),
    mk("e", "app_image", "rh-x"),
  ];
  const base = { filter: "all", contentFilter: "all", search: "", sort: "newest" } as never;
  assert.equal(q(jobs, { ...base, source: "" }).length, 5);
  assert.deepEqual(
    q(jobs, { ...base, source: "engine:h3_t2v" }).map((j) => j.id), ["b", "c"]);
  assert.deepEqual(
    q(jobs, { ...base, source: "app:rh-x" }).map((j) => j.id), ["d", "e"]);
  assert.deepEqual(q(jobs, { ...base, source: "engine:missing" }).length, 0);
});

test("重试白名单:canRerun 仅白名单 kind 且有快照且非进行中", () => {
  const mk = (kind: string, has = true, status = "error") =>
    ({ kind, has_params: has, status }) as never;
  assert.ok(canRerun(mk("txt2img")));
  assert.ok(canRerun(mk("h3_t2v")));
  assert.ok(canRerun(mk("longcat_t2v")));
  assert.ok(!canRerun(mk("h3_i2v")), "h3_i2v 媒体句柄会失效,不可重试");
  assert.ok(!canRerun(mk("app_video")), "应用运行不可重试");
  assert.ok(!canRerun(mk("txt2img", false)), "无快照不可重试");
  assert.ok(!canRerun(mk("txt2img", true, "running")), "进行中不可重试");
});

test("重试 UI 接线:卡面内联按钮 + hover 操作 + 灯箱按钮 + 快捷键提示(源码)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("lib-retry-inline"), "失败卡缺内联重试按钮");
  assert.ok(src.includes("lib-retrying"), "缺重试中遮罩");
  assert.ok(src.includes("rerunJob(job.id, { seed_mode: seedMode })"), "未接 rerun 接口");
  assert.ok(src.includes("lib-lb-kbd-hints"), "灯箱缺快捷键提示条");
  assert.ok(src.includes('"D"') && src.includes('"R"'), "快捷键缺 D/R 扩展");
});

test("来源筛选 UI 接线:下拉 + 引擎/应用分组 + 计数(源码)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("lib-source-pop"), "缺来源下拉弹层");
  assert.ok(src.includes('lib-source-group'), "缺引擎/应用分组");
  assert.ok(src.includes("sourceLabelOf"), "缺 chip 当前值文案");
  assert.ok(src.includes("setSource(o.value)"), "选项未接筛选状态");
});

// ── 2026-09-20 作品库 P1:收藏 / 时间分组 / 元数据桥 / Shift 连选 ──

test("收藏:load/save 持久化 + 容错(坏 JSON/SSR)", async () => {
  const { loadFavorites, saveFavorites } = await import("@/lib/libraryQuery");
  // SSR(无 window):不炸,空集
  assert.equal(loadFavorites().size, 0);
  // 坏 JSON → 空集
  window.localStorage.setItem("toiv_library_favorites", "{broken");
  assert.equal(loadFavorites().size, 0);
  // 正常往返
  saveFavorites(new Set(["a", "b"]));
  assert.deepEqual([...loadFavorites()].sort(), ["a", "b"]);
  saveFavorites(new Set());
  assert.equal(loadFavorites().size, 0);
});

test("时间分组:groupJobsByTimeSlot 槽边界(今天/昨天/近7天/近30天/更早)", async () => {
  const { groupJobsByTimeSlot } = await import("@/lib/libraryQuery");
  const now = new Date("2026-09-20T15:00:00").getTime();
  const day = 86400_000;
  const mk = (id: string, msAgo: number) =>
    ({ id, kind: "txt2img", prompt: "", created_at: new Date(now - msAgo).toISOString() }) as never;
  const jobs = [
    mk("t1", 1 * 3600_000),                 // 今天
    mk("y1", day + 3600_000),               // 昨天
    mk("w1", 3 * day),                      // 近 7 天
    mk("m1", 20 * day),                     // 近 30 天
    mk("o1", 60 * day),                     // 更早
  ];
  const groups = groupJobsByTimeSlot(jobs, now);
  assert.deepEqual(groups.map((g) => g.key), ["today", "yesterday", "week", "month", "older"]);
  assert.deepEqual(groups.map((g) => g.jobs[0].id), ["t1", "y1", "w1", "m1", "o1"]);
  // 空槽不出现
  const g2 = groupJobsByTimeSlot([mk("o2", 90 * day)], now);
  assert.deepEqual(g2.map((g) => g.key), ["older"]);
});

test("元数据桥:buildMetaBlock 含 prompt/seed/分辨率;pngHasWorkflow 识别 tEXt 关键字", async () => {
  const { buildMetaBlock, pngHasWorkflow } = await import("@/lib/libraryQuery");
  const job = {
    id: "j1", kind: "txt2img", prompt: "a cat", seed: 42,
    created_at: "2026-09-20T00:00:00",
    meta: { width: 1024, height: 576, steps: 25 },
  } as never;
  const block = buildMetaBlock(job);
  assert.ok(block.includes("prompt: a cat"));
  assert.ok(block.includes("seed: 42"));
  assert.ok(block.includes("size: 1024x576"));
  assert.ok(block.includes("steps: 25"));
  assert.ok(block.includes("job_id: j1"));

  // 伪造 PNG:签名 + tEXt 块(keyword=workflow,value 任意)
  const text = "workflow\x00{\"x\":1}";
  const chunk = new Uint8Array(8 + text.length + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, text.length);
  chunk.set([116, 69, 88, 116], 4); // "tEXt"
  for (let i = 0; i < text.length; i++) chunk[8 + i] = text.charCodeAt(i);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk]);
  assert.ok(pngHasWorkflow(png));
  // 无 tEXt → false
  assert.ok(!pngHasWorkflow(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  // 非 PNG → false
  assert.ok(!pngHasWorkflow(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])));
});

test("P1 UI 接线:收藏三入口/时间标题/复制参数/PNG 徽标/Shift 连选(源码)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  // 收藏:工具条开关 + hover 心形 + 灯箱动作 + F 键
  assert.ok(src.includes("favOnly"), "缺只看收藏开关");
  assert.ok(src.includes("toggleFavorite"), "缺收藏切换");
  assert.ok(src.includes('e.key === "f"'), "灯箱缺 F 收藏键");
  // 时间分组
  assert.ok(src.includes("lib-time-header"), "缺时间分组标题");
  assert.ok(src.includes("timeSlotKeyOf"), "未用时间槽纯函数");
  // 元数据桥
  assert.ok(src.includes("buildMetaBlock"), "缺参数块构造");
  assert.ok(src.includes("pngHasWorkflow"), "缺 PNG 工作流探测");
  assert.ok(src.includes("lib-lb-wf-chip"), "缺工作流徽标");
  // Shift 连选
  assert.ok(src.includes("rangeSelectTo"), "缺连选函数");
  assert.ok(src.includes("e.shiftKey"), "卡面点击未接 Shift");
});

// ── 2026-09-20 作品库 P2:变体组归组 / Saved Views ──

test("变体组:同 kind+seed+prompt 折叠 ≥2,batch_id 优先,孤品回落", async () => {
  const { groupLibraryEntries, variantKeyOf } = await import("@/lib/libraryQuery");
  const mk = (id: string, kind: string, seed: number | null, prompt: string, batchId = "") =>
    ({ id, kind, seed, prompt, batch_id: batchId }) as never;
  // 三个同参数变体 + 一个孤品 + 一个 batch_id 组
  const jobs = [
    mk("a", "txt2img", 42, "a cat"),
    mk("b", "txt2img", 42, "a cat"),
    mk("c", "txt2img", 42, "a cat"),
    mk("d", "txt2img", 7, "a cat"),
    mk("e", "txt2img", 1, "x", "batch-1"),
    mk("f", "txt2img", 2, "y", "batch-1"),
  ];
  const entries = groupLibraryEntries(jobs, { groupVariants: true });
  const folders = entries.filter((e) => e.type === "batch");
  // 变体组 1 个(3 成员,variant=true) + batch 组 1 个(variant 未设)
  assert.equal(folders.length, 2);
  const vf = folders.find((e) => e.type === "batch" && e.folder.variant);
  assert.ok(vf && vf.type === "batch");
  assert.equal(vf.type === "batch" ? vf.folder.members.length : 0, 3);
  // 孤品 d 原样平铺
  assert.ok(entries.some((e) => e.type === "job" && e.job.id === "d"));
  // 关 groupVariants:变体不平折
  const flat = groupLibraryEntries(jobs);
  assert.ok(!flat.some((e) => e.type === "batch" && e.folder.variant));
  // seed 空不参与
  assert.equal(variantKeyOf(mk("z", "txt2img", null, "p")), "");
});

test("Saved Views:持久化往返 + 坏数据容错 + 应用语义", async () => {
  const { loadViews, saveViews } = await import("@/lib/libraryQuery");
  assert.deepEqual(loadViews(), []);
  window.localStorage.setItem("toiv_library_views", "[{\"bad\":1}]");
  assert.deepEqual(loadViews(), []);
  const views = [
    {
      id: "v1", name: "H3 视频",
      query: { filter: "video", contentFilter: "all", source: "engine:h3_t2v", search: "", favOnly: false },
    },
  ];
  saveViews(views);
  assert.equal(loadViews().length, 1);
  assert.equal(loadViews()[0].query.source, "engine:h3_t2v");
  saveViews([]);
  assert.deepEqual(loadViews(), []);
});

test("P2 UI 接线:变体组标题/存视图按钮/视图 chips(源码)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("groupVariants: true"), "未开变体归组");
  assert.ok(src.includes('folder.variant ? "同参数变体"'), "文件夹卡未区分变体组");
  assert.ok(src.includes("存视图"), "缺存视图按钮");
  assert.ok(src.includes("lib-view-chip"), "缺视图 chips 行");
  assert.ok(src.includes("applyView"), "视图未接应用回调");
});

// ── 2026-09-21 作品库 P3:资产即输入 / 一键同款 ──

test("assetPick:作品 URL → 句柄解析(图/视/音) + 消费语义(kind 不匹配保留)", async () => {
  const { pickFromJob, saveAssetPick, consumeAssetPick, clearAssetPick } = await import("@/lib/assetPick");
  const mk = (url: string) => ({ results: [url] }) as never;
  const img = pickFromJob(mk("/api/images?filename=a.png&subfolder=&type=output&worker=http%3A%2F%2F192.168.71.127%3A8196&sig=x"));
  assert.equal(img?.kind, "image");
  assert.equal(img?.filename, "a.png");
  assert.equal(img?.worker, "http://192.168.71.127:8196");
  assert.equal(pickFromJob(mk("/api/images?filename=v.mp4&worker=http://w:1"))?.kind, "video");
  assert.equal(pickFromJob(mk("/api/images?filename=m.mp3&worker=http://w:1"))?.kind, "audio");
  assert.equal(pickFromJob(mk("/api/images?filename=missing-worker.png")), null);
  assert.equal(pickFromJob({ results: [] } as never), null);

  // 消费:kind 不匹配保留,匹配清除, clearAssetPick 幂等
  saveAssetPick({ kind: "video", filename: "v.mp4", worker: "http://w:1", url: "" });
  assert.equal(consumeAssetPick("image"), null, "不匹配应保留");
  assert.equal(consumeAssetPick()?.filename, "v.mp4", "不限 kind 消费成功");
  assert.equal(consumeAssetPick(), null, "已清除");
  clearAssetPick();
  assert.equal(consumeAssetPick(), null);
});

test("P3 UI 接线:用作参考/再做一张/引擎台消费 pick(源码)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("handleUseAsInput"), "缺用作参考 handler");
  assert.ok(src.includes("handleMakeAnother"), "缺再做一张 handler");
  assert.ok(src.includes('seed_mode: seedMode'), "rerun 未参数化 seedMode");
  assert.ok(src.includes("用作输入"), "卡 hover 缺用作参考按钮");
  const studio = readSrc("components/studio/EngineStudioView.tsx");
  assert.ok(studio.includes("consumeAssetPick"), "引擎台未消费资产暂存");
  assert.ok(studio.includes("已填入参考图"), "缺填入成功提示");
});

// ── 2026-09-21 续写链 / 跨端同步 / 闭门同款 ──

test("闭门同款:remix 编解码往返 + kind→engineId 映射 + 媒体键剥离", async () => {
  const { buildRemixPayload, encodeRemix, decodeRemix, engineIdForKind } = await import("@/lib/remixLink");
  assert.equal(engineIdForKind("h3_t2v"), "h3-t2v");
  assert.equal(engineIdForKind("longcat_t2v"), "longcat-t2v");
  assert.equal(engineIdForKind("audio"), "ace-music");
  const job = {
    id: "j1", kind: "h3_t2v", prompt: "a cat", seed: 42,
    meta: { width: 832, height: 480, steps: 25, duration_hint: 5 },
    params: "",
  } as never;
  const p = buildRemixPayload(job);
  assert.equal(p.e, "h3-t2v");
  assert.equal(p.s, 42);
  assert.equal(p.v.width, 832);
  const back = decodeRemix(encodeRemix(p));
  assert.deepEqual(back, p);
  assert.equal(decodeRemix("!!!not-base64"), null);
});

test("续写链:UI 徽标 + 灯箱行 + studio 隐藏值 + 请求字段(源码)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("lib-continued-badge"), "缺续写于徽标");
  assert.ok(src.includes("续写于"), "灯箱缺续写行");
  const studio = readSrc("components/studio/EngineStudioView.tsx");
  assert.ok(studio.includes("__source_job_id"), "studio 缺续写链隐藏值");
  const api = readFileSync(join(webRoot, "lib/api.ts"), "utf-8");
  assert.ok(api.includes("source_job_id"), "LongcatContinueParams 缺 source_job_id");
});

test("跨端同步:pullPreferences 服务端覆盖本地(空串不动)+端点路径(源码)", async () => {
  const api = readFileSync(join(webRoot, "lib/api.ts"), "utf-8");
  assert.ok(api.includes('"/api/account/preferences"'), "偏好端点路径缺失");
  const sync = readFileSync(join(webRoot, "lib/preferencesSync.ts"), "utf-8");
  assert.ok(sync.includes("if (remote.favorites)"), "空串字段不应覆盖本地");
  const view = readSrc("components/library/LibraryView.tsx");
  assert.ok(view.includes("pullPreferences"), "作品库未拉取偏好");
  assert.ok(view.includes("schedulePush({ favorites"), "收藏变更未推送");
});

// ── 2026-09-21 画板(手动主题板) ──

test("画板:UI 接线——入口按钮/移入画板选择器/板视图切换(源码)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("lib-boards-toggle"), "工具条缺画板入口");
  assert.ok(src.includes("openBoardPicker"), "缺移入画板选择器");
  assert.ok(src.includes("addJobToBoard"), "缺追加成员逻辑");
  assert.ok(src.includes("lib-board-picker"), "缺板选择器弹层");
  assert.ok(src.includes("BoardsView"), "未挂画板视图");
  const boards = readSrc("components/library/BoardsView.tsx");
  assert.ok(boards.includes("lib-board-new"), "板视图缺新建输入");
  assert.ok(boards.includes("removeItem"), "缺移除成员");
  assert.ok(boards.includes("onUseAsInput"), "板内未接资产即输入");
});
