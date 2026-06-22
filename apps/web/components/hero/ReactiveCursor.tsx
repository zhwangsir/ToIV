"use client";

import { useEffect, useRef } from "react";

import { useReducedMotion } from "@/hooks/useReducedMotion";

/**
 * 克制的磁吸辉光光标(hero 局部增强):
 * - 柔光点(贴手)+ 缓随的拖尾环(lerp 滞后)。
 * - screen 合成 + 低透明,深底上绝不炸白。
 * - 不劫持系统箭头(精度保留);触屏 / reduced-motion 不渲染。
 * - 只写 transform/opacity,rAF 节流,零 React 重渲染。
 *
 * 注:全局已有 body 级 CursorGlow;本组件仅在 .engine-stage 容器内叠一层
 * 偏科幻的磁吸环,低透明以避免双光标互相干扰。
 */

const MAGNET_SELECTOR = ".orbit-node, .creation-core, button, a";

export function ReactiveCursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const fine = window.matchMedia("(pointer: fine)").matches;
    if (!fine) return;

    const dot = dotRef.current;
    const ring = ringRef.current;
    if (!dot || !ring) return;

    const target = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const dotPos = { ...target };
    const ringPos = { ...target };
    let raf = 0;
    let visible = false;
    let magnet: { x: number; y: number } | null = null;

    const onMove = (e: PointerEvent) => {
      target.x = e.clientX;
      target.y = e.clientY;
      if (!visible) {
        visible = true;
        dot.style.opacity = "1";
        ring.style.opacity = "1";
      }
      // 磁吸:指针靠近可交互元素时,环吸向其中心
      const el = (e.target as Element | null)?.closest?.(MAGNET_SELECTOR);
      if (el) {
        const r = el.getBoundingClientRect();
        magnet = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        ring.classList.add("is-magnet");
      } else {
        magnet = null;
        ring.classList.remove("is-magnet");
      }
    };
    const onLeave = () => {
      visible = false;
      dot.style.opacity = "0";
      ring.style.opacity = "0";
    };
    const onDown = () => ring.classList.add("is-down");
    const onUp = () => ring.classList.remove("is-down");

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const tick = () => {
      dotPos.x = lerp(dotPos.x, target.x, 0.32);
      dotPos.y = lerp(dotPos.y, target.y, 0.32);
      // 有磁吸目标时,环偏向目标中心(80% 吸附)
      const rx = magnet ? lerp(target.x, magnet.x, 0.8) : target.x;
      const ry = magnet ? lerp(target.y, magnet.y, 0.8) : target.y;
      ringPos.x = lerp(ringPos.x, rx, 0.14);
      ringPos.y = lerp(ringPos.y, ry, 0.14);
      dot.style.transform = `translate(-50%, -50%) translate(${dotPos.x}px, ${dotPos.y}px)`;
      ring.style.transform = `translate(-50%, -50%) translate(${ringPos.x}px, ${ringPos.y}px)`;
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    document.addEventListener("pointerleave", onLeave);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, [reduced]);

  if (reduced) return null;

  return (
    <>
      <div ref={dotRef} className="reactive-cursor__dot" aria-hidden="true" />
      <div ref={ringRef} className="reactive-cursor__ring" aria-hidden="true" />
    </>
  );
}
