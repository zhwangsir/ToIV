/**
 * 极简 hook 渲染器:在无 DOM 的 node:test 环境里驱动自定义 React hook。
 * 仅实现 useState / useCallback / useEffect / useRef(被测 hook 用到的四个),
 * 通过 React 19 共享内部的 H(Hooks dispatcher)注入自制 dispatcher。
 *
 * 语义与 React 近似、对单测够用:
 * - setState 触发微任务批量重渲染;
 * - passive effect 在每次渲染结束后同步执行(deps 变化才重跑);
 * - unmount 执行所有 effect cleanup。
 */
import React from "react";

interface ReactInternals {
  H: unknown;
}
const internals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactInternals;
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

interface HookSlot {
  value?: unknown;
  set?: (next: unknown) => void;
  deps?: readonly unknown[];
  effect?: () => void | (() => void);
  cleanup?: void | (() => void);
}

export interface HookHandle<R> {
  result: { current: R | null };
  unmount: () => void;
}

export function renderHook<R>(fn: () => R): HookHandle<R> {
  const slots: HookSlot[] = [];
  let cursor = 0;
  let pendingEffects: number[] = [];
  let scheduled = false;
  let mounted = true;
  const result: { current: R | null } = { current: null };
  const prevDispatcher = internals.H;

  const render = (): void => {
    if (!mounted) return;
    cursor = 0;
    pendingEffects = [];
    internals.H = dispatcher;
    try {
      result.current = fn();
    } finally {
      internals.H = prevDispatcher;
    }
    // passive effect:deps 变化的槽位依次重跑(先跑上一个 cleanup)
    for (const i of pendingEffects) {
      const slot = slots[i];
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = slot.effect?.();
    }
  };

  const scheduleRender = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };

  const dispatcher = {
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const i = cursor++;
      let slot = slots[i];
      if (!slot) {
        slot = {
          value: typeof initial === "function" ? (initial as () => unknown)() : initial,
        };
        slot.set = (next: unknown) => {
          const v =
            typeof next === "function" ? (next as (prev: unknown) => unknown)(slot.value) : next;
          if (Object.is(v, slot.value)) return;
          slot.value = v;
          scheduleRender();
        };
        slots[i] = slot;
      }
      return [slot.value, slot.set as (next: unknown) => void];
    },
    useCallback(cb: unknown, deps: readonly unknown[]): unknown {
      const i = cursor++;
      const slot = slots[i];
      if (
        slot?.deps &&
        deps.length === slot.deps.length &&
        deps.every((d, k) => Object.is(d, slot.deps?.[k]))
      ) {
        return slot.value;
      }
      slots[i] = { value: cb, deps };
      return cb;
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
      const i = cursor++;
      const slot = slots[i];
      const changed =
        !slot?.deps ||
        !deps ||
        deps.length !== slot.deps.length ||
        deps.some((d, k) => !Object.is(d, slot.deps?.[k]));
      if (changed) {
        slots[i] = { deps, effect };
        pendingEffects.push(i);
      }
    },
    useRef(initial: unknown): { current: unknown } {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: { current: initial } };
      return slots[i].value as { current: unknown };
    },
  };

  render();

  return {
    result,
    unmount: () => {
      if (!mounted) return;
      mounted = false;
      for (const slot of slots) {
        if (typeof slot.cleanup === "function") slot.cleanup();
      }
      internals.H = prevDispatcher;
    },
  };
}

/** 刷新:让微任务队列(批量重渲染 + mock Promise 链)全部排空。 */
export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
