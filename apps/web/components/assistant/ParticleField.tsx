"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/** W4(2026-08-31)首页空态微粒场——Film Atelier 工作台「空气感」背景层。
 *
 *  设计约束(用户视觉红线):
 *  - 微粒总数硬上限 300(本实现桌面 160 / 窄屏 80,绝不超界);
 *  - 漂移速度上限 0.45 px/帧(红线 1.2 以内),无爆闪/无高饱和彩虹/无粒子连线;
 *  - 不遮文字:canvas z-0 压底 + 径向暗角,内容层 z-2 浮其上;
 *  - 呼吸感:全局透明度 6s 周期轻微起伏;景深:z 深度三档预渲染软斑(近实远虚);
 *  - 交互:指针缓随(150px 内弱吸引)、点击水波(慢速大范围扩散环,推开微粒)、
 *    卡片悬停汇聚(attractor 锚点);
 *  - 双色即收:主色 --particle-primary(accent)+ 次色 --particle-secondary(text-muted);
 *  - prefers-reduced-motion:只画一帧静态,不开 rAF;标签页隐藏即暂停;
 *  - 主题/模式切换(data-theme/data-mode 属性变化)即时重取色重建软斑。 */

export const PARTICLE_CAP = 300;
/** 漂移速度上限(px/帧 @60fps)——用户红线 1.2,取远低于红线的克制值 */
export const SPEED_CAP = 0.45;
/** 水波扩散速度(px/帧)——慢速 */
export const RIPPLE_SPEED = 2.1;
/** 水波波及范围 = 容器对角线 × 比例——大范围 */
export const RIPPLE_RANGE_RATIO = 0.62;

export interface ParticleFieldHandle {
  /** 在 (x, y)(容器坐标系)激起一圈缓慢扩散的水波 */
  ripple: (x: number, y: number) => void;
  /** 设置汇聚锚点(卡片悬停,容器坐标系) */
  setAttractor: (x: number, y: number) => void;
  /** 清除汇聚锚点 */
  clearAttractor: () => void;
}

/** 按容器宽度定微粒数(纯函数,单测锚点):窄屏更少,任何情况 ≤ PARTICLE_CAP。 */
export function particleCountForWidth(w: number): number {
  const n = w < 640 ? 80 : w < 1120 ? 120 : 160;
  return Math.min(n, PARTICLE_CAP);
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 景深 0.35–1:近大远小、近快远慢、近实远虚 */
  z: number;
  /** 0 = 主色(accent) 1 = 次色(text-muted) */
  hue: 0 | 1;
  alpha: number;
}

interface Ripple {
  x: number;
  y: number;
  r: number;
  maxR: number;
}

/** 解析 CSS 颜色(hex #rgb/#rrggbb 或 rgb(a))为 [r,g,b];失败回退中性灰。 */
export function parseCssColor(raw: string): [number, number, number] {
  const s = raw.trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const rgb = s.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  return [138, 143, 152];
}

/** 预渲染一档软斑精灵(24px):tier 0 近实 / 1 中 / 2 远虚(廉价景深)。 */
function makeSprite(rgb: [number, number, number], tier: 0 | 1 | 2): HTMLCanvasElement {
  const S = 24;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  const [r, g, b] = rgb;
  // 软度:tier 越高边缘越散(远焦外虚化感)
  const inner = [0.18, 0.1, 0.04][tier];
  const grad = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(inner, `rgba(${r},${g},${b},0.9)`);
  grad.addColorStop(0.7, `rgba(${r},${g},${b},${[0.25, 0.4, 0.5][tier]})`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);
  return c;
}

