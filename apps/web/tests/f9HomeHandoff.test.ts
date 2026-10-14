/**
 * F9(2026-10-15 UI 统一波):web 首页改跳转壳(源码断言)。
 * ①登录态 home 渲染跳转壳(splash-handoff),且闸门在 app-shell 之前——
 *   SideRail/⌘K/Shift+Enter 浮层/HomeView 第二套助手对话面全不挂载;
 * ②fail-safe:studio 关闭/无 token/非管理员 exchange 403/网络失败 → 回落经典 home(不锁死);
 * ③逃生口同在:?classic=1、R18 模式(canvas 纯 SFW)、EXTERNAL 深链(自带整页 replace);
 * ④未登录保持 LandingPage 登录/落地流程不变;
 * ⑤经典回落路径保留(HomeView/AssistantOverlay 注册不删,F12 才整体下线)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  // 四条失败出口:entry 关闭、无 token、exchange 非 ok、fetch 异常/超时
  const failures = src.split("setStudioHandoffFailed(true)").length - 1;
  assert.ok(failures >= 4, `失败出口应 ≥4 处(entry 关闭/无 token/exchange 403/catch),实际 ${failures}`);
  assert.match(src, /if \(r\.ok\) window\.location\.replace\("\/studio\/"\);\s*else setStudioHandoffFailed\(true\)/, "仅交换成功才跳;403 必须回落(零回退纪律)");
  // 闸门必须消费失败标记(失败后渲染经典回落)
  const gate = src.slice(src.indexOf("const homeHandoffPending ="), src.indexOf("if (homeHandoffPending)"));
  assert.match(gate, /!studioHandoffFailed/, "闸门未消费失败标记(失败后会卡在跳转壳)");
});

test("F9 逃生口:?classic=1 与 R18 模式不接管,EXTERNAL 深链不被截胡", () => {
  const src = readSrc("apps/web/app/page.tsx");
  const gate = src.slice(src.indexOf("const homeHandoffPending ="), src.indexOf("if (homeHandoffPending)"));
  assert.match(gate, /searchParams\.get\("classic"\) !== "1"/, "缺 ?classic=1 逃生口");
  assert.match(gate, /!r18/, "缺 R18 逃生口(canvas 纯 SFW,R18 面唯一家在经典壳)");
  assert.match(gate, /EXTERNAL_VIEW_REDIRECTS\[rawViewParam\]/, "EXTERNAL 深链会被跳转壳截胡(竞态)");
  // 探测 effect 与闸门同口径
  const effect = src.slice(src.indexOf("const studioProbeRef"), src.indexOf("useEffect(() => {\n    const raw = searchParams.get"));
  assert.match(effect, /includes\("classic=1"\)/);
  assert.match(effect, /if \(r18\) return;/);
});

test("F9 未登录流程不变:LandingPage 保持;登录探测/跨页同步不动", () => {
  const src = readSrc("apps/web/app/page.tsx");
  assert.match(src, /if \(auth === "out"\) \{\s*return <LandingPage \/>;\s*\}/, "未登录必须仍渲染登录/落地页");
  assert.match(src, /useCrossTabSync\(TOKEN_KEY/, "跨标签页登录态同步不得被动");
});

test("F9 经典回落路径保留(本波只做到「登录态不渲染助手面」,退役在 F12)", () => {
  const src = readSrc("apps/web/app/page.tsx");
  assert.match(src, /\{view === "home" && <HomeView variant="page"/, "回落路径的 home 助手面注册不得删除(F12 处置)");
  assert.match(src, /<AssistantOverlay/, "Shift+Enter 浮层保留给经典 R18 视图(F12 处置)");
  assert.match(src, /home: \(\) => import\("@\/components\/assistant\/AssistantView"\)/);
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
