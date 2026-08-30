/**
 * 冷层服务编排(service_orchestrator)前端封装 ——「服务唤醒中」UX 数据源。
 *
 * 后端契约(apps/api/app/routes/orch.py + services/service_orchestrator.py):
 * - GET  /api/orch/services            → { services: { name: {status,...} } }(仅 admin)
 * - POST /api/orch/services/{name}/wake → 手动唤醒(登录用户即可,幂等)
 * - 冷层业务端点(train/i2l/lipsync/hy3dtex)在 ensure_awake 失败时返回
 *   503 + detail「冷层服务 {name} 唤醒失败:{原因}」。
 *
 * 前端策略:业务页捕获该 503 模式 → 显示 ServiceWakeOverlay;overlay 经
 * useOrchStatus 轮询(10s,页面聚焦时)跟踪 waking → running 自动消失。
 */
import { useCallback, useEffect, useRef, useState } from "react";

// 用相对路径 ./api 而非 @/lib/api:tests/loader.mjs 只映射 @/lib/api 到 mock,
// 相对路径拿到的是真实实现(apiFetch + authHeaders),与其他 lib 模块同口径。
import { apiFetch, authHeaders } from "./api";

// ── 类型 ─────────────────────────────────────────────────────────

export type OrchServiceStatus = "running" | "waking" | "sleeping" | "stopped" | "error";

export interface OrchService {
  name: string;
  status: OrchServiceStatus;
  last_error?: string;
  last_request_at?: string;
  wake_count?: number;
  stop_count?: number;
}

export interface OrchServicesResponse {
  services: Record<string, OrchService> | OrchService[];
}

/** 冷层服务中文名(overlay 展示用)。 */
export const ORCH_SERVICE_LABELS: Record<string, string> = {
  i2l: "图像理解",
  trainer: "训练服务",
  lipsync: "对口型",
  hy3dtex: "3D 纹理",
};

// ── API 封装 ─────────────────────────────────────────────────────

/** 拉取全部编排服务状态;非 admin(403)或失败时抛出,由调用方兜底。 */
export async function listOrchServices(): Promise<Record<string, OrchService>> {
  const res = await apiFetch("/api/orch/services", { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`获取服务状态失败 (${res.status})`);
  }
  const body = (await res.json()) as OrchServicesResponse;
  const raw = body?.services;
  // 兼容 dict 与 list 两种形态(注册表实现按配置层返回,可能变化)
  const map: Record<string, OrchService> = {};
  if (raw && !Array.isArray(raw)) {
    for (const [name, svc] of Object.entries(raw)) {
      map[name] = { ...svc, name: svc.name || name };
    }
  } else if (Array.isArray(raw)) {
    for (const svc of raw) {
      if (svc?.name) map[svc.name] = svc;
    }
  }
  return map;
}

/** 手动唤醒冷服务(sleeping/stopped/error → waking → running,幂等)。 */
export async function wakeService(name: string): Promise<{ status: OrchServiceStatus }> {
  const res = await apiFetch(`/api/orch/services/${encodeURIComponent(name)}/wake`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(detail?.detail || `唤醒失败 (${res.status})`);
  }
  return res.json();
}

// ── 503 冷层唤醒失败模式捕获 ──────────────────────────────────────

/**
 * 从错误消息中提取冷层服务名:匹配后端 ensure_awake 503 契约
 * 「冷层服务 {name} 唤醒失败:{原因}」;同时兼容「{name} 服务未就绪」变体。
 * 返回 null 表示非冷层唤醒错误,不应显示唤醒 UI。
 */
export function parseWakeError(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (!msg) return null;
  // 503 契约:冷层服务 lipsync 唤醒失败:systemctl start xxx 失败…
  let m = msg.match(/冷层服务\s+([a-z0-9_-]+)\s+唤醒失败/i);
  if (m) return m[1];
  // 兜底变体:xxx 服务未就绪 / waking / not ready
  m = msg.match(/([a-z0-9_-]+)\s+服务未就绪/i);
  if (m) return m[1];
  if (/\b(waking|not ready)\b/i.test(msg)) {
    // 消息含 waking/not ready 但没点名服务时,尝试提取首个已知冷层名
    for (const name of Object.keys(ORCH_SERVICE_LABELS)) {
      if (msg.includes(name)) return name;
    }
  }
  return null;
}

