/**
 * 助手 A2 信息架构(2026-09-22)单测:
 * ① 会话分叉:store.fork server 走 forkAgentSession+新会话置顶;local 兜底本地复制(分叉后缀)
 * ② renderConvList 分叉钮源码断言(stopPropagation/aria-label/接 forkConversation)
 * ③ 一次性草稿通道(lib/assistantDraft):stash→take 取出即删;空/双取幂等
 * ④ AssistantView 消费草稿源码断言(仅 page 形态;popup 不抢)
 * ⑤ AgentRunView「在对话中继续」源码断言(stash+跳 home)
 * ⑥ SideRail「智能体」入口 + fork 图标注册
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";
import { flush, renderHook } from "./helpers/renderHook";
import {
  makeSessionSummary,
  resetSessImpl,
  sessCalls,
  sessImpl,
} from "./mocks/studioApi";

// ── localStorage/window 替身:必须在导入组件模块前装好 ──
const g = globalThis as { window?: unknown; localStorage?: unknown };
g.window ??= globalThis;
const localStore = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => void localStore.delete(k),
  clear: () => localStore.clear(),
};

const { useAgentConversations } = await import("../components/assistant/AssistantView");
const { stashAssistantDraft, takeAssistantDraft, ASSISTANT_DRAFT_KEY } = await import(
  "../lib/assistantDraft"
);

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

beforeEach(() => {
  resetSessImpl();
  localStore.clear();
});

/* ── ① 会话分叉 ── */
test("store.fork:server 模式走 forkAgentSession,新会话置顶", async () => {
  sessImpl.listAgentSessions = async () => [makeSessionSummary("s1", { title: "画只猫" })];
  const h = renderHook(() => useAgentConversations());
  await flush();
  const before = sessCalls.forkAgentSession;
  const newId = await h.result.current!.fork("s1");
  assert.equal(newId, "s1-fork");
  assert.ok(sessCalls.forkAgentSession > before, "未调 fork 端点");
  const convs = h.result.current!.conversations;
  assert.equal(convs[0].id, "s1-fork", "分叉会话应置顶");
  assert.equal(convs.length, 2);
  h.unmount();
});

test("store.fork:local 兜底本地复制(标题加分叉后缀,新 id)", async () => {
  sessImpl.listAgentSessions = async () => {
    throw new Error("offline");
  };
  const h = renderHook(() => useAgentConversations());
  await flush();
  assert.equal(h.result.current!.serverMode, false, "应为 local 兜底模式");
  // local 模式先 register 一条会话
  h.result.current!.register(
    () => null,
    null,
    [{ id: "m1", role: "user", content: "本地画猫", timestamp: 1 } as never],
    () => {},
  );
  await flush();
  const srcId = h.result.current!.conversations[0].id;
  const newId = await h.result.current!.fork(srcId);
  assert.ok(newId && newId !== srcId, "本地分叉应生成新 id");
  const convs = h.result.current!.conversations;
  assert.equal(convs[0].id, newId);
  assert.ok(convs[0].title.includes("分叉"), "标题应带分叉后缀");
  assert.equal(convs[0].messages.length, 1, "消息应全量复制");
  assert.equal(sessCalls.forkAgentSession, 0, "local 模式不调服务端");
  h.unmount();
});

/* ── ② 分叉钮(源码断言) ── */
test("renderConvList:分叉钮(stopPropagation/aria-label/接 forkConversation)", () => {
  // A3(2026-09-22):会话列表渲染拆至 SessionDrawer.tsx(ConvList),样式外迁 assistant-view.css;
  // forkConversation/fork 处理函数仍留在主壳 AssistantView.tsx
  const listSrc = readSrc("components/assistant/SessionDrawer.tsx");
  assert.ok(listSrc.includes('className="av-conv-fork"'), "缺分叉钮");
  assert.ok(listSrc.includes("forkConversation(conv)"), "分叉钮未接处理函数");
  assert.ok(listSrc.includes("e.stopPropagation(); forkConversation"), "分叉须 stopPropagation(防误切会话)");
  assert.ok(listSrc.includes("`分叉对话 ${conv.title}`"), "缺 aria-label");
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes('convStore.fork(conv.id)'), "处理函数未走 store.fork");
  // 样式:与删除键同族(accent hover 区别于 err)
  const css = readSrc("app/styles/assistant-view.css");
  assert.ok(css.includes(".av-conv-fork,"), "分叉钮未共享删除键基座样式");
  assert.ok(css.includes(".av-conv-fork:hover"), "缺分叉 hover 态");
});

/* ── ③ 一次性草稿通道 ── */
test("assistantDraft:stash→take 取出即删;空取幂等", () => {
  stashAssistantDraft("继续处理任务 X");
  assert.equal(localStore.get(ASSISTANT_DRAFT_KEY), "继续处理任务 X");
  assert.equal(takeAssistantDraft(), "继续处理任务 X");
  assert.equal(localStore.has(ASSISTANT_DRAFT_KEY), false, "取出后应即删");
  assert.equal(takeAssistantDraft(), "", "二次取应回空串");
});

/* ── ④ AssistantView 消费草稿(源码断言) ── */
test("AssistantView:草稿仅 page 形态消费(popup 不抢),回填+聚焦", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("takeAssistantDraft"), "未引入草稿通道");
  const draft = src.slice(src.indexOf("takeAssistantDraft"));
  assert.ok(draft.includes("if (popup) return"), "popup 形态应跳过草稿消费");
  assert.ok(draft.includes("setInput(draft)"), "草稿未回填输入框");
  assert.ok(draft.includes("textareaRef.current?.focus()"), "回填后未聚焦");
});

/* ── ⑤ AgentRunView「在对话中继续」 ── */
test("AgentRunView:在对话中继续(stash run 上下文+跳 home)", () => {
  const src = readSrc("components/agent-run/AgentRunView.tsx");
  assert.ok(src.includes("stashAssistantDraft"), "未引入草稿写入");
  assert.ok(src.includes("agent-continue-chat"), "缺「在对话中继续」按钮类");
  assert.ok(src.includes('href="/?view=home"'), "未跳对话页");
  assert.ok(src.includes("继续处理智能体任务"), "草稿未带 run 上下文");
});

/* ── ⑥ SideRail 入口 + 图标 ── */
test("SideRail:「智能体」入口在对话次位(handleNavSelect 特判 agent-runs)", () => {
  const src = readSrc("app/page.tsx");
  const rail = src.slice(src.indexOf("const RAIL_ITEMS"), src.indexOf("const BOTTOM_NAV_ITEMS"));
  const homeIdx = rail.indexOf('key: "home"');
  const agentIdx = rail.indexOf('key: "agent-runs"');
  assert.ok(agentIdx > homeIdx, "智能体应在对话之后");
  assert.ok(rail.includes('label: "智能体", icon: "bot"'), "智能体入口缺 label/icon");
  // handleNavSelect 对 agent-runs 的既有特判(独立路由)仍在
  assert.ok(src.includes('key === "agent-runs"'), "agent-runs 特判丢失");
  // fork 图标注册
  const icon = readSrc("components/ui/Icon.tsx");
  assert.ok(icon.includes("fork: GitFork"), "fork 图标未注册");
});
