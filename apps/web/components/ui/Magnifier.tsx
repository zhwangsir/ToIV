"use client";

import { useCallback, useRef, useState } from "react";

import "./magnifier.css";

interface MagnifierProps {
  src: string;
  alt: string;
  /** 放大倍率,默认 2.4。 */
  zoom?: number;
  /** 透镜直径(px),默认 168。 */
  lensSize?: number;
  /** 透传给底图的 class(沿用 create-media / tile 既有样式)。 */
  className?: string;
  /** 透传给外层容器的 class(用于按图片实际尺寸收缩,如灯箱内 contain 图)。 */
  wrapClassName?: string;
}

interface LensState {
  /** 透镜左上角相对容器的位置(px)。 */
  x: number;
  y: number;
  /** 放大背景定位(px,负值)。 */
  bgX: number;
  bgY: number;
  /** 放大背景尺寸(px)。 */
  bgW: number;
  bgH: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 悬停放大镜:鼠标在图上移动时浮现一枚圆形透镜,放大指针下方区域。
 * - 仅在精细指针(鼠标)上启用;触摸/粗指针自动退化为普通图,避免误触。
 * - 透镜位置用 transform 驱动(合成器友好);放大用 background 缩放,无额外网络请求(同一 src)。
 * - 无障碍:透镜纯装饰(aria-hidden),底图保留正常 alt。
 */
export function Magnifier({ src, alt, zoom = 2.4, lensSize = 168, className, wrapClassName }: MagnifierProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [lens, setLens] = useState<LensState | null>(null);

  const supportsHover = useCallback((): boolean => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }, []);

  const update = useCallback(
    (clientX: number, clientY: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      // 指针在容器内的坐标
      const px = clamp(clientX - rect.left, 0, rect.width);
      const py = clamp(clientY - rect.top, 0, rect.height);

      const half = lensSize / 2;
      // 透镜左上角(夹在容器内,避免溢出裁切感)
      const lx = clamp(px - half, 0, rect.width - lensSize);
      const ly = clamp(py - half, 0, rect.height - lensSize);

      const bgW = rect.width * zoom;
      const bgH = rect.height * zoom;
      // 让指针正下方的内容居中于透镜
      const bgX = -(px * zoom - half);
      const bgY = -(py * zoom - half);

      setLens({ x: lx, y: ly, bgX, bgY, bgW, bgH });
    },
    [lensSize, zoom],
  );

  const onEnter = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!supportsHover() || e.pointerType !== "mouse") return;
      setActive(true);
      update(e.clientX, e.clientY);
    },
    [supportsHover, update],
  );

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!active || e.pointerType !== "mouse") return;
      update(e.clientX, e.clientY);
    },
    [active, update],
  );

  const onLeave = useCallback(() => {
    setActive(false);
  }, []);

  return (
    <div
      ref={wrapRef}
      className={`magnifier${active ? " is-active" : ""}${wrapClassName ? ` ${wrapClassName}` : ""}`}
      onPointerEnter={onEnter}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      <img className={`magnifier-img${className ? ` ${className}` : ""}`} src={src} alt={alt} loading="lazy" />
      {lens && (
        <div
          className="magnifier-lens"
          aria-hidden="true"
          style={{
            width: `${lensSize}px`,
            height: `${lensSize}px`,
            ["--lens-x" as string]: `${lens.x}px`,
            ["--lens-y" as string]: `${lens.y}px`,
            backgroundImage: `url(${src})`,
            backgroundSize: `${lens.bgW}px ${lens.bgH}px`,
            backgroundPosition: `${lens.bgX}px ${lens.bgY}px`,
          }}
        />
      )}
    </div>
  );
}
