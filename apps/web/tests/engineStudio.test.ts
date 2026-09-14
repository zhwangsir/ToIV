/**
 * 引擎工作台(2026-09-12 导航收口)单测(node:test + renderToStaticMarkup + fetch 桩):
 * ① lib/engineStudio:模式→引擎映射解析(目录缺引擎自动隐藏/整模式无引擎隐藏/
 *    hidden 与跨 kind 剔除)、默认引擎选择(第一在线项,全离线回退首项)、
 *    R18 过滤行为(nsfw 引擎随目录混入/剔除,前端不判断)、extractStudioMedia 媒体契约
 * ② 提交错误路径:fetch 桩 503 → submitEngineGeneration 拒绝,错误文案进横幅链路
 * ③ EngineStudioView:初始加载态骨架静态渲染;复用接线源码断言
 *    (ParamField/submitEngineGeneration/ResultPanel/ErrorBar/at-seg/apps-studio-*)
 * ④ 共享抽取:GenerateView uploadKind 改走 lib/engines.engineUploadKind(不再私链)
 * ⑤ prefetch.ts 白名单同步(image/video 预热引擎注册表,不再拉应用目录)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  defaultStudioEngine,
  extractStudioMedia,
  resolveStudioModes,
  STUDIO_MODES,
} from "../lib/engineStudio";
import { engineUploadKind, submitEngineGeneration, type EngineInfo } from "../lib/engines";
import { EngineStudioView } from "../components/studio/EngineStudioView";
import { ToastProvider } from "../components/ui/Toast";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

function eng(id: string, kind: "image" | "video", extra?: Partial<EngineInfo>): EngineInfo {
  return {
    id,
    label: id,
    kind,
    available: true,
    nsfw: id.includes("nsfw"),
    params: [],
    ...extra,
  };
}

/* ── ① lib/engineStudio:模式→引擎映射 ── */

test("resolveStudioModes:全量目录 → 映射表三模式(image)/四模式(video),引擎保持映射序", () => {
  const catalog: EngineInfo[] = [
    eng("txt2img", "image"),
    eng("nsfw-txt2img", "image"),
    eng("img2img", "image"),
    eng("nsfw-img2img", "image"),
    eng("qwen-image-edit", "image"),
    eng("h3-t2v", "video"),
    eng("longcat-t2v", "video"),
    eng("ltx-nsfw-t2v", "video"),
    eng("h3-i2v", "video"),
    eng("longcat-i2v", "video"),
    eng("ltx-nsfw-i2v", "video"),
    eng("wan-nsfw-i2v", "video"),
    eng("h3-fl2v", "video"),
    eng("h3-r2v", "video"),
  ];
  const imageModes = resolveStudioModes(catalog, "image");
  assert.deepEqual(imageModes.map((m) => m.id), ["t2i", "i2i", "edit"]);
  assert.deepEqual(imageModes[0].engines.map((e) => e.id), ["txt2img", "nsfw-txt2img"]);
  const videoModes = resolveStudioModes(catalog, "video");
  assert.deepEqual(videoModes.map((m) => m.id), ["t2v", "i2v", "fl2v", "r2v"]);
  assert.deepEqual(
    videoModes[1].engines.map((e) => e.id),
    ["h3-i2v", "longcat-i2v", "ltx-nsfw-i2v", "wan-nsfw-i2v"],
    "图生视频引擎应保持映射表优先级序(h3 优先)",
  );
});

test("resolveStudioModes:目录缺引擎自动隐藏;整模式无引擎时模式隐藏", () => {
  const catalog: EngineInfo[] = [
    eng("txt2img", "image"),
    // nsfw-txt2img 缺席(SFW 上下文) → 文生图只剩 txt2img
    eng("img2img", "image"),
    eng("nsfw-img2img", "image"),
    // qwen-image-edit 缺席 → 图片编辑模式整体隐藏
  ];
  const modes = resolveStudioModes(catalog, "image");
  assert.deepEqual(modes.map((m) => m.id), ["t2i", "i2i"], "图片编辑模式应整体隐藏");
  assert.deepEqual(modes[0].engines.map((e) => e.id), ["txt2img"], "缺失引擎应自动隐藏");
  // 空目录 → 零模式(空态由视图层承载)
  assert.deepEqual(resolveStudioModes([], "video"), []);
});

test("resolveStudioModes:hidden 与跨 kind 引擎剔除;离线引擎保留(卡片置灰由视图层呈现)", () => {
  const catalog: EngineInfo[] = [
    eng("txt2img", "image"),
    eng("nsfw-txt2img", "image", { hidden: true }),
    eng("img2img", "image", { available: false, unavailable_reason: "worker 离线" }),
    eng("qwen-image-edit", "video"), // 目录异常:跨 kind 同 id,不应进 image 模式
  ];
  const modes = resolveStudioModes(catalog, "image");
  assert.deepEqual(modes.map((m) => m.id), ["t2i", "i2i"]);
  assert.deepEqual(modes[0].engines.map((e) => e.id), ["txt2img"], "hidden 引擎应剔除");
  assert.equal(modes[1].engines[0].available, false, "离线引擎应保留在列表中");
  assert.equal(modes[1].engines[0].unavailable_reason, "worker 离线");
});

