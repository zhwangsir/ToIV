/**
 * 应用市场(M3)视图单测(node:test + react-dom/server 静态渲染 + 源码断言):
 * ① AppMarketView:加载态 grid 骨架渲染;三区/fork 门控/NSFW 过滤/三态接线源码断言
 * ② AppRunnerView:加载态 line 骨架渲染;ParamField 复用/trackJob/runApp/下载源码断言
 * ③ page.tsx 入口注册(2026-08-31 精简:skills/apps 合并为 market 聚合视图——
 *    importer/VALID_VIEWS/VIEW_META/渲染分支/旧 key 重定向/灵动岛/BottomNav 更多)
 * ④ Icon.tsx store 图标;apps.css token 纪律(零 hex、断点 -1 约定、触达 44px)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppMarketView } from "../components/apps/AppMarketView";
import { AppRunnerView } from "../components/apps/AppRunnerView";
import { KindCreateView } from "../components/apps/KindCreateView";
import { ParamField } from "../components/generate/ParamField";
import { ToastProvider } from "../components/ui/Toast";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① AppMarketView ── */

test("AppMarketView 初始加载态渲染 grid 骨架(ui-loading--grid)", () => {
  const html = renderToStaticMarkup(h(ToastProvider, null, h(AppMarketView)));
  assert.match(html, /ui-loading--grid/, "市场加载态应为卡片网格骨架");
});

test("AppMarketView 三区(内置/公共/我的)+ fork 门控 + 打开按钮(源码)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  assert.ok(src.includes("内置应用"), "缺内置区");
  assert.ok(src.includes("公共应用"), "缺公共区");
  assert.ok(src.includes("我的应用"), "缺我的区");
  assert.ok(src.includes("splitAppSections"), "三区划分应复用 lib/apps helper");
  // fork 门控:非内置且非本人才显示
  assert.ok(src.includes("!a.is_builtin && !a.is_mine"), "fork 按钮门控缺失");
  assert.ok(src.includes("forkApp"), "未接 forkApp");
  // 卡片要素:类别徽标 + 用量计数 + 打开
  assert.ok(src.includes("apps-tag"), "缺类别徽标");
  assert.ok(src.includes("apps-usage"), "缺用量计数");
  assert.ok(src.includes("打开"), "缺「打开」按钮");
});

test("AppMarketView RunningHub 社区区:核心内置不含 rh- + 分页/截断(源码)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  const lib = readSrc("lib/apps.ts");
  assert.ok(src.includes("RunningHub 社区"), "缺社区区");
  assert.ok(src.includes("内置应用"), "核心 H3 仍在内置区");
  assert.ok(src.includes("sliceCommunityApps"), "社区分页应复用 helper");
  assert.ok(src.includes("rhFamilyChips"), "family chips 应复用 helper");
  assert.ok(src.includes("显示更多"), "空查询应有显示更多");
  assert.ok(src.includes("结果已截断,请再缩小关键词"), "搜索超 cap 应提示截断");
  assert.ok(src.includes("COMMUNITY_PAGE_SIZE"), "分页步长应走常量");
  assert.match(lib, /COMMUNITY_PAGE_SIZE = 24/, "空查询社区卡上限 24");
  assert.match(lib, /COMMUNITY_SEARCH_CAP = 120/, "搜索匹配上限 120");
  assert.ok(lib.includes("isRhCommunityId"), "rh-* 应划入社区而非内置");
  // 核心 H3 精选仍钉在内置,不把 rh-* 塞进 FEATURED
  assert.ok(lib.includes('"h3-t2v"'), "核心 H3 仍在精选");
  assert.ok(!/FEATURED_VIDEO_APP_IDS[\s\S]*?"rh-/.test(lib), "FEATURED 不得含 rh-*");
});

test("AppMarketView 三态接线:空态单行化/ErrorBar/LoadingBlock + NSFW 客户端过滤(源码)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  // 2026-09-02 W3:整库大图标 Empty 退役,改单行 muted 提示 + 行内重试
  assert.ok(!src.includes('import { Empty }'), "Empty 大图标空态应已退役");
  assert.ok(src.includes("apps-empty-all"), "缺整库单行空态");
  assert.ok(src.includes('import { ErrorBar }'), "未导入 ErrorBar(错误态)");
  assert.ok(src.includes('import { LoadingBlock }'), "未导入 LoadingBlock(加载态)");
  assert.ok(src.includes("useR18Mode"), "NSFW 过滤应读 R18 模式");
  assert.ok(src.includes("filterApps"), "过滤应复用 lib/apps filterApps(含 NSFW 门控)");
  assert.ok(src.includes('import "@/app/styles/apps.css"'), "未引入 apps.css");
  // 检索工具栏:搜索 + 分类 chips
  assert.ok(src.includes('role="search"'), "缺搜索工具栏语义");
  assert.ok(src.includes("CATEGORY_CHIPS"), "缺分类 chips");
});

