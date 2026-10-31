"use client";

/**
 * R18 全局内容模式(web 薄壳遗留开关)。
 *
 * 开关 UI 已撤出 web 薄壳(由 canvas 设置页负责切换);本模块保留键名与广播,
 * 无人引用时可整文件删除。后端 app.redline 只做审计口径,不按 X-NSFW 头
 * 放行或拦截任何请求(BACKEND_RUNTIME_GATE=False)。
 *
 * - 状态持久化在 localStorage(toiv_r18_mode),调用方用 initR18Mode 恢复;
 * - 开启即 setNsfwIntent(true) → 全站请求带 X-NSFW 头(后端仅审计打标);
 * - 切换时清三族缓存键(models/local-models/jobs 及其 :nsfw 变体),防 SWR 缓存污染;
 * - 广播 toiv:r18-changed 事件,订阅方按需重拉数据。
 *
 * 内容可见性限制只来自 @content-lock 策略;本文件不含任何限制逻辑。
 */
import { useEffect, useState } from "react";

import { setNsfwIntent } from "@/lib/api";
import { useCrossTabSync } from "@/lib/crossTab";
import { invalidatePrefix } from "@/lib/swr-cache";

const R18_MODE_KEY = "toiv_r18_mode";
export const R18_CHANGED_EVENT = "toiv:r18-changed";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/** 当前是否 R18 模式(读 localStorage;SSR/无窗口恒 false)。 */
export function isR18Mode(): boolean {
  return hasWindow() && window.localStorage.getItem(R18_MODE_KEY) === "1";
}

/** 清 R18 敏感缓存:三个键族各有「主键 + :nsfw 键」,前缀失效一次覆盖。 */
function invalidateR18Caches(): void {
  invalidatePrefix("models");
  invalidatePrefix("local-models");
  invalidatePrefix("jobs");
}

/** 切换 R18 模式:持久化 + 请求头联动 + 缓存全清 + 事件广播。 */
export function setR18Mode(on: boolean): void {
  if (!hasWindow()) return;
  if (on) window.localStorage.setItem(R18_MODE_KEY, "1");
  else window.localStorage.removeItem(R18_MODE_KEY);
  setNsfwIntent(on);
  invalidateR18Caches();
  window.dispatchEvent(new CustomEvent(R18_CHANGED_EVENT, { detail: { on } }));
}

/**
 * 应用初始化时恢复模式(fetchMe 前调用):仅同步请求头标记,
 * 不清缓存不广播(首屏 SWR 会按 :nsfw 键自然隔离,无旧数据可污染)。
 */
export function initR18Mode(): void {
  setNsfwIntent(isR18Mode());
}

/** React hook:订阅模式状态,返回 [enabled, setEnabled]。 */
export function useR18Mode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(false);
  useEffect(() => {
    setOn(isR18Mode());
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ on?: boolean }>).detail;
      setOn(typeof detail?.on === "boolean" ? detail.on : isR18Mode());
    };
    window.addEventListener(R18_CHANGED_EVENT, handler);
    return () => window.removeEventListener(R18_CHANGED_EVENT, handler);
  }, []);
  // P1-8 跨标签页同步:他页切换 R18 → 本页同步开关态 + X-NSFW 请求头 + 清敏感缓存
  // (不再广播 CustomEvent——本页 state 已直接更新,且他页事件不应回灌本页事件流)
  useCrossTabSync(R18_MODE_KEY, (newValue) => {
    // storage 事件触发时 localStorage 已是新值,直接按事件值对齐本页状态
    const next = newValue === "1";
    setNsfwIntent(next);
    invalidateR18Caches();
    setOn(next);
  });
  return [on, setR18Mode];
}
