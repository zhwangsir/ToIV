/**
 * useAgentRun 详情页 hook 单测(node:test + 自制 renderHook + FakeEventSource):
 * ① 挂载加载详情并建立 SSE
 * ② task_status 事件更新对应卡片
 * ③ confirm_required(gate=assembly)弹出合成门
 * ④ regenerate 后 attempt+1(局部更新);失败透出错误条
 * ⑤ SSE 断线 → reconnecting;连续 5 次全败 → 转 5s 轮询详情
 * ⑥ 终态 run 不订阅 SSE,直接 closed 并拉取成片
 * ⑦ 计划门 approve / 取消 调用契约端点
 * ⑧ plan 简报事件按 id 并回详情字段;计划门打开时拉全量详情
 * @/lib/api 经 tests/loader.mjs 映射到 mocks/studioApi 可控替身。
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { useAgentRun } from "../components/agent-run/useAgentRun";
import { flush, renderHook } from "./helpers/renderHook";
import {
  agentCalls,
  agentImpl,
  makeAgentRunDetail,
  makeAgentTask,
  resetAgentImpl,
} from "./mocks/studioApi";

interface FakeEvent {
  data?: string;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, Set<(e: FakeEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: FakeEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }

  close(): void {
    this.closed = true;
  }

  /** 测试驱动:派发一个事件(data 省略 = 网络层 error)。 */
  emit(type: string, data?: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
}

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  resetAgentImpl();
  FakeEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource =
    FakeEventSource as unknown as typeof EventSource;
});

