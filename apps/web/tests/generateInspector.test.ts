/**
 * 生成工作台「专业创作台」重构(2026-08-17,T1/T2/T3)防回归单测(node:test):
 * T1 参数面板 Inspector 化:
 *   ① groupEngineParam 归类(模型与引擎/画幅与时长/采样/LoRA 叠加/参考输入/高级兜底)
 *   ② groupEngineParams 分组(尺寸 chip 剔除 width/height;未知 key 落高级;保持注册表顺序)
 *   ③ GenerateView 源码:头部「参数台」标题唯一 + 滚动区迁移 .generate-params-body(修顶部裁剪)
 * T2 引擎说明卡:
 *   ④ EngineInfoCard 静态渲染:description/出处(name/url/author/note)/参数个数,url 新窗口 noopener
 *   ⑤ 缺 description/source 时对应块不渲染(兜底)
 * T3 空态快速开始卡:
 *   ⑥ QuickStartGrid 静态渲染(卡数/文案/at-card 语言/区标题)
 *   ⑦ 点击回调:直调组件取元素树,逐卡触发 onClick 断言 onPick 收到对应 engineId
 *   ⑧ 可用性门控:engines=null → 不渲染;引擎不在列表 → 卡不渲染;不可用 → disabled
 *   ⑨ ResultPanel 空态接线 + GenerateView onQuickStart(切组+聚焦)+ PromptBar inputRef(源码断言)
 * ⑩ stage.css 样式存在性:新类名齐全;全文件零 font-weight 数字 / 零 hex 硬编码
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EngineInfoCard } from "../components/generate/EngineInfoCard";
import { QUICK_START_DEFS, QuickStartGrid } from "../components/generate/QuickStartGrid";
import {
  PARAM_PANEL_GROUPS,
  groupEngineParam,
  groupEngineParams,
} from "../components/generate/paramGroups";
import type { EngineInfo, EngineParam } from "../lib/engines";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/** 构造最小 EngineParam。 */
function param(key: string, type: EngineParam["type"] = "number"): EngineParam {
  return { key, label: key, type, default: 0 };
}

/** 构造最小 EngineInfo。 */
function engine(id: string, over: Partial<EngineInfo> = {}): EngineInfo {
  return {
    id,
    label: id,
    kind: "video",
    available: true,
    nsfw: false,
    params: [],
    ...over,
  };
}

/* ── T1 ① 参数归类 ── */

test("groupEngineParam:命名 key 各归其组", () => {
  for (const k of ["ckpt_name", "style_preset", "sampler", "scheduler"]) {
    assert.equal(groupEngineParam(param(k, k === "ckpt_name" ? "text" : "select")), "model", k);
  }
  for (const k of ["width", "height", "resolution", "resolution_target", "duration", "fps", "denoise", "strength"]) {
    assert.equal(groupEngineParam(param(k, k === "resolution" || k === "resolution_target" ? "select" : "number")), "frame", k);
  }
  for (const k of ["steps", "cfg", "seed", "batch_size", "use_upscale", "use_rife", "full_quality"]) {
    assert.equal(groupEngineParam(param(k, k.startsWith("use_") || k === "full_quality" ? "switch" : "number")), "sampling", k);
  }
});

test("groupEngineParam:类型优先(loras→lora;images/audio/video→refs),未知 key 落高级", () => {
  assert.equal(groupEngineParam(param("loras", "loras")), "lora");
  assert.equal(groupEngineParam(param("images", "images")), "refs");
  assert.equal(groupEngineParam(param("audio", "audio")), "refs");
  assert.equal(groupEngineParam(param("video", "video")), "refs");
  assert.equal(groupEngineParam(param("negative", "textarea")), "advanced");
  assert.equal(groupEngineParam(param("some_future_key", "select")), "advanced");
  assert.equal(groupEngineParam(param("lyrics", "textarea")), "advanced");
});

test("groupEngineParam:分组展示顺序固定(模型与引擎→画幅与时长→采样→LoRA 叠加)", () => {
  assert.deepEqual(
    PARAM_PANEL_GROUPS.map((g) => g.id),
    ["model", "frame", "sampling", "lora"],
  );
  assert.deepEqual(
    PARAM_PANEL_GROUPS.map((g) => g.label),
    ["模型与引擎", "画幅与时长", "采样", "LoRA 叠加"],
  );
});

/* ── T1 ② 分组函数 ── */

