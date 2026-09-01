/**
 * AI 助手 popup 会话管理(2026-08-24)单测(node:test,源码断言式):
 * ① 会话按钮:popup 形态 composer 左侧渲染 history 按钮,切换 historyOpen
 * ② 会话抽屉:av-pop-conv 抽屉(列表/新会话置顶/删除入口),与页形态共用 renderConvList
 * ③ 交互:Esc/点外部关闭;切换复用 loadConversation 回放;删除走二次确认 Modal
 * ④ 样式:<style jsx global> + av- 前缀 + 200ms 开合过渡;空态 Shift+Enter 提示
 * ⑤ AssistantOverlay:抽屉展开时 Esc 让位(先关抽屉,不收浮层)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

const viewSrc = readSrc("components/assistant/AssistantView.tsx");
const overlaySrc = readSrc("components/assistant/AssistantOverlay.tsx");

/* ── ① 会话按钮 ── */
test("popup composer 左侧渲染「会话」按钮(history 图标,切换 historyOpen)", () => {
  assert.ok(viewSrc.includes("av-pop-conv-toggle"), "会话按钮 class 缺失");
  assert.ok(viewSrc.includes('aria-label="会话管理"'), "会话按钮 aria-label 缺失");
  // 按钮在 composer 的 popup 分支(文档按钮的 !popup 互斥侧)
  const branch = viewSrc.slice(viewSrc.indexOf(") : !popup ? ("));
  assert.ok(branch.includes("av-pop-conv-toggle"), "会话按钮不在 composer popup 分支");
  assert.ok(branch.includes('name="history"'), "会话按钮未用 history 图标");
  assert.ok(
    branch.includes("onClick={() => setHistoryOpen((v) => !v)}"),
    "会话按钮未切换 historyOpen",
  );
});

/* ── ② 会话抽屉结构与复用 ── */
test("popup 会话抽屉:仅 popup 渲染 + 新会话置顶 + 列表复用 renderConvList", () => {
  assert.ok(viewSrc.includes("av-pop-conv"), "抽屉容器 class 缺失");
  assert.ok(
    viewSrc.includes('className={`av-pop-conv${historyOpen ? " is-open" : ""}`}'),
    "抽屉 is-open 开合逻辑缺失",
  );
  // 抽屉内:新会话按钮置顶(head 区) + 列表复用页形态同一份渲染
  const drawer = viewSrc.slice(
    viewSrc.indexOf("av-pop-conv-head"),
    viewSrc.indexOf("av-skill-panel at-card"),
  );
  assert.ok(drawer.includes("av-pop-conv-new"), "新会话按钮缺失");
  assert.ok(drawer.includes("onNewChat()"), "新会话未接 onNewChat");
  assert.ok(drawer.includes("setHistoryOpen(false)"), "新会话后未关闭抽屉");
  assert.ok(drawer.includes("renderConvList()"), "抽屉未复用 renderConvList");
  // renderConvList 同时被页形态历史面板与 popup 抽屉使用(不复制两套列表)
  const uses = viewSrc.match(/\{renderConvList\(\)\}/g) ?? [];
  assert.ok(uses.length >= 2, "renderConvList 未在页面板+抽屉两处复用");
});

test("renderConvList:加载态/空态/列表三分支 + 当前会话高亮 + 删除入口", () => {
  const fn = viewSrc.slice(
    viewSrc.indexOf("const renderConvList"),
    viewSrc.indexOf("const renderComposer"),
  );
  assert.ok(fn.includes("convStore.serverMode === null"), "缺加载态分支");
  assert.ok(fn.includes("LoadingBlock"), "加载态未用 LoadingBlock");
  assert.ok(fn.includes("暂无历史对话"), "缺空态分支");
  assert.ok(fn.includes('activeConvId === conv.id ? " is-active"'), "当前会话高亮缺失");
  assert.ok(fn.includes("loadConversation(conv)"), "点击切换未复用 loadConversation(回放)");
  assert.ok(fn.includes("setConfirmDeleteConv(conv)"), "删除未走二次确认状态");
});

