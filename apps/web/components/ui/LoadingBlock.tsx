"use client";

/** 加载块变体:line(文本骨架)/block(灰块占位)/grid(卡片网格骨架) */
export type LoadingVariant = "line" | "block" | "grid";

interface LoadingBlockProps {
  variant?: LoadingVariant;
  /** 行数(line)/卡片数(grid),默认 3 */
  count?: number;
  /** 2026-09-04 美化 W1:mono 小字步骤文案槽(如「正在加载引擎…」),渲染在骨架下方 */
  step?: string;
  className?: string;
}

/**
 * 统一加载块:收敛 skeleton-shimmer / Skeleton / ui-skeleton-pulse 为一组件。
 * - line:灰底微光扫过,末行缩短,模拟段落收尾;
 * - block:纯色矩形(最小过渡态占位);
 * - grid:带 shimmer 的卡片网格占位;
 * - step:可选步骤文案(mono 小字,tabular-nums)。
 * reduced-motion:仅保留灰底,无扫光动画。
 */
export function LoadingBlock({ variant = "line", count = 3, step, className }: LoadingBlockProps) {
  const n = Math.max(1, Math.floor(count));
  const stepEl = step ? <div className="ui-loading-step">{step}</div> : null;
  if (variant === "block") {
    return (
      <div className={["ui-loading", "ui-loading--block", className].filter(Boolean).join(" ")}>
        <div className="ui-loading-block skeleton-shimmer" style={{ height: 40 }} />
        {stepEl}
      </div>
    );
  }
  if (variant === "grid") {
    return (
      <div className={["ui-loading", "ui-loading--grid", "grid-cards", className].filter(Boolean).join(" ")}>
        {Array.from({ length: n }).map((_, i) => (
          <div key={i} className="ui-loading-block skeleton-shimmer" />
        ))}
        {stepEl}
      </div>
    );
  }
  return (
    <div className={["ui-loading", "ui-loading--line", className].filter(Boolean).join(" ")}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="ui-loading-block skeleton-shimmer" />
      ))}
      {stepEl}
    </div>
  );
}
