/**
 * trackJob 断线容错状态机(FSM 2.0)单测(node:test,无需 DOM):
 * ① 网络 error → 自动重连并最终收到 done resolve
 * ② 业务 error 带 data → 立即 reject 不重连
 * ③ 重连全败 → 轮询(lookup 单查)查到 done → resolve
 * ④ 轮询到 error → reject(无落库原因兜底「生成出错」)
 * ④+ 轮询到 error 且落库 job.error → reject 透出失败原因
 * ④++ 轮询到 canceled → reject「作业已中止」(终态不空转)
 * ⑤ 超时 → reject 且 register(null)
 * ⑥ 看门狗:streaming 静默超阈值 → 假死软重连(不计失败、不报"重连中")
 * ⑦ 看门狗:事件持续到达刷新计时,不误判假死
 * ⑧ 看门狗:connecting 阶段 open 迟迟不到 → 按连接失败计入退避
 * ⑨ 重连快照窗:窗口内重复 progress/quality_warning 去重,新负载透传
 * ⑩ 冷启动失败分级:探针 401 → 立即终止报鉴权错误 + 广播会话失效
 * ⑪ 冷启动失败分级:探针 403 → 立即终止报鉴权错误
 * ⑫ 冷启动失败分级:探针异常/5xx → 按网络抖动走退避重连
 * ⑬ 会话失效事件:streaming 中收到 → 立即关流 reject
 * ⑭ 会话失效事件:降级轮询中收到 → 终止轮询 reject
 * ⑯ 外部 signal 中止:streaming 中 abort → 立即关流 reject(AbortError),不重连不轮询
 * ⑰ 外部 signal 中止:abort 幂等;已 aborted 的 signal 进入即 settle(不建连接)
 * ⑮ apiFetch 401 统一处理广播 SESSION_EXPIRED_EVENT(关流信号源;须最后跑,
 *    其内部幂等标记 authRedirectPending 一旦置位不可复位)
 * EventSource 用假实现,apiFetch 底层 fetch 用桩;退避/轮询/看门狗/超时经 opts 缩放成毫秒级。
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { apiFetch, SESSION_EXPIRED_EVENT } from "../lib/api";
import { trackJob, TrackJobAbortError } from "../lib/trackJob";
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
const realWindow = (globalThis as { window?: unknown }).window;

/** 最小 window 替身:EventTarget 提供事件收发;localStorage/location 供 api.ts 使用。 */
class FakeWindow extends EventTarget {
  readonly assignedUrls: string[] = [];
  readonly localStorage = {
    getItem: (_key: string): string | null => null,
    setItem: (_key: string, _value: string): void => undefined,
    removeItem: (_key: string): void => undefined,
  };
  readonly location = {
    assign: (url: string): void => {
      this.assignedUrls.push(url);
    },
  };
}

function installFakeWindow(): FakeWindow {
  const w = new FakeWindow();
  (globalThis as { window?: unknown }).window = w;
  return w;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  FakeEventSource.instances = [];
  jobsResponse = [];
  fetchCalls = [];
  (globalThis as { EventSource?: unknown }).EventSource =
    FakeEventSource as unknown as typeof EventSource;
  (globalThis as { window?: unknown }).window = realWindow;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    fetchCalls.push(url);
    // 降级轮询走 /api/jobs/lookup?prompt_id= 单查:命中返回单条,查不到 404(=仍在跑)
    if (url.includes("/api/jobs/lookup")) {
      const pid = new URL(url, "http://t").searchParams.get("prompt_id") ?? "";
      const job = jobsResponse.find((j) => j.prompt_id === pid) ?? null;
      if (!job) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(job), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(jobsResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
  (globalThis as { window?: unknown }).window = realWindow;
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
    fetchCalls.some((u) => u.includes("/api/jobs/lookup?prompt_id=pid-1")),
    "降级后按 lookup 单查轮询(不再全量扫描 200 条)",
  );
  assert.ok(
    fetchCalls.every((u) => !u.includes("/api/jobs?limit=200")),
    "降级轮询不得再扫全量作品列表(冷启动探针的 limit=1 除外)",
  );
});