test("groupEngineParams:refs 类型剔除;尺寸 chip 开启时 width/height 从画幅组剔除", () => {
  const params = [
    param("images", "images"),
    param("width"),
    param("height"),
    param("duration"),
    param("steps"),
    param("loras", "loras"),
    param("negative", "textarea"),
  ];
  const withChip = groupEngineParams(params, { sizeChip: true });
  assert.deepEqual(withChip.frame.map((p) => p.key), ["duration"], "chip 吸附后画幅组只剩 duration");
  assert.deepEqual(withChip.sampling.map((p) => p.key), ["steps"]);
  assert.deepEqual(withChip.lora.map((p) => p.key), ["loras"]);
  assert.deepEqual(withChip.advanced.map((p) => p.key), ["negative"]);

  const noChip = groupEngineParams(params, { sizeChip: false });
  assert.deepEqual(noChip.frame.map((p) => p.key), ["width", "height", "duration"], "无 chip 时宽高留在画幅组");
});

test("groupEngineParams:组内保持注册表原顺序,不重排", () => {
  const params = [
    param("scheduler", "select"),
    param("ckpt_name", "text"),
    param("seed"),
    param("steps"),
  ];
  const g = groupEngineParams(params);
  assert.deepEqual(g.model.map((p) => p.key), ["scheduler", "ckpt_name"]);
  assert.deepEqual(g.sampling.map((p) => p.key), ["seed", "steps"]);
});

/* ── T1 ③ GenerateView 源码结构(面板头固定 + 标题唯一) ── */

test("GenerateView:面板头「参数台」+ 引擎名副标题,「生成参数」标题不重复(源码断言)", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes('<span className="generate-params-title">参数台</span>'), "面板头应为「参数台」");
  assert.ok(src.includes("generate-params-sub"), "缺引擎名副标题");
  assert.ok(src.includes('aria-label="参数台"'), "aside aria-label 未同步为参数台");
  assert.ok(!src.includes(">生成参数</span>"), "旧「生成参数」大标题残留");
  assert.ok(
    !src.includes('<h3 className="params-section-title">生成参数</h3>'),
    "面板内「生成参数」分节标题与面板头重复,应随分组化移除",
  );
});

test("GenerateView:滚动区迁移 .generate-params-body,头部在滚动区外(源码断言)", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes('className="generate-params-body"'), "缺浮板滚动区容器");
  const iHead = src.indexOf('className="generate-params-head"');
  const iBody = src.indexOf('className="generate-params-body"');
  assert.ok(iHead > 0 && iBody > iHead, "头部必须先于滚动区(固定在滚动区外)");
  const iBodyEnd = src.indexOf("</aside>");
  assert.ok(src.lastIndexOf("</div>", iBodyEnd) > iBody, "滚动区容器须在 aside 内闭合");
  assert.ok(src.includes("PARAM_PANEL_GROUPS"), "分组渲染未接 PARAM_PANEL_GROUPS");
});

/* ── T2 ④⑤ 引擎说明卡 ── */

test("EngineInfoCard:description/出处/参数个数全透出,url 新窗口 noopener(静态渲染)", () => {
  const eng = engine("ltx25-t2v", {
    label: "LTX 2.5 文生视频",
    description: "音画同出,8 步快速出片",
    params: [param("width"), param("height"), param("steps")],
    source: {
      name: "LTX-2.5 22B Distilled",
      url: "https://huggingface.co/Lightricks/LTX-Video",
      author: "Lightricks",
      note: "nvfp4 蒸馏 transformer",
    },
  });
  const html = renderToStaticMarkup(h(EngineInfoCard, { engine: eng }));
  assert.ok(html.includes("engine-info-card"), "缺卡容器类");
  assert.ok(html.includes("LTX 2.5 文生视频"), "引擎名缺失");
  assert.ok(html.includes("3 项参数"), "参数个数概览缺失");
  assert.ok(html.includes("音画同出,8 步快速出片"), "description 缺失");
  assert.ok(html.includes('href="https://huggingface.co/Lightricks/LTX-Video"'), "出处外链缺失");
  assert.ok(html.includes('target="_blank"'), "外链须新窗口");
  assert.ok(html.includes('rel="noopener noreferrer"'), "外链须 noopener");
  assert.ok(html.includes("Lightricks"), "出品方缺失");
  assert.ok(html.includes("nvfp4 蒸馏 transformer"), "note 缺失");
});

