"use client";

import { useEffect, useState } from "react";

/**
 * 同步阻塞操作(无服务端中间进度,如 DWG 转换 / TTS 配音 / ffmpeg 拼接 / LLM 拆解)
 * 用的「估算进度」。给用户「在动、还要一会儿」的进度感,而非干等。
 *
 * 行为:active 期间从 ~8% 起,按指数趋近平滑爬升到 ~92% 并渐缓(永不自达 100%);
 * 完成由调用方把 active 置 false —— 真实产物随即替换等待区,无需假装到顶。
 * !active 返回 null(调用方据此隐藏进度条)。
 *
 * @param active 操作进行中。
 * @param estMs 预计耗时(ms),标定爬升速度;低估则提前贴近 92% 卡住,符合预期。
 */
export function useFauxProgress(active: boolean, estMs = 8000): number | null {
  const [pct, setPct] = useState<number | null>(null);

  useEffect(() => {
    if (!active) {
      setPct(null);
      return;
    }
    const start = performance.now();
    setPct(8);
    // 200ms 步进 + CSS width 过渡补间 → 平滑且省重渲
    const id = window.setInterval(() => {
      const t = (performance.now() - start) / estMs;
      const target = 92 * (1 - Math.exp(-1.7 * t));
      setPct((prev) => Math.max(prev ?? 8, Math.round(target)));
    }, 200);
    return () => window.clearInterval(id);
  }, [active, estMs]);

  return pct;
}