test("④ 降级轮询查到 error(无落库原因)→ reject 兜底「生成出错」", async () => {
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

test("④+ 降级轮询查到 error 且落库 job.error → reject 透出失败原因(Wave-1)", async () => {
  jobsResponse = [
    {
      id: "j1",
      prompt_id: "pid-1",
      kind: "h3_t2v",
      status: "error",
      prompt: "",
      seed: 1,
      created_at: "",
      results: [],
      error: "采样器崩溃:CUDA out of memory",
    },
  ];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    maxReconnectAttempts: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
  });
  const rejection = assert.rejects(p, /采样器崩溃:CUDA out of memory/);

  FakeEventSource.instances[0].emit("error");
  await sleep(10);
  FakeEventSource.instances[1].emit("error");
  await sleep(10); // 进入轮询

  await rejection;
});

test("④++ 降级轮询查到 canceled → reject「作业已中止」(终态不空转)", async () => {
  jobsResponse = [
    {
      id: "j1",
      prompt_id: "pid-1",
      kind: "h3_t2v",
      status: "canceled",
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
  const rejection = assert.rejects(p, /作业已中止/);

  FakeEventSource.instances[0].emit("error");
  await sleep(10);
  FakeEventSource.instances[1].emit("error");
  await sleep(10);

  await rejection;
  const callsAtSettle = fetchCalls.length;
  await sleep(10);
  assert.equal(fetchCalls.length, callsAtSettle, "canceled 收尾后轮询定时器已清");
});

test("④a SSE done 带 post_status=processing → onPostProcessing 先于 resolve 触发", async () => {
  const calls: string[] = [];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    onPostProcessing: () => calls.push("post"),
  });
  const es1 = FakeEventSource.instances[0];
  es1.emit("open");
  es1.emit("done", JSON.stringify({ images: ["out/raw.mp4"], post_status: "processing" }));
  const paths = await p;
  calls.push("resolved");
  assert.deepEqual(paths, ["out/raw.mp4"], "resolve 的仍是当前(未裁)产物");
  assert.deepEqual(calls, ["post", "resolved"], "onPostProcessing 在 resolve 之前触发");
});

test("④b SSE done 无 post_status → 不触发 onPostProcessing", async () => {
  let hits = 0;
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    onPostProcessing: () => { hits += 1; },
  });
  const es1 = FakeEventSource.instances[0];
  es1.emit("open");
  es1.emit("done", JSON.stringify({ images: ["out/a.png"] }));
  assert.deepEqual(await p, ["out/a.png"]);
  assert.equal(hits, 0);
});

test("④c 降级轮询撞上裁切窗口期(post_status=processing)→ 同样触发 onPostProcessing", async () => {
  let hits = 0;
  jobsResponse = [
    {
      id: "j1",
      prompt_id: "pid-1",
      kind: "h3_t2v",
      status: "done",
      prompt: "",
      seed: 1,
      created_at: "",
      results: ["out/raw.mp4"],
      post_status: "processing",
    },
  ];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    maxReconnectAttempts: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    onPostProcessing: () => { hits += 1; },
  });

  FakeEventSource.instances[0].emit("error");
  await sleep(10); // 第 1 次重连
  FakeEventSource.instances[1].emit("error");
  await sleep(10); // 连续失败超限 → 降级轮询

  assert.deepEqual(await p, ["out/raw.mp4"]);
  assert.equal(hits, 1, "轮询对账命中 processing 同样通知一次");
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

test("⑥ 看门狗:streaming 静默超阈值 → 假死软重连(不计失败、不报重连中)", async () => {
  const attempts: number[] = [];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    watchdogMs: 30,
    onReconnecting: (a) => attempts.push(a),
  });

  const es1 = FakeEventSource.instances[0];
  es1.emit("open");
  es1.emit("progress", JSON.stringify({ value: 1, max: 10 }));

  // 看门狗 ~30ms 触发软重连;50ms 醒来时新连接已建、其看门狗(~60ms)未到,
  // 留出断言与 settle 余量,避免时序竞态
  await sleep(50);
  assert.equal(FakeEventSource.instances.length, 2, "看门狗触发重建 EventSource");
  assert.equal(es1.closed, true, "假死旧连接被主动关闭");
  assert.deepEqual(attempts, [], "软重连不计失败、不触发 onReconnecting");

  const es2 = FakeEventSource.instances[1];
  es2.emit("open");
  es2.emit("done", JSON.stringify({ images: ["out/wd.png"] }));
  assert.deepEqual(await p, ["out/wd.png"], "软重连后正常收 done");
});