test("EngineInfoCard:无 description/source 兜底不渲染对应块;source 无 url 时纯文本", () => {
  const bare = engine("x", { label: "裸引擎", params: [] });
  const html = renderToStaticMarkup(h(EngineInfoCard, { engine: bare }));
  assert.ok(html.includes("0 项参数"), "参数个数兜底缺失");
  assert.ok(!html.includes("engine-info-desc"), "无 description 不得渲染描述块");
  assert.ok(!html.includes("engine-info-source"), "无 source 不得渲染出处块");

  const noUrl = engine("y", {
    label: "无链引擎",
    source: { name: "内部模型", url: "", author: "ToIV" },
  });
  const html2 = renderToStaticMarkup(h(EngineInfoCard, { engine: noUrl }));
  assert.ok(!html2.includes("<a"), "无 url 不得渲染链接");
  assert.ok(html2.includes("内部模型"), "出处名纯文本兜底缺失");
});

/* ── T3 ⑥⑦⑧ 快速开始卡 ── */

const VIDEO_ENGINES: EngineInfo[] = [
  engine("ltx25-t2v", { label: "LTX 2.5 文生视频" }),
  engine("h3-t2v", { label: "MiniMax H3 文生视频" }),
  engine("longcat-t2v", { label: "LongCat 文生视频" }),
];

test("QuickStartGrid:视频 3 卡 + 区标题 + at-card 语言(静态渲染)", () => {
  const html = renderToStaticMarkup(
    h(QuickStartGrid, { kind: "video", engines: VIDEO_ENGINES, onPick: () => {} }),
  );
  assert.ok(html.includes("快速开始"), "缺区标题");
  assert.equal((html.match(/quick-start-card/g) ?? []).length, 3, "视频视图应 3 张卡");
  assert.ok(html.includes("at-card"), "卡未走 at-card 发夹线语言");
  assert.ok(html.includes("LTX 2.5 文生视频") && html.includes("MiniMax H3") && html.includes("LongCat"));
  assert.ok(html.includes("音画同出,8 步快速出片"), "卡文案缺失");
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), "禁 emoji(图标走 Icon/lucide)");
});

test("QuickStartGrid:图像 2 卡 / 音频 1 卡(静态渲染)", () => {
  const img = renderToStaticMarkup(
    h(QuickStartGrid, {
      kind: "image",
      engines: [engine("txt2img", { kind: "image" }), engine("img2img", { kind: "image" })],
      onPick: () => {},
    }),
  );
  assert.equal((img.match(/quick-start-card/g) ?? []).length, 2, "图像视图应 2 张卡");
  assert.ok(img.includes("文生图") && img.includes("图生图"));
  const aud = renderToStaticMarkup(
    h(QuickStartGrid, { kind: "audio", engines: [engine("ace-music", { kind: "audio" })], onPick: () => {} }),
  );
  assert.equal((aud.match(/quick-start-card/g) ?? []).length, 1, "音频视图应 1 张卡");
});

/** 直调组件取元素树(组件无 hooks),抽出台内按钮列表。 */
function cardButtons(el: unknown): Array<{ props: Record<string, unknown> }> {
  const root = el as { props: { children?: unknown } } | null;
  assert.ok(root, "组件应返回元素树");
  const children = root.props.children as Array<{ props: { className?: string; children?: unknown } }>;
  const grid = children.find((c) => (c.props.className ?? "").includes("quick-start-grid"));
  assert.ok(grid, "缺卡栅格");
  return grid.props.children as Array<{ props: Record<string, unknown> }>;
}

test("QuickStartGrid:点击卡回调 onPick 透传对应 engineId(元素树直调)", () => {
  const picked: string[] = [];
  const tree = QuickStartGrid({ kind: "video", engines: VIDEO_ENGINES, onPick: (id) => picked.push(id) });
  const buttons = cardButtons(tree);
  assert.equal(buttons.length, 3);
  buttons.forEach((btn, i) => {
    assert.equal(btn.props.type, "button", "卡必须是 type=button(ui_lint 门禁)");
    (btn.props.onClick as () => void)();
    assert.equal(picked[i], QUICK_START_DEFS.video[i].engineId, `第 ${i} 张卡回调 id 不符`);
  });
  assert.deepEqual(picked, ["ltx25-t2v", "h3-t2v", "longcat-t2v"]);
});

