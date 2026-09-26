import type { CSSProperties, ReactNode } from "react";

/**
 * 统一进度条(2026-09-27 细节层)。样式在 app/styles/details.css 的 .ui-progress*。
 *
 * - value: 0-100;null/undefined = 不确定态(25% 段循环滑动)
 * - state: running(默认,填充内淡蒙版微光)/ queued(灰色慢速不确定)/ done / error(转红冻结)
 * - size: xs 2px / sm 4px(默认)/ md 6px
 * - label / meta: 条上方一行,左侧说明、右侧百分比或计数(等宽数字)
 * - className / fillClassName:保留各视图原有类名,便于局部微调与源码断言
 */
export interface ProgressBarProps {
  value?: number | null;
  state?: "running" | "queued" | "done" | "error";
  size?: "xs" | "sm" | "md";
  label?: ReactNode;
  meta?: ReactNode;
  className?: string;
  trackClassName?: string;
  fillClassName?: string;
  ariaLabel?: string;
  autohide?: boolean;
  style?: CSSProperties;
}

export function clampPct(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export default function ProgressBar({
  value,
  state = "running",
  size = "sm",
  label,
  meta,
  className,
  trackClassName,
  fillClassName,
  ariaLabel,
  autohide,
  style,
}: ProgressBarProps) {
  const pct = clampPct(value);
  const indeterminate = pct === null && state !== "done";
  const showMeta = label !== undefined || meta !== undefined;
  return (
    <div className={`ui-progress-block${className ? ` ${className}` : ""}`} style={style}>
      {showMeta && (
        <div className="ui-progress-meta">
          <span className="ui-progress-label">{label}</span>
          {meta !== undefined && <span className="ui-progress-pct">{meta}</span>}
        </div>
      )}
      <div
        className={`ui-progress${trackClassName ? ` ${trackClassName}` : ""}`}
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : state === "done" ? 100 : (pct ?? undefined)}
        data-size={size}
        data-state={state}
        data-indeterminate={indeterminate ? "" : undefined}
        data-autohide={autohide ? "" : undefined}
      >
        <div
          className={`ui-progress-fill${fillClassName ? ` ${fillClassName}` : ""}`}
          style={indeterminate ? undefined : { width: `${state === "done" ? 100 : pct}%` }}
        />
      </div>
    </div>
  );
}
