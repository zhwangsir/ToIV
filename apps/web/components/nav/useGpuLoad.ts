"use client";

import { useEffect, useState } from "react";

import { getGpuStats } from "@/lib/api";

/** GPU 负载语义档:绿(空闲)/ 琥珀(偏忙)/ 红(高压)/ 灰(无数据)。 */
export type GpuLoadLevel = "idle" | "busy" | "hot" | "offline";

export interface GpuLoad {
  /** 跨卡平均负载 0-100;offline 时为 null。 */
  load: number | null;
  level: GpuLoadLevel;
  /** 在线 GPU 数(供「4×PRO6000」文案)。 */
  count: number;
}

const POLL_MS = 2500;

/** 负载 → 语义档(阈值:<60 空闲 / <85 偏忙 / 否则高压)。 */
function levelOf(load: number): GpuLoadLevel {
  if (load < 60) return "idle";
  if (load < 85) return "busy";
  return "hot";
}

/**
 * 自轮询 4 卡 GPU 负载,每 2.5s 拉一次。
 * - 复用 lib/api 的 getGpuStats(只读),失败静默 → level 变 offline,点变灰。
 * - 聚合策略:跨卡平均负载(四舍五入),与 hero HUD 的呈现口径一致。
 */
export function useGpuLoad(): GpuLoad {
  const [state, setState] = useState<GpuLoad>({ load: null, level: "offline", count: 0 });

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();

    const poll = async () => {
      const stats = await getGpuStats(ctrl.signal);
      if (!alive) return;
      if (stats && stats.gpus.length > 0) {
        const avg = stats.gpus.reduce((sum, g) => sum + g.load, 0) / stats.gpus.length;
        const load = Math.round(avg);
        setState({ load, level: levelOf(load), count: stats.gpus.length });
      } else {
        // 失败 / 空:静默降级为离线档,保留点位但变灰。
        setState((prev) => ({ ...prev, level: "offline" }));
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);

    return () => {
      alive = false;
      ctrl.abort();
      window.clearInterval(id);
    };
  }, []);

  return state;
}
