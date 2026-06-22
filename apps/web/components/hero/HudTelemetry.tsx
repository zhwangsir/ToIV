"use client";

import { useEffect, useRef, useState } from "react";

import { useReducedMotion } from "@/hooks/useReducedMotion";

/**
 * 玻璃 HUD 遥测面板:4×GPU 负载条 + 队列表 + 产出计数器。
 *
 * 【MOCK / 真实边界】
 * - 当前所有数值为 *动画 MOCK*(平滑随机游走),用于"实时感"演示。
 * - 通过 `stats` prop 可注入真实数据;未传时回落到内部 mock。
 *   v2 将接 ComfyUI/后端 `/system stats`(见 MEMORY:comfyui-api-notes)。
 */

export interface GpuStat {
  id: string;
  /** 负载 0..100 */
  load: number;
  /** 显存占用 0..100,可选 */
  vram?: number;
}

export interface TelemetryStats {
  gpus: readonly GpuStat[];
  queueDepth: number;
  outputCount: number;
}

interface HudTelemetryProps {
  /** TODO(v2): 由父级订阅真实 `/system stats` 后传入;为空则使用内部 MOCK。 */
  stats?: TelemetryStats;
}

const GPU_IDS = ["GPU0", "GPU1", "GPU2", "GPU3"] as const;

// 平滑随机游走:在 [min,max] 内缓动,营造遥测抖动观感。
function walk(prev: number, min: number, max: number, step: number): number {
  const next = prev + (Math.random() - 0.5) * step;
  return Math.max(min, Math.min(max, next));
}

function useMockStats(enabled: boolean): TelemetryStats {
  const [stats, setStats] = useState<TelemetryStats>(() => ({
    gpus: GPU_IDS.map((id, i) => ({ id, load: 40 + i * 9, vram: 55 + i * 6 })),
    queueDepth: 3,
    outputCount: 0,
  }));
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const tick = window.setInterval(() => {
      seq.current += 1;
      setStats((s) => ({
        gpus: s.gpus.map((g) => ({
          id: g.id,
          load: walk(g.load, 8, 99, 22),
          vram: walk(g.vram ?? 60, 30, 96, 10),
        })),
        queueDepth: Math.max(0, Math.round(walk(s.queueDepth, 0, 12, 3))),
        // 偶发产出 +1,驱动计数器上跳
        outputCount: s.outputCount + (seq.current % 5 === 0 ? 1 : 0),
      }));
    }, 1100);
    return () => window.clearInterval(tick);
  }, [enabled]);

  return stats;
}

// 产出计数器:挂载时从 0 数字上跳到目标值。
function useCountUp(target: number, animate: boolean): number {
  const [val, setVal] = useState(animate ? 0 : target);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!animate) {
      setVal(target);
      return;
    }
    const start = performance.now();
    const from = 0;
    const DURATION = 1400;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(from + (target - from) * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
    // 仅挂载时跑一次入场;后续真实 target 由下方直显
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 入场动画结束后,直接跟随 target
  return animate ? Math.max(val, target) : target;
}

const QUEUE_ROWS = [
  { id: "JOB-7F2", kind: "txt2img", node: "GPU0" },
  { id: "JOB-7F3", kind: "video", node: "GPU2" },
  { id: "JOB-7F4", kind: "3d-mesh", node: "GPU3" },
] as const;

export function HudTelemetry({ stats }: HudTelemetryProps) {
  const reduced = useReducedMotion();
  const mock = useMockStats(!stats && !reduced);
  const live = stats ?? mock;
  const produced = useCountUp(live.outputCount + 1284, !reduced);

  return (
    <aside className="hud-telemetry" aria-label="系统遥测">
      <header className="hud-telemetry__head">
        <span className="hud-dot" aria-hidden="true" />
        <span className="hud-telemetry__title">集群遥测</span>
        <span className="hud-telemetry__src">{stats ? "LIVE" : "MOCK"}</span>
      </header>

      <section className="hud-block" aria-label="GPU 负载">
        <h3 className="hud-block__title">GPU 负载 · 4× RTX PRO 6000</h3>
        <ul className="gpu-list">
          {live.gpus.map((g) => (
            <li key={g.id} className="gpu-row">
              <span className="gpu-row__id">{g.id}</span>
              <span className="gpu-row__bar" aria-hidden="true">
                <span
                  className="gpu-row__fill"
                  style={{ transform: `scaleX(${(Math.round(g.load) / 100).toFixed(3)})` }}
                />
              </span>
              <span className="gpu-row__val">{Math.round(g.load)}%</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="hud-block" aria-label="渲染队列">
        <h3 className="hud-block__title">
          渲染队列 <span className="hud-badge">{Math.round(live.queueDepth)}</span>
        </h3>
        <table className="queue-table">
          <tbody>
            {QUEUE_ROWS.map((row, i) => (
              <tr key={row.id} className={i === 0 ? "is-running" : ""}>
                <td className="queue-table__id">{row.id}</td>
                <td className="queue-table__kind">{row.kind}</td>
                <td className="queue-table__node">{row.node}</td>
                <td className="queue-table__state">{i === 0 ? "RUN" : "WAIT"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="hud-block hud-block--count" aria-label="累计产出">
        <span className="hud-counter__label">累计产出</span>
        <span className="hud-counter__val">{Math.round(produced).toLocaleString("en-US")}</span>
      </section>
    </aside>
  );
}
