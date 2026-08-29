/**
 * 前端 UX 精修批 D(2026-08-30)单测(node:test,源码断言为主):
 * ① page.tsx:animatic 图标差异化(film,与 studio clapperboard 区分)/
 *    handleOpenDramaProject 透传 projectId → StudioView initialProjectId/
 *    admin 视图 isAdmin 门控(非管理员给无权限提示)+ admin 导航入口
 * ② StudioView:initialProjectId prop 仅透传为 activeId 初值(不改内部)
 * ③ CanvasView:三处自绘 SVG 警告三角收编 ui/Icon(warning)
 * ④ DramaView:页头 PageHeader 收编 / 删除按钮 error→delete 图标 /
 *    项目列表失败持久错误态+重试(不再只 toast)/ rail 按钮 title 去误导
 * ⑤ LibraryView:主列表+回收站双页头收编 PageHeader;灯箱 3D 操作条
 *    伪 token 回退(hex/白玻璃)与 7px/6px 野值清零
 * ⑥ BacklotView/ModelsView:私造空态收编 ui/Empty;backlot 空态补
 *    「前往工作室创建」CTA(onCreateProject)
 * ⑦ SettingsView:版本号改从 /version.json 动态拉(部署指纹);
 *    LandingPage:邮箱框 type=email + 网络故障/凭据错误文案分流
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

/* ── ① page.tsx ── */
test("page.tsx:animatic 导航图标与 studio 区分(film ≠ clapperboard)", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(
    src.includes('{ key: "animatic", label: "动态分镜", icon: "film" }'),
    "animatic 应用 film 图标(原与 studio 同用 clapperboard)",
  );
  assert.ok(
    src.includes('{ key: "studio", label: "创作", icon: "clapperboard" }'),
    "studio 保持 clapperboard",
  );
});

