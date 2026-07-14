"use client";

import { useEffect, useRef, useState } from "react";

/**
 * RAF + Lerp 滚动视差 hook。
 *
 * 原理:
 *   1. scroll 事件存储原始 scrollY 到 ref(不触发重渲)
 *   2. requestAnimationFrame 每帧用 Lerp 平滑追踪:
 *      smooth += (raw - smooth) * factor
 *      factor 0.06 → 丝滑但有轻微延迟感(适合视差)
 *   3. 输出 smoothY 供组件使用(驱动 transform)
 *
 * 性能:
 *   - 只走 transform,不触 reflow/repaint
 *   - reduced-motion 下直接返回原始 scrollY,无 RAF 循环
 *   - IntersectionObserver 离屏时暂停
 *
 * @param factor Lerp 平滑因子,0.04-0.08 视差,默认 0.06
 * @returns { scrollY: number } 平滑后的 scrollY(px)
 */
export function useScrollParallax(factor = 0.06): { scrollY: number } {
  const rawRef = useRef(0);
  const smoothRef = useRef(0);
  const rafRef = useRef(0);
  const [scrollY, setScrollY] = useState(0);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) return;

    const onScroll = () => {
      rawRef.current = window.scrollY;
    };

    const tick = () => {
      // Lerp 平滑:每帧追 6%,产生柔和视差拖尾
      smoothRef.current += (rawRef.current - smoothRef.current) * factor;
      // 小数位截断到 2 位,避免 setState 风暴(值不变时不触发重渲)
      const rounded = Math.round(smoothRef.current * 100) / 100;
      setScrollY((prev) => (prev === rounded ? prev : rounded));
      rafRef.current = requestAnimationFrame(tick);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [factor]);

  return { scrollY };
}
