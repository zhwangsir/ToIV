import type { GenStatus, Progress } from "@/lib/types";

interface Props {
  status: GenStatus;
  progress: Progress;
}

export function ProgressBar({ status, progress }: Props) {
  if (status !== "queued" && status !== "running") return null;

  const hasSteps = progress.max > 0;
  const pct = hasSteps ? Math.round((progress.value / progress.max) * 100) : 0;

  return (
    <div className="progress" aria-live="polite">
      <div className="progress-track">
        <div
          className={`progress-fill${hasSteps ? "" : " indeterminate"}`}
          style={hasSteps ? { width: `${pct}%` } : undefined}
        />
      </div>
      <span className="progress-label">
        {status === "queued"
          ? "已入队，等待 GPU…"
          : hasSteps
            ? `采样中 ${progress.value}/${progress.max} 步 · ${pct}%`
            : "生成中…"}
      </span>
    </div>
  );
}