export const ParticleField = forwardRef<ParticleFieldHandle>(function ParticleField(
  _props,
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const ripplesRef = useRef<Ripple[]>([]);
  const attractorRef = useRef<{ x: number; y: number } | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  useImperativeHandle(ref, () => ({
    ripple(x, y) {
      const c = canvasRef.current;
      if (!c) return;
      const maxR = Math.hypot(c.clientWidth, c.clientHeight) * RIPPLE_RANGE_RATIO;
      ripplesRef.current.push({ x, y, r: 0, maxR });
      // 同时存在的波纹封顶 4 圈,连点不堆积
      if (ripplesRef.current.length > 4) ripplesRef.current.shift();
    },
    setAttractor(x, y) {
      attractorRef.current = { x, y };
    },
    clearAttractor() {
      attractorRef.current = null;
    },
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const host = canvas.parentElement;
    if (!host) return;

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let raf = 0;
    let last = 0;
    let disposed = false;
    // 双色精灵:3 景深档 × 2 色
    let sprites: HTMLCanvasElement[][] = [];

    const readHues = (): [string, string] => {
      const cs = getComputedStyle(document.documentElement);
      const primary =
        cs.getPropertyValue("--particle-primary") || cs.getPropertyValue("--accent");
      const secondary =
        cs.getPropertyValue("--particle-secondary") || cs.getPropertyValue("--text-muted");
      return [primary.trim() || "#17181A", secondary.trim() || "#64666C"];
    };

    const rebuildSprites = () => {
      const [primary, secondary] = readHues();
      sprites = [0, 1].map((hue) => {
        const rgb = parseCssColor(hue ? secondary : primary);
        return [makeSprite(rgb, 0), makeSprite(rgb, 1), makeSprite(rgb, 2)];
      });
    };

    const seed = () => {
      const n = particleCountForWidth(w);
      const arr: Particle[] = [];
      for (let i = 0; i < n; i++) {
        const z = 0.35 + Math.random() * 0.65;
        arr.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * SPEED_CAP * 0.5,
          vy: (Math.random() - 0.5) * SPEED_CAP * 0.5,
          z,
          hue: Math.random() < 0.72 ? 0 : 1,
          alpha: 0.14 + z * 0.2, // 峰值 ~0.34,低饱和灰阶点点,不抢内容
        });
      }
      particlesRef.current = arr;
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (particlesRef.current.length === 0) seed();
    };

    const drawFrame = (now: number) => {
      ctx.clearRect(0, 0, w, h);
      // 呼吸:6s 周期 ±8% 透明度起伏
      const breathe = 0.92 + 0.08 * Math.sin((now / 6000) * Math.PI * 2);
      for (const p of particlesRef.current) {
        const tier = p.z > 0.78 ? 0 : p.z > 0.55 ? 1 : 2;
        const sprite = sprites[p.hue]?.[tier];
        if (!sprite) continue;
        const size = (2.2 + p.z * 3.6) * (tier === 2 ? 2.2 : tier === 1 ? 1.6 : 1.2);
        ctx.globalAlpha = Math.min(1, p.alpha * breathe);
        ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
      // 水波环:细线、低透明、随扩散衰减
      const [primary] = readHuesCache();
      const [r, g, b] = parseCssColor(primary);
      for (const rp of ripplesRef.current) {
        const k = 1 - rp.r / rp.maxR;
        if (k <= 0) continue;
        ctx.strokeStyle = `rgba(${r},${g},${b},${(0.22 * k * k).toFixed(3)})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    // 颜色按帧重读成本可控(仅在有水波时用到);缓存一帧内不重算
    let huesCache: [string, string] = ["#17181A", "#64666C"];
    let huesCacheAt = 0;
    const readHuesCache = (): [string, string] => {
      const now = performance.now();
      if (now - huesCacheAt > 1000) {
        huesCache = readHues();
        huesCacheAt = now;
      }
      return huesCache;
    };

    const step = (now: number) => {
      if (disposed) return;
      const dt = Math.min((now - last) / 16.7, 3) || 1; // 帧率归一,掉帧不突跳
      last = now;
      const pointer = pointerRef.current;
      const attractor = attractorRef.current;

      for (const p of particlesRef.current) {
        // 布朗漂移
        p.vx += (Math.random() - 0.5) * 0.008 * dt;
        p.vy += (Math.random() - 0.5) * 0.008 * dt;
        // 指针缓随(150px 弱吸引)
        if (pointer) {
          const dx = pointer.x - p.x;
          const dy = pointer.y - p.y;
          const d = Math.hypot(dx, dy);
          if (d > 1 && d < 150) {
            const f = 0.0011 * (1 - d / 150) * dt;
            p.vx += dx * f;
            p.vy += dy * f;
          }
        }
        // 卡片悬停汇聚(240px,略强于指针,形成「聚成按钮」暗示)
        if (attractor) {
          const dx = attractor.x - p.x;
          const dy = attractor.y - p.y;
          const d = Math.hypot(dx, dy);
          if (d > 1 && d < 240) {
            const f = 0.0016 * (1 - d / 240) * dt;
            p.vx += dx * f;
            p.vy += dy * f;
          }
        }
        // 水波推开(环带 30px 内径向外推)
        for (const rp of ripplesRef.current) {
          const dx = p.x - rp.x;
          const dy = p.y - rp.y;
          const d = Math.hypot(dx, dy);
          const band = Math.abs(d - rp.r);
          if (d > 1 && band < 30) {
            const f = 0.09 * (1 - band / 30) * (1 - rp.r / rp.maxR) * dt;
            p.vx += (dx / d) * f;
            p.vy += (dy / d) * f;
          }
        }
        // 阻尼 + 限速(远景更慢 → 视差纵深)
        const damp = Math.pow(0.96, dt);
        p.vx *= damp;
        p.vy *= damp;
        const cap = SPEED_CAP * (0.5 + 0.5 * p.z);
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > cap) {
          p.vx = (p.vx / sp) * cap;
          p.vy = (p.vy / sp) * cap;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        // 软包边
        const M = 20;
        if (p.x < -M) p.x = w + M;
        else if (p.x > w + M) p.x = -M;
        if (p.y < -M) p.y = h + M;
        else if (p.y > h + M) p.y = -M;
      }
      // 推进波纹,寿终移除
      for (const rp of ripplesRef.current) rp.r += RIPPLE_SPEED * dt;
      ripplesRef.current = ripplesRef.current.filter((rp) => rp.r < rp.maxR);

      drawFrame(now);
      raf = requestAnimationFrame(step);
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      pointerRef.current =
        x >= 0 && y >= 0 && x <= rect.width && y <= rect.height ? { x, y } : null;
    };
    const onPointerLeave = () => {
      pointerRef.current = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else if (!reduced && !disposed) {
        last = performance.now();
        raf = requestAnimationFrame(step);
      }
    };
    // 主题/模式切换(data-theme/data-mode/pure-black 变化)→ 重取色重建精灵
    const themeObserver = new MutationObserver(() => {
      rebuildSprites();
      if (reduced) drawFrame(performance.now());
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-mode", "data-pure-black"],
    });

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    rebuildSprites();
    resize();

    if (reduced) {
      // 静态一帧:有点阵空气感,零运动
      drawFrame(performance.now());
    } else {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      document.addEventListener("pointerleave", onPointerLeave);
      document.addEventListener("visibilitychange", onVisibility);
      raf = requestAnimationFrame((t) => {
        last = t;
        step(t);
      });
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="av-particle-field" aria-hidden="true" />;
});
