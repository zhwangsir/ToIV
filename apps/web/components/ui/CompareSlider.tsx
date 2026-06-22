"use client";

import { useCallback, useRef, useState } from "react";

interface CompareSliderProps {
  /** 原图(分隔条左侧,底层)。 */
  beforeSrc: string;
  /** 生成图(分隔条右侧,裁切层)。 */
  afterSrc: string;
  beforeLabel?: string;
  afterLabel?: string;
  alt?: string;
}

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/**
 * 拖动对比:before/after 叠放,中间一条可拖分隔线。
 * - 鼠标 + 触摸:Pointer Events 捕获,拖出区域也连续跟随。
 * - 性能:after 层走 clip-path(合成器友好),分隔线/把手走 left 百分比定位。
 * - 无障碍:分隔线 role=slider,左右方向键移动。
 */
export function CompareSlider({
  beforeSrc,
  afterSrc,
  beforeLabel = "原图",
  afterLabel = "生成",
  alt = "对比",
}: CompareSliderProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50);
  const [dragging, setDragging] = useState(false);

  const posFromClientX = useCallback((clientX: number): number => {
    const el = wrapRef.current;
    if (!el) return 50;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 ? clampPct(((clientX - rect.left) / rect.width) * 100) : 50;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDragging(true);
      setPos(posFromClientX(e.clientX));
    },
    [posFromClientX],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      setPos(posFromClientX(e.clientX));
    },
    [dragging, posFromClientX],
  );

  const endDrag = useCallback(() => setDragging(false), []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPos((p) => clampPct(p - 2));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setPos((p) => clampPct(p + 2));
    } else if (e.key === "Home") {
      e.preventDefault();
      setPos(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setPos(100);
    }
  }, []);

  return (
    <div
      ref={wrapRef}
      className={`compare-slider${dragging ? " is-dragging" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <img className="compare-img compare-before" src={beforeSrc} alt={`${alt} · ${beforeLabel}`} draggable={false} loading="lazy" />
      <div className="compare-after" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
        <img className="compare-img" src={afterSrc} alt={`${alt} · ${afterLabel}`} draggable={false} loading="lazy" />
      </div>

      <span className="compare-tag compare-tag-left">{beforeLabel}</span>
      <span className="compare-tag compare-tag-right">{afterLabel}</span>

      <div
        className="compare-divider"
        style={{ left: `${pos}%` }}
        role="slider"
        tabIndex={0}
        aria-label="对比分隔线"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos)}
        onKeyDown={onKeyDown}
      >
        <span className="compare-handle" aria-hidden="true">
          <span className="compare-arrow">‹</span>
          <span className="compare-arrow">›</span>
        </span>
      </div>
    </div>
  );
}
