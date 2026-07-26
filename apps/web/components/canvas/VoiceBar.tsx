"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import {
  useVoiceAgent,
  type VoiceAgentState,
} from "@/lib/canvas/useVoiceAgent";

interface VoiceBarProps {
  canvasId: string;
}

const STATE_TEXT: Record<VoiceAgentState, string> = {
  idle: "待命",
  recording: "录音中",
  processing: "处理中",
  playing: "播放中",
};

/** 底部悬浮语音 Agent 条 —— 录音 / 状态 / 转录 / 历史。 */
export function VoiceBar({ canvasId }: VoiceBarProps) {
  const [expanded, setExpanded] = useState(false);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  // 录音已进行秒数(录音状态下每秒 +1)
  const [recordSeconds, setRecordSeconds] = useState(0);
  // transient 错误条:显示 5s 后自动消失
  const [visibleError, setVisibleError] = useState<string | null>(null);
  const {
    state,
    transcript,
    agentText,
    history,
    error,
    volume,
    startRecording,
    stopRecording,
    cancelRecording,
    stopAudio,
  } = useVoiceAgent({ canvasId, enabled: true });

  // 录音时画音量波形(简单可视化)
  useEffect(() => {
    if (state !== "recording") return;
    const cv = waveformRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const w = cv.width;
      const h = cv.height;
      ctx.clearRect(0, 0, w, h);
      const bars = 24;
      const bw = w / bars - 2;
      for (let i = 0; i < bars; i++) {
        // 中间高、两边低(美观),叠加上 volume
        const center = 1 - Math.abs(i - bars / 2) / (bars / 2);
        const v = volume * (0.4 + center * 0.6);
        const bh = Math.max(2, v * h);
        ctx.fillStyle = `oklch(65% 0.20 25 / ${0.4 + v * 0.6})`;
        ctx.fillRect(i * (bw + 2), (h - bh) / 2, bw, bh);
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [state, volume]);

  // 录音计时:进入 recording 归零,每秒 +1;退出/卸载时清理 interval
  useEffect(() => {
    if (state !== "recording") {
      setRecordSeconds(0);
      return;
    }
    setRecordSeconds(0);
    const timer = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);

  // 错误提示:出现后 5s 自动消失(timer 有 cleanup,严格模式安全)
  useEffect(() => {
    if (!error) {
      setVisibleError(null);
      return;
    }
    setVisibleError(error);
    const timer = setTimeout(() => setVisibleError(null), 5000);
    return () => clearTimeout(timer);
  }, [error]);

  // 录音中按 Esc 取消(丢弃本次录音,不上传)
  useEffect(() => {
    if (state !== "recording") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelRecording();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state, cancelRecording]);

  const onMicClick = () => {
    if (state === "recording") {
      stopRecording();
    } else {
      // 播放中先停再录
      if (state === "playing") stopAudio();
      startRecording();
    }
  };

  // 录音秒数格式化为 m:ss
  const recordTimeText = `${Math.floor(recordSeconds / 60)}:${String(
    recordSeconds % 60,
  ).padStart(2, "0")}`;

  return (
    <div
      className={`voice-bar vb-state-${state}`}
      role="region"
      aria-label="语音助手"
    >
      <button
        type="button"
        className="vb-mic"
        onClick={onMicClick}
        disabled={state === "processing"}
        aria-label={state === "recording" ? "停止录音" : "开始录音"}
        title={
          state === "recording"
            ? "停止录音(Esc 取消)"
            : state === "processing"
              ? "处理中…"
              : "开始录音"
        }
      >
        <Icon name="mic" size={20} strokeWidth={1.8} />
      </button>

      <div className="vb-status">
        <span className="vb-status-dot" />
        <span className="vb-status-text">{STATE_TEXT[state]}</span>
        {state === "recording" && (
          <span className="vb-rec-time" aria-label="已录制时长">
            {recordTimeText}
          </span>
        )}
      </div>

      {state === "recording" && (
        <canvas
          ref={waveformRef}
          className="vb-waveform"
          width={120}
          height={32}
          aria-hidden="true"
        />
      )}

      <div className="vb-content" role="log" aria-live="polite">
        {visibleError && (
          <span className="vb-error" role="alert">
            {visibleError}
          </span>
        )}
        {!visibleError && transcript && (
          <div className="vb-line">
            <span className="vb-label">你:</span>
            <span className="vb-text">{transcript}</span>
          </div>
        )}
        {!visibleError && !transcript && agentText && (
          <div className="vb-line">
            <span className="vb-label">Agent:</span>
            <span className="vb-text">{agentText}</span>
          </div>
        )}
        {!visibleError && !transcript && !agentText && (
          <span className="vb-hint">点击麦克风与 Agent 对话</span>
        )}
      </div>

      {history.length > 0 && (
        <button
          type="button"
          className="vb-history-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "收起历史" : "展开历史"}
          aria-expanded={expanded}
          title={expanded ? "收起历史" : "展开历史"}
        >
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
        </button>
      )}

      {expanded && history.length > 0 && (
        <div className="vb-history" role="log" aria-label="历史对话">
          {history.slice(-6).reverse().map((t) => (
            <div key={t.id} className="vb-history-item">
              {t.transcript && (
                <div className="vb-history-line">
                  <span className="vb-label">你:</span>
                  <span className="vb-text">{t.transcript}</span>
                </div>
              )}
              {t.agentText && (
                <div className="vb-history-line">
                  <span className="vb-label">Agent:</span>
                  <span className="vb-text">{t.agentText}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <style jsx>{`
        .voice-bar {
          position: absolute;
          bottom: 1rem;
          left: 50%;
          transform: translateX(-50%);
          z-index: 20;
          display: flex;
          align-items: center;
          gap: 0.6rem;
          padding: 0.45rem 0.7rem;
          min-width: 360px;
          max-width: min(720px, calc(100% - 2rem));
          background: color-mix(in oklch, var(--bg-1) 88%, transparent);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-full);
          box-shadow: 0 12px 40px -8px oklch(0% 0 0 / 0.55);
          animation: vb-fade-in var(--dur-2) var(--ease);
        }
        @keyframes vb-fade-in {
          from {
            opacity: 0;
            transform: translate(-50%, 8px);
          }
          to {
            opacity: 1;
            transform: translate(-50%, 0);
          }
        }

        .vb-mic {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          flex-shrink: 0;
          border-radius: 50%;
          color: var(--ink-soft);
          background: var(--bg-3);
          border: 1px solid var(--hairline-2);
          cursor: pointer;
          transition: color var(--dur) var(--ease),
            background-color var(--dur) var(--ease),
            border-color var(--dur) var(--ease);
        }
        .vb-mic:hover {
          color: var(--ink);
          border-color: var(--accent-line);
        }
        .vb-mic:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        .vb-mic:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .vb-state-recording .vb-mic {
          color: var(--danger);
          background: color-mix(in oklch, var(--danger) 18%, transparent);
          border-color: color-mix(in oklch, var(--danger) 50%, transparent);
          /* 速度 ≤ 1.2s(项目硬约束) */
          animation: vb-breath 1.2s var(--ease) infinite;
        }
        .vb-state-processing .vb-mic {
          color: var(--warn);
          background: var(--warn-quiet);
          border-color: color-mix(in oklch, var(--warn) 45%, transparent);
        }
        .vb-state-playing .vb-mic {
          color: var(--success);
          background: var(--success-quiet);
          border-color: color-mix(in oklch, var(--success) 45%, transparent);
        }
        @keyframes vb-breath {
          0%,
          100% {
            box-shadow: 0 0 0 0
              color-mix(in oklch, var(--danger) 45%, transparent);
          }
          50% {
            box-shadow: 0 0 0 8px
              color-mix(in oklch, var(--danger) 0%, transparent);
          }
        }

        .vb-status {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          flex-shrink: 0;
          font-size: 0.72rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
        }
        .vb-status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--ink-faint);
        }
        .vb-state-recording .vb-status-dot {
          background: var(--danger);
          animation: vb-pulse 1.2s var(--ease) infinite;
        }
        .vb-state-processing .vb-status-dot {
          background: var(--warn);
          animation: vb-pulse 1.2s var(--ease) infinite;
        }
        .vb-rec-time {
          color: var(--danger);
          font-family: var(--font-mono);
          font-size: 0.72rem;
          font-variant-numeric: tabular-nums;
        }
        .vb-state-playing .vb-status-dot {
          background: var(--success);
        }
        @keyframes vb-pulse {
          0%,
          100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.5;
            transform: scale(0.7);
          }
        }

        .vb-waveform {
          width: 120px;
          height: 32px;
          flex-shrink: 0;
        }

        .vb-content {
          flex: 1;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.78rem;
          color: var(--ink-soft);
          overflow: hidden;
        }
        .vb-hint {
          color: var(--ink-faint);
          font-size: 0.74rem;
        }
        .vb-line {
          display: flex;
          gap: 0.35rem;
          align-items: baseline;
          min-width: 0;
          flex: 1;
        }
        .vb-label {
          color: var(--ink-faint);
          font-size: 0.66rem;
          font-family: var(--font-mono);
          flex-shrink: 0;
        }
        .vb-text {
          color: var(--ink-soft);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .vb-error {
          color: var(--danger);
          font-size: 0.74rem;
        }

        .vb-history-toggle {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          flex-shrink: 0;
          border-radius: 50%;
          color: var(--ink-faint);
          background: transparent;
          border: 1px solid transparent;
          cursor: pointer;
          transition: color var(--dur) var(--ease),
            background-color var(--dur) var(--ease);
        }
        .vb-history-toggle:hover {
          color: var(--ink);
          background: var(--bg-3);
        }

        .vb-history {
          position: absolute;
          bottom: calc(100% + 0.5rem);
          left: 0;
          right: 0;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          padding: 0.6rem;
          background: color-mix(in oklch, var(--bg-1) 94%, transparent);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius);
          box-shadow: 0 12px 40px -8px oklch(0% 0 0 / 0.55);
          max-height: 280px;
          overflow-y: auto;
          animation: vb-fade-in var(--dur-2) var(--ease);
        }
        .vb-history-item {
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
          padding: 0.4rem 0.55rem;
          background: var(--bg-2);
          border-radius: var(--radius-sm);
          font-size: 0.74rem;
        }
        .vb-history-line {
          display: flex;
          gap: 0.35rem;
          align-items: baseline;
        }
        .vb-history .vb-text {
          white-space: normal;
          line-height: 1.45;
        }

        @media (max-width: 640px) {
          .voice-bar {
            min-width: 0;
            width: calc(100% - 1rem);
            padding: 0.4rem 0.5rem;
          }
          .vb-waveform {
            display: none;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .voice-bar,
          .vb-mic,
          .vb-status-dot {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
}
