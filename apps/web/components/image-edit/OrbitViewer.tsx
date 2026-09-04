"use client";

import { useEffect, useRef, useState } from "react";

import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { imageUrl } from "@/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// OrbitViewer:360° 环绕序列旋转查看器(2026-08-24)
// 8 帧按方位升序(0/45/…/315°),拖拽/箭头/圆点切帧 + 自动旋转播放;
// 帧切换靠预加载缓存直换 src(不闪烁);reduced-motion 时默认不自动播放。
// ─────────────────────────────────────────────────────────────────────────────

/** 8 方位(度),与 ImageEditView CAM3D_AZIMUTHS 的提交顺序一致(帧 i = azimuths[i])。 */
export const ORBIT_AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315] as const;
/** 拖拽阻尼:每 32px 换一帧(24-40px 区间取中,太小发飘太大拖不动)。 */
export const ORBIT_FRAME_PX = 32;
/** 自动旋转帧间隔。 */
export const ORBIT_AUTOPLAY_MS = 800;

interface OrbitViewerProps {
  /** 8 张签名产物路径,按方位升序 */
  frames: string[];
  /** 当前帧索引(受控:胶片条点击/拖拽/箭头共用) */
  frame: number;
  onFrame: (index: number) => void;
}

/** 环形取模(负数安全)。 */
function wrap(index: number, count: number): number {
  return ((index % count) + count) % count;
}

