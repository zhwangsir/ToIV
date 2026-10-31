"use client";

import { useEffect, useRef } from "react";

export interface UsePollOptions {
  /** 基础轮询间隔(ms)。 */
  intervalMs: number;
  /** false 时不发任何请求(定时器也不起)。 */
  enabled: boolean;
  /** 连续失败时指数退避:间隔 ×1.5,上限 30s,成功后重置。默认 false。 */
  backoff?: boolean;
  /** enabled 变 true 时是否立即触发一次(默认 true)。 */
  immediate?: boolean;
}

/** 退避间隔上限(ms) */
const BACKOFF_MAX_MS = 30_000;
/** 退避倍率 */
const BACKOFF_FACTOR = 1.5;

/**
 * 通用轮询 hook:按 intervalMs 周期执行 fn(Promise 或同步函数)。
 *
 * 行为:
 * - 页面隐藏(document.hidden)时暂停;恢复可见时立即触发一次再继续计时;
 * - backoff=true 时连续失败间隔 ×1.5(上限 30s),任意一次成功后重置回 intervalMs;
 * - fn 变更不重启计时(内部持 ref);组件卸载或 enabled=false 时清理定时器;
 * - 上一次调用未返回时不重入(避免慢请求叠加)。
 */
export function usePoll(
  fn: () => Promise<unknown> | void,
  { intervalMs, enabled, backoff = false, immediate = true }: UsePollOptions,
): void {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    if (!enabled) return;

    let timer: number | null = null;
    let cancelled = false;
    let inFlight = false;
    let failCount = 0;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const nextDelay = () =>
      backoff
        ? Math.min(intervalMs * Math.pow(BACKOFF_FACTOR, failCount), BACKOFF_MAX_MS)
        : intervalMs;

    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await fnRef.current();
        failCount = 0;
      } catch {
        failCount += 1;
      } finally {
        inFlight = false;
      }
      if (!cancelled && !document.hidden) {
        timer = window.setTimeout(() => void tick(), nextDelay());
      }
    };

    const schedule = () => {
      clearTimer();
      timer = window.setTimeout(() => void tick(), nextDelay());
    };

    // 恢复可见:立即触发一次;转入隐藏:暂停计时
    const onVisibility = () => {
      if (cancelled) return;
      if (document.hidden) {
        clearTimer();
      } else {
        clearTimer();
        void tick();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (immediate) {
      void tick();
    } else {
      schedule();
    }

    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, backoff, immediate]);
}
