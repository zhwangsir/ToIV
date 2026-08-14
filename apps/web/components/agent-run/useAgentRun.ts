"use client";

/**
 * Agent Team 详情页状态管理(useAgentRun):
 * - detail:run 详情(计划 DAG + 全任务卡片),首屏 GET 拉取;
 * - events:事件汇报流(四态:开始/阻塞/需决策/完成 + plan/verdict),时间倒序;
 * - sseState:SSE 连接态(connecting/open/reconnecting/polling/closed),
 *   断线退避重连 ≤5 次,全败转 5s 轮询详情接口(轮询降级);
 * - assemblyGate:合成确认门(confirm_required 事件 / awaiting_assembly 状态驱动);
 * - 操作:savePlan(计划编辑)/ resume(确认门裁决)/ taskAction(卡片干预)/ cancel,
 *   全部经 withBusy 透出错误,禁止静默。
 *
 * 注:为兼容 tests/helpers/renderHook 极简渲染器(仅 useState/useCallback/useEffect),
 *     本 hook 不用 useRef/useMemo;可变句柄(事件自增序号)放在惰性 state 盒子里。
 */
import { useCallback, useEffect, useState } from "react";
import {
  agentRunEventsUrl,
  agentTaskAction,
  cancelAgentRun,
  getAgentRun,
  getAgentRunResult,
  resumeAgentRun,
  updateAgentRunPlan,
  type AgentPlanEditOp,
  type AgentResumeBody,
  type AgentRunDetail,
  type AgentRunResult,
  type AgentRunTask,
  type AgentTaskActionBody,
} from "@/lib/api";
import { RUN_TERMINAL, taskStatusMeta } from "./agentRunMeta";

/** SSE 连接态。 */
export type SseState = "connecting" | "open" | "reconnecting" | "polling" | "closed";

/** 事件流条目(tone 四态 + info/error)。 */
export interface AgentRunEventItem {
  id: number;
  ts: number;
  type: string;
  text: string;
  tone: "start" | "blocked" | "decision" | "done" | "info" | "error";
}

export interface UseAgentRunOptions {
  /** 断连降级轮询间隔(ms,默认 5000;测试可缩放)。 */
  pollIntervalMs?: number;
  /** 重连退避基数(ms,默认 1000)。 */
  reconnectBaseMs?: number;
  /** 最大连续重连次数(默认 5)。 */
  maxReconnectAttempts?: number;
}

interface SubscribeOptions {
  onEvent: (type: string, data: Record<string, unknown>) => void;
  onStateChange?: (state: SseState, attempt?: number) => void;
  reconnectBaseMs?: number;
  maxReconnectAttempts?: number;
}

/** 业务事件类型(契约 §1.3.3;error 单独处理:带 data=业务终态,无 data=网络断线)。 */
const BUSINESS_EVENTS = [
  "ack",
  "plan",
  "task_status",
  "verdict",
  "confirm_required",
  "blocked",
  "decision_required",
  "done",
] as const;

/**
 * 订阅 run 的 SSE 事件流(韧性思想同 lib/trackJob.ts):
 * 网络断线(无 data 的 error)→ 指数退避重连,open 后计数清零;
 * 连续失败超 maxReconnectAttempts → onStateChange("polling"),由调用方降级轮询;
 * done / 带 data 的 error(业务终态)→ 主动关闭,不再重连(终态后服务端也会关流)。
 * 返回关闭函数(组件卸载时调用)。
 */
