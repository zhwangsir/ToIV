/**
 * 直播助手前端(数字人 M5)单测(node:test + fetch 桩 + 源码断言):
 * ① KB 列表/新建:GET/POST /api/live/kb,新建字段(trigger_words/reply_type/互斥回复字段/priority)
 * ② KB enabled 即时 PATCH + 删除;违禁词增删(POST/DELETE /api/live/banned)
 * ③ ingest:POST /api/live/ingest 载荷 {text,author,source:"manual"},事件回执字段
 * ④ 会话 start/stop/status:start 带 avatar_image/avatar_worker
 * ⑤ 事件轮询端点:GET /api/live/events?limit=50(limit 夹取)
 * ⑥ parseTriggerWords / liveEventStatusMeta 纯函数(五色徽标映射)
 * ⑦ AvatarTalkView 第三模式段控 + LiveAssistantPanel 接线(源码断言)
 * 契约锚点:apps/api/app/routes/live_assistant.py(全部 Bearer 鉴权)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";

import {
  createLiveBanned,
  createLiveKB,
  deleteLiveBanned,
  deleteLiveKB,
  getLiveSessionStatus,
  ingestLive,
  listLiveBanned,
  listLiveEvents,
  listLiveKB,
  liveEventStatusMeta,
  parseTriggerWords,
  patchLiveKB,
  startLiveSession,
  stopLiveSession,
} from "../lib/liveAssistant";

const testDir = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(join(testDir, "..", rel), "utf8");
}

// ── fetch 桩 ──

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const KB_ROW = {
  id: "kb1",
  trigger_words: ["价格", "多少钱"],
  reply_type: "text",
  reply_text: "今天全场九折",
  reply_asset_url: "",
  priority: 10,
  enabled: true,
  created_at: "2026-08-27T00:00:00",
  updated_at: "2026-08-27T00:00:00",
};
const EVENT_ROW = {
  id: "ev1",
  source: "manual",
  author: "小明",
  text: "多少钱?",
  matched_kb_id: "kb1",
  reply_text: "今天全场九折",
  reply_type: "text",
  status: "spoken",
  created_at: "2026-08-27T00:00:00",
};

let fetchCalls: FetchCall[] = [];
const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

function route(url: string, method: string): { status: number; payload: unknown } {
  if (url.includes("/api/live/kb/")) {
    if (method === "PATCH") return { status: 200, payload: { ...KB_ROW, enabled: false } };
    if (method === "DELETE") return { status: 204, payload: null };
  }
  if (url.includes("/api/live/kb")) {
    if (method === "POST") return { status: 201, payload: KB_ROW };
    return { status: 200, payload: [KB_ROW] };
  }
  if (url.includes("/api/live/banned/")) return { status: 204, payload: null };
  if (url.includes("/api/live/banned")) {
    if (method === "POST") return { status: 201, payload: { id: "b1", word: "假货" } };
    return { status: 200, payload: [{ id: "b1", word: "假货" }] };
  }
  if (url.includes("/api/live/ingest")) return { status: 200, payload: EVENT_ROW };
  if (url.includes("/api/live/events")) return { status: 200, payload: [EVENT_ROW] };
  if (url.includes("/api/live/session/start")) return { status: 200, payload: { active: true, session_id: "s1" } };
  if (url.includes("/api/live/session/stop")) return { status: 200, payload: { active: false, session_id: null } };
  if (url.includes("/api/live/session/status")) return { status: 200, payload: { active: false, session_id: null } };
  throw new Error(`未桩接的请求:${method} ${url}`);
}

beforeEach(() => {
  fetchCalls = [];
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (k === "toiv_token" ? "tok-test" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    fetchCalls.push({
      url: String(input),
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    const { status, payload } = route(String(input), method);
    return new Response(payload === null ? null : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

// ── ① KB 列表/新建 ──

test("① KB:GET /api/live/kb 带 Bearer;POST 新建字段与回复互斥", async () => {
  const list = await listLiveKB();
  assert.equal(fetchCalls[0].url.includes("/api/live/kb"), true);
  assert.equal(fetchCalls[0].method, "GET");
  assert.equal(fetchCalls[0].headers.Authorization, "Bearer tok-test");
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].trigger_words, ["价格", "多少钱"]);
  assert.equal(list[0].priority, 10);

  fetchCalls = [];
  await createLiveKB({
    trigger_words: ["价格"],
    reply_type: "text",
    reply_text: "九折",
    reply_asset_url: "",
    priority: 5,
    enabled: true,
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(fetchCalls[0].method, "POST");
  assert.deepEqual(body.trigger_words, ["价格"]);
  assert.equal(body.reply_type, "text");
  assert.equal(body.reply_text, "九折");
  assert.equal(body.priority, 5);
  assert.equal(body.enabled, true);

  // video 类型:reply_asset_url 必填、reply_text 置空(后端组合校验 422 的合法形态)
  fetchCalls = [];
  await createLiveKB({
    trigger_words: ["看下效果"],
    reply_type: "video",
    reply_text: "",
    reply_asset_url: "/api/images?filename=demo.mp4",
    priority: 100,
    enabled: true,
  });
  const vbody = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(vbody.reply_type, "video");
  assert.equal(vbody.reply_asset_url, "/api/images?filename=demo.mp4");
  assert.equal(vbody.reply_text, "");
});

// ── ② KB PATCH/DELETE + 违禁词增删 ──

test("② KB enabled 即时 PATCH;删除走 DELETE;违禁词 POST/DELETE", async () => {
  await patchLiveKB("kb1", { enabled: false });
  assert.equal(fetchCalls[0].method, "PATCH");
  assert.ok(fetchCalls[0].url.includes("/api/live/kb/kb1"));
  assert.deepEqual(fetchCalls[0].body, { enabled: false });

  fetchCalls = [];
  await deleteLiveKB("kb1");
  assert.equal(fetchCalls[0].method, "DELETE");
  assert.ok(fetchCalls[0].url.includes("/api/live/kb/kb1"));

  fetchCalls = [];
  const w = await createLiveBanned("假货");
  assert.equal(fetchCalls[0].method, "POST");
  assert.ok(fetchCalls[0].url.includes("/api/live/banned"));
  assert.deepEqual(fetchCalls[0].body, { word: "假货" });
  assert.equal(w.word, "假货");

  fetchCalls = [];
  const banned = await listLiveBanned();
  assert.equal(banned.length, 1);
  await deleteLiveBanned("b1");
  assert.equal(fetchCalls[1].method, "DELETE");
  assert.ok(fetchCalls[1].url.includes("/api/live/banned/b1"));
});

// ── ③ ingest ──

test("③ ingest:POST /api/live/ingest 载荷 {text,author,source:manual},事件回执", async () => {
  const ev = await ingestLive({ text: "多少钱?", author: "小明" });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(fetchCalls[0].method, "POST");
  assert.ok(fetchCalls[0].url.includes("/api/live/ingest"));
  assert.equal(body.text, "多少钱?");
  assert.equal(body.author, "小明");
  assert.equal(body.source, "manual");
  assert.equal(ev.status, "spoken");
  assert.equal(ev.reply_text, "今天全场九折");
  assert.equal(ev.matched_kb_id, "kb1");

  // author 可选:缺省空串
  fetchCalls = [];
  await ingestLive({ text: "hello" });
  assert.equal((fetchCalls[0].body as Record<string, unknown>).author, "");
});

// ── ④ 会话管理 ──

test("④ 会话:start 带 avatar_image/avatar_worker;stop/status 端点", async () => {
  const started = await startLiveSession({ avatar_image: "face.png", avatar_worker: "http://pool1" });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.ok(fetchCalls[0].url.includes("/api/live/session/start"));
  assert.equal(body.avatar_image, "face.png");
  assert.equal(body.avatar_worker, "http://pool1");
  assert.equal(started.active, true);
  assert.equal(started.session_id, "s1");

  fetchCalls = [];
  const stopped = await stopLiveSession();
  assert.ok(fetchCalls[0].url.includes("/api/live/session/stop"));
  assert.equal(stopped.active, false);

  fetchCalls = [];
  const status = await getLiveSessionStatus();
  assert.ok(fetchCalls[0].url.includes("/api/live/session/status"));
  assert.equal(fetchCalls[0].method, "GET");
  assert.equal(status.active, false);
});

// ── ⑤ 事件轮询 ──

test("⑤ listLiveEvents:GET /api/live/events?limit=50;limit 夹取", async () => {
  const events = await listLiveEvents(50);
  assert.ok(fetchCalls[0].url.includes("/api/live/events?limit=50"));
  assert.equal(events[0].id, "ev1");
  fetchCalls = [];
  await listLiveEvents(9999);
  assert.ok(fetchCalls[0].url.includes("limit=200"), "limit 上限 200(后端 ge=1 le=200)");
  fetchCalls = [];
  await listLiveEvents(0);
  assert.ok(fetchCalls[0].url.includes("limit=1"), "limit 下限 1");
});

// ── ⑥ 纯函数 ──

test("⑥ parseTriggerWords 分隔/去空白/去重;liveEventStatusMeta 五色映射", () => {
  assert.deepEqual(parseTriggerWords("价格,多少钱"), ["价格", "多少钱"]);
  assert.deepEqual(parseTriggerWords("价格,多少钱、优惠\n促销,, 价格 "), ["价格", "多少钱", "优惠", "促销"]);
  assert.deepEqual(parseTriggerWords("  ,, "), []);
  // 徽标:spoken 绿 / speak_failed 红 / banned 灰 / replied 蓝 / no_session 黄
  assert.deepEqual(liveEventStatusMeta("spoken"), { label: "已播报", tone: "ok" });
  assert.deepEqual(liveEventStatusMeta("speak_failed"), { label: "播报失败", tone: "err" });
  assert.deepEqual(liveEventStatusMeta("banned"), { label: "已拦截", tone: "neutral" });
  assert.deepEqual(liveEventStatusMeta("replied"), { label: "已回复", tone: "accent" });
  assert.deepEqual(liveEventStatusMeta("no_session"), { label: "未开播", tone: "warn" });
  assert.equal(liveEventStatusMeta("weird").tone, "neutral", "未知态兜底 neutral 不炸");
});

// ── ⑦ 组件接线(源码断言) ──

test("⑦ AvatarTalkView 第三模式「直播助手」段控 + LiveAssistantPanel 接线", () => {
  const view = readSrc("components/avatartalk/AvatarTalkView.tsx");
  assert.ok(view.includes('import { LiveAssistantPanel } from "./LiveAssistantPanel"'), "未引入直播助手面板");
  assert.ok(view.includes('"live" | "gen" | "assistant"'), "mode 联合类型缺 assistant");
  assert.ok(view.includes('{ key: "assistant", label: "直播助手" }'), "段控缺「直播助手」");
  assert.ok(view.includes('mode === "assistant"'), "缺 assistant 渲染分支");
  // 全局导航不动:段控仍是 at-mode-seg 页内切换
  assert.ok(view.includes("at-seg at-mode-seg"), "模式段控语言被改动");

  const panel = readSrc("components/avatartalk/LiveAssistantPanel.tsx");
  // 播报控制台:形象选择(形象模板列表)+ start/stop + 状态点
  assert.ok(panel.includes("listAvatarAssets()"), "开播形象未复用形象模板列表");
  assert.ok(panel.includes("startLiveSession({ avatar_image: img.filename, avatar_worker: img.worker })"), "开播未传形象句柄");
  assert.ok(panel.includes("stopLiveSession()"), "缺停播调用");
  assert.ok(panel.includes("直播中") && panel.includes("未开播"), "缺会话状态点文案");
  // 手动摄入 + 事件流轮询 + 状态徽标
  assert.ok(panel.includes("ingestLive({ text, author: ingestAuthor.trim() })"), "缺手动摄入调用");
  assert.ok(panel.includes("usePoll("), "事件流未用轮询 hook");
  assert.ok(panel.includes("listLiveEvents(50)"), "事件轮询未拉 limit=50");
  assert.ok(panel.includes("liveEventStatusMeta(ev.status)"), "事件未按状态徽标渲染");
  // 知识库:enabled 即时 PATCH + 新建表单 + 删除确认
  assert.ok(panel.includes("patchLiveKB(kb.id, { enabled })"), "enabled 开关未即时 PATCH");
  assert.ok(panel.includes("createLiveKB({"), "缺知识库新建提交");
  assert.ok(panel.includes("parseTriggerWords(kbWords)"), "触发词未走逗号分隔解析");
  assert.ok(panel.includes("kbConfirmDeleteId"), "删除缺二次确认");
  assert.ok(panel.includes('"text" | "video"'), "回复类型缺 text/video 互斥段控");
  // 违禁词:标签 + 添加 + 单个删除
  assert.ok(panel.includes("createLiveBanned(word)"), "缺违禁词添加");
  assert.ok(panel.includes("deleteLiveBanned(id)"), "缺违禁词删除");
  assert.ok(panel.includes("at-banned-tag"), "违禁词未按标签渲染");
});
