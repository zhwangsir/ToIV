/**
 * 智能体会话迁移(H2)单测(node:test + 自制 renderHook,无 DOM):
 * ① 服务端会话列表加载(server 模式,摘要含消息数)
 * ② 切换会话回放:tool 消息的媒体产物并回前一条 assistant 气泡
 * ③ 新会话 id 接续:首轮响应头 sessionId 登记,后续轮次复用不重复建条目
 * ④ 离线兜底:list 接口失败 → 回退 localStorage(读/写/删全本地)
 * ⑤ 回放失败透出 listError,返回 null 不切换
 * @/lib/api 经 tests/loader.mjs 映射到 mocks/studioApi 可控替身。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { flush, renderHook } from "./helpers/renderHook";
import {
  makeSessionDetail,
  makeSessionSummary,
  resetSessImpl,
  sessCalls,
  sessImpl,
} from "./mocks/studioApi";

// ── localStorage/window 替身:必须在导入组件模块前装好(loadStoredConversations 读 window) ──
const g = globalThis as { window?: unknown; localStorage?: unknown };
g.window ??= globalThis;
const localStore = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => void localStore.delete(k),
  clear: () => localStore.clear(),
};

const {
  messagesToChat,
  useAgentConversations,
} = await import("../components/assistant/AssistantView");

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  kind?: "error";
}

const userMsg = (content: string): ChatMsg => ({
  id: `m-${content}`,
  role: "user",
  content,
  timestamp: Date.now(),
});

beforeEach(() => {
  resetSessImpl();
  localStore.clear();
});

test("① 服务端会话列表加载:server 模式,摘要含消息数", async () => {
  sessImpl.listAgentSessions = async () => [
    makeSessionSummary("s1", { title: "画只猫", message_count: 4 }),
    makeSessionSummary("s2", { title: "写剧本", message_count: 2 }),
  ];
  const h = renderHook(() => useAgentConversations());
  await flush();
  const cur = h.result.current!;
  assert.equal(cur.serverMode, true);
  assert.equal(cur.conversations.length, 2);
  assert.equal(cur.conversations[0].id, "s1");
  assert.equal(cur.conversations[0].title, "画只猫");
  assert.equal(cur.conversations[0].messageCount, 4);
  assert.equal(localStore.size, 0, "server 模式不写 localStorage");
  h.unmount();
});

test("② 切换会话回放:媒体并回前一条 assistant 气泡", async () => {
  sessImpl.listAgentSessions = async () => [makeSessionSummary("s1")];
  sessImpl.getAgentSession = async (id: string) =>
    makeSessionDetail(id, {
      messages: [
        { id: 1, role: "user", content: "画只猫", tool_calls: null, media: [], created_at: "2026-08-14T00:00:00Z" },
        { id: 2, role: "assistant", content: "好的", tool_calls: [{ id: "t1" }], media: [], created_at: "2026-08-14T00:00:01Z" },
        {
          id: 3,
          role: "tool",
          content: "已生成 1 张图片并展示给用户。",
          tool_calls: { name: "generate_image" },
          media: [{ type: "image", urls: ["/api/images?filename=cat.png"] }],
          created_at: "2026-08-14T00:00:02Z",
        },
        { id: 4, role: "assistant", content: "已为你生成", tool_calls: null, media: [], created_at: "2026-08-14T00:00:03Z" },
      ],
    });
  const h = renderHook(() => useAgentConversations());
  await flush();
  const msgs = await h.result.current!.open("s1");
  assert.ok(msgs, "回放返回消息");
  assert.deepEqual(
    msgs!.map((m) => m.role),
    ["user", "assistant", "assistant"],
  );
  assert.equal(msgs![0].content, "画只猫");
  assert.equal(msgs![1].content, "好的");
  assert.deepEqual(msgs![1].media, [
    { type: "image", urls: ["/api/images?filename=cat.png"] },
  ]);
  assert.equal(msgs![2].content, "已为你生成");
  assert.equal(sessCalls.getAgentSession, 1);
  h.unmount();
});

test("③ 新会话 id 接续:首轮登记 sessionId,后续轮次复用", async () => {
  sessImpl.listAgentSessions = async () => [];
  const h = renderHook(() => useAgentConversations());
  await flush();
  assert.equal(h.result.current!.serverMode, true);

  const seen: string[] = [];
  // 首轮:无 convId,服务端经响应头返回 srv-1
  h.result.current!.register(() => null, "srv-1", [userMsg("画只猫")], (id) => seen.push(id));
  await flush();
  assert.deepEqual(seen, ["srv-1"]);
  assert.equal(h.result.current!.conversations.length, 1);
  assert.equal(h.result.current!.conversations[0].id, "srv-1");
  assert.equal(h.result.current!.conversations[0].title, "画只猫");

  // 次轮:带 convId 续聊,不重复建条目,消息更新
  h.result.current!.register(
    () => "srv-1",
    "srv-1",
    [userMsg("画只猫"), { ...userMsg("再来一张"), id: "m2" }],
    (id) => seen.push(id),
  );
  await flush();
  assert.equal(h.result.current!.conversations.length, 1, "续聊不重复建会话条目");
  assert.equal(h.result.current!.conversations[0].messages.length, 2);
  h.unmount();
});

test("④ 离线兜底:list 失败 → localStorage 读写删全本地", async () => {
  sessImpl.listAgentSessions = () => Promise.reject(new Error("未认证 (401)"));
  const h = renderHook(() => useAgentConversations());
  await flush();
  assert.equal(h.result.current!.serverMode, false, "服务端不可达回退 local 模式");

  const seen: string[] = [];
  h.result.current!.register(() => null, null, [userMsg("本地对话")], (id) => seen.push(id));
  await flush();
  assert.equal(seen.length, 1, "本地生成会话 id");
  const localId = seen[0];
  assert.notEqual(localId, "srv-1");
  assert.equal(h.result.current!.conversations[0].id, localId);
  // localStorage 兜底写入(按天 key)
  const keys = [...localStore.keys()].filter((k) => k.startsWith("toiv_av_convs_"));
  assert.equal(keys.length, 1, "兜底模式写 localStorage");
  const stored = JSON.parse(localStore.get(keys[0])!) as { id: string }[];
  assert.equal(stored[0]?.id, localId);

  // 本地回放与删除
  const msgs = await h.result.current!.open(localId);
  assert.equal(msgs?.[0]?.content, "本地对话");
  await h.result.current!.remove(localId);
  await flush();
  assert.equal(h.result.current!.conversations.length, 0);
  assert.equal(sessCalls.deleteAgentSession, 0, "local 模式不触服务端删除");
  h.unmount();
});

test("⑤ 回放失败:透出 listError,返回 null 不切换", async () => {
  sessImpl.listAgentSessions = async () => [makeSessionSummary("s1")];
  sessImpl.getAgentSession = () => Promise.reject(new Error("会话不存在 (404)"));
  const h = renderHook(() => useAgentConversations());
  await flush();
  const msgs = await h.result.current!.open("s1");
  assert.equal(msgs, null);
  await flush();
  assert.match(h.result.current!.listError ?? "", /404/);
  h.result.current!.clearListError();
  await flush();
  assert.equal(h.result.current!.listError, null);
  h.unmount();
});

test("messagesToChat 纯函数:无媒体的 tool 消息不产生气泡", () => {
  const out = messagesToChat([
    { id: 1, role: "user", content: "有哪些模型", tool_calls: null, media: [], created_at: "2026-08-14T00:00:00Z" },
    { id: 2, role: "assistant", content: "", tool_calls: [{ id: "t1" }], media: [], created_at: "2026-08-14T00:00:01Z" },
    { id: 3, role: "tool", content: "当前可用图像大模型: a.safetensors", tool_calls: { name: "list_models" }, media: [], created_at: "2026-08-14T00:00:02Z" },
    { id: 4, role: "assistant", content: "目前有 a", tool_calls: null, media: [], created_at: "2026-08-14T00:00:03Z" },
  ]);
  // W4(2026-08-31):纯工具轮 assistant(空 content)同样不出气泡——空内容气泡会渲染成常驻打字点
  assert.equal(out.length, 2, "无媒体 tool 消息与空工具轮 assistant 均不出气泡");
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant"]);
});
