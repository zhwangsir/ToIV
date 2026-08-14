/**
 * trackJob 断线容错状态机单测(node:test,无需 DOM):
 * ① 网络 error → 自动重连并最终收到 done resolve
 * ② 业务 error 带 data → 立即 reject 不重连
 * ③ 重连全败 → 轮询查到 done → resolve
 * ④ 轮询到 error → reject
 * ⑤ 超时 → reject 且 register(null)
 * EventSource 用假实现,apiFetch 底层 fetch 用桩;退避/轮询/超时经 opts 缩放成毫秒级。
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { trackJob } from "../lib/trackJob";
import type { GenerateResponse, JobItem } from "../lib/types";

interface FakeEvent {
  data?: string;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
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
    this.readyState = 2;
  }

  /** 测试驱动:派发一个事件(data 省略 = 网络层 error)。 */
  emit(type: string, data?: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
}

const RES: GenerateResponse = { prompt_id: "pid-1", client_id: "c1", worker: "w1", seed: 1 };

/** 当前用例的 /api/jobs 轮询应答内容。 */
let jobsResponse: JobItem[] = [];
let fetchCalls: string[] = [];

const realFetch = globalThis.fetch;
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  FakeEventSource.instances = [];
  jobsResponse = [];
  fetchCalls = [];
  (globalThis as { EventSource?: unknown }).EventSource =
    FakeEventSource as unknown as typeof EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    fetchCalls.push(String(input));
    return new Response(JSON.stringify(jobsResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

test("① 网络断线(无 data error)→ 自动重连并最终 done resolve", async () => {
  const attempts: number[] = [];
  const registered: unknown[] = [];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000, // 兜底:用例异常时也不让 35min 默认超时拖住进程
    onReconnecting: (a) => attempts.push(a),
    register: (es) => registered.push(es),
  });

  const es1 = FakeEventSource.instances[0];
  assert.ok(es1, "首个 EventSource 已建立");
  es1.emit("error"); // 网络层断线

  await sleep(10); // 等退避(1ms)后重建
  assert.equal(FakeEventSource.instances.length, 2, "断线后重建了 EventSource");
  assert.equal(es1.closed, true, "旧连接已关闭");
  assert.deepEqual(attempts, [1], "onReconnecting 回调 attempt=1");

  const es2 = FakeEventSource.instances[1];
  es2.emit("open");
  es2.emit("progress", JSON.stringify({ value: 3, max: 10 }));
  es2.emit("done", JSON.stringify({ images: ["out/a.png", "out/b.png"] }));

  assert.deepEqual(await p, ["out/a.png", "out/b.png"]);
  assert.equal(registered.at(-1), null, "终态时 register(null) 交还句柄");
  assert.equal(fetchCalls.length, 0, "SSE 恢复后不触发轮询");
});

test("② 业务 error 带 data → 立即 reject,不重连不轮询", async () => {
  const p = trackJob(RES, { reconnectBaseMs: 1, pollIntervalMs: 1, timeoutMs: 5_000 });
  const rejection = assert.rejects(p, /显存不足,请稍后重试/);
  FakeEventSource.instances[0].emit("error", JSON.stringify({ message: "显存不足,请稍后重试" }));

  await rejection;
  await sleep(10);
  assert.equal(FakeEventSource.instances.length, 1, "业务错误不重连");
  assert.equal(fetchCalls.length, 0, "业务错误不轮询");
});

test("③ 重连连续全败 → 降级轮询查到 done → resolve 其 results", async () => {
  jobsResponse = [
    {
      id: "j1",
      prompt_id: "pid-1",
      kind: "txt2img",
      status: "done",
      prompt: "",
      seed: 1,
      created_at: "",
      results: ["out/poll-1.mp4"],
    },
  ];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    maxReconnectAttempts: 5,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
  });

  // 初次连接 + 5 次重连共 6 个连接,全部网络断线(第 6 次 error 后进入轮询)
  // 注意:退避为 1/2/4/8/16ms,每轮 sleep 需大于当次退避等待
  for (let i = 0; i < 6; i++) {
    const es = FakeEventSource.instances[i];
    assert.ok(es, `第 ${i + 1} 个连接存在`);
    es.emit("error");
    await sleep(30);
  }
  assert.equal(FakeEventSource.instances.length, 6, "最多重建 5 次后停止重连");

  assert.deepEqual(await p, ["out/poll-1.mp4"]);
  assert.ok(
    fetchCalls.some((u) => u.includes("/api/jobs?limit=200")),
    "降级后按作品列表端点轮询",
  );
});

test("④ 降级轮询查到 error → reject(生成出错)", async () => {
  jobsResponse = [
    {
      id: "j1",
      prompt_id: "pid-1",
      kind: "txt2img",
      status: "error",
      prompt: "",
      seed: 1,
      created_at: "",
      results: [],
    },
  ];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    maxReconnectAttempts: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
  });
  const rejection = assert.rejects(p, /生成出错/);

  FakeEventSource.instances[0].emit("error");
  await sleep(10); // 第 1 次重连
  FakeEventSource.instances[1].emit("error");
  await sleep(10); // 连续失败超限 → 轮询

  await rejection;
});

test("⑤ 轮询查不到作业 + 总超时 → reject 且 register(null)", async () => {
  jobsResponse = []; // 查不到 prompt_id:按「仍在跑」持续轮询,直到总超时
  const registered: unknown[] = [];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    maxReconnectAttempts: 1,
    pollIntervalMs: 1,
    timeoutMs: 40,
    register: (es) => registered.push(es),
  });
  const rejection = assert.rejects(p, /作业跟踪超时,请在作品库查看结果/);

  FakeEventSource.instances[0].emit("error");
  await sleep(10);
  FakeEventSource.instances[1].emit("error");
  await sleep(10); // 进入轮询,一直查不到

  await rejection;
  assert.equal(registered.at(-1), null, "超时收尾 register(null)");
  const callsAtSettle = fetchCalls.length;
  await sleep(10);
  assert.equal(fetchCalls.length, callsAtSettle, "settle 后轮询定时器已清");
});
