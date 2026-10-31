/**
 * Agent Team(R3.1)API client 单测(node:test,真实 ../lib/api + fetch 桩):
 * 逐函数断言 URL / 方法 / body / Authorization 头(契约 §1.3.3 不得偏离);
 * upload/reprompt 已开放:agentTaskAction 直返任务详情(顶层无包装),
 * uploadAgentTaskAsset 走 multipart(FormData 透传,不手设 Content-Type)。
 * token 经假 window.localStorage 注入(API_BASE 在模块加载期已定,不影响断言)。
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  agentRunEventsUrl,
  agentTaskAction,
  cancelAgentRun,
  createAgentRun,
  getAgentRun,
  getAgentRunResult,
  listAgentRuns,
  resumeAgentRun,
  updateAgentRunPlan,
} from "../lib/api";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
/** 应答队列:每次 fetch 弹出一条(缺省 200 {})。 */
let responds: { status: number; body: unknown }[] = [];

const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  fetchCalls = [];
  responds = [];
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (k === "toiv_token" ? "tok-test" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      // JSON 字符串 body 解析为对象;FormData 等非串 body 原样透传(multipart 断言用)
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    const next = responds.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  const g = globalThis as { window?: unknown };
  if (realWindow === undefined) delete g.window;
  else g.window = realWindow;
});

test("createAgentRun:POST /api/agent-runs,body 带 goal,auth 头正确(L1 秒回)", async () => {
  responds.push({
    status: 200,
    body: {
      level: "L2",
      ack: "已拆成 3 步",
      run_id: "r1",
      plan: { tasks: [{ id: "t1", kind: "script", title: "剧本", depends_on: [], status: "pending" }] },
    },
  });
  const res = await createAgentRun({ goal: "拍一支 30 秒短片" });
  assert.equal(fetchCalls.length, 1);
  const c = fetchCalls[0];
  assert.ok(c.url.endsWith("/api/agent-runs"), `URL 应指向 /api/agent-runs,实际 ${c.url}`);
  assert.equal(c.method, "POST");
  assert.equal(c.headers.Authorization, "Bearer tok-test");
  assert.equal(c.headers["Content-Type"], "application/json");
  assert.deepEqual(c.body, { goal: "拍一支 30 秒短片" });
  assert.equal(res.run_id, "r1");
  assert.equal(res.level, "L2");
});

test("createAgentRun:L0 直链秒回 run_id 为 null", async () => {
  responds.push({ status: 200, body: { level: "L0", ack: "已收到", run_id: null } });
  const res = await createAgentRun({ goal: "帮忙写句文案" });
  assert.equal(res.level, "L0");
  assert.equal(res.run_id, null);
});

test("listAgentRuns:GET 带 limit/status query", async () => {
  responds.push({ status: 200, body: [] });
  await listAgentRuns({ limit: 20, status: "running" });
  const c = fetchCalls[0];
  assert.equal(c.method, "GET");
  assert.ok(c.url.includes("/api/agent-runs?"), "列表 URL 带 query");
  assert.ok(c.url.includes("limit=20"), "limit 透传");
  assert.ok(c.url.includes("status=running"), "status 透传");
  assert.equal(c.body, undefined, "GET 无 body");
});

test("getAgentRun:GET 详情,runId 经 encodeURIComponent", async () => {
  responds.push({ status: 200, body: { id: "r 1" } });
  await getAgentRun("r 1");
  assert.ok(fetchCalls[0].url.includes("/api/agent-runs/r%201"), "runId 已编码");
  assert.equal(fetchCalls[0].method, "GET");
});

test("updateAgentRunPlan:POST /plan,body 为 {tasks: ops}", async () => {
  responds.push({ status: 200, body: { ok: true } });
  const ops = [
    { id: "t1", action: "update" as const, title: "新标题" },
    { id: "t2", action: "remove" as const },
    { id: "new-1", action: "add" as const, title: "补一镜", input: { prompt: "雨夜" } },
  ];
  await updateAgentRunPlan("r1", ops);
  const c = fetchCalls[0];
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/api/agent-runs/r1/plan"));
  assert.deepEqual(c.body, { tasks: ops });
});

test("resumeAgentRun:POST /resume,gate/action/feedback 契约字段", async () => {
  responds.push({ status: 200, body: { ok: true } });
  await resumeAgentRun("r1", { gate: "plan", action: "reject", feedback: "角色发色不一致" });
  const c = fetchCalls[0];
  assert.ok(c.url.endsWith("/api/agent-runs/r1/resume"));
  assert.deepEqual(c.body, { gate: "plan", action: "reject", feedback: "角色发色不一致" });
});

test("agentTaskAction:POST tasks/{tid}/action;后端直返任务详情(顶层无包装)", async () => {
  responds.push({ status: 200, body: { id: "t2", attempt: 1 } });
  const res = await agentTaskAction("r1", "t2", { action: "regenerate", payload: { guidance: "发色一致" } });
  const c = fetchCalls[0];
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/api/agent-runs/r1/tasks/t2/action"));
  assert.deepEqual(c.body, { action: "regenerate", payload: { guidance: "发色一致" } });
  assert.equal(res.attempt, 1);

  // 错误 detail 原样抛出(如 upload 非法 url 的 400)
  responds.push({ status: 400, body: { detail: "产物不存在或非法 url(仅支持本地产物)" } });
  await assert.rejects(agentTaskAction("r1", "t2", { action: "upload" }), /非法 url/);
});

test("uploadAgentTaskAsset:POST multipart,不手设 Content-Type", async () => {
  const { uploadAgentTaskAsset } = await import("../lib/api");
  responds.push({ status: 200, body: { id: "t2", status: "done", output: { url: "/api/studio/files/x.png", source: "upload" } } });
  const file = new File(["png-bytes"], "replacement.png", { type: "image/png" });
  const res = await uploadAgentTaskAsset("r1", "t2", file);
  const c = fetchCalls[0];
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/api/agent-runs/r1/tasks/t2/upload"));
  assert.ok(c.body instanceof FormData, "body 为 FormData");
  assert.equal(res.output?.source, "upload");
});

test("cancelAgentRun:POST /cancel 无 body", async () => {
  responds.push({ status: 200, body: { ok: true } });
  await cancelAgentRun("r1");
  const c = fetchCalls[0];
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/api/agent-runs/r1/cancel"));
  assert.equal(c.body, undefined);
});

test("getAgentRunResult:GET /result", async () => {
  responds.push({ status: 200, body: { final_url: "/api/x.mp4", duration_sec: 30, tasks: [] } });
  const res = await getAgentRunResult("r1");
  assert.ok(fetchCalls[0].url.endsWith("/api/agent-runs/r1/result"));
  assert.equal(fetchCalls[0].method, "GET");
  assert.equal(res.final_url, "/api/x.mp4");
});

test("agentRunEventsUrl:token 走 query(EventSource 无法带请求头),after 游标透传", () => {
  const url = agentRunEventsUrl("r1", 3);
  assert.ok(url.includes("/api/agent-runs/r1/events?"), "事件流地址");
  assert.ok(url.includes("after=3"), "断点游标");
  assert.ok(url.includes("token=tok-test"), "token query 认证");
});
