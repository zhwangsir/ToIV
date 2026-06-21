"use client";

import { useEffect, useRef } from "react";

/**
 * 极光流体烟雾光标:鼠标移动时往画布注入彩色"染料",以加色混合累积、
 * 逐帧淡出 + 缓慢扩散,呈现跟随光标流动的发光烟雾(ToIV 极光配色)。
 *
 * 原创实现(Canvas 2D + 预渲染精灵),非 WebGL 流体仿真的逐行移植:
 * - 预渲染 4 张极光色径向精灵,逐粒子 drawImage 缩放/透明度,避免每帧建渐变。
 * - 全屏 fixed、pointer-events:none、低 z 作背景层,不挡交互。
 * - 仅桌面 fine 指针启用;reduced-motion / 触屏自动关闭;切后台暂停。
 */
const COLORS: [number, number, number][] = [
  [139, 108, 255], // --v1 紫
  [192, 75, 255], // --v2
  [255, 77, 157], // --v3 粉
  [47, 230, 200], // --v4 青
];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  sprite: HTMLCanvasElement;
}

function makeSprite(color: [number, number, number]): HTMLCanvasElement {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},1)`);
  grad.addColorStop(0.4, `rgba(${color[0]},${color[1]},${color[2]},0.35)`);
  grad.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export function FluidCursor() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const fine = window.matchMedia("(pointer: fine)").matches;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduce) return;

    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const sprites = COLORS.map(makeSprite);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;
    const resize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const parts: Particle[] = [];
    let last = { x: W / 2, y: H / 2 };
    let colorIdx = 0;
    let raf = 0;

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      const speed = Math.hypot(dx, dy);
      const n = Math.min(5, Math.floor(speed / 7) + 1);
      const ang0 = Math.atan2(dy, dx);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const ang = ang0 + (Math.random() - 0.5) * 1.1; // 垂直抖动→卷曲感
        const sp = 0.3 + Math.random() * 0.9;
        parts.push({
          x: last.x + dx * t,
          y: last.y + dy * t,
          vx: Math.cos(ang) * sp + dx * 0.02,
          vy: Math.sin(ang) * sp + dy * 0.02,
          life: 0,
          max: 55 + Math.random() * 55,
          r: 22 + Math.random() * 42,
          sprite: sprites[(colorIdx + i) % sprites.length],
        });
      }
      colorIdx = (colorIdx + 1) % sprites.length;
      last = { x: e.clientX, y: e.clientY };
      if (parts.length > 600) parts.splice(0, parts.length - 600);
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const tick = () => {
      // 逐帧抹掉一点 alpha → 烟雾自然消散
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.055)";
      ctx.fillRect(0, 0, W, H);
      // 加色累积绘制染料
      ctx.globalCompositeOperation = "lighter";
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life++;
        if (p.life >= p.max) {
          parts.splice(i, 1);
          continue;
        }
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.95;
        p.vy *= 0.95;
        p.r *= 1.013; // 缓慢扩散
        const k = 1 - p.life / p.max;
        ctx.globalAlpha = k * k * 0.55;
        ctx.drawImage(p.sprite, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return <canvas ref={ref} className="fluid-cursor" aria-hidden="true" />;
}
