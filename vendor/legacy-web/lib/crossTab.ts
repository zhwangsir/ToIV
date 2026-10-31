"use client";

/**
 * 跨标签页状态同步(P1-8)。
 *
 * 现状问题:R18 开关 / 登录态 / 主题只在本页内用 CustomEvent 广播,
 * 其他标签页感知不到 → A 页开 R18、B 页停留 SFW;A 页退出登录、B 页以为已登录。
 *
 * 本 hook 监听 window "storage" 事件(仅在他页改写同源 localStorage 时触发,
 * 本页 setItem 不触发),与既有 CustomEvent 机制并存:
 *   - 同页即时更新 → CustomEvent(如 toiv:r18-changed);
 *   - 跨页同步     → storage 事件 → 本 hook 回调。
 *
 * 注意:他页 localStorage.clear() 时事件 key 为 null,此时保守视为目标 key 被清除,
 * 以 newValue=null 回调(三个接入方 key 被清的语义都是「回到默认态」)。
 */
import { useEffect, useRef } from "react";

/**
 * 订阅指定 localStorage key 的跨标签页变更。
 * @param key      目标 key(如 toiv_token / toiv_r18_mode / toiv_theme)
 * @param onChange 他页改写该 key 时回调,newValue 为 null 表示被删除/clear
 */
export function useCrossTabSync(
  key: string,
  onChange: (newValue: string | null) => void,
): void {
  // ref 持有最新回调,避免调用方闭包过期导致重复挂监听
  const handlerRef = useRef(onChange);
  useEffect(() => {
    handlerRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const listener = (e: StorageEvent) => {
      // 只关心本窗口 localStorage 的变更(sessionStorage 不参与跨页共享)
      if (e.storageArea !== window.localStorage) return;
      // key 为 null = clear():保守按「目标 key 已清除」处理
      if (e.key === null) {
        handlerRef.current(null);
        return;
      }
      if (e.key !== key) return;
      handlerRef.current(e.newValue);
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, [key]);
}
