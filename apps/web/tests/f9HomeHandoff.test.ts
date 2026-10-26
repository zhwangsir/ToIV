/**
 * F9(2026-10-15 UI 统一波)+ D-U1=B 选项 A(2026-10-20):web 首页跳转壳(源码断言)。
 * ①登录态 home 渲染跳转壳(splash-handoff),且闸门在 app-shell 之前;
 * ②fail-safe:studio 关闭/无 token/非管理员 exchange 403/网络失败 → 回落经典 home;
 * ③逃生口:?classic=1、EXTERNAL 深链;R18 **不再**绕过 handoff(成人只走 canvas);
 * ④未登录保持 LandingPage;
 * ⑤ F12:经典壳无 R18/引擎台;image/video/create 深链 EXTERNAL → /studio/create。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf-8");
}

test("F9 跳转壳:登录态 home 的渲染闸门在 app-shell 之前", () => {
  const src = readSrc("apps/web/app/page.tsx");
  const gateAt = src.indexOf("const homeHandoffPending =");
  assert.notEqual(gateAt, -1, "缺少 homeHandoffPending 渲染闸门");
  const shellAt = src.indexOf('<div className="app-shell">');
  assert.notEqual(shellAt, -1, "app-shell 主渲染缺失");
  assert.ok(gateAt < shellAt, "跳转壳必须先于 app-shell 返回(否则助手面已挂载)");
  const gateBlock = src.slice(gateAt, src.indexOf("if (homeHandoffPending)", gateAt) + 400);
  assert.match(gateBlock, /auth === "in"/, "闸门必须限定登录态");
  assert.match(gateBlock, /view === "home"/, "闸门必须限定 home 视图(深链经典视图不受影响)");
  assert.match(src, /className="splash splash-handoff"/, "跳转壳占位缺失");
  assert.match(src, /正在进入创作工作室/, "跳转壳状态文案缺失");
});

test("F9 fail-safe:exchange 403/studio 关闭/无 token/网络失败都回落经典,不锁死", () => {
  const src = readSrc("apps/web/app/page.tsx");
  assert.match(src, /const \[studioHandoffFailed, setStudioHandoffFailed\] = useState\(false\)/);
  const failures = src.split("setStudioHandoffFailed(true)").length - 1;
  assert.ok(failures >= 4, `失败出口应 ≥4 处(entry 关闭/无 token/exchange 403/catch),实际 ${failures}`);
  assert.match(src, /if \(r\.ok\) window\.location\.replace\("\/studio\/"\);\s*else setStudioHandoffFailed\(true\)/, "仅交换成功才跳;403 必须回落(零回退纪律)");
  const gate = src.slice(src.indexOf("const homeHandoffPending ="), src.indexOf("if (homeHandoffPending)"));
  assert.match(gate, /!studioHandoffFailed/, "闸门未消费失败标记(失败后会卡在跳转壳)");
});

test("D-U1=B 选项 A:R18 不再绕过 handoff;?classic=1 与 EXTERNAL 仍有效", () => {
  const src = readSrc("apps/web/app/page.tsx");
  const gate = src.slice(src.indexOf("const homeHandoffPending ="), src.indexOf("if (homeHandoffPending)"));
  assert.match(gate, /searchParams\.get\("classic"\) !== "1"/, "缺 ?classic=1 逃生口");
  assert.doesNotMatch(gate, /!r18/, "R18 不得再作为经典壳逃生条件");
  assert.match(gate, /EXTERNAL_VIEW_REDIRECTS\[rawViewParam\]/, "EXTERNAL 深链会被跳转壳截胡(竞态)");
  const effect = src.slice(src.indexOf("const studioProbeRef"), src.indexOf("useEffect(() => {\n    const raw = searchParams.get"));
  assert.match(effect, /includes\("classic=1"\)/);
  assert.doesNotMatch(effect, /if \(r18\) return;/);
  assert.doesNotMatch(src, /useR18Mode/, "page 不应再订阅 R18 以留守经典壳");
});

test("F9 未登录流程不变:LandingPage 保持;登录探测/跨页同步不动", () => {
  const src = readSrc("apps/web/app/page.tsx");
  assert.match(src, /if \(auth === "out"\) \{\s*return <LandingPage \/>;\s*\}/, "未登录必须仍渲染登录/落地页");
  assert.match(src, /useCrossTabSync\(TOKEN_KEY/, "跨标签页登录态同步不得被动");
});

test("F12+D-U1=B:经典壳无引擎台;image/video 深链进 canvas create", () => {
  const src = readSrc("apps/web/app/page.tsx");
  assert.doesNotMatch(src, /@\/components\/assistant\//, "助手面 import 应已随 F12 物理下线");
  assert.doesNotMatch(src, /<AssistantOverlay|<HomeView/, "助手面 JSX 应已下线");
  assert.doesNotMatch(src, /@\/components\/nav\//, "第二套壳导航 import 应已下线");
  assert.doesNotMatch(src, /<SideRail|<BottomNav|<CommandPalette|<TaskCenter|<AccountButton/, "第二套壳导航 JSX 应已下线");
  // 选项 A:EngineStudioView 不得再挂在 page
  assert.doesNotMatch(src, /EngineStudioView/, "经典壳 R18/引擎台必须撤出 page");
  assert.doesNotMatch(src, /view === "image"/);
  assert.doesNotMatch(src, /view === "video"/);
  assert.match(src, /image:\s*"\/studio\/create"/, "image 深链须进 canvas create");
  assert.match(src, /video:\s*"\/studio\/create"/, "video 深链须进 canvas create");
  assert.match(src, /create:\s*"\/studio\/create"/);
  assert.match(src, /\/studio\/auth\/exchange/, "EXTERNAL 深链须先 exchange 再进 /studio");
  assert.match(src, /auth === \"loading\"/, "EXTERNAL 须等 auth 定论再跳");
  assert.match(src, /经典模式\(薄壳\)/, "handoff 失败/?classic=1 应落经典回落面板");
  assert.match(src, /R18\/成人内容请在工作室设置/, "回落面板须提示 R18 只在 canvas");
  for (const gone of [
    "apps/web/components/assistant/HomeView.tsx",
    "apps/web/components/assistant/AssistantOverlay.tsx",
    "apps/web/components/nav/SideRail.tsx",
  ]) {
    assert.equal(existsSync(join(repoRoot, gone)), false, `${gone} 应已删除`);
  }
});

test("F12 收编面源文件确已删除", () => {
  for (const gone of [
    "apps/web/components/assistant/AssistantView.tsx",
    "apps/web/components/nav/SideRail.tsx",
    "apps/web/components/nav/TaskCenter.tsx",
    "apps/web/components/library/LibraryView.tsx",
    "apps/web/components/market/MarketView.tsx",
  ]) {
    assert.ok(!existsSync(join(repoRoot, gone)), `${gone} 应已删除`);
  }
});

test("F9 跳转壳样式:splash-handoff 落 globals.css(纵向 + muted token,零新 hex)", () => {
  const css = readSrc("apps/web/app/globals.css");
  const at = css.indexOf(".splash-handoff {");
  assert.notEqual(at, -1, "缺 .splash-handoff 样式");
  const block = css.slice(at, css.indexOf("}", css.indexOf(".splash-handoff-text")) + 1);
  assert.match(block, /flex-direction: column/, "orb+文案应纵向排列");
  assert.match(block, /var\(--text-muted\)/, "文案颜色必须走 token");
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}/, "新增块不得引入裸 hex");
});