/* ── ② AppRunnerView ── */

test("AppRunnerView 初始加载态渲染 line 骨架(ui-loading--line)", () => {
  const html = renderToStaticMarkup(
    h(ToastProvider, null, h(AppRunnerView, { appId: "a1", onBack: () => {} })),
  );
  assert.match(html, /ui-loading--line/, "运行页加载态应为行骨架");
});

test("AppRunnerView 复用 ParamField 渲染 params_schema(不私造 AppParamField)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(
    src.includes('import { ParamField } from "@/components/generate/ParamField"'),
    "应直接复用 generate/ParamField",
  );
  assert.ok(src.includes("<ParamField"), "params_schema 应经 ParamField 渲染");
  assert.ok(!/function AppParamField|const AppParamField/.test(src), "不应私造 AppParamField");
});

test("AppRunnerView 打开时 GET /api/apps/{id} 拉完整 schema(不信任列表 slim 项)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes("getApp(appId)"), "运行页须 getApp 拉详情");
  assert.ok(!src.includes("listApps("), "运行页不得用列表项的 params_schema");
});

test("AppRunnerView 上传走 generate 同款 /api/upload(appUploadKind + pinWorker)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes("appUploadKind(app.id)"), "缺 appUploadKind(与 Generate 同口径 kind)");
  assert.ok(src.includes("firstPinWorker(values)"), "缺 firstPinWorker(多槽互钉)");
  assert.ok(src.includes("uploadKind={appUploadKind(app.id)}"), "ParamField 未接 uploadKind");
});

test("ParamField: type===images && max>1 渲染 RefImagesUpload,不是文本框", () => {
  const src = readSrc("components/generate/ParamField.tsx");
  assert.ok(src.includes("case \"images\""), "ParamField 缺 images 分支");
  assert.ok(src.includes("RefImagesUpload"), "max>1 应复用 RefImagesUpload");
  assert.ok(src.includes("max > 1"), "多图条件缺失");
  const html = renderToStaticMarkup(
    h(ToastProvider, null, h(ParamField, {
      param: { key: "images", label: "参考图", type: "images", default: null, max: 9, hint: "最多 9 张" },
      value: [],
      onChange: () => undefined,
      uploadKind: "h3_i2v",
    })),
  );
  assert.match(html, /上传参考图/, "多图槽应渲染上传按钮");
  assert.doesNotMatch(html, /type="text"/, "images max>1 不得回落文本框");
});

test("ParamField: last_frame images max=1 渲染单图上传;video/audio 渲染既有上传件", () => {
  const last = renderToStaticMarkup(
    h(ToastProvider, null, h(ParamField, {
      param: { key: "last_frame", label: "尾帧图", type: "images", default: null, max: 1 },
      value: [],
      onChange: () => undefined,
      uploadKind: "h3_i2v",
    })),
  );
  assert.match(last, /上传参考图/, "尾帧单图应走 RefImageUpload");
  assert.doesNotMatch(last, /type="text"/, "尾帧不得回落文本框");
  const vid = renderToStaticMarkup(
    h(ToastProvider, null, h(ParamField, {
      param: { key: "video", label: "参考视频", type: "video", default: null, max: 3 },
      value: [],
      onChange: () => undefined,
      uploadKind: "h3_i2v",
    })),
  );
  assert.match(vid, /上传视频/);
  const aud = renderToStaticMarkup(
    h(ToastProvider, null, h(ParamField, {
      param: { key: "audio", label: "参考音频", type: "audio", default: null, max: 3 },
      value: [],
      onChange: () => undefined,
      uploadKind: "h3_i2v",
    })),
  );
  assert.match(aud, /上传音频/);
});