export function subscribeAgentRunEvents(
  runId: string,
  opts: SubscribeOptions,
): () => void {
  const maxReconnect = opts.maxReconnectAttempts ?? 5;
  const baseMs = opts.reconnectBaseMs ?? 1_000;
  let es: EventSource | null = null;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const close = (): void => {
    closed = true;
    if (es) {
      es.close();
      es = null;
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };

  const onNetworkDrop = (): void => {
    if (closed) return;
    if (es) {
      es.close();
      es = null;
    }
    if (reconnectAttempt >= maxReconnect) {
      // 连续重连全败 → 通知调用方降级轮询详情接口
      opts.onStateChange?.("polling");
      return;
    }
    reconnectAttempt += 1;
    opts.onStateChange?.("reconnecting", reconnectAttempt);
    // 指数退避:1/2/4/8s…封顶 10s
    const wait = Math.min(10_000, baseMs * 2 ** (reconnectAttempt - 1));
    reconnectTimer = setTimeout(connect, wait);
  };

  function connect(): void {
    if (closed) return;
    es = new EventSource(agentRunEventsUrl(runId));

    es.addEventListener("open", () => {
      reconnectAttempt = 0;
      opts.onStateChange?.("open");
    });

    for (const type of BUSINESS_EVENTS) {
      es.addEventListener(type, (e) => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
        } catch {
          /* 畸形分片按空载荷处理 */
        }
        opts.onEvent(type, data);
        if (type === "done") close(); // 终态:服务端随即关流,前端主动收,避免误重连
      });
    }

    es.addEventListener("error", (e) => {
      const data = (e as MessageEvent).data;
      // 带 data = 业务 error 事件(JSON)→ 终态,不重连
      if (data) {
        let parsed: Record<string, unknown> = { message: "运行出错" };
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          /* 保留默认 */
        }
        opts.onEvent("error", parsed);
        close();
        return;
      }
      // 无 data = 网络层断线 → 退避重连 / 超限降级
      onNetworkDrop();
    });
  }

  opts.onStateChange?.("connecting");
  connect();
  return close;
}

/** data 里取字符串字段(防御)。 */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 从 plan 事件载荷提取任务数组(兼容 {tasks:[...]} 与 {plan:{tasks:[...]}} 两种包法)。 */
function extractPlanTasks(data: Record<string, unknown>): AgentRunTask[] | null {
  const direct = data.tasks;
  if (Array.isArray(direct)) return direct as AgentRunTask[];
  const nested = data.plan;
  if (nested && typeof nested === "object") {
    const t = (nested as { tasks?: unknown }).tasks;
    if (Array.isArray(t)) return t as AgentRunTask[];
  }
  return null;
}

/** task_status 事件 → 合并进详情(仅更新载荷里出现的字段)。 */
function mergeTaskStatus(
  d: AgentRunDetail | null,
  data: Record<string, unknown>,
): AgentRunDetail | null {
  if (!d) return d;
  const tid = str(data.task_id) || str(data.id);
  if (!tid) return d;
  const plan = d.plan.map((t) => {
    if (t.id !== tid) return t;
    const next: AgentRunTask = { ...t };
    if (typeof data.status === "string" && data.status) {
      next.status = data.status as AgentRunTask["status"];
    }
    if (typeof data.attempt === "number") next.attempt = data.attempt;
    if (data.output && typeof data.output === "object") {
      next.output = data.output as Record<string, unknown>;
    }
    if (typeof data.verdict === "string") next.verdict = data.verdict;
    if (typeof data.gpu_hint === "string") next.gpu_hint = data.gpu_hint;
    return next;
  });
  return { ...d, plan };
}

