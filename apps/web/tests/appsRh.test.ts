/**
 * RunningHub 化(2026-09-06)专项单测(node:test + 源码断言 + 纯函数):
 * ① 市场瀑布流:rh-grid 稳定多列 DOM 6/5/4/2 + 卡片 break-inside;卡片封面/占位降级/作者行/▶用量
 * ② 详情落地:左封面右 meta+CTA;节点信息;admin 出处;打开应用后 rh-runner-body 左参数右预览
 * ③ 壳层段控:MarketView/详情顶条 rh-seg 荧光 pill
 * ④ 纯函数:normalizeApp cover_url/author 归一 / appAuthorOf 兜底 ToIV / groupAppParams 分组 / placeholderAspect
 * ⑤ 数据诚实:卡片只展示真实 usage_count,不造点赞/收藏
 * ⑥ 主题化作用域(2026-09-07):.rh-dark 只挂市场/详情根节点,rh-* 令牌全映射
 *    全站主题令牌(cinema 主题 = RunningHub 观感),荧光绿色值唯一事实源在 globals.css
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  appAuthorInitial,
  appAuthorOf,
  extractRhWebappId,
  groupAppParams,
  normalizeApp,
  placeholderAspect,
  sortAppsHot,
  summarizeWorkflowNodes,
  type AppParam,
} from "../lib/apps";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① 市场瀑布流 ── */