/** 判断一个错误是否是冷层 503 唤醒失败(可显示唤醒 overlay)。 */
export function isWakeError(err: unknown): boolean {
  return parseWakeError(err) !== null;
}

// ── useOrchStatus hook ──────────────────────────────────────────

export interface UseOrchStatusResult {
  /** 全部服务状态 map(name → service);未加载或失败时为 null。 */
  services: Record<string, OrchService> | null;
  /** 某服务是否正在 waking(或 sleeping/stopped/error 且被标记为需要唤醒)。 */
  isWaking: (name: string) => boolean;
  /** 某服务当前状态;未知返回 null。 */
  statusOf: (name: string) => OrchServiceStatus | null;
  /** 手动唤醒指定服务(返回 promise,成功 resolve 新状态)。 */
  wake: (name: string) => Promise<void>;
  /** 最近一次轮询错误(网络/403 等,用于 overlay 降级展示)。 */
  pollError: string | null;
  /** 是否具备轮询权限(403 时置 false,停止轮询)。 */
  canPoll: boolean;
}

const POLL_INTERVAL_MS = 10_000;
// 测试环境(node --test)进程保活敏感:轮询定时器必须 unref,否则阻止进程退出。
// 浏览器环境下 unref 是 no-op。

/**
 * 轮询编排服务状态(10s,仅页面聚焦时)。
 * 普通用户 GET /api/orch/services 返回 403 → 停止轮询(canPoll=false),
 * overlay 退化为「只根据 503 错误显示,不跟踪进度」。
 */
export function useOrchStatus(): UseOrchStatusResult {
  const [services, setServices] = useState<Record<string, OrchService> | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [canPoll, setCanPoll] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortedRef = useRef(false);

  const fetchOnce = useCallback(async () => {
    try {
      const map = await listOrchServices();
      if (abortedRef.current) return;
      setServices(map);
      setPollError(null);
      setCanPoll(true);
    } catch (e) {
      if (abortedRef.current) return;
      const msg = e instanceof Error ? e.message : "轮询失败";
      // 403(非 admin)= 无权限,停止轮询但不清空已缓存状态
      if (msg.includes("(403)")) {
        setCanPoll(false);
      } else {
        setPollError(msg);
      }
    }
  }, []);

  useEffect(() => {
    abortedRef.current = false;
    if (!canPoll) return;

    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return; // 页面隐藏时暂停,聚焦后下一轮恢复
      }
      void fetchOnce();
    };
    tick();
    // 链式 setTimeout(每次执行后重排)而非 setInterval:测试环境 node:test
    // 对 setInterval 更敏感(残留即 hang),且能严格对齐「页面聚焦时轮询」语义。
    const schedule = () => {
      const t = setTimeout(() => {
        tick();
        if (!abortedRef.current) schedule();
      }, POLL_INTERVAL_MS);
      timerRef.current = t;
      // node --test 环境下 unref 定时器,避免阻止进程退出
      if (typeof t === "object" && typeof (t as { unref?: () => void }).unref === "function") {
        (t as { unref: () => void }).unref();
      }
    };
    schedule();
    return () => {
      abortedRef.current = true;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [canPoll, fetchOnce]);

  useEffect(() => {
    return () => {
      abortedRef.current = true;
    };
  }, []);

  const isWaking = useCallback(
    (name: string) => services?.[name]?.status === "waking",
    [services],
  );
  const statusOf = useCallback(
    (name: string) => services?.[name]?.status ?? null,
    [services],
  );

  const wake = useCallback(
    async (name: string) => {
      const r = await wakeService(name);
      // 手动唤醒成功后立即刷新状态(不等下一轮轮询)
      setServices((prev) =>
        prev
          ? { ...prev, [name]: { ...prev[name], name, status: r.status } }
          : { [name]: { name, status: r.status } },
      );
    },
    [],
  );

  return { services, isWaking, statusOf, wake, pollError, canPoll };
}