after(() => {
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

test("① 挂载加载详情并建立 SSE;卸载关闭连接", async () => {
  const h = renderHook(() => useAgentRun("r1"));
  await flush();
  assert.equal(h.result.current?.detail?.id, "r1");
  assert.equal(h.result.current?.loading, false);
  assert.equal(h.result.current?.error, null);
  assert.equal(FakeEventSource.instances.length, 1, "非终态 run 建立 SSE");
  assert.ok(FakeEventSource.instances[0].url.includes("/r1?"), "事件流地址指向该 run");
  h.unmount();
  assert.equal(FakeEventSource.instances[0].closed, true, "卸载关闭 EventSource");
});

test("② task_status 事件更新对应卡片 + 事件流记录", async () => {
  const h = renderHook(() => useAgentRun("r1"));
  await flush();
  const es = FakeEventSource.instances[0];
  es.emit("open");
  es.emit("task_status", JSON.stringify({ task_id: "t2", status: "running" }));
  await flush();
  const t2 = h.result.current?.detail?.plan.find((t) => t.id === "t2");
  assert.equal(t2?.status, "running", "对应卡片状态已更新");
  const t1 = h.result.current?.detail?.plan.find((t) => t.id === "t1");
  assert.equal(t1?.status, "pending", "其他卡片不受影响");
  assert.equal(h.result.current?.sseState, "open");
  assert.ok(
    h.result.current?.events.some((e) => e.type === "task_status"),
    "事件流已记录",
  );
  h.unmount();
});

test("③ confirm_required(gate=assembly)弹出合成门;计划门改 run 状态", async () => {
  // 计划门事件会触发 refresh 拉全量详情(plan 简报缺 input);后端事件与状态同
  // commit,故第二次拉取即新状态——mock 按调用序模拟该推进
  let calls = 0;
  agentImpl.getAgentRun = async (id) =>
    makeAgentRunDetail(id, { status: calls++ === 0 ? "running" : "awaiting_confirm" });
  const h = renderHook(() => useAgentRun("r1"));
  await flush();
  const es = FakeEventSource.instances[0];
  es.emit("confirm_required", JSON.stringify({ gate: "assembly" }));
  await flush();
  assert.equal(h.result.current?.assemblyGate, true, "合成门已开");
  es.emit("confirm_required", JSON.stringify({ gate: "plan" }));
  await flush();
  assert.equal(h.result.current?.detail?.status, "awaiting_confirm", "计划门改 run 状态");
  h.unmount();
});

test("④ regenerate 后 attempt+1(局部更新);action 失败透出错误条", async () => {
  const h = renderHook(() => useAgentRun("r1"));
  await flush();
  agentImpl.agentTaskAction = async (_r, tid) =>
    makeAgentTask(tid, { attempt: 1, status: "queued" });
  await h.result.current!.taskAction("t1", "regenerate", { guidance: "发色保持一致" });
  await flush();
  const t1 = h.result.current?.detail?.plan.find((t) => t.id === "t1");
  assert.equal(t1?.attempt, 1, "attempt+1");
  assert.equal(t1?.status, "queued");
  assert.equal(agentCalls.agentTaskAction, 1);
  assert.equal(h.result.current?.busy["task:t1:regenerate"], false, "busy 复位");

  // 失败:透出规范中文错误条(原始 message 留 console) + 重抛 + busy 复位
  agentImpl.agentTaskAction = () => Promise.reject(new Error("GPU 排队已满"));
  await assert.rejects(h.result.current!.taskAction("t1", "approve"), /GPU 排队已满/);
  await flush();
  assert.match(h.result.current?.error ?? "", /任务操作失败,请稍后重试/);
  assert.equal(h.result.current?.busy["task:t1:approve"], false);
  h.unmount();
});

test("⑤ SSE 断线 → reconnecting 提示;连续 5 次全败 → 转轮询详情", async () => {
  const h = renderHook(() => useAgentRun("r1", { reconnectBaseMs: 1, pollIntervalMs: 5 }));
  await flush();
  const es1 = FakeEventSource.instances[0];
  es1.emit("error"); // 网络层断线(无 data)
  await flush();
  assert.equal(h.result.current?.sseState, "reconnecting", "断线提示重连中");
  assert.equal(es1.closed, true, "旧连接已关闭");

  // 继续重连,直至连续失败超限(初次 + 5 次重连共 6 个连接)
  for (let i = 1; i < 6; i++) {
    await sleep(30); // 等退避后重建
    const es = FakeEventSource.instances[i];
    assert.ok(es, `第 ${i + 1} 个连接存在`);
    es.emit("error");
  }
  await sleep(30);
  assert.equal(FakeEventSource.instances.length, 6, "最多重建 5 次");
  assert.equal(h.result.current?.sseState, "polling", "超限后降级轮询");

  const before = agentCalls.getAgentRun;
  await sleep(30);
  assert.ok(agentCalls.getAgentRun > before, "轮询详情接口在跑");
  h.unmount();
});

test("⑥ 终态 run(done)不订阅 SSE,closed 且拉取成片", async () => {
  agentImpl.getAgentRun = async (id) => makeAgentRunDetail(id, { status: "done" });
  agentImpl.getAgentRunResult = async (id) => ({
    final_url: "/api/final.mp4",
    duration_sec: 30,
    tasks: makeAgentRunDetail(id).plan,
  });
  const h = renderHook(() => useAgentRun("r9"));
  await flush();
  assert.equal(h.result.current?.detail?.status, "done");
  assert.equal(h.result.current?.sseState, "closed", "终态不订阅");
  assert.equal(FakeEventSource.instances.length, 0, "未建立 EventSource");
  assert.equal(agentCalls.getAgentRunResult, 1, "拉取成片");
  assert.equal(h.result.current?.result?.final_url, "/api/final.mp4");
  h.unmount();
});

test("⑦ 确认门 approve 与取消:契约端点被调用,门随之关闭", async () => {
  // 有状态 mock:裁决后 run 恢复 running(对齐后端 resume 语义)
  let status: "awaiting_assembly" | "running" = "awaiting_assembly";
  agentImpl.getAgentRun = async (id) => makeAgentRunDetail(id, { status });
  agentImpl.resumeAgentRun = async () => {
    status = "running";
    return { ok: true };
  };
  const h = renderHook(() => useAgentRun("r1"));
  await flush();
  assert.equal(h.result.current?.assemblyGate, true, "awaiting_assembly 初载即开门");

  await h.result.current!.resume("assembly", "approve");
  await flush();
  assert.equal(agentCalls.resumeAgentRun, 1);
  assert.equal(h.result.current?.assemblyGate, false, "裁决后门关闭");

  // 计划门(走同一 /resume 端点,gate=plan)
  await h.result.current!.resume("plan", "approve");
  await flush();
  assert.equal(agentCalls.resumeAgentRun, 2);

  await h.result.current!.cancel();
  await flush();
  assert.equal(agentCalls.cancelAgentRun, 1);
  h.unmount();
});

test("⑧ plan 简报事件按 id 并回详情字段;计划门打开时拉全量详情", async () => {
  agentImpl.getAgentRun = async (id) =>
    makeAgentRunDetail(id, {
      status: "awaiting_confirm",
      plan: [makeAgentTask("t1", { input: { prompt: "雨夜" } }), makeAgentTask("t2")],
    });
  const h = renderHook(() => useAgentRun("r1"));
  await flush();
  const es = FakeEventSource.instances[0];
  es.emit("open");
  // plan 事件是简报(无 input/output 等详情字段)
  es.emit(
    "plan",
    JSON.stringify({
      tasks: [
        { id: "t1", kind: "video", title: "镜头 1", depends_on: [], status: "pending" },
        { id: "t3", kind: "audio", title: "配音", depends_on: ["t1"], status: "pending" },
      ],
    }),
  );
  await flush();
  const plan = h.result.current?.detail?.plan ?? [];
  assert.deepEqual(
    plan.map((t) => t.id),
    ["t1", "t3"],
    "成员/顺序以事件为准(t2 被删、新增 t3)",
  );
  assert.equal(plan[0]?.input?.prompt, "雨夜", "已有详情字段并回,未被简报清空");
  assert.equal(plan[1]?.title, "配音");

  // 计划门打开 → 拉全量详情(简报缺 input,确认门展示/编辑需要完整卡片)
  const before = agentCalls.getAgentRun;
  es.emit("confirm_required", JSON.stringify({ gate: "plan" }));
  await flush();
  assert.equal(h.result.current?.detail?.status, "awaiting_confirm");
  assert.ok(agentCalls.getAgentRun > before, "开门时拉全量详情");
  h.unmount();
});