test("RH 市场:根节点挂 rh-dark 暗底作用域 + 瀑布流 rh-grid(稳定多列 6/5/4/2)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  const css = readSrc("app/styles/apps.css");
  assert.ok(src.includes('className="single-view apps-market rh-dark"'), "市场根节点缺 rh-dark 作用域");
  assert.ok(src.includes("apps-grid rh-grid"), "分区网格应挂 rh-grid 瀑布流");
  assert.ok(src.includes("rh-col"), "应渲染稳定列容器 rh-col");
  assert.ok(src.includes("distributeStableColumns"), "应使用稳定列分配");
  assert.ok(src.includes("data-cols"), "应暴露 data-cols 列数");
  // 断点档位仍 6/5/4/2(JS matchMedia + data-cols 标记)
  assert.match(css, /data-cols="6"/, "宽档应为 6 列标记");
  assert.match(css, /data-cols="5"/, "次宽档应为 5 列标记");
  assert.match(css, /data-cols="4"/, "中档应为 4 列标记");
  assert.match(css, /data-cols="2"/, "窄档应为 2 列标记");
  assert.ok(src.includes("max-width: 1599px"), "次宽断点 1599 应在源码");
  assert.ok(src.includes("max-width: 1199px"), "中档断点 1199 应在源码");
  assert.ok(src.includes("max-width: 767px"), "窄档断点 767 应在源码");
  assert.match(css, /\.rh-grid \{[\s\S]*?column-gap: var\(--grid-gutter/, "gutter 应走 --grid-gutter(RH 卡距)");
  assert.match(css, /\.rh-grid \.apps-card[\s\S]*?break-inside: avoid/, "卡片须 break-inside:avoid 防跨列截断");
  assert.match(css, /\.rh-grid \.rh-col/, "CSS 应定义 rh-col 列容器");
  assert.match(css, /\.apps-grid\.rh-grid/, "应用网格应双类压过 .apps-grid display:grid");
  assert.match(css, /\.rh-col:empty/, "空列须 :empty 不占位,防左侧大空白");
  assert.ok(src.includes("ResizeObserver"), "列数应跟容器宽度 ResizeObserver");
  assert.ok(src.includes("firstFilled"), "前导空列应强制重分");
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

test("RH 详情落地:左大封面 + 右 meta/CTA(打开应用·打开工作流)+ 节点信息 + admin 出处", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  const css = readSrc("app/styles/apps.css");
  assert.ok(src.includes('className="single-view apps-runner rh-dark"'), "详情根节点缺 rh-dark");
  assert.ok(src.includes('phase === "detail"') || src.includes('phase === \'detail\''), "缺详情 phase");
  assert.ok(src.includes("rh-detail-hero"), "缺详情 hero");
  assert.ok(src.includes("rh-detail-cover"), "缺左大封面");
  assert.ok(src.includes("打开应用"), "缺「打开应用」CTA");
  assert.ok(src.includes("打开工作流"), "缺「打开工作流」CTA");
  assert.ok(src.includes("openAppWorkflowInComfy"), "打开工作流应走 open-in-Comfy");
  assert.ok(src.includes("节点信息"), "缺节点信息区");
  assert.ok(src.includes("summarizeWorkflowNodes"), "节点信息应解析 graph");
  assert.ok(src.includes("isAdmin"), "出处应 admin 门控");
  assert.ok(src.includes("extractRhWebappId"), "admin 出处应解析 RH webappId");
  assert.ok(src.includes("出处（仅管理员）") || src.includes("出处(仅管理员)"), "缺 admin 出处标题");
  assert.match(css, /\.rh-detail-hero \{[\s\S]*?grid-template-columns:/, "详情 hero 应为网格两栏");
  assert.match(css, /\.rh-detail-cta--primary \{[\s\S]*?background: var\(--rh-lime\)/, "主 CTA 应走主题 accent 令牌");
});

test("RH 详情:打开应用后两栏运行台(左 rh-params 340px / 右 rh-preview);无简洁/工作流段控", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  const css = readSrc("app/styles/apps.css");
  assert.ok(src.includes("rh-runner-body"), "缺两栏容器");
  assert.ok(src.includes("rh-params"), "缺左参数列");
  assert.ok(src.includes("rh-preview"), "缺右预览列");
  assert.match(css, /grid-template-columns: 340px minmax\(0, 1fr\)/, "宽屏应为 340px + 弹性两栏");
  assert.match(css, /max-width: 1023px[\s\S]*?\.rh-runner-body[\s\S]*?minmax\(0, 1fr\)/, "窄屏应纵向堆叠");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!code.includes('"simple", "简洁"'), "打开应用后不应再有简洁段控");
  assert.ok(!code.includes('"workflow", "工作流"'), "打开应用后不应再有工作流段控");
  assert.ok(!code.includes("AppWorkflowGraph"), "运行台不应内嵌 AppWorkflowGraph");
  assert.ok(!code.includes("at-seg rh-seg"), "顶条不应再有 rh-seg 模式切换");
  assert.ok(code.includes("在画布中编辑"), "运行台顶条应有「在画布中编辑」");
  assert.ok(code.includes("RhPanelTabs") || code.includes("应用详情"), "应保留 RH 右栏 tabs");
  assert.ok(src.includes('setPhase("run")') || src.includes("setPhase(\"run\")"), "打开应用应进入 run phase");
});

test("Modal portal body:逃逸 sticky rh-params,封面预览不再压作品库选图弹层", () => {
  // 回归:运行台左列 position:sticky 建层叠上下文,AssetPicker→Modal 若同树渲染,
  // 右列 rh-preview-cover 大图会浮在「从作品库选」弹层之上。
  const modal = readSrc("components/ui/Modal.tsx");
  const picker = readSrc("components/generate/AssetPicker.tsx");
  const css = readSrc("app/styles/apps.css");
  assert.ok(modal.includes('from "react-dom"'), "Modal 缺 react-dom import");
  assert.ok(modal.includes("createPortal("), "Modal 未走 createPortal");
  assert.ok(modal.includes("document.body"), "Modal portal 目标不是 document.body");
  assert.ok(picker.includes('from "@/components/ui/Modal"'), "AssetPicker 应复用 ui/Modal");
  assert.match(css, /\.rh-params \{[\s\S]*?position: sticky/, "参数列 sticky 仍在(portal 才是正解,不是拆 sticky)");
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

test("RH 右栏双 Tab:应用详情 | 我的生成(run+detail)+ 跑通后切历史", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  const css = readSrc("app/styles/apps.css");
  assert.ok(src.includes("RhPanelTabs"), "缺 RhPanelTabs 组件");
  assert.ok(src.includes('"应用详情"'), "缺「应用详情」Tab 文案");
  assert.ok(src.includes("panelTab"), "缺 panelTab 状态");
  assert.ok(src.includes('setPanelTab("history")'), "跑通后应切到「我的生成」");
  assert.ok(src.includes('role="tablist"') && src.includes('aria-label="应用面板"'), "Tab 应有 tablist 语义");
  assert.match(css, /\.rh-panel-tab\.is-active \{[\s\S]*?background: var\(--rh-lime\)/, "激活 Tab 应走 --rh-lime");
});

test("RH 封面预览:object-fit contain(detail+run)不全裁切", () => {
  const css = readSrc("app/styles/apps.css");
  assert.match(
    css,
    /\.rh-preview-cover \.rh-card-img \{[\s\S]*?object-fit: contain/,
    "run 预览须 contain",
  );
  assert.match(
    css,
    /\.rh-detail-cover \.rh-card-img \{[\s\S]*?object-fit: contain/,
    "detail 封面须 contain",
  );
  assert.ok(!/\.rh-preview-cover \.rh-card-img \{[\s\S]*?object-fit: cover/.test(css), "run 预览不得再 cover");
  assert.ok(!/\.rh-detail-cover \.rh-card-img \{[\s\S]*?object-fit: cover/.test(css), "detail 封面不得再 cover");
});

test("RH admin 出处:RH/引擎外链可点(rh-prov-link)+ API 字段回退", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes("rh-prov-link"), "出处外链缺样式类");
  assert.ok(src.includes("rhWebappDetailUrl") || src.includes("rh_webapp_url"), "应能拼 RH 详情 URL");
  assert.ok(src.includes("adminSourceLinks") || src.includes("source_links"), "应消费 source_links");
  assert.ok(src.includes('target="_blank"'), "外链应新开页");
  assert.ok(src.includes("rel=\"noopener noreferrer\"") || src.includes("rel='noopener noreferrer'"), "外链须 noopener");
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



test("summarizeWorkflowNodes:primitive/custom 按 class_type 拆分计数", () => {
  const sum = summarizeWorkflowNodes({
    "1": { class_type: "CheckpointLoaderSimple", inputs: {} },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "a" } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "b" } },
    "4": { class_type: "WanVideoSampler", inputs: {} },
    "5": { class_type: "MyCustomFoo", inputs: {} },
  });
  assert.equal(sum.totalNodes, 5);
  assert.equal(sum.totalTypes, 4);
  assert.equal(sum.primitiveCount, 3);
  assert.equal(sum.customCount, 2);
  assert.deepEqual(
    sum.primitiveTypes.map((x) => [x.type, x.count]),
    [
      ["CheckpointLoaderSimple", 1],
      ["CLIPTextEncode", 2],
    ],
  );
  assert.deepEqual(
    sum.customTypes.map((x) => [x.type, x.count]),
    [
      ["MyCustomFoo", 1],
      ["WanVideoSampler", 1],
    ],
  );
  assert.equal(summarizeWorkflowNodes(null).totalNodes, 0);
});

test("extractRhWebappId:解析 description 内 RH:digits", () => {
  assert.equal(extractRhWebappId("LTX 数字人 · RH:1950219582398185474"), "1950219582398185474");
  assert.equal(extractRhWebappId("无出处"), "");
  assert.equal(extractRhWebappId(null), "");
});

test("RH 卡片 scrim:恒深 overlay + 恒白字(亮主题不翻深,abs-white)", () => {
  const css = readSrc("app/styles/apps.css");
  const i = css.indexOf(".rh-card-scrim {");
  assert.ok(i > 0, "缺 .rh-card-scrim");
  const end = css.indexOf(".rh-runner-body {", i);
  const scrim = css.slice(i, end > 0 ? end : i + 1200);
  assert.ok(scrim.includes("var(--overlay-stage)"), "scrim 底应走 --overlay-stage 恒深压");
  assert.ok(scrim.includes("color: var(--abs-white)"), "标题须恒白(--abs-white),不得用 --rh-text-1");
  assert.ok(!scrim.includes("color: var(--rh-text-1)"), "scrim 标题不得随主题翻深");
  assert.ok(!scrim.includes("color: var(--rh-text-2)"), "作者/用量不得用 --rh-text-2(亮主题翻深)");
  assert.ok(scrim.includes("var(--abs-white) 78%"), "作者/用量应半透白");
});

test("RH 市场:默认/热门排序 chips + sortAppsHot(usage_count 降序)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  assert.ok(src.includes('aria-label="排序"'), "缺排序 chips 组");
  assert.ok(src.includes('["hot", "热门"]'), "缺热门排序");
  assert.ok(src.includes("sortAppsHot"), "热门应调用 sortAppsHot");
  assert.ok(src.includes('useState<AppMarketSort>("default")'), "默认排序应为 default");
  const a = normalizeApp({ id: "a", name: "A", usage_count: 1 });
  const b = normalizeApp({ id: "b", name: "B", usage_count: 9 });
  const c = normalizeApp({ id: "c", name: "C", usage_count: 9 });
  const sorted = sortAppsHot([a, b, c]);
  assert.deepEqual(
    sorted.map((x) => x.id),
    ["b", "c", "a"],
    "热门应按 usage_count 降序,同用量按 name",
  );
});

test("RH 详情预览封面:onError 降级占位(与市场卡同范式)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes("previewFailed"), "缺 previewFailed 状态");
  assert.ok(src.includes("onError={() => setPreviewFailed(true)}"), "预览图缺 onError");
  assert.ok(src.includes("setPreviewFailed(false)"), "换应用时应复位失败态");
});

test("rh-dark 令牌全部映射全站主题令牌(2026-09-07 主题化,不再硬编码深黑)", () => {
  const css = readSrc("app/styles/apps.css");
  const block = css.slice(css.indexOf("/* RH-ACCENT-BEGIN"), css.indexOf("/* RH-ACCENT-END */"));
  // rh-* 作用域令牌 = 全站主题令牌映射(不断言具体 hex,断言引用令牌)
  assert.ok(block.includes("--rh-lime: var(--accent)"), "荧光绿位应映射 --accent(cinema 主题下即荧光绿)");
  assert.ok(block.includes("--rh-bg: var(--bg-canvas)"), "底应映射 --bg-canvas(随主题亮/暗)");
  assert.ok(block.includes("--rh-on-lime: var(--text-on-accent)"), "on-accent 应映射令牌");
  assert.ok(block.includes("--rh-text-1: var(--text-primary)"), "文本应映射令牌");
  assert.ok(block.includes("--rh-border: var(--border-subtle)"), "边线应映射令牌");
  // 作用域内不再覆盖全站 token(主题化后由 globals.css 主题块统一供给)
  assert.ok(!block.includes("--bg-canvas: var(--rh-bg)"), "作用域 token 覆盖应退役");
  // 荧光绿色值唯一事实源上移到 globals.css cinema 主题块
  const globals = readSrc("app/globals.css");
  const iCinema = globals.indexOf('[data-theme="cinema"] {');
  assert.ok(iCinema > 0, "globals.css 缺 cinema 主题块");
  const cinema = globals.slice(iCinema, globals.indexOf("\n}", iCinema));
  assert.ok(cinema.includes("--accent: #C9F24F"), "荧光绿应在 cinema 主题块");
  assert.ok(!globals.includes("--rh-lime"), "rh 令牌不得进 globals.css(作用域纪律)");
});
