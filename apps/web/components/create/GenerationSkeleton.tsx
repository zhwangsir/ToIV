"use client";

import "./generation-skeleton.css";

interface GenerationSkeletonProps {
  /** 占位块数量(通常 = 本次批量 batch);至少 1,首块高亮为"正在采样"。 */
  count: number;
}

/**
 * 生成中骨架占位网格:在结果到达前铺流光占位,
 * 让用户立刻看到"位置已经预留",降低等待焦虑。
 * - 纯 transform/opacity 动效,reduced-motion 由同位 CSS 降级。
 * - 数量取自批量参数,封顶 8 避免铺满整屏。
 */
export function GenerationSkeleton({ count }: GenerationSkeletonProps) {
  const n = Math.min(8, Math.max(1, Math.floor(count) || 1));
  return (
    <div className="gen-skel" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={`gen-skel-tile${i === 0 ? " is-lead" : ""}`} />
      ))}
    </div>
  );
}
