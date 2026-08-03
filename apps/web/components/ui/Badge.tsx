"use client";

import { CSSProperties, ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "err" | "run";

interface BadgeProps {
  tone?: BadgeTone;
  /** 状态点(默认显示) */
  dot?: boolean;
  /** 状态点脉冲动画(连接中/排队中等过渡态) */
  dotPulse?: boolean;
  title?: string;
  style?: CSSProperties;
  children?: ReactNode;
  className?: string;
}

const TONE_COLOR: Record<BadgeTone, string> = {
  neutral: "var(--text-secondary)",
  accent: "var(--accent)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  err: "var(--err)",
  run: "var(--run)",
};

const TONE_BG: Record<BadgeTone, string> = {
  neutral: "var(--bg-surface-2)",
  accent: "var(--accent-soft)",
  ok: "var(--ok-soft)",
  warn: "var(--warn-soft)",
  err: "var(--err-soft)",
  run: "var(--run-soft)",
};

/** 状态徽章:状态点 + 文案,radius-badge(6px),仅状态用语使用彩色。 */
export function Badge({ tone = "neutral", dot = true, dotPulse = false, title, style, children, className }: BadgeProps) {
  return (
    <span
      className={className}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1)",
        padding: "2px var(--space-2)",
        background: TONE_BG[tone],
        color: TONE_COLOR[tone],
        borderRadius: "var(--radius-badge)",
        fontSize: "var(--text-label)",
        fontWeight: 500,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {dot && (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: TONE_COLOR[tone],
            flexShrink: 0,
            animation: dotPulse ? "badge-dot-pulse 1.2s ease-in-out infinite" : undefined,
          }}
        />
      )}
      {children}
      {dotPulse && (
        <style jsx global>{`
          @keyframes badge-dot-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(0.8); }
          }
        `}</style>
      )}
    </span>
  );
}
