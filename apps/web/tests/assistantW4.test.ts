/**
 * 助手对话流单测(node:test,无 DOM)——2026-08-31 双波次口径:
 * W4:产物胶片条(≥2 帧横排)/多作业卡聚合/破图修复(imageUrl 补 token)/
 *    面板 Esc+顶让位/回放链路(空工具轮跳过 + 媒体并入 + URL 去重)
 * W5:助手离线降级(探活失败 → 全量工作台导航)
 * Studio Console v1:空态只剩输入框(微粒场/胶囊/chip/页头全退役)
 * @/lib/api 经 tests/loader.mjs 映射到 mocks/studioApi 可控替身。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

// ── window/localStorage 替身:必须在导入组件模块前装好 ──
const g = globalThis as { window?: unknown; localStorage?: unknown };
g.window ??= globalThis;
const localStore = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => localStore.delete(k),
  clear: () => localStore.clear(),
};

const {
  flattenVisualFrames,
  renderAvFrames,
  aggregateJobFrames,
  messagesToChat,
  OFFLINE_ENTRIES,
} = await import("../components/assistant/AssistantView");

/* ── ① 胶片条 ── */

test("胶片条:flattenVisualFrames 只收 image/video,空 url 跳过", () => {
  const frames = flattenVisualFrames([
    { type: "image", urls: ["a.png", "", "b.png"] },
    { type: "video", urls: ["c.mp4"] },
    { type: "audio", urls: ["d.mp3"] },
    { type: "model3d", urls: ["e.glb"] },
  ]);
  assert.deepEqual(frames, [
    { type: "image", url: "a.png" },
    { type: "image", url: "b.png" },
    { type: "video", url: "c.mp4" },
  ]);
  assert.deepEqual(flattenVisualFrames([]), []);
});

test("胶片条:单帧 hero 直出,≥2 帧成条(导轨/帧号/语义)", () => {
  const single = renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderAvFrames([{ type: "image", url: "x.png" }], "t")),
  );
  assert.ok(single.includes("av-media-img"), "单帧应 hero 直出");
  assert.ok(!single.includes("av-filmstrip"), "单帧不应成条");
  assert.equal(renderAvFrames([], "t"), null);
  const strip = renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderAvFrames([
      { type: "image", url: "1.png" },
      { type: "image", url: "2.png" },
      { type: "video", url: "3.mp4" },
    ], "t")),
  );
  assert.ok(strip.includes("av-filmstrip"), "多帧应成胶片条");
  assert.ok(strip.includes('aria-label="产物胶片条"'), "胶片条缺语义标签");
  for (const no of ["01", "02", "03"]) {
    assert.ok(strip.includes(`>${no}<`), `缺帧号 ${no}`);
  }
  assert.ok(strip.includes("<video"), "视频帧缺失");
});

test("胶片条:消息媒体与作业卡产物均接线 AvMediaList/AvJobCards", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("<AvMediaList media={msg.media} />"), "消息媒体未走胶片条分流");
  assert.ok(src.includes("<AvJobCards jobs={msg.jobs}"), "作业卡未走聚合组件");
  assert.ok(src.includes(".av-filmstrip::before"), "缺打孔列样式");
  assert.ok(src.includes("scroll-snap-type: x mandatory"), "胶片条缺 scroll-snap");
});

/* ── ② 产物聚合 + 破图修复 + 面板修复(生产实测抓获) ── */

test("聚合:同消息 ≥2 done 作业的视觉产物合并一条胶片条", () => {
  const mk = (jobId: string, results: string[], status = "done") =>
    ({ jobId, kind: "txt2img", status, label: "", results }) as const;
  const agg = aggregateJobFrames([
    mk("a", ["/api/images?filename=1.png&sig=x"]),
    mk("b", ["/api/images?filename=2.png&sig=x"]),
    mk("c", ["/api/images?filename=3.png&sig=x"]),
    mk("d", ["/api/images?filename=4.png&sig=x"]),
  ]);
  assert.equal(agg.length, 4);
  assert.deepEqual(aggregateJobFrames([mk("a", ["/x.png"])]), []);
  assert.deepEqual(aggregateJobFrames([
    mk("a", ["/x.png"]),
    { jobId: "b", kind: "txt2img", status: "running", label: "" },
  ] as never), []);
  assert.deepEqual(aggregateJobFrames([
    { jobId: "a", kind: "music", status: "done", label: "", results: ["/api/images?filename=1.mp3&sig=x"] },
    { jobId: "b", kind: "music", status: "done", label: "", results: ["/api/images?filename=2.mp3&sig=x"] },
  ] as never), []);
});

test("破图修复:renderAvMedia/renderAvFrames 渲染时经 imageUrl 补 token", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("imageUrl(m.urls[0])"), "renderAvMedia 未补 token");
  assert.ok(src.includes("const src = imageUrl(f.url)"), "renderAvFrames 未补 token");
});

