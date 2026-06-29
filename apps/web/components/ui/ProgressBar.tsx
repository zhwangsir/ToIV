import type { ReactNode } from "react";

/** 语义色 —— 即「不同风格」:图像紫 / 音频·配音青 / 转换冷青 / 完成绿 / 出错红。 */
export type ProgressTone = "accent" | "voice" | "cool" | "success" | "danger";

interface ProgressBarProps {
  /** false 不渲染(等待结束即收起)。默认 true。 */
  active?: boolean;
  /** 0-100;null / undefined = 不确定态(流光条 / 旋转环)。 */
  value?: number | null;
  /** 左侧阶段文字。 */
  label?: ReactNode;
  /** determinate 时右侧显示百分比数字。默认 true。 */
  showPct?: boolean;
  /** 语义色。 */
  tone?: ProgressTone;
  /** 形态:线性条 / 环形(环形用于卡片角标等紧凑位)。 */
  variant?: "linear" | "ring";
  /** 线性条粗细。 */
  size?: "sm" | "md";
  /** 环直径 px(variant=ring)。 */
  ringSize?: number;
  className?: string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * 全站统一进度条。determinate(有真实 0-100)显示填充 + 百分比 + 推进扫光;
 * indeterminate(value 为 null,如刚入队 / 同步阻塞)显示流光条 / 旋转环。
 * 通过 tone 切换语义色,通过 variant 切换条 / 环形态 —— 一处组件,多种风格。
 */
export function ProgressBar({
  active = true,
  value = null,
  label,
  showPct = true,
  tone = "accent",
  variant = "linear",
  size = "md",
  ringSize = 44,
  className,
}: ProgressBarProps) {
  if (!active) return null;
  const determinate = value !== null && value !== undefined;
  const pct = determinate ? clamp(value as number) : null;
  const cls = className ? ` ${className}` : "";

  if (variant === "ring") {
    const r = 15.5;
    const circ = 2 * Math.PI * r;
    const offset = determinate ? circ * (1 - pct! / 100) : circ * 0.72;
    return (
      <div
        className={`tpb-ring${determinate ? "" : " is-indeterminate"}${cls}`}
        data-tone={tone}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? pct! : undefined}
        aria-label={typeof label === "string" ? label : "进度"}
        style={{ width: ringSize, height: ringSize }}
      >
        <svg viewBox="0 0 36 36" width={ringSize} height={ringSize} aria-hidden="true">
          <circle className="tpb-ring-track" cx="18" cy="18" r={r} />
          <circle
            className="tpb-ring-fill"
            cx="18"
            cy="18"
            r={r}
            strokeDasharray={circ}
            strokeDashoffset={offset}
          />
        </svg>
        {determinate && <span className="tpb-ring-pct">{pct}</span>}
      </div>
    );
  }

  return (
    <div className={`tpb tpb--${size}${cls}`} data-tone={tone}>
      {(label != null || (determinate && showPct)) && (
        <div className="tpb-head">
          {label != null && <span className="tpb-label">{label}</span>}
          {determinate && showPct && <span className="tpb-pct">{pct}%</span>}
        </div>
      )}
      <div
        className="tpb-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? pct! : undefined}
      >
        <span
          className={`tpb-fill${determinate ? "" : " is-indeterminate"}`}
          style={determinate ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}
