"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/**
 * CanvasAmbience —— 无限画布「暗房氛围层」
 *
 * Film Atelier 隐喻:画布是暗房工作台,空气里有缓慢浮尘;
 * 点击空白处泛起水波纹(慢速、大范围、自中心向外);
 * 鼠标移动带起轻微视差(三层纵深)+ 一盏跟随的暗房安全灯(极淡靛蓝辉光);
 * 三层粒子带景深:远层柔焦、近层实焦,模拟镜头焦外。
 *
 * 硬约束(项目级):
 *  - 粒子总数 < 300(此处 110)
 *  - 慢速漂移 / 慢速涟漪,无快速闪烁
 *  - 单色低饱和(中性暖灰 + 少量靛蓝染色),禁止彩虹
 *  - 粒子在最底层、低透明度,绝不遮盖内容
 *  - 尊重 prefers-reduced-motion(静态单帧,无涟漪/安全灯)
 *  - 无粒子连线、无大面积闪光(安全灯峰值 alpha ≤ 0.05)
 */

export interface CanvasAmbienceHandle {
  /** 在 wrapper 相对坐标(CSS px)处激起一圈涟漪 */
  ripple: (x: number, y: number) => void;
}

/* ---------- 粒子 ---------- */
interface Mote {
  ax: number; // 锚点 x(0..1 相对宽)
  ay: number; // 锚点 y(0..1 相对高)
  size: number; // 精灵渲染边长 px(含柔和边缘)
  layer: number; // 纵深层序号(0 远 → 2 近),决定景深柔焦
  parallax: number; // 鼠标视差最大偏移 px
  driftAmp: number; // 漂移幅度 px
  driftFx: number; // x 漂移角频率 rad/s
  driftFy: number; // y 漂移角频率 rad/s
  driftPx: number; // x 相位
  driftPy: number; // y 相位
  breathF: number; // 呼吸角频率 rad/s
  breathP: number; // 呼吸相位
  baseAlpha: number; // 基础透明度(峰值)
  tinted: boolean; // 是否带靛蓝染色
}

/* 三层纵深:远层多而微、近层少而显 */
const LAYER_SPEC = [
  { count: 55, sizeMin: 4, sizeMax: 7, depth: 0.22, aMin: 0.05, aMax: 0.1, parallax: 6 },
  { count: 35, sizeMin: 7, sizeMax: 12, depth: 0.5, aMin: 0.08, aMax: 0.15, parallax: 14 },
  { count: 20, sizeMin: 12, sizeMax: 18, depth: 0.85, aMin: 0.11, aMax: 0.19, parallax: 24 },
] as const;

/* 单色体系:中性暖灰(暗房尘埃)+ 约 1/4 靛蓝染色(贴近 --accent-soft) */
const DUST_RGB = { r: 198, g: 199, b: 207 };
const DUST_TINT_RGB = { r: 146, g: 168, b: 226 };

/* ---------- 涟漪:慢速、大范围、自中心向外 ---------- */
const RIPPLE_MAX_R = 440; // 大范围 px
const RIPPLE_LIFE = 6.2; // 秒(最慢环走完全程)
const RIPPLE_RINGS = [
  { delay: 0, speed: 72, width: 1.6, alpha: 0.32 },
  { delay: 0.42, speed: 62, width: 1.2, alpha: 0.2 },
  { delay: 0.9, speed: 52, width: 0.9, alpha: 0.12 },
] as const;
const MAX_RIPPLES = 8;

interface Ripple {
  x: number;
  y: number;
  t0: number; // 秒
}

const TAU = Math.PI * 2;

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function buildMotes(): Mote[] {
  const motes: Mote[] = [];
  LAYER_SPEC.forEach((layer, li) => {
    for (let i = 0; i < layer.count; i++) {
      motes.push({
        ax: Math.random(),
        ay: Math.random(),
        size: rand(layer.sizeMin, layer.sizeMax),
        layer: li,
        parallax: layer.parallax,
        driftAmp: rand(6, 16) * (0.5 + layer.depth),
        driftFx: rand(0.08, 0.22), // 周期 ~28-78s,极慢
        driftFy: rand(0.06, 0.18),
        driftPx: rand(0, TAU),
        driftPy: rand(0, TAU),
        breathF: rand(0.25, 0.6), // 呼吸周期 ~10-25s
        breathP: rand(0, TAU),
        baseAlpha: rand(layer.aMin, layer.aMax),
        tinted: Math.random() < 0.25,
      });
    }
  });
  return motes;
}