test("AppRunnerView 提交链:buildRunValues 载荷 → runApp → trackJob(禁用原因提示)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes("buildRunValues"), "提交载荷应经 buildRunValues 归一");
  assert.ok(src.includes("runApp(app.id"), "应调 runApp(POST /run)");
  assert.ok(src.includes("trackJob("), "应复用 lib/trackJob 跟踪作业");
  assert.ok(src.includes("requiredParamLabel"), "必填缺口应卡控提交");
  assert.ok(src.includes("disabledReason"), "禁用原因提示缺失");
  // 2026-09-02 W3:PageHeader 退役,返回入口收进细顶条
  assert.ok(src.includes("返回市场"), "缺返回市场入口");
  assert.ok(src.includes("apps-runner-head"), "缺工作台细顶条");
});

test("AppRunnerView 失败复位:trackJob 终态后表单不卡「正在提交」(P1 回归)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  const runBody = src.slice(src.indexOf("async function run()"), src.indexOf("if (loading)"));
  // 提交与跟踪两段式:runApp 完成后 submitting 即复位,跟踪期只由 running 卡控
  assert.ok(runBody.includes("setSubmitting(false);\n    setRunning(true);"), "提交成功后应立即复位 submitting 再进入跟踪");
  assert.ok(!runBody.includes("finally {\n      setSubmitting(false);"), "trackJob 终态不应依赖跨 await 的 finally 才复位 submitting");
  // 跟踪段收尾:无论 resolve/reject(含非 Error 抛出)都复位 running/progress,表单可再改可再提交
  assert.ok(
    runBody.includes("} finally {\n      setRunning(false);\n      setProgress(null);"),
    "跟踪段 finally 应复位 running/progress",
  );
});

test("AppRunnerView 结果区:按 output_kind 渲染 + 下载按钮(源码)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes("mediaKindOf(p, app.output_kind)"), "产物应按 output_kind 分流渲染");
  assert.ok(src.includes("<video"), "缺视频产物分支");
  assert.ok(src.includes("<audio"), "缺音频产物分支");
  assert.ok(src.includes("<img"), "缺图片产物分支");
  assert.ok(src.includes("download"), "缺下载按钮");
});

/* ── ③ page.tsx 入口注册(2026-08-31 精简:skills/apps 合并为 market) ── */

test("page.tsx 注册 market 视图:importer/VALID_VIEWS/VIEW_META/渲染分支", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(
    src.includes('market: () => import("@/components/market/MarketView")'),
    "viewImporters 缺 market 懒加载",
  );
  assert.match(src, /\| "market"/, "View 联合类型缺 market");
  assert.ok(src.includes('market:     { label: "市场" }'), "VIEW_META 缺中文名");
  assert.ok(src.includes('{view === "market" && <MarketView />}'), "缺渲染分支");
});

test("page.tsx 旧 key 兼容:skills/apps 经 LEGACY_VIEW_REDIRECTS 跳 market(不 404)", () => {
  const src = readSrc("app/page.tsx");
  assert.match(src, /skills: "market",/, "LEGACY_VIEW_REDIRECTS 缺 skills → market");
  assert.match(src, /apps: "market",/, "LEGACY_VIEW_REDIRECTS 缺 apps → market");
  // 旧独立视图分支/导航入口应清除
  assert.ok(!src.includes('{view === "apps" && <AppMarketView />}'), "旧 apps 渲染分支应移除");
  assert.ok(!src.includes('{view === "skills" && <SkillMarketView />}'), "旧 skills 渲染分支应移除");
  assert.ok(!src.includes('key: "skills"'), "导航不应再含 skills 独立入口");
  assert.ok(!src.includes('key: "apps"'), "导航不应再含 apps 独立入口");
});

test("page.tsx 导航入口:灵动岛 + BottomNav 更多均含单一市场入口(store 图标)", () => {
  const src = readSrc("app/page.tsx");
  // W1 分组后灵动岛项带 group 字段,断言允许尾部扩展属性
  const entries = src.match(/\{ key: "market", label: "市场", icon: "store"[^}]*\}/g) ?? [];
  assert.equal(entries.length, 2, "灵动岛 ISLAND_ITEMS 与 BOTTOM_NAV_MORE_ITEMS 应各一条 market 入口");
});

test("page.tsx 导航去重:底部主入口项不在「更多」抽屉重复(audio 回归)", () => {
  const src = readSrc("app/page.tsx");
  const moreBlock = src.slice(src.indexOf("BOTTOM_NAV_MORE_ITEMS"));
  assert.ok(
    !moreBlock.includes('key: "audio"'),
    "audio 已由底部主入口承载,「更多」抽屉不应重复",
  );
});