test("⑦ 看门狗:事件持续到达刷新计时,不误判假死", async () => {
  const progresses: number[] = [];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    watchdogMs: 30,
    onProgress: (pr) => progresses.push(pr.pct),
  });

  const es1 = FakeEventSource.instances[0];
  es1.emit("open");
  for (let i = 1; i <= 4; i++) {
    await sleep(15); // 每 15ms 一帧,间隔 < 30ms 阈值
    es1.emit("progress", JSON.stringify({ value: i, max: 10 }));
  }
  assert.equal(FakeEventSource.instances.length, 1, "有事件流动时不触发重建");
  assert.deepEqual(progresses, [10, 20, 30, 40], "进度全部正常透传");

  es1.emit("done", JSON.stringify({ images: ["out/a.png"] }));
  assert.deepEqual(await p, ["out/a.png"]);
});

test("⑧ 看门狗:connecting 阶段 open 迟迟不到 → 按连接失败计入退避", async () => {
  const attempts: number[] = [];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    watchdogMs: 30,
    onReconnecting: (a) => attempts.push(a),
  });

  // 首个连接挂死:既不发 open 也不发任何事件。
  // 看门狗 ~30ms 触发;45ms 醒来时第 2 个连接已建、其看门狗(~61ms)未到,留出余量
  await sleep(45);
  assert.equal(FakeEventSource.instances.length, 2, "看门狗判定连接挂死后重建");
  assert.deepEqual(attempts, [1], "connecting 挂死计入失败并回调 onReconnecting");

  const es2 = FakeEventSource.instances[1];
  es2.emit("open");
  es2.emit("done", JSON.stringify({ images: ["out/hang.png"] }));
  assert.deepEqual(await p, ["out/hang.png"]);
});

test("⑨ 重连快照窗:窗口内重复 progress/quality_warning 去重,新负载透传", async () => {
  const progresses: number[] = [];
  const warnings: number[] = [];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    watchdogMs: 5_000,
    onProgress: (pr) => progresses.push(pr.pct),
    onQualityWarning: (w) => warnings.push(w.quality_score),
  });
  const warnPayload = JSON.stringify({
    total: 0.5,
    quality_score: 50,
    aesthetic: 0.5,
    technical: 0.5,
    prompt_alignment: 0.5,
    issues: ["偏暗"],
    suggested_prompt: null,
    degraded: false,
  });

  const es1 = FakeEventSource.instances[0];
  es1.emit("open");
  es1.emit("progress", JSON.stringify({ value: 5, max: 10 }));
  es1.emit("quality_warning", warnPayload);
  es1.emit("error"); // 网络断线(此前已收到 5/10 与该 warning)

  await sleep(10); // 退避 1ms 后重建
  const es2 = FakeEventSource.instances[1];
  assert.ok(es2, "断线后已重连");
  es2.emit("open"); // 重连 open → armed 500ms 快照窗
  es2.emit("progress", JSON.stringify({ value: 5, max: 10 })); // 回放重复 → 丢弃
  es2.emit("quality_warning", warnPayload); // 回放重复 → 丢弃
  es2.emit("progress", JSON.stringify({ value: 6, max: 10 })); // 新负载 → 透传
  es2.emit("done", JSON.stringify({ images: ["out/b.png"] }));

  assert.deepEqual(await p, ["out/b.png"]);
  assert.deepEqual(progresses, [50, 60], "窗口内重复进度被去重,新进度透传");
  assert.deepEqual(warnings, [50], "窗口内重复告警被去重(防重复 toast)");
});

