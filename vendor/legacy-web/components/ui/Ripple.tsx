"use client";

import { useCallback, useEffect, useRef, type PointerEvent, type ReactNode } from "react";

interface RippleProps {
  children: ReactNode;
  /** 时长 ms(默认 600);reduced-motion 下退化为无动画态变更 */
  duration?: number;
  /** 波纹直径倍率(≥1.0,默认 2.4) */
  spread?: number;
  /** 圆角模式:默认 8px 控件圆角,full 用于 CTA 圆形 */
  radius?: "control" | "full";
  className?: string;
}

/**
 * 水波纹叠加层:点击中心扩散,纯视觉层不改子元素样式。
 * reduced-motion: 直接跳过波纹创建(通过 matchMedia 先判定,降级为无动画态变更)。
 */
export function Ripple({
  children,
  duration = 600,
  spread = 2.4,
  radius = "control",
  className,
}: RippleProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const reduced = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      reduced.current = e.matches;
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLSpanElement>) => {
      if (reduced.current) return;
      const host = hostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const size = Math.max(rect.width, rect.height) * spread;
      const wave = document.createElement("span");
      wave.className = "ui-ripple-wave";
      wave.style.cssText = `
        width:${size}px;height:${size}px;
        left:${cx - size / 2}px;top:${cy - size / 2}px;
        animation-duration:${duration}ms;
      `;
      host.querySelector<HTMLSpanElement>(".ui-ripple-layer")?.appendChild(wave);
      window.setTimeout(() => wave.remove(), duration + 30);
    },
    [duration, spread],
  );

  const cls = ["ui-ripple", radius === "full" ? "ui-ripple--full" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <span ref={hostRef} className={cls} onPointerDown={onPointerDown}>
      {children}
      <span className="ui-ripple-layer" aria-hidden="true" />
    </span>
  );
}
