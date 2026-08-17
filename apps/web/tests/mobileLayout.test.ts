/**
 * 移动端排版专项(2026-08-16 真机 390×844 审计驱动,Team D)单测(node:test,纯源码断言):
 * ① stage.css ≤1023:参数抽屉抬底让开底导航 / FAB 提权 fixed(抗 .ui-ripple 顺序压制)
 *   / 抽屉可滚 / 提示词条 sticky / 抽屉收起钮·chips·高级参数头 44px 触控目标
 * ② library.css ≤767:过滤行横滑 + 两端渐隐 mask / 页头紧凑(副标题隐藏·标题降档)
 *   / chips·段控·搜索框 44px / 勾选圈·操作钮 ::before 命中域外扩
 * ③ assistant.css ≤767 + AssistantView:模型徽章文本收进 .av-model-name 真省略截断,
 *   徽章收缩让位、操作钮不缩(替代 132px 硬裁残字)
 * ④ 桌面规则守护:本次全部改动封在移动断点块内,桌面基座规则零改动
 * ⑤ 移动断点块内零 hex(铁律;mask 渐隐只用 black 关键字,alpha 通道生效)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/** 提取 @media 块文本(花括号配对,支持嵌套规则)。 */
function mediaBlock(css: string, query: string): string {
  const i = css.indexOf(`@media ${query}`);
  assert.ok(i >= 0, `缺 ${query} 断点块`);
  const start = css.indexOf("{", i);
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") {
      depth--;
      if (depth === 0) return css.slice(start + 1, j);
    }
  }
  throw new Error(`断点块未闭合: ${query}`);
}

/** 提取某段文本内指定规则声明体(selector 须带「 {」后缀防前缀误配,如 .lib-chip 吃 .lib-chip--sm)。 */
function ruleBody(scope: string, selectorBrace: string): string {
  const i = scope.indexOf(selectorBrace);
  assert.ok(i >= 0, `缺规则 ${selectorBrace}`);
  const start = scope.indexOf("{", i);
  const end = scope.indexOf("}", start);
  return scope.slice(start + 1, end);
}

const stage = readSrc("app/styles/stage.css");
const library = readSrc("app/styles/library.css");
const assistant = readSrc("app/styles/assistant.css");
const assistantView = readSrc("components/assistant/AssistantView.tsx");

const stageNarrow = mediaBlock(stage, "(max-width: 1023px)");
const libMobile = mediaBlock(library, "(max-width: 767px)");
const avMobile = mediaBlock(assistant, "(max-width: 767px)");

/* ── ① stage.css:参数面板抽屉化 ── */

test("stage ≤1023:参数抽屉 fixed 贴底,抬底让开底导航(--bottomnav-h),内容可滚", () => {
  const body = ruleBody(stageNarrow, ".generate-params {");
  assert.ok(body.includes("position: fixed"), "抽屉须 fixed 脱离流(实测流内被拉全宽)");
  assert.ok(
    body.includes("bottom: calc(var(--bottomnav-h) + var(--space-3))"),
    "抽屉底缘须抬过 52px 底导航(实测 bottom=834 被 nav top=792 遮挡)",
  );
  assert.ok(body.includes("max-height: 60vh"), "抽屉限高 60vh");
  // 2026-08-17 Inspector 化:滚动自抽屉本体移到 .generate-params-body(头部「参数台」固定,
  // 根除内容超高时标题被卷出可视区切半个字);抽屉本体不得再 overflow-y:auto
  assert.ok(!body.includes("overflow-y: auto"), "抽屉本体不再滚动(滚动在 body,头部固定)");
  const scroll = ruleBody(stage, ".generate-params-body {");
  assert.ok(scroll.includes("overflow-y: auto"), "抽屉内容经 .generate-params-body 滚动");
});

test("stage ≤1023:FAB 提权 .generate-view .generate-params-fab,fixed 右缘锚定", () => {
  // 根因:effects.css .ui-ripple{position:relative} 同源晚到,单类平级被压回相对定位
  // (实测宿主 w=370/x=0 贴左缘);双类 (0,2,0) 与源码顺序解耦
  const body = ruleBody(stageNarrow, ".generate-view .generate-params-fab {");
  assert.ok(body.includes("position: fixed"), "FAB 须 fixed");
  assert.ok(body.includes("right: var(--space-3)"), "FAB 锚定右缘");
  assert.ok(body.includes("z-index: var(--z-stage-mask)"), "FAB 抬升档");
});

test("stage ≤1023:主路径首屏可达——舞台 72vh + 提示词条 sticky 沉底", () => {
  const results = ruleBody(stageNarrow, ".generate-results {");
  assert.ok(results.includes("height: 72vh"), "舞台占首屏主体");
  const dock = ruleBody(stageNarrow, ".promptbar-dock {");
  assert.ok(dock.includes("position: sticky") && dock.includes("bottom: 0"), "提示词条 sticky 沉底常显");
});

test("stage ≤1023:触控目标 ≥44px(抽屉收起钮 / 引擎说明 ⓘ / 提示词条 chips / 高级参数折叠头)", () => {
  assert.ok(ruleBody(stageNarrow, ".generate-params-close {").includes("width: var(--touch-target)"));
  assert.ok(ruleBody(stageNarrow, ".engine-info-btn {").includes("width: var(--touch-target)"));
  assert.ok(ruleBody(stageNarrow, ".promptbar-chip {").includes("height: var(--touch-target)"));
  assert.ok(ruleBody(stageNarrow, ".adv-params summary {").includes("min-height: var(--touch-target)"));
});

/* ── ② library.css:过滤行横滑渐隐 + 页头紧凑 + 触控目标 ── */

