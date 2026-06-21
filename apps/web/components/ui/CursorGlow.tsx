"use client";

import { useEffect, useRef } from "react";

/**
 * 精致自定义光标:柔和极光拖尾 + 滞后细环(悬停磁吸放大)。
 * - 保留系统箭头(精度不丢),仅叠加氛围动效。
 * - 触屏 / 粗指针 / reduced-motion 自动禁用。
 * - 全程只写 transform/opacity,rAF 节流,零 React 重渲染。
 */
const INTERACTIVE = "a, button, [role='button'], input, textarea, select, label, .clickable, .bubble.user";

export function CursorGlow() {
  const glowRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fine = window.matchMedia("(pointer: fine)").matches;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduce) return;

    const glow = glowRef.current;
    const ring = ringRef.current;
    if (!glow || !ring) return;

    document.body.classList.add("has-cursor-glow");

    // 目标点(鼠标真实位置)与各层缓动位置
    const target = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const glowPos = { ...target };
    const ringPos = { ...target };
    let raf = 0;
    let visible = false;

    const onMove = (e: PointerEvent) => {
      target.x = e.clientX;
      target.y = e.clientY;
      if (!visible) {
        visible = true;
        glow.style.opacity = "1";
        ring.style.opacity = "1";
      }
    };
    const onLeave = () => {
      visible = false;
      glow.style.opacity = "0";
      ring.style.opacity = "0";
    };
    const onOver = (e: Event) => {
      const t = e.target as Element | null;
      const hit = t?.closest?.(INTERACTIVE);
      ring.classList.toggle("is-hover", Boolean(hit));
    };
    const onDown = () => ring.classList.add("is-down");
    const onUp = () => ring.classList.remove("is-down");

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const tick = () => {
      // 辉光跟得快(贴手),细环慢半拍(拖尾磁吸感)
      glowPos.x = lerp(glowPos.x, target.x, 0.22);
      glowPos.y = lerp(glowPos.y, target.y, 0.22);
      ringPos.x = lerp(ringPos.x, target.x, 0.14);
      ringPos.y = lerp(ringPos.y, target.y, 0.14);
      glow.style.transform = `translate3d(${glowPos.x}px, ${glowPos.y}px, 0) translate(-50%, -50%)`;
      ring.style.transform = `translate3d(${ringPos.x}px, ${ringPos.y}px, 0) translate(-50%, -50%)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerover", onOver, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointerleave", onLeave);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerover", onOver);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointerleave", onLeave);
      document.body.classList.remove("has-cursor-glow");
    };
  }, []);

  return (
    <>
      <div ref={glowRef} className="cursor-glow" aria-hidden="true" />
      <div ref={ringRef} className="cursor-ring" aria-hidden="true" />
    </>
  );
}