test("page.tsx 导航去重:fusion 卡五目标不在「更多」抽屉重复(2026-08-31 二轮精简)", () => {
  const src = readSrc("app/page.tsx");
  const moreBlock = src.slice(src.indexOf("BOTTOM_NAV_MORE_ITEMS"));
  // 融合页是底部 CTA 主入口,其 bento 卡一跳直达五目标;抽屉摆第二套 = 双重入口
  for (const key of ["studio", "avatartalk", "dub", "imageEdit", "videoEdit"]) {
    assert.ok(
      !moreBlock.includes(`key: "${key}"`),
      `${key} 已由融合卡承载,「更多」抽屉不应重复`,
    );
  }
  // 非 fusion 目标保留:market/canvas/entities/animatic/resources/settings
  for (const key of ["market", "canvas", "entities", "animatic", "resources", "settings"]) {
    assert.ok(moreBlock.includes(`key: "${key}"`), `「更多」抽屉缺 ${key} 入口`);
  }
});

/* ── 2026-08-31 W1 IA 骨架治理 ── */
test("W1:models/train/backlot/drama 移出独立视图,旧 key 走重定向", () => {
  const src = readSrc("app/page.tsx");
  const redirectBlock = src.slice(src.indexOf("LEGACY_VIEW_REDIRECTS"), src.indexOf("resolveView"));
  for (const key of ["models", "train", "backlot"]) {
    assert.match(redirectBlock, new RegExp(`${key}: "resources"`), `${key} 应重定向进资源中心`);
  }
  assert.match(redirectBlock, /drama: "studio"/, "drama 旧管线应重定向到 studio");
  // 不再作为独立视图渲染
  assert.ok(!src.includes('view === "train"'), "train 不应有独立渲染分支");
  assert.ok(!src.includes('view === "models"'), "models 不应有独立渲染分支");
  assert.ok(!src.includes('view === "backlot"'), "backlot 不应有独立渲染分支");
  assert.ok(!src.includes('view === "drama"'), "drama 不应有独立渲染分支");
  const validBlock = src.slice(src.indexOf("VALID_VIEWS"), src.indexOf("VIEW_META"));
  for (const key of ["models", "train", "backlot", "drama"]) {
    assert.ok(!validBlock.includes(`"${key}"`), `VALID_VIEWS 不应再含 ${key}`);
  }
});

test("W1:models/train/backlot 重定向携带 tab 直达资源中心二级页", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(
    src.includes('LEGACY_RESOURCE_TAB_KEYS = new Set(["models", "train", "backlot"])'),
    "缺资源 tab 旧 key 集合",
  );
  assert.ok(src.includes('`&tab=${raw}`'), "重定向 URL 应携带 tab 参数");
});

test("W1:ResourcesView 支持 ?tab= 初始直达(白名单校验)", () => {
  const src = readSrc("components/resources/ResourcesView.tsx");
  assert.ok(src.includes("useSearchParams"), "应读 URL 查询参数");
  assert.ok(src.includes('RESOURCE_TABS = new Set'), "缺 tab 白名单");
  assert.ok(src.includes('searchParams.get("tab")'), "应解析 tab 参数");
});

test("Studio Console v1:SideRail 左栏注册(8 高频项)+ ⌘K 面板挂载", () => {
  const src = readSrc("app/page.tsx");
  // 左栏组件与数据源
  assert.ok(src.includes('import { SideRail'), "缺 SideRail 引入");
  assert.ok(src.includes("RAIL_ITEMS"), "缺 RAIL_ITEMS");
  const railBlock = src.slice(src.indexOf("const RAIL_ITEMS"), src.indexOf("const BOTTOM_NAV_ITEMS"));
  for (const key of ['"home"', '"image"', '"video"', '"audio"', '"studio"', '"library"', '"market"', '"resources"']) {
    assert.ok(railBlock.includes(`key: ${key}`), `左栏缺 ${key}`);
  }
  // ⌘K 命令面板
  assert.ok(src.includes("CommandPalette"), "缺 CommandPalette");
  assert.ok(src.includes('e.key.toLowerCase() === "k"'), "缺 ⌘K 快捷键监听");
  // 旧灵动岛退役
  assert.ok(!src.includes("CornerNav"), "CornerNav 应退役");
});

test("W1:agent-runs 孤儿路由收口进「更多」抽屉(特判跳独立路由)", () => {
  const src = readSrc("app/page.tsx");
  const moreBlock = src.slice(src.indexOf("BOTTOM_NAV_MORE_ITEMS"));
  assert.ok(moreBlock.includes('key: "agent-runs"'), "「更多」抽屉缺智能体入口");
  assert.ok(
    src.includes('router.push("/agent-runs")'),
    "agent-runs 应特判跳独立 Next 路由",
  );
});

