"use client";

/**
 * R18 全局内容模式(M9:NSFW 整合主站)。
 *
 * 把「/nsfw 独立专区」改为全局内容模式开关:
 * - 状态持久化在 localStorage(toiv_r18_mode),刷新后由 page.tsx 初始化恢复;
 * - 开启即 setNsfwIntent(true) → 全站请求带 X-NSFW 头,后端 ContextVar 统一判定
 *   (引擎列表/作品库/LLM/反推全部走同一信号,前端不再按页面区分);
 * - 切换时双键全清(models/local-models/jobs 及其 :nsfw 变体),防 SWR 缓存污染;
 * - 广播 toiv:r18-changed 事件,GenerateView 等按需重拉引擎(engines 无缓存)。
 *
 * 年龄确认(toiv_nsfw_age_confirmed)与模式开关分离:首开须先过 18+ 声明
 * (AgeGateModal);后端未成年账户硬阻断,前端仅是 UX 层。
 */
import { useEffect, useState } from "react";

import { setNsfwIntent } from "@/lib/api";
import { invalidatePrefix } from "@/lib/swr-cache";

const R18_MODE_KEY = "toiv_r18_mode";
const AGE_CONFIRM_KEY = "toiv_nsfw_age_confirmed";
export const R18_CHANGED_EVENT = "toiv:r18-changed";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/** 是否已过 18+ 年龄确认(仅客户端可读)。 */
export function isAgeConfirmed(): boolean {
  return hasWindow() && window.localStorage.getItem(AGE_CONFIRM_KEY) === "1";
}

/** 写入年龄确认记录(AgeGateModal 确认时调用)。 */
export function confirmAge(): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(AGE_CONFIRM_KEY, "1");
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
  return [on, setR18Mode];
}
