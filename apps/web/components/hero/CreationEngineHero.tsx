"use client";

import "./hero.css";

import { type MouseEvent, useEffect, useRef, useState } from "react";

import { AuroraBackground } from "@/components/hero/AuroraBackground";
import { HudTelemetry, type TelemetryStats } from "@/components/hero/HudTelemetry";
import { OrbitalNav } from "@/components/hero/OrbitalNav";
import { ReactiveCursor } from "@/components/hero/ReactiveCursor";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { getGpuStats } from "@/lib/api";

/**
 * 「创作引擎」全息指挥控制台。
 * 组合:WebGL2 极光背景 + 公转能力环 + HUD 遥测 + 磁吸光标。
 *
 * 入场"启动自检":HUD 框 → 核心 → 节点 → 遥测 错峰揭示(~1.2s,CSS keyframes)。
 * 入场结束后卸下 boot 类(其 forwards 锁定的 transform 会挡住视差),改由
 * rAF 鼠标视差给各层做不同深度的位移,营造景深。
 * reduced-motion 下:无入场动画、无视差,瞬时静态显示。
 *
 * 数据状态:遥测为 MOCK(见 HudTelemetry);其余为真实交互组件。
 */
export function CreationEngineHero() {
  const reduced = useReducedMotion();
  const [booted, setBooted] = useState(false);
  const headRef = useRef<HTMLElement>(null);
  const consoleRef = useRef<HTMLElement>(null);
  const telemetryRef = useRef<HTMLDivElement>(null);
  const [liveStats, setLiveStats] = useState<TelemetryStats | undefined>(undefined);

  // 入场结束后卸下 boot 类,让视差 transform 生效
  useEffect(() => {
    if (reduced) {
      setBooted(true);
      return;
    }
    const id = window.setTimeout(() => setBooted(true), 1800);
    return () => window.clearTimeout(id);
  }, [reduced]);

  // 鼠标视差景深:lerp 平滑后给各层不同位移因子
  useEffect(() => {
    if (reduced || !booted) return;
    const layers: Array<[HTMLElement | null, number, number]> = [
      [headRef.current, 4, 3],
      [consoleRef.current, 2, 2],
      [telemetryRef.current, -7, -5],
    ];
    const target = { x: 0, y: 0 };
    const cur = { x: 0, y: 0 };
    let raf = 0;

    const onMove = (e: PointerEvent) => {
      target.x = (e.clientX / window.innerWidth) * 2 - 1;
      target.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    const loop = () => {
      cur.x += (target.x - cur.x) * 0.06;
      cur.y += (target.y - cur.y) * 0.06;
      for (const [el, fx, fy] of layers) {
        if (el) {
          el.style.transform = `translate3d(${(cur.x * fx).toFixed(2)}px, ${(cur.y * fy).toFixed(2)}px, 0)`;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    raf = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, [reduced, booted]);

  // 实时遥测:轮询后端聚合的 4 卡 GPU 负载/队列;成功即切 LIVE,失败保持上次值/MOCK。
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const poll = async () => {
      const s = await getGpuStats(ctrl.signal);
      if (alive && s && s.gpus.length > 0) setLiveStats(s);
    };
    void poll();
    const id = window.setInterval(() => void poll(), 2500);
    return () => {
      alive = false;
      ctrl.abort();
      window.clearInterval(id);
    };
  }, []);

  const bootCls = (name: string) => (booted ? name : `${name} boot-${name.split("-")[1]}`);

  // 向下滚动到能力展示区(reduced-motion 下瞬时跳转)
  const onScrollCue = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    document
      .getElementById("capabilities")
      ?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };

  return (
    <main className={`engine-stage${reduced ? " is-static" : ""}`}>
      <AuroraBackground />
      <ReactiveCursor />

      {/* HUD 战术框:四角细括号 + 扫描线叠层 */}
      <div className="hud-frame" aria-hidden="true">
        <span className="hud-corner hud-corner--tl" />
        <span className="hud-corner hud-corner--tr" />
        <span className="hud-corner hud-corner--bl" />
        <span className="hud-corner hud-corner--br" />
        <span className="hud-scanlines" />
        <span className="hud-grid" />
      </div>

      <div className="engine-layout">
        {/* 标题块 */}
        <header className={bootCls("engine-head")} ref={headRef}>
          <p className="engine-eyebrow">
            <span className="engine-eyebrow__tick" aria-hidden="true" />
            CREATION ENGINE · 在线
          </p>
          <h1 className="engine-title">
            ToIV <span className="engine-title__sep" aria-hidden="true">·</span>{" "}
            <span className="engine-title__accent">创作引擎</span>
          </h1>
        </header>

        {/* 中央公转控制台 */}
        <section className={bootCls("engine-console")} aria-label="创作能力控制台" ref={consoleRef}>
          <OrbitalNav />
        </section>

        {/* 右侧遥测 */}
        <div className={bootCls("engine-telemetry")} ref={telemetryRef}>
          <HudTelemetry stats={liveStats} />
        </div>
      </div>

      {/* 底部遥测读数条 */}
      <footer className={`engine-readout${booted ? "" : " boot-readout"}`} aria-hidden="true">
        <span className="readout-item">
          <em>LAT</em> 11.4°N
        </span>
        <span className="readout-item">
          <em>CORE</em> ONLINE
        </span>
        <span className="readout-item">
          <em>NODES</em> 6/6
        </span>
        <span className="readout-item">
          <em>UPLINK</em> 192.168.71.100:8000
        </span>
        <span className="readout-item readout-item--blink">
          <em>SYNC</em> ●
        </span>
      </footer>

      {/* 向下滚动提示:进入六大能力展示 */}
      <a
        className={`engine-scrollcue${booted ? "" : " boot-scrollcue"}`}
        href="#capabilities"
        aria-label="向下查看六大创作能力"
        onClick={onScrollCue}
      >
        <span className="engine-scrollcue__txt">六大能力</span>
        <span className="engine-scrollcue__chev" aria-hidden="true" />
      </a>
    </main>
  );
}
