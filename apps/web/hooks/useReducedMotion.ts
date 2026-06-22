"use client";

import { useEffect, useState } from "react";

/**
 * 监听 prefers-reduced-motion。
 * - SSR/首帧默认 false(动画态),客户端挂载后同步真实值,避免 hydration 抖动。
 * - 返回 true 时:调用方应渲染静态帧、禁用公转/拖尾/错峰揭示。
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mql.matches);

    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