/**
 * 预渲染柔和圆点精灵。
 * softness 控制景深柔焦:远层(0)最虚、近层(2)最实,模拟镜头焦外。
 */
function makeSprite(
  c: { r: number; g: number; b: number },
  softness: number,
): HTMLCanvasElement {
  const S = 64;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const g = cv.getContext("2d");
  if (!g) return cv;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  const core = 0.34 - softness * 0.2; // 越柔焦,实芯越小
  grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${1 - softness * 0.25})`);
  grad.addColorStop(core, `rgba(${c.r},${c.g},${c.b},${0.5 - softness * 0.12})`);
  grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return cv;
}

/* 每层的柔焦系数(0 远 → 2 近) */
const LAYER_SOFTNESS = [0.85, 0.45, 0.12] as const;

/* ---------- 暗房安全灯:跟随鼠标的极淡靛蓝辉光 ---------- */
const SAFELIGHT_R = 320; // 光晕半径 px
const SAFELIGHT_A = 0.05; // 峰值透明度(极低,绝不喧宾夺主)

export const CanvasAmbience = forwardRef<CanvasAmbienceHandle, object>(
  function CanvasAmbience(_props, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const ripplesRef = useRef<Ripple[]>([]);
    const reducedRef = useRef(false);
    const nowRef = useRef(0);

    useImperativeHandle(ref, () => ({
      ripple(x, y) {
        if (reducedRef.current) return;
        const list = ripplesRef.current;
        list.push({ x, y, t0: nowRef.current });
        if (list.length > MAX_RIPPLES) list.splice(0, list.length - MAX_RIPPLES);
      },
    }));

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      reducedRef.current =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const motes = buildMotes();
      // 景深精灵:3 层 × 2 色,远虚近实
      const sprites = LAYER_SOFTNESS.map((soft) => ({
        plain: makeSprite(DUST_RGB, soft),
        tint: makeSprite(DUST_TINT_RGB, soft),
      }));
      // 安全灯辉光精灵(预渲染,避免每帧建渐变)
      const safelight = (() => {
        const S = 256;
        const cv = document.createElement("canvas");
        cv.width = S;
        cv.height = S;
        const g = cv.getContext("2d");
        if (g) {
          const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
          grad.addColorStop(0, `rgba(${DUST_TINT_RGB.r},${DUST_TINT_RGB.g},${DUST_TINT_RGB.b},1)`);
          grad.addColorStop(0.45, `rgba(${DUST_TINT_RGB.r},${DUST_TINT_RGB.g},${DUST_TINT_RGB.b},0.36)`);
          grad.addColorStop(1, `rgba(${DUST_TINT_RGB.r},${DUST_TINT_RGB.g},${DUST_TINT_RGB.b},0)`);
          g.fillStyle = grad;
          g.fillRect(0, 0, S, S);
        }
        return cv;
      })();

      let w = 0;
      let h = 0;
      let raf = 0;
      let running = false;
      let lastTs = 0;

      // 鼠标视差目标 / 当前(缓动跟随,物理滞后感)
      const target = { x: 0, y: 0 };
      const current = { x: 0, y: 0 };

      const resize = () => {
        const parent = canvas.parentElement;
        if (!parent) return;
        const rect = parent.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = rect.width;
        h = rect.height;
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(h * dpr));
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (reducedRef.current) drawStatic();
      };

      // 鼠标位置(安全灯中心)→ wrapper 相对坐标;eased 为缓动跟随值
      const mouse = { x: -9999, y: -9999, inside: false };
      const eased = { x: -9999, y: -9999, init: false };

      const drawSafelight = () => {
        if (!mouse.inside) return;
        // 呼吸:极缓慢明暗,像暗房灯管的老化闪烁被抹平后的余韵
        const breath = 0.85 + 0.15 * Math.sin(nowRef.current * 0.35);
        ctx.globalAlpha = SAFELIGHT_A * breath;
        ctx.drawImage(
          safelight,
          eased.x - SAFELIGHT_R,
          eased.y - SAFELIGHT_R,
          SAFELIGHT_R * 2,
          SAFELIGHT_R * 2,
        );
        ctx.globalAlpha = 1;
      };

      const drawMotes = (t: number) => {
        for (const m of motes) {
          const px =
            m.ax * w +
            Math.sin(t * m.driftFx + m.driftPx) * m.driftAmp +
            current.x * m.parallax;
          const py =
            m.ay * h +
            Math.cos(t * m.driftFy + m.driftPy) * m.driftAmp * 0.8 +
            current.y * m.parallax;
          const breath = 0.72 + 0.28 * Math.sin(t * m.breathF + m.breathP);
          ctx.globalAlpha = m.baseAlpha * breath;
          const pair = sprites[m.layer];
          const sprite = m.tinted ? pair.tint : pair.plain;
          const s = m.size;
          ctx.drawImage(sprite, px - s / 2, py - s / 2, s, s);
        }
        ctx.globalAlpha = 1;
      };

      const drawRipples = (t: number) => {
        const list = ripplesRef.current;
        for (let i = list.length - 1; i >= 0; i--) {
          const rip = list[i];
          const age = t - rip.t0;
          if (age > RIPPLE_LIFE) {
            list.splice(i, 1);
            continue;
          }
          for (const ring of RIPPLE_RINGS) {
            const rt = age - ring.delay;
            if (rt <= 0) continue;
            const r = ring.speed * rt;
            if (r > RIPPLE_MAX_R) continue;
            const p = r / RIPPLE_MAX_R; // 0..1
            const fade = Math.pow(1 - p, 1.7);
            const a = ring.alpha * fade;
            if (a < 0.004) continue;
            ctx.strokeStyle = `rgba(${DUST_TINT_RGB.r},${DUST_TINT_RGB.g},${DUST_TINT_RGB.b},${a})`;
            ctx.lineWidth = ring.width * (1 - p * 0.35);
            ctx.beginPath();
            ctx.arc(rip.x, rip.y, r, 0, TAU);
            ctx.stroke();
          }
        }
      };

      const drawStatic = () => {
        if (w <= 0 || h <= 0) return;
        ctx.clearRect(0, 0, w, h);
        // reduced-motion:仅一帧静态浮尘,固定透明度,无动画
        for (const m of motes) {
          ctx.globalAlpha = m.baseAlpha * 0.8;
          const pair = sprites[m.layer];
          const sprite = m.tinted ? pair.tint : pair.plain;
          const s = m.size;
          ctx.drawImage(sprite, m.ax * w - s / 2, m.ay * h - s / 2, s, s);
        }
        ctx.globalAlpha = 1;
      };

      const frame = (ts: number) => {
        if (!running) return;
        const t = ts / 1000;
        const dt = lastTs > 0 ? Math.min(t - lastTs, 0.1) : 0.016;
        lastTs = t;
        nowRef.current = t;

        // 视差缓动(指数趋近,~0.45s 时间常数)
        const k = 1 - Math.exp(-dt * 2.2);
        current.x += (target.x - current.x) * k;
        current.y += (target.y - current.y) * k;

        // 安全灯位置缓动(稍快,~0.3s,保证跟手又带惯性)
        if (mouse.inside) {
          if (!eased.init) {
            eased.x = mouse.x;
            eased.y = mouse.y;
            eased.init = true;
          } else {
            const kl = 1 - Math.exp(-dt * 3.4);
            eased.x += (mouse.x - eased.x) * kl;
            eased.y += (mouse.y - eased.y) * kl;
          }
        } else {
          eased.init = false;
        }

        if (w > 0 && h > 0) {
          ctx.clearRect(0, 0, w, h);
          drawSafelight();
          drawMotes(t);
          drawRipples(t);
        }
        raf = requestAnimationFrame(frame);
      };

      const start = () => {
        if (running || reducedRef.current) return;
        running = true;
        lastTs = 0;
        raf = requestAnimationFrame(frame);
      };
      const stop = () => {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      };

      const parent = canvas.parentElement;
      const onMove = (e: MouseEvent) => {
        if (!parent || w <= 0 || h <= 0) return;
        const rect = parent.getBoundingClientRect();
        // 归一到 [-0.5, 0.5],再放大为最大视差偏移
        target.x = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
        target.y = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
        mouse.x = e.clientX - rect.left;
        mouse.y = e.clientY - rect.top;
        mouse.inside = true;
      };
      const onLeave = () => {
        target.x = 0;
        target.y = 0;
        mouse.inside = false;
      };
      const onVisibility = () => {
        if (document.hidden) stop();
        else start();
      };

      const ro = new ResizeObserver(resize);
      if (parent) ro.observe(parent);
      resize();

      if (!reducedRef.current) {
        parent?.addEventListener("mousemove", onMove, { passive: true });
        parent?.addEventListener("mouseleave", onLeave);
        document.addEventListener("visibilitychange", onVisibility);
        start();
      }

      return () => {
        stop();
        ro.disconnect();
        parent?.removeEventListener("mousemove", onMove);
        parent?.removeEventListener("mouseleave", onLeave);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }, []);

    return <canvas ref={canvasRef} className="cv-ambience" aria-hidden="true" />;
  },
);

export default CanvasAmbience;
