"use client";

import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";

interface MagnetFollowProps {
  children: ReactNode;
  /** 最大吸附位移 px(默认 4,硬性上限 4) */
  max?: number;
  className?: string;
}

/**
 * 鼠标跟随微吸附:光标在元素上时向其方向 translate ≤4px,
 * spring 缓动跟随带拖尾;离开后弹性回落。
 * reduced-motion:不吸附(无 transform 变更)。
 */
export function MagnetFollow({ children, max = 4, className }: MagnetFollowProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const reduced = useRef(false);
  const cap = Math.min(Math.max(max, 0), 4);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      reduced.current = e.matches;
      if (e.matches && hostRef.current) hostRef.current.style.transform = "";
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (reduced.current) return;
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    // 以元素中心为原点的相对偏移,按 cap 收敛
    const dx = ((e.clientX - rect.left) / rect.width - 0.5) * 2 * cap;
    const dy = ((e.clientY - rect.top) / rect.height - 0.5) * 2 * cap;
    host.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
  };

  const onPointerLeave = () => {
    if (hostRef.current) hostRef.current.style.transform = "";
  };

  const cls = ["ui-magnet", className].filter(Boolean).join(" ");
  return (
    <span
      ref={hostRef}
      className={cls}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </span>
  );
}