/* ── 2026-08-31 W2 对话为家 ── */
test("W2:home 视图注册全链路(union/VALID/META/importer/渲染分支)", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(src.includes('| "home"'), "View union 缺 home");
  const validBlock = src.slice(src.indexOf("VALID_VIEWS"), src.indexOf("VIEW_META"));
  assert.ok(validBlock.includes('"home"'), "VALID_VIEWS 缺 home");
  assert.ok(src.includes('home:      { label: "对话" }'), "VIEW_META 缺 home");
  assert.ok(
    src.includes('home: () => import("@/components/assistant/AssistantView")'),
    "home 应与助手同 chunk",
  );
  assert.match(
    src,
    /\{view === "home" && <HomeView variant="page"/,
    "home 渲染分支应为 AssistantView 整页形态",
  );
});

test("W2:默认落地为对话首页(fusion 退为场景入口)", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(src.includes('resolveView(raw) ?? "home"'), "默认视图应为 home");
  assert.ok(src.includes('if (raw === "assistant") return "home"'), "?view=assistant 应落 home");
  assert.ok(src.includes('router.replace("/?view=home")'), "assistant 旧链接 URL 应规整为 home");
  // 底部 CTA 由 fusion 改为 home;融合下沉抽屉
  const navBlock = src.slice(src.indexOf("BOTTOM_NAV_ITEMS"), src.indexOf("BOTTOM_NAV_MORE_ITEMS"));
  assert.ok(navBlock.includes('{ key: "home", label: "对话", icon: "chat", isCta: true }'), "CTA 应为对话");
  const moreBlock = src.slice(src.indexOf("BOTTOM_NAV_MORE_ITEMS"));
  assert.ok(moreBlock.includes('key: "fusion"'), "融合应在「更多」抽屉");
  // Studio Console v1:左栏首项即对话(home),离开首页后永远有回程入口
  const railBlock = src.slice(src.indexOf("const RAIL_ITEMS"), src.indexOf("const BOTTOM_NAV_ITEMS"));
  assert.ok(
    railBlock.includes('{ key: "home", label: "对话", icon: "chat" }'),
    "左栏首项缺「对话」入口",
  );
});

/* ── 2026-08-31 W3 助手 UI 驱动工具 ── */
test("W3:AssistantView 处理 ui_action 三指令(navigate/prefill/open_asset)", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes('ev.type === "ui_action"'), "缺 ui_action 分支");
  assert.ok(src.includes('act === "navigate_view"'), "缺 navigate_view 处理");
  assert.ok(src.includes('act === "prefill_generate"'), "缺 prefill_generate 处理");
  assert.ok(src.includes('act === "open_asset"'), "缺 open_asset 处理");
  // prefill 经引擎草稿回填后跳转
  assert.ok(src.includes("toiv_engine_draft"), "prefill 应写引擎草稿");
});

test("W3:AgentEvent 类型含 ui_action 字段", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("action?: string"), "AgentEvent 缺 action 字段");
  assert.ok(src.includes("view?: string"), "AgentEvent 缺 view 字段");
});

test("MarketView:at-seg 段控 + ErrorBoundary(key=tab)+ 懒加载内嵌双市场", () => {
  const src = readSrc("components/market/MarketView.tsx");
  assert.ok(src.includes("import { ErrorBoundary }"), "未导入 ErrorBoundary");
  assert.ok(src.includes("key={tab}"), "ErrorBoundary 未绑定 tab key(切换不重置)");
  assert.ok(src.includes("at-seg"), "缺 at-seg 段控");
  assert.ok(src.includes('role="tablist"'), "段控缺 tablist 语义");
  assert.ok(
    src.includes('import("@/components/apps/AppMarketView")'),
    "缺 AppMarketView 懒加载",
  );
  assert.ok(
    src.includes('import("@/components/skills/SkillMarketView")'),
    "缺 SkillMarketView 懒加载",
  );
});

/* ── ⑤ 图片/视频创作壳:默认应用目录,高级引擎仍挂 GenerateView ── */

