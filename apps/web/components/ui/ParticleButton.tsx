"use client";

import { useCallback, useEffect, useRef, type PointerEvent, type ReactNode } from "react";

/* ── 硬性红线(用户设计约束):粒子数 ≤280、速度 ≤1.0、无连线、低饱和单色 ── */
export const PARTICLE_HARD_CAP = 280;
/** 归一化速档 ≤1.0:时长 = 距离 × 1.6/SPEED,均值 ≈0.6px/ms 的慢速聚集 */
const PARTICLE_SPEED = 1.0;
/** 粒子扩散域:围绕按钮外扩 96px 的环形出生带 */
const SPAWN_SPREAD = 96;
const SPAWN_MIN = 24;

/** reduced-motion 判定(抽纯便于单测):true → 组件整段跳过粒子效果。 */
export function reducedMotionMatches(mq: { matches: boolean } | null | undefined): boolean {
  return mq?.matches === true;
}

export interface BurstParticle {
  sx: number; // 出生点(canvas 坐标系)
  sy: number;
  tx: number; // 汇聚点(按钮轮廓带)
  ty: number;
  r: number; // 半径 1-2px
  delay: number; // 错峰 ms
  duration: number; // 飞行时长 ms(由距离/速度反推)
}

/**
 * 生成一次「四周 → 按钮轮廓」聚集粒子束(纯函数,便于单测)。
 * 目标点沿按钮矩形周长均匀采样(+轮廓带抖动),聚成按钮形状。
 */
export function buildBurst(
  width: number,
  height: number,
  count: number,
  rng: () => number = Math.random,
): BurstParticle[] {
  const n = Math.min(Math.max(0, Math.floor(count)), PARTICLE_HARD_CAP);
  const perimeter = 2 * (width + height);
  const out: BurstParticle[] = [];
  for (let i = 0; i < n; i++) {
    // 目标:周长采样 + 轮廓带 ±4px 抖动
    let p = rng() * perimeter;
    let tx: number;
    let ty: number;
    if (p < width) {
      tx = p; ty = 0;
    } else if ((p -= width) < height) {
      tx = width; ty = p;
    } else if ((p -= height) < width) {
      tx = width - p; ty = height;
    } else {
      tx = 0; ty = height - (p - width);
    }
    tx += (rng() - 0.5) * 8;
    ty += (rng() - 0.5) * 8;
    // 出生:按钮外扩 SPAWN_MIN..SPAWN_SPREAD 环形带
    const angle = rng() * Math.PI * 2;
    const dist = SPAWN_MIN + rng() * (SPAWN_SPREAD - SPAWN_MIN);
    const sx = width / 2 + Math.cos(angle) * (width / 2 + dist);
    const sy = height / 2 + Math.sin(angle) * (height / 2 + dist);
    const flight = Math.hypot(sx - tx, sy - ty);
    // 慢速:duration = 距离 × 1.6/SPEED(均值 ≈0.6px/ms);ease-out 峰值 ~3× 均值仍克制
    const duration = Math.min(1100, Math.max(520, (flight * 1.6) / PARTICLE_SPEED));
    out.push({
      sx, sy, tx, ty,
      r: 1 + rng(),
      delay: rng() * 120,
      duration,
    });
  }
  return out;
}

interface ParticleButtonProps {
  children: ReactNode;
  /** 粒子数(默认 120,硬上限 280) */
  count?: number;
  className?: string;
}

/**
 * 微粒子按钮:点击瞬间四周粒子向按钮轮廓聚集(cavnas 2d,单色 accent,低透明)。
 * 红线:≤280 粒子、无连线、不遮字(半径 ≤2px、到达即淡出);
 * reduced-motion:整段跳过,仅保留按钮原生态变更。
 */
export function ParticleButton({ children, count = 120, className }: ParticleButtonProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const reduced = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = reducedMotionMatches(mq);
    const onChange = (e: MediaQueryListEvent) => {
      reduced.current = reducedMotionMatches(e);
    };
    mq.addEventListener?.("change", onChange);
    return () => {
      mq.removeEventListener?.("change", onChange);
      cancelAnimationFrame(rafRef.current); // 卸载清 RAF
    };
  }, []);

  const spawn = useCallback(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const rect = host.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // 画布覆盖按钮 + 四周出生带(粒子从按钮外飞入,不被画布边缘裁掉)
    const W = rect.width + SPAWN_SPREAD * 2;
    const H = rect.height + SPAWN_SPREAD * 2;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.left = `${-SPAWN_SPREAD}px`;
    canvas.style.top = `${-SPAWN_SPREAD}px`;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    // 单色跟随 accent(低饱和:全局透明度压到 0.5 以下)
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#17181A";
    const off = SPAWN_SPREAD;
    const particles = buildBurst(rect.width, rect.height, count).map((p) => ({
      ...p,
      sx: p.sx + off,
      sy: p.sy + off,
      tx: p.tx + off,
      ty: p.ty + off,
    }));
    const start = performance.now();

    const tick = (now: number) => {
      const t = now - start;
      ctx.clearRect(0, 0, W, H);
      let alive = false;
      for (const pt of particles) {
        const local = (t - pt.delay) / pt.duration;
        if (local < 0) {
          alive = true;
          continue;
        }
        const k = Math.min(local, 1);
        // ease-out cubic:先快后缓,物理聚集感
        const ease = 1 - Math.pow(1 - k, 3);
        const x = pt.sx + (pt.tx - pt.sx) * ease;
        const y = pt.sy + (pt.ty - pt.sy) * ease;
        // 到达后 200ms 内淡出;飞行中透明度克制
        const alpha = k >= 1 ? Math.max(0, 0.45 - ((t - pt.delay - pt.duration) / 200) * 0.45) : 0.42;
        if (alpha <= 0) continue;
        alive = true;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(x, y, pt.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (alive) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        ctx.clearRect(0, 0, W, H);
      }
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [count]);

  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (reduced.current) return; // reduced-motion:跳过粒子
    void e;
    spawn();
  };

  const cls = ["ui-particles", className].filter(Boolean).join(" ");
  return (
    <span ref={hostRef} className={cls} onPointerDown={onPointerDown}>
      {children}
      <canvas ref={canvasRef} className="ui-particles-canvas" aria-hidden="true" />
    </span>
  );
}
