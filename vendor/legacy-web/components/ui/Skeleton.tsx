"use client";

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  /** 圆形(头像等) */
  circle?: boolean;
  className?: string;
}

/** 骨架屏:bg-surface-2 呼吸块,动效 ≤200ms 之外的慢速脉冲仅用于加载占位。 */
export function Skeleton({ width = "100%", height = 14, circle = false, className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        display: "block",
        width,
        height: circle ? width : height,
        borderRadius: circle ? "50%" : "var(--radius-badge)",
        background: "var(--bg-surface-2)",
        animation: "ui-skeleton-pulse 1.6s ease-in-out infinite",
      }}
    >
      <style jsx global>{`
        @keyframes ui-skeleton-pulse {
          0%, 100% { opacity: 1; }
          /* 2026-09-04 美化 W1:脉冲谷底 0.45→0.6,呼吸对比更细腻 */
          50% { opacity: 0.6; }
        }
      `}</style>
    </span>
  );
}