export function useAgentRun(runId: string | null, opts: UseAgentRunOptions = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [events, setEvents] = useState<AgentRunEventItem[]>([]);
  const [sseState, setSseState] = useState<SseState>("connecting");
  const [assemblyGate, setAssemblyGate] = useState(false);
  /** 成片与产物清单(run 进入 done 后拉取)。 */
  const [result, setResult] = useState<AgentRunResult | null>(null);
  // 可变序号盒(事件 id 自增);惰性 state 保持引用不变,替代 useRef
  const [seq] = useState(() => ({ n: 0 }));

  const clearError = useCallback(() => setError(null), []);

  const pushEvent = useCallback(
    (type: string, text: string, tone: AgentRunEventItem["tone"]) => {
      setEvents((prev) =>
        [{ id: ++seq.n, ts: Date.now(), type, text, tone }, ...prev].slice(0, 100),
      );
    },
    [seq],
  );

  /** 拉详情;返回详情供调用方判断终态(polling 停止条件)。 */
  const refresh = useCallback(async (): Promise<AgentRunDetail | null> => {
    if (!runId) return null;
    try {
      const d = await getAgentRun(runId);
      setDetail(d);
      if (d.status === "awaiting_assembly") setAssemblyGate(true);
      return d;
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载任务详情失败");
      return null;
    }
  }, [runId]);

  // ── 首屏加载 + SSE 订阅(终态 run 不订阅,直接 closed)──
  useEffect(() => {
    if (!runId) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    /** 业务事件分发:合并进 detail / 开门 / 推事件流。 */
    const onEvent = (type: string, data: Record<string, unknown>): void => {
      switch (type) {
        case "ack":
          pushEvent("ack", str(data.ack) || "已接单,Leader 拆解中", "start");
          break;
        case "plan": {
          const tasks = extractPlanTasks(data);
          if (tasks) {
            setDetail((d) => (d ? { ...d, plan: tasks } : d));
          }
          pushEvent("plan", `计划已生成,共 ${tasks?.length ?? "?"} 步`, "info");
          break;
        }
        case "task_status": {
          setDetail((d) => mergeTaskStatus(d, data));
          const tid = str(data.task_id) || str(data.id);
          const status = str(data.status);
          const meta = taskStatusMeta(status);
          pushEvent(
            "task_status",
            `任务 ${tid} ${meta.label}`,
            status === "running"
              ? "start"
              : status === "done" || status === "approved"
                ? "done"
                : status === "error" || status === "rejected"
                  ? "error"
                  : "info",
          );
          break;
        }
        case "verdict": {
          setDetail((d) => mergeTaskStatus(d, data));
          pushEvent("verdict", `验收意见:${str(data.verdict) || "已出具"}`, "info");
          break;
        }
        case "confirm_required": {
          const gate = str(data.gate);
          if (gate === "assembly") {
            setAssemblyGate(true);
            pushEvent("confirm_required", "合成前确认门已打开,等你裁决", "decision");
          } else {
            setDetail((d) => (d ? { ...d, status: "awaiting_confirm" } : d));
            pushEvent("confirm_required", "计划确认门已打开,等你确认", "decision");
          }
          break;
        }
        case "blocked":
          pushEvent("blocked", `遇到阻塞:${str(data.message) || "等待资源"}`, "blocked");
          break;
        case "decision_required":
          pushEvent(
            "decision_required",
            `需要决策:${str(data.message) || "请查看任务卡片"}`,
            "decision",
          );
          break;
        case "done":
          setDetail((d) => (d ? { ...d, status: "done" } : d));
          pushEvent("done", "全部任务完成,成片已就绪", "done");
          setSseState("closed");
          break;
        case "error": {
          const msg = str(data.message) || "运行出错";
          setDetail((d) => (d ? { ...d, status: "error", error: msg } : d));
          pushEvent("error", msg, "error");
          setSseState("closed");
          break;
        }
      }
    };

    /** 降级轮询:5s 拉一次详情,终态即停。 */
    const startPolling = (): void => {
      if (pollTimer) return;
      const tick = async (): Promise<void> => {
        if (disposed) return;
        const d = await refresh();
        if (disposed) return;
        if (d && RUN_TERMINAL.has(d.status)) {
          pollTimer = null;
          setSseState("closed");
          return;
        }
        pollTimer = setTimeout(() => void tick(), pollIntervalMs);
      };
      pollTimer = setTimeout(() => void tick(), pollIntervalMs);
    };

    setLoading(true);
    void (async () => {
      const d = await refresh();
      if (disposed) return;
      setLoading(false);
      if (d && RUN_TERMINAL.has(d.status)) {
        setSseState("closed");
        return;
      }
      stop = subscribeAgentRunEvents(runId, {
        reconnectBaseMs: opts.reconnectBaseMs,
        maxReconnectAttempts: opts.maxReconnectAttempts,
        onEvent,
        onStateChange: (state) => {
          if (disposed) return;
          setSseState(state);
          if (state === "polling") startPolling();
        },
      });
    })();

    return () => {
      disposed = true;
      stop?.();
      if (pollTimer) clearTimeout(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, refresh, pollIntervalMs]);

  // ── 操作统一入口:失败透出 error 条并重抛(与 useStudioProject 同范式)──
  const withBusy = useCallback(
    async (key: string, label: string, fn: () => Promise<void>): Promise<void> => {
      setBusy((b) => ({ ...b, [key]: true }));
      try {
        await fn();
      } catch (e) {
        setError(`${label}失败:${e instanceof Error ? e.message : "未知错误"}`);
        throw e;
      } finally {
        setBusy((b) => ({ ...b, [key]: false }));
      }
    },
    [],
  );

  /** 保存计划编辑(增/删/改),成功后整体刷新。 */
  const savePlan = useCallback(
    (ops: AgentPlanEditOp[]) =>
      withBusy("plan", "保存计划", async () => {
        if (!runId) return;
        await updateAgentRunPlan(runId, ops);
        await refresh();
      }),
    [runId, withBusy, refresh],
  );

  /** 确认门裁决(plan/assembly × approve/modify/reject)。 */
  const resume = useCallback(
    (gate: AgentResumeBody["gate"], action: AgentResumeBody["action"], feedback?: string) =>
      withBusy(`resume:${gate}`, "提交裁决", async () => {
        if (!runId) return;
        await resumeAgentRun(runId, { gate, action, ...(feedback ? { feedback } : {}) });
        if (gate === "assembly") setAssemblyGate(false);
        await refresh();
      }),
    [runId, withBusy, refresh],
  );

  /** 卡片级干预:edit/regenerate/approve;成功后用返回的 task 局部更新(attempt 随之 +1)。 */
  const taskAction = useCallback(
    (tid: string, action: AgentTaskActionBody["action"], payload?: Record<string, unknown>) =>
      withBusy(`task:${tid}:${action}`, "任务操作", async () => {
        if (!runId) return;
        const res = await agentTaskAction(runId, tid, {
          action,
          ...(payload ? { payload } : {}),
        });
        if (res?.task) {
          setDetail((d) =>
            d ? { ...d, plan: d.plan.map((t) => (t.id === tid ? res.task : t)) } : d,
          );
        }
      }),
    [runId, withBusy],
  );

  /** 取消整个 run。 */
  const cancel = useCallback(
    () =>
      withBusy("cancel", "取消任务", async () => {
        if (!runId) return;
        await cancelAgentRun(runId);
        await refresh();
      }),
    [runId, withBusy, refresh],
  );

  /** 仅收起合成门弹层(不下裁决;refresh/事件会按状态重开)。 */
  const dismissAssemblyGate = useCallback(() => setAssemblyGate(false), []);

  // ── run 进入 done 后拉取成片(detail.status 由 SSE/轮询/refresh 驱动)──
  const isDone = detail?.status === "done";
  useEffect(() => {
    if (!runId || !isDone) return;
    let disposed = false;
    getAgentRunResult(runId)
      .then((r) => {
        if (!disposed) setResult(r);
      })
      .catch((e) => {
        if (!disposed) {
          setError(`加载成片失败:${e instanceof Error ? e.message : "未知错误"}`);
        }
      });
    return () => {
      disposed = true;
    };
  }, [runId, isDone]);

  return {
    detail,
    loading,
    error,
    busy,
    events,
    sseState,
    assemblyGate,
    result,
    clearError,
    refresh,
    savePlan,
    resume,
    taskAction,
    cancel,
    dismissAssemblyGate,
  };
}