test("library ≤767:过滤行横滑 overflow-x:auto + 两端渐隐 mask 指示", () => {
  const body = ruleBody(libMobile, ".lib-toolbar {");
  assert.ok(body.includes("overflow-x: auto"), "工具条单行横滚");
  assert.ok(body.includes("flex-wrap: nowrap"), "不换行才需要渐隐指示");
  assert.ok(body.includes("-webkit-mask-image: linear-gradient("), "缺 WebKit 渐隐 mask");
  assert.ok(body.includes("mask-image: linear-gradient("), "缺标准渐隐 mask");
  assert.ok(
    body.includes("black var(--space-5)") && body.includes("black calc(100% - var(--space-5))"),
    "渐隐须两端对称(black 关键字仅取 alpha,零 hex)",
  );
});

test("library ≤767:页头紧凑——副标题隐藏、标题降档、间距收紧", () => {
  assert.ok(
    ruleBody(libMobile, ".library-view .page-header-desc {").includes("display: none"),
    "副标题移动端隐藏",
  );
  assert.ok(
    ruleBody(libMobile, ".library-view .page-header-title {").includes("font-size: var(--text-title)"),
    "标题 display-md 降档 title",
  );
  const head = ruleBody(libMobile, ".library-view .page-header {");
  assert.ok(head.includes("margin-bottom: 0") && head.includes("padding-bottom: var(--space-2)"), "页头间距收紧");
});

test("library ≤767:触控目标 ≥44px(chips / 段控 / 搜索框)", () => {
  assert.ok(ruleBody(libMobile, ".lib-chip {").includes("height: var(--touch-target)"), "类型 chips 44px");
  assert.ok(ruleBody(libMobile, ".lib-chip--sm {").includes("height: var(--touch-target)"), "分级 chips 44px");
  const seg = ruleBody(libMobile, ".lib-seg-btn {");
  assert.ok(seg.includes("min-height: var(--touch-target)") && seg.includes("min-width: var(--touch-target)"), "段控 44×44");
  assert.ok(ruleBody(libMobile, ".lib-search-input {").includes("height: var(--touch-target)"), "搜索框 44px");
});

test("library ≤767:勾选圈/卡片操作钮 ::before 透明命中域外扩至 ≥44px(视觉尺寸不变)", () => {
  assert.ok(ruleBody(libMobile, ".lib-check::before {").includes("inset: -8px"), "28+8×2=44 命中域");
  assert.ok(ruleBody(libMobile, ".lib-action-btn::before {").includes("inset: -6px"), "32+6×2=44 命中域");
  // 视觉尺寸保持(紧凑双列拇指图容不下 4×44 实体钮)
  assert.ok(ruleBody(libMobile, ".lib-check {").includes("width: 28px"), "勾选圈视觉 28px 不变");
  assert.ok(ruleBody(libMobile, ".lib-action-btn {").includes("width: 32px"), "操作钮视觉 32px 不变");
});

/* ── ③ assistant:顶栏模型徽章省略截断 ── */

test("assistant ≤767:徽章收缩让位 + .av-model-name 真省略截断,操作钮不缩", () => {
  const pill = ruleBody(avMobile, ".av-view .av-model-pill {");
  assert.ok(pill.includes("min-width: 0") && pill.includes("flex-shrink: 1"), "徽章可收缩");
  assert.ok(pill.includes("max-width: 46vw"), "徽章上限 46vw(行内三钮 3×44 恒放得下)");
  const name = ruleBody(avMobile, ".av-view .av-model-name {");
  assert.ok(name.includes("text-overflow: ellipsis") && name.includes("overflow: hidden"), "长模型名省略号截断");
  assert.ok(ruleBody(avMobile, ".av-view .av-tb-btn {").includes("flex-shrink: 0"), "操作钮 44px 不缩");
});

test("AssistantView:模型名包进 .av-model-name 元素(flex 匿名文本节点无法省略截断)", () => {
  const count = (assistantView.match(/av-model-name/g) ?? []).length;
  assert.ok(count >= 3, `顶栏+设置面板两处徽章均须包 span(class 引用 ≥3,实测 ${count})`);
  assert.ok(
    assistantView.includes('<span className="av-model-name">{modelName}</span>'),
    "模型名须收进 .av-model-name span",
  );
});

/* ── ④ 桌面规则守护:改动全部封在移动断点内 ── */

test("桌面基座零改动:stage FAB 基座仍 absolute、library 工具条基座无 mask、assistant 徽章无移动规则", () => {
  const stageDesktop = stage.slice(0, stage.indexOf("@media (max-width: 1023px)"));
  assert.ok(
    ruleBody(stageDesktop, ".generate-params-fab {").includes("position: absolute"),
    "桌面 FAB 基座 absolute 不得动",
  );
  const libDesktop = library.slice(0, library.indexOf("@media (max-width: 767px)"));
  assert.ok(!ruleBody(libDesktop, ".lib-toolbar {").includes("mask-image"), "桌面工具条不得有渐隐 mask");
  const avDesktop = assistant.slice(0, assistant.indexOf("@media (max-width: 767px)"));
  assert.ok(!avDesktop.includes("av-model-name"), "assistant 桌面区不得出现移动徽章规则");
});

/* ── ⑤ 移动断点块内零 hex(铁律)── */

test("三个移动断点块内零 hex 色值(mask 渐隐走 black 关键字)", () => {
  for (const [name, block] of [
    ["stage ≤1023", stageNarrow],
    ["library ≤767", libMobile],
    ["assistant ≤767", avMobile],
  ] as const) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), `${name} 断点块内不得出现 hex 色值`);
  }
});