export function OrbitViewer({ frames, frame, onFrame }: OrbitViewerProps) {
  const count = frames.length;
  const current = wrap(frame, count);
  // reduced-motion 用户默认不自动播放(useState 惰性初值,SSR 安全)
  const [playing, setPlaying] = useState(
    () =>
      typeof window !== "undefined" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startFrame: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // 预加载全部帧:拖拽切帧时 src 命中缓存,无闪烁
  useEffect(() => {
    for (const f of frames) {
      const img = new Image();
      img.src = imageUrl(f);
    }
  }, [frames]);

  // 自动旋转:拖拽期间暂停,松手后继续
  useEffect(() => {
    if (!playing || dragging || count < 2) return;
    const t = window.setInterval(() => onFrame(wrap(current + 1, count)), ORBIT_AUTOPLAY_MS);
    return () => window.clearInterval(t);
  }, [playing, dragging, current, count, onFrame]);

  const step = (delta: number) => onFrame(wrap(current + delta, count));

  return (
    <Card className="at-card ie-result-card ie-orbit-card">
      <div className="ie-result-head">
        <span className="ie-result-label">360° 环绕查看器</span>
        <div className="ie-result-actions">
          <span className="ie-orbit-angle" aria-live="polite">
            {ORBIT_AZIMUTHS[current] ?? current * 45}°
          </span>
          <button
            type="button"
            className="at-btn at-btn--primary ie-orbit-play"
            aria-label={playing ? "暂停自动旋转" : "自动旋转"}
            aria-pressed={playing}
            onClick={() => setPlaying((p) => !p)}
          >
            <Icon name={playing ? "pause" : "play"} size={13} />
            {playing ? "暂停" : "播放"}
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={`ie-orbit-stage${dragging ? " is-dragging" : ""}`}
        role="slider"
        aria-label="环绕视角"
        aria-valuemin={0}
        aria-valuemax={315}
        aria-valuenow={ORBIT_AZIMUTHS[current] ?? 0}
        aria-valuetext={`方位 ${ORBIT_AZIMUTHS[current] ?? 0}°`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            step(-1);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            step(1);
          }
        }}
        onPointerDown={(e) => {
          e.preventDefault(); // 防误选图/触发原生拖拽
          dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startFrame: current };
          stageRef.current?.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d || e.pointerId !== d.pointerId) return;
          const delta = Math.round((e.clientX - d.startX) / ORBIT_FRAME_PX);
          if (delta !== 0) onFrame(wrap(d.startFrame + delta, count));
        }}
        onPointerUp={(e) => {
          if (dragRef.current?.pointerId !== e.pointerId) return;
          dragRef.current = null;
          stageRef.current?.releasePointerCapture(e.pointerId);
          setDragging(false);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {/* CLS 防护:1:1 设计基准值;CSS 约束保持实际纵横比(.ie-orbit-img) */}
        <img
          src={imageUrl(frames[current])}
          alt={`环绕视角 ${ORBIT_AZIMUTHS[current] ?? 0}°`}
          className="ie-orbit-img"
          width={1024}
          height={1024}
          decoding="async"
          draggable={false}
        />
        <button
          type="button"
          className="ie-orbit-nav ie-orbit-prev"
          aria-label="上一视角(←)"
          title="上一视角(←)"
          onClick={() => step(-1)}
        >
          <Icon name="chevron-left" size={18} />
        </button>
        <button
          type="button"
          className="ie-orbit-nav ie-orbit-next"
          aria-label="下一视角(→)"
          title="下一视角(→)"
          onClick={() => step(1)}
        >
          <Icon name="chevron-right" size={18} />
        </button>
      </div>

      <div className="ie-orbit-dots" role="tablist" aria-label="方位选择">
        {frames.map((f, i) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={i === current}
            aria-label={`方位 ${ORBIT_AZIMUTHS[i] ?? i * 45}°`}
            className={`ie-orbit-dot${i === current ? " is-active" : ""}`}
            onClick={() => onFrame(i)}
          />
        ))}
      </div>

      {/* 多组件文件 styled-jsx 作用域坑(AGENTS.md P-2b):一律 jsx global + ie- 前缀 */}
      <style jsx global>{`
        .ie-orbit-card {
          gap: var(--space-3);
        }
        .ie-orbit-angle {
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
          min-width: 44px;
          text-align: right;
        }
        .ie-orbit-play {
          min-height: 30px;
          padding: 0 var(--space-3);
          font-size: var(--text-aux);
        }
        .ie-orbit-stage {
          position: relative;
          display: flex;
          justify-content: center;
          background: var(--bg-canvas);
          border-radius: var(--radius-control);
          overflow: hidden;
          cursor: grab;
          touch-action: pan-y; /* 纵向滚动留给页面,横向拖拽换帧 */
          user-select: none;
          -webkit-user-select: none;
        }
        .ie-orbit-stage.is-dragging {
          cursor: grabbing;
        }
        .ie-orbit-stage:focus-visible {
          outline: var(--focus-ring);
          outline-offset: 2px;
        }
        .ie-orbit-img {
          max-width: 100%;
          max-height: 520px;
          object-fit: contain;
          display: block;
          pointer-events: none; /* 拖拽事件统一落 stage,防 img 原生拖拽 */
        }
        .ie-orbit-nav {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          display: flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          border: none;
          border-radius: var(--radius-full);
          background: color-mix(in srgb, var(--bg-surface-1) 78%, transparent);
          color: var(--text-primary);
          cursor: pointer;
          opacity: 0;
          transition: opacity var(--duration-fast) var(--ease-standard);
        }
        .ie-orbit-stage:hover .ie-orbit-nav,
        .ie-orbit-stage:focus-within .ie-orbit-nav {
          opacity: 1;
        }
        .ie-orbit-nav:hover {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .ie-orbit-prev {
          left: var(--space-3);
        }
        .ie-orbit-next {
          right: var(--space-3);
        }
        @media (max-width: 767px) {
          /* 移动端无 hover:导航箭头常显,触控目标 ≥44px */
          .ie-orbit-nav {
            opacity: 1;
            width: 44px;
            height: 44px;
          }
        }
        /* 帧指示刻度(2026-09-04 美化 W3):圆点改刻度条——当前帧拉高+accent,读出「8 机位环」节律 */
        .ie-orbit-dots {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: var(--space-1);
        }
        .ie-orbit-dot {
          width: 3px;
          height: 10px;
          padding: 0;
          border: none;
          border-radius: var(--radius-full);
          background: var(--bg-surface-3);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            height var(--duration-fast) var(--ease-standard);
        }
        .ie-orbit-dot:hover {
          background: var(--text-muted);
        }
        .ie-orbit-dot.is-active {
          background: var(--accent);
          height: 16px;
        }
        @media (prefers-reduced-motion: reduce) {
          .ie-orbit-dot,
          .ie-orbit-nav {
            transition: none;
          }
        }
      `}</style>
    </Card>
  );
}
