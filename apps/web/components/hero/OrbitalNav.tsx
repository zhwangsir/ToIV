"use client";

import { useEffect, useRef, useState } from "react";

import { useReducedMotion } from "@/hooks/useReducedMotion";

/**
 * 中心"创作核心" + 能力节点环绕公转(rAF 驱动,纯 transform 合成器友好)。
 * - 悬停某节点 → 磁吸放大/发光/显标签,公转缓停。
 * - 点击 → 短暂"跃迁"脉冲 + 高亮该能力(no-op 占位,写入 state/console)。
 * - 节点↔核心 间 SVG 细光线相连。
 * - 键盘可聚焦 + aria-label;reduced-motion → 静态布列,不公转。
 */

interface Node {
  key: string;
  label: string;
  glyph: string;
  /** 公转起始角(度) */
  angle: number;
}

const NODES: readonly Node[] = [
  { key: "image", label: "图像", glyph: "◳", angle: 0 },
  { key: "video", label: "视频", glyph: "▷", angle: 60 },
  { key: "manju", label: "漫剧", glyph: "❏", angle: 120 },
  { key: "threed", label: "3D", glyph: "◇", angle: 180 },
  { key: "audio", label: "音频", glyph: "≋", angle: 240 },
  { key: "model", label: "模型", glyph: "⬡", angle: 300 },
] as const;

const ORBIT_RADIUS = 168; // px,与 hero.css 中 --orbit-r 对应
const REV_PERIOD_MS = 64000; // 一圈周期,缓慢

export function OrbitalNav() {
  const reduced = useReducedMotion();
  const ringRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const lineRefs = useRef<Map<string, SVGLineElement>>(new Map());
  const [active, setActive] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  // 把悬停态实时灌给 rAF 闭包(不触发 effect 重建)
  const hoverSync = useRef<string | null>(null);

  // 公转 rAF:把每个节点摆到环上,光线端点跟随。
  useEffect(() => {
    if (reduced) {
      // 静态布列:直接按起始角定位一次
      NODES.forEach((n) => placeNode(n.key, n.angle));
      return;
    }

    let raf = 0;
    let running = true;
    let lastT = performance.now();
    let spin = 0; // 累计公转角(度)

    const ring = ringRef.current;
    const io = ring
      ? new IntersectionObserver(
          (e) => {
            const vis = e[0]?.isIntersecting ?? true;
            if (vis && !running) {
              running = true;
              lastT = performance.now();
              raf = requestAnimationFrame(tick);
            } else if (!vis && running) {
              running = false;
              cancelAnimationFrame(raf);
            }
          },
          { threshold: 0.01 },
        )
      : null;
    if (ring && io) io.observe(ring);

    function tick(now: number) {
      if (!running) return;
      const dt = now - lastT;
      lastT = now;
      // 悬停任意节点 → 公转缓停(速度因子趋 0)
      const speed = hoverSync.current ? 0 : 1;
      spin += (dt / REV_PERIOD_MS) * 360 * speed;
      NODES.forEach((n) => placeNode(n.key, n.angle + spin));
      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  useEffect(() => {
    hoverSync.current = hovered;
  }, [hovered]);

  function placeNode(key: string, deg: number) {
    const rad = (deg * Math.PI) / 180;
    const x = Math.cos(rad) * ORBIT_RADIUS;
    const y = Math.sin(rad) * ORBIT_RADIUS;
    const el = nodeRefs.current.get(key);
    if (el) {
      el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
    }
    const line = lineRefs.current.get(key);
    if (line) {
      // SVG 中心为 (0,0)(viewBox 已居中)
      line.setAttribute("x2", x.toFixed(1));
      line.setAttribute("y2", y.toFixed(1));
    }
  }

  const onActivate = (key: string) => {
    setActive(key);
    // 占位"跃迁":真实跳转留待 v2 接 create/manju 工作室。
    // eslint-disable-next-line no-console
    console.info(`[engine] jump → ${key}`);
    const el = nodeRefs.current.get(key);
    if (el) {
      el.classList.remove("orbit-node--jump");
      // 强制 reflow 以重启动画
      void el.offsetWidth;
      el.classList.add("orbit-node--jump");
    }
  };

  return (
    <div className="orbital" ref={ringRef}>
      {/* 光线层:核心 → 各节点 */}
      <svg className="orbital-lines" viewBox="-220 -220 440 440" aria-hidden="true">
        <g>
          {NODES.map((n) => (
            <line
              key={n.key}
              ref={(el) => {
                if (el) lineRefs.current.set(n.key, el);
              }}
              className={`orbital-line${active === n.key || hovered === n.key ? " is-lit" : ""}`}
              x1="0"
              y1="0"
              x2={(Math.cos((n.angle * Math.PI) / 180) * ORBIT_RADIUS).toFixed(1)}
              y2={(Math.sin((n.angle * Math.PI) / 180) * ORBIT_RADIUS).toFixed(1)}
            />
          ))}
        </g>
      </svg>

      {/* 公转轨道虚线 */}
      <div className="orbital-track" aria-hidden="true" />

      {/* 中心创作核心 */}
      <div className={`creation-core${active ? " is-engaged" : ""}`}>
        <span className="creation-core__pulse" aria-hidden="true" />
        <span className="creation-core__ring" aria-hidden="true" />
        <span className="creation-core__label">创作核心</span>
        <span className="creation-core__status">{active ? `${labelOf(active)} · 就绪` : "待命"}</span>
      </div>

      {/* 能力节点 */}
      {NODES.map((n) => (
        <button
          key={n.key}
          type="button"
          ref={(el) => {
            if (el) nodeRefs.current.set(n.key, el);
          }}
          className={`orbit-node${active === n.key ? " is-active" : ""}`}
          aria-label={`激活${n.label}创作能力`}
          aria-pressed={active === n.key}
          onMouseEnter={() => setHovered(n.key)}
          onMouseLeave={() => setHovered(null)}
          onFocus={() => setHovered(n.key)}
          onBlur={() => setHovered(null)}
          onClick={() => onActivate(n.key)}
        >
          <span className="orbit-node__glyph" aria-hidden="true">
            {n.glyph}
          </span>
          <span className="orbit-node__label">{n.label}</span>
        </button>
      ))}
    </div>
  );
}

function labelOf(key: string): string {
  return NODES.find((n) => n.key === key)?.label ?? key;
}
