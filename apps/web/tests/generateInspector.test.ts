/**
 * 生成工作台「专业创作台」重构(2026-08-17,T1/T2)防回归单测(node:test):
 * T1 参数面板 Inspector 化:
 *   ① groupEngineParam 归类(模型与引擎/画幅与时长/采样/LoRA 叠加/参考输入/高级兜底)
 *   ② groupEngineParams 分组(尺寸 chip 剔除 width/height;未知 key 落高级;保持注册表顺序)
 *   ③ GenerateView 源码:头部「参数台」标题唯一 + 滚动区迁移 .generate-params-body(修顶部裁剪)
 * T2 引擎说明卡:
 *   ④ EngineInfoCard 静态渲染:description/出处(name/url/author/note)/参数个数,url 新窗口 noopener
 *   ⑤ 缺 description/source 时对应块不渲染(兜底)
 * 空态(2026-08-31 Studio Console v1):
 *   ⑥ T3 快速开始卡/步骤卡/英雄区整套退役(QuickStartGrid 组件删除),空态只余单行
 *     muted 提示(.empty-console-hint);PromptBar inputRef 外部聚焦句柄保留
 * ⑦ stage.css 样式存在性:新类名齐全;全文件零 font-weight 数字 / 零 hex 硬编码
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EngineInfoCard } from "../components/generate/EngineInfoCard";
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
  assert.equal(groupEngineParam(param("segment_extend", "switch")), "frame", "segment_extend");
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
  const eng = engine("ltx-nsfw-t2v", {
    label: "LTX 2.3 文生视频(R18)",
    description: "音画同出,8 步快速出片",
    params: [param("width"), param("height"), param("steps")],
    source: {
      name: "LTX-2.3 22B Distilled",
      url: "https://huggingface.co/Lightricks/LTX-Video",
      author: "Lightricks",
      note: "nvfp4 蒸馏 transformer",
    },
  });
  const html = renderToStaticMarkup(h(EngineInfoCard, { engine: eng }));
  assert.ok(html.includes("engine-info-card"), "缺卡容器类");
  assert.ok(html.includes("LTX 2.3 文生视频(R18)"), "引擎名缺失");
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

/* ── 空态(2026-08-31 Studio Console v1:T3 快速开始卡/步骤卡/英雄区整套退役) ── */

test("ResultPanel 空态:单行 muted 提示,快速开始卡/英雄区已退役(源码断言)", () => {
  const panel = readSrc("components/generate/ResultPanel.tsx");
  assert.ok(panel.includes("empty-console-hint"), "空态缺单行 muted 提示");
  assert.ok(!panel.includes("QuickStartGrid"), "ResultPanel 不应再接快速开始卡");
  assert.ok(!panel.includes("empty-editorial"), "空态英雄区应已退役");

  const view = readSrc("components/generate/GenerateView.tsx");
  assert.ok(!view.includes("onQuickStart"), "GenerateView 不应再有 onQuickStart");

  const bar = readSrc("components/generate/PromptBar.tsx");
  assert.ok(bar.includes("inputRef"), "PromptBar 缺 inputRef 外部聚焦句柄");
  assert.ok(bar.includes("if (inputRef) inputRef.current = el;"), "textarea 未向 inputRef 赋值");
});

/* ── ⑩ stage.css 样式存在性 + token 纪律 ── */

test("stage.css:Inspector/说明卡/空态提示全部新类名已定义", () => {
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
    ".empty-console-hint",
  ]) {
    assert.ok(css.includes(cls), `stage.css 缺 ${cls} 定义`);
  }
  // 快速开始卡样式应已随 Studio Console v1 退役
  assert.ok(!css.includes(".quick-start"), "stage.css 不应再有 quick-start 样式");
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

test("ParamField LoRA: Off sends empty array, cap 3, auto is null", () => {
  const src = readFileSync(join(webRoot, "components/generate/ParamField.tsx"), "utf-8");
  assert.ok(src.includes("LORA_CAP"), "must cap checkbox picker");
  assert.ok(src.includes("set([])"), "Off must set empty array");
  assert.ok(src.includes("set(null)"), "Auto must set null");
  assert.ok(src.includes("关闭"), "explicit Off control");
});