test("R18 过滤行为:nsfw 引擎随目录混入/剔除,前端不另设开关", () => {
  // SFW 上下文目录:后端已剔除 nsfw 引擎 → 映射含 nsfw 位但解析后不可见
  const sfw = resolveStudioModes([eng("txt2img", "image"), eng("img2img", "image")], "image");
  assert.ok(!sfw.some((m) => m.engines.some((e) => e.nsfw)), "SFW 目录不得出现 R18 引擎");
  // R18 上下文目录:后端混入 nsfw 引擎 → 按映射序排在 SFW 对位之后
  const r18 = resolveStudioModes(
    [eng("txt2img", "image"), eng("nsfw-txt2img", "image")],
    "image",
  );
  assert.deepEqual(r18[0].engines.map((e) => e.id), ["txt2img", "nsfw-txt2img"]);
});

test("defaultStudioEngine:默认 = 映射表第一个在线项;全离线回退首项", () => {
  const modes = resolveStudioModes(
    [eng("txt2img", "image", { available: false }), eng("nsfw-txt2img", "image")],
    "image",
  );
  assert.equal(defaultStudioEngine(modes[0])?.id, "nsfw-txt2img", "首个离线时应落到下一个在线项");
  const allOff = resolveStudioModes(
    [eng("h3-fl2v", "video", { available: false })],
    "video",
  );
  assert.equal(defaultStudioEngine(allOff[0])?.id, "h3-fl2v", "全离线回退首项(可选中看参数)");
});

test("extractStudioMedia:images 拼接/audio/video 首柄;字符串与句柄对象兼容", () => {
  const e = eng("h3-r2v", "video", {
    params: [
      { key: "images", label: "参考图", type: "images", default: null, max: 4 },
      { key: "video", label: "参考视频", type: "video", default: null },
      { key: "audio", label: "参考音频", type: "audio", default: null },
    ],
  });
  const refs = extractStudioMedia(e, {
    images: [{ filename: "a.png", worker: "w1" }, { filename: "b.png", worker: "w1" }],
    video: [{ filename: "v.mp4", worker: "w1" }],
    audio: "x.mp3",
  });
  assert.deepEqual(refs.refImages, [
    { filename: "a.png", worker: "w1" },
    { filename: "b.png", worker: "w1" },
  ]);
  assert.deepEqual(refs.refVideo, { filename: "v.mp4", worker: "w1" });
  assert.deepEqual(refs.refAudio, { filename: "x.mp3", worker: "" });
  // 空 values → 全空(提交门控由视图层 canSubmit 承载)
  const empty = extractStudioMedia(e, {});
  assert.equal(empty.refImages.length, 0);
  assert.equal(empty.refAudio, null);
});

