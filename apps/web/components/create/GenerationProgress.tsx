"use client";

interface GenerationProgressProps {
  stage: string;
  /** 0-100 真实进度;null = 不确定态(动画条)。 */
  progress: number | null;
}

/**
 * 生成进度条:有 SSE 真百分比时显示填充进度 + 数值,
 * 否则显示优雅的不确定态(暖金流动)。
 */
export function GenerationProgress({ stage, progress }: GenerationProgressProps) {
  const determinate = progress != null;
  return (
    <div className="gen-progress" role="status" aria-live="polite">
      <div className="gen-progress-head">
        <span className="gen-progress-stage">{stage || "处理中…"}</span>
        {determinate && <span className="gen-progress-pct">{progress}%</span>}
      </div>
      <div
        className="progress-track gen-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? progress! : undefined}
      >
        <div
          className={`progress-fill gen-progress-fill${determinate ? "" : " indeterminate"}`}
          style={determinate ? { width: `${progress}%` } : undefined}
        />
      </div>
    </div>
  );
}