test("KindCreateView 段控:应用默认 + 高级引擎(源码)", () => {
  const src = readSrc("components/apps/KindCreateView.tsx");
  assert.ok(src.includes('useState<CreateTab>("apps")'), "默认 tab 应为应用,不是引擎");
  assert.ok(src.includes('"应用"'), "缺「应用」段");
  assert.ok(src.includes('"高级引擎"'), "缺「高级引擎」段");
  assert.ok(src.includes("at-seg"), "段控应复用 at-seg(与 MarketView 同款)");
  assert.ok(src.includes('role="tablist"'), "段控缺 tablist 语义");
  assert.ok(src.includes("AppMarketView"), "应用 tab 应挂 AppMarketView");
  assert.ok(src.includes("outputKind={kind}"), "目录应按 output_kind 过滤");
  assert.ok(src.includes("featuredAppIdsForKind"), "视频精选应走 featured helper");
  assert.ok(src.includes('tab === "engine" && <GenerateView lockedKind={kind} />'), "高级引擎应挂 GenerateView");
  assert.ok(src.includes('import "@/app/styles/apps.css"'), "应复用 apps.css,不另起 CSS 语言");
});

test("KindCreateView 初始渲染应用段控为选中(静态)", () => {
  const html = renderToStaticMarkup(h(ToastProvider, null, h(KindCreateView, { kind: "video" })));
  assert.match(html, />应用</, "缺应用段按钮");
  assert.match(html, />高级引擎</, "缺高级引擎段按钮");
  assert.match(html, /aria-selected="true"[^>]*>应用</, "默认选中应为应用");
  assert.match(html, /aria-selected="false"[^>]*>高级引擎</, "高级引擎默认未选");
});

test("page.tsx:image/video 默认 KindCreateView,不再直接挂 GenerateView", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(
    src.includes('image: () => import("@/components/apps/KindCreateView")'),
    "image importer 应指向 KindCreateView",
  );
  assert.ok(
    src.includes('video: () => import("@/components/apps/KindCreateView")'),
    "video importer 应指向 KindCreateView",
  );
  assert.ok(src.includes('{view === "image" && <KindCreateView kind="image" />}'), "image 渲染分支缺 KindCreateView");
  assert.ok(src.includes('{view === "video" && <KindCreateView kind="video" />}'), "video 渲染分支缺 KindCreateView");
  assert.ok(
    !src.includes('{view === "image" && <GenerateView lockedKind="image" />}'),
    "image 不应再直接挂 GenerateView",
  );
  assert.ok(
    !src.includes('{view === "video" && <GenerateView lockedKind="video" />}'),
    "video 不应再直接挂 GenerateView",
  );
  // 音频维持原状
  assert.ok(src.includes('{view === "audio" && <AudioView />}'), "audio 不应被这次改动波及");
});

test("AppMarketView 创作页过滤:outputKind + featuredIds + runnerBackLabel(源码)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  assert.ok(src.includes("outputKind"), "缺 outputKind prop");
  assert.ok(src.includes("sortFeaturedApps"), "精选排序应复用 lib/apps helper");
  assert.ok(src.includes("featuredIds"), "缺 featuredIds prop");
  assert.ok(src.includes("runnerBackLabel"), "创作页返回文案应可覆盖");
  assert.ok(src.includes("!outputKind &&"), "产物类型锁定时应隐藏分类 chips");
});

/* ── ④ Icon / apps.css ── */

test("Icon.tsx:store 图标已注册(lucide Store)", () => {
  const src = readSrc("components/ui/Icon.tsx");
  assert.match(src, /\bStore,/, "lucide-react 应导入 Store");
  assert.match(src, /store: Store,/, "ICON_MAP 缺 store 键");
});

test("apps.css:类名齐全 + token 纪律(零 hex / 无违规断点 / 触达 44px)", () => {
  const css = readSrc("app/styles/apps.css");
  for (const cls of [
    ".apps-market",
    ".apps-toolbar",
    ".apps-chip",
    ".apps-grid",
    ".apps-card",
    ".apps-usage",
    ".apps-runner",
    ".apps-runner-form",
    ".apps-disabled-reason",
    ".apps-results",
    ".apps-result-card",
    ".apps-kind-create",
    ".apps-kind-mode-row",
    ".apps-kind-body",
    ".apps-family-chips",
    ".apps-community-more",
    ".apps-truncated",
  ]) {
    assert.ok(css.includes(cls), `apps.css 缺 ${cls} 定义`);
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), "apps.css 存在硬编码 hex 色值");
  assert.doesNotMatch(css, /@media\s*\(max-width:\s*(1024|1280)px\)/, "断点须 -1 约定");
  assert.ok(css.includes("var(--touch-target)"), "移动端卡片操作钮须 ≥44px");
  assert.ok(css.includes("var(--duration-fast)"), "动效应走 token(≤320ms)");
});
