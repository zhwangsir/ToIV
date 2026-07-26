"use client";

import { imageUrl } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

interface TimelineBarProps {
  project: UseDramaProjectReturn;
}

/**
 * Film Atelier · 底部时间轴(合成轨)。
 * 片段轨按镜头时长占比排布,点击片段联动选中故事板;
 * 全部镜头就绪后解锁「合成成片」,合成结果/错误就地展示。
 */
export function TimelineBar({ project }: TimelineBarProps) {
  const {
    shots,
    doneCount,
    busyShot,
    selectedShotId,
    setSelectedShotId,
    assemble,
    assembling,
    assembleResult,
    assembleError,
    clearAssembleResult,
  } = project;

  const total = shots.length;
  // 预计成片时长:全部镜头 duration_sec 求和(有任一已就绪才显示)
  const totalDur = shots.reduce((sum, s) => sum + (s.duration_sec || 0), 0);
  const canAssemble = total > 0 && doneCount === total && !assembling;

  return (
    <div className="fa-timeline">
      <div className="fa-tl-head">
        <span className="fa-tl-title">Timeline</span>
        <span className="fa-tl-info">
          已就绪 <b>{doneCount} / {total}</b> 镜头 · 预计成片{" "}
          <b>{total > 0 && doneCount > 0 ? `${totalDur}s` : "—"}</b>
        </span>
        <div className="fa-tl-actions">
          <button
            type="button"
            className="fa-btn fa-btn-amber fa-btn-sm"
            onClick={() => void assemble()}
            disabled={!canAssemble}
            title={
              canAssemble
                ? "按故事板顺序拼接全部镜头,合成成片"
                : total === 0
                  ? "尚无镜头"
                  : `还有 ${total - doneCount} 个镜头未就绪`
            }
          >
            {assembling ? (
              <>
                <Icon name="loading" size={12} className="fa-spin" />
                合成中…
              </>
            ) : (
              <>
                <Icon name="film" size={12} />
                合成成片
              </>
            )}
          </button>
        </div>
      </div>

      <div className="fa-tl-track">
        {total === 0 ? (
          <div className="fa-tl-empty">尚无镜头 · 拆解剧本后此处出现片段轨</div>
        ) : (
          shots.map((s) => {
            const done = (s.video_status || "").toLowerCase() === "done";
            const gen =
              busyShot === s.id ||
              ["generating", "running", "processing"].includes(
                (s.video_status || "").toLowerCase(),
              );
            const cls = [
              "fa-tl-clip",
              done ? "fa-tl-clip-ready" : "",
              gen ? "fa-tl-clip-gen" : "",
              assembling && done ? "fa-tl-clip-burn" : "",
              selectedShotId === s.id ? "fa-tl-clip-sel" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={s.id}
                type="button"
                className={cls}
                style={{ flexGrow: Math.max(1, s.duration_sec || 1) }}
                onClick={() => setSelectedShotId(s.id)}
                title={`#${s.idx} ${s.scene || "分镜"} · 点击在检查器中打开`}
              >
                {String(s.idx).padStart(2, "0")} · {s.duration_sec}s
              </button>
            );
          })
        )}
      </div>

      <div className="fa-tl-audio">
        <span className="fa-tl-audio-label">VOICE</span>
        <div className="fa-tl-wave" />
      </div>

      {assembleError && <div className="fa-tl-error">{assembleError}</div>}

      {assembleResult && (
        <div className="fa-tl-result">
          <Icon name="success" size={13} />
          <span className="fa-tl-result-text">
            成片已合成:{assembleResult.name}(
            {assembleResult.duration_sec.toFixed(1)}s)
          </span>
          <a
            className="fa-tl-result-link"
            href={imageUrl(assembleResult.url)}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="eye" size={11} />
            查看成片
          </a>
          <button
            type="button"
            className="fa-tl-result-close"
            onClick={clearAssembleResult}
            title="收起结果"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      <style jsx>{`
        .fa-timeline {
          flex-shrink: 0;
          background: var(--fa-bg2);
          border: 1px solid var(--fa-line);
          border-radius: 10px;
          padding: 12px 16px 13px;
        }
        .fa-tl-head {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 10px;
        }
        .fa-tl-title {
          font-family: var(--fa-mono);
          font-size: 10px;
          letter-spacing: 0.18em;
          color: var(--fa-ink3);
          text-transform: uppercase;
        }
        .fa-tl-info {
          font-size: 11.5px;
          color: var(--fa-ink2);
        }
        .fa-tl-info b {
          color: var(--fa-amber);
          font-weight: 600;
        }
        .fa-tl-actions {
          margin-left: auto;
          display: flex;
          gap: 8px;
        }
        .fa-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border-radius: 6px;
          font-weight: 500;
          background: transparent;
          color: var(--fa-ink2);
          border: 1px solid var(--fa-line-hi);
          cursor: pointer;
          transition: all 0.2s ease;
          white-space: nowrap;
        }
        .fa-btn-sm {
          padding: 5px 11px;
          font-size: 11px;
        }
        .fa-btn:hover:not(:disabled) {
          color: var(--fa-ink);
          border-color: var(--fa-ink3);
          transform: translateY(-1px);
        }
        .fa-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .fa-btn-amber {
          background: var(--fa-amber);
          border-color: var(--fa-amber);
          color: var(--fa-bg);
          font-weight: 600;
        }
        .fa-btn-amber:hover:not(:disabled) {
          background: var(--fa-amber-hi);
          border-color: var(--fa-amber-hi);
          color: var(--fa-bg);
          box-shadow: 0 4px 16px var(--fa-amber-soft);
        }
        .fa-tl-track {
          display: flex;
          gap: 4px;
          height: 40px;
          margin-bottom: 8px;
        }
        .fa-tl-empty {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px dashed var(--fa-line-hi);
          border-radius: 4px;
          color: var(--fa-ink3);
          font-size: 11px;
        }
        .fa-tl-clip {
          flex-basis: 0;
          min-width: 54px;
          border-radius: 4px;
          border: 1px solid var(--fa-line-hi);
          background: var(--fa-card);
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: var(--fa-mono);
          font-size: 9.5px;
          color: var(--fa-ink3);
          cursor: pointer;
          transition: all 0.3s ease;
          overflow: hidden;
          white-space: nowrap;
        }
        .fa-tl-clip:hover {
          border-color: var(--fa-ink3);
          color: var(--fa-ink2);
        }
        .fa-tl-clip-gen {
          color: var(--fa-amber);
          border-color: var(--fa-amber-line);
          animation: fa-breathe 2s ease-in-out infinite;
        }
        .fa-tl-clip-ready {
          color: var(--fa-ink2);
          border-color: var(--fa-amber-line);
          background: linear-gradient(180deg, var(--fa-hi), var(--fa-card));
        }
        .fa-tl-clip-burn {
          background: var(--fa-amber);
          color: var(--fa-bg);
          border-color: var(--fa-amber);
          font-weight: 600;
        }
        .fa-tl-clip-sel,
        .fa-tl-clip-sel:hover {
          border-color: var(--fa-amber);
          box-shadow: 0 0 0 2px var(--fa-amber-soft);
          color: var(--fa-amber);
        }
        .fa-tl-clip-burn.fa-tl-clip-sel {
          color: var(--fa-bg);
        }
        .fa-tl-audio {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .fa-tl-audio-label {
          font-family: var(--fa-mono);
          font-size: 9px;
          letter-spacing: 0.14em;
          color: var(--fa-ink3);
        }
        .fa-tl-wave {
          flex: 1;
          height: 20px;
          background-image: repeating-linear-gradient(
            90deg,
            var(--fa-ink3) 0 1.5px,
            transparent 1.5px 5px
          );
          opacity: 0.4;
          border-radius: 2px;
          -webkit-mask-image: linear-gradient(
            90deg,
            transparent,
            #000 5%,
            #000 95%,
            transparent
          );
          mask-image: linear-gradient(
            90deg,
            transparent,
            #000 5%,
            #000 95%,
            transparent
          );
        }
        .fa-tl-error {
          margin-top: 8px;
          font-size: 11.5px;
          color: var(--fa-red);
          line-height: 1.5;
        }
        .fa-tl-result {
          margin-top: 8px;
          display: flex;
          align-items: center;
          gap: 8px;
          border-left: 2px solid var(--fa-amber);
          padding: 4px 0 4px 12px;
          color: var(--fa-green);
          animation: fa-rise 0.3s ease both;
        }
        .fa-tl-result-text {
          flex: 1;
          font-size: 12px;
          color: var(--fa-ink2);
        }
        .fa-tl-result-link {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 11.5px;
          color: var(--fa-amber);
          text-decoration: none;
          border: 1px solid var(--fa-amber-line);
          border-radius: 4px;
          padding: 3px 9px;
          transition: all 0.2s ease;
        }
        .fa-tl-result-link:hover {
          background: var(--fa-amber);
          color: var(--fa-bg);
        }
        .fa-tl-result-close {
          background: none;
          border: none;
          color: var(--fa-ink3);
          cursor: pointer;
          padding: 2px;
          display: flex;
          transition: color 0.15s ease;
        }
        .fa-tl-result-close:hover {
          color: var(--fa-ink);
        }
        .fa-spin {
          animation: fa-spin 1s linear infinite;
        }
        @keyframes fa-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes fa-breathe {
          0%,
          100% {
            opacity: 0.45;
          }
          50% {
            opacity: 1;
          }
        }
        @keyframes fa-rise {
          from {
            opacity: 0;
            transform: translateY(6px);
          }
          to {
            opacity: 1;
            transform: none;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .fa-spin,
          .fa-tl-clip-gen,
          .fa-tl-result {
            animation: none;
          }
          .fa-btn,
          .fa-tl-clip,
          .fa-tl-result-link,
          .fa-tl-result-close {
            transition: none;
          }
          .fa-btn:hover:not(:disabled) {
            transform: none;
          }
        }
      `}</style>
    </div>
  );
}
