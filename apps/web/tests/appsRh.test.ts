/**
 * RunningHub 化(2026-09-06)专项单测(node:test + 源码断言 + 纯函数):
 * ① 市场瀑布流:rh-grid CSS columns 5/4/3/2 + 卡片 break-inside;卡片封面/占位降级/作者行/▶用量
 * ② 详情页两栏:rh-runner-body 左参数右预览;折叠分区/数值 stepper/通栏「立即运行」/我的生成(app_id 过滤)
 * ③ 壳层段控:MarketView/详情顶条 rh-seg 荧光 pill
 * ④ 纯函数:normalizeApp cover_url/author 归一 / appAuthorOf 兜底 ToIV / groupAppParams 分组 / placeholderAspect
 * ⑤ 数据诚实:卡片只展示真实 usage_count,不造点赞/收藏
 * ⑥ 暗底作用域:.rh-dark 只挂市场/详情根节点,令牌覆盖仅在作用域内
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  appAuthorInitial,
  appAuthorOf,
  groupAppParams,
  normalizeApp,
  placeholderAspect,
  type AppParam,
} from "../lib/apps";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① 市场瀑布流 ── */

test("RH 市场:根节点挂 rh-dark 暗底作用域 + 瀑布流 rh-grid(CSS columns 6/5/4/2)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  const css = readSrc("app/styles/apps.css");
  assert.ok(src.includes('className="single-view apps-market rh-dark"'), "市场根节点缺 rh-dark 作用域");
  assert.ok(src.includes("apps-grid rh-grid"), "分区网格应挂 rh-grid 瀑布流");
  // 2026-09-06 紧凑化:5/4/3/2→6/5/4/2(列宽 ~214→~188px 级)
  assert.match(css, /\.rh-grid \{[\s\S]*?column-count: 6/, "宽档应为 6 列");
  assert.match(css, /max-width: 1599px[\s\S]*?column-count: 5/, "次宽档应为 5 列");
  assert.match(css, /max-width: 1199px[\s\S]*?column-count: 4/, "中档应为 4 列");
  assert.match(css, /max-width: 767px[\s\S]*?column-count: 2/, "窄档应为 2 列");
  assert.match(css, /\.rh-grid \{[\s\S]*?column-gap: var\(--grid-gutter-sm\)/, "gutter 应走紧凑档 --grid-gutter-sm");
  assert.match(css, /\.rh-grid \.apps-card \{[\s\S]*?break-inside: avoid/, "卡片须 break-inside:avoid 防跨列截断");
});

test("RH 卡片:封面充满整卡 + scrim 标题 + 作者行 + ▶ usage_count(源码)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  const css = readSrc("app/styles/apps.css");
  // 封面:cover_url 经 imageUrl 带 token;加载失败 onError 降级占位
  assert.ok(src.includes("imageUrl(a.cover_url"), "封面应走 imageUrl 带 token");
  assert.ok(src.includes("onError={() => setImgFailed(true)}"), "封面加载失败应降级占位");
  assert.ok(src.includes("rh-card-scrim"), "缺底部 scrim 叠层");
  assert.ok(src.includes("rh-card-name"), "缺标题");
  // 作者行:首字母圆头像 + 名字,author 空兜底 ToIV
  assert.ok(src.includes("rh-card-author"), "缺作者行");
  assert.ok(src.includes("rh-card-avatar"), "缺首字母圆头像");
  assert.ok(src.includes("appAuthorOf"), "作者兜底应复用 helper");
  // 用量:▶ 图标 + mono 数字(唯一真实运行数据)
  assert.ok(src.includes("rh-card-usage"), "缺用量位");
  assert.ok(src.includes('name="play"'), "用量应带 ▶ 图标");
  assert.match(css, /\.rh-card-usage[\s\S]*?margin-left: auto/, "用量应靠右对齐作者行");
  // hover:封面微放大 + 荧光描边 + 「运行」pill
  assert.ok(src.includes("rh-card-run"), "缺 hover「运行」pill");
  assert.match(css, /\.rh-card:hover \.rh-card-img[\s\S]*?scale\(1\.04\)/, "hover 封面应微放大");
  assert.match(css, /\.rh-card:hover \{[\s\S]*?border-color: var\(--rh-lime\)/, "hover 边框应转荧光绿");
  // fork/R18/我的 收进角落小标,不挤标题区
  assert.ok(src.includes("rh-card-badges"), "缺角落小标容器");
  assert.ok(src.includes("rh-card-fork"), "fork 应收进角落角钮");
});

test("RH 卡片占位封面:按 category 色相渐变 + 居中大图标 + id 散列高度档(瀑布流错落)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  const css = readSrc("app/styles/apps.css");
  assert.ok(src.includes('data-category={a.category}'), "封面应携带 category 供渐变分色相");
  assert.ok(src.includes("rh-card-placeholder-icon"), "缺占位大图标");
  assert.ok(src.includes("placeholderAspect(a.id)"), "占位封面应按 id 散列取高度档");
  for (const cat of ["image", "video", "audio", "edit", "3d"]) {
    assert.ok(
      css.includes(`.rh-card-cover[data-category="${cat}"]`),
      `缺 ${cat} 分类占位渐变`,
    );
  }
});

test("数据诚实:卡片只展示真实 usage_count,不造点赞/收藏", () => {
  // 剥注释后再查(本测试名与组件 docstring 都含这些词,注释不算 UI 文案)
  const src = readSrc("components/apps/AppMarketView.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/点赞|收藏|likes|favorites/i.test(src), "不应出现点赞/收藏(无数据不造假)");
  assert.ok(src.includes("a.usage_count"), "用量应取真实 usage_count");
});

/* ── ② 详情页两栏 ── */

test("RH 详情:rh-dark + 两栏(左 rh-params 340px / 右 rh-preview)+ 顶条 rh-seg 保留简洁/工作流", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  const css = readSrc("app/styles/apps.css");
  assert.ok(src.includes('className="single-view apps-runner rh-dark"'), "详情根节点缺 rh-dark");
  assert.ok(src.includes("rh-runner-body"), "缺两栏容器");
  assert.ok(src.includes("rh-params"), "缺左参数列");
  assert.ok(src.includes("rh-preview"), "缺右预览列");
  // 2026-09-06 紧凑化:380→340
  assert.match(css, /grid-template-columns: 340px minmax\(0, 1fr\)/, "宽屏应为 340px + 弹性两栏");
  assert.match(css, /max-width: 1023px[\s\S]*?\.rh-runner-body[\s\S]*?minmax\(0, 1fr\)/, "窄屏应纵向堆叠");
  // 「简洁/工作流」段控保留在顶条,工作流 = AppWorkflowGraph 画布
  assert.ok(src.includes('"simple", "简洁"'), "缺简洁段");
  assert.ok(src.includes('"workflow", "工作流"'), "缺工作流段");
  assert.ok(src.includes("AppWorkflowGraph"), "工作流模式应保留既有画布");
  assert.ok(src.includes("at-seg rh-seg"), "顶条段控应叠 rh-seg 荧光 pill");
});

test("RH 详情参数列:折叠分区(荧光标题+chevron)+ 数值 stepper + 通栏「立即运行」", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  const css = readSrc("app/styles/apps.css");
  // 分组渲染(复用 ParamField,包 RH 分区)
  assert.ok(src.includes("groupAppParams(app.params_schema)"), "参数应按 groupAppParams 分组");
  assert.ok(src.includes("RhParamSection"), "缺折叠分区组件");
  assert.ok(src.includes("aria-expanded"), "分区头应有展开语义");
  assert.ok(src.includes('name="chevron-down"'), "分区头应有 chevron");
  assert.match(css, /\.rh-section-title \{[\s\S]*?color: var\(--rh-lime\)/, "分区标题应荧光绿");
  // 数值 −/+ stepper(其余类型仍 ParamField)
  assert.ok(src.includes("RhNumberField"), "缺数值 stepper 组件");
  assert.ok(src.includes("rh-stepper"), "缺 stepper 结构");
  assert.ok(src.includes('p.type === "number"'), "number 类型应分流到 stepper");
  assert.ok(src.includes("<ParamField"), "其余类型仍复用 ParamField");
  // 底部通栏荧光大按钮
  assert.ok(src.includes("rh-run-btn"), "缺通栏运行大按钮");
  assert.ok(src.includes("立即运行"), "缺「立即运行」文案");
  assert.match(css, /\.rh-run-btn \{[\s\S]*?width: 100%/, "运行按钮应通栏");
  assert.match(css, /\.rh-run-btn \{[\s\S]*?background: var\(--rh-lime\)/, "运行按钮应荧光绿");
  // 运行状态仍在按钮区
  assert.ok(src.includes("apps-run-status"), "缺运行状态行");
});

test("RH 详情右列:封面预览(占位降级)+「我的生成」按 app_id 过滤历史 Job", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes("rh-preview-cover"), "缺预览大卡");
  assert.ok(src.includes("imageUrl(app.cover_url)"), "预览封面应走 imageUrl");
  assert.ok(src.includes("placeholderAspect(app.id)"), "预览占位同样按 id 散列高度");
  assert.ok(src.includes("我的生成"), "缺「我的生成」区");
  assert.ok(src.includes("listJobs"), "历史应复用作品库 listJobs(SWR)");
  assert.ok(
    src.includes("j.app_id === app.id") && src.includes('j.status === "done"'),
    "历史应按 app_id + done 过滤",
  );
  // 本次运行结果与历史共用同一结果格组件
  assert.ok(src.includes("ResultTile"), "结果格应抽公共组件");
  assert.ok(src.includes("mediaKindOf(p, app.output_kind)"), "产物仍按 output_kind 分流渲染");
});

/* ── ③ 壳层段控 ── */

test("RH 壳层:MarketView 段控叠 rh-seg(荧光 pill)且引入 apps.css", () => {
  const src = readSrc("components/market/MarketView.tsx");
  assert.ok(src.includes("at-seg rh-seg"), "壳层段控缺 rh-seg");
  assert.ok(src.includes('import "@/app/styles/apps.css"'), "壳层应自引 apps.css(skills tab 下不经过 AppMarketView)");
  const css = readSrc("app/styles/apps.css");
  assert.match(css, /\.rh-seg \.at-seg-btn\.is-active \{[\s\S]*?background: var\(--rh-lime\)/, "激活项应荧光 pill");
  assert.match(css, /\.rh-seg \.at-seg-btn\.is-active \{[\s\S]*?color: var\(--rh-on-lime\)/, "激活项应黑字");
});

/* ── ④ 纯函数 ── */

test("normalizeApp:cover_url/author 宽容归一(空串/缺省 → null)", () => {
  const full = normalizeApp({
    id: "a1",
    name: "测试",
    cover_url: " /api/files/cover.png ",
    author: " 某作者 ",
  });
  assert.equal(full.cover_url, "/api/files/cover.png", "cover_url 应去空白保留");
  assert.equal(full.author, "某作者", "author 应去空白保留");
  const bare = normalizeApp({ id: "a2", name: "裸" });
  assert.equal(bare.cover_url, null, "缺省 cover_url 应为 null");
  assert.equal(bare.author, null, "缺省 author 应为 null");
  const blank = normalizeApp({ id: "a3", name: "空串", cover_url: "  ", author: "" });
  assert.equal(blank.cover_url, null, "空串 cover_url 应为 null(走占位降级)");
  assert.equal(blank.author, null, "空串 author 应为 null(兜底 ToIV)");
});

test("appAuthorOf/appAuthorInitial:author 空兜底「ToIV」,首字符大写", () => {
  assert.equal(appAuthorOf({ author: null }), "ToIV");
  assert.equal(appAuthorOf({ author: "RunningHub" }), "RunningHub");
  assert.equal(appAuthorInitial({ author: null }), "T");
  assert.equal(appAuthorInitial({ author: "runninghub" }), "R");
  assert.equal(appAuthorInitial({ author: "某作者" }), "某");
});

test("groupAppParams:素材/提示词/生成参数三档固定序,空组剔除", () => {
  const P = (key: string, type: AppParam["type"]): AppParam => ({ key, label: key, type, default: null });
  const groups = groupAppParams([
    P("steps", "number"),
    P("prompt", "textarea"),
    P("image", "images"),
    P("mode", "select"),
    P("audio", "audio"),
  ]);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["media", "prompt", "gen"],
    "分组顺序应为 素材上传→提示词→生成参数",
  );
  assert.deepEqual(groups[0].params.map((p) => p.key), ["image", "audio"]);
  assert.deepEqual(groups[1].params.map((p) => p.key), ["prompt"]);
  assert.deepEqual(groups[2].params.map((p) => p.key), ["steps", "mode"]);
  // 空组剔除:纯文本应用只剩提示词组
  const onlyText = groupAppParams([P("prompt", "textarea")]);
  assert.deepEqual(onlyText.map((g) => g.key), ["prompt"]);
});

test("placeholderAspect:4 档宽高比 + 按 id 确定性", () => {
  const ARS = new Set(["1 / 1", "4 / 5", "3 / 4", "5 / 4"]);
  for (const id of ["a", "h3-t2v", "rh-123", "wan-vace", "xyz-999"]) {
    assert.ok(ARS.has(placeholderAspect(id)), `${id} 应落在 4 档内`);
    assert.equal(placeholderAspect(id), placeholderAspect(id), "同一 id 应稳定同档");
  }
});

/* ── ⑤ 暗底作用域纪律 ── */

test("rh-dark 令牌覆盖只在作用域内:不影响全站亮/暗主题", () => {
  const css = readSrc("app/styles/apps.css");
  const block = css.slice(css.indexOf("/* RH-ACCENT-BEGIN"), css.indexOf("/* RH-ACCENT-END */"));
  assert.ok(block.includes("--rh-lime: #c9f24f"), "荧光绿唯一事实源应在标记块");
  assert.ok(block.includes("--rh-bg: #0b0d10"), "深黑底应在标记块");
  // 全站 token 覆盖必须写在 .rh-dark 作用域块内(不在 :root / 裸选择器)
  assert.ok(block.includes("--bg-canvas: var(--rh-bg)"), "暗底应经 token 覆盖让子组件继承");
  const globals = readSrc("app/globals.css");
  assert.ok(!globals.includes("--rh-lime"), "rh 令牌不得进 globals.css(作用域纪律)");
});