/* ── ② 提交错误路径(fetch 桩 503 → 错误横幅链路) ── */

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (): Promise<Response> => {
    return new Response(JSON.stringify({ detail: "H3 引擎离线,请稍后再试" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("提交 503(引擎离线):submitEngineGeneration 拒绝并透出后端 detail(横幅文案来源)", async () => {
  const engine = eng("h3-t2v", "video");
  await assert.rejects(
    submitEngineGeneration({ engine, positive: "一只猫在草地上奔跑", values: {} }),
    /H3 引擎离线/,
    "503 detail 应原样透出(视图层经 friendlyError 包装后进 ErrorBar,不静默)",
  );
});

/* ── ③ EngineStudioView 复用接线 ── */

test("EngineStudioView 初始加载态渲染骨架(引擎目录未就绪)", () => {
  const html = renderToStaticMarkup(h(ToastProvider, null, h(EngineStudioView, { kind: "image" })));
  assert.match(html, /apps-studio/, "缺工作台根容器");
  assert.match(html, /skeleton/i, "引擎目录加载中应渲染骨架");
});

test("EngineStudioView 复用接线:ParamField/submitEngineGeneration/ResultPanel/ErrorBar(源码)", () => {
  const src = readSrc("components/studio/EngineStudioView.tsx");
  assert.ok(src.includes('from "@/components/generate/ParamField"'), "参数区应复用 generate/ParamField");
  assert.ok(src.includes("<ParamField"), "引擎 params 应经 ParamField 渲染");
  assert.ok(src.includes("submitEngineGeneration"), "提交应走 lib/engines 既有链路(不另写提交逻辑)");
  assert.ok(src.includes("useGeneration"), "进度跟踪应复用 useGeneration/trackJob");
  assert.ok(src.includes("ResultPanel"), "结果区应复用 generate/ResultPanel");
  assert.ok(src.includes("ErrorBar"), "错误横幅应复用 ErrorBar");
  assert.ok(src.includes("friendlyError"), "提交错误应经 friendlyError 包装");
  assert.ok(src.includes("setSubmitError"), "提交失败应写错误横幅状态(不静默)");
  assert.ok(src.includes("at-seg"), "模式段控应复用 at-seg 共享类");
  assert.ok(src.includes('role="tablist"'), "段控缺 tablist 语义");
  assert.ok(src.includes("引擎离线"), "离线引擎卡片/门控提示缺失");
  assert.ok(src.includes("resolveStudioModes"), "模式解析应走 lib/engineStudio");
  assert.ok(src.includes("engineUploadKind"), "上传 kind 应走共享 engineUploadKind");
  assert.ok(src.includes('import "@/app/styles/apps.css"'), "样式应集中进 apps.css");
  assert.ok(!src.includes("styled-jsx") && !src.includes("<style jsx"), "不应使用 styled-jsx(集中 css 纪律)");
  for (const cls of [
    "apps-studio-engines",
    "apps-studio-engine-card",
    "is-offline",
    "apps-studio-params",
    "apps-studio-runbar",
    "apps-studio-results",
  ]) {
    assert.ok(src.includes(cls), `组件缺 ${cls} 类`);
  }
});

/* ── ④ 共享抽取:engineUploadKind ── */

test("engineUploadKind:GenerateView 口径收编 lib/engines,h3-* 直传 H3 实例", () => {
  assert.equal(engineUploadKind("img2img"), "img2img");
  assert.equal(engineUploadKind("nsfw-img2img"), "img2img");
  assert.equal(engineUploadKind("h3-i2v"), "h3_i2v");
  assert.equal(engineUploadKind("h3-fl2v"), "h3_i2v");
  assert.equal(engineUploadKind("h3-r2v"), "h3_i2v");
  assert.equal(engineUploadKind("wan-animate-2"), "wan_animate2");
  assert.equal(engineUploadKind("wan-vace"), "wan_vace");
  assert.equal(engineUploadKind("ltx-nsfw-i2v"), "ltx_i2v");
  const gv = readSrc("components/generate/GenerateView.tsx");
  assert.ok(gv.includes("engineUploadKind(engine.id)"), "GenerateView 应改走共享 engineUploadKind");
  assert.ok(!gv.includes('engine?.id === "wan-animate-2"'), "GenerateView 不应再私链 uploadKind 三元");
});

/* ── ⑤ 样式与预取 ── */

test("apps.css:apps-studio-* 类齐全且 token 纪律(零 hex)", () => {
  const css = readSrc("app/styles/apps.css");
  for (const cls of [
    ".apps-studio",
    ".apps-studio-head",
    ".apps-studio-body",
    ".apps-studio-panel",
    ".apps-studio-engines",
    ".apps-studio-engine-card",
    ".apps-studio-engine-dot",
    ".apps-studio-engine-desc",
    ".apps-studio-engine-off",
    ".apps-studio-params",
    ".apps-studio-runbar",
    ".apps-studio-block",
    ".apps-studio-results",
  ]) {
    assert.ok(css.includes(cls), `apps.css 缺 ${cls} 定义`);
  }
  const studioBlock = css.slice(css.indexOf(".apps-studio {"));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(studioBlock), "apps-studio 段不得出现 hex 色值");
});

test("prefetch.ts:image/video 预热引擎注册表,不再拉应用目录(应用全归市场)", () => {
  const src = readSrc("lib/prefetch.ts");
  const img = src.match(/image: \[[^\]]*\]/)?.[0] ?? "";
  const vid = src.match(/video: \[[^\]]*\]/)?.[0] ?? "";
  for (const [name, row] of [["image", img], ["video", vid]] as const) {
    assert.ok(row.includes("fetchEngines()"), `${name} 预热缺引擎注册表`);
    assert.ok(!row.includes("listApps()"), `${name} 不应再预热应用目录`);
  }
  assert.ok((src.match(/market: \[[^\]]*\]/)?.[0] ?? "").includes("listApps()"), "market 预热保留应用目录");
});

test("STUDIO_MODES 映射覆盖设计清单(模式标签与引擎 id)", () => {
  assert.deepEqual(STUDIO_MODES.image.map((m) => m.label), ["文生图", "图生图", "图片编辑"]);
  assert.deepEqual(STUDIO_MODES.video.map((m) => m.label), ["文生视频", "图生视频", "首尾帧", "参考生视频"]);
  assert.deepEqual(STUDIO_MODES.video[0].engineIds, ["h3-t2v", "longcat-t2v", "ltx-nsfw-t2v"]);
  assert.deepEqual(STUDIO_MODES.video[1].engineIds, ["h3-i2v", "longcat-i2v", "ltx-nsfw-i2v", "wan-nsfw-i2v"]);
});