test("⑩ 冷启动失败分级:探针 401 → 立即终止报鉴权错误 + 广播会话失效", async () => {
  const win = installFakeWindow();
  let sessionEvents = 0;
  win.addEventListener(SESSION_EXPIRED_EVENT, () => {
    sessionEvents += 1;
  });
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    fetchCalls.push(String(input));
    return new Response("{}", { status: 401 });
  }) as typeof fetch;

  const p = trackJob(RES, { reconnectBaseMs: 1, pollIntervalMs: 1, timeoutMs: 5_000 });
  const rejection = assert.rejects(p, /登录状态已失效,请重新登录/);

  FakeEventSource.instances[0].emit("error"); // 第 1 次失败:直接退避,不探针
  await sleep(10);
  FakeEventSource.instances[1].emit("error"); // 第 2 次连续失败 → 探针 401

  await rejection;
  await sleep(15);
  assert.equal(FakeEventSource.instances.length, 2, "凭据无效不再重连");
  assert.equal(sessionEvents, 1, "向其他在途 trackJob 广播了会话失效");
  assert.ok(
    fetchCalls.every((u) => !u.includes("limit=200")),
    "凭据无效不降级轮询(仅有探针请求)",
  );
});

test("⑪ 冷启动失败分级:探针 403 → 立即终止报鉴权错误", async () => {
  installFakeWindow();
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    fetchCalls.push(String(input));
    return new Response("{}", { status: 403 });
  }) as typeof fetch;

  const p = trackJob(RES, { reconnectBaseMs: 1, pollIntervalMs: 1, timeoutMs: 5_000 });
  const rejection = assert.rejects(p, /登录状态已失效,请重新登录/);

  FakeEventSource.instances[0].emit("error");
  await sleep(10);
  FakeEventSource.instances[1].emit("error"); // 探针 403

  await rejection;
  await sleep(15);
  assert.equal(FakeEventSource.instances.length, 2, "403 同样立即终止,不重连不降级");
});

test("⑫ 冷启动失败分级:探针异常/5xx → 按网络抖动走退避重连", async () => {
  globalThis.fetch = (async (): Promise<Response> => {
    throw new Error("network down");
  }) as typeof fetch;
  const attempts: number[] = [];
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    onReconnecting: (a) => attempts.push(a),
  });

  FakeEventSource.instances[0].emit("error"); // 第 1 次失败:直接退避
  await sleep(10);
  FakeEventSource.instances[1].emit("error"); // 第 2 次连续失败 → 探针自身失败 → 抖动
  await sleep(15);

  assert.equal(FakeEventSource.instances.length, 3, "抖动判定后照常退避重建");
  assert.deepEqual(attempts, [1, 2], "抖动失败正常计入重连次数");

  const es3 = FakeEventSource.instances[2];
  es3.emit("open");
  es3.emit("done", JSON.stringify({ images: ["out/jitter.png"] }));
  assert.deepEqual(await p, ["out/jitter.png"]);
});

test("⑬ 会话失效事件:streaming 中收到 → 立即关流并 reject 鉴权错误", async () => {
  const win = installFakeWindow();
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    watchdogMs: 5_000,
  });
  const rejection = assert.rejects(p, /登录状态已失效,请重新登录/);

  const es1 = FakeEventSource.instances[0];
  es1.emit("open");
  win.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)); // 全局登出/401 广播

  await rejection;
  assert.equal(es1.closed, true, "EventSource 已显式关闭");
  await sleep(15);
  assert.equal(FakeEventSource.instances.length, 1, "关流后不再重连");
});

test("⑭ 会话失效事件:降级轮询中收到 → 终止轮询并 reject", async () => {
  const win = installFakeWindow();
  jobsResponse = []; // 查不到作业:按「仍在跑」持续轮询
  const p = trackJob(RES, {
    reconnectBaseMs: 1,
    maxReconnectAttempts: 1,
    pollIntervalMs: 5,
    timeoutMs: 5_000,
  });
  const rejection = assert.rejects(p, /登录状态已失效,请重新登录/);

  FakeEventSource.instances[0].emit("error");
  await sleep(10); // 第 1 次重连
  FakeEventSource.instances[1].emit("error");
  await sleep(15); // 连续失败超限 → 已进入轮询

  win.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  await rejection;
  const callsAtSettle = fetchCalls.length;
  assert.ok(callsAtSettle > 0, "关流前确已发起轮询");
  await sleep(20);
  assert.equal(fetchCalls.length, callsAtSettle, "关流后轮询定时器已清");
});