test("QuickStartGrid:可用性门控——null 不渲染 / 不在列表不渲染 / 不可用 disabled", () => {
  // 引擎列表加载中:整区不渲染(避免闪现)
  assert.equal(QuickStartGrid({ kind: "video", engines: null, onPick: () => {} }), null);
  // 策划卡引擎不在当前列表(如 R18 上下文过滤):整区不渲染
  assert.equal(
    QuickStartGrid({ kind: "video", engines: [engine("wan-nsfw-i2v")], onPick: () => {} }),
    null,
  );
  // 部分缺失 + 部分不可用:缺失卡不渲染,不可用卡 disabled 且 title 透出原因
  const tree = QuickStartGrid({
    kind: "video",
    engines: [
      engine("ltx25-t2v"),
      engine("h3-t2v", { available: false, unavailable_reason: "worker 离线" }),
      // longcat-t2v 缺席 → 卡不渲染
    ],
    onPick: () => {},
  });
  const buttons = cardButtons(tree);
  assert.equal(buttons.length, 2, "缺席引擎的卡不得渲染");
  assert.ok(!buttons[0].props.disabled, "可用卡不得 disabled");
  assert.equal(buttons[1].props.disabled, true, "不可用卡须 disabled(DOM 层屏蔽真实点击)");
  assert.ok(String(buttons[1].props.title).includes("worker 离线"), "不可用原因须透出到 title");
});

/* ── T3 ⑨ 接线(源码断言) ── */

test("ResultPanel 空态接 QuickStartGrid;GenerateView onQuickStart 切组+聚焦(源码断言)", () => {
  const panel = readSrc("components/generate/ResultPanel.tsx");
  assert.ok(panel.includes("QuickStartGrid"), "ResultPanel 未接入快速开始卡");
  assert.ok(panel.includes("onQuickStart"), "ResultPanel 缺 onQuickStart prop");
  // 空态分支内渲染(quick-start 引用须位于 empty-editorial 之后)
  const iEmpty = panel.indexOf("empty-editorial");
  const iQuick = panel.indexOf("<QuickStartGrid");
  assert.ok(iEmpty > 0 && iQuick > iEmpty, "快速开始卡须位于空态区内");

  const view = readSrc("components/generate/GenerateView.tsx");
  assert.ok(view.includes("function onQuickStart"), "GenerateView 缺 onQuickStart");
  assert.ok(
    view.includes('engineNeedsImage(target) === null ? "gen" : "edit"'),
    "快速开始未处理文生/图生跨组切换",
  );
  assert.ok(view.includes("promptInputRef.current?.focus()"), "快速开始未聚焦提示词框");
  assert.ok(view.includes("quickStartEngines={kindEngines}"), "卡可用性数据源应为 kindEngines(不按组过滤)");

  const bar = readSrc("components/generate/PromptBar.tsx");
  assert.ok(bar.includes("inputRef"), "PromptBar 缺 inputRef 外部聚焦句柄");
  assert.ok(bar.includes("if (inputRef) inputRef.current = el;"), "textarea 未向 inputRef 赋值");
});

/* ── ⑩ stage.css 样式存在性 + token 纪律 ── */

test("stage.css:Inspector/说明卡/快速开始全部新类名已定义", () => {
  const css = readSrc("app/styles/stage.css");
  for (const cls of [
    ".generate-params-body",
    ".generate-params-heading",
    ".generate-params-sub",
    ".engine-select-row",
    ".engine-info-btn",
    ".engine-info-pop",
    ".engine-info-card",
    ".engine-info-count",
    ".quick-start",
    ".quick-start-grid",
    ".quick-start-card",
    ".quick-start-icon",
  ]) {
    assert.ok(css.includes(cls), `stage.css 缺 ${cls} 定义`);
  }
  // 浮板本体不再滚动(头部固定修裁剪),滚动在 body
  const iPanel = css.indexOf(".generate-params {");
  const panelBlock = css.slice(iPanel, css.indexOf("\n}", iPanel));
  assert.ok(panelBlock.includes("overflow: hidden"), "浮板本体须 overflow:hidden(滚动在 body)");
  assert.ok(!panelBlock.includes("overflow-y: auto"), "浮板本体不得再整体滚动");
  // 说明卡浮层实底语言(覆盖 Popover 玻璃底)
  const iPop = css.indexOf(".engine-info-pop {");
  const popBlock = css.slice(iPop, css.indexOf("\n}", iPop));
  assert.ok(popBlock.includes("var(--bg-surface-1)"), "说明卡须实底 surface-1");
  assert.ok(popBlock.includes("var(--shadow-lg)"), "说明卡须 shadow-lg");
});

test("stage.css:全文件零 font-weight 数字字面值、零 hex 色值(token 纪律)", () => {
  const css = readSrc("app/styles/stage.css");
  assert.ok(!/font-weight:\s*[0-9]/.test(css), "font-weight 必须走 var(--font-*)");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), "stage.css 不得出现 hex 色值");
});