/* ── ③ 交互:Esc/点外部关闭 + 删除二次确认 ── */
test("抽屉 Esc / 点外部关闭", () => {
  assert.ok(
    viewSrc.includes('e.key === "Escape") setHistoryOpen(false)'),
    "Esc 关闭抽屉缺失",
  );
  assert.ok(
    viewSrc.includes('document.addEventListener("mousedown", onDown)'),
    "点外部关闭监听缺失",
  );
  assert.ok(viewSrc.includes("convDrawerRef.current?.contains(t)"), "抽屉内部点击豁免缺失");
  assert.ok(viewSrc.includes('t.closest(".av-pop-conv-toggle")'), "触发按钮点击豁免缺失");
});

test("删除会话:二次确认 Modal → deleteConversation → DELETE API", () => {
  // Modal 已在组件根部(popup 不屏蔽),确认按钮触发删除
  assert.ok(viewSrc.includes("open={!!confirmDeleteConv}"), "删除确认 Modal 缺失");
  assert.ok(
    viewSrc.includes("deleteConversation(confirmDeleteConv.id)"),
    "确认按钮未调 deleteConversation",
  );
  // store 层:server 模式调 DELETE /api/agent/sessions/{id}
  assert.ok(viewSrc.includes("await deleteAgentSession(id)"), "store 未调删除 API");
  const api = readSrc("lib/api.ts");
  const del = api.slice(api.indexOf("export async function deleteAgentSession"));
  assert.ok(del.includes('method: "DELETE"'), "删除 API 非 DELETE");
  assert.ok(del.includes("/api/agent/sessions/"), "删除 API 路径错误");
  // 列表/回放 API 沿用既有契约(2026-09-01:列表走 swr 缓存,导出改非 async 函数)
  assert.ok(api.includes("export function listAgentSessions"), "列表 API 缺失");
  assert.ok(api.includes("export async function getAgentSession"), "回放 API 缺失");
});

/* ── ④ 样式与空态提示 ── */
test("样式:style jsx global + av- 前缀 + 200ms 开合过渡 + reduced-motion", () => {
  assert.ok(viewSrc.includes("<style jsx global>"), "样式未走 style jsx global(P-2b)");
  assert.ok(viewSrc.includes(".av-pop-conv {"), "抽屉样式缺失");
  assert.ok(viewSrc.includes(".av-pop-conv.is-open"), "抽屉开启态样式缺失");
  const style = viewSrc.slice(viewSrc.indexOf(".av-pop-conv {"));
  assert.ok(/opacity 200ms/.test(style), "缺 200ms opacity 过渡");
  assert.ok(/transform 200ms/.test(style), "缺 200ms transform 过渡");
  assert.ok(/visibility 200ms/.test(style), "缺 visibility 过渡(关态退出 Tab 序)");
  assert.ok(
    viewSrc.includes(".av-pop-conv { transition: none; }"),
    "reduced-motion 未豁免抽屉过渡",
  );
  // 关闭态不可交互
  assert.ok(/\.av-pop-conv \{[^}]*pointer-events:\s*none/s.test(viewSrc), "关态未禁指针事件");
});

test("popup 空态:Shift+Enter 唤起/关闭提示", () => {
  const empty = viewSrc.slice(
    viewSrc.indexOf("av-popup-empty"),
    viewSrc.indexOf("av-popup-empty") + 800,
  );
  assert.ok(empty.includes("Shift+Enter 随时唤起/关闭"), "popup 空态 Shift+Enter 提示缺失");
  assert.ok(empty.includes("av-popup-empty-hint"), "提示行 class 缺失");
});

/* ── ⑤ AssistantOverlay:抽屉展开时 Esc 让位 ── */
test("AssistantOverlay:会话抽屉展开时 Esc 先关抽屉(不收浮层)", () => {
  const esc = overlaySrc.slice(overlaySrc.indexOf('e.key === "Escape"'));
  assert.ok(
    esc.includes('document.querySelector(".av-pop-conv.is-open")'),
    "Esc 未检测抽屉展开态",
  );
});