/* ── 外部中止(opts.signal):用户取消/卸载场景,立即关流 settle ──
   回归锚点:此前只 close EventSource 不会让 trackJob 的 Promise 落定
   (close 后无事件到达,看门狗还会软重连复活跟踪),await 方(useGeneration.start
   → 视图 finally)永久挂起,submitting 卡死。 */

test("⑯ 外部 signal 中止:streaming 中 abort → 立即关流 reject(AbortError),不重连不轮询", async () => {
  const ac = new AbortController();
  const registered: unknown[] = [];
  const p = trackJob(RES, {
    signal: ac.signal,
    reconnectBaseMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    watchdogMs: 50, // 缩小看门狗:若 abort 未生效,软重连会复活连接,用例能抓到
    register: (es) => registered.push(es),
  });
  const rejection = assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof TrackJobAbortError, "中止错误应为 TrackJobAbortError");
    assert.equal((e as Error).name, "AbortError");
    return true;
  });

  const es1 = FakeEventSource.instances[0];
  es1.emit("open");
  ac.abort(); // 用户点「取消」/ 组件卸载

  await rejection;
  assert.equal(es1.closed, true, "abort 后 EventSource 已显式关闭");
  assert.equal(registered.at(-1), null, "终态时 register(null) 交还句柄");
  await sleep(80); // 越过看门狗窗口
  assert.equal(FakeEventSource.instances.length, 1, "abort 后看门狗不得软重连复活跟踪");
  assert.equal(fetchCalls.length, 0, "abort 后不降级轮询");
});

test("⑰ 外部 signal 中止:abort 幂等(重复 abort 无副作用);已 aborted 的 signal 进入即 settle", async () => {
  // 重复 abort:第二次不得再触发任何动作
  const ac1 = new AbortController();
  const p1 = trackJob(RES, { signal: ac1.signal, reconnectBaseMs: 1, pollIntervalMs: 1, timeoutMs: 5_000 });
  const rejection1 = assert.rejects(p1, TrackJobAbortError);
  ac1.abort();
  ac1.abort();
  await rejection1;
  assert.equal(FakeEventSource.instances.length, 1, "首次 abort 前建立的连接被关闭,无新增");
  assert.equal(FakeEventSource.instances[0].closed, true);

  // 调用前就 aborted:不建连接,立即 settle
  const ac2 = new AbortController();
  ac2.abort();
  const p2 = trackJob(RES, { signal: ac2.signal, reconnectBaseMs: 1, pollIntervalMs: 1, timeoutMs: 5_000 });
  await assert.rejects(p2, TrackJobAbortError);
  assert.equal(FakeEventSource.instances.length, 1, "已 aborted 的 signal 不再建立 EventSource");
});

// ⚠️ 本用例须最后跑:apiFetch 的 401 统一处理内置幂等标记(authRedirectPending),
// 一旦触发不可复位,若提前跑会影响其他用例的 401 路径。
test("⑮ apiFetch 401 统一处理广播 SESSION_EXPIRED_EVENT(关流信号源)", async () => {  const win = installFakeWindow();
  let fired = 0;
  win.addEventListener(SESSION_EXPIRED_EVENT, () => {
    fired += 1;
  });
  globalThis.fetch = (async (): Promise<Response> => new Response("{}", { status: 401 })) as typeof fetch;

  const res = await apiFetch("/api/jobs", {});
  assert.equal(res.status, 401);
  assert.equal(fired, 1, "401 触发会话失效广播(trackJob 据此关流)");
  assert.deepEqual(win.assignedUrls, ["/"], "401 仍跳转登录入口(既有行为不变)");
});