test("面板修复:页形态面板 Esc 统一关闭 + 桌面端顶让位 chrome 带", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(/Escape"\)[\s\S]{0,120}setDocsOpen\(false\)/.test(src), "页形态面板缺 Esc 关闭");
  assert.ok(/\.av-panel \{[^}]*top: 56px/.test(src), "面板未让位顶部 chrome 带");
  assert.ok(/max-width: 1023px\)[\s\S]{0,80}\.av-panel \{[\s\S]{0,40}top: 0/.test(src), "窄屏面板应恢复全高");
});

/* ── ③ 回放修复:空工具轮空气泡 + 异步产物回放 ── */

test("回放:纯工具轮 assistant 不生成空气泡,tool 媒体并入可见气泡", () => {
  const row = (id: number, role: string, content: string, media: { type: string; urls: string[] }[] = []) =>
    ({ id, role, content, tool_calls: null, media, created_at: "2026-08-31T13:00:00Z" }) as never;
  const msgs = messagesToChat([
    row(1, "user", "画四张猫"),
    row(2, "assistant", ""),
    row(3, "assistant", ""),
    row(4, "tool", "ok", [
      { type: "image", urls: ["/a.png"] },
      { type: "image", urls: ["/b.png"] },
    ]),
    row(5, "assistant", "画好了"),
  ]);
  assert.equal(msgs.filter((m) => m.role === "assistant" && !m.content && !(m.media?.length)).length, 0, "不允许无内容又无媒体的空气泡");
  const withMedia = msgs.find((m) => (m.media?.length ?? 0) > 0);
  assert.ok(withMedia, "tool 媒体未并入气泡");
  assert.equal(withMedia!.media!.length, 2);
  assert.equal(msgs[msgs.length - 1].content, "画好了");
});

/* ── ④ W5 降级路径:助手离线 → 全量工作台导航 ── */

test("W5 降级:探活失败置离线,门户隐藏对话框、展开全量工作台导航", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("setLlmOffline(!info)"), "缺探活离线判定");
  assert.ok(src.includes("const [llmOffline, setLlmOffline]"), "缺 llmOffline 状态");
  assert.ok(src.includes("llmOffline ? ("), "缺离线分支");
  assert.ok(src.includes('role="alert"'), "离线提示缺 alert 语义");
  assert.ok(src.includes("助手暂时离线"), "缺离线提示文案");
  assert.ok(src.includes("OFFLINE_ENTRIES.map"), "离线态未展开全量导航");
  for (const v of ["image", "video", "audio", "studio", "avatartalk", "dub", "imageEdit", "videoEdit", "canvas", "library", "entities", "market"]) {
    assert.ok(OFFLINE_ENTRIES.some((e) => e.view === v), `离线导航缺 ${v}`);
  }
  for (const v of ["admin", "observability", "settings"]) {
    assert.ok(!OFFLINE_ENTRIES.some((e) => e.view === v), `离线导航不应含 ${v}`);
  }
});

/* ── ⑤ Studio Console v1:空态极简 + 文档式消息流 ── */

test("Studio Console:空态只剩铭牌+输入框+模型行,门户区块全退役", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("av-console-wordmark"), "缺 TOIV 铭牌");
  assert.ok(src.includes("av-console-model"), "缺模型行");
  assert.ok(src.includes("av-portal--console"), "缺 console 空态变体");
  // 旧门户区块全退役(av-scene-chip 仍服务离线降级导航,不在此列)
  for (const dead of ["ParticleField", "QUICK_ACTIONS", "SCENE_CAPSULES", "av-eng-block", "av-works", "buildEngineCapsules", "pickRecentWorks"]) {
    assert.ok(!src.includes(dead), `旧门户元素残留: ${dead}`);
  }
  // 文档式消息流:无头像节点
  assert.ok(!src.includes("av-msg-avatar"), "消息头像节点应移除");
  // 页头退役,历史/新对话收进输入框工具行
  assert.ok(!src.includes("av-header"), "页头应整体退役");
  assert.ok(src.includes('aria-label="对话历史"'), "历史按钮应收进输入区");
  assert.ok(src.includes('aria-label="新对话"'), "新对话按钮应收进输入区");
});

test("Studio Console:胶片条 token 仍在 globals.css(组件未随微粒场一并退役)", () => {
  const css = readSrc("app/globals.css");
  for (const tok of ["--film-frame-w", "--film-frame-h", "--film-rail-bg", "--film-perf-color"]) {
    assert.ok(css.includes(tok), `globals.css 缺 token ${tok}`);
  }
  assert.ok(!css.includes("--particle-primary"), "微粒 token 应随微粒场退役");
});