test("page.tsx:handleOpenDramaProject 携带 projectId 并透传给 StudioView", () => {
  const src = readSrc("app/page.tsx");
  assert.match(
    src,
    /const handleOpenDramaProject = useCallback\(\s*\(projectId: string\)/,
    "handleOpenDramaProject 应接收 projectId(原签名丢弃)",
  );
  assert.ok(
    src.includes("setStudioInitialProjectId(projectId)"),
    "projectId 应写入 studioInitialProjectId 状态",
  );
  assert.ok(
    src.includes("initialProjectId={studioInitialProjectId}"),
    "StudioView 应接收 initialProjectId",
  );
  // 导航/融合直进 studio 复位,防陈旧 id 误开旧项目
  assert.ok(
    src.includes('if (key === "studio") setStudioInitialProjectId(null)'),
    "导航直进 studio 应复位待开项目 id",
  );
});

test("page.tsx:admin 视图 isAdmin 门控 + 非管理员无权限提示", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(
    !src.includes('{view === "admin" && <AdminView />}'),
    "admin 视图不得再裸挂(无门控)",
  );
  assert.match(
    src,
    /view === "admin" &&[\s\S]{0,400}isAdmin \? \([\s\S]{0,200}<AdminView \/>/,
    "AdminView 应只在 isAdmin 分支渲染",
  );
  assert.ok(src.includes("无权限访问"), "非管理员应看到无权限提示");
  assert.ok(src.includes("管理面板仅管理员账号可见"), "无权限提示副文案缺失");
});

test("page.tsx:admin 导航入口仅管理员可见(灵动岛 + 底部更多)", () => {
  const src = readSrc("app/page.tsx");
  assert.match(src, /const adminItem: BottomNavItem = \{[\s\S]*?key: "admin"/, "缺 adminItem 定义");
  assert.ok(
    src.includes("[...islandItems, observabilityItem, adminItem]"),
    "灵动岛应追加 adminItem",
  );
  assert.ok(
    src.includes("[...bottomNavMoreItems, observabilityItem, adminItem]"),
    "底部「更多」应追加 adminItem",
  );
});

/* ── ② StudioView initialProjectId 透传 ── */
test("StudioView:initialProjectId 仅作 activeId 初值透传", () => {
  const src = readSrc("components/studio/StudioView.tsx");
  assert.ok(src.includes("initialProjectId?: string | null"), "props 缺 initialProjectId");
  assert.ok(
    src.includes("useState<string | null>(initialProjectId ?? null)"),
    "activeId 应以 initialProjectId 为初值",
  );
});

/* ── ③ CanvasView 自绘 SVG 收编 ── */
test("CanvasView:三处警告三角收编 ui/Icon,无自绘 SVG 残留", () => {
  const src = readSrc("components/canvas/CanvasView.tsx");
  assert.ok(
    !src.includes('d="M12 3 2.5 20h19L12 3Z"'),
    "自绘三角 path 应清除(UI_STANDARD §6 禁自定义 SVG)",
  );
  const iconCount = (src.match(/name="warning" size=\{28\}/g) ?? []).length;
  assert.equal(iconCount, 3, "三处警告位都应使用 Icon warning(原三处内联 SVG)");
  assert.ok(src.includes("canvas-fallback-icon"), "fallback 图标类名保留(尺寸钩子)");
  assert.ok(src.includes("canvas-error-icon"), "error 图标类名保留(尺寸钩子)");
});

/* ── ④ DramaView ── */
test("DramaView:页头收编 PageHeader + 删除图标 delete + rail title 去误导", () => {
  const src = readSrc("components/drama/DramaView.tsx");
  assert.match(src, /import \{ PageHeader \} from "@\/components\/ui\/PageHeader"/);
  assert.match(src, /<PageHeader[\s\S]{0,200}title="短剧工作台"/, "页头应走 PageHeader 组件");
  assert.ok(!src.includes('name="error" size={13}'), "删除按钮不得用 error 图标");
  assert.ok(src.includes('name="delete" size={13}'), "删除按钮应用 delete(trash)图标");
  assert.ok(src.includes('title="回列表页新建项目"'), "rail 按钮 title 应如实描述行为");
  assert.ok(!src.includes('title="新建项目"'), "误导性 title 应清除");
});

test("DramaView:项目列表失败给持久错误态 + 重试(不再只 toast)", () => {
  const src = readSrc("components/drama/DramaView.tsx");
  assert.ok(src.includes("listError"), "缺 listError 状态");
  assert.ok(src.includes("setListError(msg)"), "失败应落 listError");
  assert.match(
    src,
    /listError && \([\s\S]{0,300}nsfw-drama-error[\s\S]{0,300}重试/,
    "列表区应渲染错误条 + 重试按钮",
  );
  assert.ok(
    src.includes('projects === null && !listError && <LoadingBlock'),
    "失败时不得再卡在骨架屏(假空态)",
  );
});

/* ── ⑤ LibraryView ── */
test("LibraryView:主列表 + 回收站双页头收编 PageHeader", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.match(src, /import \{ PageHeader \} from "@\/components\/ui\/PageHeader"/);
  const count = (src.match(/<PageHeader[\s\S]{0,80}className="lib-header"/g) ?? []).length;
  assert.equal(count, 2, "作品库与回收站两处页头都应走 PageHeader");
  assert.ok(
    !src.includes('<header className="page-header lib-header">'),
    "手写 header 结构应清除",
  );
});

test("LibraryView:灯箱 3D 操作条伪 token 回退与野值清零", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  const i0 = src.indexOf(".t3dops-bar");
  const i1 = src.indexOf(".t3dops-more[open]");
  assert.ok(i0 > 0 && i1 > i0, "t3dops 样式块缺失");
  const block = src.slice(i0, i1);
  assert.ok(!block.includes("#"), "t3dops 不得含 hex 回退(#888/#eee/#7c6cff)");
  assert.ok(!block.includes("rgba("), "t3dops 不得含白玻璃 rgba 回退");
  assert.ok(!/\b7px\b/.test(block), "7px 野值应清除");
  assert.ok(!/\b6px 8px\b/.test(block), "6px 8px 野值应清除");
  assert.ok(block.includes("var(--space-2)"), "间距应走 --space-* token");
  assert.ok(block.includes("var(--radius-control)"), "圆角应走 --radius-control");
  assert.ok(block.includes("border-color: var(--accent)"), "hover/主钮描边应走 --accent");
});

/* ── ⑥ BacklotView / ModelsView 空态收敛 ── */
test("BacklotView:空态收编 ui/Empty + 前往工作室创建 CTA", () => {
  const src = readSrc("components/backlot/BacklotView.tsx");
  assert.match(src, /import \{ Empty \} from "@\/components\/ui\/Empty"/);
  assert.match(src, /<Empty[\s\S]{0,200}title="还没有项目"/, "空态应走 Empty 组件");
  assert.ok(src.includes("前往工作室创建"), "空态缺 CTA 文案");
  assert.ok(src.includes("onCreateProject"), "缺 onCreateProject prop");
  assert.ok(!src.includes("bl-empty"), "私造 bl-empty 空态应清除(含死样式)");
});

test("BacklotView:page.tsx 为空态 CTA 接线跳 studio", () => {
  const src = readSrc("app/page.tsx");
  assert.match(
    src,
    /<BacklotView onCreateProject=\{\(\) => handleNavSelect\("studio"\)\} \/>/,
    "CTA 应跳工作室(handleNavSelect 顺带复位待开项目 id)",
  );
});

test("ModelsView:本地模型空态收编 ui/Empty", () => {
  const src = readSrc("components/models/ModelsView.tsx");
  assert.match(src, /import \{ Empty \} from "@\/components\/ui\/Empty"/);
  assert.match(src, /<Empty[\s\S]{0,200}本地暂无已安装模型/, "空态应走 Empty 组件");
});

/* ── ⑦ SettingsView / LandingPage ── */
test("SettingsView:版本号从 /version.json 动态拉取,无硬编码 APP_VERSION", () => {
  const src = readSrc("components/settings/SettingsView.tsx");
  assert.ok(!src.includes('APP_VERSION = "0.0.1"'), "硬编码版本号应清除");
  assert.ok(src.includes('fetch("/version.json"'), "应请求 /version.json");
  assert.ok(src.includes("buildId"), "应展示构建指纹 buildId");
});

test("LandingPage:邮箱框 type=email + 网络/凭据错误文案分流", () => {
  const src = readSrc("components/landing/LandingPage.tsx");
  assert.ok(src.includes('type="email"'), "邮箱框应为 type=email");
  assert.ok(src.includes("网络连接异常或请求超时,请检查网络后重试"), "缺网络故障文案");
  assert.ok(src.includes("账号或密码错误,请重试"), "缺凭据错误文案");
  assert.ok(src.includes("isNetwork"), "缺网络/凭据分流判定");
});
